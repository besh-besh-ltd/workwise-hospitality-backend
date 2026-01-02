import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import negotiationModel from '../../models/negotiationModel.js';
import { getLifecycleHistory, getApprovalInstancesByEntity, submitApprovalAction, cancelApprovalInstance } from '../../models/generalModel.js';
import db from '../../config/dbConn.js';

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

      // Get lifecycle history
      const lifecycleHistory = await getLifecycleHistory('RFQ', rfq_id);

      // Get ARC approval instances
      const entityType = 'ARC';
      const arcApprovalInstances = await getApprovalInstancesByEntity(entityType, rfq_id);
      const pendingArcApproval = arcApprovalInstances.find(inst => inst.status === 'PENDING');

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
            entityType: entityType
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
      const { page = 1, limit = 50, project_id, is_tender } = req.query;

      // Get RFQs pending ARC approval using model
      const result = await rfqModel.getRfqsPendingArcApproval({
        page: parseInt(page),
        limit: parseInt(limit),
        project_id,
        is_tender
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
      const { action, target_stage, remarks, approval_instance_id, approval_instance_step_id } = req.body;
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

      // Get RFQ to determine entity type using existing model function
      const rfq = await rfqModel.getRfqDetailsById(rfq_id);

      if (!rfq) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ/Tender not found'
        });
      }

      // Use 'ARC' as entity type for ARC approvals
      const entityType = 'ARC';

      // Get approval instances for this RFQ
      const approvalInstances = await getApprovalInstancesByEntity(entityType, rfq_id);
      
      // Find the pending approval instance
      const pendingInstance = approvalInstances.find(inst => inst.status === 'PENDING');
      
      if (!pendingInstance && (action === 'approve' || action === 'reject')) {
        return res.status(400).json({
          status: 2,
          message: 'No pending ARC approval instance found for this RFQ'
        });
      }

      const { recordLifecycleEvent } = await import('../../models/generalModel.js');
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
          result = await submitApprovalAction({
            approval_instance_id: instanceId,
            approval_instance_step_id: approval_instance_step_id || null,
            approver_user_id: user_id,
            action: actionType,
            comment: remarks || null
          });

          // Record lifecycle event
          let stage = 'ARC_APPROVED';
          if (action === 'reject') {
            stage = 'ARC_REJECTED';
          } else if (result.instance_status === 'APPROVED') {
            stage = 'ARC_APPROVED';
          } else {
            stage = 'ARC_PENDING';
          }

          await recordLifecycleEvent({
            entity_type: 'RFQ',
            entity_id: rfq_id,
            stage,
            action: actionType,
            performed_by: user_id,
            metadata: {
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
        // Send to previous stage - cancel current approval and record lifecycle
        if (!target_stage) {
          return res.status(400).json({
            status: 2,
            message: 'target_stage is required for send_to action'
          });
        }

        // Cancel pending approval instance if exists
        if (pendingInstance) {
          try {
            await cancelApprovalInstance(pendingInstance.id, user_id, `Sent back to ${target_stage}: ${remarks || 'No remarks'}`);
          } catch (cancelError) {
            console.error('Error cancelling approval instance:', cancelError);
            // Continue even if cancellation fails
          }
        }

        // Record lifecycle event
        const stage = `SENT_TO_${target_stage.toUpperCase()}`;
        await recordLifecycleEvent({
          entity_type: 'RFQ',
          entity_id: rfq_id,
          stage,
          action: 'SEND_TO',
          performed_by: user_id,
          metadata: {
            target_stage: target_stage,
            cancelled_instance_id: pendingInstance?.id || null
          },
          remarks: remarks || null
        });

        return res.status(200).json({
          status: 1,
          message: `Tender sent back to ${target_stage} successfully`,
          data: {
            rfq_id,
            action,
            target_stage: target_stage,
            stage,
            performed_by: user_id,
            performed_at: new Date()
          }
        });
      }
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }
};

export default ArcController;

