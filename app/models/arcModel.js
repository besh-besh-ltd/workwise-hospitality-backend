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
   * For a given (hotel, product_variant) pair, return every ARC envelope
   * that:
   *   - is in an active state (DOC_GENERATED or ACTIVE),
   *   - covers the hotel via tbl_arc_hotels,
   *   - has an APPROVED tbl_arc_item for the product_variant_id,
   *   - has a validity period that has NOT expired (period_to >= today).
   *
   * Returns rows enriched with vendor + price + period info so the
   * frontend can show the "CONTRACTED ITEM" badge and pre-populate the
   * release-PO modal without another round-trip.
   *
   * Bulk-friendly: pass arrays of product_variant_ids and hotel_ids and
   * the helper returns one row per (arc, product, hotel) match. Callers
   * can group by product_variant_id client-side.
   */
  findActiveArcsForProducts: async ({ product_variant_ids = [], hotel_ids = [], txContext = null }) => {
    if (!product_variant_ids.length || !hotel_ids.length) return [];
    const t = txContext || db;
    return t.any(
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
         ah.hotel_id,
         u.organization_name AS vendor_name,
         u.email AS vendor_email,
         r.rfq_no AS source_rfq_no,
         r.title AS source_rfq_title
       FROM tbl_arc a
       JOIN tbl_arc_hotels ah ON ah.arc_id = a.id
       JOIN tbl_arc_item ai ON ai.arc_id = a.id
       JOIN tbl_rfq r ON r.id = a.rfq_id
       JOIN tbl_users u ON u.id = a.vendor_id
       WHERE ai.product_variant_id = ANY($1::int[])
         AND ah.hotel_id = ANY($2::int[])
         AND ai.status = 'APPROVED'
         AND a.status IN ('ACTIVE', 'DOC_GENERATED')
         AND a.period_to >= CURRENT_DATE
       ORDER BY ai.product_variant_id, a.period_to DESC, ai.unit_price ASC`,
      [product_variant_ids, hotel_ids]
    );
  },

  /**
   * Read an envelope by id, with parent rfq metadata. Used by the
   * release flow to validate that a buyer can call off against this ARC.
   */
  getEnvelopeForRelease: async ({ arc_id, txContext = null }) => {
    const t = txContext || db;
    return t.oneOrNone(
      `SELECT a.*, r.rfq_no, r.title AS rfq_title, r.is_tender, r.tender_scope
       FROM tbl_arc a
       JOIN tbl_rfq r ON r.id = a.rfq_id
       WHERE a.id = $1`,
      [arc_id]
    );
  },

  /**
   * Confirm a hotel is part of the ARC's covered hotels.
   * Group ARC may cover N hotels via tbl_arc_hotels; Single ARC covers
   * exactly one. Returns true / false.
   */
  hotelCoveredByEnvelope: async ({ arc_id, hotel_id, txContext = null }) => {
    const t = txContext || db;
    const row = await t.oneOrNone(
      `SELECT 1 FROM tbl_arc_hotels WHERE arc_id = $1 AND hotel_id = $2`,
      [arc_id, hotel_id]
    );
    return !!row;
  },

  /**
   * Bulk-fetch arc_items by id, scoped to a single envelope, for the
   * release-create path. The release controller cross-checks every item
   * against this list before snapshotting prices.
   */
  getApprovedItemsForRelease: async ({ arc_id, arc_item_ids = [], txContext = null }) => {
    if (!arc_item_ids.length) return [];
    const t = txContext || db;
    // Schema-correct join: product name lives on tbl_product, not on
    // tbl_product_variants (which only has variant_name/value).
    return t.any(
      `SELECT ai.*,
              COALESCE(p.name, pv.variant_name, 'Item') AS product_name
       FROM tbl_arc_item ai
       LEFT JOIN tbl_product_variants pv ON pv.id = ai.product_variant_id
       LEFT JOIN tbl_product p ON p.id = pv.product_id
       WHERE ai.arc_id = $1
         AND ai.id = ANY($2::int[])
         AND ai.status = 'APPROVED'`,
      [arc_id, arc_item_ids]
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
