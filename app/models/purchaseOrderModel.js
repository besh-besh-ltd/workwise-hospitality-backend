import db from "../config/dbConn.js";
import { AVAILABLE_HIERARCHY_TYPES, PO_STATUSES } from "../util/constants.js";
import generalModel, { markPOStatusChange } from "./generalModel.js";

const getNextPONumber = async () => {
  return new Promise(async function (resolve, reject) {
    const query = `SELECT rfq_no FROM tbl_rfq ORDER BY id DESC LIMIT 1`;
    const response = await db.one(query);
    if (response && response.length > 0) {
      resolve(response[0].po_number + 1);
    } else {
      resolve(Math.floor(100000 + Math.random() * 900000));
    }
  });
};

export const initiatePurchaseOrder = async (rfq_id, project_id, quote_id, total_value, product_info, initiated_by, company_id, txn) => {
    try {
      return db.tx(async (t) => {
        t = txn ?? t;

        const { rfq_product_id, quantity, unit_price, finalized_vendor_id } =
          product_info;

        // 1. Check if a pending PO already exists for this RFQ Product
        const existing = await t.oneOrNone(
          `SELECT id FROM tbl_rfq_purchase_order
        WHERE rfq_id = $1 AND rfq_product_id = $2 AND status = $3`,
          [rfq_id, rfq_product_id, PO_STATUSES.PENDING_APPROVAL]
        );

        if (existing) {
          await t.none(
            `UPDATE tbl_rfq_purchase_order
            SET status = $3, updated_at = NOW()
            WHERE rfq_id = $1 AND rfq_product_id = $2`,
            [rfq_id, rfq_product_id, PO_STATUSES.CANCELLED]
          );
        }

        // 2. Insert new PO record
        const poNumber = await getNextPONumber();
        const po = await t.one(
          `INSERT INTO tbl_rfq_purchase_order (
            rfq_id, project_id, quote_id, po_number, total_value, rfq_product_id, quantity,
            unit_price, finalized_vendor_id, initiated_by, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
          [
            rfq_id,
            project_id,
            quote_id,
            poNumber,
            total_value,
            rfq_product_id,
            quantity,
            unit_price,
            finalized_vendor_id,
            initiated_by,
            PO_STATUSES.PENDING_APPROVAL
          ]
        );

        // 3. Call Approval Logic
        const meta = {
          rfq_id,
          project_id,
          rfq_product_id,
          quantity,
          unit_price,
          finalized_vendor_id,
          total_value,
          po_id: po.id
        };

        const approvalResult = await generalModel.initiateApproval({
          type: AVAILABLE_HIERARCHY_TYPES.po.type,
          entityType: AVAILABLE_HIERARCHY_TYPES.po.target_entity_type,
          entityId: po.id,
          companyId: company_id,
          initiatedBy: initiated_by,
          meta,
          errors: {
            exist: `You cannot change the finalized vendor because an approved Purchase Order already exists for them.`
          }
        });

        // 4. If no further approval required → mark PO as approved
        if (!approvalResult.approval_required) {
          await markPOStatusChange(po.id, t);
        }

        return {
          po_id: po.id,
          approval_required: approvalResult.approval_required,
          current_approver_id: approvalResult.current_approver_id ?? null
        };
      });
    } catch (error) {
      throw error;
    }
};

export const getPOByRFQId = async (rfq_id, user_id, page = 1, limit = 10, filters = {}) => {
  try {
    const offset = (page - 1) * limit;

    const conditions = ["po.rfq_id = $1"];
    const values = [rfq_id, user_id];
    let paramIndex = 3; // Next available $ index

    // Search by PO Number
    if (filters.poNumber) {
      conditions.push(`po.po_number ILIKE $${paramIndex++}`);
      values.push(`%${filters.poNumber}%`);
    }

    // Filter by Initiated By
    if (filters.initiatedBy) {
      conditions.push(`po.initiated_by = $${paramIndex++}`);
      values.push(filters.initiatedBy);
    }

    // Filter by Status
    if (filters.status) {
      conditions.push(`po.status = $${paramIndex++}`);
      values.push(filters.status);
    }

    // Date Range Filters
    if (filters.dateFrom) {
      conditions.push(`po.created_at >= $${paramIndex++}`);
      values.push(filters.dateFrom);
    }

    if (filters.dateTo) {
      conditions.push(`po.created_at <= $${paramIndex++}`);
      values.push(filters.dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [pos, { total }] = await db.tx(async t => {
      const data = await t.any(
        `SELECT po.*,
                TU.name AS initiated_by,
                CASE WHEN trx.current_approver_id = $2 THEN TRUE ELSE FALSE END AS is_approver,
                JSON_BUILD_OBJECT(
                    'id', TPV.id,
                    'name', TPV.name
                ) AS product_details,
                CASE
                  WHEN trx.id IS NOT NULL THEN json_build_object(
                    'id', trx.id,
                    'status', trx.status,
                    'initiated_by', trx.initiated_by,
                    'current_approver_id', trx.current_approver_id,
                    'final_decision_by', trx.final_decision_by
                  )
                  ELSE NULL
                END AS approval_status
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_approval_hierarchy_transactions trx
           ON trx.hierarchy_type = 'po'
           AND trx.target_entity_id = po.id
        JOIN tbl_rfq_products TRP ON TRP.id = po.rfq_product_id
        JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
        JOIN tbl_users TU ON TU.id = po.initiated_by
         ${whereClause}
         ORDER BY po.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...values, limit, offset]
      );

      const count = await t.one(
        `SELECT COUNT(*) AS total
         FROM tbl_rfq_purchase_order po
         ${whereClause}`,
        values
      );

      return [data, count];
    });

    return {
      data: pos,
      page,
      limit,
      total: parseInt(total, 10),
      totalPages: Math.ceil(total / limit)
    };
  } catch (error) {
    throw error;
  }
};

export const getPODetailsById = async (po_id, user_id) => {
  try {
    const result = await db.oneOrNone(
      `SELECT po.*,
              TU.name AS initiated_by_name,
              CASE WHEN trx.current_approver_id = $2 THEN TRUE ELSE FALSE END AS is_approver,
              
              JSON_BUILD_OBJECT(
                  'id', TPV.id,
                  'name', TPV.name,
                  'product_id', TPV.product_id
              ) AS product_details,
              
              CASE
                WHEN trx.id IS NOT NULL THEN json_build_object(
                  'id', trx.id,
                  'status', trx.status,
                  'initiated_by', trx.initiated_by,
                  'current_approver_id', trx.current_approver_id,
                  'final_decision_by', trx.final_decision_by
                )
                ELSE NULL
              END AS approval_status,

              COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                        'id', H.id,
                        'action', H.action,
                        'remarks', H.remarks,
                        'created_at', H.created_at,
                        'approved_by', H.approved_by,
                        'approved_by_name', U.name
                      )
                  )
                  FROM tbl_approval_hierarchy_history H
                  JOIN tbl_users U ON U.id = H.approved_by
                  WHERE H.approval_transaction_id = trx.id
                ),
                '[]'::json
              ) AS approval_history

       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_approval_hierarchy_transactions trx
         ON trx.hierarchy_type = 'po'
         AND trx.target_entity_id = po.id
         AND trx.target_entity_type = 'purchase_order'
       JOIN tbl_rfq_products TRP ON TRP.id = po.rfq_product_id
       JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
       JOIN tbl_users TU ON TU.id = po.initiated_by
       WHERE po.id = $1`,
      [po_id, user_id]
    );

    return result;
  } catch (error) {
    console.error('Error in getPODetails:', error);
    throw error;
  }
};