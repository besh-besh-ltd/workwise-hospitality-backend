import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractModel from '../../models/arc_v2/arcContractModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';

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
  'vendor_submitted', 'vendor_withdrew', 'vendor_declined',
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
    // Mark invitation viewed if not yet (silent best-effort).
    if (invitation && invitation.status === 'invited') {
      await arcModel.recordVendorResponse(arcId, vendorId, 'viewed');
      await logArcEvent({ arcId, eventType: ARC_EVENT_TYPES.VENDOR_VIEWED, actorId: vendorId, payload: {} });
    }
    return ok(res, { arc, items, invitation, quote, lines });
  } catch (err) {
    logger.error({ err }, '[vendorController.getRequestDetail]');
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
    return db.tx(async (t) => {
      const quote = await arcEvalModel.upsertQuote(arc_id, vendorId, { payment_terms, gstin_used }, t);
      const upserted = [];
      for (const line of (lines || [])) {
        upserted.push(await arcEvalModel.upsertQuoteLine(quote.id, line, t));
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
    // H3 — completeness: at least one line, each with a valid non-negative rate.
    const quoteLines = await arcEvalModel.listQuoteLines(quote.id);
    if (quoteLines.length === 0) return bad(res, 400, 'Quote has no line items');
    const submitLineErr = validateSubmittedLines(quoteLines);
    if (submitLineErr) return bad(res, 400, submitLineErr);
    return db.tx(async (t) => {
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
