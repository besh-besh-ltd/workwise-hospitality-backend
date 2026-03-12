import db from '../config/dbConn.js';

/**
 * Build complete data object for PO template rendering
 * Fetches all required data including approval history
 *
 * @param {number} po_id - Purchase Order ID
 * @returns {Object} - Complete data object for template rendering
 */
export const buildPOTemplateData = async (po_id, txContext = null) => {
  const conn = txContext || db;
  // 1. Get PO with all related data
  const poData = await conn.oneOrNone(`
    SELECT
      PO.*,
      PO.initiated_by,
      INITIATOR.name AS prepared_by_name,

      -- RFQ Details
      RFQ.id AS rfq_id,
      RFQ.rfq_no,
      RFQ.title AS rfq_title,
      RFQ.hospitality_company_id,
      RFQ.hotel_id,

      -- Project
      PROJ.name AS project_name,

      -- Finalized Quote
      TQ.id AS quote_id,
      TQ.gstin AS quote_gstin,

      -- Buyer Company
      TC.company_name,
      TC.cin AS buyer_cin,
      TC.gstin AS buyer_gstin,
      TC.logo AS company_logo,

      -- Hospitality Company (if applicable)
      THC.name AS hospitality_company_name,

      -- Hotel (if applicable)
      THCH.name AS hotel_name,
      THCH.full_address AS hotel_address,
      THCH.gst AS hotel_gstin,

      -- Delivery Location
      COALESCE(RFQ.location, TCL.address) AS delivery_location,
      TCL.address AS buyer_address

    FROM tbl_rfq_purchase_order PO
    JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
    LEFT JOIN tbl_users INITIATOR ON INITIATOR.id = PO.initiated_by
    LEFT JOIN tbl_projects PROJ ON PROJ.id = RFQ.project_id
    LEFT JOIN tbl_quotes TQ ON TQ.created_by = PO.finalized_vendor_id AND TQ.rfq_id = PO.rfq_id
    LEFT JOIN tbl_company TC ON TC.id = PO.company_id
    LEFT JOIN tbl_hospitality_companies THC ON THC.id = RFQ.hospitality_company_id
    LEFT JOIN tbl_hospitality_company_hotels THCH ON THCH.id = RFQ.hotel_id
    LEFT JOIN tbl_company_location TCL ON TCL.company_id = TC.id
    WHERE PO.id = $1
  `, [po_id]);

  if (!poData) {
    throw new Error(`PO ${po_id} not found`);
  }

  // 2. Get Supplier/Vendor details (including state for tax calculation)
  const supplier = await conn.oneOrNone(`
    SELECT
      U.id, U.name, U.email, U.mobile AS phone,
      TC.company_name AS organization_name,
      TC.gstin, TC.cin,
      TCL.address,
      TLS.state_name AS supplier_state
    FROM tbl_users U
    LEFT JOIN tbl_company TC ON TC.id = U.company_id
    LEFT JOIN tbl_company_location TCL ON TCL.company_id = TC.id
    LEFT JOIN tbl_location_states TLS ON TCL.state_id = TLS.id
    WHERE U.id = $1
    ORDER BY TCL.created_at DESC
    LIMIT 1
  `, [poData.finalized_vendor_id]);

  // Get buyer state for tax calculation
  const buyerLocation = await conn.oneOrNone(`
    SELECT TLS.state_name AS state FROM tbl_company_location TCL
    JOIN tbl_location_states TLS ON TCL.state_id = TLS.id
    WHERE TCL.company_id = $1
    ORDER BY TCL.created_at DESC LIMIT 1
  `, [poData.company_id]);

  // 3. Get PO Items with product details
  // Note: tax, freight_price, package_price are stored in charges_meta JSONB column
  // Size and Spec come from tbl_rfq_products_specs filtered by title
  // HSN code comes from tbl_purchase_order_hsn_mapping
  const items = await conn.any(`
    SELECT
      POP.quantity,
      POP.unit,
      POP.unit_price,
      POP.total_price,
      -- Extract charges from JSONB charges_meta column
      COALESCE((POP.charges_meta->>'tax')::numeric, 0) AS tax,
      POP.charges_meta->>'tax_mode' AS tax_mode,
      COALESCE((POP.charges_meta->>'freight_price')::numeric, 0) AS freight_price,
      POP.charges_meta->>'freight_mode' AS freight_mode,
      COALESCE((POP.charges_meta->>'package_price')::numeric, 0) AS package_price,
      POP.charges_meta->>'package_mode' AS package_mode,
      PV.name AS product_name,
      -- HSN code from mapping table
      POHM.hsn_code,
      -- Size from specs table (title = 'Size')
      RPS_SIZE.value AS size,
      -- Specification from specs table (title = 'Spec')
      RPS_SPEC.value AS specification
    FROM tbl_purchase_order_product POP
    JOIN tbl_rfq_products RP ON RP.id = POP.rfq_product_id
    JOIN tbl_product_variant PV ON PV.id = RP.product_variant_id
    -- HSN mapping
    LEFT JOIN tbl_purchase_order_hsn_mapping POHM ON POHM.rfq_item_id = POP.rfq_product_id
    -- Size from specs
    LEFT JOIN tbl_rfq_products_specs RPS_SIZE ON
      RPS_SIZE.product_variant_id = RP.product_variant_id
      AND RPS_SIZE.variant = RP.variant
      AND RPS_SIZE.rfq_id = RP.rfq_id
      AND RPS_SIZE.title = 'Size'
    -- Specification from specs
    LEFT JOIN tbl_rfq_products_specs RPS_SPEC ON
      RPS_SPEC.product_variant_id = RP.product_variant_id
      AND RPS_SPEC.variant = RP.variant
      AND RPS_SPEC.rfq_id = RP.rfq_id
      AND RPS_SPEC.title = 'Spec'
    WHERE POP.purchase_order_id = $1
    ORDER BY POP.id
  `, [po_id]);

  // 4. Calculate pricing with tax breakdown (state-based SGST/CGST vs IGST)
  const buyerState = buyerLocation?.state;
  const supplierState = supplier?.supplier_state;
  const pricing = calculatePricingBreakdown(items, buyerState, supplierState);

  // 5. Get Payment Terms from Quote
  const paymentTermsList = await conn.any(`
    SELECT type, value, days, comment
    FROM tbl_quotes_payment_terms
    WHERE quote_id = $1
    ORDER BY id
  `, [poData.quote_id]);

  // 6. Get RFQ Terms (via junction table tbl_rfq_terms_map)
  const rfqTerms = await conn.any(`
    SELECT RT.id, RT.term_content
    FROM tbl_rfq_terms_map RTM
    JOIN tbl_rfq_terms RT ON RT.id = RTM.terms_id
    WHERE RTM.rfq_id = $1
    ORDER BY RTM.id
  `, [poData.rfq_id]);

  // 7. Get Approval Data
  const approvalData = await getApprovalDataForPO(po_id, poData, conn);

  // 8. Build final template data
  return {
    // Header
    project_name: poData.project_name,
    rfq_title: poData.rfq_title,
    rfq_no: poData.rfq_no,

    // Supplier
    supplier: {
      name: supplier?.organization_name || supplier?.name,
      address: supplier?.address,
      gstin: supplier?.gstin || poData.quote_gstin,
      cin: supplier?.cin,
      phone: supplier?.phone,
      email: supplier?.email
    },

    // PO Meta
    po_number: poData.po_number,
    created_at: poData.created_at,  // Raw date - seoController.js handles formatting

    // Items with calculated fields
    items: items.map(item => ({
      ...item,
      basic_amount: (item.unit_price * item.quantity).toFixed(2)
    })),

    // Pricing Breakdown
    ...pricing,

    // Delivery & Location
    delivery_location: poData.delivery_location,
    location: poData.buyer_address,
    company_name: poData.hospitality_company_name || poData.company_name,
    company: {
      address: poData.buyer_address
    },
    buyer_business_unit_name: poData.hotel_name,
    gstin: poData.hotel_gstin || poData.buyer_gstin,

    // Terms
    deliveryterms: poData.delivery_period,
    paymentTermsList,
    rfqTerms,

    // Approval Section
    isAutoPublished: approvalData.isAutoPublished,
    rfqCreatorName: approvalData.rfqCreatorName,
    rfqApproverName: approvalData.rfqApproverName,
    techEvaluations: approvalData.techEvaluations,
    commercialEvaluations: approvalData.commercialEvaluations,
    poApprovers: approvalData.poApprovers
  };
};

/**
 * Calculate pricing breakdown with SGST/CGST/IGST
 * Uses state comparison: Same state = CGST+SGST, Different state = IGST
 *
 * @param {Array} items - PO items
 * @param {string} buyerState - Buyer's state
 * @param {string} supplierState - Supplier's state
 * @returns {Object} - Pricing breakdown object
 */
const calculatePricingBreakdown = (items, buyerState, supplierState) => {
  let basicAmount = 0;
  let totalFreight = 0;
  let totalPackage = 0;
  let totalTax = 0;

  items.forEach(item => {
    const itemBasic = item.unit_price * item.quantity;
    basicAmount += itemBasic;

    // Calculate freight for this item (percentage or actual)
    let itemFreight = 0;
    const freightValue = Number(item.freight_price) || 0;
    if (item.freight_mode === 'percentage') {
      itemFreight = (itemBasic * freightValue) / 100;
    } else {
      itemFreight = freightValue;
    }
    totalFreight += itemFreight;

    // Calculate package for this item (percentage or actual)
    let itemPackage = 0;
    const packageValue = Number(item.package_price) || 0;
    if (item.package_mode === 'percentage') {
      itemPackage = (itemBasic * packageValue) / 100;
    } else {
      itemPackage = packageValue;
    }
    totalPackage += itemPackage;

    // Calculate tax on (basic + freight + package) for this item
    // Tax is applied AFTER freight and package are added to the base price
    const itemSubtotal = itemBasic + itemFreight + itemPackage;
    const taxValue = Number(item.tax) || 0;
    if (item.tax_mode === 'percentage' || !item.tax_mode) {
      // Default to percentage if mode not specified
      totalTax += (itemSubtotal * taxValue) / 100;
    } else {
      totalTax += taxValue;
    }
  });

  // Determine tax type based on state comparison
  const isSameState = buyerState && supplierState &&
    buyerState.toLowerCase().trim() === supplierState.toLowerCase().trim();

  const taxPercent = basicAmount > 0 ? (totalTax / basicAmount) * 100 : 0;

  if (isSameState) {
    // Intra-state: Split into CGST + SGST (equal halves)
    const halfTax = totalTax / 2;
    const halfPercent = taxPercent / 2;
    return {
      basicAmount: basicAmount.toFixed(2),
      totalFreight: totalFreight > 0 ? totalFreight.toFixed(2) : null,
      totalPackage: totalPackage > 0 ? totalPackage.toFixed(2) : null,
      sgstAmount: halfTax > 0 ? halfTax.toFixed(2) : null,
      sgstPercent: halfPercent > 0 ? halfPercent.toFixed(1) : null,
      cgstAmount: halfTax > 0 ? halfTax.toFixed(2) : null,
      cgstPercent: halfPercent > 0 ? halfPercent.toFixed(1) : null,
      igstAmount: null,
      igstPercent: null,
      totalPrice: (basicAmount + totalFreight + totalPackage + totalTax).toFixed(2)
    };
  } else {
    // Inter-state: Use IGST only
    return {
      basicAmount: basicAmount.toFixed(2),
      totalFreight: totalFreight > 0 ? totalFreight.toFixed(2) : null,
      totalPackage: totalPackage > 0 ? totalPackage.toFixed(2) : null,
      sgstAmount: null,
      sgstPercent: null,
      cgstAmount: null,
      cgstPercent: null,
      igstAmount: totalTax > 0 ? totalTax.toFixed(2) : null,
      igstPercent: taxPercent > 0 ? taxPercent.toFixed(1) : null,
      totalPrice: (basicAmount + totalFreight + totalPackage + totalTax).toFixed(2)
    };
  }
};

/**
 * Deduplicate evaluation entries by product name.
 * Merges evaluators and approvers when the same product appears in multiple instances.
 */
const deduplicateByProduct = (evaluations) => {
  const byProduct = new Map();
  for (const e of evaluations) {
    const key = e.productName || 'Unknown';
    if (!byProduct.has(key)) {
      byProduct.set(key, { productName: key, evaluators: new Set(), approvers: new Set() });
    }
    const entry = byProduct.get(key);
    if (e.evaluatorName) entry.evaluators.add(e.evaluatorName);
    for (const a of e.approvers) entry.approvers.add(a.name);
  }
  return Array.from(byProduct.values()).map(e => ({
    productName: e.productName,
    evaluators: Array.from(e.evaluators),
    approvers: Array.from(e.approvers)
  }));
};

/**
 * Get approval data for PO template
 * Fetches technical evaluator, commercial evaluator, and PO approvers
 *
 * @param {number} po_id - Purchase Order ID
 * @param {Object} poData - PO data object
 * @returns {Object} - Approval data object
 */
const getApprovalDataForPO = async (po_id, poData, conn = db) => {
  const result = {
    // Created By section: RFQ creator + RFQ publishing approver
    rfqCreatorName: null,
    rfqApproverName: null,
    isAutoPublished: false,
    // Technical Evaluation section: per-product evaluators + approvers
    techEvaluations: [],
    // Commercial Evaluation section: per-product evaluators + approvers
    commercialEvaluations: [],
    poApprovers: []
  };

  // 1. Get RFQ creator
  const rfqCreator = await conn.oneOrNone(`
    SELECT U.name, R.created_by
    FROM tbl_rfq R
    JOIN tbl_users U ON U.id = R.created_by
    WHERE R.id = $1
  `, [poData.rfq_id]);
  if (rfqCreator) {
    result.rfqCreatorName = rfqCreator.name;
  }

  // 2. Check if RFQ was auto-published or has an approval flow
  const rfqApproval = await conn.oneOrNone(`
    SELECT AI.id, AI.status
    FROM tbl_approval_instances AI
    WHERE AI.entity_type IN ('RFQ', 'TENDER')
      AND AI.entity_id = $1
    ORDER BY AI.created_at DESC
    LIMIT 1
  `, [poData.rfq_id]);

  if (!rfqApproval) {
    // No approval instance = auto-published
    result.isAutoPublished = true;
  } else {
    // Get the final approver for RFQ publishing
    const rfqFinalApprover = await conn.oneOrNone(`
      SELECT U.name
      FROM tbl_approval_actions AA
      JOIN tbl_approval_instance_steps AIS ON AIS.id = AA.approval_instance_step_id
      JOIN tbl_users U ON U.id = AA.approver_user_id
      WHERE AIS.approval_instance_id = $1
        AND AA.action = 'APPROVE'
      ORDER BY AA.created_at DESC
      LIMIT 1
    `, [rfqApproval.id]);
    if (rfqFinalApprover) {
      result.rfqApproverName = rfqFinalApprover.name;
    }
  }

  // 3. Get Technical Evaluations - all approved TECHNICAL instances for this RFQ
  // Note: TECHNICAL instances store entity_id = round.id, not rfq_id.
  // The rfq_id is in metadata->>'rfq_id'.
  if (poData.rfq_id) {
    const techInstances = await conn.any(`
      SELECT AI.id, AI.initiated_by,
             AI.metadata->>'product_name' AS product_name,
             U.name AS evaluator_name
      FROM tbl_approval_instances AI
      JOIN tbl_users U ON U.id = AI.initiated_by
      WHERE AI.entity_type = 'TECHNICAL'
        AND AI.metadata->>'rfq_id' = $1::text
        AND AI.status = 'APPROVED'
      ORDER BY AI.created_at
    `, [poData.rfq_id]);

    for (const inst of techInstances) {
      const approvers = await conn.any(`
        SELECT U.name
        FROM tbl_approval_actions AA
        JOIN tbl_approval_instance_steps AIS ON AIS.id = AA.approval_instance_step_id
        JOIN tbl_users U ON U.id = AA.approver_user_id
        WHERE AIS.approval_instance_id = $1
          AND AA.action = 'APPROVE'
        ORDER BY AIS.step_order, AA.created_at
      `, [inst.id]);

      result.techEvaluations.push({
        productName: inst.product_name || 'Unknown',
        evaluatorName: inst.evaluator_name,
        approvers: approvers.map(a => ({ name: a.name }))
      });
    }
  }

  // 4. Get Commercial/Negotiation - all approved instances for this RFQ
  if (poData.rfq_id) {
    const commercialInstances = await conn.any(`
      SELECT AI.id, AI.initiated_by, AI.entity_type,
             AI.metadata->>'rfq_product_id' AS rfq_product_id,
             U.name AS evaluator_name
      FROM tbl_approval_instances AI
      JOIN tbl_users U ON U.id = AI.initiated_by
      WHERE AI.entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
        AND AI.metadata->>'rfq_id' = $1::text
        AND AI.status = 'APPROVED'
      ORDER BY AI.created_at
    `, [poData.rfq_id]);

    const rawCommercial = [];
    for (const inst of commercialInstances) {
      // Resolve product name from rfq_product_id in metadata
      let productName = 'Unknown';
      if (inst.rfq_product_id) {
        const product = await conn.oneOrNone(`
          SELECT PV.name AS product_name
          FROM tbl_rfq_products RP
          JOIN tbl_product_variant PV ON PV.id = RP.product_variant_id
          WHERE RP.id = $1
        `, [inst.rfq_product_id]);
        if (product) productName = product.product_name;
      }

      const approvers = await conn.any(`
        SELECT U.name
        FROM tbl_approval_actions AA
        JOIN tbl_approval_instance_steps AIS ON AIS.id = AA.approval_instance_step_id
        JOIN tbl_users U ON U.id = AA.approver_user_id
        WHERE AIS.approval_instance_id = $1
          AND AA.action = 'APPROVE'
        ORDER BY AIS.step_order, AA.created_at
      `, [inst.id]);

      rawCommercial.push({
        productName,
        evaluatorName: inst.evaluator_name,
        approvers: approvers.map(a => ({ name: a.name }))
      });
    }

    result.commercialEvaluations = deduplicateByProduct(rawCommercial);
  }

  // Also deduplicate tech evaluations
  if (result.techEvaluations.length > 0) {
    result.techEvaluations = deduplicateByProduct(result.techEvaluations);
  }

  // 5. Get PO Approvers - ALL approvers with their status
  if (poData.approval_instance_id) {
    // New approval workflow - get all steps with their approvers
    const stepsWithApprovers = await conn.any(`
      SELECT
        AIS.id AS step_id,
        AIS.step_order,
        AIS.decision_rule,
        AIS.status AS step_status,
        AIS.completed_at AS step_completed_at,
        SA.approver_user_id,
        SA.status AS approver_status,
        SA.acted_at,
        U.name,
        U.designation
      FROM tbl_approval_instance_steps AIS
      JOIN tbl_approval_step_approvers SA ON SA.approval_instance_step_id = AIS.id
      JOIN tbl_users U ON U.id = SA.approver_user_id
      WHERE AIS.approval_instance_id = $1
      ORDER BY AIS.step_order, SA.id
    `, [poData.approval_instance_id]);

    // Process approvers with display status
    result.poApprovers = stepsWithApprovers.map(approver => {
      let displayStatus;
      let timestamp = null;

      if (approver.approver_status === 'APPROVED') {
        displayStatus = 'Approved';
        timestamp = formatTimestamp(approver.acted_at);
      } else if (approver.approver_status === 'REJECTED') {
        displayStatus = 'Rejected';
        timestamp = formatTimestamp(approver.acted_at);
      } else if (approver.approver_status === 'PENDING') {
        // Check if this approver was "skipped" due to ANY rule
        if (approver.step_status === 'APPROVED' && approver.decision_rule === 'ANY') {
          displayStatus = 'Skipped';
          timestamp = formatTimestamp(approver.step_completed_at);
        } else {
          displayStatus = 'Invited';
        }
      } else {
        displayStatus = approver.approver_status || 'Unknown';
      }

      return {
        step_order: approver.step_order,
        name: approver.name,
        designation: approver.designation,
        status: displayStatus,
        timestamp: timestamp
      };
    });
  } else {
    // Legacy approval workflow - get all approvers from hierarchy
    const txn = await conn.oneOrNone(`
      SELECT id, hierarchy_id, status AS txn_status
      FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = 'po' AND target_entity_id = $1
    `, [po_id]);

    if (txn) {
      // Get all approvers in the hierarchy with their action status
      const hierarchyApprovers = await conn.any(`
        SELECT
          AH.approval_level AS step_order,
          AH.user_id,
          U.name,
          U.designation,
          H.decision AS action,
          H.created_at AS acted_at
        FROM tbl_approval_hierarchy AH
        JOIN tbl_users U ON U.id = AH.user_id
        LEFT JOIN tbl_approval_hierarchy_history H ON H.approver_id = AH.user_id
          AND H.transaction_id = $1
        WHERE AH.hierarchy_id = $2
          AND AH.is_active = true
        ORDER BY AH.approval_level, AH.id
      `, [txn.id, txn.hierarchy_id]);

      result.poApprovers = hierarchyApprovers.map(approver => {
        let displayStatus;
        let timestamp = null;

        if (approver.action && approver.action.toLowerCase() === 'approved') {
          displayStatus = 'Approved';
          timestamp = formatTimestamp(approver.acted_at);
        } else if (approver.action && approver.action.toLowerCase() === 'rejected') {
          displayStatus = 'Rejected';
          timestamp = formatTimestamp(approver.acted_at);
        } else {
          // No action taken - check if txn is completed (approved/rejected)
          if (txn.txn_status === 'approved' || txn.txn_status === 'rejected') {
            displayStatus = 'Skipped';
          } else {
            displayStatus = 'Invited';
          }
        }

        return {
          step_order: approver.step_order,
          name: approver.name,
          designation: approver.designation,
          status: displayStatus,
          timestamp: timestamp
        };
      });
    }
  }

  return result;
};

/**
 * Format timestamp for display in PO template
 * @param {Date|string} date - Date to format
 * @returns {string|null} - Formatted timestamp or null
 */
const formatTimestamp = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;

  // Format: DD/MM/YYYY - HH:MM AM/PM
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12

  return `${day}/${month}/${year} - ${hours}:${minutes} ${ampm}`;
};

