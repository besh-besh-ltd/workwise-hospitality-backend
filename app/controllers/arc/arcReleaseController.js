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
 * Pull the canonical engine inputs for a single arc_item. The
 * tbl_arc_item.charges_meta column only carries the `other_charges`
 * array (legacy snapshot shape) — feeding it to the engine alone gives
 * a base-only total because tax/tax_mode/freight/packaging are dropped.
 * The committee matrix already side-steps this by reading from
 * tbl_quote_items; this helper does the same so the release path and
 * the matrix agree on the rupee total.
 *
 * Returns the row with envelope state + quote_item engine fields, or
 * null when the arc_item / quote_item join misses.
 */
const loadArcItemEngineRow = async (arc_item_id, txContext = null) => {
  const t = txContext || db;
  return t.oneOrNone(
    `SELECT ai.id AS arc_item_id,
            ai.arc_id,
            ai.rfq_product_id,
            ai.product_variant_id,
            ai.variant,
            ai.quote_id,
            ai.unit_price,
            ai.status AS item_status,
            a.status AS envelope_status,
            a.period_from,
            a.period_to,
            a.vendor_id,
            a.tender_scope,
            r.rfq_no AS source_rfq_no,
            r.title AS source_rfq_title,
            COALESCE(c.company_name, u.organization_name, u.name) AS vendor_name,
            COALESCE(pv.name, 'Item') AS product_name,
            qi.tax            AS qi_tax,
            qi.tax_mode       AS qi_tax_mode,
            qi.freight_price  AS qi_freight_price,
            qi.freight_mode   AS qi_freight_mode,
            qi.package_price  AS qi_package_price,
            qi.package_mode   AS qi_package_mode,
            qi.other_charges  AS qi_other_charges
       FROM tbl_arc_item ai
       JOIN tbl_arc a ON a.id = ai.arc_id
       JOIN tbl_rfq r ON r.id = a.rfq_id
       LEFT JOIN tbl_users u ON u.id = a.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
       LEFT JOIN tbl_quote_items qi
         ON qi.quote_id = ai.quote_id
        AND qi.product_variant_id = ai.product_variant_id
        AND COALESCE(qi.variant, 0) = COALESCE(NULLIF(ai.variant, '')::int, 0)
      WHERE ai.id = $1`,
    [arc_item_id]
  );
};

/**
 * Compose other_charges for the engine from a quote_item snapshot:
 * explicit other_charges array PLUS synthesised entries for legacy
 * flat freight/packaging fields (when the explicit array doesn't
 * already cover them). Mirrors the matrix's composeEngineCharges so
 * release totals are byte-identical to the figure the buyer saw at
 * finalization time.
 */
const composeEngineCharges = (row) => {
  const explicit = Array.isArray(row.qi_other_charges) ? row.qi_other_charges : [];
  const haveSlug = (slug) =>
    explicit.some((c) => String(c?.slug || c?.name || '').toLowerCase() === slug);
  const charges = [...explicit];
  const freight = Number(row.qi_freight_price) || 0;
  if (freight > 0 && !haveSlug('freight')) {
    charges.push({
      name: 'Freight',
      slug: 'freight',
      amount: freight,
      amount_mode: row.qi_freight_mode || 'absolute',
    });
  }
  const pkg = Number(row.qi_package_price) || 0;
  if (pkg > 0 && !haveSlug('packaging')) {
    charges.push({
      name: 'Packaging',
      slug: 'packaging',
      amount: pkg,
      amount_mode: row.qi_package_mode || 'absolute',
    });
  }
  return charges;
};

/**
 * Run pricingEngine.calculateLineTotal for a (row, qty) pair and
 * return both the engine output and a FE-friendly breakdown shape
 * matching what the matrix attaches as `engine_breakdown`. Single
 * source of truth used by the live-pricing endpoint AND by the
 * createRelease persistence path.
 */
const computeEngineForRow = (row, qty) => {
  const taxMode = row.qi_tax_mode || 'percentage';
  const engineOut = pricingEngine.calculateLineTotal({
    unit_price: row.unit_price,
    quantity: qty,
    tax: row.qi_tax,
    tax_mode: taxMode,
    other_charges: composeEngineCharges(row),
  });
  return {
    engineOut,
    breakdown: {
      quantity: qty,
      unit_price: Number(row.unit_price) || 0,
      base: engineOut.base,
      base_tax: engineOut.base_tax,
      base_tax_rate: taxMode === 'percentage' ? Number(row.qi_tax) || 0 : null,
      base_tax_mode: taxMode,
      charges: engineOut.charges,
      charges_total: engineOut.charges_total,
      total: engineOut.total,
    },
  };
};

const ArcReleaseController = {
  /**
   * GET /arc/release/eligible-vendors
   *
   * Two callers, two shapes:
   *
   *   (a) ?product_variant_id=&hotel_id=
   *       Used during product search ("which active ARCs cover this
   *       SKU at this hotel?"). Returns every (vendor × ARC) row.
   *
   *   (b) ?arc_id=&hotel_id=
   *       Used by the ARC-release wizard once the buyer has already
   *       picked an envelope. Returns every approved line item under
   *       that envelope at that hotel. The hotel must be covered by
   *       the envelope; otherwise [].
   *
   * Either pair is sufficient. Earlier the endpoint only accepted
   * (a) and 400'd the (b) flow.
   */
  getEligibleVendors: async (req, res) => {
    try {
      const product_variant_id = req.query.product_variant_id ? parseInt(req.query.product_variant_id) : null;
      const arc_id = req.query.arc_id ? parseInt(req.query.arc_id) : null;
      const hotel_id = req.query.hotel_id ? parseInt(req.query.hotel_id) : null;

      if (!hotel_id || (!product_variant_id && !arc_id)) {
        return res.status(400).json({
          status: 2,
          message: 'hotel_id is required, plus either product_variant_id or arc_id',
        });
      }

      // Branch (b): caller pinned to a specific envelope.
      if (arc_id) {
        const envelope = await arcModel.getEnvelopeForRelease({ arc_id });
        if (!envelope) {
          return res.status(404).json({ status: 2, message: `ARC envelope ${arc_id} not found` });
        }
        const covered = await arcModel.hotelCoveredByEnvelope({ arc_id, hotel_id });
        if (!covered) {
          return res.status(200).json({ status: 1, data: [] });
        }
        // Pull every approved line under the envelope, then re-shape
        // to match the (a) branch's row shape so the FE can render
        // either response uniformly.
        const itemRows = await db.any(
          `SELECT
             a.id AS arc_id,
             a.rfq_id AS source_tender_id,
             a.vendor_id,
             a.period_from,
             a.period_to,
             a.status AS envelope_status,
             a.tender_scope,
             ai.id AS arc_item_id,
             ai.product_variant_id,
             ai.unit_price,
             ai.charges_meta,
             $2::int AS hotel_id,
             COALESCE(c.company_name, u.organization_name, u.name) AS vendor_name,
             u.email AS vendor_email,
             r.rfq_no AS source_rfq_no,
             r.title AS source_rfq_title,
             pv.name AS product_name,
             (SELECT _us.value FROM tbl_rfq_products_specs _us
                WHERE _us.rfq_id = a.rfq_id
                  AND _us.product_variant_id = ai.product_variant_id
                  AND COALESCE(_us.variant, 0) = COALESCE(NULLIF(ai.variant, '')::int, 0)
                  AND LOWER(_us.title) = 'unit'
                LIMIT 1) AS unit
           FROM tbl_arc_item ai
           JOIN tbl_arc a ON a.id = ai.arc_id
           JOIN tbl_rfq r ON r.id = a.rfq_id
           JOIN tbl_users u ON u.id = a.vendor_id
           LEFT JOIN tbl_company c ON c.id = u.company_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           WHERE a.id = $1
             AND ai.status = 'APPROVED'
             AND a.status IN ('ACTIVE', 'DOC_GENERATED')
             AND a.period_to >= CURRENT_DATE
           ORDER BY ai.unit_price ASC`,
          [arc_id, hotel_id]
        );
        return res.status(200).json({ status: 1, data: itemRows });
      }

      // Branch (a): caller pinned to a product, list all envelopes.
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
   * GET /arc/release/quote?arc_item_id=&quantity=
   *
   * Live pricing for the release wizard. Given a contracted line and a
   * quantity, returns the engine grand total + full breakdown using the
   * same pricingEngine the QC page and the ARC matrix already use, so
   * the buyer sees the exact figure the persisted PO will carry — no
   * client-side math, no "indicative" caveat.
   *
   * Rejects when the envelope isn't ACTIVE/DOC_GENERATED, the period
   * has lapsed, the line isn't APPROVED, or quantity is non-positive.
   */
  getReleasePricing: async (req, res) => {
    try {
      const arc_item_id = req.query.arc_item_id ? parseInt(req.query.arc_item_id) : null;
      const quantity = Number(req.query.quantity);

      if (!arc_item_id || !(quantity > 0)) {
        return res.status(400).json({
          status: 2,
          message: 'arc_item_id and a positive quantity are required',
        });
      }

      const row = await loadArcItemEngineRow(arc_item_id);
      if (!row) {
        return res.status(404).json({ status: 2, message: 'ARC item not found' });
      }
      if (row.item_status !== 'APPROVED') {
        return res.status(400).json({ status: 0, message: 'ARC item is not approved' });
      }
      if (!['ACTIVE', 'DOC_GENERATED'].includes(row.envelope_status)) {
        return res.status(400).json({
          status: 0,
          message: `ARC envelope is in status ${row.envelope_status}; release requires ACTIVE/DOC_GENERATED`,
        });
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const from = new Date(row.period_from);
      const to = new Date(row.period_to);
      if (today < from) {
        return res.status(400).json({ status: 0, message: 'ARC has not yet started' });
      }
      if (today > to) {
        return res.status(400).json({ status: 0, message: 'ARC has expired' });
      }

      const { breakdown } = computeEngineForRow(row, quantity);

      return res.status(200).json({
        status: 1,
        data: {
          arc_item_id: row.arc_item_id,
          arc_id: row.arc_id,
          vendor_id: row.vendor_id,
          vendor_name: row.vendor_name,
          product_name: row.product_name,
          period_from: row.period_from,
          period_to: row.period_to,
          source_rfq_no: row.source_rfq_no,
          breakdown,
        },
      });
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
      const { arc_id, hotel_id, items, process_id, vendor_selection_reason } = req.body;
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
      // process_id is required — admin always configures PO approval
      // policies under a specific process. The wizard now asks the
      // buyer which process this contracted PO falls under so the
      // engine can match a policy at initiation time.
      if (!process_id) {
        return res.status(400).json({
          status: 2,
          message: 'process_id is required — pick the approval process for this contracted PO',
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

        // 5. Snapshot prices and compute line totals from the engine
        // using the canonical inputs (tax/tax_mode/freight/packaging
        // /other_charges) read from tbl_quote_items — same path the
        // pricing endpoint uses, so the persisted total matches what
        // the buyer saw on the wizard's review step exactly.
        const engineRows = await Promise.all(
          arcItemIds.map((id) => loadArcItemEngineRow(id, t))
        );
        const engineRowById = new Map(engineRows.filter(Boolean).map((r) => [r.arc_item_id, r]));
        // Reshape into the full canonical charges_meta object shape that
        // the PO read paths (purchaseOrderModel.js:636-645) consume:
        // { tax, tax_mode, freight_price, freight_mode, package_price,
        //   package_mode, other_charges:[...] }. The arc_item only
        // snapshots the `other_charges` array, so a downstream
        // `pop.charges_meta->>'tax'` would otherwise return NULL.
        const buildPoChargesMeta = (engineRow, fallbackOtherCharges) => ({
          tax: engineRow?.qi_tax ?? null,
          tax_mode: engineRow?.qi_tax_mode || 'percentage',
          freight_price: engineRow?.qi_freight_price ?? null,
          freight_mode: engineRow?.qi_freight_mode || 'absolute',
          package_price: engineRow?.qi_package_price ?? null,
          package_mode: engineRow?.qi_package_mode || 'absolute',
          other_charges: Array.isArray(engineRow?.qi_other_charges)
            ? engineRow.qi_other_charges
            : Array.isArray(fallbackOtherCharges)
              ? fallbackOtherCharges
              : [],
        });
        const releaseLines = items.map((it) => {
          const src = itemById.get(parseInt(it.arc_item_id));
          const engineRow = engineRowById.get(parseInt(it.arc_item_id));
          const qty = Number(it.quantity);
          const { engineOut } = computeEngineForRow(engineRow || { unit_price: src.unit_price }, qty);
          return {
            arc_item_id: src.id,
            rfq_product_id: src.rfq_product_id,
            product_variant_id: src.product_variant_id,
            quote_id: src.quote_id,
            quantity: qty,
            unit: 'NOS',
            unit_price: src.unit_price,
            charges_meta: buildPoChargesMeta(engineRow, src.charges_meta),
            total_price: engineOut.total,
          };
        });
        const totalValue = releaseLines.reduce((s, l) => s + Number(l.total_price || 0), 0);

        // 6.a Validate process_id belongs to the actor's tenant and
        // is active. Avoids a buyer pasting an arbitrary process_id
        // for another company's process.
        const processRow = await t.oneOrNone(
          `SELECT p.id
             FROM tbl_approval_processes p
            WHERE p.id = $1 AND p.is_active = true
              AND ($2::int IS NULL OR p.company_id = $2)`,
          [process_id, req.user?.company_id || null]
        );
        if (!processRow) {
          throw new Error('Selected approval process is invalid or not accessible');
        }

        // 6.b If multiple vendors hold contracts for this (hotel,
        // product), the buyer's reason for picking THIS vendor must
        // be recorded for audit. When only one vendor is eligible the
        // reason is optional (no choice was made). The wizard already
        // gates this; we mirror it server-side.
        const eligibleCount = await t.oneOrNone(
          `SELECT COUNT(DISTINCT a.vendor_id)::int AS cnt
             FROM tbl_arc a
             JOIN tbl_arc_hotels ah ON ah.arc_id = a.id
             JOIN tbl_arc_item ai ON ai.arc_id = a.id
            WHERE ai.product_variant_id = (
                    SELECT product_variant_id FROM tbl_arc_item WHERE id = $1
                  )
              AND ah.hotel_id = $2
              AND ai.status = 'APPROVED'
              AND a.status IN ('ACTIVE', 'DOC_GENERATED')
              AND a.period_to >= CURRENT_DATE`,
          [arcItemIds[0], hotel_id]
        );
        const choiceCount = eligibleCount?.cnt ?? 1;
        const trimmedReason = typeof vendor_selection_reason === 'string'
          ? vendor_selection_reason.trim()
          : '';
        if (choiceCount > 1 && trimmedReason.length < 30) {
          throw new Error(
            'Multiple contracted vendors are eligible — please record at least 30 characters explaining why this vendor was selected.'
          );
        }
        const persistedReason = trimmedReason.length > 0 ? trimmedReason : null;

        // 6.c Insert release header + items.
        const releaseRow = await t.one(
          `INSERT INTO tbl_arc_release
              (arc_id, hotel_id, vendor_id, created_by, status, total_value, process_id, vendor_selection_reason)
           VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7)
           RETURNING *`,
          [arc_id, hotel_id, envelope.vendor_id, created_by, totalValue, process_id, persistedReason]
        );
        for (const ln of releaseLines) {
          // pg-promise serialises JS objects/arrays as text[] when bound
          // positionally — JSON.stringify + ::jsonb cast is the safe
          // path for jsonb columns. Same fix as arcModel.upsertItem.
          const chargesMetaJson = ln.charges_meta == null ? null : JSON.stringify(ln.charges_meta);
          await t.none(
            `INSERT INTO tbl_arc_release_items
              (arc_release_id, arc_item_id, product_variant_id, quantity, unit_price, total_price, charges_meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [releaseRow.id, ln.arc_item_id, ln.product_variant_id, ln.quantity, ln.unit_price, ln.total_price, chargesMetaJson]
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

      // ri.product_variant_id FKs to tbl_product_variant (singular) —
      // .name is the variant's display name. Fall back to the parent
      // product name via tbl_product when the variant is unnamed.
      const items = await db.any(
        `SELECT ri.*,
                COALESCE(pv.name, p.name, 'Item') AS product_name
           FROM tbl_arc_release_items ri
           LEFT JOIN tbl_product_variant pv ON pv.id = ri.product_variant_id
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
