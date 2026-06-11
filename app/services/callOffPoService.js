import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { resolveCurrentPrice } from './arcPricingResolver.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';

/**
 * Call-off PO Service
 *
 * The post-MR-approval call-off PO path. Owns the bypass of the RFQ-style
 * approval routing in `purchaseOrderModel.initiatePurchaseOrder` — per plan
 * §5.4, the MR approval IS the approval gate, so call-off POs are created in
 * an already-issued state and dispatched directly to the vendor.
 *
 * Triggered by approvalActionService's MR post-approval hook.
 *
 * Lifecycle:
 *   1. Re-resolve each tbl_material_requisition_item's unit price via arcPricingResolver so any
 *      amendment that became live between MR submission and approval is
 *      honoured.
 *   2. Group items by arc_contract_id — one PO per (vendor × contract).
 *   3. For each group, insert a row into tbl_rfq_purchase_order with
 *      is_call_off=TRUE, arc_contract_id, source_mr_id, and status='approved'
 *      (call-off POs skip the multi-step PO approval chain entirely).
 *   4. Render the call-off PDF via helper/arc_v2/callOffPoRenderer.js (NOT the
 *      RFQ PO template).
 *   5. Write tbl_arc_callof_po link rows capturing applied_amendment_id and
 *      price_applied per item.
 *   6. Increment tbl_arc_contract_line.consumed_qty atomically.
 *   7. Dispatch vendor notification (email template detects is_call_off=TRUE
 *      and links the ARC contract).
 *   8. Update tbl_material_requisition.status = 'po_released'.
 *
 *   Never invokes initiatePurchaseOrder — that branch is RFQ-only and would
 *   incorrectly route the call-off through the awarding-approval chain.
 */

/**
 * Resolve and group MR items into vendor-contract buckets for PO creation.
 * Returns: [{ arc_contract_id, vendor_id, hospitality_company_id, items: [ {mr_item, pricing} ], total_value }]
 */
async function buildCallOffBuckets(mrId, txContext) {
  const runner = txContext || db;
  const items = await runner.any(
    `SELECT mi.id          AS mr_item_id,
            mi.product_variant_id,
            mi.quantity,
            mi.uom,
            mi.arc_contract_id,
            mi.arc_contract_line_id,
            c.vendor_id,
            c.arc_id
       FROM tbl_material_requisition_item mi
       JOIN tbl_arc_contract c ON c.id = mi.arc_contract_id
      WHERE mi.mr_id = $1`,
    [mrId]
  );
  if (items.length === 0) {
    return [];
  }

  const mr = await runner.oneOrNone(
    `SELECT id, hospitality_company_id, hotel_id, department_id, raised_by
       FROM tbl_material_requisition WHERE id = $1`,
    [mrId]
  );

  const today = new Date();
  const itemsWithPricing = await Promise.all(items.map(async (it) => {
    const pricing = await resolveCurrentPrice(it.arc_contract_line_id, today, txContext);
    const lineValue = Number(pricing.unit_rate) * Number(it.quantity);
    return { ...it, pricing, lineValue };
  }));

  // Group by arc_contract_id (one PO per vendor contract within this MR).
  const groups = new Map();
  for (const it of itemsWithPricing) {
    const key = it.arc_contract_id;
    if (!groups.has(key)) {
      groups.set(key, {
        arc_contract_id:        it.arc_contract_id,
        vendor_id:              it.vendor_id,
        arc_id:                 it.arc_id,
        hospitality_company_id: mr?.hospitality_company_id,
        hotel_id:               mr?.hotel_id,
        items:                  [],
        total_value:            0,
      });
    }
    const g = groups.get(key);
    g.items.push(it);
    g.total_value += it.lineValue;
  }
  return Array.from(groups.values());
}

/**
 * Insert the call-off PO header and return the new PO row.
 *
 * Relies on migration 8 having added (arc_contract_id, source_mr_id,
 * is_call_off) columns. Sets status to 'approved' directly — call-off POs are
 * born approved (the MR approval was the gate).
 *
 * NOTE: the existing tbl_rfq_purchase_order has several NOT-NULL columns
 * scoped to the RFQ flow (rfq_id, rfq_product_id, finalized_vendor_id,
 * quantity, unit_price, total_value, company_id). For call-off POs we satisfy
 * them with synthesised values that the PO read APIs ignore when
 * is_call_off=TRUE:
 *   rfq_id            — left NULL (relax_not_null deferred — see TODO below)
 *   rfq_product_id    — empty array '{}'
 *   finalized_vendor_id — the call-off vendor (= contract vendor)
 *   quantity          — sum of line quantities (denormalised summary)
 *   unit_price        — first line's unit_rate (denormalised summary)
 *   total_value       — sum of (qty × unit_rate)
 *   company_id        — the buyer hospitality_company_id
 *
 * TODO before first end-to-end smoke: confirm rfq_id can be NULL on call-off
 * rows. The current schema enforces NOT NULL — the safest follow-up is to
 * relax rfq_id (additive migration) so call-off POs are unambiguously
 * RFQ-orphan rows. Until then, callers will need to provide a sentinel RFQ id
 * or the migration must be amended.
 */
async function insertCallOffPoHeader(group, mrId, txContext) {
  const runner = txContext || db;
  const firstLineRate = Number(group.items[0]?.pricing?.unit_rate || 0);
  const totalQty = group.items.reduce((s, it) => s + Number(it.quantity), 0);

  const po = await runner.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, project_id, company_id, po_number, status,
        rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, initiated_by, created_at, updated_at,
        arc_contract_id, source_mr_id, is_call_off)
     VALUES
       (NULL, NULL, $1, $2, 'approved'::public.po_status,
        '{}'::integer[], $3, $4, $5,
        $6, '{}'::integer[], $7, NOW(), NOW(),
        $8, $9, TRUE)
     RETURNING *`,
    [
      group.hospitality_company_id,
      `CO-${Date.now()}-${group.arc_contract_id}`,
      totalQty,
      firstLineRate,
      group.vendor_id,
      group.total_value,
      null /* initiated_by — set by caller via update if needed */,
      group.arc_contract_id,
      mrId,
    ]
  );
  return po;
}

/**
 * Write tbl_arc_callof_po link rows for each (PO, contract line) pairing in
 * the group and atomically increment consumed_qty on the contract line.
 */
async function recordCallOffAndUpdateConsumption(po, group, txContext) {
  const runner = txContext || db;
  for (const it of group.items) {
    await runner.none(
      `INSERT INTO tbl_arc_callof_po
         (po_id, mr_id, arc_contract_id, arc_contract_line_id,
          quantity, applied_amendment_id, price_applied, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        po.id,
        po.source_mr_id,
        po.arc_contract_id,
        it.arc_contract_line_id,
        it.quantity,
        it.pricing.applied_amendment_id,
        it.pricing.unit_rate,
      ]
    );
    await runner.none(
      `UPDATE tbl_arc_contract_line
         SET consumed_qty = consumed_qty + $1,
             updated_at   = NOW()
       WHERE id = $2`,
      [it.quantity, it.arc_contract_line_id]
    );
  }
}

/**
 * Public entry point — called by approvalActionService's MR APPROVED handler.
 * Releases one or more call-off POs (one per vendor contract) for the given
 * approved MR.
 *
 * Returns: [{ po, group }] for each PO released.
 */
export async function releaseForMr(mrId, txContext = null) {
  const runner = txContext || db;
  const buckets = await buildCallOffBuckets(mrId, runner);
  if (buckets.length === 0) {
    logger.warn({ mrId }, '[callOffPo] MR has no items — skipping release');
    return [];
  }

  const released = [];
  for (const group of buckets) {
    const po = await insertCallOffPoHeader(group, mrId, runner);
    await recordCallOffAndUpdateConsumption(po, group, runner);
    released.push({ po, group });

    // TODO Phase A finish: render the call-off PDF via callOffPoRenderer,
    // upload to S3, set po.po_pdf_url, dispatch vendor notification + email
    // (the email template detects is_call_off=TRUE and links the ARC
    // contract). Until that helper lands, the PO row + link rows + consumption
    // increment are all persisted so the data audit is complete and the FE
    // can show the call-off in the vendor's order book.
    await logArcEvent({
      arcId:     group.arc_id,
      eventType: ARC_EVENT_TYPES.CALL_OFF_RELEASED,
      actorId:   null,
      payload:   { mr_id: mrId, po_id: po.id, vendor_id: group.vendor_id, total_value: group.total_value },
      txContext: runner,
    });
  }

  await runner.none(
    `UPDATE tbl_material_requisition SET status = 'po_released', updated_at = NOW() WHERE id = $1`,
    [mrId]
  );
  return released;
}

/**
 * Handler for vendor-rejected call-off POs. Reverses consumption + re-opens
 * the MR. Does NOT run the RFQ-side de-finalisation cascade (handlePORejection)
 * — that's RFQ-only.
 */
export async function handleCallOffRejection(poId, reason, txContext = null) {
  const runner = txContext || db;
  const links = await runner.any(
    `SELECT * FROM tbl_arc_callof_po WHERE po_id = $1`,
    [poId]
  );
  if (links.length === 0) {
    return { handled: false, reason: 'not_a_call_off_po' };
  }
  const mrId = links[0].mr_id;
  const arcId = (await runner.oneOrNone(
    `SELECT c.arc_id FROM tbl_arc_callof_po cp
       JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
      WHERE cp.po_id = $1 LIMIT 1`,
    [poId]
  ))?.arc_id;

  for (const link of links) {
    await runner.none(
      `UPDATE tbl_arc_contract_line
         SET consumed_qty = GREATEST(consumed_qty - $1, 0),
             updated_at   = NOW()
       WHERE id = $2`,
      [link.quantity, link.arc_contract_line_id]
    );
  }
  await runner.none(
    `UPDATE tbl_material_requisition SET status = 'approved', updated_at = NOW() WHERE id = $1`,
    [mrId]
  );

  if (arcId) {
    await logArcEvent({
      arcId,
      eventType: ARC_EVENT_TYPES.CALL_OFF_REJECTED,
      actorId:   null,
      payload:   { po_id: poId, mr_id: mrId, reason },
      txContext: runner,
    });
  }
  return { handled: true, mr_id: mrId, reverted_lines: links.length };
}
