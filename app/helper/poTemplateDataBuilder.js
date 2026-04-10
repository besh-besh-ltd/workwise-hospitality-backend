import db from '../config/dbConn.js';
import { formatCompanyLocationDisplay } from './companyLocation.js';
import { buildPOTemplatePricing, resolvePOTaxMode } from './poTemplatePricing.js';

const getLatestCompanyLocation = async (conn, companyId) => {
  if (!companyId) return null;

  return conn.oneOrNone(
    `
      SELECT
        TCL.id,
        TCL.company_id,
        TCL.address,
        TCL.postal_code,
        TCL.country_id,
        LCO.country_name,
        TCL.state_id,
        TLS.state_name,
        TCL.city_id,
        TLC.city_name
      FROM tbl_company_location TCL
      LEFT JOIN tbl_location_country LCO ON LCO.id = TCL.country_id
      LEFT JOIN tbl_location_states TLS ON TLS.id = TCL.state_id
      LEFT JOIN tbl_location_cities TLC ON TLC.id = TCL.city_id
      WHERE TCL.company_id = $1
      ORDER BY COALESCE(TCL.created_at, TCL.updated_at) DESC, TCL.id DESC
      LIMIT 1
    `,
    [companyId]
  );
};

const buildDeliveryTermsLabel = (items = []) => {
  const deliveryPeriods = items
    .map((item) => Number.parseInt(item.delivery_period, 10))
    .filter((value) => !Number.isNaN(value));

  if (!deliveryPeriods.length) return null;

  const minValue = Math.min(...deliveryPeriods);
  const maxValue = Math.max(...deliveryPeriods);

  return minValue === maxValue ? String(minValue) : `${minValue} - ${maxValue}`;
};

/**
 * Build complete data object for PO template rendering
 * Fetches all required data including approval history
 *
 * @param {number} po_id - Purchase Order ID
 * @returns {Object} - Complete data object for template rendering
 */
export const buildPOTemplateData = async (po_id, txContext = null) => {
  const conn = txContext || db;

  const poData = await conn.oneOrNone(`
    SELECT
      PO.*,
      PO.initiated_by,
      INITIATOR.name AS prepared_by_name,
      RFQ.id AS rfq_id,
      RFQ.rfq_no,
      RFQ.title AS rfq_title,
      RFQ.comment AS rfq_comment,
      RFQ.hospitality_company_id,
      RFQ.hotel_id,
      PROJ.name AS project_name,
      POQ.id AS source_quote_id,
      POQ.gstin AS quote_gstin,
      POQ.global_comment,
      TC.company_name,
      TC.cin AS buyer_cin,
      TC.gstin AS buyer_gstin,
      TC.logo AS company_logo,
      TC.location AS buyer_legacy_location,
      THC.name AS hospitality_company_name,
      THCH.name AS hotel_name,
      THCH.full_address AS hotel_address,
      THCH.gst AS hotel_gstin,
      RFQ.location AS rfq_delivery_location

    FROM tbl_rfq_purchase_order PO
    JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
    LEFT JOIN tbl_users INITIATOR ON INITIATOR.id = PO.initiated_by
    LEFT JOIN tbl_projects PROJ ON PROJ.id = RFQ.project_id
    LEFT JOIN LATERAL (
      SELECT TQ.id, TQ.gstin, TQ.global_comment
      FROM tbl_purchase_order_product POP_Q
      JOIN tbl_quote_items TQI ON TQI.id = POP_Q.quote_id
      JOIN tbl_quotes TQ ON TQ.id = TQI.quote_id
      WHERE POP_Q.purchase_order_id = PO.id
      ORDER BY TQ.timestamp DESC, TQ.id DESC
      LIMIT 1
    ) POQ ON TRUE
    LEFT JOIN tbl_company TC ON TC.id = PO.company_id
    LEFT JOIN tbl_hospitality_companies THC ON THC.id = RFQ.hospitality_company_id
    LEFT JOIN tbl_hospitality_company_hotels THCH ON THCH.id = RFQ.hotel_id
    WHERE PO.id = $1
  `, [po_id]);

  if (!poData) {
    throw new Error(`PO ${po_id} not found`);
  }

  const supplier = await conn.oneOrNone(`
    SELECT
      U.id,
      U.company_id,
      U.name,
      U.email,
      U.mobile AS phone,
      TC.company_name AS organization_name,
      TC.gstin,
      TC.cin,
      TC.location AS legacy_address
    FROM tbl_users U
    LEFT JOIN tbl_company TC ON TC.id = U.company_id
    WHERE U.id = $1
    LIMIT 1
  `, [poData.finalized_vendor_id]);

  const [buyerLocation, supplierLocation] = await Promise.all([
    getLatestCompanyLocation(conn, poData.company_id),
    getLatestCompanyLocation(conn, supplier?.company_id)
  ]);

  const items = await conn.any(`
    SELECT
      POP.id,
      POP.quote_id AS quote_item_id,
      POP.quantity,
      POP.unit,
      POP.unit_price,
      POP.total_price,
      COALESCE((POP.charges_meta->>'tax')::numeric, 0) AS tax,
      POP.charges_meta->>'tax_mode' AS tax_mode,
      COALESCE((POP.charges_meta->>'freight_price')::numeric, 0) AS freight_price,
      POP.charges_meta->>'freight_mode' AS freight_mode,
      COALESCE((POP.charges_meta->>'package_price')::numeric, 0) AS package_price,
      POP.charges_meta->>'package_mode' AS package_mode,
      PV.name AS product_name,
      POHM.hsn_code,
      RPS_SIZE.value AS size,
      RPS_SPEC.value AS specification,
      QI.comment,
      QI.delivery_period
    FROM tbl_purchase_order_product POP
    JOIN tbl_rfq_products RP ON RP.id = POP.rfq_product_id
    JOIN tbl_product_variant PV ON PV.id = RP.product_variant_id
    LEFT JOIN tbl_purchase_order_hsn_mapping POHM ON POHM.rfq_item_id = POP.rfq_product_id
    LEFT JOIN tbl_rfq_products_specs RPS_SIZE ON
      RPS_SIZE.product_variant_id = RP.product_variant_id
      AND RPS_SIZE.variant = RP.variant
      AND RPS_SIZE.rfq_id = RP.rfq_id
      AND RPS_SIZE.title = 'Size'
    LEFT JOIN tbl_rfq_products_specs RPS_SPEC ON
      RPS_SPEC.product_variant_id = RP.product_variant_id
      AND RPS_SPEC.variant = RP.variant
      AND RPS_SPEC.rfq_id = RP.rfq_id
      AND RPS_SPEC.title = 'Spec'
    LEFT JOIN tbl_quote_items QI ON QI.id = POP.quote_id
    WHERE POP.purchase_order_id = $1
    ORDER BY POP.id
  `, [po_id]);

  const taxMode = resolvePOTaxMode(buyerLocation, supplierLocation);
  const pricing = buildPOTemplatePricing(items, taxMode);
  const buyerAddress = formatCompanyLocationDisplay(buyerLocation, poData.buyer_legacy_location);
  const supplierAddress = formatCompanyLocationDisplay(supplierLocation, supplier?.legacy_address);

  const paymentTermsList = poData.source_quote_id
    ? await conn.any(`
        SELECT type, value, days, comment
        FROM tbl_quotes_payment_terms
        WHERE quote_id = $1
        ORDER BY id
      `, [poData.source_quote_id])
    : [];

  const rfqTerms = await conn.any(`
    SELECT RT.id, RT.term_content
    FROM tbl_rfq_terms_map RTM
    JOIN tbl_rfq_terms RT ON RT.id = RTM.terms_id
    WHERE RTM.rfq_id = $1
    ORDER BY RTM.id
  `, [poData.rfq_id]);

  // 6a. Parse the rfq.comment HTML and merge into rfqTerms.
  //  - Starts with list (no preceding text) → flatten each <li> as its own row
  //  - Plain text (no list)                 → one numbered row
  //  - Text then list                       → text is the row, list nests under it
  //  - Trailing text after a list           → next numbered row
  if (poData.rfq_comment) {
    const html = poData.rfq_comment.trim();

    // Split into ordered segments: { type: 'text'|'list', html }
    const segments = [];
    const listBlockRegex = /<(ul|ol)[^>]*>[\s\S]*?<\/\1>/gi;
    let lastIndex = 0;
    let blockMatch;
    while ((blockMatch = listBlockRegex.exec(html)) !== null) {
      const before = html.substring(lastIndex, blockMatch.index).trim();
      if (before) segments.push({ type: 'text', html: before });
      segments.push({ type: 'list', html: blockMatch[0] });
      lastIndex = blockMatch.index + blockMatch[0].length;
    }
    const trailing = html.substring(lastIndex).trim();
    if (trailing) segments.push({ type: 'text', html: trailing });

    // Walk segments and build rfqTerms entries
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      if (seg.type === 'text') {
        const next = segments[i + 1];
        if (next && next.type === 'list') {
          // Text + list → merge into one row; convert <ul> to <ol> for numbering
          const numberedList = next.html
            .replace(/<ul([^>]*)>/gi, '<ol$1>')
            .replace(/<\/ul>/gi, '</ol>');
          rfqTerms.push({ id: null, term_content: seg.html + numberedList });
          i++; // skip the list segment
        } else {
          rfqTerms.push({ id: null, term_content: seg.html });
        }
      } else {
        // List without preceding text → flatten each <li>
        const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let liMatch;
        while ((liMatch = liRegex.exec(seg.html)) !== null) {
          const inner = liMatch[1].trim();
          if (inner) rfqTerms.push({ id: null, term_content: inner });
        }
      }
    }
  }

  const approvalData = await getApprovalDataForPO(po_id, poData, conn);

  return {
    project_name: poData.project_name,
    rfq_title: poData.rfq_title,
    rfq_no: poData.rfq_no,
    supplier: {
      name: supplier?.organization_name || supplier?.name,
      address: supplierAddress,
      gstin: poData.quote_gstin || supplier?.gstin,
      cin: supplier?.cin,
      phone: supplier?.phone,
      email: supplier?.email,
      state_name: supplierLocation?.state_name || null
    },
    po_number: poData.po_number,
    created_at: poData.created_at,
    items: pricing.items,
    ...pricing,
    tax_mode: taxMode,
    delivery_location: poData.rfq_delivery_location || buyerAddress,
    location: buyerAddress,
    company_name: poData.hospitality_company_name || poData.company_name,
    company: {
      address: buyerAddress
    },
    buyer: {
      name: poData.hospitality_company_name || poData.company_name,
      business_unit_name: poData.hotel_name,
      address: buyerAddress,
      gstin: poData.hotel_gstin || poData.buyer_gstin,
      state_name: buyerLocation?.state_name || null
    },
    buyer_business_unit_name: poData.hotel_name,
    gstin: poData.hotel_gstin || poData.buyer_gstin,
    deliveryterms: poData.delivery_period || buildDeliveryTermsLabel(items),
    paymentTermsList,
    rfqTerms,
    global_comment: poData.global_comment || null,
    isAutoPublished: approvalData.isAutoPublished,
    rfqCreatorName: approvalData.rfqCreatorName,
    rfqApproverName: approvalData.rfqApproverName,
    techEvaluations: approvalData.techEvaluations,
    commercialEvaluations: approvalData.commercialEvaluations,
    poApprovers: approvalData.poApprovers
  };
};

/**
 * Flatten evaluation entries: club all evaluators and approvers across all products
 * into single deduplicated lists.
 * Returns { evaluators: string[], approvers: string[] }
 */
const flattenEvaluations = (evaluations) => {
  const evaluatorSet = new Set();
  const approverSet = new Set();
  for (const e of evaluations) {
    if (e.evaluatorName) evaluatorSet.add(e.evaluatorName);
    for (const a of (e.approvers || [])) {
      if (a.name) approverSet.add(a.name);
    }
  }
  return {
    evaluators: Array.from(evaluatorSet),
    approvers: Array.from(approverSet)
  };
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

    result.commercialEvaluations = rawCommercial;
  }

  // Flatten evaluations: club all evaluators and approvers across products
  result.techEvaluations = flattenEvaluations(result.techEvaluations);
  result.commercialEvaluations = flattenEvaluations(result.commercialEvaluations);

  // 5. Get PO Approvers - ALL approvers with their status
  if (poData.approval_instance_id) {
    // New approval workflow - get all steps with their approvers
    const stepsWithApprovers = await conn.any(`
      SELECT
        AIS.id AS step_id,
        AIS.step_order,
        AIS.decision_rule,
        AIS.status AS step_status,
        AIS.completed_at AT TIME ZONE 'UTC' AS step_completed_at,
        SA.approver_user_id,
        SA.status AS approver_status,
        SA.acted_at AT TIME ZONE 'UTC' AS acted_at,
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
          H.created_at AT TIME ZONE 'UTC' AS acted_at
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

  // Convert UTC to IST (UTC+5:30) before formatting
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);

  // Format: DD/MM/YYYY - HH:MM AM/PM (IST)
  const day = String(ist.getUTCDate()).padStart(2, '0');
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const year = ist.getUTCFullYear();

  let hours = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12

  return `${day}/${month}/${year} - ${hours}:${minutes} ${ampm}`;
};
