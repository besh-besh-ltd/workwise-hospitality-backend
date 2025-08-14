import db from "../config/dbConn.js";
import { AVAILABLE_HIERARCHY_TYPES, PO_STATUSES } from "../util/constants.js";
import generalModel, { markPOStatusChange } from "./generalModel.js";

const getNextPONumber = async () => {
  return new Promise(async function (resolve, reject) {
    const query = `SELECT po_number FROM tbl_rfq_purchase_order ORDER BY created_at DESC LIMIT 1`;
    const response = await db.oneOrNone(query);
    if (response) {
      resolve(parseInt(response.po_number) + 1);
    } else {
      resolve(Math.floor(100000 + Math.random() * 900000));
    }
  });
};

export const initiatePurchaseOrder = async (rfq_id, project_id, quote_id, total_value, product_info, initiated_by, company_id, user, t) => {
    try {
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

      const approvalResult = await generalModel.initiateApproval(
        AVAILABLE_HIERARCHY_TYPES.po.type,
        po.id,
        company_id,
        initiated_by,
        meta,
        {
          exist: `You cannot change the finalized vendor because an approved Purchase Order already exists for them.`
        },
        t,
      );

      // 4. If no further approval required → mark PO as approved
      if (!approvalResult.approval_required) {
        await markPOStatusChange(po.id, t, false, user);
      }

      return {
        po_id: po.id,
        approval_required: approvalResult.approval_required,
        current_approver_id: approvalResult.current_approver_id ?? null
      };
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
                VENDOR.organization_name AS finalized_vendor_name,
                PRJ.name AS project_name,
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
                END AS approval_status,
                (
                  SELECT PM.* 
                    FROM tbl_payment_milestone PM 
                    WHERE PM.po_id = PO.id 
                      AND NOT PM.is_done 
                      AND PM.due_date > NOW()
                    
                    LIMIT 1
                ) AS upcoming_milestone
         FROM tbl_rfq_purchase_order po
         JOIN tbl_projects PRJ ON PRJ.id = PO.project_id
         LEFT JOIN tbl_approval_hierarchy_transactions trx
           ON trx.hierarchy_type = 'po'
           AND trx.target_entity_id = po.id
        JOIN tbl_rfq_products TRP ON TRP.id = po.rfq_product_id
        JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
        JOIN tbl_users TU ON TU.id = po.initiated_by
        JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
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
              CASE
                WHEN PD.id IS NOT NULL THEN
                  JSON_BUILD_OBJECT(
                      'id', PD.id,
                      'name', PD.name
                  )
                ELSE NULL END AS project_details,
              COALESCE(VENDOR.organization_name, VENDOR.name) AS finalized_vendor_name,
              VENDOR.email AS finalized_vendor_email,
              JSON_BUILD_OBJECT(
                  'id', LOGGED_IN_USER.id,
                  'name', LOGGED_IN_USER.name,
                  'user_type', LOGGED_IN_USER.user_type
              ) AS logged_in_user,
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
                  'current_approver_name', trx_user.name,
                  'final_decision_by', trx.final_decision_by,
                  'created_at', trx.created_at
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
              ) AS approval_history,
              COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                        'id', M.id,
                        'rfq_id', M.rfq_id,
                        'po_id', M.po_id,
                        'milestone_name', M.milestone_name,
                        'due_date', M.due_date,
                        'is_reminded', M.is_reminded,
                        'status', M.status,
                        'milestone_description', M.milestone_description,
                        'reminder_users', (
                          SELECT JSON_AGG(
                            JSON_BUILD_OBJECT(
                              'id', RU.id,
                              'name', RU.name
                            )
                          )
                          FROM UNNEST(M.reminder_users) AS reminder_user_id
                          JOIN tbl_users RU ON RU.id = reminder_user_id
                        ),
                        'attachments', M.attachments,
                        'created_by', U.name,
                        'created_at', M.created_at
                      )
                  )
                  FROM tbl_payment_milestone M
                  JOIN tbl_users U ON U.id = M.created_by
                  WHERE M.po_id = po.id
                  AND (
                    M.status != 'deleted' 
                    OR (LOGGED_IN_USER.user_type = 8) -- user_type 8 sees everything, including deleted
                  )
                ),
                '[]'::json
              ) AS payment_milestones,
              COALESCE(
              (
                SELECT JSON_AGG(
                    JSON_BUILD_OBJECT(
                      'id', M.id,
                      'rfq_id', M.rfq_id,
                      'po_id', M.po_id,
                      'task_name', M.task_name,
                      'completion_date', M.completion_date,
                      'status', M.status,
                      'task_description', M.task_description,
                      'created_by', U.name,
                      'created_at', M.created_at
                    )
                )
                FROM tbl_purchase_order_tasks M
                JOIN tbl_users U ON U.id = M.created_by
                WHERE M.po_id = po.id
              ),
              '[]'::json
            ) AS tasks

       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_approval_hierarchy_transactions trx
         ON trx.hierarchy_type = 'po'
         AND trx.target_entity_id = po.id
       LEFT JOIN tbl_projects PD ON PD.id = po.project_id

       LEFT JOIN tbl_users trx_user ON trx_user.id = trx.current_approver_id
       JOIN tbl_rfq_products TRP ON TRP.id = po.rfq_product_id
       JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
       JOIN tbl_users TU ON TU.id = po.initiated_by
       JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
       LEFT JOIN tbl_users LOGGED_IN_USER ON LOGGED_IN_USER.id = $2
       WHERE po.id = $1`,
      [po_id, user_id]
    );

    return result;
  } catch (error) {
    console.error('Error in getPODetails:', error);
    throw error;
  }
};

export const getMilestonesByPOId = async (company_id, po_id, includeDeleted = false) => {
  let condition = 'WHERE po_id = $1'
  condition += includeDeleted ? '' : ` AND status != 'deleted'`;

  return db.any(
    `SELECT * FROM tbl_payment_milestone 
     WHERE company_id = $2 ${condition}
     ORDER BY due_date ASC`,
    [po_id, company_id]
  );
};

export const createMilestone = async (data, user) => {
  const {
    rfq_id,
    po_id,
    milestone_name,
    due_date,
    milestone_description,
    reminder_users = [],
    attachments = [],
  } = data;

  const milestone = await db.oneOrNone(
    `INSERT INTO tbl_payment_milestone 
      (rfq_id, po_id, company_id, milestone_name, due_date, milestone_description, created_by, reminder_users, attachments) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [rfq_id, po_id, user.company_id, milestone_name, due_date, milestone_description, user.id, reminder_users, attachments ? JSON.stringify(attachments) : []]
  );

  return milestone;
};

export const updateMilestone = async (id, updates, user_id) => {
  const milestone = await db.oneOrNone(
    `UPDATE tbl_payment_milestone
     SET milestone_name = COALESCE($2, milestone_name),
         due_date = COALESCE($3, due_date),
         milestone_description = COALESCE($4, milestone_description),
         status = COALESCE($5, status),
         updated_by = $6,
         reminder_users = $7,
         attachments = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, updates.milestone_name, updates.due_date, updates.milestone_description, updates.status, user_id, updates.reminder_users, updates.attachments ? JSON.stringify(updates.attachments) : []]
  );

  return milestone;
};

export const deleteMilestone = async (id, user) => {
  const result = await db.oneOrNone(
    `UPDATE tbl_payment_milestone 
     SET status = 'deleted', updated_at = NOW(), updated_by = $2 
     WHERE id = $1 
     RETURNING *`,
    [id, user.id]
  );

  return result;
};

export const getTasksByPOId = async (company_id, po_id, page, limit) => {
  const offset = (page - 1) * limit;
  let condition = 'AND po_id = $1'

  const [pos, { total }] = await db.tx(async t => {
    const data = await t.any(
      `SELECT pot.id, 
        pot.rfq_id, 
        pot.po_id, 
        pot.company_id, 
        pot.task_name, 
        pot.completion_date::date, 
        pot.status, 
        pot.task_description
      FROM tbl_purchase_order_tasks pot
      WHERE company_id = $2 ${condition}
      ORDER BY completion_date DESC
      LIMIT $3 OFFSET $4`,
      [po_id, company_id, limit, offset]
    );

    const count = await t.one(
      `SELECT COUNT(*) AS total
        FROM tbl_purchase_order_tasks
        WHERE company_id = $2 ${condition}`,
      [po_id, company_id]
    );

    return [data, count]
  })

  return [pos, total]
};

export const createTask = async (data, user) => {
  const {
    rfq_id,
    po_id,
    task_name,
    completion_date,
    status,
    task_description,
  } = data;

  const task = await db.oneOrNone(
    `INSERT INTO tbl_purchase_order_tasks 
      (rfq_id, po_id, company_id, task_name, completion_date, task_description, status, created_by) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [rfq_id, po_id, user.company_id, task_name, completion_date, task_description, status, user.id]
  );

  return task;
};

export const updateTask = async (id, updates, user_id) => {
  const task = await db.oneOrNone(
    `UPDATE tbl_purchase_order_tasks
     SET task_name = COALESCE($2, task_name),
         completion_date = COALESCE($3, completion_date),
         task_description = COALESCE($4, task_description),
         status = COALESCE($5, status),
         updated_by = $6,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, updates.task_name, updates.completion_date, updates.task_description, updates.status, user_id]
  );

  return task;
};

export const deleteTask = async (id, user) => {
  const result = await db.oneOrNone(
    `DELETE FROM tbl_purchase_order_tasks 
      WHERE id = $1 
      RETURNING *`,
    [id, user.id]
  );

  return result;
};