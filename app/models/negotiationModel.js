import db, { pgp } from '../config/dbConn.js';

const negotiationModel = {
  // ============= NEGOTIATION ROUNDS =============

  /**
   * Create a new negotiation round (product-specific)
   */
  createRound: async (roundData) => {
    const {
      rfq_id,
      rfq_product_id,
      round_number,
      target_price,
      end_date,
      status = 'DRAFT',
      created_by,
      remarks = null
    } = roundData;

    if (!rfq_product_id) {
      throw new Error('rfq_product_id is required for product-specific negotiation rounds');
    }

    return db.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks]
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
   * Get all rounds for an RFQ (optionally filtered by product)
   */
  getRoundsByRfqId: async (rfqId, rfqProductId = null) => {
    let query = `SELECT 
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       WHERE nr.rfq_id = $1`;
    
    const values = [rfqId];
    
    if (rfqProductId) {
      query += ` AND nr.rfq_product_id = $2`;
      values.push(rfqProductId);
    }
    
    query += ` ORDER BY nr.rfq_product_id, nr.round_number ASC, nr.created_at DESC`;
    
    return db.any(query, values);
  },

  /**
   * Get active round for a product
   */
  getActiveRound: async (rfqId, rfqProductId) => {
    if (!rfqProductId) {
      throw new Error('rfq_product_id is required');
    }
    
    return db.oneOrNone(
      `SELECT 
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       WHERE nr.rfq_id = $1
         AND nr.rfq_product_id = $2
         AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
       ORDER BY nr.round_number DESC
       LIMIT 1`,
      [rfqId, rfqProductId]
    );
  },

  /**
   * Get all active rounds for an RFQ (multiple products)
   */
  getActiveRoundsByRfqId: async (rfqId) => {
    return db.any(
      `SELECT 
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       WHERE nr.rfq_id = $1
         AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
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

    return db.one(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (negotiation_round_id, vendor_id, rfq_product_id)
       DO UPDATE SET
         quoted_price = EXCLUDED.quoted_price,
         previous_price = EXCLUDED.previous_price,
         submitted_at = NOW()
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

    const now = new Date();
    const endDate = new Date(result.end_date);
    return {
      expired: now > endDate,
      endDate: result.end_date,
      status: result.status
    };
  }
};

export default negotiationModel;

