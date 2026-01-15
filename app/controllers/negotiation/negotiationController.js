import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import negotiationModel from '../../models/negotiationModel.js';
import rfqModel from '../../models/rfqModel.js';
import {
  recordLifecycleEvent,
  createApprovalInstance,
  submitApprovalAction,
  getApprovalInstancesByEntity
} from '../../models/generalModel.js';
import db, { pgp } from '../../config/dbConn.js';

const formatErrorResponse = (res, error) => {
  const statusCode = error.statusCode || 400;
  const message = error.message || Config.errorText.value;
  return res.status(statusCode).json({
    status: 3,
    message
  });
};

/**
 * Handle NEGOTIATION post-approval actions (add quotes to finalization)
 * Called after NEGOTIATION approval instance is fully approved
 */
const handleNegotiationPostApproval = async (approval_instance_id, approver_user_id, txContext = null) => {
  const t = txContext || db;
  
  try {
    // Get approval instance
    const { getApprovalInstanceById } = await import('../../models/generalModel.js');
    const instance = await getApprovalInstanceById(approval_instance_id, 'NEGOTIATION', t);
    if (!instance || instance.status !== 'APPROVED') {
      return; // Not approved yet or not NEGOTIATION type
    }

    const rfq_product_id = instance.entity_id;
    const metadata = instance.metadata || {};
    const rfq_id = metadata.rfq_id;

    if (rfq_id && metadata.selected_quotes && metadata.selected_quotes.length > 0) {
      // Get RFQ data
      const rfq = await t.oneOrNone(`SELECT * FROM tbl_rfq WHERE id = $1`, [rfq_id]);

      if (rfq) {
        // Get product details
        const product = await t.oneOrNone(`
          SELECT rp.*, rp.product_variant_id, rp.variant
          FROM tbl_rfq_products rp
          WHERE rp.id = $1
        `, [rfq_product_id]);

        if (product) {
          // Add each selected quote to finalization
          for (const selectedQuote of metadata.selected_quotes) {
            // Check if this vendor is already finalized for this product
            const existingFinalization = await t.oneOrNone(`
              SELECT id FROM tbl_quote_finalization
              WHERE rfq_id = $1
                AND product_variant_id = $2
                AND variant = $3
                AND vendor_id = $4
            `, [rfq_id, product.product_variant_id, product.variant, selectedQuote.vendor_id]);

            if (existingFinalization) {
              // Update existing finalization
              await t.none(`
                UPDATE tbl_quote_finalization
                SET quote_id = $1, created_by = $2, created_at = NOW()
                WHERE id = $3
              `, [selectedQuote.quote_id, approver_user_id, existingFinalization.id]);
            } else {
              // Insert new finalization record
              await t.none(`
                INSERT INTO tbl_quote_finalization
                (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, timestamp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
              `, [
                rfq_id,
                rfq.rfq_no,
                product.product_variant_id,
                selectedQuote.vendor_id,
                selectedQuote.quote_id,
                approver_user_id,
                product.variant
              ]);
            }
          }

          // Record lifecycle event
          await recordLifecycleEvent({
            entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'APPROVE',
            performed_by: approver_user_id,
            metadata: {
              approval_instance_id: approval_instance_id,
              rfq_product_id: rfq_product_id,
              quote_ids: metadata.selected_quotes.map(q => q.quote_id),
              vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
            },
            txContext: t
          });
        }
      }
    }
  } catch (negQuoteError) {
    // Log but don't fail the transaction
    console.error('Error handling NEGOTIATION post-approval:', negQuoteError);
  }
};

/**
 * startApprovalForNegotiation
 *
 * Creates an approval instance for a negotiation round using the centralized approval engine.
 * Uses entity_type: 'NEGOTIATION' and entity_id: rfq_product_id.
 *
 * @param {number} rfqProductId - The RFQ product ID (used as entity_id)
 * @param {number} roundId - The negotiation round ID
 * @param {number} roundNumber - The round number
 * @param {number} rfqId - The RFQ ID
 * @param {Object} rfqData - The RFQ data containing hospitality_company_id, hotel_id, etc.
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if auto-approved
 */
const startApprovalForNegotiation = async (rfqProductId, roundId, roundNumber, rfqId, rfqData, userId, txContext) => {
  try {
    const result = await createApprovalInstance({
      entity_type: 'NEGOTIATION',
      entity_id: rfqProductId,
      hospitality_company_id: rfqData.hospitality_company_id,
      hotel_id: rfqData.hotel_id || null,
      initiated_by: userId,
      metadata: {
        round_id: roundId,
        round_number: roundNumber,
        rfq_id: rfqId,
        rfq_number: rfqData.rfq_no,
        is_tender: rfqData.is_tender,
        rfq_product_id: rfqProductId
      },
      txContext
    });

    return result;
  } catch (error) {
    // If no policy exists, throw error (don't auto-approve)
    if (error.message && error.message.includes('No approval policy found')) {
      throw new Error('No approval policy found for NEGOTIATION_QUOTE. Please configure an approval policy before submitting quotes for approval.');
    }
    throw error;
  }
};

/**
 * startApprovalForNegotiationQuotes
 *
 * Creates an approval instance for selected negotiation quotes.
 * Uses entity_type: 'NEGOTIATION_QUOTE' and entity_id: rfq_product_id.
 *
 * @param {number} rfqProductId - The RFQ product ID (used as entity_id)
 * @param {number} rfqId - The RFQ ID
 * @param {Array} selectedQuotes - Array of selected quote objects with full details
 * @param {Object} rfqData - The RFQ data containing hospitality_company_id, hotel_id, etc.
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if auto-approved
 */
const startApprovalForNegotiationQuotes = async (rfqProductId, rfqId, selectedQuotes, rfqData, userId, txContext) => {
  try {
    const result = await createApprovalInstance({
      entity_type: 'NEGOTIATION_QUOTE',
      entity_id: rfqProductId,
      hospitality_company_id: rfqData.hospitality_company_id,
      hotel_id: rfqData.hotel_id || null,
      initiated_by: userId,
      metadata: {
        rfq_id: rfqId,
        rfq_no: rfqData.rfq_no,
        rfq_product_id: rfqProductId,
        is_tender: rfqData.is_tender,
        selected_quotes: selectedQuotes.map(q => ({
          quote_id: q.id,
          vendor_id: q.vendor_id,
          vendor_name: q.vendor_name || q.organization_name,
          quoted_price: q.quoted_price,
          negotiation_round_id: q.negotiation_round_id,
          submitted_at: q.submitted_at
        })),
        submitted_at: new Date().toISOString()
      },
      txContext
    });

    return result;
  } catch (error) {
    // If no policy exists, throw error (don't auto-approve)
    if (error.message && error.message.includes('No approval policy found')) {
      throw new Error('No approval policy found for Quotes Approval. Please configure an approval policy before submitting quotes for approval.');
    }
    throw error;
  }
};

/**
 * addQuotesToFinalization
 *
 * Adds approved negotiation quotes to tbl_quote_finalization.
 * This is called either on auto-approval or after full committee approval.
 *
 * @param {number} rfqId - The RFQ ID
 * @param {number} rfqProductId - The RFQ product ID
 * @param {Array} quotes - Array of approved quote objects
 * @param {number} userId - The user ID who approved/initiated
 * @param {Object} rfqData - The RFQ data
 * @param {Object} txContext - Transaction context
 */
const addQuotesToFinalization = async (rfqId, rfqProductId, quotes, userId, rfqData, txContext) => {
  const t = txContext || db;

  // Get product details using model
  const product = await rfqModel.getRfqProductById(rfqProductId, rfqId, t);
  
  if (!product) {
    throw new Error('RFQ product not found');
  }

  for (const quote of quotes) {
    // Check if this vendor is already finalized using model
    const existingFinalization = await rfqModel.getExistingFinalization(
      rfqId, 
      product.product_variant_id, 
      product.variant, 
      quote.vendor_id,
      t
    );

    if (existingFinalization) {
      // Update existing finalization with new quote info
      await t.none(
        `UPDATE tbl_quote_finalization
         SET quote_id = $1, created_by = $2, created_at = NOW()
         WHERE id = $3`,
        [quote.id, userId, existingFinalization.id]
      );
    } else {
      // Insert new finalization record
      await t.none(
        `INSERT INTO tbl_quote_finalization
         (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          rfqId,
          rfqData.rfq_no,
          product.product_variant_id,
          quote.vendor_id,
          quote.id,
          userId,
          product.variant
        ]
      );
    }
  }
  // Note: ARC creation is now handled immediately during product finalization, not here
};

// Export the helper function for use in general controller
export { handleNegotiationPostApproval };

const NegotiationController = {
  /**
   * Create a new negotiation round (product-specific)
   * POST /negotiation/rounds
   */
  createRound: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, target_price, end_date } = req.body;
      const user_id = req.user.id;

      if (!rfq_id || !rfq_product_id || !target_price || !end_date) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id, rfq_product_id, target_price, and end_date are required'
        });
      }

      // Validate end_date is in the future
      const endDate = new Date(end_date);
      const now = new Date();
      if (endDate <= now) {
        return res.status(400).json({
          status: 2,
          message: 'End date must be in the future'
        });
      }

      // Check if RFQ exists and get hospitality context
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if (!rfq || rfq.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      const rfqData = rfq[0];
      if (!rfqData.hospitality_company_id) {
        return res.status(400).json({
          status: 2,
          message: 'Negotiation rounds are only available for hospitality RFQs/Tenders'
        });
      }

      // Check if product exists using model
      const product = await rfqModel.getRfqProductById(rfq_product_id, rfq_id);
      if (!product) {
        return res.status(404).json({
          status: 2,
          message: 'Product not found in this RFQ'
        });
      }

      // Check if there's an active round for this product
      const activeRound = await negotiationModel.getActiveRound(rfq_id, rfq_product_id);
      if (activeRound) {
        return res.status(400).json({
          status: 2,
          message: `Round ${activeRound.round_number} is still active for this product. Please complete or cancel it first.`
        });
      }

      // Get next round number for this product
      const round_number = await negotiationModel.getNextRoundNumber(rfq_id, rfq_product_id);

      // Create round in transaction
      const result = await db.tx(async (t) => {
        // Create the round via model (uses tx)
        const round = await negotiationModel.createRound({
          rfq_id,
          rfq_product_id,
          round_number,
          target_price,
          end_date,
          status: 'PENDING_APPROVAL',
          created_by: user_id
        }, t);

        // Create approval instance using the centralized approval engine
        const approvalResult = await startApprovalForNegotiation(
          rfq_product_id,
          round.id,
          round_number,
          rfq_id,
          rfqData,
          user_id,
          t
        );

        // If no policy exists or auto-approved, activate the round immediately
        if (!approvalResult || approvalResult.autoApproved) {
          await t.none(
            `UPDATE tbl_negotiation_rounds
             SET status = 'ACTIVE', published_at = NOW()
             WHERE id = $1`,
            [round.id]
          );
        }

        // Get updated round status
        const updatedRound = await negotiationModel.getRoundById(round.id);

        // Record lifecycle event
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: rfq_id,
          stage: round_number === 1 ? 'NEGOTIATION_STARTED' : `NEGOTIATION_ROUND_${round_number}`,
          action: 'CREATE_ROUND',
          performed_by: user_id,
          metadata: {
            round_id: updatedRound.id,
            round_number: round_number,
            rfq_product_id: rfq_product_id,
            target_price: target_price,
            status: updatedRound.status
          },
          txContext: t
        });

        return updatedRound || round;
      });

      return res.status(200).json({
        status: 1,
        data: result,
        message: `Negotiation round ${round_number} created successfully. Awaiting committee approval.`
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all rounds for an RFQ
   * GET /negotiation/rounds/:rfq_id
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getRounds: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      const rounds = await negotiationModel.getRoundsByRfqId(rfq_id);

      return res.status(200).json({
        status: 1,
        data: rounds
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get active round for a product
   * GET /negotiation/rounds/:rfq_id/active?rfq_product_id=123
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getActiveRound: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = req.query.rfq_product_id ? parseInt(req.query.rfq_product_id) : null;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      const round = await negotiationModel.getActiveRound(rfq_id, rfq_product_id);

      if (!round) {
        return res.status(200).json({
          status: 1,
          data: null,
          message: 'No active round found for this product'
        });
      }

      return res.status(200).json({
        status: 1,
        data: round
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all active rounds for an RFQ (all products)
   * GET /negotiation/rounds/:rfq_id/active-all
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getActiveRounds: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      const rounds = await negotiationModel.getActiveRoundsByRfqId(rfq_id);

      return res.status(200).json({
        status: 1,
        data: rounds || []
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve a negotiation round
   * POST /negotiation/rounds/:id/approve
   */
  approveRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      // Get approval instance for this negotiation (entity_type: NEGOTIATION, entity_id: rfq_product_id)
      const instances = await getApprovalInstancesByEntity('NEGOTIATION', round.rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending approval instance found for this round'
        });
      }

      // Submit approval action using the centralized approval engine
      const approvalResult = await submitApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'APPROVE',
        comment: remarks || null
      });

      const isFullyApproved = approvalResult.instance_status === 'APPROVED';

      // Handle NEGOTIATION post-approval actions (add quotes to finalization) if fully approved
      if (isFullyApproved) {
        await handleNegotiationPostApproval(pendingInstance.id, user_id);
      }

      // If fully approved, update round status to ACTIVE
      if (isFullyApproved) {
        await negotiationModel.updateRoundStatus(round_id, 'ACTIVE', {
          approved_at: new Date(),
          published_at: new Date()
        });

        // Record lifecycle event for round published
        const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
        const rfqData = rfq[0];
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: round.rfq_id,
          stage: `NEGOTIATION_ROUND_${round.round_number}`,
          action: 'ROUND_PUBLISHED',
          performed_by: user_id,
          metadata: {
            round_id: round_id,
            round_number: round.round_number
          }
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          approved: true,
          allApproved: isFullyApproved,
          published: isFullyApproved
        },
        message: isFullyApproved
          ? 'Round approved and published to vendors'
          : 'Round approved. Waiting for other approvers.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Reject a negotiation round
   * POST /negotiation/rounds/:id/reject
   */
  rejectRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'Remarks are required for rejection'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      // Get approval instance for this negotiation (entity_type: NEGOTIATION, entity_id: rfq_product_id)
      const instances = await getApprovalInstancesByEntity('NEGOTIATION', round.rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending approval instance found for this round'
        });
      }

      // Submit rejection action using the centralized approval engine
      await submitApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'REJECT',
        comment: remarks
      });

      // Update round status to CANCELLED
      await negotiationModel.updateRoundStatus(round_id, 'CANCELLED', {
        remarks: remarks
      });

      return res.status(200).json({
        status: 1,
        data: {
          rejected: true
        },
        message: 'Round rejected successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Close a negotiation round
   * POST /negotiation/rounds/:id/close
   */
  closeRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { action } = req.body; // 'ANOTHER_ROUND', 'REVERSE_AUCTION', 'SEND_FORWARD'

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'ACTIVE' && round.status !== 'COMPLETED') {
        return res.status(400).json({
          status: 2,
          message: `Round cannot be closed. Current status: ${round.status}`
        });
      }

      // Update round status
      await negotiationModel.updateRoundStatus(round_id, 'COMPLETED', {
        closed_at: new Date()
      });

      // Record lifecycle event
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
      const rfqData = rfq[0];
      await recordLifecycleEvent({
        entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: round.rfq_id,
        stage: `NEGOTIATION_ROUND_${round.round_number}`,
        action: 'ROUND_COMPLETED',
        performed_by: user_id,
        metadata: {
          round_id: round_id,
          round_number: round.round_number,
          next_action: action
        }
      });

      // Handle next action
      if (action === 'SEND_FORWARD') {
        // This would trigger award approval workflow
        // Implementation depends on existing award approval system
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: round.rfq_id,
          stage: 'NEGOTIATION_COMPLETED',
          action: 'SEND_FOR_APPROVAL',
          performed_by: user_id,
          metadata: {
            round_id: round_id
          }
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          closed: true,
          action: action
        },
        message: 'Round closed successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get quotes for a round
   * GET /negotiation/rounds/:id/quotes
   */
  getRoundQuotes: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      const quotes = await negotiationModel.getRoundQuotes(round_id);

      return res.status(200).json({
        status: 1,
        data: quotes
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Vendor submits quote for a round
   * POST /negotiation/rounds/:id/quote
   */
  submitVendorQuote: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const vendor_id = req.user.vendor_id || req.user.id; // Adjust based on your auth structure
      const { rfq_product_id, quoted_price, previous_price } = req.body;

      if (!round_id || !rfq_product_id || quoted_price === undefined) {
        return res.status(400).json({
          status: 2,
          message: 'round_id, rfq_product_id, and quoted_price are required'
        });
      }

      // Check if round exists and is active
      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'ACTIVE') {
        return res.status(400).json({
          status: 2,
          message: `Round is not active. Current status: ${round.status}`
        });
      }

      // Check if round has expired
      const expirationCheck = await negotiationModel.isRoundExpired(round_id);
      if (expirationCheck.expired) {
        return res.status(400).json({
          status: 2,
          message: 'Round has expired. Quote submission is no longer allowed.'
        });
      }

      // Check if vendor has already submitted a quote using model
      const existingQuote = await negotiationModel.getExistingRoundQuote(
        round_id, 
        vendor_id, 
        round.rfq_product_id
      );

      if (existingQuote) {
        return res.status(400).json({
          status: 2,
          message: 'You have already submitted a quote for this negotiation round. Only one submission is allowed per round.'
        });
      }

      // Insert quote (no update allowed)
      const quote = await negotiationModel.upsertRoundQuote({
        negotiation_round_id: round_id,
        vendor_id: vendor_id,
        rfq_product_id: round.rfq_product_id,
        quoted_price: quoted_price,
        previous_price: previous_price || null
      });

      return res.status(200).json({
        status: 1,
        data: quote,
        message: 'Quote submitted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get vendor's negotiation status for a specific product
   * GET /negotiation/rounds/:rfq_id/product/:rfq_product_id/vendor-status
   */
  getVendorNegotiationStatus: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const vendor_id = req.user.vendor_id || req.user.id;

      if (!rfq_id || !rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id and rfq_product_id are required'
        });
      }

      const status = await negotiationModel.getVendorNegotiationStatus(
        rfq_id,
        rfq_product_id,
        vendor_id
      );

      return res.status(200).json({
        status: 1,
        data: status
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all active negotiation rounds for an RFQ with vendor's quote status
   * GET /negotiation/rounds/:rfq_id/vendor-status
   */
  getAllVendorNegotiationStatus: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const vendor_id = req.user.vendor_id || req.user.id;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      const rounds = await negotiationModel.getActiveRoundsWithVendorStatus(
        rfq_id,
        vendor_id
      );

      return res.status(200).json({
        status: 1,
        data: rounds
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // ============= NEGOTIATION QUOTES APPROVAL =============

  /**
   * Submit selected negotiation quotes for approval
   * POST /negotiation/quotes/submit-for-approval
   */
  submitQuotesForApproval: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, quote_ids, remarks } = req.body;
      const user_id = req.user.id;

      // 1. Validate required fields
      if (!rfq_id || !rfq_product_id || !quote_ids || !Array.isArray(quote_ids) || quote_ids.length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id, rfq_product_id, and quote_ids (non-empty array) are required'
        });
      }

      // 2. Validate RFQ exists and is hospitality
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if (!rfq || rfq.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      const rfqData = rfq[0];
      if (!rfqData.hospitality_company_id) {
        return res.status(400).json({
          status: 2,
          message: 'Quote approval is only available for hospitality RFQs/Tenders'
        });
      }

      // 3. Validate product belongs to RFQ using model
      const product = await rfqModel.getRfqProductById(rfq_product_id, rfq_id);
      if (!product) {
        return res.status(404).json({
          status: 2,
          message: 'Product not found in this RFQ'
        });
      }

      // 4. Check for existing pending approval for this product
      const existingApprovals = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingApproval = existingApprovals.find(a => a.status === 'PENDING');
      if (pendingApproval) {
        return res.status(400).json({
          status: 2,
          message: `A pending quote approval already exists for this product. Instance ID: ${pendingApproval.id}`
        });
      }

      // 5. Validate all quotes exist using model
      const quotes = await negotiationModel.getQuotesByIds(quote_ids);

      if (quotes.length !== quote_ids.length) {
        return res.status(400).json({
          status: 2,
          message: 'One or more quote IDs are invalid or do not belong to this product'
        });
      }

      // Check all rounds are either completed OR expired (end_date < now)
      const now = new Date();
      const invalidRounds = quotes.filter(q => {
        const isCompleted = q.round_status === 'COMPLETED';
        const isExpired = new Date(q.round_end_date) < now;
        return !isCompleted && !isExpired;
      });
      if (invalidRounds.length > 0) {
        return res.status(400).json({
          status: 2,
          message: 'All selected quotes must be from completed or expired negotiation rounds'
        });
      }

      // 6. Execute in transaction
      const result = await db.tx(async (t) => {
        // Create approval instance
        const approvalResult = await startApprovalForNegotiationQuotes(
          rfq_product_id,
          rfq_id,
          quotes,
          rfqData,
          user_id,
          t
        );

        // If auto-approved (no approval required), directly add to finalization
        if (approvalResult && approvalResult.autoApproved) {
          await addQuotesToFinalization(rfq_id, rfq_product_id, quotes, user_id, rfqData, t);

          // Record lifecycle event
          await recordLifecycleEvent({
            entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'AUTO_APPROVE',
            performed_by: user_id,
            metadata: {
              rfq_product_id: rfq_product_id,
              quote_ids: quote_ids,
              vendor_ids: quotes.map(q => q.vendor_id)
            },
            txContext: t
          });

          return {
            autoApproved: true,
            quotes: quotes
          };
        }

        // Record lifecycle event for submission
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: rfq_id,
          stage: 'NEGOTIATION_QUOTES_SUBMITTED',
          action: 'SUBMIT_FOR_APPROVAL',
          performed_by: user_id,
          metadata: {
            approval_instance_id: approvalResult.instance?.id,
            rfq_product_id: rfq_product_id,
            quote_ids: quote_ids
          },
          remarks: remarks,
          txContext: t
        });

        return {
          autoApproved: false,
          approvalResult: approvalResult,
          quotes: quotes
        };
      });

      if (result.autoApproved) {
        return res.status(200).json({
          status: 1,
          data: {
            status: 'AUTO_APPROVED',
            selected_quotes: result.quotes.map(q => ({
              quote_id: q.id,
              vendor_id: q.vendor_id,
              vendor_name: q.vendor_name || q.organization_name,
              quoted_price: q.quoted_price
            })),
            finalization_complete: true
          },
          message: 'Quotes auto-approved and added to finalization (no approval policy configured)'
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          approval_instance_id: result.approvalResult.instance?.id,
          status: 'PENDING',
          selected_quotes: result.quotes.map(q => ({
            quote_id: q.id,
            vendor_id: q.vendor_id,
            vendor_name: q.vendor_name || q.organization_name,
            quoted_price: q.quoted_price
          })),
          total_steps: result.approvalResult.totalSteps,
          current_step: 1
        },
        message: 'Quotes submitted for approval successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get quote approval status for a product
   * GET /negotiation/quotes/:rfq_product_id/approval-status
   */
  getQuoteApprovalStatus: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const latestInstance = instances[0]; // Already ordered by created_at DESC

      if (!latestInstance) {
        return res.status(200).json({
          status: 1,
          data: {
            has_pending_approval: false,
            approval_instance: null
          }
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          has_pending_approval: latestInstance.status === 'PENDING',
          approval_instance: {
            id: latestInstance.id,
            status: latestInstance.status,
            metadata: latestInstance.metadata,
            created_at: latestInstance.created_at,
            completed_at: latestInstance.completed_at
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve negotiation quotes
   * POST /negotiation/quotes/:rfq_product_id/approve
   */
  approveQuotes: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      // 1. Get pending approval instance
      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending quote approval found for this product'
        });
      }

      // 2. Submit approval action
      const result = await submitApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'APPROVE',
        comment: remarks || null
      });

      const isFullyApproved = result.instance_status === 'APPROVED';

      // 3. If fully approved, add to finalization
      if (isFullyApproved) {
        const { getApprovalInstanceById } = await import('../../models/generalModel.js');
        const instance = await getApprovalInstanceById(pendingInstance.id, 'NEGOTIATION_QUOTE');
        const metadata = instance?.metadata || {};

        if (metadata.rfq_id && metadata.selected_quotes?.length > 0) {
          const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${metadata.rfq_id}`);
          const rfqData = rfq[0];

          // Convert metadata quotes to format expected by addQuotesToFinalization
          const quotesForFinalization = metadata.selected_quotes.map(q => ({
            id: q.quote_id,
            vendor_id: q.vendor_id
          }));

          await addQuotesToFinalization(
            metadata.rfq_id,
            rfq_product_id,
            quotesForFinalization,
            user_id,
            rfqData
          );

          // Record lifecycle event
          await recordLifecycleEvent({
            entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: metadata.rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'APPROVE',
            performed_by: user_id,
            metadata: {
              approval_instance_id: pendingInstance.id,
              rfq_product_id,
              quote_ids: metadata.selected_quotes.map(q => q.quote_id),
              vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
            }
          });
        }
      }

      return res.status(200).json({
        status: 1,
        data: {
          approved: true,
          fully_approved: isFullyApproved,
          finalized: isFullyApproved,
          instance_status: result.instance_status,
          next_step: result.next_step || null
        },
        message: isFullyApproved
          ? 'Quotes fully approved and finalized'
          : 'Approval recorded. Waiting for other approvers.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Reject negotiation quotes
   * POST /negotiation/quotes/:rfq_product_id/reject
   */
  rejectQuotes: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'Remarks are required for rejection'
        });
      }

      // 1. Get pending approval instance
      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending quote approval found for this product'
        });
      }

      // 2. Get instance metadata for lifecycle event
      const { getApprovalInstanceById } = await import('../../models/generalModel.js');
      const instance = await getApprovalInstanceById(pendingInstance.id, 'NEGOTIATION_QUOTE');
      const metadata = instance?.metadata || {};

      // 3. Submit rejection
      await submitApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'REJECT',
        comment: remarks
      });

      // 4. Record lifecycle event
      if (metadata.rfq_id) {
        const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${metadata.rfq_id}`);
        const rfqData = rfq?.[0];

        await recordLifecycleEvent({
          entity_type: rfqData?.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: metadata.rfq_id,
          stage: 'NEGOTIATION_QUOTES_REJECTED',
          action: 'REJECT',
          performed_by: user_id,
          metadata: {
            approval_instance_id: pendingInstance.id,
            rfq_product_id,
            quote_ids: metadata.selected_quotes?.map(q => q.quote_id) || [],
            rejection_reason: remarks
          },
          remarks
        });
      }

      return res.status(200).json({
        status: 1,
        data: { rejected: true },
        message: 'Quotes rejected successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }
};

export default NegotiationController;

