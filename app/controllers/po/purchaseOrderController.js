import db from "../../config/dbConn.js";
import { logError } from "../../helper/common.js";
import { logger } from '../../util/logger.js';
import { removeMilestoneReminder, rescheduleMilestoneReminder, scheduleMilestoneReminder } from "../../helper/cronManager.js";
import generalModel, { markPOStatusChange, getApprovalInstanceById, getApprovalInstanceDetails, recordLifecycleEvent, submitApprovalAction } from "../../models/generalModel.js";
import { createMilestone, createTask, deleteMilestone, deleteTask, getMilestonesByPOId, getPOByRFQId, getPODetailsById, getTasksByPOId, draftPurchaseOrder, updateMilestone, updateTask, initiatePurchaseOrder, updateGSTForPO, updateHSNCode, handleUpdatePO, handleRaiseInvoice, handleMarkDispatched, handleAddSiteRepresentative, handleMarkGRN, regeneratePODocument } from "../../models/purchaseOrderModel.js";
import rfqModel from "../../models/rfqModel.js";
import userModel from "../../models/userModel.js";
import hospitalityModel from "../../models/hospitalityModel.js";
import { APPROVAL_DECISIONS, AVAILABLE_HIERARCHY_TYPES, PO_STATUSES } from "../../util/constants.js";
import { sendApprovalNotification, sendPONotificationToVendor, sendPOAcceptanceRequestToVendor, sendVendorRejectionNotification, sendPOAcceptedNotificationToTeam } from "./purchaseOrderEmails.js";
import rbacModel from "../../models/rbacModel.js";
import { sendPOApprovalCompletionNotification } from "../../helper/sendEmailFunctions/poEmails.js";
import pricingEngine from "../../services/pricingEngine.js";

export const getPOByRFQ = async (req, res) => {
    try {
        const { rfq_id } = req.params;
        const { page = 1, limit = 10, ...filters } = req.query;
        const { id, user_type } = req.user;

        const result = await getPOByRFQId(rfq_id, id, user_type, page, limit, filters);

        return res.json(result);

    } catch (error) {
        logError(error);
        return res.status(500).json({
            status: 0,
            message: error.message || 'An error occurred while approving the PO.',
            error
        });
    }
};

export const getPODetails = async (req, res) => {
    try {
        const { po_id } = req.params;
        const { id } = req.user;

        const result = await getPODetailsById(po_id, id);

        return res.json({
          data: result,
        });

    } catch (error) {
        logError(error);
        return res.status(500).json({
            status: 0,
            message: error.message || 'An error occurred while approving the PO.',
            error
        });
    }
};

export const updatePO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { changes } = req.body;

    const updated = await handleUpdatePO(po_id, changes, req.user);

    return res.json({
      status: 1,
      message: "PO has been updated!",
      updated,
    });
  } catch (error) {
      logError(error);
      return res.status(500).json({
          status: 0,
          message: error.message || 'An error occurred while approving the PO.',
          error
      });
  }
};

/**
 * Replaces product_info.charges_meta with authoritative values from tbl_quote_items.
 * Prevents frontend normalization or stale data from corrupting PO charges.
 */
export const buildAuthoritativePOPayload = async (poInfo, txn) => {
  const dbCtx = txn || db;
  const quoteItemId = poInfo.quote_item_id || poInfo.quote_id;

  if (!quoteItemId || !poInfo.product_info) {
    return poInfo;
  }

  try {
    const dbRow = await dbCtx.oneOrNone(
      `SELECT qi.freight_price, qi.freight_mode,
              qi.package_price, qi.package_mode,
              qi.tax, qi.tax_mode,
              qi.other_charges
       FROM tbl_quote_items qi
       WHERE qi.id = $1`,
      [quoteItemId]
    );

    if (!dbRow) {
      logger.warn(`buildAuthoritativePOPayload: Quote item ${quoteItemId} not found, using payload as-is`);
      return poInfo;
    }

    return {
      ...poInfo,
      product_info: {
        ...poInfo.product_info,
        charges_meta: {
          freight_price: dbRow.freight_price,
          freight_mode: dbRow.freight_mode,
          package_price: dbRow.package_price,
          package_mode: dbRow.package_mode,
          tax: dbRow.tax,
          tax_mode: dbRow.tax_mode,
          other_charges: dbRow.other_charges || []
        }
      }
    };
  } catch (err) {
    logError('buildAuthoritativePOPayload error, using payload as-is:', err);
    return poInfo;
  }
};

export const draftPO = async (poInfo, user, txn) => {
  try {
    const { rfq_id, project_id, product_info, quote_item_id, existing_po_id, selected_hierarchy } = poInfo;
    const { id: initiated_by, company_id } = user;

    if (!rfq_id || !product_info || !product_info.rfq_product_id) {
      throw new Error('Missing required PO fields.');
    }

    // Server-authoritative recompute: ignore the client's total_value and
    // derive it from the engine using the charges_meta that will actually
    // persist (which buildAuthoritativePOPayload may already have replaced
    // with values from tbl_quote_items).
    const meta = pricingEngine.normalizeChargesMeta(product_info.charges_meta || {});
    const lineOut = pricingEngine.calculateLineTotal({
      unit_price: product_info.unit_price,
      quantity: product_info.quantity,
      tax: meta.tax,
      tax_mode: meta.tax_mode,
      other_charges: meta.other_charges,
    });
    const total_value = lineOut.total;

    const result = await draftPurchaseOrder(
      rfq_id,
      project_id,
      quote_item_id,
      total_value,
      product_info,
      initiated_by,
      company_id,
      user,
      existing_po_id,
      selected_hierarchy,
      txn
    );

    return result;
  } catch (error) {
    logError('draftPO failed', error);
    throw error;
  }
};

export const initiatePO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const initiator = req.user;

    const result = await db.tx(async t => {
      return await initiatePurchaseOrder(po_id, initiator, t);
    })

    if(result.approval_required) {
      const purchaseOrder = await db.oneOrNone(
        `SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`,
        [result.po_id]
      );

      // Handle notifications based on workflow type
      if (result.approval_type === 'new' && result.approval_instance_id) {
        // NEW WORKFLOW: Get pending approvers from the approval instance
        const pendingApprovers = await db.any(`
          SELECT DISTINCT tasa.approver_user_id AS user_id
          FROM tbl_approval_step_approvers tasa
          JOIN tbl_approval_instance_steps tais ON tais.id = tasa.approval_instance_step_id
          WHERE tais.approval_instance_id = $1
            AND tais.step_order = (
              SELECT current_step FROM tbl_approval_instances WHERE id = $1
            )
            AND tais.status = 'PENDING'
        `, [result.approval_instance_id]);

        // Send notification to each pending approver
        for (const approver of pendingApprovers) {
          await sendApprovalNotification(purchaseOrder, approver.user_id);
        }
      } else if (result.current_approver_id) {
        // OLD WORKFLOW: Single approver notification
        await sendApprovalNotification(purchaseOrder, result.current_approver_id);
      }
    }

    return res.json({
      status: 1,
      message: "Purchase order has been initiated",
      data: {
        approval_required: result.approval_required,
        approval_type: result.approval_type || 'legacy',
        approval_instance_id: result.approval_instance_id || null
      }
    })
  } catch (error) {
    // logError(error);
    return res.status(400).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const approvePO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { decision, remarks = '' } = req.body;
    const { id: userId, company_id } = req.user;

    if(!decision || !(Object.values(APPROVAL_DECISIONS).includes(decision))) {
      return res.status(400).json({
        status: 2,
        message: "Missing required data, Decision is required!"
      });
    }

    return db.tx(async t => {
        // Check if PO uses new approval workflow (has approval_instance_id)
        const po = await t.oneOrNone(`
          SELECT id, approval_instance_id, status, rfq_id, finalized_vendor_id, rfq_product_id
          FROM tbl_rfq_purchase_order WHERE id = $1
        `, [po_id]);

        if (!po) {
          return res.status(404).json({
            status: 2,
            message: 'Purchase order not found.'
          });
        }

        // NEW APPROVAL WORKFLOW
        if (po.approval_instance_id) {
          // NOTE: this dedicated endpoint uses the raw submitApprovalAction
          // model function (NOT executeApprovalAction) because the post-action
          // handlers must run AFTER regeneratePODocument so that the PDF
          // emailed by handlePOPostApproval includes the latest approver. The
          // dispatcher in approvalActionService cannot inject the PDF
          // regeneration step between submitApprovalAction and the post-action,
          // so we keep the explicit ordering here.
          //
          // Other approval surfaces (RFQ Lifecycle Journey, generic action
          // endpoint) go through executeApprovalAction and the dispatcher,
          // which correctly handles the PO status transition — they just
          // don't regenerate the PDF, which is acceptable because the
          // dedicated endpoint is the canonical PO approval surface.
          const actionResult = await submitApprovalAction({
            approval_instance_id: po.approval_instance_id,
            approver_user_id: userId,
            action: decision === 'approved' ? 'APPROVE' : 'REJECT',
            comment: remarks || ''
          });

          // Regenerate PO document on every approval step to update approver statuses
          // Must happen BEFORE post-approval so the emailed PDF includes the latest approver
          if (decision === 'approved') {
            try {
              await regeneratePODocument(po_id, t);
            } catch (err) {
              logError('Failed to regenerate PO document', err);
            }
          }

          // Handle post-approval actions
          if (actionResult.instance_status === 'APPROVED') {
            await handlePOPostApproval(po.approval_instance_id, userId, { txContext: t });
          } else if (actionResult.instance_status === 'REJECTED') {
            // Update PO status to rejected
            await t.none(`
              UPDATE tbl_rfq_purchase_order SET status = 'rejected', updated_at = NOW() WHERE id = $1
            `, [po_id]);

            // Handle rejection cleanup (move finalization to history)
            await handlePORejection(po, userId, t);
          }

          return res.status(200).json({
            status: 1,
            message:
              actionResult.instance_status === 'APPROVED'
                ? 'Purchase order approved and finalized.'
                : actionResult.instance_status === 'REJECTED'
                ? 'Purchase order rejected successfully.'
                : 'Approval action recorded, waiting for more approvers.',
            data: {
              instance_status: actionResult.instance_status,
              step_status: actionResult.status,
              next_step: actionResult.next_step,
              approval_type: 'new'
            }
          });
        }

        // OLD APPROVAL WORKFLOW (backward compatibility for non-hospitality POs)
        // 1. Get the matching approval transaction by looking into the meta
        const trx = await t.oneOrNone(
          `SELECT * FROM tbl_approval_hierarchy_transactions
           WHERE hierarchy_type = $4
             AND company_id = $1
             AND status = $2
             AND meta ->> 'po_id' = $3`,
          [
            company_id,
            APPROVAL_DECISIONS.PENDING,
            String(po_id),
            AVAILABLE_HIERARCHY_TYPES.po.type,
          ]
        );

        if (!trx) {
          return res.status(404).json({
            status: 2,
            message: 'No approval request found for this PO.'
          });
        }

        const result = await generalModel.approveRequest({
          transactionId: trx.id,
          approvedBy: userId,
          decision,
          remarks,
          t,
        });

        // Regenerate PO document to update approval section (on each successful approval)
        // Must happen BEFORE fetching purchaseOrder so notification gets the latest po_pdf_url
        if (decision === 'approved') {
          try {
            await regeneratePODocument(po_id, t);
          } catch (err) {
            logError('Failed to regenerate PO document', err);
          }
        }

        const purchaseOrder = await t.oneOrNone(`
          SELECT * FROM tbl_rfq_purchase_order trpo
            JOIN tbl_approval_hierarchy_transactions taht ON taht.id = $1
          WHERE trpo.id = taht.target_entity_id`,
        [trx.id])

        if (result && (!result.approval_required || result.is_rejected)) {
          await markPOStatusChange(po_id, t, result.is_rejected, req.user);

          if(result.is_rejected) {
            await handlePORejection(purchaseOrder, userId, t);
          } else {
            // Send company-wide notification for legacy workflow
            sendLegacyPOApprovalNotification(purchaseOrder, trx).catch(err => {
              logError('Failed to send legacy PO approval notifications', err);
            });
          }
        } else if (result && (!result.is_rejected && result.approval_required)) {
          await sendApprovalNotification(purchaseOrder, result.current_approver_id);
        }

        return res.status(200).json({
          status: 1,
          message:
            decision === 'rejected'
              ? 'Purchase order rejected successfully.'
              : result.approval_required
              ? 'Purchase order approved and sent to next approver.'
              : 'Purchase order approved and finalized.',
          data: { ...result, approval_type: 'legacy' }
        });
    })
  } catch (error) {
    logError(error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const handlePORejection = async (purchaseOrder, rejectedBy, t) => {
  try {
    if(!purchaseOrder) throw new Error("Purchase order is required to handle Reject Case")
    if(!t) throw new Error("Transaction is required for PO Rejection Case handling")

    // Query ALL products from tbl_purchase_order_product (source of truth)
    const poProducts = await t.any(`
      SELECT pop.rfq_product_id, rp.product_variant_id, rp.variant
      FROM tbl_purchase_order_product pop
      JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
      WHERE pop.purchase_order_id = $1
    `, [purchaseOrder.id]);

    for (const product of poProducts) {
      const finalization = await t.oneOrNone(`
        SELECT * FROM tbl_quote_finalization
        WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3
        LIMIT 1
      `, [purchaseOrder.rfq_id, product.product_variant_id, product.variant]);

      if (!finalization) continue;

      await rfqModel.insert(
        'tbl_quote_finalization_history',
        {
          rfq_id: finalization.rfq_id,
          rfq_no: finalization.rfq_no,
          product_variant_id: finalization.product_variant_id,
          vendor_id: finalization.vendor_id,
          quote_id: finalization.quote_id,
          created_by: finalization.created_by,
          timestamp: finalization.timestamp,
          variant: finalization.variant,
          changed_by: rejectedBy
        },
        t
      );

      await t.none(`
        DELETE FROM tbl_quote_finalization WHERE id = $1
      `, [finalization.id]);
    }
  } catch (error) {
    logError(error);
    return false;
  }
};

/**
 * Post-approval handler for PO - called when approval instance is fully approved
 * Uses the new approval workflow (tbl_approval_instances)
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [options]
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 */
export const handlePOPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    const instance = await getApprovalInstanceById(approval_instance_id, 'PO', t);

    if (!instance || instance.status !== 'APPROVED') {
      return;
    }

    const po_id = instance.entity_id;
    const metadata = instance.metadata || {};

    // Get PO details
    const purchaseOrder = await t.oneOrNone(`
      SELECT * FROM tbl_rfq_purchase_order WHERE id = $1
    `, [po_id]);

    if (!purchaseOrder) {
      logger.error(`PO ${po_id} not found for approval instance ${approval_instance_id}`);
      return;
    }

    // Update PO status to acceptance_pending (vendor must accept before proceeding)
    await t.none(`
      UPDATE tbl_rfq_purchase_order
      SET status = 'acceptance_pending', updated_at = NOW()
      WHERE id = $1
    `, [po_id]);

    // Record lifecycle event
    await recordLifecycleEvent({
      entity_type: 'PO',
      entity_id: po_id,
      stage: 'PO_ACCEPTANCE_PENDING',
      action: 'APPROVE',
      performed_by: approver_user_id,
      metadata: {
        approval_instance_id,
        rfq_id: metadata.rfq_id,
        po_number: metadata.po_number
      },
      txContext: t
    });

    // Send notification to all company members
    try {
      // Get full approval instance details with action history
      const instanceDetails = await getApprovalInstanceDetails(approval_instance_id, approver_user_id);

      // Get RFQ details
      const rfqDetails = await t.oneOrNone(`
        SELECT r.id, r.rfq_no, r.title, r.timestamp, r.hospitality_company_id, r.hotel_id, r.created_by
        FROM tbl_rfq r
        WHERE r.id = $1
      `, [purchaseOrder.rfq_id]);

      // Send acceptance request email to vendor (vendor must accept/reject)
      sendPOAcceptanceRequestToVendor(purchaseOrder, rfqDetails).catch(err => {
        logError('Failed to send PO acceptance request to vendor', err);
      });

      // Get product names from tbl_purchase_order_product (normalized table)
      const products = await t.any(`
        SELECT pv.name, pop.quantity, pop.unit, pop.unit_price, pop.total_price
        FROM tbl_purchase_order_product pop
        JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
        JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
        WHERE pop.purchase_order_id = $1
      `, [purchaseOrder.id]);
      const productNames = products.map(p => p.name);

      // Get vendor details
      const vendorData = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
      const vendorCompanyData = await userModel.getCompanyDetail(purchaseOrder.finalized_vendor_id);
      const vendorDetails = vendorData?.[0] || {};

      // Get company details
      const companyDetails = await t.oneOrNone(`
        SELECT name AS company_name FROM tbl_hospitality_companies WHERE id = $1
      `, [rfqDetails?.hospitality_company_id]);

      // Get users mapped to this specific hotel + company-level admins
      const hotelUsers = await hospitalityModel.getUserMappingsForCompany(
        rfqDetails?.hospitality_company_id,
        1,  // mapping_type = 1 (hotel-level)
        rfqDetails?.hotel_id
      );
      const companyAdmins = await hospitalityModel.getUserMappingsForCompany(
        rfqDetails?.hospitality_company_id,
        0   // mapping_type = 0 (company-level)
      );
      // Deduplicate by user_id
      const userMap = new Map();
      [...hotelUsers, ...companyAdmins].forEach(m => {
        if (!userMap.has(m.user_id)) {
          userMap.set(m.user_id, { id: m.user_id, name: m.name, email: m.email });
        }
      });
      const usersToNotify = Array.from(userMap.values());

      // Build approval history from action_history (filter out system audit entries)
      const DISPLAYABLE_ACTIONS = ['APPROVE', 'REJECT', 'APPROVER_REMOVED', 'STEP_REMOVED'];
      const approvalHistory = (instanceDetails?.action_history || [])
        .filter(action => DISPLAYABLE_ACTIONS.includes(action.action))
        .map(action => ({
          step_order: instanceDetails.steps?.find(s =>
            s.approvers?.some(a => a.user_id === action.actor?.user_id)
          )?.step_order || 1,
          approver_name: action.actor?.name || 'Unknown',
          action: action.action,
          created_at: action.created_at
        }));

      // Fire-and-forget notification (internal team: PO approved, sent to vendor for acceptance)
      sendPOApprovalCompletionNotification({
        rfqDetails: {
          id: rfqDetails?.id,
          rfq_no: rfqDetails?.rfq_no,
          title: rfqDetails?.title,
          created_at: rfqDetails?.created_at
        },
        poDetails: {
          id: purchaseOrder.id,
          po_number: purchaseOrder.po_number,
          total_value: products.reduce((sum, p) => sum + Number(p.total_price || 0), 0),
          quantity: products.reduce((sum, p) => sum + Number(p.quantity || 0), 0),
          po_pdf_url: purchaseOrder.po_pdf_url,
          created_at: purchaseOrder.created_at
        },
        vendorDetails: {
          id: vendorDetails.id,
          organization_name: vendorDetails.organization_name,
          name: vendorDetails.name,
          email: vendorDetails.email,
          company_name: vendorCompanyData[0]?.company_name || ''
        },
        productNames,
        approvalHistory,
        users: usersToNotify,
        companyDetails: {
          company_name: companyDetails?.company_name
        }
      }).catch(err => {
        logError('Failed to send PO approval completion notifications', err);
      });

    } catch (notificationError) {
      // Don't fail the approval if notification fails
      logError('Error preparing PO approval notifications', notificationError);
    }

    logger.info(`PO ${po_id} approved via new approval workflow`);
  } catch (error) {
    logError('Error handling PO post-approval', error);
  }
};

/**
 * Instance-based wrapper around handlePORejection for use by the centralized
 * approval action service. The original handlePORejection takes a pre-loaded
 * PO object and a transaction context (because it's called from inside the
 * dedicated approvePO endpoint's transaction). This wrapper loads the PO row
 * from the approval instance, updates the PO status to 'rejected', and then
 * delegates the finalization-history cleanup to handlePORejection.
 *
 * Called by approvalActionService.executeApprovalAction whenever a PO
 * approval instance is rejected through any surface (generic action endpoint,
 * lifecycle journey, etc.).
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [ctx]
 * @param {Object} [ctx.instance] - pre-loaded approval instance, optional
 */
export const handlePORejectionByInstance = async (approval_instance_id, approver_user_id, ctx = {}) => {
  try {
    const instance = ctx.instance || await getApprovalInstanceById(approval_instance_id, 'PO');
    if (!instance || instance.entity_type !== 'PO' || instance.status !== 'REJECTED') {
      return;
    }

    const po_id = instance.entity_id;

    await db.tx(async (t) => {
      const purchaseOrder = await t.oneOrNone(`
        SELECT id, approval_instance_id, status, rfq_id, finalized_vendor_id, rfq_product_id
        FROM tbl_rfq_purchase_order WHERE id = $1
      `, [po_id]);

      if (!purchaseOrder) {
        logger.error(`PO ${po_id} not found for rejected approval instance ${approval_instance_id}`);
        return;
      }

      await t.none(`
        UPDATE tbl_rfq_purchase_order SET status = 'rejected', updated_at = NOW() WHERE id = $1
      `, [po_id]);

      await handlePORejection(purchaseOrder, approver_user_id, t);
    });
  } catch (error) {
    logError('Error handling PO rejection by instance', error);
  }
};

/**
 * Send PO approval completion notification for legacy (non-hospitality) workflow
 */
const sendLegacyPOApprovalNotification = async (purchaseOrder, transaction) => {
  try {
    // Get RFQ details
    const rfqDetails = await db.oneOrNone(`
      SELECT r.id, r.rfq_no, r.title, r.timestamp, r.company_id
      FROM tbl_rfq r WHERE r.id = $1
    `, [purchaseOrder.rfq_id]);

    // Get product names from tbl_purchase_order_product (normalized table)
    const products = await db.any(`
      SELECT pv.name, pop.quantity, pop.unit, pop.unit_price, pop.total_price
      FROM tbl_purchase_order_product pop
      JOIN tbl_rfq_products rp ON pop.rfq_product_id = rp.id
      JOIN tbl_product_variant pv ON rp.product_variant_id = pv.id
      WHERE pop.purchase_order_id = $1
    `, [purchaseOrder.id]);
    const productNames = products.map(p => p.name);

    // Get vendor details
    const vendorData = await userModel.getUserById(purchaseOrder.finalized_vendor_id);
    const vendorCompanyData = await userModel.getCompanyDetail(purchaseOrder.finalized_vendor_id);
    const vendorDetails = vendorData?.[0] || {};

    // Get company details (non-hospitality)
    const companyDetails = await db.oneOrNone(`
      SELECT company_name FROM tbl_company WHERE id = $1
    `, [rfqDetails?.company_id]);

    // Get approval history from legacy tables
    const approvalHistory = await db.any(`
      SELECT
        tah.approval_level as step_order,
        u.name as approver_name,
        tahh.decision as action,
        tahh.created_at
      FROM tbl_approval_hierarchy_history tahh
      JOIN tbl_approval_hierarchy tah ON tahh.approver_id = tah.user_id
        AND tah.hierarchy_type = 'po'
        AND tah.hierarchy_id = $2
      JOIN tbl_users u ON tahh.approver_id = u.id
      WHERE tahh.transaction_id = $1
      ORDER BY tahh.created_at ASC
    `, [transaction.id, transaction.hierarchy_id]);

    // Get all users in the approval hierarchy (company members involved in PO approvals)
    const hierarchyUsers = await db.any(`
      SELECT DISTINCT u.id, u.name, u.email
      FROM tbl_approval_hierarchy ah
      JOIN tbl_users u ON ah.user_id = u.id
      WHERE ah.company_id = $1
        AND ah.hierarchy_type = 'po'
        AND ah.is_active = true
        AND u.status = 1
        AND u.is_deleted = 0
    `, [rfqDetails?.company_id]);

    // Also get the PO initiator
    const initiator = await userModel.getUserById(purchaseOrder.created_by);
    if (initiator?.[0] && !hierarchyUsers.find(u => u.id === initiator[0].id)) {
      hierarchyUsers.push({
        id: initiator[0].id,
        name: initiator[0].name,
        email: initiator[0].email
      });
    }

    // Format approval history for email
    const formattedHistory = approvalHistory.map(h => ({
      step_order: h.step_order,
      approver_name: h.approver_name,
      action: h.action?.toUpperCase() === 'APPROVED' ? 'APPROVE' : h.action?.toUpperCase(),
      created_at: h.created_at
    }));

    // Send notification
    await sendPOApprovalCompletionNotification({
      rfqDetails: {
        id: rfqDetails?.id,
        rfq_no: rfqDetails?.rfq_no,
        title: rfqDetails?.title,
        created_at: rfqDetails?.created_at
      },
      poDetails: {
        id: purchaseOrder.id,
        po_number: purchaseOrder.po_number,
        total_value: purchaseOrder.total_value,
        quantity: purchaseOrder.quantity,
        po_pdf_url: purchaseOrder.po_pdf_url,
        created_at: purchaseOrder.created_at
      },
      vendorDetails: {
        id: vendorDetails.id,
        organization_name: vendorDetails.organization_name,
        name: vendorDetails.name,
        email: vendorDetails.email,
        company_name: vendorCompanyData[0]?.company_name || '',
      },
      productNames,
      approvalHistory: formattedHistory,
      users: hierarchyUsers,
      companyDetails: {
        company_name: companyDetails?.company_name
      }
    });

  } catch (error) {
    logError('Error in sendLegacyPOApprovalNotification', error);
  }
};

// ============= VENDOR ACCEPTANCE / REJECTION =============

/**
 * Vendor accepts a PO that is in acceptance_pending status.
 * POST /api/v1/po/accept/:po_id
 */
export const acceptPO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const vendorUserId = req.user.id;

    const result = await db.tx(async t => {
      const po = await t.oneOrNone(`
        SELECT * FROM tbl_rfq_purchase_order
        WHERE id = $1 AND status = 'acceptance_pending' AND finalized_vendor_id = $2
      `, [po_id, vendorUserId]);

      if (!po) {
        throw new Error('PO not found, already actioned, or you are not the assigned vendor.');
      }

      await t.none(`
        UPDATE tbl_rfq_purchase_order
        SET status = 'approved', vendor_action_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [po_id]);

      await recordLifecycleEvent({
        entity_type: 'PO',
        entity_id: po_id,
        stage: 'PO_ACCEPTED_BY_VENDOR',
        action: 'ACCEPT',
        performed_by: vendorUserId,
        metadata: { rfq_id: po.rfq_id, po_number: po.po_number },
        txContext: t
      });

      return po;
    });

    // Send confirmed PO email to vendor (existing email with PO PDF)
    const rfqDetails = await db.oneOrNone(`
      SELECT r.id, r.rfq_no, r.title, r.created_by, r.hospitality_company_id, r.hotel_id
      FROM tbl_rfq r WHERE r.id = $1
    `, [result.rfq_id]);

    const rfqCreator = await userModel.getUserById(rfqDetails?.created_by);
    if (rfqCreator && rfqCreator[0]) {
      sendPONotificationToVendor(result, rfqCreator[0]).catch(err => {
        logError('Failed to send PO confirmed notification to vendor', err);
      });
    }

    // Send "Vendor Accepted" notification to all internal BU members
    sendPOAcceptedNotificationToTeam(result, rfqDetails).catch(err => {
      logError('Failed to send PO accepted notification to team', err);
    });

    return res.json({
      status: 1,
      message: 'Purchase order accepted successfully.',
    });
  } catch (error) {
    logError(error);
    return res.status(400).json({
      status: 0,
      message: error.message || 'Failed to accept PO.',
    });
  }
};

/**
 * Vendor rejects a PO that is in acceptance_pending status.
 * POST /api/v1/po/reject/:po_id
 */
export const rejectPO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { reason = '' } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ status: 0, message: 'Rejection reason is required.' });
    }
    const vendorUserId = req.user.id;

    const result = await db.tx(async t => {
      const po = await t.oneOrNone(`
        SELECT * FROM tbl_rfq_purchase_order
        WHERE id = $1 AND status = 'acceptance_pending' AND finalized_vendor_id = $2
      `, [po_id, vendorUserId]);

      if (!po) {
        throw new Error('PO not found, already actioned, or you are not the assigned vendor.');
      }

      await t.none(`
        UPDATE tbl_rfq_purchase_order
        SET status = 'rejected_by_vendor',
            vendor_rejection_reason = $2,
            vendor_action_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `, [po_id, reason]);

      // Definalize vendor — move from tbl_quote_finalization to history
      await handlePORejection(po, vendorUserId, t);

      await recordLifecycleEvent({
        entity_type: 'PO',
        entity_id: po_id,
        stage: 'PO_REJECTED_BY_VENDOR',
        action: 'REJECT',
        performed_by: vendorUserId,
        metadata: {
          rfq_id: po.rfq_id,
          po_number: po.po_number,
          rejection_reason: reason
        },
        txContext: t
      });

      return po;
    });

    // Send rejection notification to commercial evaluators (fire-and-forget)
    sendVendorRejectionNotification(result, vendorUserId, reason).catch(err => {
      logError('Failed to send vendor rejection notification', err);
    });

    return res.json({
      status: 1,
      message: 'Purchase order rejected. The buyer has been notified.',
    });
  } catch (error) {
    logError(error);
    return res.status(400).json({
      status: 0,
      message: error.message || 'Failed to reject PO.',
    });
  }
};

export const updateGST = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { value } = req.body;

    const updatedData = await updateGSTForPO(po_id, value);
    return res.json({
      status: 1,
      message: 'Updated GST for given PO.',
      data: updatedData
    })
  } catch (error) {
    logError(error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const updateHSNForProduct = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { hsn_codes } = req.body;
    const { id } = req.user;

    const updatedData = await updateHSNCode(po_id, hsn_codes, id);
    return res.json({
      status: 1,
      message: 'Updated HSN for given product.',
      data: updatedData
    });
  } catch (error) {
    logError('updateHSNForProduct failed', error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const raiseInvoice = async (req, res) => {
  try {
    const { po_id, invoice_url } = req.body;
    const { id } = req.user;

    const result = await handleRaiseInvoice(po_id, invoice_url, id);
    return res.json({
      status: 1,
      message: 'Invoice has been raised for this PO.',
      data: result
    });
  } catch (error) {
    logError('raiseInvoice failed', error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const markGRN = async (req, res) => {
  try {
    const { po_id, grn_document_url, remarks } = req.body;
    const { id } = req.user;

    const result = await handleMarkGRN(po_id, grn_document_url, id, remarks);
    return res.json({
      status: 1,
      message: 'GRN has been marked for this PO.',
      data: result
    });
  } catch (error) {
    logError('markGRN failed', error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const markDispatched = async (req, res) => {
  try {
    const { po_id } = req.body;
    const { id } = req.user;

    const result = await handleMarkDispatched(po_id, id);
    return res.json({
      status: 1,
      message: 'Marked as Dispatched for this PO.',
      data: result
    });
  } catch (error) {
    logError('markDispatched failed', error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

export const addSiteRepresentative = async (req, res) => {
  try {
    const { po_id, name, email, phone } = req.body;
    const { id, company_id } = req.user;

    const result = await handleAddSiteRepresentative(po_id, id, name, email, phone);
    return res.json({
      status: 1,
      message: 'Site Rep has been added for this PO',
      data: result
    });
  } catch (error) {
    logError('addSiteRepresentative failed', error);
    return res.status(500).json({
      status: 0,
      message: error.message || 'An error occurred while approving the PO.',
      error
    });
  }
};

// Payment Milestone Controllers
export const getMilestonesController = async (req, res) => {
  try {
    const { po_id } = req.params;
    const user = req.user;

    const data = await getMilestonesByPOId(req.user.company_id, po_id, user.user_type == '8');
    return res.status(200).json({ success: true, data });
  } catch (error) {
    logError('getMilestonesController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createMilestoneController = async (req, res) => {
  try {
    let milestone = await createMilestone(req.body, req.user);
    if(milestone) {
      await scheduleMilestoneReminder(milestone)
    };

    return res.status(201).json({ success: true, data: milestone });
  } catch (error) {
    logError('createMilestoneController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMilestoneController = async (req, res) => {
  try {
    const updated = await updateMilestone(req.params.id, req.body, req.user.id);
    if (updated) await rescheduleMilestoneReminder(updated);

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    logError('updateMilestoneController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMilestoneController = async (req, res) => {
  try {
    const deleted = await deleteMilestone(req.params.id, req.user);
    if (deleted) removeMilestoneReminder(deleted.id);
    
    return res.status(200).json({ success: true, data: deleted });
  } catch (error) {
    logError('deleteMilestoneController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PO Tasks Controllers
export const getTasksController = async (req, res) => {
  try {
    const { po_id } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const [data, count] = await getTasksByPOId(req.user.company_id, po_id, page, limit);
    return res.status(200).json({ success: true, data, total: count });
  } catch (error) {
    logError('getTasksController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createTaskController = async (req, res) => {
  try {
    const milestone = await createTask(req.body, req.user);

    return res.status(201).json({ success: true, data: milestone });
  } catch (error) {
    logError('createTaskController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateTaskController = async (req, res) => {
  try {
    const updated = await updateTask(req.params.id, req.body, req.user.id);

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    logError('updateTaskController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteTaskController = async (req, res) => {
  try {
    const deleted = await deleteTask(req.params.id, req.user);

    return res.status(200).json({ success: true, data: deleted });
  } catch (error) {
    logError('deleteTaskController failed', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const regeneratePO = async (req, res) => {
  try {
    const { po_id } = req.params;

    const newUrl = await regeneratePODocument(po_id);

    if (newUrl) {
      return res.json({
        status: 1,
        message: "PO document regenerated successfully",
        data: { po_pdf_url: newUrl }
      });
    }

    return res.status(500).json({
      status: 0,
      message: "Failed to regenerate PO document"
    });
  } catch (error) {
    logError(error);
    return res.status(500).json({
      status: 0,
      message: error.message || "An error occurred while regenerating the PO document.",
      error
    });
  }
};

export const uploadPODocument = async (req, res) => {
  try {
    const { po_id } = req.params;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        status: 0,
        message: "No file uploaded"
      });
    }

    const s3Url = req.file.location;

    await db.none(`
      UPDATE tbl_rfq_purchase_order
      SET po_pdf_url = $1, updated_at = NOW()
      WHERE id = $2
    `, [s3Url, po_id]);

    return res.json({
      status: 1,
      message: "PO document uploaded successfully",
      data: { po_pdf_url: s3Url }
    });
  } catch (error) {
    logError(error);
    return res.status(500).json({
      status: 0,
      message: error.message || "An error occurred while uploading the PO document.",
      error
    });
  }
};