import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel, { normalizeArcCharges } from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractModel from '../../models/arc_v2/arcContractModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { logger } from '../../util/logger.js';
import pricingEngine from '../../services/pricingEngine.js';
import { arcMomentIst, windowNotOpen, windowClosed } from '../../helper/arcTime.js';
import axios from 'axios';
import crypto from 'crypto';
import puppeteer from 'puppeteer';
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

// The vendor submission window is the CLOSED interval [submission_start_at,
// submission_end_at]. The ARC becomes visible to invited vendors when it floats
// (which can happen on publish-approval, BEFORE the window opens), but the bid
// box stays sealed until the start: no vendor write (accept terms / save draft /
// submit quote / submit technical envelope) is allowed outside the window.
// Returns an error { status, message } when the window is NOT open right now,
// else null. Both boundaries are enforced symmetrically.
function submissionWindowGate(arc) {
  if (windowNotOpen(arc)) {
    const opens = arcMomentIst(arc.submission_start_at).format('DD MMM YYYY, HH:mm');
    return { status: 409, message: `Submission window has not opened yet (opens ${opens})` };
  }
  if (windowClosed(arc)) {
    return { status: 409, message: 'Submission deadline has passed' };
  }
  return null;
}
// True only while the window is open now (and the ARC is in a live-for-quotes
// status). Used to drive the vendor UI's submit affordance.
function submissionWindowOpen(arc) {
  return ['floated', 'submission_closed'].includes(arc.status) && !submissionWindowGate(arc);
}

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
// Sr 52 — AND a valid GST %: blank/null/"" is a hard block on submit (never
// silently treated as 0%), but an EXPLICIT 0 is a valid zero-GST line and must
// pass. Draft-save stays tolerant (validateDraftLines, above) — this guard is
// submit-time only, and is the authoritative check (never trust the FE gate).
function validateSubmittedLines(lines) {
  for (const line of lines) {
    const r = Number(line.rate);
    if (line.rate == null || !Number.isFinite(r) || r < 0) {
      return 'Every line item must have a valid non-negative rate before submitting';
    }
    const gstRaw = line.gst_pct;
    if (gstRaw == null || gstRaw === '' || !Number.isFinite(Number(gstRaw)) || Number(gstRaw) < 0) {
      return 'Every line item must have a valid GST % (enter 0 if no GST applies) before submitting';
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
            -- Sr 27 (Option C): a floated-but-not-yet-open ARC (submission_start_at
            -- still in the IST future) must not be counted, surfaced in
            -- needs_action, or become the next_action CTA — same visibility
            -- rule as listRequests.
            AND (a.status <> 'floated'
                 OR a.submission_start_at IS NULL
                 OR a.submission_start_at <= (NOW() AT TIME ZONE 'Asia/Kolkata'))
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
            -- Sr 27 (Option C): a floated-but-not-yet-open ARC's events (esp.
            -- its own 'floated' row) must not appear in the vendor's activity
            -- feed before the window opens — same visibility rule as
            -- listRequests / the invites query above.
            AND (a.status <> 'floated'
                 OR a.submission_start_at IS NULL
                 OR a.submission_start_at <= (NOW() AT TIME ZONE 'Asia/Kolkata'))
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
          -- Sr 27 (Option C): a floated-but-not-yet-open ARC (submission_start_at
          -- still in the IST future) must not appear in the vendor's list. Scoped
          -- to status='floated' — every later status necessarily has a past
          -- start (start < end by publish validation, and later statuses only
          -- happen once end has passed) — so this can never hide those.
          AND (a.status <> 'floated'
               OR a.submission_start_at IS NULL
               OR a.submission_start_at <= (NOW() AT TIME ZONE 'Asia/Kolkata'))
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
    // Sr 27 (Option C): a floated ARC whose submission window has not opened
    // yet must not be readable by vendors — hide it the same as a non-live ARC.
    // Post-start behaviour (and every other status) is unchanged.
    if (arc.status === 'floated' && windowNotOpen(arc)) return bad(res, 404, 'ARC not found', 2);
    // Access-control: mirror getRequestLifecycle — a vendor may only read the
    // detail of an ARC they were invited to (open-market ARCs auto-invite eligible
    // vendors, so this is the universal gate). Without it a non-invited vendor
    // could read an invitation-only ARC's scope/items/tech envelope by direct id.
    if (!(await vendorInvitedToArc(arcId, vendorId)))
      return bad(res, 403, 'You were not invited to this rate contract');
    // Sr 33: bare getById carries only FK ints (hotel_id/category_id/department_id),
    // no resolved display names — enrich with the same join used by the
    // quote-PDF path (see getVendorQuotePdf, ~line 1464) so the FE "Buyer &
    // Scope" / "Key terms" cards can render hotel/BU + category names.
    const names = await db.oneOrNone(
      `SELECT cat.title AS category_title,
              h.name AS hotel_name, h.city AS hotel_city,
              d.title AS department_title
         FROM tbl_arc a
         LEFT JOIN tbl_category cat ON cat.id = a.category_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN tbl_department d ON d.id = a.department_id
        WHERE a.id = $1`,
      [arcId]
    );
    if (names) Object.assign(arc, names);
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
      // §6.1 — fold universal totals in: clauses_total/clauses_answered are the
      // COMBINED (item + universal) counts so the single seal reflects both, and
      // distinct universal_* fields let the FE render a separate universal section.
      const counts = await arcEvalModel.techEnvelopeCounts(arcId, vendorId);
      const univCounts = await arcEvalModel.universalEnvelopeCounts(arcId, vendorId);
      tech_envelope = {
        required: true,
        tech_submitted_at: quote?.tech_submitted_at || null,
        clauses_total: counts.clauses_total + univCounts.clauses_total,
        clauses_answered: counts.clauses_answered + univCounts.clauses_answered,
        universal_clauses_total: univCounts.clauses_total,
        universal_clauses_answered: univCounts.clauses_answered,
      };
    } else {
      tech_envelope = { required: false, tech_submitted_at: null, clauses_total: 0, clauses_answered: 0, universal_clauses_total: 0, universal_clauses_answered: 0 };
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
    const wt = submissionWindowGate(arc);
    if (wt) return bad(res, wt.status, wt.message);
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
    const { arc_id, payment_terms, gstin_used, lines, global_charges = [] } = req.body || {};
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
    // H2 — enforce the FULL submission window on draft-save too (not just submit):
    // no saving before the window opens or after it closes.
    const wd = submissionWindowGate(arc);
    if (wd) return bad(res, wd.status, wd.message);
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
    // Normalize and canonicalize global_charges from the request body.
    const canonicalGlobalCharges = normalizeArcCharges(global_charges).map((c) => {
      // Document-level charge tax lives on the engine's additional_tax/_mode keys
      // (normalizeGlobalCharge reads ONLY those — per-line `tax` is ignored at the
      // document level). Accept either input key for robustness; emit additional_tax.
      const gtax = c.additional_tax ?? c.tax;
      const gtaxMode = c.additional_tax_mode ?? c.tax_mode;
      return {
        name:                c.name ?? null,
        amount:              Number(c.amount ?? 0),
        amount_mode:         toEngineMode(c.amount_mode),
        additional_tax:      (gtax !== null && gtax !== undefined && gtax !== '') ? Number(gtax) : null,
        additional_tax_mode: toEngineMode(gtaxMode),
        ...(c.comment !== undefined && c.comment !== null ? { comment: c.comment } : {}),
      };
    });
    const engineResult = pricingEngine.calculateDocumentTotals(engineInputsOnly, canonicalGlobalCharges);
    // Map engine line output back to arc_item_id.
    const engineLineByItemId = {};
    engineLineInputs.forEach((x, idx) => {
      engineLineByItemId[x.arcItemId] = engineResult.lines[idx];
    });
    const quotePricing = {
      grand_subtotal:       engineResult.grand_subtotal,
      global_charges:       engineResult.global_charges,
      global_charges_total: engineResult.global_charges_total,
      grand_total:          engineResult.grand_total,
      // Persist the raw canonical global_charges INPUT so the vendor UI can
      // reload it on revisit (no dedicated column — stored inside quote_pricing
      // JSONB under global_charges_input; OQ-3 resolved default).
      global_charges_input: canonicalGlobalCharges,
    };

    // Respond AFTER commit — never send the HTTP response inside the tx callback
    // (a commit that fails after res.json would leave the client falsely "saved").
    const result = await db.tx(async (t) => {
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
      return { quote, lines: upserted };
    });
    return ok(res, { quote: result.quote, lines: result.lines });
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
    // Enforce BOTH window boundaries — a floated ARC whose window hasn't opened
    // yet must reject early submissions (the reported "submitted before the
    // window opened" bug), as well as late ones.
    const wq = submissionWindowGate(arc);
    if (wq) return bad(res, wq.status, wq.message);
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
    // Reload persisted global_charges_input from the saved draft (quote row
    // already fetched above). On submit we NEVER accept global_charges from the
    // client body — recompute from what was saved on draft (idempotent + secure).
    const persistedGlobalCharges = Array.isArray(quote.quote_pricing?.global_charges_input)
      ? quote.quote_pricing.global_charges_input : [];
    const submitEngineResult = pricingEngine.calculateDocumentTotals(
      submitEngineInputs.map((x) => x.input), persistedGlobalCharges
    );
    const submitQuotePricing = {
      grand_subtotal:       submitEngineResult.grand_subtotal,
      global_charges:       submitEngineResult.global_charges,
      global_charges_total: submitEngineResult.global_charges_total,
      grand_total:          submitEngineResult.grand_total,
      // Carry forward the raw input so post-submit reload can still hydrate the UI.
      global_charges_input: persistedGlobalCharges,
    };
    const submitLineByItemId = {};
    submitEngineInputs.forEach((x, idx) => {
      submitLineByItemId[x.arcItemId] = submitEngineResult.lines[idx];
    });

    // Respond AFTER commit — never send the HTTP response inside the tx callback.
    const result = await db.tx(async (t) => {
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
      // Archive an immutable snapshot of THIS submission for audit/history. The
      // live quote is overwritten in place on every re-submit, so this version
      // ledger is the COMPLETE record of every send. version_no is computed
      // inside the tx (count of existing versions + 1). NO existing guard or
      // pricing logic is changed here — this is a pure additive snapshot.
      const versionLines = quoteLines.map((ql) => ({
        arc_item_id:  Number(ql.arc_item_id),
        rate:         ql.rate,
        gst_pct:      ql.gst_pct,
        charges:      ql.charges,
        line_pricing: submitLineByItemId[Number(ql.arc_item_id)] || null,
      }));
      await arcEvalModel.archiveQuoteVersion({
        arcQuoteId: quote.id, arcId: arc_id, vendorId,
        quotePricing: submitQuotePricing, lines: versionLines,
      }, t);
      await arcModel.recordVendorResponse(arc_id, vendorId, 'submitted', t);
      await logArcEvent({
        arcId: arc_id, eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED,
        actorId: vendorId, payload: { quote_id: quote.id }, txContext: t,
      });
      return { quote: updated };
    });
    // Notify creator + comm evaluators post-commit (in-app only). Previously this
    // was unreachable (it sat after `return db.tx(...)`), so buyers were never
    // told a vendor had submitted — now it fires after the commit succeeds.
    await notifyArcEvent({ arcId: arc_id, eventType: ARC_EVENT_TYPES.VENDOR_SUBMITTED, actorId: vendorId, payload: {} });
    return ok(res, { quote: result.quote }, 'Quote submitted');
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
    if (windowClosed(arc)) {
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
    // Notify creator post-commit (email BOTH)
    await notifyArcEvent({ arcId: arc_id, eventType: ARC_EVENT_TYPES.VENDOR_WITHDREW, actorId: vendorId, payload: {} });
    return ok(res, { quote }, 'Quote withdrawn');
  } catch (err) {
    logger.error({ err }, '[vendorController.withdrawQuote]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// GET /vendor/quote/:arcId/history
// Vendor-isolated audit trail of the caller's OWN quote submissions, newest
// first. vendorId is ALWAYS derived from req.user — never the client. The
// caller must be invited to the ARC (same authority used everywhere else);
// a vendor can therefore only ever see THEIR OWN versions.
export async function getQuoteHistory(req, res) {
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.params.arcId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!arcId) return bad(res, 400, 'arcId is required');
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    // Invitation is the authority — never widen access from a client id.
    if (!(await vendorInvitedToArc(arcId, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    // Resolve the vendor's own quote (vendor-scoped) for context.
    const quote = await arcEvalModel.getQuote(arcId, vendorId);
    const versions = await arcEvalModel.listQuoteVersions(arcId, vendorId);
    return ok(res, {
      quote_id: quote?.id || null,
      versions: versions.map((v) => ({
        version_no:   Number(v.version_no),
        submitted_at: v.submitted_at,
        grand_total:  v.grand_total != null ? Number(v.grand_total) : null,
        line_count:   Number(v.line_count || 0),
      })),
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.getQuoteHistory]');
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
    const wte = submissionWindowGate(arc);
    if (wte) return { error: wte };
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
    // Sr 27 (Option C): tech clauses are readable only once the submission
    // window has opened — a floated-but-future-start ARC 404s here too, so a
    // vendor cannot read the technical-evaluation questions before start.
    if (arc.status === 'floated' && windowNotOpen(arc)) return bad(res, 404, 'ARC not found', 2);
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
    // §7.4 — universal (ARC-wide) clauses returned as a SEPARATE `universal`
    // key so the FE can render a distinct "universally configured" section.
    // Item logic above is untouched. NEVER returns buyer_marks / verdicts /
    // other vendors' rows (getVendorUniversalEnvelope is vendor-isolated).
    const { clauses: univClauses, filesByResponse: univFiles } =
      await arcEvalModel.getVendorUniversalEnvelope(arcId, vendorId);
    let universal = null;
    if (univClauses.length > 0) {
      universal = {
        minimum_passing_score: univClauses[0].minimum_passing_score,
        clauses: univClauses.map((c) => ({
          clause_id: Number(c.clause_id),
          clause_text: c.clause_text,
          clause_type: c.clause_type,
          weightage: c.weightage,
          is_mandatory: !!c.is_mandatory,
          vendor_response: c.vendor_response ?? null,
          files: (univFiles[Number(c.response_id)] || []).map((f) => ({
            file_id: Number(f.file_id),
            // Vendor-scoped, ownership-checked proxy URL — NOT the raw S3 url.
            url: `/arc-v2/vendor/universal-tech-envelope/file/${f.file_id}`,
            original_name: f.original_name || null,
          })),
        })),
      };
    }
    return ok(res, {
      tech_submitted_at: quote?.tech_submitted_at || null,
      window_open: submissionWindowOpen(arc),
      items: [...itemsMap.values()],
      universal,
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
    // Completeness guard (defence-in-depth; FE gate is primary) — applies ONLY
    // when the envelope actually has clauses. An EMPTY technical envelope (no
    // clauses configured for any item) is trivially complete and MUST be
    // sealable: otherwise a vendor whose ARC is flagged tech-required but has no
    // clauses gets stuck on the technical stage with nothing to answer and no
    // way to reach the commercial quote (the commercial-submit gate still needs
    // this seal when the ARC is tech-required).
    // §6.1 — ONE seal covers BOTH envelopes: require ALL clauses answered across
    // item AND universal. An empty universal envelope (no universal clauses) is
    // trivially complete (0 of 0), so tech-only ARCs are unaffected.
    const itemCounts = await arcEvalModel.techEnvelopeCounts(arcId, vendorId);
    const univCounts = await arcEvalModel.universalEnvelopeCounts(arcId, vendorId);
    const clausesTotal = itemCounts.clauses_total + univCounts.clauses_total;
    const clausesAnswered = itemCounts.clauses_answered + univCounts.clauses_answered;
    if (clausesTotal > 0 && clausesAnswered < clausesTotal) {
      return bad(res, 409,
        `Respond to all clauses before sealing — ${clausesAnswered} of ${clausesTotal} answered`
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
    // Notify technical evaluators only (in-app) post-commit
    await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.VENDOR_TECH_SUBMITTED, actorId: vendorId, payload: {} });
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

// ============================================================
// Universal (ARC-wide) technical envelope — vendor self-submission (§7.2)
//
// Parallel to the per-item tech-envelope handlers above, targeting the
// universal model helpers. SAME security posture: scope from req.user.id,
// invitation + window + not-sealed gated via loadTechEnvelopeScope, clause ids
// validated via universalClauseIdsBelongToArc, vendor isolation always by
// req.user.id. ONE seal (tbl_arc_quote.tech_submitted_at) covers both envelopes;
// there is no separate universal submit — it rides submitTechEnvelope.
// ============================================================

// Resolve the ARC from a universal clause (analog of arcLifecycleModelGetArcIdForClause).
async function getArcIdForUniversalClause(clauseId) {
  const row = await db.oneOrNone(
    `SELECT te.arc_id
       FROM tbl_arc_universal_tech_evaluation_clauses c
       JOIN tbl_arc_universal_tech_evaluation te ON te.id = c.arc_universal_tech_evaluation_id
      WHERE c.id = $1`,
    [clauseId]
  );
  return row ? Number(row.arc_id) : null;
}

// POST /vendor/universal-tech-envelope/draft  body: { arc_id, responses:[{clause_id, vendor_response}] }
export async function saveUniversalTechEnvelopeDraft(req, res) {
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
    // Cross-ARC universal clause ids are rejected outright (never trust client ids).
    const valid = new Set(await arcEvalModel.universalClauseIdsBelongToArc(arcId, clauseIds));
    for (const cid of clauseIds) {
      if (!valid.has(Number(cid))) {
        return bad(res, 400, 'A response references a clause that does not belong to this rate contract');
      }
    }
    const saved = await db.tx(async (t) => {
      let n = 0;
      for (const r of responses) {
        // Vendor isolation: ALWAYS scoped to req.user.id.
        await arcEvalModel.saveUniversalVendorResponse(Number(r.clause_id), vendorId, r.vendor_response ?? null, t);
        n += 1;
      }
      return n;
    });
    return ok(res, { saved });
  } catch (err) {
    logger.error({ err }, '[vendorController.saveUniversalTechEnvelopeDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /vendor/universal-tech-envelope/clause/:clauseId/file  (multipart, field 'file')
export async function uploadUniversalTechEvidence(req, res) {
  let tmpPath = null;
  try {
    const vendorId = req.user?.id;
    const clauseId = Number(req.params.clauseId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!clauseId) return bad(res, 400, 'clauseId is required');
    if (!req.file) return bad(res, 400, 'A file is required (field name: file)');

    // Resolve the ARC from the universal clause and run the full write-scope guard.
    const arcId = await getArcIdForUniversalClause(clauseId);
    if (!arcId) return bad(res, 404, 'Clause not found', 2);
    const scope = await loadTechEnvelopeScope(arcId, vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    // Clause must belong to THIS ARC (defensive — re-verify rather than trust the chain).
    const valid = await arcEvalModel.universalClauseIdsBelongToArc(arcId, [clauseId]);
    if (valid.length === 0) return bad(res, 400, 'Clause does not belong to this rate contract');

    // File validation — size + MIME + extension allow-list (same as item upload).
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (req.file.size > TECH_EVIDENCE_MAX_BYTES) {
      return bad(res, 400, 'File exceeds the 15 MB limit');
    }
    if (!TECH_EVIDENCE_MIME.has(req.file.mimetype) && !TECH_EVIDENCE_EXT.has(ext)) {
      return bad(res, 400, 'Unsupported file type — allowed: pdf, jpg, png, doc, docx');
    }

    const safeExt = TECH_EVIDENCE_EXT.has(ext) ? ext : '.bin';
    tmpPath = path.join(os.tmpdir(), `arc-univ-tech-evidence-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    fs.writeFileSync(tmpPath, req.file.buffer);
    const s3Key = `arc-tech-evidence/${arcId}/${vendorId}/universal-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    const up = await uploadToS3(tmpPath, s3Key);
    if (!up?.ok || !up?.url) return bad(res, 502, 'File upload failed — please retry', 3);

    const sanitisedOriginalName = (req.file.originalname || "").slice(0, 255) || null;
    const file = await db.tx(async (t) => {
      // Ensure a response row exists so the file can attach (vendor-scoped).
      const row = await arcEvalModel.ensureUniversalVendorResponseRow(clauseId, vendorId, t);
      return arcEvalModel.addUniversalResponseFile(row.id, up.url, sanitisedOriginalName, t);
    });
    return ok(res, {
      file: {
        file_id: Number(file.id),
        url: `/arc-v2/vendor/universal-tech-envelope/file/${file.id}`,
        original_name: file.original_name || null,
      },
    });
  } catch (err) {
    logger.error({ err }, '[vendorController.uploadUniversalTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  } finally {
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
  }
}

// GET /vendor/universal-tech-envelope/file/:fileId — vendor downloads their OWN evidence.
export async function getOwnUniversalTechEvidence(req, res) {
  try {
    const vendorId = req.user?.id;
    const fileId = Number(req.params.fileId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!fileId) return bad(res, 400, 'fileId is required');
    const file = await arcEvalModel.getUniversalResponseFileWithScope(fileId);
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
    logger.error({ err }, '[vendorController.getOwnUniversalTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// DELETE /vendor/universal-tech-envelope/file/:fileId  (own file only, before seal)
export async function deleteUniversalTechEvidence(req, res) {
  try {
    const vendorId = req.user?.id;
    const fileId = Number(req.params.fileId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!fileId) return bad(res, 400, 'fileId is required');
    const file = await arcEvalModel.getUniversalResponseFileWithScope(fileId);
    if (!file) return bad(res, 404, 'File not found', 2);
    if (Number(file.vendor_id) !== Number(vendorId)) {
      return bad(res, 403, 'You can only remove your own evidence files');
    }
    const scope = await loadTechEnvelopeScope(Number(file.arc_id), vendorId, { forWrite: true });
    if (scope.error) return bad(res, scope.error.status, scope.error.message, scope.error.code ?? 0);
    const deleted = await arcEvalModel.deleteUniversalResponseFile(fileId, vendorId);
    if (!deleted) return bad(res, 404, 'File not found', 2);
    return ok(res, { deleted: { file_id: Number(deleted.id) } });
  } catch (err) {
    logger.error({ err }, '[vendorController.deleteUniversalTechEvidence]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
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
    // Sr 27 (Option C): a floated ARC whose submission window has not opened
    // yet must not be readable by vendors — hide it the same as the
    // detail/tech-clauses reads (same guard, same 404 shape).
    if (arc.status === 'floated' && windowNotOpen(arc)) return bad(res, 404, 'ARC not found', 2);
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

// ============================================================
// Vendor quote PDF — comprehensive, tabular, professional document.
//
// SECURITY: vendorId is ALWAYS req.user.id (never the client). The PDF is
// generated to a temp file with Puppeteer (same launch flags as the contract
// generator), the bytes are streamed back as an attachment, and the temp file
// + browser are always cleaned up. Nothing is uploaded to S3.
// ============================================================

// HTML-escape every dynamic value before interpolation (injection / broken markup).
const htmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Money formatters. `money` mirrors the FE quote page's fmtN (Sr 53 — 2-decimal
// en-IN grouping, NOT whole-rupee rounding) so the PDF's totals — esp. GRAND
// TOTAL — match exactly what the vendor saw on screen (and what the engine
// persisted). `rate2` keeps 2dp for the unit price column.
const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate2 = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty0  = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dtFull = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const dDate  = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Resolve one quote line's authoritative pricing. Prefer the stored line_pricing
// (the engine's per-line output persisted on submit); fall back to recomputing
// rate × qty + charges through the SAME pricing engine when a legacy row lacks it.
function resolveLinePricing(line, item) {
  let lp = line.line_pricing;
  if (typeof lp === 'string') { try { lp = JSON.parse(lp); } catch (_) { lp = null; } }
  if (lp && typeof lp === 'object' && lp.total != null) return lp;
  // Fallback — qty is server-authoritative (tbl_arc_item), never client-supplied.
  const quantity = Number(item?.indicative_qty ?? 0);
  let charges = line.charges;
  if (typeof charges === 'string') { try { charges = JSON.parse(charges); } catch (_) { charges = []; } }
  const other_charges = normalizeArcCharges(charges).map((c) => ({
    name:        c.name ?? null,
    amount:      Number(c.amount ?? 0),
    amount_mode: (c.amount_mode === 'percentage' || c.amount_mode === '%') ? 'percentage' : 'absolute',
    tax:         (c.tax !== null && c.tax !== undefined && c.tax !== '') ? Number(c.tax) : null,
    tax_mode:    (c.tax_mode === 'percentage' || c.tax_mode === '%') ? 'percentage' : 'absolute',
  }));
  return pricingEngine.calculateLineTotal({
    unit_price: Number(line.rate ?? 0),
    quantity,
    tax:        Number(line.gst_pct ?? 0),
    tax_mode:   'percentage',
    other_charges,
  });
}

/**
 * Render the vendor's submitted quote as a self-contained, A4-friendly HTML
 * document (HTML → PDF source). Three sections:
 *   1. ARC / buyer details (end-to-end, as the buyer created it) + items in scope.
 *   2. Commercial quote breakdown — authoritative per-line table + totals block.
 *   3. Technical envelope responses (vendor-isolated; clauses + evidence names).
 * All dynamic text is HTML-escaped. No external assets/fonts (system stack).
 */
function renderVendorQuoteHtml(ctx) {
  const { arc, names = {}, vendor = {}, quote = {}, items = [], lines = [], tech = null } = ctx;

  const itemById = Object.fromEntries(items.map((it) => [Number(it.id), it]));
  const eligibility = arc.eligibility_type === 'invitation' ? 'Invitation only' : 'Open competitive';

  // Escalation clause — JSONB (already parsed by pg-promise; parse defensively).
  let escJson = arc.escalation_clause_json || {};
  if (typeof escJson === 'string') { try { escJson = JSON.parse(escJson); } catch (_) { escJson = {}; } }
  const escText = (!escJson.type || escJson.type === 'none')
    ? 'Firm &amp; fixed for the entire contract term — no price escalation admissible.'
    : (escJson.cap_pct
      ? `Indexed price revision permitted, capped at ${htmlEsc(escJson.cap_pct)}% over the term (buyer approval required).`
      : 'Indexed price revision permitted, subject to the buyer’s prior written approval.');

  // ── Section 1 — items in scope ──────────────────────────────────────────
  const scopeRows = items.map((it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td><strong>${htmlEsc(it.variant_name || ('Item #' + it.id))}</strong>${it.variant_slug ? `<div class="sub">${htmlEsc(it.variant_slug)}</div>` : ''}</td>
      <td>${it.spec_text ? htmlEsc(it.spec_text) : '<span class="muted">—</span>'}</td>
      <td class="r">${qty0(it.indicative_qty)}</td>
      <td class="c">${htmlEsc(it.uom || '—')}</td>
    </tr>`).join('');

  // ── Section 2 — commercial breakdown (authoritative pricing) ────────────
  let sumBase = 0, sumBaseTax = 0, sumCharges = 0, sumLineTotal = 0;
  const commRows = lines.map((ln, i) => {
    const it = itemById[Number(ln.arc_item_id)];
    const lp = resolveLinePricing(ln, it);
    sumBase      += Number(lp.base || 0);
    sumBaseTax   += Number(lp.base_tax || 0);
    sumCharges   += Number(lp.charges_total || 0);
    sumLineTotal += Number(lp.total || 0);
    const qty = Number(it?.indicative_qty ?? 0);
    const chargeNames = (lp.charges || [])
      .filter((c) => Number(c.subtotal ?? c.amount ?? 0) > 0)
      .map((c) => `${htmlEsc(c.name || 'Charge')}: ${money(c.subtotal ?? c.amount)}`)
      .join('<br/>');
    return `<tr>
      <td class="c">${i + 1}</td>
      <td><strong>${htmlEsc(it?.variant_name || ('Item #' + ln.arc_item_id))}</strong></td>
      <td class="r">${rate2(ln.rate)}</td>
      <td class="r">${qty0(qty)}${it?.uom ? ` <span class="muted">${htmlEsc(it.uom)}</span>` : ''}</td>
      <td class="r">${Number(ln.gst_pct ?? 0)}%</td>
      <td class="r">${Number(lp.charges_total || 0) > 0 ? money(lp.charges_total) : '—'}${chargeNames ? `<div class="sub">${chargeNames}</div>` : ''}</td>
      <td class="r">${money(lp.base_tax)}</td>
      <td class="r"><strong>${money(lp.total)}</strong></td>
    </tr>`;
  }).join('');

  // Document-level (global) charges + authoritative grand total from quote_pricing.
  let qp = quote.quote_pricing || {};
  if (typeof qp === 'string') { try { qp = JSON.parse(qp); } catch (_) { qp = {}; } }
  const globalCharges = Array.isArray(qp.global_charges) ? qp.global_charges : [];
  const globalChargesTotal = Number(qp.global_charges_total || 0);
  // AUTHORITATIVE grand total — the engine value persisted on submit. Matches the
  // vendor quote page's `fmtN(totals.grand)`. Fall back only for legacy rows.
  const grandTotal = (qp.grand_total !== null && qp.grand_total !== undefined)
    ? Number(qp.grand_total)
    : (sumLineTotal + globalChargesTotal);

  const globalRows = globalCharges
    .filter((c) => Number(c.subtotal ?? c.amount ?? 0) > 0)
    .map((c) => `<tr><td class="lbl">${htmlEsc(c.name || 'Document charge')}${c.rate != null ? ` <span class="muted">(${htmlEsc(c.rate)}${c.mode === 'percentage' ? '%' : ''})</span>` : ''}</td><td class="r">${money(c.subtotal ?? c.amount)}</td></tr>`)
    .join('');

  // ── Section 3 — technical envelope (vendor-isolated) ────────────────────
  let techHtml;
  const techClauses = (tech && Array.isArray(tech.clauses)) ? tech.clauses : [];
  const filesByResponse = (tech && tech.filesByResponse) ? tech.filesByResponse : {};
  if (techClauses.length === 0) {
    techHtml = `<p class="muted" style="margin:6px 0 0;">No technical evaluation was required for this rate contract.</p>`;
  } else {
    const byItem = new Map();
    for (const c of techClauses) {
      const k = Number(c.arc_item_id);
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k).push(c);
    }
    techHtml = [...byItem.entries()].map(([itemId, clauses]) => {
      const it = itemById[Number(itemId)];
      const rows = clauses.map((c) => {
        const fileNames = (filesByResponse[Number(c.response_id)] || [])
          .map((f) => htmlEsc(f.original_name || 'evidence'))
          .join(', ');
        return `<tr>
          <td>${htmlEsc(c.clause_text || '—')}${c.clause_type ? `<div class="sub">${htmlEsc(c.clause_type)}</div>` : ''}</td>
          <td class="c">${c.weightage != null ? htmlEsc(c.weightage) : '—'}</td>
          <td class="c">${c.is_mandatory ? '<span class="pill warn">Mandatory</span>' : 'No'}</td>
          <td>${c.vendor_response ? htmlEsc(c.vendor_response) : '<span class="muted">No response</span>'}</td>
          <td>${fileNames || '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join('');
      return `<h3 class="item-sub">${htmlEsc(it?.variant_name || ('Item #' + itemId))}</h3>
        <table class="tbl tech">
          <thead><tr><th>Clause</th><th class="c">Weightage</th><th class="c">Mandatory</th><th>Your response</th><th>Evidence files</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }).join('');
  }

  const hotelLine = [names.hotel_name, names.hotel_city, names.hotel_state].filter(Boolean).map(htmlEsc).join(', ') || '—';
  const status = (quote.withdrawn_at) ? 'WITHDRAWN' : 'SUBMITTED';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Quote ${htmlEsc(arc.arc_number || '')} — ${htmlEsc(vendor.name || '')}</title>
<style>
  @page { size: A4; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1f2430; font-size: 11px; line-height: 1.5; margin: 0; }
  .doc { max-width: 880px; margin: 0 auto; }
  .lh { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #1d3b53; padding-bottom: 12px; }
  .lh .org { font-size: 16px; font-weight: 700; color: #1d3b53; letter-spacing: 0.3px; }
  .lh .org .sub { display: block; font-size: 9px; font-weight: 600; color: #6b7280; letter-spacing: 2px; text-transform: uppercase; margin-top: 3px; }
  .lh .doctype { text-align: right; }
  .lh .doctype .kind { font-size: 12px; font-weight: 700; color: #1d3b53; text-transform: uppercase; letter-spacing: 0.5px; }
  .lh .doctype .ref { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 10px; color: #374151; margin-top: 3px; }
  .badge { display: inline-block; font-size: 8.5px; font-weight: 700; letter-spacing: 0.5px; padding: 3px 9px; border-radius: 3px; margin-top: 5px; background: #e6f4ec; color: #0f5132; border: 1px solid #0f5132; }
  .badge.warn { background: #fdf3e7; color: #8a4b08; border-color: #b5731a; }
  .title { margin: 14px 0 2px; }
  .title h1 { font-size: 17px; margin: 0; color: #111827; }
  .title .meta { font-size: 11px; color: #4b5563; margin-top: 4px; }
  .title .meta .em { color: #1f2937; font-weight: 600; }
  h2.sec { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #1d3b53; border-bottom: 1.5px solid #1d3b53; padding-bottom: 4px; margin: 22px 0 10px; }
  h3.item-sub { font-size: 11.5px; color: #1f2937; margin: 14px 0 5px; }
  .grid { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid #e3e6ea; border-radius: 6px; overflow: hidden; }
  .grid .cell { flex: 1 1 33%; min-width: 33%; padding: 9px 12px; border-right: 1px solid #eef0f3; border-bottom: 1px solid #eef0f3; }
  .grid .cell .k { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.7px; color: #8a93a0; }
  .grid .cell .v { font-size: 11.5px; color: #1f2937; margin-top: 3px; font-weight: 500; }
  .terms { margin-top: 10px; }
  .terms .row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px dashed #e8eaee; }
  .terms .row .tk { flex: 0 0 150px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a93a0; padding-top: 1px; }
  .terms .row .tv { flex: 1; font-size: 11px; color: #1f2937; }
  table.tbl { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
  table.tbl th { background: #1d3b53; color: #fff; padding: 7px 8px; text-align: left; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
  table.tbl td { padding: 7px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  table.tbl tbody tr:nth-child(even) { background: #f7f9fb; }
  table.tbl td.r, table.tbl th.r { text-align: right; }
  table.tbl td.c, table.tbl th.c { text-align: center; }
  table.tbl td .sub { font-size: 8.5px; color: #8a93a0; margin-top: 2px; }
  .muted { color: #9aa2ad; }
  .pill { display: inline-block; font-size: 8px; font-weight: 700; padding: 2px 7px; border-radius: 10px; letter-spacing: 0.3px; }
  .pill.warn { background: #fdf3e7; color: #8a4b08; }
  .totals { margin-top: 12px; margin-left: auto; width: 320px; }
  .totals table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .totals td { padding: 6px 4px; }
  .totals td.lbl { color: #4b5563; }
  .totals td.r { text-align: right; font-variant-numeric: tabular-nums; color: #1f2937; }
  .totals tr.grand td { border-top: 2px solid #1d3b53; padding-top: 9px; font-size: 13px; font-weight: 700; color: #111827; }
  .qmeta { display: flex; gap: 22px; margin: 4px 0 2px; font-size: 10.5px; color: #4b5563; }
  .qmeta .em { color: #1f2937; font-weight: 600; }
  .foot { margin-top: 24px; border-top: 1px dashed #d6dae0; padding-top: 8px; text-align: center; font-size: 8.5px; color: #9aa2ad; }
  .avoid-break { page-break-inside: avoid; }
</style></head>
<body><div class="doc">

  <div class="lh">
    <div>
      <div class="org">${htmlEsc(names.company_name || 'Workwise Hospitality')}<span class="sub">Procurement · Rate Contract</span></div>
    </div>
    <div class="doctype">
      <div class="kind">Quote Submission</div>
      <div class="ref">${htmlEsc(arc.arc_number || ('ARC-' + arc.id))}</div>
      <div class="badge${status === 'WITHDRAWN' ? ' warn' : ''}">${status}</div>
    </div>
  </div>

  <div class="title">
    <h1>${htmlEsc(arc.title || 'Rate Contract')}</h1>
    <div class="meta">Submitted by <span class="em">${htmlEsc(vendor.name || 'Vendor')}</span>${vendor.email ? ` · ${htmlEsc(vendor.email)}` : ''} · on <span class="em">${dtFull(quote.submitted_at)}</span></div>
  </div>

  <h2 class="sec">1 · Rate Contract Details</h2>
  <div class="grid">
    <div class="cell"><div class="k">ARC Number</div><div class="v">${htmlEsc(arc.arc_number || '—')}</div></div>
    <div class="cell"><div class="k">Category</div><div class="v">${htmlEsc(names.category_title || '—')}</div></div>
    <div class="cell"><div class="k">Department</div><div class="v">${htmlEsc(names.department_title || '—')}</div></div>
    <div class="cell"><div class="k">Hotel / Business Unit</div><div class="v">${hotelLine}</div></div>
    <div class="cell"><div class="k">Eligibility</div><div class="v">${eligibility}</div></div>
    <div class="cell"><div class="k">Items in Scope</div><div class="v">${items.length}</div></div>
    <div class="cell"><div class="k">Submission Window</div><div class="v">${dtFull(arc.submission_start_at)} → ${dtFull(arc.submission_end_at)}</div></div>
    <div class="cell"><div class="k">Contract Term</div><div class="v">${dDate(arc.contract_start_at)} → ${dDate(arc.contract_end_at)}</div></div>
    <div class="cell"><div class="k">Generated</div><div class="v">${dtFull(new Date())}</div></div>
  </div>

  <div class="terms">
    <div class="row"><div class="tk">Payment terms</div><div class="tv">${arc.payment_terms_expected ? htmlEsc(arc.payment_terms_expected) : '<span class="muted">As mutually agreed</span>'}</div></div>
    <div class="row"><div class="tk">Delivery expected</div><div class="tv">${arc.delivery_expected ? htmlEsc(arc.delivery_expected) : '<span class="muted">As agreed per line</span>'}</div></div>
    <div class="row"><div class="tk">Penalty clause</div><div class="tv">${arc.penalty_clause ? htmlEsc(arc.penalty_clause) : '<span class="muted">As per buyer’s standard policy</span>'}</div></div>
    <div class="row"><div class="tk">Escalation clause</div><div class="tv">${escText}</div></div>
  </div>

  <h3 class="item-sub">Items in scope</h3>
  <table class="tbl">
    <thead><tr><th class="c">#</th><th>Item / Variant</th><th>Specification</th><th class="r">Indicative Qty</th><th class="c">UOM</th></tr></thead>
    <tbody>${scopeRows || '<tr><td colspan="5" class="muted c">No items.</td></tr>'}</tbody>
  </table>

  <h2 class="sec">2 · Commercial Quote Breakdown</h2>
  <div class="qmeta">
    <span>GSTIN used: <span class="em">${vendor.gstin ? htmlEsc(vendor.gstin) : '—'}</span></span>
    ${quote.payment_terms ? `<span>Payment terms: <span class="em">${htmlEsc(quote.payment_terms)}</span></span>` : ''}
  </div>
  <table class="tbl">
    <thead><tr>
      <th class="c">#</th><th>Item</th><th class="r">Rate</th><th class="r">Qty · UOM</th>
      <th class="r">GST</th><th class="r">Charges</th><th class="r">Tax</th><th class="r">Line Total</th>
    </tr></thead>
    <tbody>${commRows || '<tr><td colspan="8" class="muted c">No priced lines.</td></tr>'}</tbody>
  </table>

  <div class="totals avoid-break">
    <table>
      <tr><td class="lbl">Subtotal (rate × qty)</td><td class="r">${money(sumBase)}</td></tr>
      <tr><td class="lbl">Total tax (GST)</td><td class="r">${money(sumBaseTax)}</td></tr>
      <tr><td class="lbl">Total line charges</td><td class="r">${money(sumCharges)}</td></tr>
      ${globalRows}
      ${globalChargesTotal > 0 && !globalRows ? `<tr><td class="lbl">Document charges</td><td class="r">${money(globalChargesTotal)}</td></tr>` : ''}
      <tr class="grand"><td>GRAND TOTAL</td><td class="r">${money(grandTotal)}</td></tr>
    </table>
  </div>

  <h2 class="sec">3 · Technical Details</h2>
  ${techHtml}

  <div class="foot">System-generated quote document · ${htmlEsc(arc.arc_number || ('ARC-' + arc.id))} · ${htmlEsc(vendor.name || 'Vendor')} · This reflects the vendor’s authoritative submitted pricing.</div>

</div></body></html>`;
}

// GET /vendor/quote/:arcId/pdf  — stream the vendor's OWN submitted quote as PDF.
// vendorId = req.user.id (NEVER the client). 404 if absent / not-live; 403 if not
// invited; 400 if no SUBMITTED quote. Guarantees a vendor can only download THEIR
// OWN submitted quote for an ARC they were invited to.
export async function downloadQuotePdf(req, res) {
  let browser = null;
  let tmpPath = null;
  try {
    const vendorId = req.user?.id;
    const arcId = Number(req.params.arcId);
    if (!vendorId) return bad(res, 401, 'Unauthorized');
    if (!arcId) return bad(res, 400, 'arcId is required');

    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (NOT_LIVE_TO_VENDOR.includes(arc.status)) return bad(res, 404, 'ARC not found', 2);
    if (!(await vendorInvitedToArc(arcId, vendorId))) {
      return bad(res, 403, 'You were not invited to this rate contract');
    }
    const quote = await arcEvalModel.getQuote(arcId, vendorId);
    if (!quote || !quote.submitted_at || quote.withdrawn_at) {
      return bad(res, 400, 'No submitted quote to download');
    }

    const [items, lines, names, vendorRow, tech] = await Promise.all([
      arcModel.listItems(arcId),
      arcEvalModel.listQuoteLines(quote.id),
      // Display names the document needs (department title is absent from
      // loadContractDocContext, so resolve the full name set in one small join).
      db.oneOrNone(
        `SELECT cat.title AS category_title,
                h.name AS hotel_name, h.city AS hotel_city, h.state AS hotel_state,
                hc.name AS company_name, d.title AS department_title
           FROM tbl_arc a
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
           LEFT JOIN tbl_department d ON d.id = a.department_id
          WHERE a.id = $1`,
        [arcId]
      ),
      db.oneOrNone(`SELECT name, email FROM tbl_users WHERE id = $1`, [vendorId]),
      arcEvalModel.getVendorTechEnvelope(arcId, vendorId).catch(() => null),
    ]);

    const vendor = { name: vendorRow?.name || 'Vendor', email: vendorRow?.email || null, gstin: quote.gstin_used || null };
    const html = renderVendorQuoteHtml({ arc, names: names || {}, vendor, quote, items, lines, tech });

    tmpPath = path.join(os.tmpdir(), `arc-quote-${arcId}-${vendorId}-${Date.now()}.pdf`);
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: tmpPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    await browser.close();
    browser = null;

    const pdfBuffer = fs.readFileSync(tmpPath);
    const safeVendor = String(vendor.name || 'vendor').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'vendor';
    const fileName = `Quote-${arc.arc_number || arcId}-${safeVendor}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    logger.error({ err }, '[vendorController.downloadQuotePdf]');
    return bad(res, 500, err.message || 'Internal error', 3);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } }
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
  }
}
