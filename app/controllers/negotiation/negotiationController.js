import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import negotiationModel from '../../models/negotiationModel.js';
import rfqModel from '../../models/rfqModel.js';
import { recordLifecycleEvent } from '../../models/generalModel.js';
import { findBestMatchingPolicy, createApprovalInstance } from '../../models/generalModel.js';
import db, { pgp } from '../../config/dbConn.js';

const formatErrorResponse = (res, error) => {
  const statusCode = error.statusCode || 400;
  const message = error.message || Config.errorText.value;
  return res.status(statusCode).json({
    status: 3,
    message
  });
};

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

      // Check if product exists
      const product = await db.oneOrNone(
        `SELECT * FROM tbl_rfq_products WHERE id = $1 AND rfq_id = $2`,
        [rfq_product_id, rfq_id]
      );
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
        // Create the round
        const round = await t.one(
          `INSERT INTO tbl_negotiation_rounds
            (rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by)
           VALUES ($1, $2, $3, $4, $5, 'PENDING_APPROVAL', $6)
           RETURNING *`,
          [rfq_id, rfq_product_id, round_number, target_price, end_date, user_id]
        );

        // Find negotiation approval policy
        const policy = await findBestMatchingPolicy({
          entity_type: 'NEGOTIATION',
          hospitality_company_id: rfqData.hospitality_company_id,
          hotel_id: rfqData.hotel_id || null,
          department_id: null
        });

        if (policy) {
          // Get policy steps to find approvers
          const policySteps = await t.any(
            `SELECT * FROM tbl_approval_policy_steps
             WHERE approval_policy_id = $1
             ORDER BY step_order ASC
             LIMIT 1`,
            [policy.id]
          );

          if (policySteps.length > 0) {
            const firstStep = policySteps[0];

            // Resolve approvers based on step configuration
            const approvers = [];
            if (firstStep.approver_source_type === 'ROLE') {
              // Get users with this role
              const roleUsers = await t.any(
                `SELECT DISTINCT u.id
                 FROM tbl_users u
                 JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
                 JOIN tbl_hospitality_user_mappings hum ON hum.user_id = u.id
                 WHERE urs.role_id = $1
                   AND hum.hospitality_company_id = $2
                   AND (hum.mapping_type = 0 OR (hum.mapping_type = 1 AND hum.hospitality_hotel_id = $3))
                   AND u.status = 1 AND u.is_deleted = 0`,
                [firstStep.approver_source_id, rfqData.hospitality_company_id, rfqData.hotel_id || null]
              );
              approvers.push(...roleUsers.map(u => u.id));
            } else if (firstStep.approver_source_type === 'USER') {
              approvers.push(firstStep.approver_source_id);
            }

            if (approvers.length > 0) {
              // Create approval records
              const approvalRows = approvers.map(approverId => ({
                negotiation_round_id: round.id,
                approver_user_id: approverId,
                status: 'PENDING'
              }));

              const columnSet = new pgp.helpers.ColumnSet(
                ['negotiation_round_id', 'approver_user_id', 'status'],
                { table: 'tbl_negotiation_round_approvals' }
              );
              const query = pgp.helpers.insert(approvalRows, columnSet);
              await t.none(query);
            } else {
              // No approvers found, auto-approve the round
              await t.none(
                `UPDATE tbl_negotiation_rounds 
                 SET status = 'ACTIVE', published_at = NOW() 
                 WHERE id = $1`,
                [round.id]
              );
            }
          } else {
            // No policy steps, auto-approve the round
            await t.none(
              `UPDATE tbl_negotiation_rounds 
               SET status = 'ACTIVE', published_at = NOW() 
               WHERE id = $1`,
              [round.id]
            );
          }
        } else {
          // No approval policy found, auto-approve the round
          await t.none(
            `UPDATE tbl_negotiation_rounds 
             SET status = 'ACTIVE', published_at = NOW() 
             WHERE id = $1`,
            [round.id]
          );
        }

        // Get updated round status
        const updatedRound = await t.oneOrNone(
          `SELECT * FROM tbl_negotiation_rounds WHERE id = $1`,
          [round.id]
        );

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

      // Get approvals for each round
      const roundsWithApprovals = await Promise.all(
        rounds.map(async (round) => {
          const approvals = await negotiationModel.getRoundApprovals(round.id);
          return {
            ...round,
            approvals
          };
        })
      );

      return res.status(200).json({
        status: 1,
        data: roundsWithApprovals
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get active round for a product
   * GET /negotiation/rounds/:rfq_id/active?rfq_product_id=123
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

      // Get approvals
      const approvals = await negotiationModel.getRoundApprovals(round.id);
      const approvalStatus = await negotiationModel.areAllApprovalsComplete(round.id);

      return res.status(200).json({
        status: 1,
        data: {
          ...round,
          approvals,
          approvalStatus
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all active rounds for an RFQ (all products)
   * GET /negotiation/rounds/:rfq_id/active-all
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

      // Get approvals for each round
      const roundsWithApprovals = await Promise.all(
        rounds.map(async (round) => {
          const approvals = await negotiationModel.getRoundApprovals(round.id);
          const approvalStatus = await negotiationModel.areAllApprovalsComplete(round.id);
          return {
            ...round,
            approvals: approvals || [],
            approvalStatus
          };
        })
      );

      return res.status(200).json({
        status: 1,
        data: roundsWithApprovals || []
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

      // Check if user is an approver
      const userApproval = await negotiationModel.getUserApproval(round_id, user_id);
      if (!userApproval) {
        return res.status(403).json({
          status: 2,
          message: 'You are not an approver for this round'
        });
      }

      if (userApproval.status !== 'PENDING') {
        return res.status(400).json({
          status: 2,
          message: `You have already ${userApproval.status.toLowerCase()} this round`
        });
      }

      // Update approval
      await negotiationModel.updateApproval(round_id, user_id, 'APPROVED', remarks || null);

      // Check if all approvals are complete
      const approvalStatus = await negotiationModel.areAllApprovalsComplete(round_id);

      // Record lifecycle event
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
      const rfqData = rfq[0];
      await recordLifecycleEvent({
        entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: round.rfq_id,
        stage: `NEGOTIATION_ROUND_${round.round_number}`,
        action: 'APPROVE_ROUND',
        performed_by: user_id,
        metadata: {
          round_id: round_id,
          round_number: round.round_number,
          all_approved: approvalStatus.allApproved
        }
      });

      // If all approved, auto-publish
      if (approvalStatus.allApproved) {
        await negotiationModel.updateRoundStatus(round_id, 'ACTIVE', {
          approved_at: new Date(),
          published_at: new Date()
        });

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
          allApproved: approvalStatus.allApproved,
          published: approvalStatus.allApproved
        },
        message: approvalStatus.allApproved
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

      // Check if user is an approver
      const userApproval = await negotiationModel.getUserApproval(round_id, user_id);
      if (!userApproval) {
        return res.status(403).json({
          status: 2,
          message: 'You are not an approver for this round'
        });
      }

      // Update approval and round status
      await negotiationModel.updateApproval(round_id, user_id, 'REJECTED', remarks);
      await negotiationModel.updateRoundStatus(round_id, 'CANCELLED', {
        remarks: remarks
      });

      // Record lifecycle event
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
      const rfqData = rfq[0];
      await recordLifecycleEvent({
        entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: round.rfq_id,
        stage: `NEGOTIATION_ROUND_${round.round_number}`,
        action: 'REJECT_ROUND',
        performed_by: user_id,
        metadata: {
          round_id: round_id,
          round_number: round.round_number
        },
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

      // Check if vendor has already submitted a quote for this round
      const existingQuote = await db.oneOrNone(
        `SELECT id, submitted_at FROM tbl_negotiation_round_quotes 
         WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
        [round_id, vendor_id, round.rfq_product_id]
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
  }
};

export default NegotiationController;

