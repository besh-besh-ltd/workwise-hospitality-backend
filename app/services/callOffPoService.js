import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { resolveCurrentPrice } from './arcPricingResolver.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import { dispatch as dispatchNotification } from './notificationService.js';
import { buyerMrDetail, buyerMrList } from './notificationLinks.js';
import { sendMail } from '../helper/common.js';
import pricingEngine from './pricingEngine.js';
import { normalizeArcCharges } from '../models/arc_v2/arcEvaluationModel.js';

// Phase 2 — run the pricing engine for a contract line at a given quantity.
// Shared by the per-unit landed price (qty=1) and the LINE total (qty=N) so the
// two can't diverge. The engine adds ABSOLUTE other_charges ONCE per line and
// applies percentage charges/taxes on the line subtotal (base = unit_rate × qty)
// — identical to how poTemplatePricing reconstructs the PO, so the stored
// total_price matches the template exactly (no qty-scaling of absolutes,
// no double-tax).
function computeLineEngineOut(pricingResult, quantity) {
  const { unit_rate, gst_pct, charges } = pricingResult;
  const canonicalCharges = normalizeArcCharges(charges);
  return pricingEngine.calculateLineTotal({
    unit_price:    Number(unit_rate || 0),
    quantity:      Number(quantity || 0),
    tax:           Number(gst_pct || 0),
    tax_mode:      'percentage',
    other_charges: canonicalCharges.map((c) => ({
      name:        c.name ?? null,
      amount:      Number(c.amount ?? 0),
      amount_mode: (c.amount_mode === 'percentage' || c.amount_mode === '%') ? 'percentage' : 'absolute',
      tax:         (c.tax !== null && c.tax !== undefined && c.tax !== '') ? Number(c.tax) : null,
      tax_mode:    (c.tax_mode === 'percentage' || c.tax_mode === '%') ? 'percentage' : 'absolute',
    })),
  });
}

// Per-unit landed price (qty=1) — base + per-unit charges + taxes. Display/back-compat
// only; the authoritative LINE total below always uses the real quantity.
function computeAllInUnitPrice(pricingResult) {
  return computeLineEngineOut(pricingResult, 1).total;
}

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
    `SELECT m.id, m.hospitality_company_id, m.hotel_id, m.department_id, m.raised_by,
            hc.buyer_company_id
       FROM tbl_material_requisition m
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = m.hospitality_company_id
      WHERE m.id = $1`,
    [mrId]
  );

  const today = new Date();
  const itemsWithPricing = await Promise.all(items.map(async (it) => {
    const pricing = await resolveCurrentPrice(it.arc_contract_line_id, today, txContext);
    // Price floor (audit CO13): never mint a ₹0/negative-rate call-off — that
    // signals a misconfigured contract line. Abort the release loudly instead.
    if (!(Number(pricing.unit_rate) > 0)) {
      const e = new Error(`Contract line ${it.arc_contract_line_id} has an invalid unit rate (${pricing.unit_rate}) — cannot release a call-off`);
      e.code = 'INVALID_PRICE';
      throw e;
    }
    // Phase 2 — LINE total via the engine at the REAL quantity. Absolute charges
    // are added once (not × qty) and percentage charges/taxes apply on the line
    // subtotal, so total_price reconciles with poTemplatePricing. (allInUnitPrice
    // is the qty=1 per-unit landed price, kept for display/back-compat only.)
    const lineValue = computeLineEngineOut(pricing, it.quantity).total;
    const allInUnitPrice = computeAllInUnitPrice(pricing);
    return { ...it, pricing, lineValue, allInUnitPrice };
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
        buyer_company_id:       mr?.buyer_company_id,
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
 * is_call_off) columns. Born in 'acceptance_pending' — the MR approval gates
 * RELEASE, but the vendor must still accept the call-off PO (audit decision);
 * acceptance flips it to 'approved', rejection reverses consumption + reopens
 * the MR (handleCallOffRejection).
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
 *   company_id        — the buyer's tbl_company id (hospitality_companies.buyer_company_id),
 *                       NOT the hospitality_company_id — this MUST match what regular
 *                       RFQ-backed POs store so the PO read APIs' company-scope fallback
 *                       (po.company_id = req.user.company_id, used when no hospitality
 *                       header is sent) resolves call-off POs too.
 *
 * TODO before first end-to-end smoke: confirm rfq_id can be NULL on call-off
 * rows. The current schema enforces NOT NULL — the safest follow-up is to
 * relax rfq_id (additive migration) so call-off POs are unambiguously
 * RFQ-orphan rows. Until then, callers will need to provide a sentinel RFQ id
 * or the migration must be amended.
 */
async function insertCallOffPoHeader(group, mrId, txContext) {
  const runner = txContext || db;
  // Header unit_price is the first line's BASE rate — the same convention as
  // RFQ POs (unit_price = base; tax/charges live in the line's charges_meta).
  const firstItem = group.items[0];
  const firstLineRate = Number(firstItem && firstItem.pricing && firstItem.pricing.unit_rate || 0);
  const totalQty = group.items.reduce((s, it) => s + Number(it.quantity), 0);

  const po = await runner.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, project_id, company_id, po_number, status,
        rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, initiated_by, created_at, updated_at,
        arc_contract_id, source_mr_id, is_call_off)
     VALUES
       (NULL, NULL, $1, $2, 'acceptance_pending'::public.po_status,
        '{}'::integer[], $3, $4, $5,
        $6, '{}'::integer[], $7, NOW(), NOW(),
        $8, $9, TRUE)
     RETURNING *`,
    [
      // buyer_company_id (parent tbl_company) keeps call-offs scope-consistent
      // with regular POs; fall back to hospitality_company_id only if a hosp
      // company somehow has no buyer_company_id mapping.
      group.buyer_company_id || group.hospitality_company_id,
      // Wide suffix avoids same-millisecond collisions on the same contract
      // (audit CO14); po_number is not UNIQUE-constrained so we must not collide.
      `CO-${Date.now().toString(36).toUpperCase()}-${group.arc_contract_id}-${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`,
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
 * Write tbl_purchase_order_product line rows so a call-off PO carries first-class
 * line items (audit CO7) readable by the same detail/GRN/invoice paths as RFQ
 * POs. rfq_product_id/quote_id are NULL; product_variant_id + arc_contract_line_id
 * identify the line (relaxed by migration 20260618110000).
 */
async function writeCallOffPoLines(po, group, txContext) {
  const runner = txContext || db;
  for (const it of group.items) {
    // RFQ PO convention: unit_price = BASE rate; tax/charges live in charges_meta
    // so the detail/template can re-derive the all-in total WITHOUT double-counting.
    // total_price = engine all-in line total (base + base_tax + charges + charge_taxes) × qty.
    // Storing all-in as unit_price would cause double-application of tax when the
    // template re-runs: engine(unit_price=allIn, tax=gst%) = allIn × (1 + gst%) ≠ lineValue.
    const canonicalCharges = normalizeArcCharges(it.pricing.charges);
    const chargesMeta = {
      tax:           Number(it.pricing.gst_pct || 0),
      tax_mode:      'percentage',
      other_charges: canonicalCharges,
    };
    await runner.none(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price,
          charges_meta, total_price, product_variant_id, arc_contract_line_id)
       VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8)`,
      // unit_price = BASE rate; charges_meta carries GST + per-unit charges in the
      // same shape as RFQ POs; total_price = allInUnitPrice × qty (the engine landing cost).
      [po.id, it.quantity, it.uom || null, Number(it.pricing.unit_rate),
       chargesMeta, it.lineValue, it.product_variant_id, it.arc_contract_line_id]
    );
  }
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
        // price_applied records the contracted BASE unit rate (the rate the call-off
        // was issued at). Tax/charges are PO-level and live in charges_meta; the
        // all-in landed cost is reconstructable from unit_rate + charges_meta, matching
        // how the RFQ PO convention stores and reconstructs per-line totals.
        it.pricing.unit_rate,
      ]
    );
    // Atomic over-consumption guard (audit CO4): only increment if it stays
    // within the committed quantity. rowCount 0 => the draw would exceed the
    // contract cap (e.g. a concurrent MR consumed the remainder since submit) —
    // abort the whole release so nothing is over-drawn.
    const updRes = await runner.result(
      `UPDATE tbl_arc_contract_line
         SET consumed_qty = consumed_qty + $1,
             updated_at   = NOW()
       WHERE id = $2
         AND consumed_qty + $1 <= committed_qty`,
      [it.quantity, it.arc_contract_line_id]
    );
    if (updRes.rowCount === 0) {
      const e = new Error(`Call-off would exceed the contracted quantity on contract line ${it.arc_contract_line_id}`);
      e.code = 'OVER_CONSUMPTION';
      throw e;
    }
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
    await writeCallOffPoLines(po, group, runner);
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
  const mr = await runner.oneOrNone(
    `SELECT id, mr_number, raised_by FROM tbl_material_requisition WHERE id = $1`, [mrId]
  );
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
  return {
    handled: true,
    mr_id: mrId,
    raised_by: mr?.raised_by || null,
    mr_number: mr?.mr_number || null,
    reverted_lines: links.length,
  };
}

/**
 * Notify the MR raiser that a vendor rejected their call-off PO (audit CO9).
 * Post-commit — in-app via notificationService + email. The RFQ-side
 * sendVendorRejectionNotification is skipped for call-offs (it targets
 * commercial evaluators, which a call-off has none of).
 *
 * TOTAL BY CONSTRUCTION: every step swallows its own errors, so this function
 * never rejects. That is a contract, not an accident — rejectPO AWAITS it
 * before answering (so the raiser's only notice is durable before the vendor
 * is told the rejection succeeded), and an awaited call that could throw would
 * turn a committed rejection into a 400. SMTP stays fire-and-forget so the
 * response never waits on the mail server.
 */
export async function notifyCallOffRejected({ raisedBy, mrId = null, mrNumber, poNumber, reason }) {
  if (!raisedBy) return;
  // The raiser has to act on the requisition, so name it. The caller carries
  // only the MR number today; it is unique, so it resolves the id exactly.
  let targetMrId = Number(mrId) || null;
  if (!targetMrId && mrNumber) {
    try {
      const row = await db.oneOrNone(`SELECT id FROM tbl_material_requisition WHERE mr_number = $1`, [mrNumber]);
      targetMrId = row ? Number(row.id) : null;
    } catch (err) {
      logger.error({ err, mrNumber }, '[callOffPo.notifyCallOffRejected] requisition lookup failed');
    }
  }
  try {
    await dispatchNotification({
      userIds: [Number(raisedBy)],
      category: 'mr',
      type: 'CALL_OFF_REJECTED',
      title: 'Call-off PO rejected by vendor',
      body: `The vendor rejected call-off PO ${poNumber || ''} (from requisition ${mrNumber || ''})${reason ? `: ${reason}` : ''}. The contract quantity has been released back.`,
      data: { mr_id: targetMrId, mr_number: mrNumber, po_number: poNumber, reason: reason || null },
      actionUrl: buyerMrDetail(targetMrId) || buyerMrList({ tab: 'for_me' }),
    });
  } catch (err) {
    logger.error({ err, raisedBy }, '[callOffPo.notifyCallOffRejected] in-app notify failed');
  }
  try {
    const raiser = await db.oneOrNone(`SELECT email, name FROM tbl_users WHERE id = $1`, [raisedBy]);
    if (raiser?.email) {
      sendMail({
        to: raiser.email,
        subject: `Call-off PO ${poNumber || ''} rejected by vendor`,
        html: `<p>Hello ${raiser.name || ''},</p>
               <p>The vendor has <strong>rejected</strong> call-off purchase order <strong>${poNumber || ''}</strong> raised from requisition <strong>${mrNumber || ''}</strong>${reason ? ` with the reason: <em>${reason}</em>` : ''}.</p>
               <p>The contracted quantity has been released back to the rate contract. You may raise a fresh requisition if the materials are still required.</p>`,
      }).catch((err) => logger.error({ err, raisedBy }, '[callOffPo.notifyCallOffRejected] email failed'));
    }
  } catch (err) {
    // The raiser lookup is the one step that was previously unguarded; a DB
    // blip here must not propagate now that the caller awaits this function.
    logger.error({ err, raisedBy }, '[callOffPo.notifyCallOffRejected] raiser lookup failed');
  }
}
