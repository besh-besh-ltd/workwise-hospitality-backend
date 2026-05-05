import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import rfqModel from '../../models/rfqModel.js';
import arcModel from '../../models/arcModel.js';
import negotiationModel from '../../models/negotiationModel.js';
import { getLifecycleHistory, getApprovalInstancesByEntity, cancelApprovalInstance, getApprovalInstanceById, recordLifecycleEvent, uploadToS3, resetQuoteFinalizationForSendback } from '../../models/generalModel.js';
import { executeApprovalAction } from '../../services/approvalActionService.js';
import { generateAwardDocument, sendAwardDocumentToVendor } from './arcDocumentController.js';
import db from '../../config/dbConn.js';

/**
 * Handle ARC post-approval actions (document generation and email)
 * Called after ARC approval instance is fully approved
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [options]
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 */
const handleArcPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    // Get approval instance. Per Phase 2, entity_id is the arc_item.id —
    // each (product, vendor) cell in the committee matrix has its own
    // approval instance.
    const instance = await getApprovalInstanceById(approval_instance_id, 'ARC', t);
    if (!instance || instance.status !== 'APPROVED') {
      return; // Not approved yet or not ARC type
    }

    const arc_item_id = instance.entity_id;
    const metadata = instance.metadata || {};
    const rfq_id = metadata.rfq_id;

    // 1. Mark this ARC item APPROVED. Idempotent — a duplicate dispatch
    //    just updates the timestamp.
    await t.none(
      `UPDATE tbl_arc_item
       SET status = 'APPROVED',
           approved_at = NOW(),
           approved_by = $2
       WHERE id = $1`,
      [arc_item_id, approver_user_id]
    );

    // 2. Look up the parent envelope.
    const arcItem = await t.oneOrNone(
      `SELECT * FROM tbl_arc_item WHERE id = $1`,
      [arc_item_id]
    );
    if (!arcItem) {
      logger.warn(`[ARC] Item ${arc_item_id} not found after approve — skipping envelope check`);
      return;
    }
    const arc_id = arcItem.arc_id;

    // 3. Are ALL items in the envelope decided? PARTIALLY_DECIDED is the
    //    intermediate state. The PDF only fires on the last decision.
    const counts = await arcModel.getEnvelopeDecisionCounts({ arc_id, txContext: t });
    if (counts.pending > 0) {
      // Mark the envelope as PARTIALLY_DECIDED so the buyer-side UI can
      // show committee progress. Does not generate a doc yet.
      await t.none(
        `UPDATE tbl_arc SET status = 'PARTIALLY_DECIDED', updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING_COMMITTEE'`,
        [arc_id]
      );
      await recordLifecycleEvent({
        entity_type: 'TENDER',
        entity_id: rfq_id,
        stage: 'ARC_ITEM_APPROVED',
        action: 'APPROVE_ITEM',
        performed_by: approver_user_id,
        metadata: { arc_id, arc_item_id, decision_counts: counts },
        txContext: t,
      });
      return;
    }

    // 4. All items decided. If ALL were rejected, the envelope is VOID —
    //    no PDF.
    if (counts.approved === 0) {
      await t.none(
        `UPDATE tbl_arc SET status = 'VOID', updated_at = NOW() WHERE id = $1`,
        [arc_id]
      );
      await recordLifecycleEvent({
        entity_type: 'TENDER',
        entity_id: rfq_id,
        stage: 'ARC_VOID',
        action: 'VOID_ENVELOPE',
        performed_by: approver_user_id,
        metadata: { arc_id, decision_counts: counts },
        remarks: 'All ARC items rejected by committee',
        txContext: t,
      });
      return;
    }

    // 5. ≥1 item approved — generate the consolidated per-vendor ARC PDF.
    //    generateAwardDocument now takes arc_id and produces ONE document
    //    listing every approved product for that vendor with period dates
    //    and no quantity (per product team).
    const pdfResult = await generateAwardDocument(arc_id, t);
    if (!pdfResult.ok) {
      logError(`ARC PDF generation failed for arc_id=${arc_id}: ${pdfResult.error}`);
      return;
    }

    const envelope = await t.one(
      `SELECT a.*, r.rfq_no FROM tbl_arc a
       JOIN tbl_rfq r ON r.id = a.rfq_id
       WHERE a.id = $1`,
      [arc_id]
    );
    const fileName = `arc-${envelope.rfq_no}-vendor-${envelope.vendor_id}-${Date.now()}.pdf`;
    const s3Key = `arc-documents/${envelope.rfq_no}/${envelope.vendor_id}/${fileName}`;
    const s3Result = await uploadToS3(pdfResult.absolutePath, s3Key);
    if (!s3Result.ok) {
      logError(`ARC PDF upload failed for arc_id=${arc_id}: ${s3Result.error}`);
      return;
    }

    // 6. Persist the document URL on the envelope and transition status.
    await t.none(
      `UPDATE tbl_arc
       SET document_url = $2,
           document_generated_at = NOW(),
           status = 'ACTIVE',
           updated_at = NOW()
       WHERE id = $1`,
      [arc_id, s3Result.url]
    );

    // 7. Email the consolidated doc to the vendor.
    await sendAwardDocumentToVendor(arc_id, s3Result.url, t);

    // 8. Lifecycle: doc generated + envelope active.
    await recordLifecycleEvent({
      entity_type: 'TENDER',
      entity_id: rfq_id,
      stage: 'ARC_DOC_GENERATED',
      action: 'GENERATE_DOCUMENT',
      performed_by: approver_user_id,
      metadata: {
        arc_id,
        vendor_id: envelope.vendor_id,
        document_url: s3Result.url,
        decision_counts: counts,
      },
      txContext: t,
    });
    await recordLifecycleEvent({
      entity_type: 'TENDER',
      entity_id: rfq_id,
      stage: 'ARC_ACTIVE',
      action: 'ACTIVATE',
      performed_by: approver_user_id,
      metadata: { arc_id, vendor_id: envelope.vendor_id },
      txContext: t,
    });
  } catch (arcDocError) {
    // Log but don't fail the transaction
    logError(arcDocError);
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

      // Get ARC approval instances. Phase 2 changed entity_id from
      // rfq_product_id to arc_item.id (each product-vendor cell now has
      // its own approval). For back-compat we surface BOTH shapes:
      //   - arcApprovalInstances (legacy flat list, kept for any UI
      //     that hasn't migrated to the matrix model).
      //   - arcEnvelopes / arcItems (new shape) so the matrix UI can
      //     render rows=products, columns=vendors without N round-trips.
      const entityType = 'ARC';
      let arcApprovalInstances = [];

      // Legacy path — entity_id was rfq_product_id.
      const products = await rfqModel.getRfqProductIds(rfq_id);
      const legacyByProduct = await Promise.all(
        products.map(async (product) => {
          const instances = await getApprovalInstancesByEntity(entityType, product.id);
          return instances.map((inst) => ({ ...inst, rfq_product_id: product.id }));
        })
      );
      arcApprovalInstances = legacyByProduct.flat();

      // New path — load envelopes (per vendor) and items (per
      // product-vendor cell) for this rfq, plus the approval instance
      // attached to each item.
      const arcEnvelopes = await db.any(
        `SELECT a.*, u.organization_name AS vendor_name
         FROM tbl_arc a
         LEFT JOIN tbl_users u ON u.id = a.vendor_id
         WHERE a.rfq_id = $1
         ORDER BY a.created_at`,
        [rfq_id]
      );
      const arcItems = await db.any(
        `SELECT ai.*, pv.name AS product_name,
                a.vendor_id, u.organization_name AS vendor_name,
                ainst.id AS approval_instance_id_full,
                ainst.status AS approval_status,
                ainst.metadata AS approval_metadata
         FROM tbl_arc_item ai
         JOIN tbl_arc a ON a.id = ai.arc_id
         LEFT JOIN tbl_product_variants pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_users u ON u.id = a.vendor_id
         LEFT JOIN tbl_approval_instances ainst ON ainst.id = ai.approval_instance_id
         WHERE a.rfq_id = $1
         ORDER BY ai.rfq_product_id, a.vendor_id`,
        [rfq_id]
      );

      // Item-level approval instances — surface them alongside the
      // legacy product-level ones so a forwards-only client can prefer
      // them. The matrix UI uses these.
      const itemInstances = await db.any(
        `SELECT ainst.*, ai.id AS arc_item_id, ai.arc_id, ai.product_variant_id,
                ai.rfq_product_id, ai.variant, ai.unit_price, a.vendor_id
         FROM tbl_approval_instances ainst
         JOIN tbl_arc_item ai ON ai.approval_instance_id = ainst.id
         JOIN tbl_arc a ON a.id = ai.arc_id
         WHERE ainst.entity_type = 'ARC'
           AND a.rfq_id = $1
         ORDER BY ai.rfq_product_id, a.vendor_id`,
        [rfq_id]
      );
      arcApprovalInstances = [...arcApprovalInstances, ...itemInstances];

      const pendingArcApproval = arcApprovalInstances.find((inst) => inst.status === 'PENDING');

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
            entityType: entityType,
            // Phase 3 matrix view: envelopes (per vendor) + items
            // (per product-vendor cell) so the FE renders rows=products,
            // columns=vendors without aggregating from instance metadata.
            envelopes: arcEnvelopes || [],
            items: arcItems || [],
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
      const { page = 1, limit = 50, project_id, show_all } = req.query;
      const user_id = req.user?.id;

      // Get products with ARC approvals (tenders only)
      const result = await rfqModel.getRfqsPendingArcApproval({
        page: parseInt(page),
        limit: parseInt(limit),
        project_id,
        is_tender: 1, // Only tenders
        user_id,
        includeAll: show_all === '1' || show_all === 1
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
          // executeApprovalAction wraps submitApprovalAction and centrally
          // dispatches handleArcPostApproval on APPROVED, so the explicit
          // post-action call that previously lived here is no longer needed.
          result = await executeApprovalAction({
            approval_instance_id: instanceId,
            approval_instance_step_id: approval_instance_step_id || null,
            approver_user_id: user_id,
            action: actionType,
            comment: remarks || null
          });

          // If ARC is rejected, undo vendor finalization so vendors don't see it
          if (actionType === 'REJECT') {
            const instanceMetadata = pendingInstance?.metadata || {};
            const productId = instanceMetadata.rfq_product_id || rfq_product_id || null;
            if (productId) {
              try {
                await resetQuoteFinalizationForSendback(rfq_id, productId, user_id, `ARC rejected: ${remarks || 'No remarks'}`, 'NEGOTIATION');
              } catch (resetError) {
                logError('Error resetting quote finalization on ARC rejection', resetError);
              }
            }
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

        // Cancel pending approval instance if exists and save target_stage in metadata
        if (pendingInstance) {
          try {
            // First update metadata with target_stage so it's preserved after cancellation
            const updatedMetadata = {
              ...(pendingInstance.metadata || {}),
              sent_back_to: target_stage.toUpperCase(),
              sent_back_at: new Date().toISOString(),
              sent_back_by: user_id,
              sent_back_remarks: remarks || null
            };

            await db.none(`
              UPDATE tbl_approval_instances
              SET metadata = $1
              WHERE id = $2
            `, [JSON.stringify(updatedMetadata), pendingInstance.id]);

            await cancelApprovalInstance(pendingInstance.id, user_id, `Sent back to ${target_stage}: ${remarks || 'No remarks'}`);
          } catch (cancelError) {
            logError('Error cancelling approval instance', cancelError);
            // Continue even if cancellation fails
          }
        }

        // Record lifecycle event
        const stage = `SENT_TO_${target_stage.toUpperCase()}`;
        const instanceMetadata = pendingInstance?.metadata || {};
        const productId = instanceMetadata.rfq_product_id || rfq_product_id || null;

        // Reset quote finalization if sending back to stages before ARC
        if (productId) {
          try {
            await resetQuoteFinalizationForSendback(rfq_id, productId, user_id, `Sent back to ${target_stage}`, target_stage);
          } catch (resetError) {
            logError('Error resetting quote finalization', resetError);
          }
        }
        
        await recordLifecycleEvent({
          entity_type: 'TENDER', // Always TENDER for ARC
          entity_id: rfq_id,
          stage,
          action: 'SEND_TO',
          performed_by: user_id,
          metadata: {
            rfq_product_id: productId,
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

