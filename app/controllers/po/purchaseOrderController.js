import db from "../../config/dbConn.js";
import { logError } from "../../helper/common.js";
import { removeMilestoneReminder, rescheduleMilestoneReminder, scheduleMilestoneReminder } from "../../helper/cronManager.js";
import generalModel, { markPOStatusChange } from "../../models/generalModel.js";
import { createMilestone, createTask, deleteMilestone, deleteTask, getMilestonesByPOId, getPOByRFQId, getPODetailsById, getTasksByPOId, draftPurchaseOrder, updateMilestone, updateTask, initiatePurchaseOrder, updateGSTForPO, updateHSNCode } from "../../models/purchaseOrderModel.js";
import rfqModel from "../../models/rfqModel.js";
import { APPROVAL_DECISIONS, AVAILABLE_HIERARCHY_TYPES } from "../../util/constants.js";
import { sendApprovalNotification } from "./purchaseOrderEmails.js";

export const getPOByRFQ = async (req, res) => {
    try {
        const { rfq_id } = req.params;
        const { page = 1, limit = 10, ...filters } = req.query;
        const { id } = req.user;

        const result = await getPOByRFQId(rfq_id, id, page, limit, filters);

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

export const draftPO = async (poInfo, user, txn) => {
  try {
    const { rfq_id, project_id, total_value, product_info, quote_id, existing_po_id, selected_hierarchy } = poInfo;
    const { id: initiated_by, company_id } = user;

    if (!rfq_id || !product_info || !product_info.rfq_product_id) {
      throw new Error('Missing required PO fields.');
    }

    const result = await draftPurchaseOrder(
      rfq_id,
      project_id,
      quote_id,
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
    console.error(error);
    throw error;
  }
};

export const initiatePO = async (req, res) => {
  try {
    const { po_id } = req.params;
    const initiator = req.user;
  
    const result = await initiatePurchaseOrder(po_id, initiator);
    if(result.approval_required) {
      const purchaseOrder = await db.oneOrNone(
        `SELECT * FROM tbl_rfq_purchase_order
        WHERE id = $1`,
        [result.po_id]
      );
  
      await sendApprovalNotification(purchaseOrder, result.current_approver_id);
    }
  
    return res.json({
      status: 1,
      message: "Purchase order has been initiated"
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
    
        const purchaseOrder = await t.oneOrNone(`
          SELECT * FROM tbl_rfq_purchase_order trpo 
            JOIN tbl_approval_hierarchy_transactions taht ON taht.id = $1 
          WHERE trpo.id = taht.target_entity_id`,
        [trx.id])

        if (result && (!result.approval_required || result.is_rejected)) {
          await markPOStatusChange(po_id, t, result.is_rejected, req.user);

          if(result.is_rejected) {
            await handlePORejection(purchaseOrder, userId, t);
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
          data: result
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

    for (let product of purchaseOrder.rfq_product_id) {
      const alreadyExists = await t.one(`
        SELECT TQF.* FROM tbl_quote_finalization TQF
        JOIN tbl_rfq_products TRP ON TRP.id = $2
        WHERE TQF.rfq_id = $1
        AND TQF.product_variant_id = TRP.product_variant_id AND TQF.variant = TRP.variant 
        LIMIT 1
      `, [purchaseOrder.rfq_id, product])

      const history_data = {
        rfq_id: alreadyExists.rfq_id,
        rfq_no: alreadyExists.rfq_no,
        product_variant_id: alreadyExists.product_variant_id,
        vendor_id: alreadyExists.vendor_id,
        quote_id: alreadyExists.quote_id,
        created_by: alreadyExists.created_by,
        timestamp: alreadyExists.timestamp,
        variant: alreadyExists.variant,
        changed_by: rejectedBy
      };
  
      await rfqModel.insert(
        'tbl_quote_finalization_history',
        history_data,
        t
      );

      await t.one(`
        DELETE FROM tbl_quote_finalization
        WHERE id = $1 RETURNING *
      `, [alreadyExists.id]);
    }
  } catch (error) {
    logError(error);
    return false;
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
    logError(error);
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
    console.error(error);
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
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMilestoneController = async (req, res) => {
  try {
    const updated = await updateMilestone(req.params.id, req.body, req.user.id);
    if (updated) await rescheduleMilestoneReminder(updated);

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMilestoneController = async (req, res) => {
  try {
    const deleted = await deleteMilestone(req.params.id, req.user);
    if (deleted) removeMilestoneReminder(deleted.id);
    
    return res.status(200).json({ success: true, data: deleted });
  } catch (error) {
    console.error(error);
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
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createTaskController = async (req, res) => {
  try {
    const milestone = await createTask(req.body, req.user);

    return res.status(201).json({ success: true, data: milestone });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateTaskController = async (req, res) => {
  try {
    const updated = await updateTask(req.params.id, req.body, req.user.id);

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteTaskController = async (req, res) => {
  try {
    const deleted = await deleteTask(req.params.id, req.user);
    
    return res.status(200).json({ success: true, data: deleted });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: error.message });
  }
};