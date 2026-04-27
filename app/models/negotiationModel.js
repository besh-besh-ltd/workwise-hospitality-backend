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

const negotiationModel = {
  // ============= NEGOTIATION ROUNDS =============

  /**
   * Create a new negotiation round (product-specific)
   */
  createRound: async (roundData, txContext = null) => {
    const {
      rfq_id,
      rfq_product_id,
      round_number,
      target_price,
      end_date,
      status = 'DRAFT',
      created_by,
      remarks = null,
      vendor_ids = null,
      vendor_approvals = null
    } = roundData;

    if (!rfq_product_id) {
      throw new Error('rfq_product_id is required for product-specific negotiation rounds');
    }

    return (txContext || db).one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, vendor_approvals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, JSON.stringify(vendor_approvals || [])]
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
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       WHERE nr.rfq_id = $1`;

    const values = [rfqId];

    if (rfqProductId) {
      values.push(rfqProductId);
      query += ` AND nr.rfq_product_id = $${values.length}`;
    }

    if (vendorId) {
      values.push(vendorId);
      query += ` AND $${values.length} = ANY(nr.vendor_ids)`;
    }

    query += ` ORDER BY nr.rfq_product_id, nr.round_number ASC, nr.created_at DESC`;

    return db.any(query, values);
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

    if (vendorId) {
      return db.oneOrNone(
        `SELECT
          nr.*,
          u.name as created_by_name,
          u.email as created_by_email,
          COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         WHERE nr.rfq_id = $1
           AND nr.rfq_product_id = $2
           AND nr.status IN ${statusFilter}
           AND $3 = ANY(nr.vendor_ids)
         ORDER BY nr.round_number DESC
         LIMIT 1`,
        [rfqId, rfqProductId, vendorId]
      );
    }

    return db.oneOrNone(
      `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       WHERE nr.rfq_id = $1
         AND nr.rfq_product_id = $2
         AND nr.status IN ${statusFilter}
       ORDER BY nr.round_number DESC
       LIMIT 1`,
      [rfqId, rfqProductId]
    );
  },

  /**
   * Get all active rounds for an RFQ (multiple products)
   */
  getActiveRoundsByRfqId: async (rfqId, includeEnded = false) => {
    const statusFilter = includeEnded
      ? `('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')`
      : `('PENDING_APPROVAL', 'ACTIVE')`;

    return db.any(
      `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       WHERE nr.rfq_id = $1
         AND nr.status IN ${statusFilter}
       ORDER BY nr.rfq_product_id, nr.round_number DESC`,
      [rfqId]
    );
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

    // Use status directly — cron sets ENDED/EXPIRED when end_date passes
    const expired = result.status !== 'ACTIVE' && result.status !== 'PENDING_APPROVAL';
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
    // Find the latest negotiation round assigned to this vendor for this product
    const latestRound = await db.oneOrNone(
      `SELECT nr.*,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       WHERE nr.rfq_id = $1
         AND nr.rfq_product_id = $2
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

    // Check if vendor has submitted a quote for this round
    const vendorQuote = await db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2`,
      [latestRound.id, vendorId]
    );

    // Use status directly — cron sets ENDED/EXPIRED when end_date passes
    const isActive = latestRound.status === 'ACTIVE';
    const isExpired = latestRound.status === 'ENDED' || latestRound.status === 'EXPIRED' || latestRound.status === 'CLOSED' || latestRound.status === 'COMPLETED';

    return {
      hasActiveRound: isActive,
      hasRound: true,
      round: {
        ...latestRound,
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
    // Get the latest round per product assigned to this vendor
    const latestRounds = await db.any(
      `SELECT DISTINCT ON (nr.rfq_product_id) nr.*,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        nrq.id as vendor_quote_id,
        nrq.quoted_price as vendor_quoted_price,
        nrq.submitted_at as vendor_submitted_at
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = nr.id AND nrq.vendor_id = $2
       WHERE nr.rfq_id = $1
         AND $2 = ANY(nr.vendor_ids)
       ORDER BY nr.rfq_product_id,
         CASE WHEN nr.status = 'ACTIVE' THEN 0 ELSE 1 END,
         nr.round_number DESC,
         nr.created_at DESC`,
      [rfqId, vendorId]
    );

    return latestRounds.map(round => {
      // Use status directly — cron sets ENDED/EXPIRED when end_date passes
      const isExpired = round.status === 'ENDED' || round.status === 'EXPIRED' || round.status === 'CLOSED' || round.status === 'COMPLETED';
      return {
        ...round,
        isExpired,
        isActive: round.status === 'ACTIVE',
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

    // Combine both ID sets for querying (NEGOTIATION uses roundIds, NEGOTIATION_QUOTE uses productIds)
    const allEntityIds = [...new Set([...productIds, ...roundIds])];

    // 2. Fetch rounds history, approval instances, steps, approvers, and actions in parallel
    const [roundsHistory, instances, allSteps, allApprovers, allActions] = await Promise.all([
      // Full rounds history for the RFQ
      db.any(
        `SELECT nr.*, u.name as created_by_name, u.email as created_by_email,
                COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         WHERE nr.rfq_id = $1
         ORDER BY nr.rfq_product_id, nr.round_number ASC, nr.created_at DESC`,
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
    return db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date > NOW()
    `);
  },

  /**
   * Get rounds that expired during server downtime (past end_date, still pending or active)
   */
  getExpiredRoundsDuringDowntime: async () => {
    return db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date <= NOW()
    `);
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
    return db.oneOrNone(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      WHERE nr.id = $1
    `, [roundId]);
  },

  // ============= ROUND VENDOR ASSIGNMENT =============

  /**
   * Get vendor IDs currently assigned to PENDING_APPROVAL or ACTIVE rounds for a product.
   * Uses the vendor_ids integer array column on tbl_negotiation_rounds.
   */
  getVendorsInActiveRounds: async (rfqId, rfqProductId) => {
    const rows = await db.any(
      `SELECT vendor_ids
       FROM tbl_negotiation_rounds
       WHERE rfq_id = $1
         AND rfq_product_id = $2
         AND status IN ('PENDING_APPROVAL', 'ACTIVE')
         AND vendor_ids IS NOT NULL`,
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
           AND nr.rfq_product_id = $1
           AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
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
             THEN jsonb_build_object(
               'vendor_id', $2::int,
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
             THEN jsonb_build_object(
               'vendor_id', $2::int,
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

