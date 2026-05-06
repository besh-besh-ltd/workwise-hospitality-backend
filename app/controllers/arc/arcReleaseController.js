// arcReleaseController.js
// Phase 7 — ARC Release / Direct-PO flow.
//
// A "release" (industry term: call-off order) is the bridge between an
// active ARC and an actual Purchase Order. Buyers don't run a fresh
// RFQ for items already under contract; they create a release against
// the ARC and a Contracted PO is drafted automatically with the
// committed prices.
//
// Endpoints:
//   GET  /arc/release/eligible-vendors?arc_id=&hotel_id=&product_variant_id=
//        Returns the vendors holding active rate contracts for the
//        (hotel, product) pair so the FE wizard can let the buyer pick.
//
//   POST /arc/release
//        Validates eligibility, snapshots prices, creates tbl_arc_release
//        + items, drafts a Contracted PO with arc_release_id+is_contracted=1,
//        and returns { release_id, po_id }.
//
//   GET  /arc/release/:id
//        Read a release and its items.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import { recordLifecycleEvent } from '../../models/generalModel.js';
import arcModel from '../../models/arcModel.js';
import { draftPurchaseOrderFromArcRelease } from '../../models/purchaseOrderModel.js';
import pricingEngine from '../../services/pricingEngine.js';

const formatErrorResponse = (res, error) => {
  const message = error.message || 'Failed to process ARC release';
  const statusCode = error.statusCode || 400;
  return res.status(statusCode).json({ status: 3, message });
};

/**
 * Compute a per-line total using the same engine the regular RFQ→PO
 * path uses, so a contracted PO and an open-market PO arrive at the
 * same rupee total for identical line shapes.
 */
const lineTotalFromQuoteShape = ({ unit_price, quantity, charges_meta }) => {
  const meta = pricingEngine.normalizeChargesMeta(charges_meta || {});
  const docOut = pricingEngine.calculateDocumentTotals(
    [{
      unit_price,
      quantity,
      tax: meta.tax,
      tax_mode: meta.tax_mode,
      other_charges: meta.other_charges,
    }],
    [] // no document-level global_charges on a single-line release
  );
  return {
    line_total: docOut.lines[0]?.total ?? 0,
    grand_total: docOut.grand_total,
  };
};

const ArcReleaseController = {
  /**
   * GET /arc/release/eligible-vendors
   * Returns every active ARC entry for (hotel_id, product_variant_id),
   * one row per vendor, with the committed unit price. The FE wizard
   * uses this to render the vendor-pick step.
   */
  getEligibleVendors: async (req, res) => {
    try {
      const product_variant_id = parseInt(req.query.product_variant_id);
      const hotel_id = parseInt(req.query.hotel_id);
      if (!product_variant_id || !hotel_id) {
        return res.status(400).json({
          status: 2,
          message: 'product_variant_id and hotel_id are required',
        });
      }
      const rows = await arcModel.findActiveArcsForProducts({
        product_variant_ids: [product_variant_id],
        hotel_ids: [hotel_id],
      });
      return res.status(200).json({ status: 1, data: rows });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /arc/release
   * Body: { arc_id, hotel_id, items: [{ arc_item_id, quantity }] }
   *
   * Validations (all must pass before any DB write):
   *   - ARC envelope exists, is_tender=1, status IN ('ACTIVE','DOC_GENERATED'),
   *     today between period_from and period_to.
   *   - Hotel is in tbl_arc_hotels for that envelope.
   *   - Every arc_item_id belongs to the envelope and is APPROVED.
   *   - Every quantity > 0.
   *
   * On success: creates tbl_arc_release + tbl_arc_release_items, drafts a
   * Contracted PO via draftPurchaseOrderFromArcRelease, records lifecycle
   * events for ARC_RELEASE_CREATED and ARC_RELEASE_PO_DRAFTED, returns
   * { release_id, po_id, vendor_id, total_value }.
   */
  createRelease: async (req, res) => {
    try {
      const { arc_id, hotel_id, items } = req.body;
      const created_by = req.user?.id;

      if (!created_by) {
        return res.status(401).json({ status: 3, message: 'Authentication required' });
      }
      if (!arc_id || !hotel_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'arc_id, hotel_id, and at least one item are required',
        });
      }

      // Quantities must be positive numbers — fail fast.
      for (const it of items) {
        if (!it.arc_item_id || !(Number(it.quantity) > 0)) {
          return res.status(400).json({
            status: 2,
            message: 'Each item must include arc_item_id and quantity > 0',
          });
        }
      }

      const result = await db.tx(async (t) => {
        // 1. Envelope + tender_scope.
        const envelope = await arcModel.getEnvelopeForRelease({ arc_id, txContext: t });
        if (!envelope) throw new Error(`ARC envelope ${arc_id} not found`);
        if (envelope.is_tender !== 1) throw new Error('ARC release is only valid for tenders');
        if (!['ACTIVE', 'DOC_GENERATED'].includes(envelope.status)) {
          throw new Error(`ARC envelope is in status ${envelope.status}; release requires ACTIVE/DOC_GENERATED`);
        }

        // 2. Period validity. Compare in UTC date-only to avoid TZ drift.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const from = new Date(envelope.period_from);
        const to = new Date(envelope.period_to);
        if (today < from) throw new Error('ARC has not yet started');
        if (today > to) throw new Error('ARC has expired');

        // 3. Hotel coverage.
        const covered = await arcModel.hotelCoveredByEnvelope({ arc_id, hotel_id, txContext: t });
        if (!covered) {
          throw new Error('Selected hotel is not covered by this ARC');
        }

        // 4. Items must all belong to this envelope and be APPROVED.
        const arcItemIds = items.map((it) => parseInt(it.arc_item_id)).filter(Number.isFinite);
        const validItems = await arcModel.getApprovedItemsForRelease({ arc_id, arc_item_ids: arcItemIds, txContext: t });
        if (validItems.length !== arcItemIds.length) {
          throw new Error('One or more arc_item_ids do not belong to this ARC or are not approved');
        }
        const itemById = new Map(validItems.map((i) => [i.id, i]));

        // 5. Snapshot prices and compute line totals from the engine.
        const releaseLines = items.map((it) => {
          const src = itemById.get(parseInt(it.arc_item_id));
          const qty = Number(it.quantity);
          const { line_total } = lineTotalFromQuoteShape({
            unit_price: src.unit_price,
            quantity: qty,
            charges_meta: src.charges_meta,
          });
          return {
            arc_item_id: src.id,
            rfq_product_id: src.rfq_product_id,
            product_variant_id: src.product_variant_id,
            quote_id: src.quote_id,
            quantity: qty,
            unit: 'NOS',
            unit_price: src.unit_price,
            charges_meta: src.charges_meta,
            total_price: line_total,
          };
        });
        const totalValue = releaseLines.reduce((s, l) => s + Number(l.total_price || 0), 0);

        // 6. Insert release header + items.
        const releaseRow = await t.one(
          `INSERT INTO tbl_arc_release
              (arc_id, hotel_id, vendor_id, created_by, status, total_value)
           VALUES ($1, $2, $3, $4, 'DRAFT', $5)
           RETURNING *`,
          [arc_id, hotel_id, envelope.vendor_id, created_by, totalValue]
        );
        for (const ln of releaseLines) {
          await t.none(
            `INSERT INTO tbl_arc_release_items
              (arc_release_id, arc_item_id, product_variant_id, quantity, unit_price, total_price, charges_meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [releaseRow.id, ln.arc_item_id, ln.product_variant_id, ln.quantity, ln.unit_price, ln.total_price, ln.charges_meta]
          );
        }

        await recordLifecycleEvent({
          entity_type: 'TENDER',
          entity_id: envelope.rfq_id,
          stage: 'ARC_RELEASE_CREATED',
          action: 'CREATE_RELEASE',
          performed_by: created_by,
          metadata: {
            arc_id,
            release_id: releaseRow.id,
            hotel_id,
            vendor_id: envelope.vendor_id,
            line_count: releaseLines.length,
            total_value: totalValue,
          },
          txContext: t,
        });

        // 7. Draft the Contracted PO.
        const poId = await draftPurchaseOrderFromArcRelease({
          release: { ...releaseRow, items: releaseLines },
          source_rfq_id: envelope.rfq_id,
          company_id: req.user.company_id,
          initiated_by: created_by,
          t,
        });

        // 8. Mark the release as PO drafted; lifecycle event for audit.
        await t.none(
          `UPDATE tbl_arc_release SET status = 'PO_DRAFTED' WHERE id = $1`,
          [releaseRow.id]
        );
        await recordLifecycleEvent({
          entity_type: 'TENDER',
          entity_id: envelope.rfq_id,
          stage: 'ARC_RELEASE_PO_DRAFTED',
          action: 'DRAFT_CONTRACTED_PO',
          performed_by: created_by,
          metadata: { arc_id, release_id: releaseRow.id, po_id: poId, vendor_id: envelope.vendor_id },
          txContext: t,
        });

        return {
          release_id: releaseRow.id,
          po_id: poId,
          vendor_id: envelope.vendor_id,
          hotel_id,
          total_value: totalValue,
        };
      });

      return res.status(200).json({ status: 1, data: result });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * GET /arc/release/:id
   */
  getRelease: async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ status: 2, message: 'id is required' });

      const release = await db.oneOrNone(
        `SELECT r.*, a.rfq_id, a.vendor_id AS arc_vendor_id, h.name AS hotel_name
         FROM tbl_arc_release r
         JOIN tbl_arc a ON a.id = r.arc_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
         WHERE r.id = $1`,
        [id]
      );
      if (!release) return res.status(404).json({ status: 2, message: 'Release not found' });

      // Schema-correct join: product name on tbl_product (variant table
      // has no `name` column).
      const items = await db.any(
        `SELECT ri.*,
                COALESCE(p.name, pv.variant_name, 'Item') AS product_name
           FROM tbl_arc_release_items ri
           LEFT JOIN tbl_product_variants pv ON pv.id = ri.product_variant_id
           LEFT JOIN tbl_product p ON p.id = pv.product_id
          WHERE ri.arc_release_id = $1
          ORDER BY ri.id`,
        [id]
      );

      // Locate the PO drafted from this release (if any) so the FE can
      // deep-link without a second round-trip.
      const po = await db.oneOrNone(
        `SELECT id, po_number, status FROM tbl_rfq_purchase_order WHERE arc_release_id = $1 ORDER BY id DESC LIMIT 1`,
        [id]
      );

      return res.status(200).json({
        status: 1,
        data: { ...release, items, po },
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },
};

export default ArcReleaseController;
