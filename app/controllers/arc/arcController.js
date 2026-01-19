import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import negotiationModel from '../../models/negotiationModel.js';
import { getLifecycleHistory, getApprovalInstancesByEntity, submitApprovalAction, cancelApprovalInstance, getApprovalInstanceById, recordLifecycleEvent, uploadToS3 } from '../../models/generalModel.js';
import { generateAwardDocument, sendAwardDocumentToVendor } from './arcDocumentController.js';
import db from '../../config/dbConn.js';

/**
 * Handle ARC post-approval actions (document generation and email)
 * Called after ARC approval instance is fully approved
 */
const handleArcPostApproval = async (approval_instance_id, approver_user_id, txContext = null) => {
  const t = txContext || db;
  
  try {
    // Get approval instance
    const instance = await getApprovalInstanceById(approval_instance_id, 'ARC', t);
    if (!instance || instance.status !== 'APPROVED') {
      return; // Not approved yet or not ARC type
    }

    const rfq_product_id = instance.entity_id;
    const metadata = instance.metadata || {};
    const rfq_id = metadata.rfq_id;
    
    // Validate RFQ is a tender
    const rfqData = await t.oneOrNone(`
      SELECT is_tender FROM tbl_rfq WHERE id = $1
    `, [rfq_id]);
    
    if (!rfqData || rfqData.is_tender !== 1) {
      throw new Error('ARC document generation is only applicable for tenders (is_tender = 1)');
    }
    
    // Generate PDF document for this product
    const pdfResult = await generateAwardDocument(rfq_product_id, t);
    
    if (pdfResult.ok) {
      // Upload to S3 with arc-documents folder
      const fileName = `arc-award-${metadata.rfq_number || rfq_id}-product-${rfq_product_id}-${Date.now()}.pdf`;
      const s3Key = `arc-documents/${fileName}`;
      const s3Result = await uploadToS3(pdfResult.absolutePath, s3Key);

      console.log("ARC: S3 RESULT FOR AWARD DOC:", s3Result);
      
      if (s3Result.ok) {
        // Update approval instance metadata with document URL
        const updatedMetadata = {
          ...metadata,
          award_document_url: s3Result.url,
          award_document_generated_at: new Date().toISOString(),
          award_document_generated_by: approver_user_id
        };
        
        await t.none(`
          UPDATE tbl_approval_instances
          SET metadata = $1
          WHERE id = $2
        `, [JSON.stringify(updatedMetadata), approval_instance_id]);
        
        // Send email to vendor for this product
        await sendAwardDocumentToVendor(rfq_product_id, s3Result.url, t);
        
        // Record lifecycle event
        await recordLifecycleEvent({
          entity_type: 'TENDER',
          entity_id: rfq_id,
          stage: 'ARC_DOCUMENT_GENERATED',
          action: 'GENERATE_DOCUMENT',
          performed_by: approver_user_id,
          metadata: {
            rfq_product_id: rfq_product_id,
            document_url: s3Result.url,
            approval_instance_id: approval_instance_id
          },
          txContext: t
        });
      }
    }
  } catch (arcDocError) {
    // Log but don't fail the transaction
    console.error('Error handling ARC post-approval:', arcDocError);
  }
};

// Export the helper function for use in general controller
export { handleArcPostApproval };

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

      // Get ARC approval instances (product-level)
      const entityType = 'ARC';
      let arcApprovalInstances = [];
      
      if (rfq_product_id) {
        // Get single product ARC approval
        arcApprovalInstances = await getApprovalInstancesByEntity(entityType, rfq_product_id);
      } else {
        // Get all product ARC approvals for this RFQ using model
        const products = await rfqModel.getRfqProductIds(rfq_id);
        
        const allInstances = await Promise.all(
          products.map(async (product) => {
            const instances = await getApprovalInstancesByEntity(entityType, product.id);
            return instances.map(inst => ({ ...inst, rfq_product_id: product.id }));
          })
        );
        
        arcApprovalInstances = allInstances.flat();
      }
      
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
      const { page = 1, limit = 50, project_id } = req.query;

      // Get products with ARC approvals (tenders only)
      const result = await rfqModel.getRfqsPendingArcApproval({
        page: parseInt(page),
        limit: parseInt(limit),
        project_id,
        is_tender: 1 // Only tenders
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

      // Get approval instances (product-level)
      let approvalInstances = [];
      let pendingInstance = null;
      
      if (rfq_product_id) {
        // Get approval instance for specific product
        approvalInstances = await getApprovalInstancesByEntity(entityType, rfq_product_id);
        pendingInstance = approvalInstances.find(inst => inst.status === 'PENDING');
      } else {
        // Get all product ARC approvals for this RFQ using model
        const products = await rfqModel.getRfqProductIds(rfq_id);
        
        const allInstances = await Promise.all(
          products.map(async (product) => {
            return await getApprovalInstancesByEntity(entityType, product.id);
          })
        );
        
        approvalInstances = allInstances.flat();
        pendingInstance = approvalInstances.find(inst => inst.status === 'PENDING');
      }
      
      if (!pendingInstance && (action === 'approve' || action === 'reject')) {
        return res.status(400).json({
          status: 2,
          message: 'No pending ARC approval instance found' + (rfq_product_id ? ` for product ${rfq_product_id}` : ' for this RFQ')
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
          result = await submitApprovalAction({
            approval_instance_id: instanceId,
            approval_instance_step_id: approval_instance_step_id || null,
            approver_user_id: user_id,
            action: actionType,
            comment: remarks || null
          });

          // Handle ARC post-approval actions (document generation) if fully approved
          if (actionType === 'APPROVE' && result.instance_status === 'APPROVED') {
            await handleArcPostApproval(instanceId, user_id);
          }

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
        const instanceMetadata = pendingInstance?.metadata || {};
        const rfq_product_id = instanceMetadata.rfq_product_id || (rfq_product_id ? rfq_product_id : null);
        
        await recordLifecycleEvent({
          entity_type: 'TENDER', // Always TENDER for ARC
          entity_id: rfq_id,
          stage,
          action: 'SEND_TO',
          performed_by: user_id,
          metadata: {
            rfq_product_id: rfq_product_id,
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
  },

  /**
   * Get ARC document URL from approval instance metadata
   * GET /arc/document/:approval_instance_id
   */
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

