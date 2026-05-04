// arcModel.js
// All ARC-side queries (envelopes, items, hotels, releases, contracted-item
// detection). Keeps ARC SQL in one place so callers in rfqController and the
// upcoming arcReleaseController stay focused on workflow logic.

import db from '../config/dbConn.js';

const arcModel = {
  /**
   * Resolve-or-create the per-(rfq, vendor) ARC envelope and ensure the
   * covered-hotels denormalisation matches tbl_rfq_hotel_mappings.
   *
   * Idempotent. Safe to call once per product-vendor finalization.
   *
   * Returns: { id, rfq_id, vendor_id, status, period_from, period_to, ... }
   */
  ensureEnvelope: async ({ rfq_id, vendor_id, created_by, txContext = null }) => {
    const t = txContext || db;

    const rfq = await t.oneOrNone(
      `SELECT id, hospitality_company_id, tender_scope, arc_period_from, arc_period_to, is_tender
       FROM tbl_rfq WHERE id = $1`,
      [rfq_id]
    );
    if (!rfq) throw new Error(`RFQ ${rfq_id} not found`);
    if (rfq.is_tender !== 1) {
      throw new Error(`ARC envelope is only valid for tenders (rfq ${rfq_id} is_tender=${rfq.is_tender})`);
    }
    if (!rfq.tender_scope || !rfq.arc_period_from || !rfq.arc_period_to) {
      throw new Error(`Tender ${rfq_id} is missing tender_scope or ARC period dates`);
    }

    let envelope = await t.oneOrNone(
      `SELECT * FROM tbl_arc WHERE rfq_id = $1 AND vendor_id = $2`,
      [rfq_id, vendor_id]
    );

    if (!envelope) {
      envelope = await t.one(
        `INSERT INTO tbl_arc
           (rfq_id, vendor_id, hospitality_company_id, tender_scope, period_from, period_to, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_COMMITTEE', $7)
         RETURNING *`,
        [
          rfq_id,
          vendor_id,
          rfq.hospitality_company_id,
          rfq.tender_scope,
          rfq.arc_period_from,
          rfq.arc_period_to,
          created_by,
        ]
      );
    }

    // Hotels coverage — copy from the canonical tbl_rfq_hotel_mappings.
    // ON CONFLICT keeps it idempotent so re-runs don't fail.
    await t.none(
      `INSERT INTO tbl_arc_hotels (arc_id, hotel_id)
       SELECT $1, rhm.hotel_id
       FROM tbl_rfq_hotel_mappings rhm
       WHERE rhm.rfq_id = $2
       ON CONFLICT (arc_id, hotel_id) DO NOTHING`,
      [envelope.id, rfq_id]
    );

    return envelope;
  },

  /**
   * Insert a per-(product, vendor) ARC item under an existing envelope.
   * Returns the inserted row (or the existing one if the unique key collides
   * — re-finalization is idempotent at the line-item level).
   */
  upsertItem: async ({
    arc_id,
    rfq_product_id,
    product_variant_id,
    variant,
    quote_id,
    unit_price,
    charges_meta = null,
    txContext = null,
  }) => {
    const t = txContext || db;

    const existing = await t.oneOrNone(
      `SELECT * FROM tbl_arc_item
       WHERE arc_id = $1 AND product_variant_id = $2
         AND COALESCE(variant, '') = COALESCE($3::varchar, '')`,
      [arc_id, product_variant_id, variant ?? null]
    );

    if (existing) {
      // Refresh the snapshot but preserve approval state (status,
      // approval_instance_id). We do NOT silently flip an APPROVED item to
      // PENDING just because it was re-finalized; that would defeat the
      // committee audit trail. If an item must be re-evaluated, the
      // committee uses send-back (Phase 3.5) to reset.
      return existing;
    }

    return t.one(
      `INSERT INTO tbl_arc_item
         (arc_id, rfq_product_id, product_variant_id, variant, quote_id, unit_price, charges_meta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
       RETURNING *`,
      [arc_id, rfq_product_id, product_variant_id, variant ?? null, quote_id, unit_price, charges_meta]
    );
  },

  /**
   * Set the back-reference from an ARC item to its approval instance after
   * createApprovalInstance returns the new id.
   */
  setItemApprovalInstance: async ({ arc_item_id, approval_instance_id, txContext = null }) => {
    const t = txContext || db;
    await t.none(
      `UPDATE tbl_arc_item SET approval_instance_id = $1 WHERE id = $2`,
      [approval_instance_id, arc_item_id]
    );
  },

  /**
   * For a given envelope, return the decision summary used by the
   * committee-completion gate (Phase 3 / handleArcPostApproval).
   *
   * Returns: { total, pending, approved, rejected }
   */
  getEnvelopeDecisionCounts: async ({ arc_id, txContext = null }) => {
    const t = txContext || db;
    const row = await t.one(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
         COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
       FROM tbl_arc_item WHERE arc_id = $1`,
      [arc_id]
    );
    return row;
  },
};

export default arcModel;
