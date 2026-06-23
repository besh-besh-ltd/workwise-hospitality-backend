import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel, { normalizeArcCharges } from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractModel from '../../models/arc_v2/arcContractModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { logger } from '../../util/logger.js';
import pricingEngine from '../../services/pricingEngine.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Phase 2 — pricing engine helpers ────────────────────────────────────────

// Map the FE display tokens ('%' / '₹') to the engine's canonical mode strings.
// The FE sends either token; the engine and DB always store 'percentage'/'absolute'.
function toEngineMode(mode) {
  if (mode === '%' || mode === 'percentage') return 'percentage';
  if (mode === '₹' || mode === 'absolute') return 'absolute';
  return 'percentage'; // safe default (legacy behaviour)
}

// Build a canonical engine line input from a vendor's quote line + ARC item
// quantity. The server RE-DERIVES quantity from tbl_arc_item (committed_qty ??
// indicative_qty) — never trusts client qty for the authoritative stored total.
function buildEngineLineInput(line, arcItem) {
  const quantity = Number(arcItem.committed_qty ?? arcItem.indicative_qty ?? 0);
  const other_charges = normalizeArcCharges(line.charges).map((c) => ({
    name:        c.name ?? null,
    amount:      Number(c.amount ?? 0),
    amount_mode: toEngineMode(c.amount_mode),
    tax:         c.tax !== null && c.tax !== undefined && c.tax !== '' ? Number(c.tax) : null,
    tax_mode:    toEngineMode(c.tax_mode),
    slug:        c.slug ?? undefined,
    comment:     c.comment ?? undefined,
  }));
  return {
    unit_price:    Number(line.rate ?? 0),
    quantity,
    tax:           Number(line.gst_pct ?? 0),
    tax_mode:      toEngineMode(line.gst_mode ?? '%'),
    other_charges,
  };
}

/**
 * ARC v2 — Vendor-side controller.
 *
 * Endpoints surfaced by app/routes/arc_v2/vendorRoutes.js:
 *   GET   /vendor/dashboard               — KPI + rollup payload for the portal home
 *   GET   /vendor/requests                — list ARC invitations + responses
 *   GET   /vendor/requests/:arcId         — detail view
 *   POST  /vendor/quote/draft             — create or update draft
 *   POST  /vendor/quote/submit            — submit (locks until submission_end)
 *   POST  /vendor/quote/withdraw          — withdraw a submitted quote pre-deadline
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

// Pre-live ARC statuses that must NEVER be exposed to vendors. The list/dashboard
// queries already exclude them (no invitation rows until float), but the detail
// and lifecycle read paths gate on an invitation row — so a leftover invitation
// could otherwise leak a non-live ARC. Defence-in-depth: 404 (do not reveal
// existence) BEFORE any invitation lookup.
const NOT_LIVE_TO_VENDOR = ['draft', 'pending_publish_approval', 'publish_rejected'];

// ── Quote eligibility + validation guards (audit H1 / H3) ──────────────────

// H1 — vendor must have been invited (tagged) to this ARC.
async function vendorInvitedToArc(arcId, vendorId) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM tbl_arc_invitation WHERE arc_id = $1 AND vendor_id = $2`,
    [arcId, vendorId]
  );
  return !!row;
}

// H1 — submitting a binding quote requires a CURRENTLY ACTIVE subscription for
// the ARC's hotel or category (lapsed/expired vendors may draft but not send).
async function vendorHasActiveSubscription(vendorId, arc) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM tbl_vendor_hotel_category_subscription
      WHERE vendor_id = $1 AND status = 'active'
        AND ((item_type = 'hotel'    AND item_id = $2)
          OR (item_type = 'category' AND item_id = $3))
      LIMIT 1`,
    [vendorId, arc.hotel_id, arc.category_id]
  );
  return !!row;
}

// H3 — any supplied rate/gst must be a non-negative number (draft tolerance:
// a still-blank rate is allowed while drafting).
function validateDraftLines(lines) {
  for (const line of (lines || [])) {
    if (line == null) continue;
    if (line.rate != null) {
      const r = Number(line.rate);
      if (!Number.isFinite(r) || r < 0) return 'Each rate must be a non-negative number';
    }
    if (line.gst_pct != null) {
      const g = Number(line.gst_pct);
      if (!Number.isFinite(g) || g < 0) return 'GST % must be a non-negative number';
    }
  }
  return null;
}

// H3 — at submit time every line must carry a valid non-negative rate.
function validateSubmittedLines(lines) {
  for (const line of lines) {
    const r = Number(line.rate);
    if (line.rate == null || !Number.isFinite(r) || r < 0) {
      return 'Every line item must have a valid non-negative rate before submitting';
    }
  }
  return null;
}

// ============================================================
// Vendor dashboard
// ============================================================

// Vendor-perspective state of one invitation. Mirrors the requests page's
// derivation so dashboard counts and the inbox always agree.
function vendorArcStatus(r) {
  if (r.contract_status === 'awaiting_acceptance' || r.contract_status === 'generated') return 'awaiting_sign';
  if (r.contract_status === 'active' || r.contract_status === 'expiring_soon') return 'active';
  if (r.contract_status === 'expired' || r.contract_status === 'terminated' || r.contract_status === 'declined') return 'past';
  if (r.arc_status === 'floated') return r.quote_submitted_at ? 'submitted' : 'open';
  const EVALUATING = new Set([
    'submission_closed', 'tech_eval_in_progress', 'tech_eval_approved', 'tech_eval_rejected',
    'comm_eval_in_progress', 'comm_eval_finalized', 'committee_review', 'committee_sent_back',
  ]);
  if (EVALUATING.has(r.arc_status)) return r.quote_submitted_at ? 'evaluating' : 'past';
  // ARC moved past committee and this vendor holds no contract → not awarded.
  return 'past';
}

// Date floor for the range selector. 'fy' = Indian financial year (Apr 1).
function rangeFloor(range) {
  const now = new Date();
  if (range === 'qtd') return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  if (range === 'fy')  return new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
  return null; // all-time
}

// Event types a vendor may see. Buyer-internal evaluation events are
// deliberately excluded; rows naming a different vendor are filtered in SQL.
const VENDOR_SAFE_EVENTS = [
  'floated', 'submission_closed', 'deadline_extended',
  'vendor_submitted', 'vendor_tech_submitted', 'vendor_withdrew', 'vendor_declined',
  'contract_generated', 'contract_awaiting_acceptance', 'contract_signed',
  'contract_active', 'contract_declined',
  'amendment_requested', 'amendment_approved', 'amendment_rejected',
  'amendment_live', 'amendment_ended',
  'amendment_awaiting_signature', 'addendum_signed', 'amendment_sign_declined',
  'expiring_soon', 'expired', 'renewed',
  'call_off_released', 'call_off_rejected',
];

export async function getVendorDashboard(req, res) {
  try {
    const vendorId = req.user?.id;
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    const range = ['qtd', 'fy', 'all'].includes(String(req.query.range)) ? String(req.query.range) : 'all';
    const floor = rangeFloor(range);

    const [invites, contracts, topProducts, recentCallOffs, perf, activity] = await Promise.all([
      // Every invitation with the vendor's own quote + contract joined in.
      db.any(
        `SELECT a.id AS arc_id, a.arc_number, a.title, a.status AS arc_status,
                a.category_id, cat.title AS category_title,
                a.hotel_id, h.name AS hotel_name,
                a.submission_end_at, a.contract_end_at,
                q.submitted_at AS quote_submitted_at,
                c.id AS contract_id, c.status AS contract_status, c.awaiting_until
           FROM tbl_arc_invitation i
           JOIN tbl_arc a ON a.id = i.arc_id
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_arc_quote q ON q.arc_id = a.id AND q.vendor_id = $1
           LEFT JOIN tbl_arc_contract c ON c.arc_id = a.id AND c.vendor_id = $1
          WHERE i.vendor_id = $1
          ORDER BY a.submission_end_at DESC NULLS LAST`,
        [vendorId]
      ),
      // Active contracts with the enriched aggregates (committed/consumed/…).
      arcContractModel.listForVendor(vendorId, ['active', 'expiring_soon']),
      // Top products supplied, by committed value on active contracts.
      db.any(
        `SELECT pv.name AS variant_name, ai.uom,
                SUM(cl.unit_rate * cl.committed_qty)::numeric AS value,
                SUM(cl.unit_rate * cl.consumed_qty)::numeric  AS consumed
           FROM tbl_arc_contract_line cl
           JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
           JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
          WHERE c.vendor_id = $1 AND c.status IN ('active','expiring_soon')
          GROUP BY pv.name, ai.uom
          ORDER BY value DESC
          LIMIT 5`,
        [vendorId]
      ),
      // Last 5 call-off POs received.
      db.any(
        `SELECT cp.po_id, po.po_number, po.status AS po_status,
                cp.quantity, cp.price_applied, cp.released_at, cp.arc_contract_id,
                (cp.quantity * cp.price_applied)::numeric AS value,
                pv.name AS variant_name, ai.uom
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id AND c.vendor_id = $1
           JOIN tbl_arc_contract_line cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
          ORDER BY cp.released_at DESC
          LIMIT 5`,
        [vendorId]
      ),
      // Fulfilment performance over the selected range — computed, not mocked.
      db.one(
        `SELECT COUNT(*)::int AS total_call_offs,
                COUNT(*) FILTER (WHERE po.status IN ('GRN','completed','invoice_raised'))::int AS delivered,
                COUNT(*) FILTER (WHERE po.status IN ('rejected','rejected_by_vendor','cancelled'))::int AS rejected,
                COALESCE(SUM(cp.quantity * cp.price_applied), 0)::numeric AS call_off_value
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
          WHERE c.vendor_id = $1
            AND ($2::timestamp IS NULL OR cp.released_at >= $2)`,
        [vendorId, floor]
      ),
      // Vendor-safe activity: whitelisted event types on ARCs this vendor is
      // part of; rows that name another vendor are excluded.
      db.any(
        `SELECT e.event_type, e.payload, e.at,
                a.id AS arc_id, a.arc_number, a.title
           FROM tbl_arc_event_log e
           JOIN tbl_arc a ON a.id = e.arc_id
          WHERE e.arc_id IN (
                  SELECT arc_id FROM tbl_arc_invitation WHERE vendor_id = $1
                  UNION
                  SELECT arc_id FROM tbl_arc_contract  WHERE vendor_id = $1
                )
            AND e.event_type = ANY($2::varchar[])
            AND (e.payload->>'vendor_id' IS NULL OR (e.payload->>'vendor_id')::bigint = $1)
          ORDER BY e.at DESC
          LIMIT 8`,
        [vendorId, VENDOR_SAFE_EVENTS]
      ),
    ]);

    // ── counts + needs-action from the invitation set ───────────────────
    const counts = { open: 0, submitted: 0, evaluating: 0, awaiting_sign: 0, active: 0, past: 0 };
    const needsAction = [];
    for (const r of invites) {
      const s = vendorArcStatus(r);
      counts[s] = (counts[s] || 0) + 1;
      if (['awaiting_sign', 'open', 'submitted', 'evaluating'].includes(s)) {
        needsAction.push({
          arc_id: r.arc_id, contract_id: r.contract_id, arc_number: r.arc_number,
          title: r.title, category_title: r.category_title, hotel_name: r.hotel_name,
          status: s, submission_end_at: r.submission_end_at, awaiting_until: r.awaiting_until,
        });
      }
    }
    const PRIORITY = { awaiting_sign: 0, open: 1, submitted: 2, evaluating: 3 };
    needsAction.sort((a, b) => (PRIORITY[a.status] - PRIORITY[b.status]) ||
      (new Date(a.submission_end_at || 0) - new Date(b.submission_end_at || 0)));
    const nextAction = needsAction.find((x) => x.status === 'awaiting_sign')
      || needsAction.find((x) => x.status === 'open')
      || null;

    // ── value rollups from active contracts ─────────────────────────────
    let awardedValue = 0, consumedValue = 0;
    const byCategory = new Map(), byBu = new Map();
    for (const c of contracts) {
      const committed = Number(c.committed_value || 0);
      awardedValue += committed;
      consumedValue += Number(c.consumed_value || 0);
      const cat = c.category_title || 'Uncategorised';
      byCategory.set(cat, (byCategory.get(cat) || 0) + committed);
      const buKey = String(c.hotel_id ?? '—');
      const bu = byBu.get(buKey) || { hotel_id: c.hotel_id, hotel_name: c.hotel_name || '—', value: 0 };
      bu.value += committed;
      byBu.set(buKey, bu);
    }

    return ok(res, {
      range,
      counts,
      totals: {
        awarded_value: awardedValue,
        consumed_value: consumedValue,
        call_off_count: perf.total_call_offs,
        call_off_value: Number(perf.call_off_value || 0),
      },
      next_action: nextAction,
      needs_action: needsAction,
      spend_by_category: Array.from(byCategory.entries())
        .map(([category_title, value]) => ({ category_title, value }))
        .sort((a, b) => b.value - a.value),
      spend_by_bu: Array.from(byBu.values()).sort((a, b) => b.value - a.value),
      top_products: topProducts,
      recent_call_offs: recentCallOffs,
      activity,
      performance: {
        total_call_offs: perf.total_call_offs,
        delivered: perf.delivered,
        delivered_pct: perf.total_call_offs ? Math.round((perf.delivered / perf.total_call_offs) * 100) : null,
        accepted_pct: perf.total_call_offs ? Math.round(((perf.total_call_offs - perf.rejected) / perf.total_call_offs) * 100) : null,
        call_off_value: Number(perf.call_off_value || 0),
      },
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.getVendorDashboard]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function listRequests(req, res) {
  try {
    const vendorId = req.user?.id;
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    // ARCs the vendor was invited to (invitation-only) OR all open ARCs the
    // vendor is eligible for. For now we just surface invitations; an
    // "open ARC" surface can be added once the eligibility query is wired.
    const rows = await db.any(
      `SELECT a.id, a.arc_number, a.title, a.status, a.category_id, a.hotel_id,
              a.submission_start_at, a.submission_end_at,
              i.status AS invitation_status, i.invited_at, i.responded_at,
              q.id AS quote_id, q.submitted_at AS quote_submitted_at
         FROM tbl_arc a
         JOIN tbl_arc_invitation i ON i.arc_id = a.id AND i.vendor_id = $1
         LEFT JOIN tbl_arc_quote q ON q.arc_id = a.id AND q.vendor_id = $1
        WHERE a.status IN ('floated','submission_closed','tech_eval_in_progress','comm_eval_in_progress','committee_review','committee_approved','awaiting_vendor_acceptance','contract_active')
        ORDER BY a.submission_end_at`,
      [vendorId]
    );
    return ok(res, { requests: rows });
  } catch (err) {
    logger.error({ err }, '[vendorController.listRequests]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getRequestDetail(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.params.arcId);
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    const items = await arcModel.listItems(arcId);
    const invitation = await db.oneOrNone(
      `SELECT * FROM tbl_arc_invitation WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, vendorId]
    );
    const quote = await db.oneOrNone(
      `SELECT * FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, vendorId]
    );
    const lines = quote ? await arcEvalModel.listQuoteLines(quote.id) : [];
    // Lightweight technical-envelope status so the vendor page can show whether
    // a technical envelope is required, sealed, and how many clauses are drafted
    // — without the full clause payload (that comes from the dedicated GET).
    const techRequired = await arcEvalModel.arcHasTechClauses(arcId);
    let tech_envelope = null;
    if (techRequired) {
      // Phase 1 §B — reuse extracted model method (also used by seal guard).
      const counts = await arcEvalModel.techEnvelopeCounts(arcId, vendorId);
      tech_envelope = {
        required: true,
        tech_submitted_at: quote?.tech_submitted_at || null,
        clauses_total: counts.clauses_total,
        clauses_answered: counts.clauses_answered,
      };
    } else {
      tech_envelope = { required: false, tech_submitted_at: null, clauses_total: 0, clauses_answered: 0 };
    }
    // Mark invitation viewed if not yet (silent best-effort).
    if (invitation && invitation.status === 'invited') {
      await arcModel.recordVendorResponse(arcId, vendorId, 'viewed');
      await logArcEvent({ arcId, eventType: ARC_EVENT_TYPES.VENDOR_VIEWED, actorId: vendorId, payload: {} });
    }
    return ok(res, { arc, items, invitation, quote, lines, tech_envelope });
  } catch (err) {
    logger.error({ err }, '[vendorController.getRequestDetail]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/quote/accept-terms  body: { arc_id }
// Phase 1 §3 — persist the T&C acceptance timestamp. Idempotent.
export async function acceptTerms(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.body?.arc_id);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!arcId) return bad(res, 400, 'arc_id is required');
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    if (!['floated', 'submission_closed'].includes(arc.status)) {
      return bad(res, 409, `Rate contract is not open for new responses (status=${arc.status})`);
    }
    if (arc.submission_end_at && new Date(arc.submission_end_at) < new Date()) {
      return bad(res, 409, 'Submission deadline has passed');
    }
    if (!(await vendorInvitedToArc(arcId, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    const result = await arcEvalModel.acceptTerms(arcId, vendorId);
    return ok(res, { terms_accepted_at: result.terms_accepted_at }, 'Terms accepted');
  } catch (err) {
    logger.error({ err }, '[vendorController.acceptTerms]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/quote/preview  body: { arc_id, lines: [...], global_charges?: [...] }
// Phase 2 — engine-driven stateless preview. Server re-derives qty from
// tbl_arc_item (never trusts client qty). Returns authoritative per-line
// engine output + document totals. Does NOT persist anything.
export async function previewQuote(req, res) {
  try {
    const vendorId = req.user?.id;
    const { arc_id, lines = [], global_charges = [] } = req.body || {};
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!arc_id) return bad(res, 400, 'arc_id is required');
    const arc = await arcModel.getById(arc_id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    // Must be an invited vendor (H1 — never trust client vendor ids).
    if (!(await vendorInvitedToArc(arc_id, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    // Load items to derive quantities server-side.
    const arcItems = await arcModel.listItems(arc_id);
    const itemById = Object.fromEntries(arcItems.map((i) => [Number(i.id), i]));
    // Build engine input for each line. Lines referencing unknown items are skipped.
    const engineLines = [];
    const lineMap = []; // keep order for the response
    for (const line of (lines || [])) {
      const arcItem = itemById[Number(line.arc_item_id)];
      if (!arcItem) continue; // unknown item — skip silently (cross-ARC tamper)
      const input = buildEngineLineInput(line, arcItem);
      engineLines.push(input);
      lineMap.push({ arc_item_id: Number(line.arc_item_id), input });
    }
    // Run the engine (pure, no I/O).
    const result = pricingEngine.calculateDocumentTotals(engineLines, global_charges || []);
    // Shape the per-line response: attach arc_item_id for the FE to correlate.
    const linesOut = result.lines.map((l, idx) => ({
      arc_item_id:   lineMap[idx]?.arc_item_id ?? null,
      base:          l.base,
      base_tax:      l.base_tax,
      charges:       l.charges,
      charges_total: l.charges_total,
      total:         l.total,
    }));
    return ok(res, {
      lines:               linesOut,
      grand_subtotal:      result.grand_subtotal,
      global_charges:      result.global_charges,
      global_charges_total: result.global_charges_total,
      grand_total:         result.grand_total,
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.previewQuote]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function saveQuoteDraft(req, res) {
  try {
    const vendorId = req.user?.id;
    const { arc_id, payment_terms, gstin_used, lines } = req.body || {};
    if (!arc_id) return bad(res, 400, 'arc_id is required');
    const arc = await arcModel.getById(arc_id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (!['floated','submission_closed'].includes(arc.status)) {
      return bad(res, 409, `ARC not open for quotes (status=${arc.status})`);
    }
    // H1 — only invited vendors may quote.
    if (!(await vendorInvitedToArc(arc_id, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    // H2 — enforce the submission deadline on draft-save too (not just submit).
    if (arc.submission_end_at && new Date(arc.submission_end_at) < new Date()) {
      return bad(res, 409, 'Submission deadline has passed');
    }
    // H3 — reject malformed rates before persisting anything.
    const draftLineErr = validateDraftLines(lines);
    if (draftLineErr) return bad(res, 400, draftLineErr);
    // M8 — every line must reference an item that belongs to THIS ARC.
    const arcItemIds = (await arcModel.listItems(arc_id)).map((i) => Number(i.id));
    for (const line of (lines || [])) {
      if (line?.arc_item_id != null && !arcItemIds.includes(Number(line.arc_item_id))) {
        return bad(res, 400, 'A quote line references an item that does not belong to this rate contract');
      }
    }
    // Phase 2 — compute engine output (server-authoritative). Qty re-derived from
    // tbl_arc_item; never stored from client totals. Partial drafts (missing rate)
    // get a 0-valued engine output (engine returns {base:0,...,total:0} when
    // unit_price is 0 or missing), which is fine for a draft.
    const arcItemsForEngine = await arcModel.listItems(arc_id);
    const itemByIdForEngine = Object.fromEntries(arcItemsForEngine.map((i) => [Number(i.id), i]));
    const engineLineInputs = (lines || []).map((line) => {
      const arcItem = itemByIdForEngine[Number(line.arc_item_id)];
      if (!arcItem) return null;
      return { arcItemId: Number(line.arc_item_id), input: buildEngineLineInput(line, arcItem) };
    }).filter(Boolean);
    const engineInputsOnly = engineLineInputs.map((x) => x.input);
    const engineResult = pricingEngine.calculateDocumentTotals(engineInputsOnly, []);
    // Map engine line output back to arc_item_id.
    const engineLineByItemId = {};
    engineLineInputs.forEach((x, idx) => {
      engineLineByItemId[x.arcItemId] = engineResult.lines[idx];
    });
    const quotePricing = {
      grand_subtotal:      engineResult.grand_subtotal,
      global_charges:      engineResult.global_charges,
      global_charges_total: engineResult.global_charges_total,
      grand_total:         engineResult.grand_total,
    };

    return db.tx(async (t) => {
      const quote = await arcEvalModel.upsertQuote(arc_id, vendorId,
        { payment_terms, gstin_used, quote_pricing: quotePricing }, t);
      const upserted = [];
      for (const line of (lines || [])) {
        const engineLineOut = engineLineByItemId[Number(line.arc_item_id)];
        const linePricing = engineLineOut
          ? { base: engineLineOut.base, base_tax: engineLineOut.base_tax,
              charges: engineLineOut.charges, charges_total: engineLineOut.charges_total,
              total: engineLineOut.total }
          : undefined;
        // Normalize charges to engine-canonical array before persisting.
        const canonicalCharges = normalizeArcCharges(line.charges).map((c) => ({
          name:        c.name ?? null,
          amount:      Number(c.amount ?? 0),
          amount_mode: toEngineMode(c.amount_mode),
          tax:         c.tax !== null && c.tax !== undefined && c.tax !== '' ? Number(c.tax) : null,
          tax_mode:    toEngineMode(c.tax_mode),
          ...(c.slug !== undefined ? { slug: c.slug } : {}),
          ...(c.comment !== undefined && c.comment !== null ? { comment: c.comment } : {}),
        }));
        upserted.push(await arcEvalModel.upsertQuoteLine(quote.id,
          { ...line, charges: canonicalCharges, line_pricing: linePricing }, t));
      }
      return ok(res, { quote, lines: upserted });
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.saveQuoteDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function submitQuote(req, res) {
  try {
    const vendorId = req.user?.id;
    const { arc_id } = req.body || {};
    if (!arc_id) return bad(res, 400, 'arc_id is required');
    const arc = await arcModel.getById(arc_id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (arc.status !== 'floated') return bad(res, 409, `ARC not floated (status=${arc.status})`);
    if (arc.submission_end_at && new Date(arc.submission_end_at) < new Date()) {
      return bad(res, 409, 'Submission deadline has passed');
    }
    // H1 — only invited vendors with a CURRENTLY ACTIVE subscription may submit.
    if (!(await vendorInvitedToArc(arc_id, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    if (!(await vendorHasActiveSubscription(vendorId, arc))) {
      return bad(res, 403, 'Your subscription is not active — renew it to submit a quote');
    }
    const quote = await db.oneOrNone(
      `SELECT * FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arc_id, vendorId]
    );
    if (!quote) return bad(res, 400, 'No draft quote to submit');
    // HARD BLOCK (RESOLVED DECISION 1) — strict two-step. When this ARC requires
    // technical responses (has clauses configured), the vendor MUST seal their
    // technical envelope before the commercial quote can be submitted. The seal
    // marker is tech_submitted_at on the same arc_quote row.
    if (await arcEvalModel.arcHasTechClauses(arc_id)) {
      if (!quote.tech_submitted_at) {
        return bad(res, 409, 'Submit your technical envelope before submitting the commercial quote');
      }
    }
    // H3 — completeness: at least one line, each with a valid non-negative rate.
    const quoteLines = await arcEvalModel.listQuoteLines(quote.id);
    if (quoteLines.length === 0) return bad(res, 400, 'Quote has no line items');
    const submitLineErr = validateSubmittedLines(quoteLines);
    if (submitLineErr) return bad(res, 400, submitLineErr);

    // Phase 2 — recompute engine output on submit (authoritative). Qty from DB, not client.
    const arcItemsForSubmit = await arcModel.listItems(arc_id);
    const itemByIdForSubmit = Object.fromEntries(arcItemsForSubmit.map((i) => [Number(i.id), i]));
    const submitEngineInputs = quoteLines.map((ql) => {
      const arcItem = itemByIdForSubmit[Number(ql.arc_item_id)];
      if (!arcItem) return null;
      // quoteLines come from DB — charges are already canonical engine arrays after draft-save.
      return { arcItemId: Number(ql.arc_item_id), input: buildEngineLineInput(ql, arcItem) };
    }).filter(Boolean);
    const submitEngineResult = pricingEngine.calculateDocumentTotals(
      submitEngineInputs.map((x) => x.input), []
    );
    const submitQuotePricing = {
      grand_subtotal:       submitEngineResult.grand_subtotal,
      global_charges:       submitEngineResult.global_charges,
      global_charges_total: submitEngineResult.global_charges_total,
      grand_total:          submitEngineResult.grand_total,
    };
    const submitLineByItemId = {};
    submitEngineInputs.forEach((x, idx) => {
      submitLineByItemId[x.arcItemId] = submitEngineResult.lines[idx];
    });

    return db.tx(async (t) => {
      // Store authoritative quote_pricing on submit.
      await t.none(
        `UPDATE tbl_arc_quote SET quote_pricing = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(submitQuotePricing), quote.id]
      );
      // Store authoritative line_pricing per line.
      for (const ql of quoteLines) {
        const engineLineOut = submitLineByItemId[Number(ql.arc_item_id)];
        if (!engineLineOut) continue;
        const lp = { base: engineLineOut.base, base_tax: engineLineOut.base_tax,
                     charges: engineLineOut.charges, charges_total: engineLineOut.charges_total,
                     total: engineLineOut.total };
        await t.none(
          `UPDATE tbl_arc_quote_line SET line_pricing = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [JSON.stringify(lp), ql.id]
        );
      }
      const updated = await arcEvalModel.submitQuote(quote.id, t);
      await arcModel.recordVendorResponse(arc_id, vendorId, 'submitted', t);
      await logArcEvent({
        arcId: arc_id, eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
        actorId: vendorId, payload: { quote_id: quote.id }, txContext: t,
      });
      return ok(res, { quote: updated }, 'Quote submitted');
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.submitQuote]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function withdrawQuote(req, res) {
  try {
    const vendorId = req.user?.id;
    const { arc_id } = req.body || {};
    const arc = await arcModel.getById(arc_id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (arc.submission_end_at && new Date(arc.submission_end_at) < new Date()) {
      return bad(res, 409, 'Submission deadline has passed — cannot withdraw');
    }
    const quote = await db.oneOrNone(
      `UPDATE tbl_arc_quote SET withdrawn_at = CURRENT_TIMESTAMP
        WHERE arc_id = $1 AND vendor_id = $2 RETURNING *`,
      [arc_id, vendorId]
    );
    await arcModel.recordVendorResponse(arc_id, vendorId, 'declined');
    await logArcEvent({
      arcId: arc_id, eventType: ARC_EVENT_TYPES.VENDOR_WITHDREW,
      actorId: vendorId, payload: { quote_id: quote?.id },
    });
    return ok(res, { quote }, 'Quote withdrawn');
  } catch (err) {
    logger.error({ err }, '[vendorController.withdrawQuote]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Technical envelope (two-envelope flow) — vendor self-submission
//
// SECURITY: every endpoint below derives the vendor scope from req.user.id
// (never the body). A vendor may ONLY touch an ARC they are invited to and
// ONLY their OWN responses/files. Clause text is visible only to invited
// vendors within the open submission window.
// ============================================================

const TECH_EVIDENCE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const TECH_EVIDENCE_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const TECH_EVIDENCE_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx']);

/**
 * Shared scope guard for every tech-envelope write/read. Resolves the ARC,
 * verifies the caller is invited, and (for writes) that the submission window
 * is open and the envelope is not already sealed. Returns
 * { arc, quote } on success or { error: {status, message} } to surface.
 */
async function loadTechEnvelopeScope(arcId, vendorId, { forWrite = false } = {}) {
  if (!vendorId) return { error: { status: 401, message: 'Unauthorized' } };
  if (!arcId) return { error: { status: 400, message: 'arc_id is required' } };
  const arc = await arcModel.getById(arcId);
  if (!arc) return { error: { status: 404, message: 'ARC not found', code: 2 } };
  // Invitation is the authority — never widen access from a client id.
  if (!(await vendorInvitedToArc(arcId, vendorId))) {
    return { error: { status: 403, message: 'You were not invited to this rate contract' } };
  }
  const quote = await arcEvalModel.getQuote(arcId, vendorId);
  if (forWrite) {
    if (!['floated', 'submission_closed'].includes(arc.status)) {
      return { error: { status: 409, message: `Rate contract is not open for technical responses (status=${arc.status})` } };
    }
    if (arc.submission_end_at && new Date(arc.submission_end_at) < new Date()) {
      return { error: { status: 409, message: 'Submission deadline has passed' } };
    }
    if (quote?.tech_submitted_at) {
      return { error: { status: 409, message: 'Technical envelope already submitted' } };
    }
  }
  return { arc, quote };
}

// GET /vendor/requests/:arcId/tech-clauses
// Returns per-item clauses + this vendor's own draft responses + uploaded
// files + the seal marker. NEVER returns buyer_marks / mandatory verdicts /
// other vendors' rows.
export async function getTechClausesForVendor(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.params.arcId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    if (!(await vendorInvitedToArc(arcId, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    const quote = await arcEvalModel.getQuote(arcId, vendorId);
    const { clauses, filesByResponse } = await arcEvalModel.getVendorTechEnvelope(arcId, vendorId);

    // Group clauses by item.
    const itemsMap = new Map();
    for (const c of clauses) {
      const k = Number(c.arc_item_id);
      if (!itemsMap.has(k)) {
        itemsMap.set(k, { arc_item_id: k, minimum_passing_score: c.minimum_passing_score, clauses: [] });
      }
      itemsMap.get(k).clauses.push({
        clause_id: Number(c.clause_id),
        clause_text: c.clause_text,
        clause_type: c.clause_type,
        weightage: c.weightage,
        is_mandatory: !!c.is_mandatory,
        vendor_response: c.vendor_response ?? null,
        files: (filesByResponse[Number(c.response_id)] || []).map((f) => ({
          file_id: Number(f.file_id),
          // Vendor-scoped, ownership-checked proxy URL — NOT the raw S3 url.
          url: `/arc-v2/vendor/tech-envelope/file/${f.file_id}`,
          original_name: f.original_name || null,
        })),
      });
    }
    return ok(res, {
      tech_submitted_at: quote?.tech_submitted_at || null,
      window_open: ['floated', 'submission_closed'].includes(arc.status)
        && !(arc.submission_end_at && new Date(arc.submission_end_at) < new Date()),
      items: [...itemsMap.values()],
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.getTechClausesForVendor]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/tech-envelope/draft  body: { arc_id, responses:[{clause_id, vendor_response}] }
export async function saveTechEnvelopeDraft(req, res) {
  try {
    const vendorId = req.user?.id;
    const { arc_id, responses } = req.body || {};
    const arcId = Number(arc_id);
    const scope = await loadTechEnvelopeScope(arcId, vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    if (!Array.isArray(responses) || responses.length === 0) {
      return bad(res, 400, 'responses[] is required');
    }
    const clauseIds = responses.map((r) => Number(r.clause_id)).filter(Boolean);
    if (clauseIds.length === 0) return bad(res, 400, 'Each response needs a clause_id');
    // Cross-ARC clause ids are rejected outright (never trust client ids).
    const valid = new Set(await arcEvalModel.clauseIdsBelongToArc(arcId, clauseIds));
    for (const cid of clauseIds) {
      if (!valid.has(Number(cid))) {
        return bad(res, 400, 'A response references a clause that does not belong to this rate contract');
      }
    }
    const saved = await db.tx(async (t) => {
      let n = 0;
      for (const r of responses) {
        // Vendor isolation: ALWAYS scoped to req.user.id.
        await arcEvalModel.saveVendorTechResponse(Number(r.clause_id), vendorId, r.vendor_response ?? null, t);
        n += 1;
      }
      return n;
    });
    return ok(res, { saved });
  } catch (err) {
    logger.error({ err }, '[vendorController.saveTechEnvelopeDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/tech-envelope/clause/:clauseId/file  (multipart, field 'file')
export async function uploadTechEvidence(req, res) {
  let tmpPath = null;
  try {
    const vendorId = req.user?.id;
    const clauseId = Number(req.params.clauseId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!clauseId) return bad(res, 400, 'clauseId is required');
    if (!req.file) return bad(res, 400, 'A file is required (field name: file)');

    // Resolve the ARC from the clause and run the full write-scope guard.
    const arcId = await arcLifecycleModelGetArcIdForClause(clauseId);
    if (!arcId) return bad(res, 404, 'Clause not found', 2);
    const scope = await loadTechEnvelopeScope(arcId, vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    // Clause must belong to THIS ARC (defensive — getArcIdForClause already
    // bound it, but re-verify rather than trust the chain).
    const valid = await arcEvalModel.clauseIdsBelongToArc(arcId, [clauseId]);
    if (valid.length === 0) return bad(res, 400, 'Clause does not belong to this rate contract');

    // File validation — size + MIME + extension allow-list.
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (req.file.size > TECH_EVIDENCE_MAX_BYTES) {
      return bad(res, 400, 'File exceeds the 15 MB limit');
    }
    if (!TECH_EVIDENCE_MIME.has(req.file.mimetype) && !TECH_EVIDENCE_EXT.has(ext)) {
      return bad(res, 400, 'Unsupported file type — allowed: pdf, jpg, png, doc, docx');
    }

    // Persist the buffer to a temp file and upload to S3 under a tech-evidence
    // prefix. The DB stores only the S3 url; access is served through the
    // ownership-checked proxy (never a raw public link in the UI).
    const safeExt = TECH_EVIDENCE_EXT.has(ext) ? ext : '.bin';
    tmpPath = path.join(os.tmpdir(), `arc-tech-evidence-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    fs.writeFileSync(tmpPath, req.file.buffer);
    const s3Key = `arc-tech-evidence/${arcId}/${vendorId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    const up = await uploadToS3(tmpPath, s3Key);
    if (!up?.ok || !up?.url) return bad(res, 502, 'File upload failed — please retry', 3);

    // Sanitise the original filename to a safe length (never changes validation).
    const sanitisedOriginalName = (req.file.originalname || "").slice(0, 255) || null;
    const file = await db.tx(async (t) => {
      // Ensure a response row exists so the file can attach (vendor-scoped).
      const row = await arcEvalModel.ensureVendorResponseRow(clauseId, vendorId, t);
      return arcEvalModel.addVendorResponseFile(row.id, up.url, sanitisedOriginalName, t);
    });
    return ok(res, {
      file: {
        file_id: Number(file.id),
        url: `/arc-v2/vendor/tech-envelope/file/${file.id}`,
        original_name: file.original_name || null,
      },
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.uploadTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  } finally {
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
  }
}

// DELETE /vendor/tech-envelope/file/:fileId  (own file only, before seal)
export async function deleteTechEvidence(req, res) {
  try {
    const vendorId = req.user?.id;
    const fileId = Number(req.params.fileId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!fileId) return bad(res, 400, 'fileId is required');
    // Resolve owner + ARC; verify ownership and that the envelope isn't sealed.
    const file = await arcEvalModel.getResponseFileWithScope(fileId);
    if (!file) return bad(res, 404, 'File not found', 2);
    if (Number(file.vendor_id) !== Number(vendorId)) {
      return bad(res, 403, 'You can only remove your own evidence files');
    }
    const scope = await loadTechEnvelopeScope(Number(file.arc_id), vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    const deleted = await arcEvalModel.deleteVendorResponseFile(fileId, vendorId);
    if (!deleted) return bad(res, 404, 'File not found', 2);
    return ok(res, { deleted: { file_id: Number(deleted.id) } });
  } catch (err) {
    logger.error({ err }, '[vendorController.deleteTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// GET /vendor/tech-envelope/file/:fileId  — vendor downloads their OWN evidence.
// Ownership-checked server-side proxy (no raw S3 URL). A vendor can ONLY fetch
// a file attached to their own response row (file.vendor_id === req.user.id).
export async function getOwnTechEvidence(req, res) {
  try {
    const vendorId = req.user?.id;
    const fileId = Number(req.params.fileId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!fileId) return bad(res, 400, 'fileId is required');
    const file = await arcEvalModel.getResponseFileWithScope(fileId);
    if (!file) return bad(res, 404, 'File not found', 2);
    if (Number(file.vendor_id) !== Number(vendorId)) {
      return bad(res, 403, 'You can only access your own evidence files');
    }
    const resp = await axios.get(file.file_url, {
      responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024,
    });
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="evidence-${fileId}"`);
    return res.status(200).send(Buffer.from(resp.data));
  } catch (err) {
    logger.error({ err }, '[vendorController.getOwnTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/tech-envelope/submit  body: { arc_id }
export async function submitTechEnvelope(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.body?.arc_id);
    const scope = await loadTechEnvelopeScope(arcId, vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    // There must be a technical envelope to seal (the ARC has clauses).
    if (!(await arcEvalModel.arcHasTechClauses(arcId))) {
      return bad(res, 400, 'This rate contract has no technical clauses to submit');
    }
    // Phase 1 §B — server-side completeness guard (defence-in-depth; FE gate is primary).
    const counts = await arcEvalModel.techEnvelopeCounts(arcId, vendorId);
    if (counts.clauses_total > 0 && counts.clauses_answered < counts.clauses_total) {
      return bad(res, 409,
        `Respond to all clauses before sealing — ${counts.clauses_answered} of ${counts.clauses_total} answered`
      );
    }
    const result = await db.tx(async (t) => {
      const sealed = await arcEvalModel.sealTechEnvelope(arcId, vendorId, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED,
        actorId: vendorId, payload: { vendor_id: vendorId }, txContext: t,
      });
      return sealed;
    });
    return ok(res, { tech_submitted_at: result.tech_submitted_at }, 'Technical envelope submitted');
  } catch (err) {
    logger.error({ err }, '[vendorController.submitTechEnvelope]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Thin wrapper so the upload handler can resolve the ARC from a clause without
// importing the lifecycle model at module top (kept local to the tech-envelope
// block). Uses the eval model's own ownership-safe join chain.
async function arcLifecycleModelGetArcIdForClause(clauseId) {
  const row = await db.oneOrNone(
    `SELECT i.arc_id
       FROM tbl_arc_item_tech_evaluation_clauses c
       JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
       JOIN tbl_arc_item i ON i.id = te.arc_item_id
      WHERE c.id = $1`,
    [clauseId]
  );
  return row ? Number(row.arc_id) : null;
}

// GET /vendor/requests/:arcId/lifecycle
// Server-computed stages projected for the vendor's role. Scope is derived
// from req.user.id; the vendor must be invited; NO buyer-internal counts or
// other-vendor data is returned.
export async function getRequestLifecycle(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.params.arcId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    // Never expose a pre-live ARC's lifecycle (404, do not reveal existence) —
    // even if a stale invitation row exists.
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    if (!(await vendorInvitedToArc(arcId, vendorId)))
      return bad(res, 403, 'You were not invited to this rate contract');
    const lifecycle = await arcLifecycleModel.computeLifecycle(arcId, { lazyFlip: true });
    if (!lifecycle) return bad(res, 404, 'ARC not found', 2);
    const projected = await arcEvalModel.projectVendorLifecycle(lifecycle, arcId, vendorId);
    return ok(res, projected);
  } catch (err) {
    logger.error({ err }, '[vendorController.getRequestLifecycle]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
