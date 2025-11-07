import db from "../config/dbConn.js";
import seoController from "../controllers/seo/seoController.js";
import { AVAILABLE_HIERARCHY_TYPES, PO_STATUSES } from "../util/constants.js";
import generalModel, { markPOStatusChange, uploadToS3 } from "./generalModel.js";

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

const getItemTotalWOFreight = (item) => {
  const quantity = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const freightPrice = parseFloat(item.freight_price) || 0;
    const packagePrice = parseFloat(item.package_price) || 0;
    const tax = parseFloat(item.tax) || 0;
    
    // Base amount (unit_price * quantity)
    const baseAmount = unitPrice * quantity;

    let freightAmount = 0;
    if (item.freight_mode === 'percentage') {
      freightAmount = (freightPrice / 100) * baseAmount;
    } else {
      freightAmount = freightPrice; // flat amount
    }
    
    // Calculate package amount based on mode
    let packageAmount = 0;
    if (item.package_mode === 'percentage') {
      packageAmount = (packagePrice / 100) * baseAmount;
    } else {
      packageAmount = packagePrice; // flat amount
    }
    
    // Calculate subtotal before tax for this item
    const itemSubtotal = baseAmount + freightAmount + packageAmount;
    
    // Calculate tax amount based on mode
    let taxAmount = 0;
    if (item.tax_mode === 'percentage') {
      taxAmount = (tax / 100) * itemSubtotal;
    } else {
      taxAmount = tax; // flat amount
    }
    
    return (itemSubtotal + taxAmount) - freightAmount;
}

const getSingleItemTaxAmount = (item) => {
  const quantity = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const freightPrice = parseFloat(item.freight_price) || 0;
    const packagePrice = parseFloat(item.package_price) || 0;
    const tax = parseFloat(item.tax) || 0;
    
    // Base amount (unit_price * quantity)
    const baseAmount = unitPrice * quantity;
    
    // Calculate freight amount based on mode
    let freightAmount = 0;
    if (item.freight_mode === 'percentage') {
      freightAmount = (freightPrice / 100) * baseAmount;
    } else {
      freightAmount = freightPrice; // flat amount
    }
    
    // Calculate package amount based on mode
    let packageAmount = 0;
    if (item.package_mode === 'percentage') {
      packageAmount = (packagePrice / 100) * baseAmount;
    } else {
      packageAmount = packagePrice; // flat amount
    }
    
    // Calculate subtotal before tax for this item
    const itemSubtotal = baseAmount + freightAmount + packageAmount;
    
    // Calculate tax amount based on mode
    let taxAmount = 0;
    if (item.tax_mode === 'percentage') {
      taxAmount = (tax / 100) * itemSubtotal;
    } else {
      taxAmount = tax; // flat amount
    }
    
    return taxAmount;
}

function calculatePricing(items) {
  let subtotal = 0;
  let totalPrice = 0;
  let totalFreight = 0;
  
  // Calculate subtotal first (unit_price * quantity for all items)
  items.forEach(item => {
    const quantity = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unit_price) || 0;
    subtotal += unitPrice * quantity;
  });
  
  // Calculate total price with freight, package, and tax
  items.forEach(item => {
    const quantity = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const freightPrice = parseFloat(item.freight_price) || 0;
    const packagePrice = parseFloat(item.package_price) || 0;
    const tax = parseFloat(item.tax) || 0;
    
    // Base amount (unit_price * quantity)
    const baseAmount = unitPrice * quantity;
    
    // Calculate freight amount based on mode
    let freightAmount = 0;
    if (item.freight_mode === 'percentage') {
      freightAmount = (freightPrice / 100) * baseAmount;
    } else {
      freightAmount = freightPrice; // flat amount
    }

    totalFreight += freightAmount;
    
    // Calculate package amount based on mode
    let packageAmount = 0;
    if (item.package_mode === 'percentage') {
      packageAmount = (packagePrice / 100) * baseAmount;
    } else {
      packageAmount = packagePrice; // flat amount
    }
    
    // Calculate subtotal before tax for this item
    const itemSubtotal = baseAmount + freightAmount + packageAmount;
    
    // Calculate tax amount based on mode
    let taxAmount = 0;
    if (item.tax_mode === 'percentage') {
      taxAmount = (tax / 100) * itemSubtotal;
    } else {
      taxAmount = tax; // flat amount
    }
    
    // Add to total price
    totalPrice += itemSubtotal + taxAmount;
  });
  
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    taxAmount: parseFloat((totalPrice - subtotal).toFixed(2)),
    totalFreight: parseFloat(totalFreight.toFixed(2)),
  };
}

export const draftPurchaseOrder = async (rfq_id, project_id, quote_id, total_value, product_info, initiated_by, company_id, user, existing_po_id, t) => {
    try {
      const { rfq_product_id, quantity, unit_price, finalized_vendor_id } =
        product_info;

      // 1. Check if a pending PO already exists for this RFQ Product
      const existing = await t.oneOrNone(
        `SELECT id FROM tbl_rfq_purchase_order
      WHERE rfq_id = $1 AND $2 = ANY(rfq_product_id) AND status = $3`,
        [rfq_id, rfq_product_id, PO_STATUSES.PENDING_APPROVAL]
      );

      if (existing) {
        await t.none(
          `UPDATE tbl_rfq_purchase_order
          SET status = $3, updated_at = NOW()
          WHERE rfq_id = $1 AND $2 = ANY(rfq_product_id)`,
          [rfq_id, rfq_product_id, PO_STATUSES.CANCELLED]
        );
      }

      let po = null;

      if(existing_po_id) {
        if(!(await t.oneOrNone(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1`, [existing_po_id]))) 
          throw new Error("No Purchase Order found from id:", existing_po_id);

        po = await t.one(
          `UPDATE tbl_rfq_purchase_order 
            SET
              rfq_product_id = array_append(rfq_product_id, $1),
              quote_id = array_append(quote_id, $2),
              total_value = total_value + $3,
              quantity = quantity + $4,
              unit_price = unit_price + $5

            WHERE id = $6
            RETURNING id`,
          [
            rfq_product_id,
            quote_id,
            total_value,
            quantity,
            unit_price,
            existing_po_id
          ]
        );
      } else {
        // 2. Insert new PO record
        const poNumber = await getNextPONumber();
        po = await t.one(
          `INSERT INTO tbl_rfq_purchase_order (
            rfq_id, project_id, quote_id, po_number, total_value, rfq_product_id, quantity,
            unit_price, finalized_vendor_id, initiated_by, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id`,
          [
            rfq_id,
            project_id,
            [quote_id],
            poNumber,
            total_value,
            [rfq_product_id],
            quantity,
            unit_price,
            finalized_vendor_id,
            initiated_by,
            PO_STATUSES.DRAFT
          ]
        );
      }

      return {
        po_id: po.id,
        status: true,
        message: "PO has been drafted successfully!"
      };
    } catch (error) {
      throw error;
    }
};

export const initiatePurchaseOrder = async (po_id, initiator) => {
  try {
    return await db.tx(async t => {
      const purchaseOrder = await t.oneOrNone(
        `SELECT 
          PO.*, 
          TC.company_name,
          TC.cin,
          TC.gstin,
          TC.website,
          TC.location,
          TC.logo,
          FIN.mobile,
          JSON_BUILD_OBJECT(
            'id', SUP.id,
            'name', SUP.name,
            'email', SUP.email,
            'phone', SUP.mobile,
            'address', SUP.address,
            'gstin', TCSUP.gstin,
            'cin', TCSUP.cin
          ) AS supplier,
          JSON_BUILD_OBJECT(
            'id', TC.id,
            'name', TC.company_name,
            'email', FIN.email,
            'phone', FIN.mobile,
            'address', FIN.address,
            'logoUrl', TC.logo
          ) AS company,
          (
            SELECT CONCAT(
              MIN(CAST(TQI.delivery_period AS INTEGER)), ' - ', MAX(CAST(TQI.delivery_period AS INTEGER))
            )
            FROM tbl_quote_items TQI
            WHERE 
              TQI.id = ANY(PO.quote_id)
              AND TQI.delivery_period <> ''
          ) AS deliveryTerms

          FROM tbl_rfq_purchase_order PO
          JOIN tbl_users SUP ON SUP.id = PO.finalized_vendor_id
          JOIN tbl_users FIN ON FIN.id = PO.initiated_by
          JOIN tbl_company TCSUP ON TCSUP.id = SUP.company_id
          JOIN tbl_company TC ON TC.id = PO.company_id 

        WHERE PO.id = $1`,
        [po_id]
      );
  
      if(!purchaseOrder) {
        throw new Error("No Purchase Order found by id:", po_id);
      }
  
      const { rfq_id, project_id, total_value, rfq_product_id, quantity, unit_price, finalized_vendor_id } = purchaseOrder;
  
      // 3. Call Approval Logic
      const meta = {
        rfq_id,
        project_id,
        rfq_product_id,
        quantity,
        unit_price,
        finalized_vendor_id,
        total_value,
        po_id: purchaseOrder.id
      };
  
      const approvalResult = await generalModel.initiateApproval(
        AVAILABLE_HIERARCHY_TYPES.po.type,
        purchaseOrder.id,
        initiator.company_id,
        initiator.id,
        meta,
        {
          exist: `You cannot change the finalized vendor because an approved Purchase Order already exists for them.`
        },
        t,
      );
  
      // 4. If no further approval required → mark PO as approved
      if (!approvalResult.approval_required) {
        await markPOStatusChange(purchaseOrder.id, t, false, initiator);
      } else {
        await t.oneOrNone(
          `UPDATE tbl_rfq_purchase_order
          SET status = 'pending_approval'
          WHERE id = $1`,
          [po_id]
        );
      }

      const items = await getPOItemDetails(purchaseOrder)

      const pdfSaveResult = await seoController.poPDF({
        ...purchaseOrder,
        ...items
      });

      const s3Url = await uploadToS3(pdfSaveResult.absolutePath, `po-${purchaseOrder.po_number}.pdf`)
      await t.any(
        `UPDATE tbl_rfq_purchase_order
        SET po_pdf_url = $1
        WHERE id = $2`,
        [s3Url.url ?? `${process.env.APP_BASE_PATH}${pdfSaveResult.file}`, purchaseOrder.id]
      );
  
      return {
        po_id: purchaseOrder.id,
        approval_required: approvalResult.approval_required,
        current_approver_id: approvalResult.current_approver_id ?? null,
        poPdf: pdfSaveResult
      };
    })
  } catch (error) {
    throw error;
  }
};

export const getPOItemDetails = async (purchase_order) => {
  try {
    const { rfq_product_id, quote_id } = purchase_order;

    return await db.tx(async t => {
      const q = `
        SELECT 
          qi.unit_price,
          qi.package_price,
          qi.tax,
          qi.freight_price,
          qi.total_price,
          qi.comment,
          qi.delivery_period,
          qi.freight_mode,
          qi.package_mode,
          qi.tax_mode,
          pv.name as product_name,
          qi.quantity,
          (
            SELECT s.value
            FROM tbl_rfq_products_specs s
            WHERE s.rfq_id = qi.rfq_id
            AND s.product_variant_id = qi.product_variant_id
            AND s.variant = qi.variant
            AND s.title = 'Unit'
            LIMIT 1
          ) as unit

        FROM tbl_quote_items qi
        INNER JOIN tbl_product_variant pv ON qi.product_variant_id = pv.id
        WHERE qi.id = ANY($1)
        ORDER BY qi.id;
      `;
      let items = await t.any(q, [quote_id])

      items = items.map(i => ({
        ...i,
        taxAmount: getSingleItemTaxAmount(i),
        total_price: getItemTotalWOFreight(i)
      }))

      let prices = calculatePricing(items);
      prices.taxAmount = items.reduce((prev, cur) => prev + cur.taxAmount, 0);

      if(prices.totalFreight && prices.totalFreight > 0) {
        const freightItem = {
          unit_price: prices.totalFreight,
          package_price: 0,
          tax: 0,
          freight_price: 0,
          total_price: prices.totalFreight,
          comment: '',
          delivery_period: '',
          freight_mode: '',
          package_mode: '',
          tax_mode: '',
          product_name: 'Overall Freight Price',
          quantity: 'N/A',
        }
        items = [...items, freightItem]
      }

      return {
        items,
        ...prices
      }
    })
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

    const [pos, { total }, { approval_level }] = await db.tx(async t => {
      const dataQuery = `SELECT po.*,
                VENDOR.organization_name AS finalized_vendor_name,
                PRJ.name AS project_name,
                TU.name AS initiated_by,
                CASE WHEN trx.current_approver_id = $2 THEN TRUE ELSE FALSE END AS is_approver,
                COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                          'id', TPV.id,
                          'name', TPV.name
                      )
                  )
                  FROM tbl_rfq_products TRP
                  JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
                  WHERE TRP.id = ANY(po.rfq_product_id)
                ),
                '[]'::json
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
                    SELECT array_agg(
                            json_build_object(
                              'id',            PM.id,
                              'milestone_name',PM.milestone_name,
                              'milestone_description',PM.milestone_description,
                              'due_date',      PM.due_date,
                              'amount',        PM.amount,
                              'amount_mode',   PM.amount_mode
                            )
                            ORDER BY PM.due_date
                          )
                    FROM tbl_payment_milestone PM
                    WHERE PM.po_id   = PO.id
                      AND NOT PM.is_done
                      AND PM.due_date > NOW()
                ) AS upcoming_milestones
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_projects PRJ ON PRJ.id = PO.project_id
         LEFT JOIN tbl_approval_hierarchy_transactions trx
           ON trx.hierarchy_type = 'po'
           AND trx.target_entity_id = po.id
        JOIN tbl_users TU ON TU.id = po.initiated_by
        JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
         ${whereClause}
         ORDER BY po.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`

      let data = await t.any(dataQuery,
        [...values, limit, offset]
      );

      data = data.map(d => ({
        ...d,
        poPdfUrl: d.po_pdf_url
      }))

      const count = await t.one(
        `SELECT COUNT(*) AS total
         FROM tbl_rfq_purchase_order po
         ${whereClause}`,
        values
      );

      const approverLevel = await t.oneOrNone(
        `SELECT approval_level FROM tbl_approval_hierarchy TAH
         WHERE user_id = $1 AND hierarchy_type = 'po'`,
         [user_id]
      )

      return [data, count, approverLevel || -1];
    });

    return {
      data: pos,
      page,
      limit,
      total: parseInt(total, 10),
      totalPages: Math.ceil(total / limit),
      approval_level,
    };
  } catch (error) {
    throw error;
  }
};

export const getPODetailsById = async (po_id, user_id) => {
  try {
    let result = await db.oneOrNone(
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
              COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                          'id', TPV.id,
                          'name', TPV.name,
                          'product_id', TPV.product_id
                      )
                  )
                  FROM tbl_rfq_products TRP
                  JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
                  WHERE TRP.id = ANY(po.rfq_product_id)
                ),
                '[]'::json
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
            ) AS tasks,
            (
                SELECT array_agg(
                    json_build_object(
                      'id',            TQ.id,
                      'quote_id', TQuotes.id,
                      'vendor_name', TUser.name,
                      'unit_price', TQ.unit_price,
                      'package_price', TQ.package_price,
                      'freight_price',      TQ.freight_price,
                      'tax',        TQ.tax,
                      'freight_mode', TQ.freight_mode,
                      'package_mode', TQ.package_mode,
                      'tax_mode', TQ.tax_mode,
                      'comment',   TQ.comment,
                      'delivery_period', TQ.delivery_period
                    )
                )

                FROM tbl_quote_items TQ
                JOIN tbl_quotes TQuotes ON TQ.quote_id = TQuotes.id
                JOIN tbl_users TUser ON TUser.id = TQuotes.created_by
                JOIN tbl_rfq_products TRP ON TRP.id = ANY(po.rfq_product_id)
                WHERE PO.rfq_id   = TQ.rfq_id
                  AND TQ.product_variant_id = TRP.product_variant_id
                  AND TQ.variant = TRP.variant
            ) AS quotations

       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_approval_hierarchy_transactions trx
         ON trx.hierarchy_type = 'po'
         AND trx.target_entity_id = po.id
       LEFT JOIN tbl_projects PD ON PD.id = po.project_id
       LEFT JOIN tbl_users trx_user ON trx_user.id = trx.current_approver_id
       JOIN tbl_users TU ON TU.id = po.initiated_by
       JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
       LEFT JOIN tbl_users LOGGED_IN_USER ON LOGGED_IN_USER.id = $2
       WHERE po.id = $1`,
      [po_id, user_id]
    );

    return { ...result, poPdfUrl: result.po_pdf_url };
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