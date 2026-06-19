import db from "../config/dbConn.js";
import { sendApprovalNotification } from "../controllers/po/purchaseOrderEmails.js";
import seoController from "../controllers/seo/seoController.js";
import { consoleLogData, generateSignature, logError } from "../helper/common.js";
import { scheduleGRNReminders } from "../helper/cronManager.js";
import { sendDispatchedEmail, sendGRNRepresentativeEmail, sendGRNUpdationEmail, sendInvoiceEmail } from "../helper/sendEmailFunctions/generalReminderEmails.js";
import { AVAILABLE_HIERARCHY_TYPES, INVALID_PO_STATUSES_FOR_VENDOR, PO_STATUSES } from "../util/constants.js";
import { logger } from "../util/logger.js";
import generalModel, { markPOStatusChange, uploadToS3, createApprovalInstance } from "./generalModel.js";
import pricingEngine from "../services/pricingEngine.js";
import fs from 'fs';

// Statuses at which the rendered PO PDF must stay sealed. The PDF is generated
// at draft time so the buyer can preview, but it is intended for the vendor —
// surfacing it to anyone (including approvers reviewing the structured data)
// before approval completes risks leakage. Once approval finishes the PO
// transitions to ACCEPTANCE_PENDING (vendor email goes out at the same moment)
// and the PDF becomes appropriate to share. Rejected/cancelled POs never
// surface the PDF.
const PO_PDF_SEALED_STATUSES = new Set([
  PO_STATUSES.DRAFT,
  PO_STATUSES.PENDING_APPROVAL,
  PO_STATUSES.REJECTED,
  PO_STATUSES.CANCELLED,
]);

const resolvePoPdfVisibility = (status, url) => {
  if (!url) return null;
  return PO_PDF_SEALED_STATUSES.has(status) ? null : url;
};

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

export const draftPurchaseOrder = async (rfq_id, project_id, quote_item_id, total_value, product_info, initiated_by, company_id, user, existing_po_id, selected_hierarchy, t, global_charges = [], line_total = null) => {
    try {
      const { rfq_product_id, quantity, unit, unit_price, charges_meta, finalized_vendor_id } =
        product_info;
      // Per-line total goes onto tbl_purchase_order_product.total_price.
      // Grand total (line + document-level global charges) goes onto
      // tbl_rfq_purchase_order.total_value. When the caller didn't separate
      // the two, fall back to total_value to preserve legacy behaviour.
      const linePrice = line_total ?? total_value;

      // 1. Check if a pending PO already exists for this RFQ Product
      const existing = await t.oneOrNone(
        `SELECT TRPO.id FROM tbl_rfq_purchase_order TRPO
        LEFT JOIN tbl_purchase_order_product TPOP ON TPOP.purchase_order_id = TRPO.id AND TPOP.rfq_product_id = $2
      WHERE rfq_id = $1 AND TPOP.id IS NOT NULL AND status = $3`,
        [rfq_id, rfq_product_id, PO_STATUSES.PENDING_APPROVAL]
      );

      if (existing) {
        await t.none(
          `UPDATE tbl_rfq_purchase_order
          SET status = $2, updated_at = NOW()
          WHERE id = $1`,
          [existing.id, PO_STATUSES.CANCELLED]
        );
      }

      let po = null;

      // Auto-merge: if the caller did not nominate a merge target, look for an
      // existing draft PO on this RFQ for the same vendor that shares the same
      // project + selected_hierarchy. If found, treat the new line as an
      // append onto that PO. SELECT ... FOR UPDATE serializes concurrent
      // finalize transactions targeting the same (rfq, vendor, project,
      // hierarchy), so the "at most one draft PO per tuple" invariant holds
      // even under parallel awards. selected_hierarchy is compared via ::text
      // to be agnostic to json/jsonb/text storage; IS NOT DISTINCT FROM keeps
      // NULL == NULL so legacy rows without a hierarchy can still merge.
      // Restricted to status='draft' — pending-approval POs are mid-review
      // and must not absorb new lines (would invalidate approval context).
      if (!existing_po_id && finalized_vendor_id) {
        const mergeTarget = await t.oneOrNone(
          `SELECT id FROM tbl_rfq_purchase_order
            WHERE rfq_id = $1
              AND finalized_vendor_id = $2
              AND project_id IS NOT DISTINCT FROM $3
              AND selected_hierarchy::text IS NOT DISTINCT FROM $4::text
              AND status = $5
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE`,
          [rfq_id, finalized_vendor_id, project_id, selected_hierarchy, PO_STATUSES.DRAFT]
        );
        if (mergeTarget) {
          existing_po_id = mergeTarget.id;
        }
      }

      if(existing_po_id) {
        if(!(await t.oneOrNone(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1`, [existing_po_id])))
          throw new Error("No Purchase Order found from id:", existing_po_id);

        po = await t.one(
          `UPDATE tbl_rfq_purchase_order
            SET
              selected_hierarchy = $1

            WHERE id = $2
            RETURNING id`,
          [
            selected_hierarchy,
            existing_po_id
          ]
        );

        await t.none(
          `INSERT INTO tbl_purchase_order_product
          (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [existing_po_id, rfq_product_id, quote_item_id, quantity, unit, unit_price, charges_meta, linePrice]
        )

        // Re-aggregate the header grand total over ALL lines now on this PO
        // plus the existing snapshot of document-level global_charges. Without
        // this, total_value would still reflect just the FIRST line's grand
        // total even though we just appended a second product.
        //
        // Reuses pricingEngine.normalizeGlobalCharge so legacy {tax, tax_mode}
        // and newer {amount, amount_mode} global-charge shapes both apply
        // correctly. Globals stay at one occurrence on the snapshot — they're
        // a document-level charge, applied once to the combined subtotal.
        const summed = await t.oneOrNone(
          `SELECT COALESCE(SUM(total_price), 0) AS sub
             FROM tbl_purchase_order_product
            WHERE purchase_order_id = $1`,
          [existing_po_id]
        );
        const lineSubtotal = Number(summed?.sub) || 0;
        const headerRow = await t.oneOrNone(
          `SELECT global_charges FROM tbl_rfq_purchase_order WHERE id = $1`,
          [existing_po_id]
        );
        const rawGc = headerRow?.global_charges;
        let snapshotGlobals = [];
        if (Array.isArray(rawGc)) snapshotGlobals = rawGc;
        else if (typeof rawGc === 'string' && rawGc.trim()) {
          try { snapshotGlobals = JSON.parse(rawGc); } catch (_e) { snapshotGlobals = []; }
        }
        let gcTotal = 0;
        for (const gc of snapshotGlobals) {
          const norm = pricingEngine.normalizeGlobalCharge(gc);
          if (!norm) continue;
          gcTotal += pricingEngine.applyChargeMode(
            norm.amount, norm.amount_mode, lineSubtotal
          );
        }
        // Quantise to 2dp, matching pricingEngine.calculateDocumentTotals
        // (which is what the new-PO branch uses). Keeping rounding consistent
        // across the new-PO path and the merge path means the stored
        // total_value never drifts by 1 paisa just because a PO was built in
        // two draftPO calls vs one.
        const grandTotal = Math.round((lineSubtotal + gcTotal) * 100) / 100;
        await t.none(
          `UPDATE tbl_rfq_purchase_order SET total_value = $1 WHERE id = $2`,
          [grandTotal, existing_po_id]
        );
      } else {
        // 2. Insert new PO record
        const poNumber = await getNextPONumber();
        const concated_terms = await db.one(
          `SELECT STRING_AGG(t.term_content, ', ' ORDER BY t.id) AS terms_text
            FROM tbl_rfq_terms_map tm
            JOIN tbl_rfq_terms t ON t.id = tm.terms_id
            WHERE tm.rfq_id = $1;
          `,
          [rfq_id]
        )
        po = await t.one(
          `INSERT INTO tbl_rfq_purchase_order (
            rfq_id, project_id, quote_id, po_number, total_value, rfq_product_id, quantity,
            unit_price, finalized_vendor_id, initiated_by, status, selected_hierarchy, terms_and_conditions, company_id, global_charges
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id`,
          [
            rfq_id,
            project_id,
            [quote_item_id],
            poNumber,
            total_value,
            [rfq_product_id],
            quantity,
            unit_price,
            finalized_vendor_id,
            initiated_by,
            PO_STATUSES.DRAFT,
            selected_hierarchy,
            concated_terms.terms_text,
            company_id,
            JSON.stringify(global_charges || [])
          ]
        );

        await t.none(
          `INSERT INTO tbl_purchase_order_product
          (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [po.id, rfq_product_id, quote_item_id, quantity, unit, unit_price, charges_meta, linePrice]
        )
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

/**
 * Merge N draft POs of the SAME vendor on the SAME RFQ into a single kept PO.
 *
 * Use-case: a buyer (or the post-merge approver) realises that during
 * commercial finalization the new draft wasn't merged into the vendor's
 * existing draft (or that two finalize actions independently produced two
 * drafts for the same vendor). Rather than discard work and restart, this
 * call moves all line items, documents, milestones, tasks, and HSN mappings
 * from the SOURCE drafts onto the KEPT draft, then deletes the now-empty
 * source headers. Total is recomputed using the kept PO's global_charges
 * snapshot — globals are NOT additively combined; they're already a
 * document-level header concept and the kept PO's snapshot wins.
 *
 * Guarantees (all enforced inside one tx; the whole merge rolls back on any
 * failed pre-condition):
 *   - All IDs exist and are reachable
 *   - All are status='draft' (never touches a PO in flight)
 *   - All share finalized_vendor_id (same vendor)
 *   - All share rfq_id (same RFQ)
 *   - All share company_id (no cross-tenant merge)
 *   - keep_po_id is present in the merged set
 *   - At least two distinct POs (a 1-PO "merge" is a no-op error)
 *
 * Post-state:
 *   - Source POs deleted; kept PO carries all child rows
 *   - HSN mappings: kept PO's wins on conflict (same rfq_item_id), source's
 *     dropped to avoid duplicate rows that would confuse the read paths
 *   - total_value recomputed via pricingEngine (same logic the draft-merge
 *     path uses), keeping the merge-vs-fresh-draft total parity invariant
 *   - po_pdf_url nulled (the existing PDF is now stale; the sealed-status
 *     visibility gate keeps it hidden until approval anyway, but a stale URL
 *     would still surface in some places — null is the safe state)
 *   - rfq_product_id / quote_id / quantity rebuilt from the new line set
 */
export const mergeDraftPOs = async ({ keep_po_id, po_ids, user, txContext = null } = {}) => {
  const executor = async (t) => {
    const keepIdNum = Number(keep_po_id);
    const idArray = Array.isArray(po_ids) ? po_ids.map(Number).filter(Number.isFinite) : [];
    // Deduplicate + ensure keep is in the set.
    const allIds = Array.from(new Set([...idArray, keepIdNum]));
    if (!Number.isFinite(keepIdNum) || keepIdNum <= 0) {
      throw new Error('keep_po_id is required');
    }
    if (allIds.length < 2) {
      throw new Error('At least 2 distinct POs are required to merge');
    }
    if (!allIds.includes(keepIdNum)) {
      throw new Error('keep_po_id must be one of the selected POs');
    }
    const sourceIds = allIds.filter((id) => id !== keepIdNum);

    // SELECT … FOR UPDATE locks the rows for the duration of the tx, so a
    // concurrent initiate/approve/edit on any of these drafts can't race
    // past us mid-merge.
    const rows = await t.any(
      `SELECT id, status, finalized_vendor_id, rfq_id, company_id
         FROM tbl_rfq_purchase_order
        WHERE id = ANY($1::int[])
        FOR UPDATE`,
      [allIds]
    );
    if (rows.length !== allIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = allIds.filter((id) => !found.has(id));
      throw new Error(`Purchase order(s) not found: ${missing.join(', ')}`);
    }

    const keepRow = rows.find((r) => r.id === keepIdNum);
    for (const r of rows) {
      if (r.status !== PO_STATUSES.DRAFT) {
        throw new Error(`PO ${r.id} is not a draft (status: ${r.status}) — only drafts can be merged`);
      }
      if (r.finalized_vendor_id !== keepRow.finalized_vendor_id) {
        throw new Error('All selected POs must be for the same vendor');
      }
      if (r.rfq_id !== keepRow.rfq_id) {
        throw new Error('All selected POs must belong to the same RFQ');
      }
      if (r.company_id !== keepRow.company_id) {
        throw new Error('All selected POs must belong to the same company');
      }
    }

    // Tenant scope safety: caller must be acting within the same company as
    // the POs. Controller layer also enforces this; double-checking inside
    // the tx makes the model safe for direct internal callers (tests, jobs).
    if (user && user.company_id && Number(user.company_id) !== Number(keepRow.company_id)) {
      throw new Error('You do not have access to these purchase orders');
    }

    // Re-parent ALL child rows from source POs to the kept PO. Order doesn't
    // matter since they're sibling tables, but we keep it deterministic for
    // readability (and for the test to assert state at each step if needed).
    await t.none(
      `UPDATE tbl_purchase_order_product
          SET purchase_order_id = $1
        WHERE purchase_order_id = ANY($2::int[])`,
      [keepIdNum, sourceIds]
    );
    await t.none(
      `UPDATE tbl_purchase_order_document
          SET purchase_order_id = $1
        WHERE purchase_order_id = ANY($2::int[])`,
      [keepIdNum, sourceIds]
    );
    await t.none(
      `UPDATE tbl_payment_milestone
          SET po_id = $1
        WHERE po_id = ANY($2::int[])`,
      [keepIdNum, sourceIds]
    );
    await t.none(
      `UPDATE tbl_purchase_order_tasks
          SET po_id = $1
        WHERE po_id = ANY($2::int[])`,
      [keepIdNum, sourceIds]
    );

    // HSN: drop source rows whose rfq_item_id already has a mapping on the
    // kept PO (kept-PO's wins), then re-parent the remainder. There's no
    // (po_id, rfq_item_id) unique constraint at the schema level today, but
    // a duplicate row would just inflate read responses without breaking
    // anything — best to dedupe pre-emptively.
    await t.none(
      `DELETE FROM tbl_purchase_order_hsn_mapping
        WHERE po_id = ANY($1::int[])
          AND rfq_item_id IN (
            SELECT rfq_item_id FROM tbl_purchase_order_hsn_mapping
             WHERE po_id = $2
          )`,
      [sourceIds, keepIdNum]
    );
    await t.none(
      `UPDATE tbl_purchase_order_hsn_mapping
          SET po_id = $1
        WHERE po_id = ANY($2::int[])`,
      [keepIdNum, sourceIds]
    );

    // Source headers are now childless. Delete.
    await t.none(
      `DELETE FROM tbl_rfq_purchase_order
        WHERE id = ANY($1::int[])`,
      [sourceIds]
    );

    // Recompute kept-PO totals over the merged line set. Reuse the exact
    // pricing-engine pattern from the draft-merge branch in
    // draftPurchaseOrder so the stored total matches a hypothetical
    // "single-shot fresh draft" of the same lines.
    const summed = await t.oneOrNone(
      `SELECT COALESCE(SUM(total_price), 0) AS sub
         FROM tbl_purchase_order_product
        WHERE purchase_order_id = $1`,
      [keepIdNum]
    );
    const lineSubtotal = Number(summed?.sub) || 0;

    const headerRow = await t.oneOrNone(
      `SELECT global_charges FROM tbl_rfq_purchase_order WHERE id = $1`,
      [keepIdNum]
    );
    const rawGc = headerRow?.global_charges;
    let snapshotGlobals = [];
    if (Array.isArray(rawGc)) snapshotGlobals = rawGc;
    else if (typeof rawGc === 'string' && rawGc.trim()) {
      try { snapshotGlobals = JSON.parse(rawGc); } catch (_e) { snapshotGlobals = []; }
    }
    let gcTotal = 0;
    for (const gc of snapshotGlobals) {
      const norm = pricingEngine.normalizeGlobalCharge(gc);
      if (!norm) continue;
      gcTotal += pricingEngine.applyChargeMode(norm.amount, norm.amount_mode, lineSubtotal);
    }
    const grandTotal = Math.round((lineSubtotal + gcTotal) * 100) / 100;

    // Refresh derived header columns from the current line set. quote_id /
    // rfq_product_id on the header are denormalised arrays — without this
    // refresh they'd still reflect the source-PO contribution and would
    // mislead downstream callers that read the header directly.
    const linesAgg = await t.oneOrNone(
      `SELECT
          COALESCE(array_remove(array_agg(DISTINCT rfq_product_id), NULL), '{}'::int[]) AS rfq_products,
          COALESCE(array_remove(array_agg(DISTINCT quote_id),       NULL), '{}'::int[]) AS quotes,
          COALESCE(SUM(quantity), 0)::float8 AS qty,
          COUNT(*)::int AS line_count
         FROM tbl_purchase_order_product
        WHERE purchase_order_id = $1`,
      [keepIdNum]
    );

    // Casts on $2/$3: pg-promise serialises JS arrays as PG literal '{...}'
    // which Postgres types as text[] by default. Without ::int[] the UPDATE
    // is rejected because the target columns are integer[].
    await t.none(
      `UPDATE tbl_rfq_purchase_order
          SET total_value    = $1,
              rfq_product_id = $2::int[],
              quote_id       = $3::int[],
              quantity       = $4,
              po_pdf_url     = NULL,
              updated_at     = NOW()
        WHERE id = $5`,
      [
        grandTotal,
        linesAgg?.rfq_products || [],
        linesAgg?.quotes || [],
        Number(linesAgg?.qty) || 0,
        keepIdNum,
      ]
    );

    return {
      keep_po_id: keepIdNum,
      merged_po_ids: sourceIds,
      new_line_count: Number(linesAgg?.line_count) || 0,
      new_total_value: grandTotal,
      new_line_subtotal: Math.round(lineSubtotal * 100) / 100,
    };
  };

  return txContext ? executor(txContext) : db.tx(executor);
};

export const initiatePurchaseOrder = async (po_id, initiator, t) => {
  try {
    const purchaseOrder = await t.oneOrNone(
      `SELECT 
        PO.*, 
        TC.company_name,
        TC.cin,
        TC.website,
        TC.location,
        TC.logo,
        FIN.mobile,
        TQ.timestamp,
        RFQ.location AS delivery_location,
        JSON_BUILD_OBJECT(
          'id', SUP.id,
          'name', SUP.name,
          'email', SUP.email,
          'phone', SUP.mobile,
          'address', (
            SELECT address
            FROM tbl_company_location
            WHERE company_id = SUP.company_id
            ORDER BY created_at DESC
            LIMIT 1
          ),
          'gstin', COALESCE(TQ.gstin, TCSUP.gstin),
          'cin', TCSUP.cin
        ) AS supplier,
        JSON_BUILD_OBJECT(
          'id', TC.id,
          'name', TC.company_name,
          'email', FIN.email,
          'phone', FIN.mobile,
          'address', (
            SELECT address
            FROM tbl_company_location
            WHERE company_id = FIN.company_id
            ORDER BY created_at DESC
            LIMIT 1
          ),
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
        JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
        LEFT JOIN LATERAL (
          SELECT * FROM tbl_quotes
          WHERE rfq_id = PO.rfq_id AND created_by = PO.finalized_vendor_id
          ORDER BY timestamp DESC LIMIT 1
        ) TQ ON TRUE
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

    const { rfq_id, project_id, finalized_vendor_id } = purchaseOrder;

    // Get actual product data from tbl_purchase_order_product (source of truth)
    const poProducts = await t.any(`
      SELECT pop.rfq_product_id, pop.quantity, pop.unit_price, pop.total_price
      FROM tbl_purchase_order_product pop
      WHERE pop.purchase_order_id = $1
    `, [purchaseOrder.id]);
    const computedTotal = poProducts.reduce((sum, p) => sum + Number(p.total_price || 0), 0);
    const computedQuantity = poProducts.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
    const productIds = poProducts.map(p => p.rfq_product_id);

    // Get RFQ details to check if it's a hospitality RFQ
    const rfq = await t.oneOrNone(`
      SELECT id, hospitality_company_id, hotel_id, department_id, process_id, rfq_no, is_tender
      FROM tbl_rfq WHERE id = $1
    `, [rfq_id]);

    let approvalResult;
    let useNewWorkflow = false;

    // Use new approval workflow for hospitality POs
    if (rfq && rfq.hospitality_company_id) {
      useNewWorkflow = true;

      try {
        approvalResult = await createApprovalInstance({
          entity_type: 'PO',
          entity_id: purchaseOrder.id,
          hospitality_company_id: rfq.hospitality_company_id,
          hotel_id: rfq.hotel_id,
          department_id: rfq.department_id,
          process_id: rfq.process_id,
          initiated_by: initiator.id,
          metadata: {
            po_id: purchaseOrder.id,
            po_number: purchaseOrder.po_number,
            rfq_id: rfq_id,
            rfq_no: rfq.rfq_no,
            total_value: computedTotal,
            vendor_id: finalized_vendor_id,
            is_tender: rfq.is_tender,
            project_id: project_id,
            rfq_product_ids: productIds
          },
          txContext: t
        });

        // Store approval_instance_id in PO
        if (approvalResult.instance?.id) {
          await t.none(`
            UPDATE tbl_rfq_purchase_order
            SET approval_instance_id = $1, status = 'pending_approval'
            WHERE id = $2
          `, [approvalResult.instance.id, purchaseOrder.id]);
        }

        // Handle auto-approval (if creator is only approver or no policy)
        if (approvalResult.autoApproved) {
          await markPOStatusChange(purchaseOrder.id, t, false, initiator);
          approvalResult.approval_required = false;
        } else {
          approvalResult.approval_required = true;
        }
      } catch (approvalError) {
        logError("APPROVAL ERROR", approvalError);
        // No policy found - throw error, do not auto-approve
        throw new Error('No approval policy found for Purchase Order. Please configure an approval policy for PO entity type in the hospitality scope.');
      }
    } else {
      // Use old approval workflow for non-hospitality POs
      const meta = {
        rfq_id,
        project_id,
        rfq_product_ids: productIds,
        quantity: computedQuantity,
        unit_price: poProducts.reduce((sum, p) => sum + Number(p.unit_price || 0), 0),
        finalized_vendor_id,
        total_value: computedTotal,
        po_id: purchaseOrder.id
      };

      approvalResult = await generalModel.initiateApproval(
        AVAILABLE_HIERARCHY_TYPES.po.type,
        purchaseOrder.id,
        initiator.company_id,
        initiator.id,
        purchaseOrder.selected_hierarchy,
        meta,
        {
          exist: `You cannot change the finalized vendor because an approved Purchase Order already exists for them.`
        },
        t,
      );

      // If no further approval required → mark PO as approved
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
    }

    const items = await getPOItemDetails(purchaseOrder, t)

    // Generate PO PDF with dynamic template selection
    const pdfSaveResult = await seoController.poPDF({
      po_id: purchaseOrder.id,
      company_id: purchaseOrder.company_id,
      hospitality_company_id: rfq?.hospitality_company_id,
      hotel_id: rfq?.hotel_id,
      // Legacy data for backward compatibility with default template
      ...purchaseOrder,
      ...items
    }, t);

    const s3Url = await uploadToS3(pdfSaveResult.absolutePath, `po-${purchaseOrder.po_number}-${Date.now().toString()}.pdf`)
    // await fs.promises.unlink(pdfSaveResult.absolutePath);

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
      approval_instance_id: approvalResult.instance?.id ?? null,
      approval_type: useNewWorkflow ? 'new' : 'legacy',
      poPdf: pdfSaveResult
    };
  } catch (error) {
    throw error;
  }
};

export const getPOItemDetails = async (purchase_order, t) => {
  try {
    const q = `
      SELECT 
        pop.unit_price,
        -- charges_meta JSONB breakdown
        (pop.charges_meta->>'package_price')::numeric    AS package_price,
        (pop.charges_meta->>'tax')::numeric              AS tax,
        (pop.charges_meta->>'freight_price')::numeric    AS freight_price,
        pop.total_price,
        qi.comment,
        qi.delivery_period,
        pop.charges_meta->>'freight_mode'  AS freight_mode,
        pop.charges_meta->>'package_mode'  AS package_mode,
        pop.charges_meta->>'tax_mode'      AS tax_mode,
        COALESCE(pop.charges_meta->'other_charges', '[]'::jsonb) AS other_charges,
        pv.name                            AS product_name,
        pop.quantity,
        pop.unit,
        TPOHM.hsn_code
      FROM tbl_purchase_order_product pop
      JOIN tbl_rfq_products TRP
        ON TRP.id = pop.rfq_product_id
      LEFT JOIN tbl_purchase_order_hsn_mapping TPOHM
        ON TPOHM.po_id = pop.purchase_order_id
      AND TPOHM.rfq_item_id = TRP.id
      JOIN tbl_product_variant pv
        ON TRP.product_variant_id = pv.id
      LEFT JOIN tbl_quote_items qi
        ON qi.id = pop.quote_id
      WHERE pop.purchase_order_id = $1
      ORDER BY pop.id;
    `;
    let items = await t.any(q, [purchase_order.id])

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
  } catch (error) {
    throw error;
  }
};

export const getPOByRFQId = async (rfq_id, user_id, user_type, page = 1, limit = 10, filters = {}) => {
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

    if(user_type == 3) {
      // Only PO that are for our vendor
      conditions.push(`po.finalized_vendor_id = $${paramIndex++}`);
      values.push(user_id);

      // Only PO that are either approved or in the latter stage
      conditions.push(`po.status <> ALL($${paramIndex++}::po_status[])`);
      values.push(INVALID_PO_STATUSES_FOR_VENDOR);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [pos, { total }, { approval_level }] = await db.tx(async t => {
      const dataQuery = `SELECT po.*,
                (
                  SELECT COALESCE(SUM(TPOP.quantity), 0)::double precision
                  FROM tbl_purchase_order_product TPOP
                  WHERE TPOP.purchase_order_id = po.id
                ) AS quantity,
                (
                  SELECT COALESCE(SUM(TPOP.unit_price), 0)::numeric(15,2)
                  FROM tbl_purchase_order_product TPOP
                  WHERE TPOP.purchase_order_id = po.id
                ) AS unit_price,
                -- po.total_value is the authoritative grand total (line subtotal
                -- + document-level global_charges, populated by draftPO via
                -- pricingEngine.calculateDocumentTotals). The legacy SUM(line.
                -- total_price) subquery dropped global charges entirely; kept
                -- as line_subtotal for the FE breakdown view.
                po.total_value AS total_value,
                (
                  SELECT COALESCE(SUM(TPOP.total_price), 0)::numeric(15,2)
                  FROM tbl_purchase_order_product TPOP
                  WHERE TPOP.purchase_order_id = po.id
                ) AS line_subtotal,
                COALESCE(VENDOR_COMPANY.company_name, VENDOR.organization_name, VENDOR.name) AS finalized_vendor_name,
                PRJ.name AS project_name,
                TU.name AS initiated_by,
                COALESCE(BUYER_HC.name, BUYER_COMPANY.company_name) AS buyer_company_name,
                -- Check if user is approver (supports both old and new workflows)
                CASE
                  WHEN po.approval_instance_id IS NOT NULL THEN (
                    SELECT EXISTS(
                      SELECT 1 FROM tbl_approval_step_approvers tasa
                      JOIN tbl_approval_instance_steps tais ON tais.id = tasa.approval_instance_step_id
                      WHERE tais.approval_instance_id = po.approval_instance_id
                        AND tais.step_order = tai.current_step
                        AND tais.status = 'PENDING'
                        AND tasa.status = 'PENDING'
                        AND tasa.approver_user_id = $2
                    )
                  )
                  WHEN trx.current_approver_id = $2 THEN TRUE
                  ELSE FALSE
                END AS is_approver,
                COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                          'id', TPV.id,
                          'name', TPV.name,
                          'quantity', TPOP.quantity,
                          'unit', TPOP.unit
                      )
                  )
                  FROM tbl_purchase_order_product TPOP
                  JOIN tbl_rfq_products TRP ON TPOP.rfq_product_id = TRP.id
                  JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
                  WHERE TPOP.purchase_order_id = po.id
                ),
                '[]'::json
              ) AS product_details,
                -- Approval status supports both old and new workflows.
                -- Includes pending_approvers (new flow) and
                -- current_approver_name (legacy flow) so the listing can
                -- show "Pending at: names" under the status badge without
                -- the user opening each PO.
                CASE
                  WHEN po.approval_instance_id IS NOT NULL THEN json_build_object(
                    'type', 'new',
                    'id', tai.id,
                    'status', tai.status,
                    'current_step', tai.current_step,
                    'total_steps', (
                      SELECT COUNT(AIS.id)
                      FROM tbl_approval_instance_steps AIS
                      WHERE AIS.approval_instance_id = tai.id
                    ),
                    'pending_approvers', (
                      SELECT COALESCE(JSON_AGG(
                        JSON_BUILD_OBJECT(
                          'user_id', tasa.approver_user_id,
                          'name', approver_user.name
                        )
                      ), '[]'::json)
                      FROM tbl_approval_step_approvers tasa
                      JOIN tbl_approval_instance_steps tais ON tais.id = tasa.approval_instance_step_id
                      JOIN tbl_users approver_user ON approver_user.id = tasa.approver_user_id
                      WHERE tais.approval_instance_id = tai.id
                        AND tais.step_order = tai.current_step
                        AND tais.status = 'PENDING'
                        AND tasa.status = 'PENDING'
                    )
                  )
                  WHEN trx.id IS NOT NULL THEN json_build_object(
                    'type', 'legacy',
                    'id', trx.id,
                    'status', trx.status,
                    'initiated_by', trx.initiated_by,
                    'current_approver_id', trx.current_approver_id,
                    'current_approver_name', (
                      SELECT TRX_U.name FROM tbl_users TRX_U
                      WHERE TRX_U.id = trx.current_approver_id
                    ),
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
         -- Old approval workflow
         LEFT JOIN tbl_approval_hierarchy_transactions trx
           ON trx.hierarchy_type = 'po'
           AND trx.target_entity_id = po.id
         -- New approval workflow
         LEFT JOIN tbl_approval_instances tai
           ON tai.id = po.approval_instance_id
        JOIN tbl_users TU ON TU.id = po.initiated_by
        JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
        LEFT JOIN tbl_company VENDOR_COMPANY ON VENDOR_COMPANY.id = VENDOR.company_id
        JOIN tbl_rfq BUYER_RFQ ON BUYER_RFQ.id = po.rfq_id
        LEFT JOIN tbl_hospitality_companies BUYER_HC ON BUYER_HC.id = BUYER_RFQ.hospitality_company_id
        LEFT JOIN tbl_company BUYER_COMPANY ON BUYER_COMPANY.id = po.company_id
         ${whereClause}
         ORDER BY po.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`

      let data = await t.any(dataQuery,
        [...values, limit, offset]
      );

      data = data.map(d => {
        const sealedPdfUrl = resolvePoPdfVisibility(d.status, d.po_pdf_url);
        return {
          ...d,
          po_pdf_url: sealedPdfUrl,
          poPdfUrl: sealedPdfUrl,
        };
      })

      const count = await t.one(
        `SELECT COUNT(*) AS total
         FROM tbl_rfq_purchase_order po
         ${whereClause}`,
        values
      );

      // const approverLevel = await t.oneOrNone(
      //   `SELECT approval_level FROM tbl_approval_hierarchy TAH
      //    WHERE user_id = $1 AND hierarchy_type = 'po'`,
      //    [user_id]
      // )

      return [data, count, 999];
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
              (
                SELECT COALESCE(SUM(TPOP.quantity), 0)::double precision
                FROM tbl_purchase_order_product TPOP
                WHERE TPOP.purchase_order_id = po.id
              ) AS quantity,
              (
                SELECT COALESCE(SUM(TPOP.unit_price), 0)::numeric(15,2)
                FROM tbl_purchase_order_product TPOP
                WHERE TPOP.purchase_order_id = po.id
              ) AS unit_price,
              -- po.total_value is the authoritative grand total, populated by
              -- draftPO via pricingEngine.calculateDocumentTotals. It already
              -- includes document-level global_charges (snapshotted onto
              -- po.global_charges at draft). The legacy SUM(line.total_price)
              -- subquery was only the per-line aggregate and lost global
              -- charges entirely — kept here as line_subtotal for FE breakdown.
              po.total_value AS total_value,
              (
                SELECT COALESCE(SUM(TPOP.total_price), 0)::numeric(15,2)
                FROM tbl_purchase_order_product TPOP
                WHERE TPOP.purchase_order_id = po.id
              ) AS line_subtotal,
              CASE
                WHEN PD.id IS NOT NULL THEN
                  JSON_BUILD_OBJECT(
                      'id', PD.id,
                      'name', PD.name
                  )
                ELSE NULL END AS project_details,
              COALESCE(VENDOR_COMPANY.company_name, VENDOR.organization_name, VENDOR.name) AS finalized_vendor_name,
              VENDOR.email AS finalized_vendor_email,
              VENDOR.mobile AS finalized_vendor_phone,
              -- Buyer company details
              COALESCE(THC.name, TC.company_name) AS buyer_company_name,
              THCH.name AS buyer_business_unit,
              TC.gstin AS buyer_gstin,
              (SELECT address FROM tbl_company_location WHERE company_id = po.company_id ORDER BY created_at DESC LIMIT 1) AS buyer_address,
              TU.mobile AS initiated_by_phone,
              RFQ.rfq_no,
              RFQ.title AS rfq_title,
              JSON_BUILD_OBJECT(
                  'id', LOGGED_IN_USER.id,
                  'name', LOGGED_IN_USER.name,
                  'user_type', LOGGED_IN_USER.user_type
              ) AS logged_in_user,
              TU.name AS initiated_by_name,
              TU.email AS initiated_by_email,
              -- Check if user is approver (supports both old and new workflows)
              CASE
                WHEN po.approval_instance_id IS NOT NULL THEN (
                  SELECT EXISTS(
                    SELECT 1 FROM tbl_approval_step_approvers tasa
                    JOIN tbl_approval_instance_steps tais ON tais.id = tasa.approval_instance_step_id
                    WHERE tais.approval_instance_id = po.approval_instance_id
                      AND tais.step_order = tai.current_step
                      AND tais.status = 'PENDING'
                      AND tasa.status = 'PENDING'
                      AND tasa.approver_user_id = $2
                  )
                )
                WHEN trx.current_approver_id = $2 THEN TRUE
                ELSE FALSE
              END AS is_approver,
              COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                          'id', TPV.id,
                          'name', TPV.name,
                          'product_id', TPV.product_id,
                          'rfq_item_id', TRP.id,
                          'quantity', TPOP.quantity,
                          'unit', TPOP.unit,
                          'unit_price', TPOP.unit_price,
                          'charges_meta', TPOP.charges_meta,
                          'total_price', TPOP.total_price,
                          'vendor_comment', TQI.comment
                      )
                  )
                  FROM tbl_purchase_order_product TPOP
                  JOIN tbl_rfq_products TRP ON TPOP.rfq_product_id = TRP.id
                  JOIN tbl_product_variant TPV ON TRP.product_variant_id = TPV.id
                  LEFT JOIN tbl_quote_items TQI ON TQI.id = TPOP.quote_id
                  WHERE TPOP.purchase_order_id = po.id
                ),
                '[]'::json
              ) AS product_details,
              -- Vendor's overall/global comment from the finalized quote. Walks
              -- back from any PO line → quote_item → parent quote. All lines on
              -- a PO share the same finalized quote, so LIMIT 1 is exact.
              (
                SELECT TQ.global_comment
                FROM tbl_purchase_order_product TPOP
                JOIN tbl_quote_items TQI ON TQI.id = TPOP.quote_id
                JOIN tbl_quotes TQ ON TQ.id = TQI.quote_id
                WHERE TPOP.purchase_order_id = po.id
                LIMIT 1
              ) AS vendor_global_comment,
              COALESCE(
                (
                  SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                          'id', TPOD.id,
                          'document_type', TPOD.document_type,
                          'document_url', TPOD.document_url,
                          'uploaded_by', TPOD.uploaded_by,
                          'created_at', TPOD.created_at
                      )
                  )
                  FROM tbl_purchase_order_document TPOD
                  WHERE TPOD.purchase_order_id = po.id
                ),
                '[]'::json
              ) AS documents,
              (
                SELECT JSON_BUILD_OBJECT(
                  'id', TTLD.id,
                  'name', TTLD.name,
                  'email', TTLD.email,
                  'phone', TTLD.phone,
                  'created_at', TTLD.created_at
                )
                FROM tbl_token_login_data TTLD
                WHERE TTLD.token_type = 'GRN'
                AND entity_id = po.id

                LIMIT 1
              ) AS site_rep,
              COALESCE(
              (
                SELECT JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'id', TPOHM.id,
                        'rfq_item_id', TPOHM.rfq_item_id,
                        'hsn_code', TPOHM.hsn_code,
                        'mapped_by', TPOHM.mapped_by
                    )
                )
                FROM tbl_purchase_order_hsn_mapping TPOHM
                WHERE TPOHM.po_id = po.id
              ),
              '[]'::json
            ) AS hsn_codes,
              -- Approval status supports both old and new workflows
              CASE
                WHEN po.approval_instance_id IS NOT NULL THEN json_build_object(
                  'type', 'new',
                  'id', tai.id,
                  'status', tai.status,
                  'current_step', tai.current_step,
                  'total_steps', (
                    SELECT COUNT(AIS.id)
                    FROM tbl_approval_instance_steps AIS
                    WHERE AIS.approval_instance_id = tai.id
                  ),
                  'initiated_by', tai.initiated_by,
                  'created_at', tai.created_at AT TIME ZONE 'UTC',
                  'pending_approvers', (
                    SELECT COALESCE(JSON_AGG(
                      JSON_BUILD_OBJECT(
                        'user_id', tasa.approver_user_id,
                        'name', approver_user.name
                      )
                    ), '[]'::json)
                    FROM tbl_approval_step_approvers tasa
                    JOIN tbl_approval_instance_steps tais ON tais.id = tasa.approval_instance_step_id
                    JOIN tbl_users approver_user ON approver_user.id = tasa.approver_user_id
                    WHERE tais.approval_instance_id = tai.id
                      AND tais.step_order = tai.current_step
                      AND tais.status = 'PENDING'
                      AND tasa.status = 'PENDING'
                  )
                )
                WHEN trx.id IS NOT NULL THEN json_build_object(
                  'type', 'legacy',
                  'id', trx.id,
                  'status', trx.status,
                  'initiated_by', trx.initiated_by,
                  'current_approver_id', trx.current_approver_id,
                  'current_approver_name', trx_user.name,
                  'final_decision_by', trx.final_decision_by,
                  'created_at', trx.created_at AT TIME ZONE 'UTC'
                )
                ELSE NULL
              END AS approval_status,

              -- Approval history supports both old and new workflows
              CASE
                WHEN po.approval_instance_id IS NOT NULL THEN COALESCE(
                  (
                    SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                        'id', taa.id,
                        'action', taa.action,
                        'remarks', taa.comment,
                        'created_at', taa.created_at AT TIME ZONE 'UTC',
                        'approved_by', taa.approver_user_id,
                        'approved_by_name', COALESCE(action_user.name, 'Unknown'),
                        'step_number', tais_action.step_order
                      )
                      ORDER BY taa.created_at
                    )
                    FROM tbl_approval_actions taa
                    JOIN tbl_approval_instance_steps tais_action ON tais_action.id = taa.approval_instance_step_id
                    LEFT JOIN tbl_users action_user ON action_user.id = taa.approver_user_id
                    WHERE tais_action.approval_instance_id = tai.id
                  ),
                  '[]'::json
                )
                ELSE COALESCE(
                  (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                          'id', H.id,
                          'action', H.action,
                          'remarks', H.remarks,
                          'created_at', H.created_at AT TIME ZONE 'UTC',
                          'approved_by', H.approved_by,
                          'approved_by_name', COALESCE(U.name, 'Site Representative')
                        )
                        ORDER BY H.created_at,
                        CASE
                          WHEN H.action = 'edited' THEN 1
                          WHEN H.action = 'approved' THEN 2
                          ELSE 3
                        END
                    )
                    FROM tbl_approval_hierarchy_history H
                    LEFT JOIN tbl_users U ON U.id = H.approved_by
                    WHERE H.approval_transaction_id = trx.id
                  ),
                  '[]'::json
                )
              END AS approval_history,
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
            -- po_approved_on supports both old and new workflows
            CASE
              WHEN po.approval_instance_id IS NOT NULL AND tai.status = 'APPROVED' THEN tai.completed_at
              ELSE TAHH.created_at
            END AS po_approved_on,
            -- Vendor quote-level T&C files: surfaces files attached by the finalized
            -- vendor via rfq/quote/create and rfq/quote/update (which appends), so the
            -- buyer can audit the full attachment trail from the PO page without
            -- switching to the vendor-only RFQ view.
            COALESCE(
              (
                SELECT JSON_AGG(TQF.file_url)
                FROM tbl_quotes_files TQF
                JOIN tbl_quotes TQ ON TQ.id = TQF.quote_id
                WHERE TQ.rfq_id = po.rfq_id
                  AND TQ.created_by = po.finalized_vendor_id
                  AND TQF.file_type = 'term_and_condition'
              ),
              '[]'::json
            ) AS vendor_quote_term_files,
            -- Vendor per-product document files, scoped to RFQ products that are
            -- actually on this PO. Joined via product_variant_id+variant since
            -- tbl_quote_items doesn't carry rfq_product_id directly.
            COALESCE(
              (
                SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'rfq_product_id', TPOP.rfq_product_id,
                    'product_name',   TPV.name,
                    'file_url',       QIF.file_url,
                    'file_type',      QIF.file_type
                  )
                )
                FROM tbl_purchase_order_product TPOP
                JOIN tbl_rfq_products TRP    ON TRP.id = TPOP.rfq_product_id
                JOIN tbl_product_variant TPV ON TPV.id = TRP.product_variant_id
                JOIN tbl_quote_items TQI     ON TQI.product_variant_id = TRP.product_variant_id
                                            AND TQI.variant = TRP.variant
                JOIN tbl_quotes TQ           ON TQ.id = TQI.quote_id
                                            AND TQ.rfq_id = po.rfq_id
                                            AND TQ.created_by = po.finalized_vendor_id
                JOIN tbl_quote_item_files QIF ON QIF.quote_item_id = TQI.id
                WHERE TPOP.purchase_order_id = po.id
              ),
              '[]'::json
            ) AS vendor_quote_product_files,
            -- Vendor technical-evaluation evidence files: surfaces files the
            -- finalized vendor uploaded against tech-eval clauses on the
            -- /vendor/technical-evaluation page, scoped to RFQ products on this PO.
            COALESCE(
              (
                SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'rfq_product_id', TPOP.rfq_product_id,
                    'product_name',   TPV.name,
                    'file_url',       VRF.file_url
                  )
                )
                FROM tbl_purchase_order_product TPOP
                JOIN tbl_rfq_products TRP    ON TRP.id = TPOP.rfq_product_id
                JOIN tbl_product_variant TPV ON TPV.id = TRP.product_variant_id
                JOIN tbl_rfq_product_tech_evaluation TE
                  ON TE.rfq_id = po.rfq_id
                 AND TE.tbl_rfq_product_id = TRP.id
                JOIN tbl_rfq_product_tech_evaluation_clauses TEC
                  ON TEC.tbl_rfq_product_tech_evaluation_id = TE.id
                JOIN tbl_rfq_product_tech_evaluation_vendors_response VR
                  ON VR.tbl_rfq_product_tech_evaluation_clauses_id = TEC.id
                 AND VR.vendor_id = po.finalized_vendor_id
                JOIN tbl_rfq_product_tech_evaluation_vendors_response_files VRF
                  ON VRF.tbl_rfq_product_tech_evaluation_vendors_response_id = VR.id
                WHERE TPOP.purchase_order_id = po.id
              ),
              '[]'::json
            ) AS vendor_tech_eval_files,
            -- Buyer technical-evaluation clause files: surfaces files the
            -- buyer uploaded against tech-eval clauses (clause-modal attachments),
            -- scoped to RFQ products on this PO.
            COALESCE(
              (
                SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'rfq_product_id', TPOP.rfq_product_id,
                    'product_name',   TPV.name,
                    'file_url',       TECF.file_url
                  )
                )
                FROM tbl_purchase_order_product TPOP
                JOIN tbl_rfq_products TRP    ON TRP.id = TPOP.rfq_product_id
                JOIN tbl_product_variant TPV ON TPV.id = TRP.product_variant_id
                JOIN tbl_rfq_product_tech_evaluation TE
                  ON TE.rfq_id = po.rfq_id
                 AND TE.tbl_rfq_product_id = TRP.id
                JOIN tbl_rfq_product_tech_evaluation_clauses TEC
                  ON TEC.tbl_rfq_product_tech_evaluation_id = TE.id
                JOIN tbl_rfq_product_tech_evaluation_clauses_files TECF
                  ON TECF.tbl_rfq_product_tech_evaluation_clauses_id = TEC.id
                WHERE TPOP.purchase_order_id = po.id
              ),
              '[]'::json
            ) AS buyer_tech_eval_files,
            (
              SELECT QI.delivery_period
              FROM tbl_purchase_order_product TPOP
              JOIN tbl_quote_items QI ON QI.id = TPOP.quote_id
              WHERE TPOP.purchase_order_id = po.id
              LIMIT 1
            ) AS delivery_period

       FROM tbl_rfq_purchase_order po
       -- Old approval workflow
       LEFT JOIN tbl_approval_hierarchy_transactions trx
         ON trx.hierarchy_type = 'po'
         AND trx.target_entity_id = po.id
       -- New approval workflow
       LEFT JOIN tbl_approval_instances tai
         ON tai.id = po.approval_instance_id
       LEFT JOIN tbl_projects PD ON PD.id = po.project_id
       LEFT JOIN tbl_users trx_user ON trx_user.id = trx.current_approver_id
       -- LEFT so call-off POs (initiated_by NULL, rfq_id NULL) still load (CO5).
       LEFT JOIN tbl_users TU ON TU.id = po.initiated_by
       JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
       LEFT JOIN tbl_company VENDOR_COMPANY ON VENDOR_COMPANY.id = VENDOR.company_id
       LEFT JOIN tbl_users LOGGED_IN_USER ON LOGGED_IN_USER.id = $2
       LEFT JOIN tbl_approval_hierarchy_history TAHH ON trx.id = TAHH.approval_transaction_id AND TAHH.action = 'approved'
       LEFT JOIN tbl_company TC ON TC.id = po.company_id
       LEFT JOIN tbl_rfq RFQ ON RFQ.id = po.rfq_id
       LEFT JOIN tbl_hospitality_companies THC ON THC.id = RFQ.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels THCH ON THCH.id = RFQ.hotel_id
       WHERE po.id = $1`,
      [po_id, user_id]
    );

    const sealedPdfUrl = resolvePoPdfVisibility(result?.status, result?.po_pdf_url);
    return { ...result, po_pdf_url: sealedPdfUrl, poPdfUrl: sealedPdfUrl };
  } catch (error) {
    logError('Error in getPODetails', error);
    throw error;
  }
};

export const handleUpdatePO = async (po_id, changes, current_user) => {
  if (!po_id || !Array.isArray(changes) || changes.length <= 0) {
    throw new Error("PO Id and Changes are required to update the PO!");
  }

  const poId = Number(po_id);

  const po = await db.one(
    `SELECT * FROM tbl_rfq_purchase_order
    WHERE id = $1`,
    [poId]
  );

  // Authorization: allow edit if user is the creator or is in the PO's approval hierarchy
  const isCreator = po.initiated_by === current_user.id;

  if (!isCreator) {
    if (po.selected_hierarchy) {
      // Old approval system: check hierarchy membership
      const isUserInHierarchy = await db.oneOrNone(
        `SELECT 1 FROM tbl_approval_hierarchy
        WHERE company_id = $1
        AND hierarchy_id = $2
        AND user_id = $3`,
        [po.company_id, po.selected_hierarchy, current_user.id]
      );
      if (!isUserInHierarchy) throw new Error("Edit failed! Logged in user is not in the PO selected hierarchy");
    } else {
      throw new Error("Edit failed! Only the PO creator can edit this PO");
    }
  }

  return db.tx(async (t) => {
    // --- Buckets for updates ---
    const poUpdates = {}; // root-level PO column => latest value
    const productUpdates = {}; // rfq_item_id => { remove: bool, fields: {}, charges: {} }
    const hsnUpdates = {}; // rfq_item_id => hsn_code string

    for (const change of changes) {
      const { path, newValue } = change || {};
      if (!path) continue;

      // 1) PRODUCT changes: product[<rfq_item_id>].field / product[<rfq_item_id>].charges_meta.key
      if (path.startsWith("product[")) {
        const match = path.match(/^product\[(\d+)\]\.(.+)$/);
        if (!match) continue;

        const rfqItemId = Number(match[1]); // this maps to rfq_product_id in tbl_purchase_order_product
        const rest = match[2];

        if (!productUpdates[rfqItemId]) {
          productUpdates[rfqItemId] = {
            remove: false,
            fields: {},
            charges: {},
          };
        }

        // Special case: removal flag
        if (rest === "removed") {
          productUpdates[rfqItemId].remove = !!newValue;
          continue;
        }

        // charges_meta.<key>
        if (rest.startsWith("charges_meta.")) {
          const key = rest.split(".")[1]; // e.g. "tax", "freight_price"
          if (!key) continue;
          productUpdates[rfqItemId].charges[key] = newValue;
          continue;
        }

        // Any other field is treated as a direct column on tbl_purchase_order_product
        // e.g. quantity, unit, unit_price, total_price, future columns
        const colName = rest;
        if (!/^[a-zA-Z0-9_]+$/.test(colName)) {
          // Avoid SQL injection via column name, even though path is from our own frontend
          continue;
        }
        productUpdates[rfqItemId].fields[colName] = newValue;
        continue;
      }

      // 2) HSN changes: hsn_codes[<rfq_item_id>].code
      if (path.startsWith("hsn_codes[")) {
        const match = path.match(/^hsn_codes\[(\d+)\]\.code$/);
        if (!match) continue;

        const rfqItemId = Number(match[1]);
        hsnUpdates[rfqItemId] = newValue || ""; // empty means delete mapping
        continue;
      }

      // 3) Everything else is treated as a root-level PO column (tbl_rfq_purchase_order)
      //    e.g. "po_number", "terms_and_conditions", "gstin", or any future column.
      const col = path;
      if (!/^[a-zA-Z0-9_]+$/.test(col)) {
        continue;
      }
      poUpdates[col] = newValue;
    }

    // --- 1) Apply PO root-level updates (tbl_rfq_purchase_order) ---
    if (Object.keys(poUpdates).length > 0) {
      const cols = Object.keys(poUpdates);
      const setFragments = [];
      const values = [poId];

      cols.forEach((col, idx) => {
        // quote column name to avoid conflicts with reserved words
        setFragments.push(`"${col}" = $${idx + 2}`);
        values.push(poUpdates[col]);
      });

      const poUpdateQuery = `
        UPDATE tbl_rfq_purchase_order
        SET ${setFragments.join(", ")}
        WHERE id = $1
      `;

      await t.none(poUpdateQuery, values);
    }

    // --- 2) Apply product-level updates (tbl_purchase_order_product) ---
    // We expect one row per (purchase_order_id, rfq_product_id)
    for (const [rfqItemIdStr, info] of Object.entries(productUpdates)) {
      const rfqItemId = Number(rfqItemIdStr);
      const { remove, fields, charges } = info;

      if (remove) {
        // Delete product row from PO
        await t.none(
          `
            DELETE FROM tbl_purchase_order_product
            WHERE purchase_order_id = $1 AND rfq_product_id = $2
          `,
          [poId, rfqItemId]
        );
        continue;
      }

      const setFragments = [];
      const values = [poId, rfqItemId];
      let paramIndex = 3;

      // Direct column updates (quantity, unit, unit_price, total_price, future columns)
      for (const [colName, val] of Object.entries(fields)) {
        if (!/^[a-zA-Z0-9_]+$/.test(colName)) continue;
        setFragments.push(`"${colName}" = $${paramIndex++}`);
        values.push(val);
      }

      // charges_meta merge
      if (Object.keys(charges).length > 0) {
        setFragments.push(
          `charges_meta = COALESCE(charges_meta, '{}'::jsonb) || $${paramIndex}::jsonb`
        );
        values.push(JSON.stringify(charges));
        paramIndex++;
      }

      if (setFragments.length === 0) {
        // nothing to update for this product
        continue;
      }

      const productUpdateQuery = `
        UPDATE tbl_purchase_order_product
        SET ${setFragments.join(", ")}
        WHERE purchase_order_id = $1
          AND rfq_product_id = $2
      `;

      await t.none(productUpdateQuery, values);
    }

    // --- 2b) Server-authoritative recompute of total_price per touched
    // product, then re-aggregate the PO's total_value. The engine consumes
    // the row state AFTER the patches above were applied, so any client-
    // supplied `total_price` in the changes is silently overwritten.
    const touchedRfqItemIds = Object.entries(productUpdates)
      .filter(([, info]) => !info.remove)
      .map(([id]) => Number(id));

    for (const rfqItemId of touchedRfqItemIds) {
      const row = await t.oneOrNone(
        `SELECT quantity, unit_price, charges_meta
         FROM tbl_purchase_order_product
         WHERE purchase_order_id = $1 AND rfq_product_id = $2`,
        [poId, rfqItemId]
      );
      if (!row) continue;

      const meta = pricingEngine.normalizeChargesMeta(row.charges_meta || {});
      const lineOut = pricingEngine.calculateLineTotal({
        unit_price: row.unit_price,
        quantity: row.quantity,
        tax: meta.tax,
        tax_mode: meta.tax_mode,
        other_charges: meta.other_charges,
      });

      await t.none(
        `UPDATE tbl_purchase_order_product
         SET total_price = $1
         WHERE purchase_order_id = $2 AND rfq_product_id = $3`,
        [lineOut.total, poId, rfqItemId]
      );
    }

    // Refresh PO grand total whenever any product was touched (fields,
    // charges, or removal — covers all paths that could shift the total).
    // Grand total = sum of per-line totals + document-level global charges
    // (snapshotted onto tbl_rfq_purchase_order.global_charges at draft time).
    // Without re-applying global charges here, every PO edit would silently
    // drop them from total_value.
    if (Object.keys(productUpdates).length > 0) {
      const summed = await t.oneOrNone(
        `SELECT COALESCE(SUM(total_price), 0) AS total
         FROM tbl_purchase_order_product
         WHERE purchase_order_id = $1`,
        [poId]
      );
      const lineSubtotal = Number(summed?.total) || 0;

      const poRow = await t.oneOrNone(
        `SELECT global_charges FROM tbl_rfq_purchase_order WHERE id = $1`,
        [poId]
      );
      const rawGc = poRow?.global_charges;
      let globalCharges = [];
      if (Array.isArray(rawGc)) globalCharges = rawGc;
      else if (typeof rawGc === 'string' && rawGc.trim()) {
        try { globalCharges = JSON.parse(rawGc); } catch (_e) { globalCharges = []; }
      }
      let globalChargesTotal = 0;
      for (const gc of globalCharges) {
        const norm = pricingEngine.normalizeGlobalCharge(gc);
        if (!norm) continue;
        globalChargesTotal += pricingEngine.applyChargeMode(
          norm.amount, norm.amount_mode, lineSubtotal
        );
      }
      const grandTotal = Math.round((lineSubtotal + globalChargesTotal) * 100) / 100;

      await t.none(
        `UPDATE tbl_rfq_purchase_order SET total_value = $1 WHERE id = $2`,
        [grandTotal, poId]
      );
    }

    // --- 3) Apply HSN updates (tbl_purchase_order_hsn_mapping) ---
    for (const [rfqItemIdStr, hsnCode] of Object.entries(hsnUpdates)) {
      const rfqItemId = Number(rfqItemIdStr);

      if (!hsnCode) {
        // Empty string => delete mapping
        await t.none(
          `
            DELETE FROM tbl_purchase_order_hsn_mapping
            WHERE po_id = $1 AND rfq_item_id = $2
          `,
          [poId, rfqItemId]
        );
        continue;
      }

      // Try update first
      const updateResult = await t.result(
        `
          UPDATE tbl_purchase_order_hsn_mapping
          SET hsn_code = $1
          WHERE po_id = $2 AND rfq_item_id = $3
        `,
        [hsnCode, poId, rfqItemId]
      );

      if (updateResult.rowCount === 0) {
        // No existing row -> insert new mapping
        await t.none(
          `
            INSERT INTO tbl_purchase_order_hsn_mapping (rfq_item_id, hsn_code, po_id)
            VALUES ($1, $2, $3)
          `,
          [rfqItemId, hsnCode, poId]
        );
      }
    }

    // Log edit in old hierarchy history if it exists (non-hospitality POs)
    const txn = await t.oneOrNone(
      `SELECT * FROM tbl_approval_hierarchy_transactions WHERE hierarchy_type = 'po' AND target_entity_id = $1`,
      [po_id]
    );

    if (txn) {
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_history
        (approval_transaction_id, approved_by, action, meta)
        VALUES ($1, $2, $3, $4)`,
        [txn.id, current_user.id, 'edited', { ...poUpdates, ...productUpdates, ...hsnUpdates }]
      );
    }

    // Cancel existing approval instance before re-initiating (PO was edited, needs fresh approval)
    const existingInstance = await t.oneOrNone(
      `SELECT id, status FROM tbl_approval_instances
      WHERE entity_type = 'PO' AND entity_id = $1 AND status = 'PENDING'
      ORDER BY created_at DESC LIMIT 1`,
      [po_id]
    );

    if (existingInstance) {
      await t.none(
        `UPDATE tbl_approval_instances SET status = 'CANCELLED', completed_at = NOW() WHERE id = $1`,
        [existingInstance.id]
      );
      await t.none(
        `UPDATE tbl_approval_instance_steps SET status = 'CANCELLED', completed_at = NOW()
        WHERE approval_instance_id = $1 AND status = 'PENDING'`,
        [existingInstance.id]
      );
      await t.none(
        `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment)
        VALUES ($1, $2, 'REJECT', $3)`,
        [existingInstance.id, current_user.id, '[CANCELLED] PO edited, re-initiating approval']
      );
      // Clear the old instance reference from PO
      await t.none(
        `UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL, status = 'draft' WHERE id = $1`,
        [po_id]
      );
    }

    const result = await initiatePurchaseOrder(po_id, current_user, t);
    if(result.approval_required) {
      const purchaseOrder = await t.oneOrNone(
        `SELECT * FROM tbl_rfq_purchase_order
        WHERE id = $1`,
        [result.po_id]
      );

      if (purchaseOrder && result.current_approver_id) {
        await sendApprovalNotification(purchaseOrder, result.current_approver_id);
      }
    }

    return { success: true };
  });
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

export const updateGSTForPO = async (id, newGST) => {
  const result = await db.one(
    `UPDATE tbl_rfq_purchase_order
      SET gstin = $1
      WHERE id = $2
      RETURNING *`,
      [newGST, id]
  )

  return result;
};

export const updateHSNCode = async (po_id, hsn_codes, mapped_by) => {
  if(Array.isArray(hsn_codes) && hsn_codes.length > 0) {
    const totalResult = [];
    
    for(let hsn_code of hsn_codes) {
      const alreadyExist = await db.oneOrNone(
        `SELECT id FROM tbl_purchase_order_hsn_mapping
         WHERE rfq_item_id = $1
         AND po_id = $2`,
        [hsn_code.rfq_item_id, po_id]
      );
      if (alreadyExist) {
        const result = await db.one(
          `UPDATE tbl_purchase_order_hsn_mapping
           SET hsn_code = $1
           WHERE id = $2
           RETURNING *`,
          [hsn_code.code, alreadyExist.id]
        );
    
        totalResult.push(result);
      } else {
        const result = await db.one(
          `INSERT INTO tbl_purchase_order_hsn_mapping 
           (rfq_item_id, hsn_code, po_id, mapped_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [hsn_code.rfq_item_id, hsn_code.code, po_id, mapped_by]
        );
    
        totalResult.push(result);
      }
    }

    return totalResult;
  } else {
    return null;
  }
};

export const handleRaiseInvoice = async (po_id, invoice_url, vendor_id) => {
  return await db.tx(async t => {
    const po = await t.oneOrNone(
      `SELECT * FROM tbl_rfq_purchase_order
      WHERE id = $1`,
      [po_id]
    );

    if(!po) throw new Error('PO does not exist with given id')
    else if (po && po.finalized_vendor_id != vendor_id) throw new Error('PO does not belong to you!')

    const existing = await t.oneOrNone(
      `SELECT id FROM tbl_purchase_order_document WHERE purchase_order_id = $1 AND document_type = 'invoice'`,
      [po_id]
    );

    if(existing) {
      throw new Error("Invoice is already raised for this PO!")
    }

    const result = await t.one(
      `INSERT INTO tbl_purchase_order_document
      (purchase_order_id, document_type, document_url, uploaded_by)
      VALUES($1, 'invoice', $2, $3)
      
      RETURNING *`,
      [po_id, invoice_url, vendor_id]
    );

    await t.none(
      `UPDATE tbl_rfq_purchase_order
      SET status = 'invoice_raised'
      WHERE id = $1`,
      [po_id]
    );

    const formattedPOData = await t.one(
      `SELECT PO.*,
      TC.company_name AS finalized_vendor_name,
      TU.email AS finalized_vendor_email

      FROM tbl_rfq_purchase_order PO
      JOIN tbl_users TU ON PO.finalized_vendor_id = TU.id
      JOIN tbl_company TC ON TU.company_id = TC.id

      WHERE PO.id = $1`,
      [po_id]
    );

    const reminderUsers = await t.oneOrNone(
      `SELECT ARRAY_AGG(user_id) AS users_list
      FROM tbl_approval_hierarchy
      WHERE company_id = $1
      AND hierarchy_type = 'po'
      AND hierarchy_id = $2`,
      [po.company_id, po.selected_hierarchy]
    );

    const txn = await t.oneOrNone(
      `SELECT id FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = 'po'
      AND target_entity_id = $1`,
      [po_id]
    );

    if (txn) {
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_history
        (approval_transaction_id, approved_by, action)
        VALUES ($1, $2, $3)`,
        [txn.id, vendor_id, 'invoice']
      );
    }

    await sendInvoiceEmail(formattedPOData, invoice_url, reminderUsers?.users_list);

    return result;
  })
};

export const handleMarkGRN = async (po_id, grn_document_url, user_id, remarks) => {
  return await db.tx(async t => {
    const po = await t.oneOrNone(
      `SELECT * FROM tbl_rfq_purchase_order
      WHERE id = $1`,
      [po_id]
    );

    if(!po) throw new Error('PO does not exist with given id')

    const existing = await t.oneOrNone(
      `SELECT id FROM tbl_purchase_order_document WHERE purchase_order_id = $1 AND document_type = 'grn'`,
      [po_id]
    );

    if(existing) {
      throw new Error("GRN is already marked for this PO!")
    }

    let result = null;

    if(grn_document_url) 
      result = await t.one(
        `INSERT INTO tbl_purchase_order_document
        (purchase_order_id, document_type, document_url, uploaded_by)
        VALUES($1, 'grn', $2, $3)
        
        RETURNING *`,
        [po_id, grn_document_url, user_id]
      );

    await t.none(
      `UPDATE tbl_rfq_purchase_order
      SET status = 'GRN'
      WHERE id = $1`,
      [po_id]
    );

    const formattedPOData = await t.one(
      `SELECT PO.*,
      TC.company_name AS finalized_vendor_name,
      TU.email AS finalized_vendor_email

      FROM tbl_rfq_purchase_order PO
      JOIN tbl_users TU ON PO.finalized_vendor_id = TU.id
      JOIN tbl_company TC ON TU.company_id = TC.id

      WHERE PO.id = $1`,
      [po_id]
    );

    const reminderUsers = await t.oneOrNone(
      `SELECT ARRAY_AGG(user_id) AS users_list
      FROM tbl_approval_hierarchy
      WHERE company_id = $1
      AND hierarchy_type = 'po'
      AND hierarchy_id = $2`,
      [po.company_id, po.selected_hierarchy]
    );

    const txn = await t.oneOrNone(
      `SELECT id FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = 'po'
      AND target_entity_id = $1`,
      [po_id]
    );

    if (txn) {
      await t.none(
        `INSERT INTO tbl_approval_hierarchy_history
        (approval_transaction_id, approved_by, action, remarks)
        VALUES ($1, $2, $3, $4)`,
        [txn.id, user_id, 'grn', remarks]
      );
    }

    await sendGRNUpdationEmail(formattedPOData, grn_document_url, reminderUsers?.users_list);

    return result;
  });
};


export const handleMarkDispatched = async (po_id, vendor_id) => {
  return await db.tx(async t => {
    const po = await t.oneOrNone(
      `SELECT * FROM tbl_rfq_purchase_order
      WHERE id = $1`,
      [po_id]
    );

    if(!po) throw new Error('PO does not exist with given id')
    else if (po && po.finalized_vendor_id != vendor_id) throw new Error('PO does not belong to you!')

    await t.none(
      `UPDATE tbl_rfq_purchase_order
      SET status = 'dispatched'
      WHERE id = $1`,
      [po_id]
    );

    const formattedPOData = await t.one(
      `SELECT PO.*,
      TU.name AS finalized_vendor_name,
      TU.email AS finalized_vendor_email,
      COALESCE(TAHH.created_at, TAI.completed_at) AS po_approved_on,
      QI.delivery_period

      FROM tbl_rfq_purchase_order PO
      JOIN tbl_purchase_order_product TPOP ON TPOP.purchase_order_id = PO.id
      JOIN tbl_quote_items QI ON QI.id = TPOP.quote_id
      LEFT JOIN tbl_approval_hierarchy_transactions TAHT ON TAHT.hierarchy_type = 'po' AND TAHT.target_entity_id = PO.id
      LEFT JOIN tbl_approval_hierarchy_history TAHH ON TAHT.id = TAHH.approval_transaction_id AND TAHH.action = 'approved'
      LEFT JOIN tbl_approval_instances TAI ON TAI.id = PO.approval_instance_id AND TAI.status = 'APPROVED'
      JOIN tbl_users TU ON PO.finalized_vendor_id = TU.id
      JOIN tbl_company TC ON TU.company_id = TC.id

      WHERE PO.id = $1`,
      [po_id]
    );

    const reminderUsers = await t.oneOrNone(
      `SELECT ARRAY_AGG(user_id) AS users_list
      FROM tbl_approval_hierarchy
      WHERE company_id = $1
      AND hierarchy_type = 'po'
      AND hierarchy_id = $2`,
      [po.company_id, po.selected_hierarchy]
    );

    const grnRepData = await t.oneOrNone(
      `SELECT id, name, email, phone
      FROM tbl_token_login_data
      WHERE token_type = 'GRN'
      AND entity_id = $1`,
      [po_id]
    );
    
    await scheduleGRNReminders(formattedPOData, reminderUsers?.users_list, grnRepData);
    await sendDispatchedEmail(formattedPOData, reminderUsers?.users_list);

    return true;
  })
};

export const handleAddSiteRepresentative = async (po_id, added_by, name, email, phone) => {
  return await db.tx(async t => {
    const existing = await t.oneOrNone(
      `SELECT id FROM tbl_token_login_data
      WHERE token_type = 'GRN'
      AND entity_id = $1`,
      [po_id]
    );
    let result = null;

    const secret = process.env.WEBHOOK_SECRET;
    const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const message = `${name}_${email}_${phone}_${expires}`;

    const token = generateSignature(message, secret);

    if(existing) {
      result = await t.one(
        `UPDATE tbl_token_login_data
        SET name = $1,
        email = $2,
        phone = $3,
        added_by = $4
        token = $5
        
        WHERE id = $6
        RETURNING *`,
        [name, email, phone, added_by, token, existing.id]
      );
    } else {
      result = await t.one(
        `INSERT INTO tbl_token_login_data
        (token_type, entity_id, name, email, phone, added_by, token)
        VALUES ('GRN', $1, $2, $3, $4, $5, $6)
        
        RETURNING *`,
        [po_id, name, email, phone, added_by, token]
      );
    }

    const formattedPOData = await t.one(
      `SELECT PO.*,
      TU.name AS finalized_vendor_name,
      TU.email AS finalized_vendor_email,
      COALESCE(TAHH.created_at, TAI.completed_at) AS po_approved_on,
      QI.delivery_period

      FROM tbl_rfq_purchase_order PO
      JOIN tbl_purchase_order_product TPOP ON TPOP.purchase_order_id = PO.id
      JOIN tbl_quote_items QI ON QI.id = TPOP.quote_id
      LEFT JOIN tbl_approval_hierarchy_transactions TAHT ON TAHT.hierarchy_type = 'po' AND TAHT.target_entity_id = PO.id
      LEFT JOIN tbl_approval_hierarchy_history TAHH ON TAHT.id = TAHH.approval_transaction_id AND TAHH.action = 'approved'
      LEFT JOIN tbl_approval_instances TAI ON TAI.id = PO.approval_instance_id AND TAI.status = 'APPROVED'
      JOIN tbl_users TU ON PO.finalized_vendor_id = TU.id
      JOIN tbl_company TC ON TU.company_id = TC.id

      WHERE PO.id = $1`,
      [po_id]
    );

    await sendGRNRepresentativeEmail(formattedPOData, email, token);

    return result;
  })
};

/**
 * Regenerate PO PDF document with current approval state
 * Called after each approval action to update poApprovers section
 *
 * @param {number} po_id - Purchase Order ID
 * @param {Object} txContext - Optional transaction context
 * @returns {string|null} - New PDF URL or null on failure
 */
export const regeneratePODocument = async (po_id, txContext = null) => {
  const t = txContext || db;

  try {
    // Get RFQ context for template selection
    const poData = await t.oneOrNone(`
      SELECT
        PO.id, PO.po_number,
        PO.company_id, RFQ.hospitality_company_id, RFQ.hotel_id
      FROM tbl_rfq_purchase_order PO
      JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
      WHERE PO.id = $1
    `, [po_id]);

    if (!poData) {
      logger.error(`Cannot regenerate PO document: PO ${po_id} not found`);
      return null;
    }

    // Generate new PDF with dynamic template selection
    const pdfResult = await seoController.poPDF({
      po_id: poData.id,
      company_id: poData.company_id,
      hospitality_company_id: poData.hospitality_company_id,
      hotel_id: poData.hotel_id
    }, t);

    if (pdfResult.ok) {
      // Upload to S3 and update URL
      const s3Key = `po-${poData.po_number}-${Date.now()}.pdf`;
      const s3Url = await uploadToS3(pdfResult.absolutePath, s3Key);

      await t.none(`
        UPDATE tbl_rfq_purchase_order
        SET po_pdf_url = $1, updated_at = NOW()
        WHERE id = $2
      `, [s3Url.url || pdfResult.file, po_id]);

      logger.info(`Regenerated PO document for PO ${po_id}`);
      return s3Url.url || pdfResult.file;
    }

    return null;
  } catch (error) {
    logError(`Error regenerating PO document for PO ${po_id}`, error);
    return null;
  }
};
