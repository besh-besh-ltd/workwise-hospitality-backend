import db, { pgp } from '../config/dbConn.js';

// Helper: parse date strings as UTC when no timezone suffix is present
// PostgreSQL returns timestamp without time zone as bare strings (e.g. "2026-03-27 18:54:00")
// which new Date() would incorrectly interpret as local time
const parseAsUTC = (dateValue) => {
  if (!dateValue) return null;
  if (dateValue instanceof Date) return dateValue;
  const str = String(dateValue);
  if (str.includes('+') || str.includes('Z')) return new Date(str);
  return new Date(str.replace(' ', 'T') + 'Z');
};

// ============= MULTI-PRODUCT ROUND HELPERS =============
// A round either targets a single product (legacy: rfq_product_id NOT NULL,
// per-vendor fields in vendor_approvals[].negotiation_fields) or multiple
// products (products JSONB: [{rfq_product_id, vendor_targets}, ...,
// {is_rfq_level: true, vendor_targets}]).

// SQL predicate: does round `nr` cover product <paramRef>? Works for both
// legacy and multi shapes. `paramRef` is a pg-promise placeholder ('$2' etc).
export const coversProductSql = (paramRef, alias = 'nr') =>
  `(${alias}.rfq_product_id = ${paramRef} OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) cp_
     WHERE (cp_->>'rfq_product_id')::int = ${paramRef}))`;

// LATERAL emitting `product_names` json array for every product the round
// covers: [{rfq_product_id, product_name}, ...]. NULL for rfq-level-only.
export const productNamesLateralSql = (alias = 'nr') =>
  `LEFT JOIN LATERAL (
     SELECT json_agg(json_build_object(
              'rfq_product_id', rp_.id,
              'product_name', COALESCE(PV_.name, P_.name, 'Product #' || rp_.product_variant_id)
            ) ORDER BY rp_.id) AS product_names
     FROM tbl_rfq_products rp_
     LEFT JOIN tbl_product_variant PV_ ON PV_.id = rp_.product_variant_id
     LEFT JOIN tbl_product P_ ON P_.id = PV_.product_id
     WHERE rp_.id = ${alias}.rfq_product_id
        OR rp_.id IN (
          SELECT (p_->>'rfq_product_id')::int
          FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) p_
          WHERE p_->>'rfq_product_id' IS NOT NULL
        )
   ) pn_ ON true`;

// Product ids covered by a round row (legacy fallback to rfq_product_id).
export const getCoveredProductIds = (round) => {
  if (Array.isArray(round?.products) && round.products.length > 0) {
    return round.products
      .map(p => p?.rfq_product_id)
      .filter(id => id != null)
      .map(Number);
  }
  return round?.rfq_product_id != null ? [Number(round.rfq_product_id)] : [];
};

// Per-vendor negotiation fields for one product (or 'RFQ_LEVEL') of a round.
export const getVendorFieldsForProduct = (round, vendorId, rfqProductId) => {
  if (Array.isArray(round?.products) && round.products.length > 0) {
    const entry = round.products.find(p => rfqProductId === 'RFQ_LEVEL'
      ? p?.is_rfq_level === true
      : Number(p?.rfq_product_id) === Number(rfqProductId));
    const vt = (entry?.vendor_targets || []).find(v => Number(v?.vendor_id) === Number(vendorId));
    return vt?.fields || [];
  }
  const va = (round?.vendor_approvals || []).find(v => Number(v?.vendor_id) === Number(vendorId));
  return va?.negotiation_fields || [];
};

// Security: when a vendor reads a round, their view of products[] must only
// carry their own vendor_targets — other vendors' targets must never leak.
export const stripProductsForVendor = (round, vendorId) => {
  if (round && Array.isArray(round.products)) {
    round.products = round.products.map(p => ({
      ...p,
      vendor_targets: (p?.vendor_targets || []).filter(
        vt => Number(vt?.vendor_id) === Number(vendorId)
      ),
    }));
  }
  return round;
};

// Backfill the singular `product_name` for multi rounds (first covered
// product) so legacy consumers keep rendering something sensible.
const normalizeProductNames = (row) => {
  if (!row) return row;
  if (!row.product_name && Array.isArray(row.product_names) && row.product_names.length > 0) {
    row.product_name = row.product_names[0]?.product_name || null;
  }
  return row;
};

const negotiationModel = {
  // ============= NEGOTIATION ROUNDS =============

  /**
   * Create a new negotiation round (product-specific).
   *
   * Polymorphic via (source_type, source_id) — defaults to 'RFQ'+rfq_id when
   * source_type/source_id aren't supplied, so existing RFQ callers don't need
   * to change. ARC commercial-eval callers pass source_type='ARC' + source_id
   * (the arc id) and leave rfq_id null.
   */
  createRound: async (roundData, txContext = null) => {
    const {
      rfq_id,
      rfq_product_id = null,
      round_number,
      target_price,
      end_date,
      status = 'DRAFT',
      created_by,
      remarks = null,
      vendor_ids = null,
      vendor_approvals = null,
      source_type,
      source_id,
      products = null
    } = roundData;

    // A round is either single-product (legacy: rfq_product_id) or
    // multi-product (products JSONB) — never neither.
    if (!rfq_product_id && !(Array.isArray(products) && products.length > 0)) {
      throw new Error('Either rfq_product_id or a non-empty products array is required');
    }

    const resolvedSourceType = source_type || (rfq_id ? 'RFQ' : null);
    const resolvedSourceId   = source_id   ?? rfq_id;

    if (!resolvedSourceType || !resolvedSourceId) {
      throw new Error('source_type + source_id (or rfq_id for RFQ flow) is required');
    }

    return (txContext || db).one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, vendor_approvals, source_type, source_id, products)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb)
       RETURNING *`,
      [rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, JSON.stringify(vendor_approvals || []), resolvedSourceType, resolvedSourceId, products ? JSON.stringify(products) : null]
    );
  },

  /**
   * Get round by ID
   */
  getRoundById: async (roundId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_negotiation_rounds WHERE id = $1`,
      [roundId]
    );
  },

  /**
   * Get all rounds for an RFQ (optionally filtered by product).
   * When vendorId is provided, returns only rounds where that vendor is in vendor_ids.
   */
  getRoundsByRfqId: async (rfqId, rfqProductId = null, vendorId = null) => {
    let query = `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1`;

    const values = [rfqId];

    if (rfqProductId) {
      values.push(rfqProductId);
      query += ` AND ${coversProductSql(`$${values.length}`)}`;
    }

    if (vendorId) {
      values.push(vendorId);
      query += ` AND $${values.length} = ANY(nr.vendor_ids)`;
    }

    // NULLS LAST keeps legacy per-product grouping while multi rounds
    // (rfq_product_id NULL) sort by round number.
    query += ` ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number ASC, nr.created_at DESC`;

    const rows = await db.any(query, values);
    rows.forEach(normalizeProductNames);
    // Vendor reads must not leak other vendors' targets.
    if (vendorId) rows.forEach(r => stripProductsForVendor(r, vendorId));
    return rows;
  },

  /**
   * Buyer landing list: every RFQ that has at least one negotiation round,
   * scoped to a hospitality company (and optionally a single hotel). One row
   * per RFQ, rolled up to the RFQ's LATEST round (max created_at), with the
   * aggregated facets the Negotiation list page renders (hotel, department,
   * product names, vendor names) plus an effective `neg_status` string the
   * page buckets into its tabs.
   *
   * neg_status mapping (latest round, with end_date check):
   *   DRAFT | PENDING_APPROVAL                 → 'pending_approval'
   *   ACTIVE & end_date in future (or null)    → 'active'
   *   ACTIVE & end_date passed, or ENDED       → 'awaiting_decision'
   *   COMPLETED                                → 'completed'
   *   CANCELLED | EXPIRED                       → 'cancelled'
   *
   * Stored timestamps are UTC-naive (timestamp without time zone), so compare
   * end_date against now() converted to UTC.
   */
  // Of the given RFQ ids, which have a negotiation approval waiting on the user
  // (current-step pending approver). NEGOTIATION instances key on the round id
  // (→ round.rfq_id); NEGOTIATION_QUOTE instances key on the rfq_product id
  // (→ product.rfq_id).
  getPendingNegotiationRfqIds: async (rfqIds, userId) => {
    if (!Array.isArray(rfqIds) || rfqIds.length === 0 || !userId) return [];
    const rows = await db.any(
      `SELECT DISTINCT rfq_id FROM (
         SELECT nr.rfq_id
           FROM tbl_approval_instances i
           JOIN tbl_negotiation_rounds nr ON nr.id = i.entity_id
           JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type = 'NEGOTIATION' AND i.status = 'PENDING'
            AND nr.rfq_id = ANY($1::int[])
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
         UNION
         SELECT rp.rfq_id
           FROM tbl_approval_instances i
           JOIN tbl_rfq_products rp ON rp.id = i.entity_id
           JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type = 'NEGOTIATION_QUOTE' AND i.status = 'PENDING'
            AND rp.rfq_id = ANY($1::int[])
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
       ) t`,
      [rfqIds.map(Number), Number(userId)]
    );
    return rows.map((r) => Number(r.rfq_id));
  },

  getNegotiationRfqList: async ({ companyIds = null, hotelIds = null }) => {
    return db.any(
      `WITH neg AS (
         SELECT nr.rfq_id,
                COUNT(*)::int AS total_rounds,
                MAX(nr.round_number) AS latest_round_number,
                (ARRAY_AGG(nr.id ORDER BY nr.created_at DESC))[1] AS latest_round_id
           FROM tbl_negotiation_rounds nr
          WHERE nr.rfq_id IS NOT NULL
          GROUP BY nr.rfq_id
       )
       SELECT rfq.id                AS rfq_id,
              rfq.rfq_no,
              rfq.title,
              rfq.is_tender,
              rfq.hotel_id,
              h.name                AS hotel_name,
              rfq.department_id,
              d.title               AS department_title,
              neg.total_rounds,
              neg.latest_round_number,
              lr.status             AS latest_round_status,
              lr.end_date,
              lr.created_at         AS latest_round_created_at,
              lr.approved_at,
              lr.published_at,
              lr.closed_at,
              COALESCE(array_length(lr.vendor_ids, 1), 0)::int AS invited_count,
              CASE
                WHEN lr.status IN ('DRAFT','PENDING_APPROVAL') THEN 'pending_approval'
                WHEN lr.status = 'ACTIVE'
                     AND (lr.end_date IS NULL OR lr.end_date > (now() AT TIME ZONE 'UTC')) THEN 'active'
                WHEN lr.status = 'ACTIVE' THEN 'awaiting_decision'
                WHEN lr.status = 'ENDED' THEN 'awaiting_decision'
                WHEN lr.status = 'COMPLETED' THEN 'completed'
                WHEN lr.status IN ('CANCELLED','EXPIRED') THEN 'cancelled'
                ELSE 'pending_approval'
              END AS neg_status,
              COALESCE(q.quotes_received, 0)::int AS quotes_received,
              COALESCE(items.item_names, '[]'::json) AS item_names,
              COALESCE(vend.vendors, '[]'::jsonb) AS vendors
         FROM neg
         JOIN tbl_rfq rfq ON rfq.id = neg.rfq_id
         JOIN tbl_negotiation_rounds lr ON lr.id = neg.latest_round_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rfq.hotel_id
         LEFT JOIN tbl_department d ON d.id = rfq.department_id
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.rfq_product_id))::int AS quotes_received
             FROM tbl_negotiation_round_quotes nrq
            WHERE nrq.negotiation_round_id = lr.id
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(DISTINCT COALESCE(PV.name, P.name))
                    FILTER (WHERE COALESCE(PV.name, P.name) IS NOT NULL) AS item_names
             FROM tbl_rfq_products rp
             LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
             LEFT JOIN tbl_product P ON P.id = PV.product_id
            WHERE rp.rfq_id = rfq.id
         ) items ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name)) AS vendors
             FROM tbl_negotiation_rounds nr2
             CROSS JOIN LATERAL unnest(COALESCE(nr2.vendor_ids, '{}'::int[])) AS vid(vendor_id)
             JOIN tbl_users u ON u.id = vid.vendor_id
            WHERE nr2.rfq_id = rfq.id
         ) vend ON TRUE
        WHERE ($1::int[] IS NULL OR rfq.hospitality_company_id = ANY($1::int[]))
          AND ($2::int[] IS NULL OR rfq.hotel_id = ANY($2::int[]))
        ORDER BY lr.created_at DESC`,
      [companyIds, hotelIds]
    );
  },

  /**
   * Get active round for a product.
   * When vendorId is provided, returns only the round assigned to that vendor.
   * When vendorId is omitted, returns the most recent active round (admin view).
   */
  getActiveRound: async (rfqId, rfqProductId, includeEnded = false, vendorId = null) => {
    if (!rfqProductId) {
      throw new Error('rfq_product_id is required');
    }

    const statusFilter = includeEnded
      ? `('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')`
      : `('PENDING_APPROVAL', 'ACTIVE')`;

    // When not including ended rounds, also exclude rounds whose end_date has passed
    const endDateFilter = includeEnded ? '' : `AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())`;

    let row;
    if (vendorId) {
      row = await db.oneOrNone(
        `SELECT
          nr.*,
          u.name as created_by_name,
          u.email as created_by_email,
          COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
          pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
           AND ${coversProductSql('$2')}
           AND nr.status IN ${statusFilter}
           ${endDateFilter}
           AND $3 = ANY(nr.vendor_ids)
         ORDER BY nr.round_number DESC
         LIMIT 1`,
        [rfqId, rfqProductId, vendorId]
      );
    } else {
      row = await db.oneOrNone(
        `SELECT
          nr.*,
          u.name as created_by_name,
          u.email as created_by_email,
          COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
          pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
           AND ${coversProductSql('$2')}
           AND nr.status IN ${statusFilter}
           ${endDateFilter}
         ORDER BY nr.round_number DESC
         LIMIT 1`,
        [rfqId, rfqProductId]
      );
    }

    normalizeProductNames(row);

    // F-NEGO-001: when a vendor is reading the round, scope vendor_approvals
    // to that vendor only — never expose other vendors' approval entries
    // (which carry their custom_charges, approval status, and acted-by ids).
    if (row && vendorId && Array.isArray(row.vendor_approvals)) {
      row.vendor_approvals = row.vendor_approvals.filter(
        (elem) => Number(elem?.vendor_id) === Number(vendorId)
      );
    }
    // Same rule for multi-product rounds: strip products[].vendor_targets
    // down to the requesting vendor.
    if (row && vendorId) stripProductsForVendor(row, vendorId);

    return row;
  },

  /**
   * Get all active rounds for an RFQ (multiple products)
   */
  getActiveRoundsByRfqId: async (rfqId, includeEnded = false) => {
    const statusFilter = includeEnded
      ? `('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')`
      : `('PENDING_APPROVAL', 'ACTIVE')`;

    // When not including ended rounds, also exclude rounds whose end_date has passed
    // (cron may not have updated the status to ENDED yet)
    const endDateFilter = includeEnded ? '' : `AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())`;

    const rows = await db.any(
      `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1
         AND nr.status IN ${statusFilter}
         ${endDateFilter}
       ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number DESC`,
      [rfqId]
    );
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get next round number for a product
   */
  getNextRoundNumber: async (rfqId, rfqProductId) => {
    if (!rfqProductId) {
      throw new Error('rfq_product_id is required');
    }

    const result = await db.oneOrNone(
      `SELECT COALESCE(MAX(round_number), 0) + 1 as next_round
       FROM tbl_negotiation_rounds
       WHERE rfq_id = $1 AND rfq_product_id = $2`,
      [rfqId, rfqProductId]
    );
    return result ? parseInt(result.next_round) : 1;
  },

  /**
   * Next round number across the whole RFQ — used for all NEW rounds
   * (multi-product rounds have no single product to scope numbering to).
   */
  getNextRoundNumberForRfq: async (rfqId) => {
    const result = await db.oneOrNone(
      `SELECT COALESCE(MAX(round_number), 0) + 1 as next_round
       FROM tbl_negotiation_rounds
       WHERE rfq_id = $1`,
      [rfqId]
    );
    return result ? parseInt(result.next_round) : 1;
  },

  /**
   * Update round status
   */
  updateRoundStatus: async (roundId, status, additionalData = {}) => {
    const updates = ['status = $2'];
    const values = [roundId, status];
    let paramIndex = 3;

    if (additionalData.approved_at !== undefined) {
      updates.push(`approved_at = $${paramIndex}`);
      values.push(additionalData.approved_at);
      paramIndex++;
    }

    if (additionalData.published_at !== undefined) {
      updates.push(`published_at = $${paramIndex}`);
      values.push(additionalData.published_at);
      paramIndex++;
    }

    if (additionalData.closed_at !== undefined) {
      updates.push(`closed_at = $${paramIndex}`);
      values.push(additionalData.closed_at);
      paramIndex++;
    }

    if (additionalData.remarks !== undefined) {
      updates.push(`remarks = $${paramIndex}`);
      values.push(additionalData.remarks);
      paramIndex++;
    }

    updates.push('updated_at = NOW()');

    return db.one(
      `UPDATE tbl_negotiation_rounds
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      values
    );
  },

  // ============= ROUND APPROVALS =============

  /**
   * Create approval records for a round (for all committee members)
   */
  createRoundApprovals: async (roundId, approverUserIds) => {
    if (!approverUserIds || approverUserIds.length === 0) {
      return [];
    }

    const rows = approverUserIds.map(userId => ({
      negotiation_round_id: roundId,
      approver_user_id: userId,
      status: 'PENDING'
    }));

    const columnSet = new pgp.helpers.ColumnSet(
      ['negotiation_round_id', 'approver_user_id', 'status'],
      { table: 'tbl_negotiation_round_approvals' }
    );

    const query = pgp.helpers.insert(rows, columnSet) + ' RETURNING *';
    return db.any(query);
  },

  /**
   * Get all approvals for a round
   */
  getRoundApprovals: async (roundId) => {
    return db.any(
      `SELECT 
        nra.*,
        u.name as approver_name,
        u.email as approver_email
       FROM tbl_negotiation_round_approvals nra
       LEFT JOIN tbl_users u ON u.id = nra.approver_user_id
       WHERE nra.negotiation_round_id = $1
       ORDER BY nra.created_at ASC`,
      [roundId]
    );
  },

  /**
   * Get approval for a specific user and round
   */
  getUserApproval: async (roundId, userId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_approvals
       WHERE negotiation_round_id = $1 AND approver_user_id = $2`,
      [roundId, userId]
    );
  },

  /**
   * Update approval status
   */
  updateApproval: async (roundId, userId, status, remarks = null) => {
    return db.one(
      `UPDATE tbl_negotiation_round_approvals
       SET status = $3,
           remarks = $4,
           acted_at = NOW()
       WHERE negotiation_round_id = $1 AND approver_user_id = $2
       RETURNING *`,
      [roundId, userId, status, remarks]
    );
  },

  /**
   * Check if all approvals are complete
   */
  areAllApprovalsComplete: async (roundId) => {
    const result = await db.one(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_count
       FROM tbl_negotiation_round_approvals
       WHERE negotiation_round_id = $1`,
      [roundId]
    );

    return {
      allApproved: parseInt(result.total) > 0 && 
                   parseInt(result.approved_count) === parseInt(result.total),
      hasRejection: parseInt(result.rejected_count) > 0,
      total: parseInt(result.total),
      approved: parseInt(result.approved_count),
      rejected: parseInt(result.rejected_count)
    };
  },

  // ============= ROUND QUOTES =============

  /**
   * Create or update vendor quote for a round
   */
  upsertRoundQuote: async (quoteData) => {
    const {
      negotiation_round_id,
      vendor_id,
      rfq_product_id,
      quoted_price,
      previous_price
    } = quoteData;

    // Insert-only (one submission per round); conflict will throw
    return db.one(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price]
    );
  },

  /**
   * Get all quotes for a round
   */
  getRoundQuotes: async (roundId) => {
    return db.any(
      `SELECT 
        nrq.*,
        u.name as vendor_name,
        u.email as vendor_email,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.negotiation_round_id = $1
       ORDER BY nrq.submitted_at DESC`,
      [roundId]
    );
  },

  /**
   * Get quotes for a specific vendor in a round
   */
  getVendorRoundQuotes: async (roundId, vendorId) => {
    return db.any(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2`,
      [roundId, vendorId]
    );
  },

  /**
   * Check if round end date has passed
   */
  isRoundExpired: async (roundId) => {
    const result = await db.oneOrNone(
      `SELECT end_date, status
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId]
    );

    if (!result) return null;

    // Check both status and end_date as fallback in case cron hasn't fired yet
    const endDatePassed = parseAsUTC(result.end_date) <= new Date();
    const expired = (result.status !== 'ACTIVE' && result.status !== 'PENDING_APPROVAL') || endDatePassed;
    return {
      expired,
      endDate: result.end_date,
      status: result.status
    };
  },

  /**
   * Get vendor's negotiation quote status for a product (checks active rounds).
   * Only considers rounds where the vendor is assigned.
   */
  getVendorNegotiationStatus: async (rfqId, rfqProductId, vendorId) => {
    // Find the latest negotiation round assigned to this vendor covering this product
    const latestRound = await db.oneOrNone(
      `SELECT nr.*,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1
         AND ${coversProductSql('$2')}
         AND $3 = ANY(nr.vendor_ids)
       ORDER BY
         CASE WHEN nr.status = 'ACTIVE' THEN 0 ELSE 1 END,
         nr.round_number DESC,
         nr.created_at DESC
       LIMIT 1`,
      [rfqId, rfqProductId, vendorId]
    );

    if (!latestRound) {
      return {
        hasActiveRound: false,
        hasRound: false,
        round: null,
        vendorQuote: null,
        hasSubmittedQuote: false
      };
    }

    normalizeProductNames(latestRound);
    // Per-product negotiation fields for this vendor (multi rounds carry them
    // in products[]; legacy in vendor_approvals[].negotiation_fields).
    const negotiationFields = getVendorFieldsForProduct(latestRound, vendorId, rfqProductId);
    stripProductsForVendor(latestRound, vendorId);
    if (Array.isArray(latestRound.vendor_approvals)) {
      latestRound.vendor_approvals = latestRound.vendor_approvals.filter(
        (elem) => Number(elem?.vendor_id) === Number(vendorId)
      );
    }

    // Check if vendor has submitted a quote for this round + product (multi
    // rounds carry one quote row per covered product — without the product
    // filter oneOrNone would throw on >1 row).
    const vendorQuote = await db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
      [latestRound.id, vendorId, rfqProductId]
    );

    // Check both status and end_date as fallback in case cron hasn't fired yet
    const endDatePassed = parseAsUTC(latestRound.end_date) <= new Date();
    const effectiveStatus = (latestRound.status === 'ACTIVE' && endDatePassed) ? 'ENDED' : latestRound.status;
    const isActive = effectiveStatus === 'ACTIVE';
    const isExpired = effectiveStatus === 'ENDED' || effectiveStatus === 'EXPIRED' || effectiveStatus === 'CLOSED' || effectiveStatus === 'COMPLETED';

    return {
      hasActiveRound: isActive,
      hasRound: true,
      round: {
        ...latestRound,
        negotiation_fields_for_product: negotiationFields,
        isExpired
      },
      vendorQuote: vendorQuote,
      hasSubmittedQuote: !!vendorQuote
    };
  },

  /**
   * Get latest rounds for an RFQ (per product) with vendor quote status.
   * Only returns rounds where the vendor is assigned via the vendor_ids array column.
   */
  getActiveRoundsWithVendorStatus: async (rfqId, vendorId) => {
    // Latest round per COVERED product assigned to this vendor. A multi
    // round (rfq_product_id NULL, products JSONB) is unnested into one row
    // per covered product so per-product lock/badge logic keeps working.
    const latestRounds = await db.any(
      `SELECT DISTINCT ON (cp.covered_product_id) nr.*,
        cp.covered_product_id,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        nrq.id as vendor_quote_id,
        nrq.quoted_price as vendor_quoted_price,
        nrq.submitted_at as vendor_submitted_at
       FROM tbl_negotiation_rounds nr
       CROSS JOIN LATERAL (
         SELECT nr.rfq_product_id AS covered_product_id
         WHERE nr.rfq_product_id IS NOT NULL
         UNION
         SELECT (p_->>'rfq_product_id')::int
         FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
         WHERE p_->>'rfq_product_id' IS NOT NULL
       ) cp
       LEFT JOIN tbl_rfq_products rp ON rp.id = cp.covered_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       LEFT JOIN tbl_negotiation_round_quotes nrq
         ON nrq.negotiation_round_id = nr.id
         AND nrq.vendor_id = $2
         AND nrq.rfq_product_id = cp.covered_product_id
       WHERE nr.rfq_id = $1
         AND $2 = ANY(nr.vendor_ids)
       ORDER BY cp.covered_product_id,
         CASE WHEN nr.status = 'ACTIVE' THEN 0 ELSE 1 END,
         nr.round_number DESC,
         nr.created_at DESC`,
      [rfqId, vendorId]
    );

    return latestRounds.map(round => {
      // Check both status and end_date as fallback in case cron hasn't fired yet
      const endDatePassed = parseAsUTC(round.end_date) <= new Date();
      const effectiveStatus = (round.status === 'ACTIVE' && endDatePassed) ? 'ENDED' : round.status;
      const isExpired = effectiveStatus === 'ENDED' || effectiveStatus === 'EXPIRED' || effectiveStatus === 'CLOSED' || effectiveStatus === 'COMPLETED';
      const coveredProductId = round.covered_product_id ?? round.rfq_product_id;
      stripProductsForVendor(round, vendorId);
      if (Array.isArray(round.vendor_approvals)) {
        round.vendor_approvals = round.vendor_approvals.filter(
          (elem) => Number(elem?.vendor_id) === Number(vendorId)
        );
      }
      return {
        ...round,
        // Per-product identity for consumers that key by rfq_product_id.
        rfq_product_id: coveredProductId,
        negotiation_fields_for_product: getVendorFieldsForProduct(round, vendorId, coveredProductId),
        isExpired,
        isActive: effectiveStatus === 'ACTIVE',
        hasSubmittedQuote: !!round.vendor_quote_id
      };
    });
  },

  /**
   * Insert vendor quote for negotiation round (only insert, no update)
   */
  insertRoundQuote: async (quoteData) => {
    const {
      negotiation_round_id,
      vendor_id,
      rfq_product_id,
      quoted_price,
      previous_price
    } = quoteData;

    return db.one(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price]
    );
  },

  // ============= QUOTE APPROVAL FUNCTIONS =============

  /**
   * Get regular quotes (from tbl_quotes) by IDs for approval
   */
  getRegularQuotesByIds: async (quoteIds, rfqId, rfqProductId) => {
    if (!quoteIds || quoteIds.length === 0) {
      return [];
    }
    return db.any(
      `SELECT
        q.id,
        q.id as quote_id,
        q.rfq_id,
        q.created_by as vendor_id,
        qi.unit_price as quoted_price,
        qi.total_price,
        qi.freight_price,
        qi.tax,
        qi.package_price,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_quotes q
       JOIN tbl_rfq_products rp ON rp.id = $3
       JOIN tbl_quote_items qi ON qi.quote_id = q.id AND qi.product_variant_id = rp.product_variant_id AND qi.variant = rp.variant
       LEFT JOIN tbl_users u ON u.id = q.created_by
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE q.id = ANY($1)
         AND q.rfq_id = $2
         AND COALESCE(q.is_regret, 0) != 1`,
      [quoteIds, rfqId, rfqProductId]
    );
  },

  /**
   * Get quotes by IDs with vendor details
   */
  getQuotesByIds: async (quoteIds) => {
    if (!quoteIds || quoteIds.length === 0) {
      return [];
    }
    return db.any(
      `SELECT
        nrq.*,
        nr.status as round_status,
        nr.round_number,
        nr.rfq_id,
        nr.end_date as round_end_date,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.id = ANY($1)`,
      [quoteIds]
    );
  },

  /**
   * Get all quotes for a product across all completed rounds
   */
  getCompletedRoundQuotesForProduct: async (rfqProductId) => {
    return db.any(
      `SELECT
        nrq.*,
        nr.round_number,
        nr.target_price,
        nr.rfq_id,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.rfq_product_id = $1
         AND nr.status = 'COMPLETED'
       ORDER BY nr.round_number DESC, nrq.quoted_price ASC`,
      [rfqProductId]
    );
  },

  /**
   * Check if quote already exists for a vendor in a round
   * @param {number} negotiation_round_id - Negotiation round ID
   * @param {number} vendor_id - Vendor ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Existing quote if found
   */
  getExistingRoundQuote: async (negotiation_round_id, vendor_id, rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT id, submitted_at FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
      [negotiation_round_id, vendor_id, rfq_product_id]
    );
  },

  getApprovalBundleForRfq: async (rfqId, userId) => {
    // 1. Get all rfq_product_ids and round_ids for this RFQ
    // NEGOTIATION instances use round_id as entity_id; NEGOTIATION_QUOTE uses product_id
    const [products, rounds] = await Promise.all([
      db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = $1`, [rfqId]),
      db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqId])
    ]);
    const productIds = products.map(p => p.id);
    const roundIds = rounds.map(r => r.id);
    if (productIds.length === 0) {
      return { negotiation_instances: {}, negotiation_quote_instances: {}, rounds_history: [] };
    }

    // Lazy-heal stale APPROVED NEGOTIATION_QUOTE rows. handlePORejection
    // cancels these when the last vendor on a product is de-finalized, but
    // rejections that pre-date that fix left orphaned APPROVED rows behind,
    // causing the negotiation modal to keep showing products as "Approved"
    // after the PO that consumed the approval was rejected. Source of truth
    // for "is this approval still in force?" is whether ANY vendor still has
    // a finalization row for the product — if none do, the approval has been
    // rolled back. Heal in-place before assembling the bundle so the modal
    // sees the corrected status.
    await db.none(
      `UPDATE tbl_approval_instances
          SET status = 'CANCELLED', completed_at = NOW()
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND status = 'APPROVED'
          AND entity_id IN (
            SELECT rp.id FROM tbl_rfq_products rp
            WHERE rp.rfq_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM tbl_quote_finalization qf
                WHERE qf.rfq_id = rp.rfq_id
                  AND qf.product_variant_id = rp.product_variant_id
                  AND qf.variant = rp.variant
              )
          )`,
      [rfqId]
    );

    // Combine both ID sets for querying (NEGOTIATION uses roundIds, NEGOTIATION_QUOTE uses productIds)
    const allEntityIds = [...new Set([...productIds, ...roundIds])];

    // 2. Fetch rounds history, approval instances, steps, approvers, and actions in parallel
    const [roundsHistory, instances, allSteps, allApprovers, allActions] = await Promise.all([
      // Full rounds history for the RFQ
      db.any(
        `SELECT nr.*, u.name as created_by_name, u.email as created_by_email,
                COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
                pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
         ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number ASC, nr.created_at DESC`,
        [rfqId]
      ),
      // All approval instances for NEGOTIATION (entity_id = round_id) and NEGOTIATION_QUOTE (entity_id = product_id)
      db.any(
        `SELECT
           i.*,
           p.entity_type as policy_entity_type,
           p.hospitality_company_id as policy_company_id,
           p.hotel_id as policy_hotel_id,
           p.department_id as policy_department_id,
           hc.name as company_name,
           hh.name as hotel_name,
           d.title as department_name,
           initiator.name as initiated_by_name,
           initiator.email as initiated_by_email,
           initiator.designation as initiated_by_designation
         FROM tbl_approval_instances i
         JOIN tbl_approval_policies p ON i.approval_policy_id = p.id
         LEFT JOIN tbl_hospitality_companies hc ON i.hospitality_company_id = hc.id
         LEFT JOIN tbl_hospitality_company_hotels hh ON i.hotel_id = hh.id
         LEFT JOIN tbl_department d ON i.department_id = d.id
         LEFT JOIN tbl_users initiator ON i.initiated_by = initiator.id
         WHERE i.entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
           AND i.entity_id = ANY($1::int[])
         ORDER BY i.created_at DESC`,
        [allEntityIds]
      ),
      // All steps for those instances
      db.any(
        `SELECT s.*, ps.approval_type, ps.approver_source_type, ps.approver_source_id
         FROM tbl_approval_instance_steps s
         LEFT JOIN tbl_approval_policy_steps ps ON s.policy_step_id = ps.id
         WHERE s.approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
             AND entity_id = ANY($1::int[])
         )
         ORDER BY s.step_order ASC`,
        [allEntityIds]
      ),
      // All approvers for those steps
      db.any(
        `SELECT
           sa.*,
           u.name as user_name,
           u.email as user_email,
           u.designation as user_designation,
           (
             SELECT d.title
             FROM tbl_user_department ud
             JOIN tbl_department d ON d.id = ud.department_id
             WHERE ud.user_id = u.id
             ORDER BY ud.id DESC
             LIMIT 1
           ) AS user_department
         FROM tbl_approval_step_approvers sa
         JOIN tbl_users u ON sa.approver_user_id = u.id
         WHERE sa.approval_instance_step_id IN (
           SELECT s.id FROM tbl_approval_instance_steps s
           WHERE s.approval_instance_id IN (
             SELECT id FROM tbl_approval_instances
             WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
               AND entity_id = ANY($1::int[])
           )
         )`,
        [allEntityIds]
      ),
      // All actions for those instances
      db.any(
        `SELECT
           a.id, a.approval_instance_id, a.approval_instance_step_id,
           a.approver_user_id, a.action, a.comment,
           a.created_at AT TIME ZONE 'UTC' AS created_at,
           u.name as actor_name,
           u.email as actor_email
         FROM tbl_approval_actions a
         JOIN tbl_users u ON a.approver_user_id = u.id
         WHERE a.approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
             AND entity_id = ANY($1::int[])
         )
         ORDER BY a.created_at ASC`,
        [allEntityIds]
      )
    ]);

    // 3. Index steps and approvers by instance/step
    const stepsByInstance = {};
    for (const step of allSteps) {
      if (!stepsByInstance[step.approval_instance_id]) {
        stepsByInstance[step.approval_instance_id] = [];
      }
      stepsByInstance[step.approval_instance_id].push(step);
    }

    const approversByStep = {};
    for (const approver of allApprovers) {
      if (!approversByStep[approver.approval_instance_step_id]) {
        approversByStep[approver.approval_instance_step_id] = [];
      }
      approversByStep[approver.approval_instance_step_id].push(approver);
    }

    const actionsByInstance = {};
    for (const action of allActions) {
      if (!actionsByInstance[action.approval_instance_id]) {
        actionsByInstance[action.approval_instance_id] = [];
      }
      actionsByInstance[action.approval_instance_id].push(action);
    }

    // 4. Assemble full instance details (matching getApprovalInstanceDetails contract)
    const negotiationInstances = {};
    const negotiationQuoteInstances = {};

    for (const inst of instances) {
      const steps = (stepsByInstance[inst.id] || []).map(step => {
        const approvers = approversByStep[step.id] || [];
        return { ...step, approvers };
      });

      // Compute can_user_approve
      let canUserApprove = false;
      let userApprovalStepId = null;
      if (userId) {
        for (const step of steps) {
          if (step.step_order === inst.current_step && inst.status === 'PENDING') {
            const userApprover = step.approvers.find(
              ap => ap.approver_user_id === userId && ap.status === 'PENDING'
            );
            if (userApprover) {
              canUserApprove = true;
              userApprovalStepId = step.id;
              break;
            }
          }
        }
      }

      // Compute total_steps
      const totalSteps = steps.length;

      const assembled = {
        id: inst.id,
        entity_type: inst.entity_type,
        entity_id: inst.entity_id,
        status: inst.status,
        current_step: inst.current_step,
        total_steps: totalSteps,
        created_at: inst.created_at,
        completed_at: inst.completed_at,
        metadata: inst.metadata,
        initiated_by: {
          user_id: inst.initiated_by,
          name: inst.initiated_by_name,
          email: inst.initiated_by_email,
          designation: inst.initiated_by_designation
        },
        policy: {
          id: inst.approval_policy_id,
          hospitality_company_id: inst.policy_company_id,
          hotel_id: inst.policy_hotel_id,
          department_id: inst.policy_department_id
        },
        scope: {
          hospitality_company_id: inst.hospitality_company_id,
          company_name: inst.company_name,
          hotel_id: inst.hotel_id,
          hotel_name: inst.hotel_name,
          department_id: inst.department_id,
          department_name: inst.department_name
        },
        can_user_approve: canUserApprove,
        user_approval_step_id: userApprovalStepId,
        steps,
        action_history: actionsByInstance[inst.id] || []
      };

      // Group by entity_type and entity_id
      const targetMap = inst.entity_type === 'NEGOTIATION' ? negotiationInstances : negotiationQuoteInstances;
      const entityId = String(inst.entity_id);
      if (!targetMap[entityId]) {
        targetMap[entityId] = [];
      }
      targetMap[entityId].push(assembled);
    }

    // 5. Attach round-level approvals to rounds_history
    // New rounds use entity_id = round.id; old rounds used entity_id = rfq_product_id.
    // Try round.id first, then fall back to matching via metadata.round_id from the product bucket.
    const enrichedRounds = roundsHistory.map(round => {
      normalizeProductNames(round);
      let roundApprovals = negotiationInstances[String(round.id)] || [];
      if (roundApprovals.length === 0) {
        // Backward compat: old instances keyed by rfq_product_id
        const productBucket = negotiationInstances[String(round.rfq_product_id)] || [];
        roundApprovals = productBucket.filter(inst => {
          if (!inst.metadata) return false;
          // New instances: match by round_id in metadata
          if (inst.metadata.round_id) {
            return inst.metadata.round_id === round.id || inst.metadata.round_id === String(round.id);
          }
          // Old instances without round_id: match by round_number if available, otherwise include
          if (inst.metadata.round_number != null) {
            return inst.metadata.round_number === round.round_number || inst.metadata.round_number === String(round.round_number);
          }
          return true;
        });
      }
      return {
        ...round,
        approvals: roundApprovals.length > 0
          ? roundApprovals[0].steps?.flatMap(s => s.approvers.map(a => ({
              id: a.id,
              approver_name: a.user_name,
              approver_email: a.user_email,
              status: a.status,
              acted_at: a.acted_at,
              comment: a.comment
            })))
          : []
      };
    });

    return {
      negotiation_instances: negotiationInstances,
      negotiation_quote_instances: negotiationQuoteInstances,
      rounds_history: enrichedRounds
    };
  },

  // ============= ROUND EXPIRATION SCHEDULING =============

  /**
   * Get rounds that need rescheduling on server startup (future end_date, still pending or active)
   */
  getRoundsForReschedule: async () => {
    // LEFT JOIN on tbl_rfq_products: multi-product rounds have a NULL
    // rfq_product_id — an INNER JOIN would silently drop them from the
    // expiry scheduler and they would never end.
    const rows = await db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date > NOW()
    `);
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get rounds that expired during server downtime (past end_date, still pending or active)
   */
  getExpiredRoundsDuringDowntime: async () => {
    // LEFT JOIN — see getRoundsForReschedule note (multi rounds have NULL
    // rfq_product_id).
    const rows = await db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date <= NOW()
    `);
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get the count of quotes submitted for a specific negotiation round
   */
  getQuoteCountForRound: async (roundId) => {
    const result = await db.one(
      `SELECT COUNT(*)::int AS count FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = $1`,
      [roundId]
    );
    return result.count;
  },

  /**
   * Get round by ID with RFQ and product info (for cron expiration handler)
   */
  getRoundWithContext: async (roundId) => {
    // LEFT JOIN — see getRoundsForReschedule note (multi rounds have NULL
    // rfq_product_id).
    const row = await db.oneOrNone(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.id = $1
    `, [roundId]);
    return normalizeProductNames(row);
  },

  // ============= ROUND VENDOR ASSIGNMENT =============

  /**
   * Get vendor IDs currently assigned to PENDING_APPROVAL or ACTIVE rounds for a product.
   * Uses the vendor_ids integer array column on tbl_negotiation_rounds.
   */
  getVendorsInActiveRounds: async (rfqId, rfqProductId) => {
    const rows = await db.any(
      `SELECT nr.vendor_ids
       FROM tbl_negotiation_rounds nr
       WHERE nr.rfq_id = $1
         AND ${coversProductSql('$2')}
         AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
         AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
         AND nr.vendor_ids IS NOT NULL`,
      [rfqId, rfqProductId]
    );
    // Flatten all vendor_ids arrays into a unique set
    const allIds = new Set();
    for (const row of rows) {
      if (Array.isArray(row.vendor_ids)) {
        row.vendor_ids.forEach(id => allIds.add(id));
      }
    }
    return [...allIds];
  },

  /**
   * Check if a vendor is assigned to a specific round
   */
  isVendorAssignedToRound: async (roundId, vendorId) => {
    const result = await db.oneOrNone(
      `SELECT $2 = ANY(vendor_ids) AS assigned
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId, vendorId]
    );
    return result ? result.assigned : false;
  },

  /**
   * Get all vendors for a product with their active negotiation round status.
   * Returns every vendor with `in_active_round` flag and `active_round_number` so
   * the frontend can show which vendors are available vs already in a round.
   */
  getVendorsForProductWithStatus: async (rfqId, rfqProductId) => {
    return db.any(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.organization_name,
         c.company_name,
         CASE WHEN active_nr.id IS NOT NULL THEN true ELSE false END AS in_active_round,
         active_nr.id AS active_round_id,
         active_nr.round_number AS active_round_number,
         active_nr.status AS active_round_status
       FROM tbl_rfq_products rp
       JOIN tbl_rfq_product_vendors rpv
         ON rpv.rfq_id = rp.rfq_id
         AND rpv.product_variant_id = rp.product_variant_id
         AND rpv.variant = rp.variant
       JOIN tbl_users u ON u.id = rpv.user_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       LEFT JOIN LATERAL (
         SELECT nr.id, nr.round_number, nr.status
         FROM tbl_negotiation_rounds nr
         WHERE nr.rfq_id = $2
           AND ${coversProductSql('$1')}
           AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
           AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
           AND u.id = ANY(nr.vendor_ids)
         ORDER BY nr.round_number DESC
         LIMIT 1
       ) active_nr ON true
       WHERE rp.id = $1
         AND rp.rfq_id = $2
       ORDER BY
         CASE WHEN active_nr.id IS NOT NULL THEN 1 ELSE 0 END,
         COALESCE(c.company_name, u.organization_name, u.name)`,
      [rfqProductId, rfqId]
    );
  },

  /**
   * Distinct vendors across every product of an RFQ — used to validate the
   * vendor list of an RFQ-level (no product) negotiation entry.
   */
  getVendorsForRfq: async (rfqId) => {
    return db.any(
      `SELECT DISTINCT u.id, u.name, u.email, u.organization_name, c.company_name
       FROM tbl_rfq_products rp
       JOIN tbl_rfq_product_vendors rpv
         ON rpv.rfq_id = rp.rfq_id
         AND rpv.product_variant_id = rp.product_variant_id
         AND rpv.variant = rp.variant
       JOIN tbl_users u ON u.id = rpv.user_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE rp.rfq_id = $1`,
      [rfqId]
    );
  },

  /**
   * Get vendor details for a specific round (from vendor_ids array column)
   */
  getVendorsForRound: async (roundId) => {
    return db.any(
      `SELECT u.id, u.name, u.email, u.organization_name, c.company_name
       FROM tbl_negotiation_rounds nr
       JOIN LATERAL unnest(nr.vendor_ids) AS vid ON true
       JOIN tbl_users u ON u.id = vid
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nr.id = $1
         AND nr.vendor_ids IS NOT NULL
       ORDER BY COALESCE(c.company_name, u.organization_name, u.name)`,
      [roundId]
    );
  },

  // ============= VENDOR-LEVEL APPROVAL =============

  /**
   * Update a single vendor's approval status within a round's vendor_approvals JSONB.
   * Returns the updated round row.
   */
  updateVendorApprovalStatus: async (roundId, vendorId, status, remarks, actedBy, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           CASE
             WHEN (elem->>'vendor_id')::int = $2
             -- Merge instead of rebuild so extra keys on the entry (e.g.
             -- legacy negotiation_fields) survive the status update.
             THEN elem || jsonb_build_object(
               'status', $3::text,
               'remarks', $4::text,
               'acted_by', $5::int,
               'acted_at', NOW()::text
             )
             ELSE elem
           END
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, vendorId, status, remarks || null, actedBy]
    );
  },

  /**
   * Bulk update all vendor approval statuses in a round.
   * Used when the entire round is approved/rejected at the round level.
   */
  updateAllVendorsStatus: async (roundId, status, remarks, actedBy, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           elem || jsonb_build_object(
             'status', $2::text,
             'remarks', $3::text,
             'acted_by', $4::int,
             'acted_at', NOW()::text
           )
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, status, remarks || null, actedBy]
    );
  },

  /**
   * Check if all vendors in a round have been approved.
   */
  areAllVendorsApproved: async (roundId, txContext = null) => {
    const result = await (txContext || db).one(
      `SELECT
         (jsonb_array_length(vendor_approvals) > 0)
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(vendor_approvals) AS elem
           WHERE elem->>'status' != 'APPROVED'
         ) AS all_approved
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId]
    );
    return result.all_approved;
  },

  /**
   * Reset a rejected vendor back to PENDING for re-evaluation.
   */
  resubmitRoundVendor: async (roundId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           CASE
             WHEN (elem->>'vendor_id')::int = $2
             -- Merge instead of rebuild so extra keys on the entry (e.g.
             -- legacy negotiation_fields) survive the reset.
             THEN elem || jsonb_build_object(
               'status', 'PENDING',
               'remarks', null,
               'acted_by', null,
               'acted_at', null
             )
             ELSE elem
           END
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, vendorId]
    );
  }
};

export default negotiationModel;

