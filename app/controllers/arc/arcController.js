import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import rfqModel from '../../models/rfqModel.js';
import arcModel from '../../models/arcModel.js';
import negotiationModel from '../../models/negotiationModel.js';
import { getLifecycleHistory, getApprovalInstancesByEntity, cancelApprovalInstance, getApprovalInstanceById, recordLifecycleEvent, uploadToS3, resetQuoteFinalizationForSendback } from '../../models/generalModel.js';
import { executeApprovalAction } from '../../services/approvalActionService.js';
import { generateAwardDocument, sendAwardDocumentToVendor } from './arcDocumentController.js';
import { sendBackTender, getTenderIterationHistory } from '../../services/tenderSendbackService.js';
import pricingEngine from '../../services/pricingEngine.js';
import db from '../../config/dbConn.js';

/**
 * Recompute the parent envelope's status after a per-cell decision and,
 * if all items are decided AND ≥1 was approved, generate + upload the
 * consolidated ARC PDF.
 *
 * Shared between handleArcPostApproval (APPROVED dispatch) and
 * handleArcRejection (REJECTED dispatch) because both terminal cell
 * transitions need to drive the same envelope-level state machine:
 *
 *   pending > 0          → PARTIALLY_DECIDED  (no PDF)
 *   pending = 0, all rej → VOID               (no PDF)
 *   pending = 0, ≥1 appr → ACTIVE             (+ PDF + email)
 *
 * This used to be inline inside handleArcPostApproval, which meant the
 * REJECTED path could never drive the envelope to VOID — committee
 * "all reject" envelopes stayed at PENDING_COMMITTEE forever.
 */
const recomputeEnvelopeAfterDecision = async ({ arc_id, rfq_id, approver_user_id, txContext }) => {
  const t = txContext || db;

  const counts = await arcModel.getEnvelopeDecisionCounts({ arc_id, txContext: t });

  if (counts.pending > 0) {
    await t.none(
      `UPDATE tbl_arc SET status = 'PARTIALLY_DECIDED', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING_COMMITTEE'`,
      [arc_id]
    );
    await recordLifecycleEvent({
      entity_type: 'TENDER',
      entity_id: rfq_id,
      stage: 'ARC_ITEM_DECIDED',
      action: 'DECIDE_ITEM',
      performed_by: approver_user_id,
      metadata: { arc_id, decision_counts: counts },
      txContext: t,
    });
    return;
  }

  if (counts.approved === 0) {
    await t.none(`UPDATE tbl_arc SET status = 'VOID', updated_at = NOW() WHERE id = $1`, [arc_id]);
    await recordLifecycleEvent({
      entity_type: 'TENDER',
      entity_id: rfq_id,
      stage: 'ARC_VOID',
      action: 'VOID_ENVELOPE',
      performed_by: approver_user_id,
      metadata: { arc_id, decision_counts: counts },
      remarks: 'All ARC items rejected by committee',
      txContext: t,
    });
    return;
  }

  // ≥1 item approved AND no pending → consolidated PDF + ACTIVE.
  const pdfResult = await generateAwardDocument(arc_id, t);
  if (!pdfResult.ok) {
    logError(`ARC PDF generation failed for arc_id=${arc_id}: ${pdfResult.error}`);
    return;
  }

  const envelope = await t.one(
    `SELECT a.*, r.rfq_no FROM tbl_arc a
     JOIN tbl_rfq r ON r.id = a.rfq_id WHERE a.id = $1`,
    [arc_id]
  );
  const fileName = `arc-${envelope.rfq_no}-vendor-${envelope.vendor_id}-${Date.now()}.pdf`;
  const s3Key = `arc-documents/${envelope.rfq_no}/${envelope.vendor_id}/${fileName}`;
  const s3Result = await uploadToS3(pdfResult.absolutePath, s3Key);
  if (!s3Result.ok) {
    logError(`ARC PDF upload failed for arc_id=${arc_id}: ${s3Result.error}`);
    return;
  }

  await t.none(
    `UPDATE tbl_arc
     SET document_url = $2, document_generated_at = NOW(),
         status = 'ACTIVE', updated_at = NOW()
     WHERE id = $1`,
    [arc_id, s3Result.url]
  );
  await sendAwardDocumentToVendor(arc_id, s3Result.url, t);

  await recordLifecycleEvent({
    entity_type: 'TENDER', entity_id: rfq_id,
    stage: 'ARC_DOC_GENERATED', action: 'GENERATE_DOCUMENT',
    performed_by: approver_user_id,
    metadata: { arc_id, vendor_id: envelope.vendor_id, document_url: s3Result.url, decision_counts: counts },
    txContext: t,
  });
  await recordLifecycleEvent({
    entity_type: 'TENDER', entity_id: rfq_id,
    stage: 'ARC_ACTIVE', action: 'ACTIVATE',
    performed_by: approver_user_id,
    metadata: { arc_id, vendor_id: envelope.vendor_id },
    txContext: t,
  });
};

/**
 * Handle ARC post-approval actions (document generation and email)
 * Called after ARC approval instance is fully approved
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [options]
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 */
const handleArcPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    const instance = await getApprovalInstanceById(approval_instance_id, 'ARC', t);
    if (!instance || instance.status !== 'APPROVED') return;

    const arc_item_id = instance.entity_id;
    const rfq_id = instance.metadata?.rfq_id;

    // 1. Mark this ARC item APPROVED (idempotent).
    await t.none(
      `UPDATE tbl_arc_item
        SET status = 'APPROVED', approved_at = NOW(), approved_by = $2
       WHERE id = $1`,
      [arc_item_id, approver_user_id]
    );

    const arcItem = await t.oneOrNone(`SELECT arc_id FROM tbl_arc_item WHERE id = $1`, [arc_item_id]);
    if (!arcItem) {
      logger.warn(`[ARC] Item ${arc_item_id} not found after approve — skipping envelope check`);
      return;
    }

    await recomputeEnvelopeAfterDecision({
      arc_id: arcItem.arc_id, rfq_id, approver_user_id, txContext: t,
    });
  } catch (arcDocError) {
    logError(arcDocError);
  }
};

/**
 * Handle ARC rejection — counterpart to handleArcPostApproval.
 * Marks the arc_item REJECTED and recomputes envelope status. If the
 * rejection completes the envelope (no pending) AND every cell was
 * rejected, the envelope is set VOID; if ≥1 cell was approved earlier,
 * the envelope still gets the PDF and goes ACTIVE.
 */
const handleArcRejection = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;
  try {
    const instance = await getApprovalInstanceById(approval_instance_id, 'ARC', t);
    if (!instance || instance.status !== 'REJECTED') return;

    const arc_item_id = instance.entity_id;
    const rfq_id = instance.metadata?.rfq_id;
    const remarks = options?.comment || null;

    await t.none(
      `UPDATE tbl_arc_item
        SET status = 'REJECTED', rejection_remarks = COALESCE($2, rejection_remarks)
       WHERE id = $1`,
      [arc_item_id, remarks]
    );

    const arcItem = await t.oneOrNone(
      `SELECT ai.arc_id, ai.product_variant_id, ai.variant, a.vendor_id
         FROM tbl_arc_item ai JOIN tbl_arc a ON a.id = ai.arc_id
        WHERE ai.id = $1`,
      [arc_item_id]
    );
    if (!arcItem) {
      logger.warn(`[ARC] Item ${arc_item_id} not found after reject — skipping envelope check`);
      return;
    }

    // Vendor-scoped finalization cleanup. ARC supports multi-vendor: a
    // committee rejection of one (vendor, product) cell must only wipe
    // that vendor's finalization row, not the row of any other vendor
    // who also won the same product. The legacy
    // resetQuoteFinalizationForSendback helper wipes everything by
    // (rfq, product) and is wrong for the multi-vendor ARC contract.
    const finRows = await t.any(
      `SELECT * FROM tbl_quote_finalization
        WHERE rfq_id = $1 AND vendor_id = $2 AND product_variant_id = $3 AND variant = $4`,
      [rfq_id, arcItem.vendor_id, arcItem.product_variant_id, arcItem.variant]
    );
    for (const f of finRows) {
      await t.none(
        `INSERT INTO tbl_quote_finalization_history
           (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, timestamp,
            variant, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [f.rfq_id, f.rfq_no, f.quote_id, f.product_variant_id, f.vendor_id, f.created_by,
         f.timestamp, f.variant, approver_user_id]
      );
      await t.none(`DELETE FROM tbl_quote_finalization WHERE id = $1`, [f.id]);
    }

    await recomputeEnvelopeAfterDecision({
      arc_id: arcItem.arc_id, rfq_id, approver_user_id, txContext: t,
    });
  } catch (arcRejectError) {
    logError(arcRejectError);
  }
};

export { handleArcPostApproval, handleArcRejection };

const formatErrorResponse = (res, error) => {
  const message = error.message || Config.errorText.value;
  const statusCode = error.statusCode || 400;

  return res.status(statusCode).json({
    status: 3,
    message
  });
};

const ArcController = {
  /**
   * Get full tender lifecycle data for ARC Committee
   * GET /arc/tender/:rfq_id
   */
  getTenderLifecycle: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = req.query.rfq_product_id ? parseInt(req.query.rfq_product_id) : null;
      const user_id = req.user.id;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      // Get RFQ/Tender details
      const rfqData = await rfqModel.getRfqById(rfq_id, user_id, req.user.user_type, true);
      const rfq = rfqData.length > 0 ? rfqData[0] : rfqData;

      if (!rfq) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ/Tender not found'
        });
      }

      // VALIDATION: ARC is only applicable for tenders (is_tender = 1)
      if (!rfq.is_tender || rfq.is_tender !== 1) {
        return res.status(400).json({
          status: 2,
          message: 'ARC is only applicable for tenders (is_tender = 1)'
        });
      }

      // Get lifecycle history
      const lifecycleHistory = await getLifecycleHistory('TENDER', rfq_id);

      // Get ARC approval instances. Phase 2 changed entity_id from
      // rfq_product_id to arc_item.id (each product-vendor cell now has
      // its own approval). For back-compat we surface BOTH shapes:
      //   - arcApprovalInstances (legacy flat list, kept for any UI
      //     that hasn't migrated to the matrix model).
      //   - arcEnvelopes / arcItems (new shape) so the matrix UI can
      //     render rows=products, columns=vendors without N round-trips.
      const entityType = 'ARC';
      let arcApprovalInstances = [];

      // Legacy path — entity_id was rfq_product_id.
      const products = await rfqModel.getRfqProductIds(rfq_id);
      const legacyByProduct = await Promise.all(
        products.map(async (product) => {
          const instances = await getApprovalInstancesByEntity(entityType, product.id);
          return instances.map((inst) => ({ ...inst, rfq_product_id: product.id }));
        })
      );
      arcApprovalInstances = legacyByProduct.flat();

      // New path — load envelopes (per vendor) and items (per
      // product-vendor cell) for this rfq, plus the approval instance
      // attached to each item.
      // Vendor display-name resolution: a vendor user (tbl_users)
      // typically has organization_name NULL — the real org name lives
      // in tbl_company keyed by tbl_users.company_id. Fall through:
      //   tbl_company.company_name  →  tbl_users.organization_name
      //     →  tbl_users.name. Without this fallback the matrix
      // header showed "Vendor 429" instead of "Workwise IT Wale".
      const arcEnvelopes = await db.any(
        `SELECT a.*,
                COALESCE(c.company_name, u.organization_name, u.name) AS vendor_name
         FROM tbl_arc a
         LEFT JOIN tbl_users u ON u.id = a.vendor_id
         LEFT JOIN tbl_company c ON c.id = u.company_id
         WHERE a.rfq_id = $1
         ORDER BY a.created_at`,
        [rfq_id]
      );
      // Decision-grade enrichment: surface the fields a committee
      // member needs to act without leaving the matrix — vendor's
      // line comment, delivery period, payment terms, the
      // last-purchase unit price for THIS product (so the savings
      // delta is auditable), and prior PO performance for the
      // vendor (volume + rejection count). All sourced server-side
      // — the FE renders, never derives.
      const arcItems = await db.any(
        `SELECT ai.*, pv.name AS product_name,
                a.vendor_id,
                COALESCE(c.company_name, u.organization_name, u.name) AS vendor_name,
                qi.comment AS quote_comment,
                qi.delivery_period AS lead_time_days,
                -- Canonical engine inputs straight from the quote_item.
                -- tbl_arc_item.charges_meta holds ONLY the other_charges
                -- array (not the parent tax/tax_mode), so feeding it to
                -- pricingEngine alone produced a base-only total. Pull
                -- the tax/tax_mode/freight/packaging/other_charges from
                -- the snapshotted quote_item directly.
                qi.tax AS qi_tax,
                qi.tax_mode AS qi_tax_mode,
                qi.freight_price AS qi_freight_price,
                qi.freight_mode AS qi_freight_mode,
                qi.package_price AS qi_package_price,
                qi.package_mode AS qi_package_mode,
                qi.other_charges AS qi_other_charges,
                vp.payment_terms AS vendor_payment_terms,
                q.global_payment_term AS quote_global_payment_term,
                q.global_comment AS quote_global_comment,
                -- Last purchase for THIS product variant by THIS buyer
                -- on any OTHER rfq. Mirrors getRfqById's last_purchase_rate
                -- subquery shape — a recent finalized quote_item for the
                -- same product variant outside this tender.
                (
                  SELECT lpqi.unit_price
                    FROM tbl_quote_items lpqi
                    JOIN tbl_quote_finalization lpqf
                      ON lpqi.quote_id = lpqf.quote_id
                     AND lpqi.product_variant_id = lpqf.product_variant_id
                     AND COALESCE(lpqi.variant, 0) = COALESCE(lpqf.variant, 0)
                   WHERE lpqi.product_variant_id = ai.product_variant_id
                     AND lpqf.rfq_id != $1
                   ORDER BY lpqf.timestamp DESC
                   LIMIT 1
                ) AS last_purchase_unit_price,
                -- Vendor's prior PO volume + rejection count across all
                -- RFQs in the tenant — gives the approver a one-glance
                -- "do we trust this vendor?" signal.
                (
                  SELECT COUNT(*)::int
                    FROM tbl_rfq_purchase_order po_v
                   WHERE po_v.finalized_vendor_id = a.vendor_id
                     AND po_v.status NOT IN ('cancelled')
                ) AS vendor_prior_po_count,
                (
                  SELECT COUNT(*)::int
                    FROM tbl_rfq_purchase_order po_r
                   WHERE po_r.finalized_vendor_id = a.vendor_id
                     AND po_r.status = 'rejected'
                ) AS vendor_prior_po_rejections,
                ainst.id AS approval_instance_id_full,
                ainst.status AS approval_status,
                ainst.metadata AS approval_metadata
         FROM tbl_arc_item ai
         JOIN tbl_arc a ON a.id = ai.arc_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_users u ON u.id = a.vendor_id
         LEFT JOIN tbl_company c ON c.id = u.company_id
         -- tbl_arc_item.variant is varchar (legacy column type) while
         -- tbl_quote_items.variant is integer. Cast ai.variant to int
         -- via NULLIF so empty strings collapse to NULL before the
         -- COALESCE — otherwise the type union fails with
         -- "COALESCE types character varying and integer cannot be matched".
         LEFT JOIN tbl_quote_items qi
           ON qi.quote_id = ai.quote_id
          AND qi.product_variant_id = ai.product_variant_id
          AND COALESCE(qi.variant, 0) = COALESCE(NULLIF(ai.variant, '')::int, 0)
         LEFT JOIN tbl_quotes q ON q.id = ai.quote_id
         LEFT JOIN tbl_vendor_profile vp ON vp.vendor_id = a.vendor_id
         LEFT JOIN tbl_approval_instances ainst ON ainst.id = ai.approval_instance_id
         WHERE a.rfq_id = $1
         ORDER BY ai.rfq_product_id, a.vendor_id`,
        [rfq_id]
      );

      // Engine-compute each arc_item's grand total + charge breakdown
      // using the same pricingEngine.calculateLineTotal that drives
      // QC's `engine_total` / `engine_grand_total`. The FE matrix
      // renders these verbatim (no client-side math), so the "Total"
      // it shows = subtotal + base GST + every other_charge with its
      // own tax — fully consistent with what the buyer saw on the QC
      // page when they finalized the vendor.
      //
      // Single batched read of (rfq_product_id → quantity) so we can
      // multiply unit_price by the right quantity per line. Quantity
      // lives in tbl_rfq_products_specs as title='Quantity', value=N
      // (the same shape the QC view-model already consumes).
      const productIdsForEngine = [...new Set(arcItems.map((i) => i.rfq_product_id))];
      let qtyByProductId = new Map();
      if (productIdsForEngine.length > 0) {
        const qtyRows = await db.any(
          `SELECT rp.id AS rfq_product_id,
                  (SELECT s.value FROM tbl_rfq_products_specs s
                    WHERE s.rfq_id = rp.rfq_id
                      AND s.product_variant_id = rp.product_variant_id
                      AND s.variant = rp.variant
                      AND LOWER(s.title) = 'quantity'
                    LIMIT 1) AS quantity
             FROM tbl_rfq_products rp
            WHERE rp.id = ANY($1::int[])`,
          [productIdsForEngine]
        );
        qtyByProductId = new Map(qtyRows.map((r) => [r.rfq_product_id, Number(r.quantity) || 0]));
      }
      // Compose other_charges from the snapshotted quote_item using
      // the same shape pricingEngine expects: explicit other_charges
      // PLUS synthesised entries for legacy flat freight/packaging
      // fields (when the explicit array doesn't already cover them).
      // Mirrors quoteCompareService.buildEngineCharges so the matrix
      // total is byte-identical to QC's engine_grand_total.
      const composeEngineCharges = (item) => {
        const explicit = Array.isArray(item.qi_other_charges) ? item.qi_other_charges : [];
        const haveSlug = (slug) =>
          explicit.some((c) => String(c?.slug || c?.name || '').toLowerCase() === slug);
        const charges = [...explicit];
        const freight = Number(item.qi_freight_price) || 0;
        if (freight > 0 && !haveSlug('freight')) {
          charges.push({
            name: 'Freight',
            slug: 'freight',
            amount: freight,
            amount_mode: item.qi_freight_mode || 'absolute',
          });
        }
        const pkg = Number(item.qi_package_price) || 0;
        if (pkg > 0 && !haveSlug('packaging')) {
          charges.push({
            name: 'Packaging',
            slug: 'packaging',
            amount: pkg,
            amount_mode: item.qi_package_mode || 'absolute',
          });
        }
        return charges;
      };
      for (const item of arcItems) {
        const engineOut = pricingEngine.calculateLineTotal({
          unit_price: item.unit_price,
          quantity: qtyByProductId.get(item.rfq_product_id) || 0,
          tax: item.qi_tax,
          tax_mode: item.qi_tax_mode || 'percentage',
          other_charges: composeEngineCharges(item),
        });
        // Attach: engine_total = grand line total (base + base_tax +
        // all other_charges incl. their own tax). engine_breakdown is
        // the structured breakdown the FE tooltip renders.
        item.engine_total = engineOut.total;
        item.engine_breakdown = {
          quantity: qtyByProductId.get(item.rfq_product_id) || 0,
          base: engineOut.base,
          base_tax: engineOut.base_tax,
          base_tax_rate:
            (item.qi_tax_mode || 'percentage') === 'percentage'
              ? Number(item.qi_tax) || 0
              : null,
          charges: engineOut.charges,
          charges_total: engineOut.charges_total,
          total: engineOut.total,
        };
      }

      // Item-level approval instances — surface them alongside the
      // legacy product-level ones so a forwards-only client can prefer
      // them. The matrix UI uses these.
      const itemInstances = await db.any(
        `SELECT ainst.*, ai.id AS arc_item_id, ai.arc_id, ai.product_variant_id,
                ai.rfq_product_id, ai.variant, ai.unit_price, a.vendor_id
         FROM tbl_approval_instances ainst
         JOIN tbl_arc_item ai ON ai.approval_instance_id = ainst.id
         JOIN tbl_arc a ON a.id = ai.arc_id
         WHERE ainst.entity_type = 'ARC'
           AND a.rfq_id = $1
         ORDER BY ai.rfq_product_id, a.vendor_id`,
        [rfq_id]
      );
      arcApprovalInstances = [...arcApprovalInstances, ...itemInstances];

      const pendingArcApproval = arcApprovalInstances.find((inst) => inst.status === 'PENDING');

      // Get all quotes with vendor details using model
      const quotes = await rfqModel.getQuotesWithVendorDetails(rfq_id);

      // Get technical evaluation data using model
      const techEvalData = await rfqModel.getTechEvaluationData(rfq_id);

      // Get all negotiation rounds with quotes
      const negotiationRounds = await negotiationModel.getRoundsByRfqId(rfq_id);
      const roundsWithQuotes = await Promise.all(
        (negotiationRounds || []).map(async (round) => {
          const roundQuotes = await negotiationModel.getRoundQuotes(round.id);
          const approvals = await negotiationModel.getRoundApprovals(round.id);
          return {
            ...round,
            quotes: roundQuotes || [],
            approvals: approvals || []
          };
        })
      );

      // Get L1-L5 vendor rankings (finalization data) using model
      const vendorRankingsByProduct = await rfqModel.getVendorRankingsByProduct(rfq_id);

      // Group by product and rank L1-L5
      const rankingsByProduct = {};
      vendorRankingsByProduct.forEach((item, index) => {
        const key = `${item.product_variant_id}_${item.variant}`;
        if (!rankingsByProduct[key]) {
          rankingsByProduct[key] = [];
        }
        // Only add if not already added (avoid duplicates)
        const exists = rankingsByProduct[key].some(r => r.vendor_id === item.vendor_id);
        if (!exists && rankingsByProduct[key].length < 5) {
          rankingsByProduct[key].push({
            ...item,
            rank: rankingsByProduct[key].length + 1
          });
        }
      });

      // Get sampling data using model
      const samplingData = await rfqModel.getSamplingData(rfq_id);

      // Hotels covered by this tender. For Group ARC tenders this is
      // the canonical N>1 list; the FE uses the count for the
      // "X hotels covered" line + tender_scope sanity. Mirrors the
      // shape rfqModel.saveDraft persists (delete-then-insert into
      // tbl_rfq_hotel_mappings).
      const hotelMappings = await db.any(
        `SELECT rhm.hotel_id, h.name AS hotel_name
           FROM tbl_rfq_hotel_mappings rhm
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rhm.hotel_id
          WHERE rhm.rfq_id = $1
          ORDER BY rhm.hotel_id`,
        [rfq_id]
      );
      // Attach onto the rfq object so consumers don't have to know
      // about a separate sibling field. tender_scope is already on
      // rfq from getRfqById; we only enrich with hotels here.
      rfq.hotels = hotelMappings || [];
      rfq.hotel_count = hotelMappings.length;

      return res.status(200).json({
        status: 1,
        data: {
          rfq,
          lifecycleHistory: lifecycleHistory || [],
          quotes: quotes || [],
          techEvaluation: techEvalData || [],
          negotiationRounds: roundsWithQuotes || [],
          vendorRankings: rankingsByProduct,
          sampling: samplingData || [],
          arcApproval: {
            instances: arcApprovalInstances || [],
            pending: pendingArcApproval || null,
            entityType: entityType,
            // Phase 3 matrix view: envelopes (per vendor) + items
            // (per product-vendor cell) so the FE renders rows=products,
            // columns=vendors without aggregating from instance metadata.
            envelopes: arcEnvelopes || [],
            items: arcItems || [],
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get list of RFQs pending ARC approval
   * GET /arc/rfqs
   */
  getRfqList: async (req, res) => {
    try {
      const { page = 1, limit = 50, project_id, show_all } = req.query;
      const user_id = req.user?.id;

      // Get products with ARC approvals (tenders only)
      const result = await rfqModel.getRfqsPendingArcApproval({
        page: parseInt(page),
        limit: parseInt(limit),
        project_id,
        is_tender: 1, // Only tenders
        user_id,
        includeAll: show_all === '1' || show_all === 1
      });

      return res.status(200).json({
        status: 1,
        data: result.rfqs,
        total: result.total,
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve/Reject/Send To stage
   * POST /arc/tender/:rfq_id/action
   */
  performAction: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const { action, target_stage, remarks, approval_instance_id, approval_instance_step_id, rfq_product_id } = req.body;
      const user_id = req.user.id;

      if (!rfq_id || !action) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id and action are required'
        });
      }

      // Validate action
      const validActions = ['approve', 'reject', 'send_to'];
      if (!validActions.includes(action)) {
        return res.status(400).json({
          status: 2,
          message: `Invalid action. Must be one of: ${validActions.join(', ')}`
        });
      }

      // Get RFQ to validate tender
      const rfq = await rfqModel.getRfqDetailsById(rfq_id);

      if (!rfq) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ/Tender not found'
        });
      }

      // VALIDATION: ARC is only applicable for tenders (is_tender = 1)
      if (!rfq.is_tender || rfq.is_tender !== 1) {
        return res.status(400).json({
          status: 2,
          message: 'ARC is only applicable for tenders (is_tender = 1)'
        });
      }

      // Use 'ARC' as entity type for ARC approvals
      const entityType = 'ARC';

      // Resolve the pending instance.
      //
      // Phase 2 changed the entity_id of an ARC approval instance from
      // rfq_product_id to arc_item.id (per-cell granularity for the
      // committee matrix). The lookup paths must support both the new
      // (matrix) callers and the older legacy callers:
      //
      //   1. New matrix UI: passes approval_instance_id directly. Fetch
      //      it by id and validate it's PENDING + ARC + belongs to this
      //      rfq. This is the preferred path.
      //   2. Legacy product-level callers: pass rfq_product_id. Resolve
      //      arc_items for that product within this rfq, then their
      //      approval instances.
      //   3. No identifier supplied: fall back to the first pending ARC
      //      instance under any arc_item belonging to this rfq.
      //
      // entity_type='ARC' + entity_id=rfq_product_id is no longer a
      // valid pairing — that data lookup never returns matches in the
      // post-Phase-2 schema and was the cause of the 400 the committee
      // matrix saw on every cell action.
      let approvalInstances = [];
      let pendingInstance = null;

      if (approval_instance_id) {
        const direct = await getApprovalInstanceById(approval_instance_id, entityType);
        if (!direct) {
          return res.status(404).json({
            status: 2,
            message: `ARC approval instance ${approval_instance_id} not found`,
          });
        }
        // Defence: the instance must belong to an arc_item under this rfq.
        const ownership = await db.oneOrNone(
          `SELECT 1 FROM tbl_arc_item ai
             JOIN tbl_arc a ON a.id = ai.arc_id
            WHERE ai.id = $1 AND a.rfq_id = $2 LIMIT 1`,
          [direct.entity_id, rfq_id]
        );
        if (!ownership) {
          return res.status(403).json({
            status: 2,
            message: 'Approval instance does not belong to this tender',
          });
        }
        approvalInstances = [direct];
        pendingInstance = direct.status === 'PENDING' ? direct : null;
      } else {
        // Discover via arc_item.id under the rfq, optionally narrowed by
        // rfq_product_id.
        const arcItemIds = (await db.any(
          rfq_product_id
            ? `SELECT ai.id FROM tbl_arc_item ai
                 JOIN tbl_arc a ON a.id = ai.arc_id
                 WHERE a.rfq_id = $1 AND ai.rfq_product_id = $2`
            : `SELECT ai.id FROM tbl_arc_item ai
                 JOIN tbl_arc a ON a.id = ai.arc_id
                 WHERE a.rfq_id = $1`,
          rfq_product_id ? [rfq_id, rfq_product_id] : [rfq_id]
        )).map((r) => r.id);

        if (arcItemIds.length > 0) {
          const all = await Promise.all(
            arcItemIds.map((id) => getApprovalInstancesByEntity(entityType, id))
          );
          approvalInstances = all.flat();
          pendingInstance = approvalInstances.find((inst) => inst.status === 'PENDING') || null;
        }
      }

      if (!pendingInstance && (action === 'approve' || action === 'reject')) {
        return res.status(400).json({
          status: 2,
          message: 'No pending ARC approval instance found' + (rfq_product_id ? ` for product ${rfq_product_id}` : ' for this RFQ'),
        });
      }

      let result;

      if (action === 'approve' || action === 'reject') {
        // Use approval system for approve/reject
        if (!approval_instance_id && !pendingInstance) {
          return res.status(400).json({
            status: 2,
            message: 'approval_instance_id is required or no pending instance found'
          });
        }

        const instanceId = approval_instance_id || pendingInstance.id;
        const actionType = action.toUpperCase() === 'APPROVE' ? 'APPROVE' : 'REJECT';

        try {
          // executeApprovalAction wraps submitApprovalAction and centrally
          // dispatches handleArcPostApproval on APPROVED, so the explicit
          // post-action call that previously lived here is no longer needed.
          result = await executeApprovalAction({
            approval_instance_id: instanceId,
            approval_instance_step_id: approval_instance_step_id || null,
            approver_user_id: user_id,
            action: actionType,
            comment: remarks || null
          });

          // ARC rejection cleanup is handled inside handleArcRejection
          // (dispatched by executeApprovalAction). It marks the arc_item
          // REJECTED, wipes ONLY the (vendor, product) finalization row
          // for the rejected cell, and recomputes envelope status.
          //
          // The legacy resetQuoteFinalizationForSendback helper used
          // (rfq, product)-scoped wipe — wrong for multi-vendor ARC
          // because rejecting one vendor's cell would also wipe other
          // vendors' finalization rows for the same product. That call
          // is intentionally removed here.

          // Record lifecycle event
          let stage = 'ARC_APPROVED';
          if (action === 'reject') {
            stage = 'ARC_REJECTED';
          } else if (result.instance_status === 'APPROVED') {
            stage = 'ARC_APPROVED';
          } else {
            stage = 'ARC_PENDING';
          }

          // Get rfq_product_id from approval instance metadata
          const instanceMetadata = pendingInstance?.metadata || {};
          const rfq_product_id = instanceMetadata.rfq_product_id || (rfq_product_id ? rfq_product_id : null);
          
          await recordLifecycleEvent({
            entity_type: 'TENDER', // Always TENDER for ARC
            entity_id: rfq_id,
            stage,
            action: actionType,
            performed_by: user_id,
            metadata: {
              rfq_product_id: rfq_product_id,
              approval_instance_id: instanceId,
              step_status: result.step_status,
              instance_status: result.instance_status,
              next_step: result.next_step || null
            },
            remarks: remarks || null
          });

          return res.status(200).json({
            status: 1,
            message: result.message || `Action ${action} performed successfully`,
            data: {
              rfq_id,
              action,
              approval_result: result,
              performed_by: user_id,
              performed_at: new Date()
            }
          });
        } catch (approvalError) {
          logError(approvalError);
          return res.status(400).json({
            status: 2,
            message: approvalError.message || `Failed to ${action} ARC approval`
          });
        }
      } else if (action === 'send_to') {
        // Phase 3.5: send-back delegates to tenderSendbackService for
        // the full snapshot-and-wipe pipeline. The service captures
        // the affected state into tbl_tender_sendback_history before
        // any deletes, cancels (not deletes) every relevant approval
        // instance, wipes the live tables per the wipe-plan matrix,
        // and bumps tbl_rfq.iteration_number. The lifecycle event is
        // emitted inside the service.
        if (!target_stage) {
          return res.status(400).json({ status: 2, message: 'target_stage is required for send_to action' });
        }
        if (!remarks || remarks.trim().length < 30) {
          return res.status(400).json({
            status: 2,
            message: 'A reason of at least 30 characters is required when sending a tender back.',
          });
        }
        const fromStage = 'ARC'; // this controller endpoint is the ARC committee surface
        try {
          const result = await sendBackTender({
            rfq_id,
            from_stage: fromStage,
            to_stage: target_stage.toUpperCase(),
            reason: remarks,
            performed_by: user_id,
          });
          return res.status(200).json({
            status: 1,
            message: `Tender sent back to ${target_stage} successfully (iteration ${result.iteration_after}).`,
            data: {
              rfq_id,
              action,
              target_stage: target_stage.toUpperCase(),
              stage: 'TENDER_SENDBACK',
              ...result,
              performed_by: user_id,
              performed_at: new Date(),
            },
          });
        } catch (sendBackErr) {
          logError('Send-back failed', sendBackErr);
          return res.status(400).json({
            status: 2,
            message: sendBackErr.message || 'Failed to send tender back',
          });
        }
      }
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get ARC document URL from approval instance metadata
   * GET /arc/document/:approval_instance_id
   */
  /**
   * GET /arc/tender/:rfq_id/iteration-history
   * Returns the full snapshot history (newest first) for the
   * IterationHistoryPanel on the FE.
   */
  iterationHistory: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      if (!rfq_id) {
        return res.status(400).json({ status: 2, message: 'rfq_id is required' });
      }
      const data = await getTenderIterationHistory(rfq_id);
      return res.status(200).json({ status: 1, data });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getArcDocument: async (req, res) => {
    try {
      const approval_instance_id = parseInt(req.params.approval_instance_id);
      
      if (!approval_instance_id) {
        return res.status(400).json({
          status: 2,
          message: 'approval_instance_id is required'
        });
      }
      
      // Get approval instance using model
      const instance = await getApprovalInstanceById(approval_instance_id, 'ARC');
      
      if (!instance) {
        return res.status(404).json({
          status: 2,
          message: 'ARC approval instance not found'
        });
      }
      
      const metadata = instance.metadata || {};
      const documentUrl = metadata.award_document_url;
      
      if (!documentUrl) {
        return res.status(404).json({
          status: 2,
          message: 'ARC document not yet generated'
        });
      }
      
      return res.status(200).json({
        status: 1,
        data: {
          document_url: documentUrl,
          generated_at: metadata.award_document_generated_at,
          generated_by: metadata.award_document_generated_by,
          approval_instance_id: instance.id,
          status: instance.status
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }
};

export default ArcController;

