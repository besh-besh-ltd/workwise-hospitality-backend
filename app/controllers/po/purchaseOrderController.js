import db from "../../config/dbConn.js";
import { logError } from "../../helper/common.js";
import generalModel, { markPOStatusChange } from "../../models/generalModel.js";
import { getPOByRFQId, getPODetailsById, initiatePurchaseOrder } from "../../models/purchaseOrderModel.js";
import { APPROVAL_DECISIONS, AVAILABLE_HIERARCHY_TYPES } from "../../util/constants.js";

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

export const initiatePO = async (poInfo, user, txn) => {
  try {
    const { rfq_id, project_id, total_value, product_info, quote_id } = poInfo;
    const { id: initiated_by, company_id } = user;

    if (!rfq_id || !product_info || !product_info.rfq_product_id) {
      throw new Error('Missing required PO fields.');
    }

    const result = await initiatePurchaseOrder(
      rfq_id,
      project_id,
      quote_id,
      total_value,
      product_info,
      initiated_by,
      company_id,
      txn
    );

    return result;
  } catch (error) {
    console.error(error);
    throw error;
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
             AND target_entity_type = $5
             AND company_id = $1
             AND status = $2
             AND meta ->> 'po_id' = $3`,
          [
            company_id,
            APPROVAL_DECISIONS.PENDING,
            String(po_id),
            AVAILABLE_HIERARCHY_TYPES.po.type,
            AVAILABLE_HIERARCHY_TYPES.po.target_entity_type
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
    
        if (result && (!result.approval_required || result.is_rejected)) {
          await markPOStatusChange(po_id, t, result.is_rejected);
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