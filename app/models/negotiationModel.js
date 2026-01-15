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
        u.email as created_by_email,
        COALESCE(PV.name, P.name) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
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
        u.email as created_by_email,
        COALESCE(PV.name, P.name) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
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
        u.email as created_by_email,
        COALESCE(PV.name, P.name) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
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

    const now = new Date();
    const endDate = new Date(result.end_date);
    return {
      expired: now > endDate,
      endDate: result.end_date,
      status: result.status
    };
  },

  /**
   * Get vendor's negotiation quote status for a product (checks active rounds)
   */
  getVendorNegotiationStatus: async (rfqId, rfqProductId, vendorId) => {
    // Find active negotiation round for this product
    const activeRound = await db.oneOrNone(
      `SELECT nr.*, 
        COALESCE(PV.name, P.name) as product_name
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       WHERE nr.rfq_id = $1 
         AND nr.rfq_product_id = $2 
         AND nr.status = 'ACTIVE'
       LIMIT 1`,
      [rfqId, rfqProductId]
    );

    if (!activeRound) {
      return {
        hasActiveRound: false,
        round: null,
        vendorQuote: null,
        hasSubmittedQuote: false
      };
    }

    // Check if vendor has submitted a quote for this round
    const vendorQuote = await db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2`,
      [activeRound.id, vendorId]
    );

    const now = new Date();
    const endDate = new Date(activeRound.end_date);
    const isExpired = now > endDate;

    return {
      hasActiveRound: true,
      round: {
        ...activeRound,
        isExpired
      },
      vendorQuote: vendorQuote,
      hasSubmittedQuote: !!vendorQuote
    };
  },

  /**
   * Get all active rounds for an RFQ with vendor quote status
   */
  getActiveRoundsWithVendorStatus: async (rfqId, vendorId) => {
    const activeRounds = await db.any(
      `SELECT nr.*, 
        COALESCE(PV.name, P.name) as product_name,
        nrq.id as vendor_quote_id,
        nrq.quoted_price as vendor_quoted_price,
        nrq.submitted_at as vendor_submitted_at
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = nr.id AND nrq.vendor_id = $2
       WHERE nr.rfq_id = $1 
         AND nr.status = 'ACTIVE'
       ORDER BY nr.rfq_product_id`,
      [rfqId, vendorId]
    );

    return activeRounds.map(round => {
      const now = new Date();
      const endDate = new Date(round.end_date);
      return {
        ...round,
        isExpired: now > endDate,
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
  }
};

export default negotiationModel;

