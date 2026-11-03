// RFQ items closed without award.
//
// An RFQ item (tbl_rfq_products row) is in exactly one state:
//   closed_no_award  the buyer closed it: closed_at is set (with a reason)
//   award_pending    a finalization exists and its NEGOTIATION_QUOTE
//                    approval is still PENDING
//   awarded          a finalization (or a live PO line) exists, nothing pending
//   open             none of the above
// An item is SETTLED when it is awarded or closed_no_award. The RFQ's outcome
// (award_outcome) is derived from its items; tbl_rfq.status is untouched by
// an item closure and keeps its 1 = open / 2 = closed meaning.
//
// Closing is append-only history (tbl_rfq_product_closure, one row per close
// or reopen) plus the item's current closure on tbl_rfq_products, which every
// "is this item settled" query reads.
//
// Who: the RFQ's creator, the same rule as POST /rfq/close-rfq/:id.
// When: the RFQ is live (status 1, published) and the item's bid window has
// closed, or every vendor invited on the item has regretted. An item can be
// closed only while it is open: not awarded, no award approval pending, no
// negotiation round open or awaiting approval on it, no technical-evaluation
// round awaiting a decision.
//
// Lock order: the RFQ row, then its items (id order). closeRFQ takes the RFQ
// row through its status UPDATE; finalize takes the item row FOR SHARE before
// writing an award, so an award and a close of the same item serialise.

import db from '../../config/dbConn.js';
import { coversProductSql } from '../../models/negotiationModel.js';
import { parseIstWallTimeToEpoch } from '../../controllers/rfq/rfqUpdateHelpers.js';

/** Reasons a buyer can pick. */
export const ITEM_CLOSE_REASONS = Object.freeze([
  'no_quotes_received',
  'all_vendors_regretted',
  'technically_disqualified',
  'quotes_not_acceptable',
  'requirement_cancelled',
  'sourced_elsewhere',
  'other',
]);

/** Set by POST /rfq/close-rfq/:id on items still open when the RFQ closes. */
export const RFQ_CLOSED_REASON = 'rfq_closed';

export const ITEM_STATES = Object.freeze({
  OPEN: 'open',
  AWARD_PENDING: 'award_pending',
  AWARDED: 'awarded',
  CLOSED: 'closed_no_award',
});

const REMARKS_MAX = 2000;
const MAX_ITEMS = 1000;

// PO statuses that no longer hold their products (same list as poInitiateGuide).
const DEAD_PO_STATUSES = ['rejected', 'cancelled', 'rejected_by_vendor'];

const HTTP_STATUS = Object.freeze({ NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION: 400, CONFLICT: 409 });

export class RfqItemClosureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RfqItemClosureError';
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS[code] ?? 400;
  }
}

const invalid = (message, details) => new RfqItemClosureError('VALIDATION', message, details);

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function idList(v) {
  if (!Array.isArray(v) || !v.length) throw invalid('Choose at least one item', { field: 'rfq_product_ids' });
  if (v.length > MAX_ITEMS) throw invalid(`At most ${MAX_ITEMS} items at a time`, { field: 'rfq_product_ids' });
  const ids = v.map(positiveInt);
  if (ids.some((id) => id == null)) throw invalid('Item ids must be positive integers', { field: 'rfq_product_ids' });
  return [...new Set(ids)];
}

function cleanRemarks(remarks, field = 'remarks') {
  if (remarks == null) return null;
  if (typeof remarks !== 'string') throw invalid('Remarks must be text', { field });
  const s = remarks.trim();
  if (s.length > REMARKS_MAX) throw invalid(`Remarks can be at most ${REMARKS_MAX} characters`, { field });
  return s || null;
}

/** A buyer-picked reason, checked; `other` needs remarks. */
function checkReason(reasonCode, remarks, field = 'reason_code') {
  if (!ITEM_CLOSE_REASONS.includes(reasonCode)) {
    throw invalid('Choose why the item is being closed', { field, allowed: ITEM_CLOSE_REASONS });
  }
  if (reasonCode === 'other' && !remarks) {
    throw invalid('Add remarks when the reason is "other"', { field: 'remarks' });
  }
}

/** True once the RFQ's bid window has closed (bid_end_date is wall-clock IST). */
export function isBidEnded(rfq, nowMs = Date.now()) {
  const end = parseIstWallTimeToEpoch(rfq?.bid_end_date);
  return end !== null && end <= nowMs;
}

async function loadRfq(t, rfqId, { forUpdate = false } = {}) {
  const id = positiveInt(rfqId);
  if (!id) throw new RfqItemClosureError('NOT_FOUND', 'RFQ not found');
  const rfq = await t.oneOrNone(
    `SELECT id, rfq_no, title, status, is_published, is_tender, created_by, bid_end_date
       FROM tbl_rfq WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!rfq) throw new RfqItemClosureError('NOT_FOUND', 'RFQ not found');
  return rfq;
}

function assertCreator(rfq, user) {
  if (String(rfq.created_by) !== String(user?.id)) {
    throw new RfqItemClosureError('FORBIDDEN', 'Only the RFQ creator can close or reopen its items');
  }
}

function assertLive(rfq) {
  if (Number(rfq.status) !== 1 || Number(rfq.is_published) !== 1) {
    throw new RfqItemClosureError(
      'CONFLICT',
      Number(rfq.status) === 2
        ? 'This RFQ is closed, so its items can no longer be closed or reopened'
        : 'Items can be closed once the RFQ is published',
      { rfq_status: Number(rfq.status), is_published: Number(rfq.is_published) }
    );
  }
}

/**
 * Every item of the RFQ with the facts its state is derived from, id order.
 * `lock` takes the item rows FOR UPDATE (callers must hold the RFQ row first).
 */
export async function getRfqItemFacts(t, rfqId, { lock = false } = {}) {
  return t.any(
    `SELECT rp.id, rp.product_variant_id, rp.variant,
            COALESCE(pv.name, p.name, 'Product #' || rp.product_variant_id) AS product_name,
            rp.closed_at, rp.closed_by, cu.name AS closed_by_name,
            rp.close_reason_code, rp.close_remarks,
            EXISTS (SELECT 1 FROM tbl_quote_finalization qf
                     WHERE qf.rfq_id = rp.rfq_id
                       AND qf.product_variant_id = rp.product_variant_id
                       AND qf.variant = rp.variant) AS finalized,
            EXISTS (SELECT 1 FROM tbl_approval_instances ai
                     WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
                       AND ai.status = 'PENDING'
                       AND ai.entity_id = rp.id) AS award_pending,
            EXISTS (SELECT 1 FROM tbl_purchase_order_product pop
                      JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
                     WHERE pop.rfq_product_id = rp.id
                       AND po.status::text <> ALL($2::text[])) AS live_po,
            EXISTS (SELECT 1 FROM tbl_negotiation_rounds nr
                     WHERE nr.rfq_id = rp.rfq_id
                       AND nr.source_type = 'RFQ'
                       AND (nr.status IN ('DRAFT', 'PENDING_APPROVAL')
                            OR (nr.status = 'ACTIVE'
                                AND (nr.end_date IS NULL OR nr.end_date > (now() AT TIME ZONE 'UTC'))))
                       AND ${coversProductSql('rp.id')}) AS in_round,
            EXISTS (SELECT 1 FROM tbl_tech_evaluation_rounds ter
                      JOIN tbl_rfq_product_tech_evaluation te ON te.id = ter.tbl_rfq_product_tech_evaluation_id
                     WHERE te.tbl_rfq_product_id = rp.id
                       AND ter.status IN ('PENDING', 'SUBMITTED')) AS tech_eval_pending,
            (SELECT count(DISTINCT q.created_by)
               FROM tbl_quote_items qi
               JOIN tbl_quotes q ON q.id = qi.quote_id
              WHERE q.rfq_id = rp.rfq_id
                AND qi.product_variant_id = rp.product_variant_id
                AND qi.variant = rp.variant
                AND COALESCE(q.is_regret, 0) <> 1)::int AS quoted_vendor_count,
            (SELECT count(DISTINCT iv.user_id)
               FROM tbl_rfq_product_vendors iv
              WHERE iv.rfq_id = rp.rfq_id
                AND iv.product_variant_id = rp.product_variant_id
                AND iv.variant IS NOT DISTINCT FROM rp.variant)::int AS invited_vendor_count,
            (SELECT count(DISTINCT iv.user_id)
               FROM tbl_rfq_product_vendors iv
              WHERE iv.rfq_id = rp.rfq_id
                AND iv.product_variant_id = rp.product_variant_id
                AND iv.variant IS NOT DISTINCT FROM rp.variant
                AND EXISTS (SELECT 1 FROM tbl_quotes rq
                             WHERE rq.rfq_id = rp.rfq_id
                               AND rq.created_by = iv.user_id
                               AND rq.is_regret = 1))::int AS regretted_vendor_count
       FROM tbl_rfq_products rp
       LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
       LEFT JOIN tbl_product p ON p.id = pv.product_id
       LEFT JOIN tbl_users cu ON cu.id = rp.closed_by
      WHERE rp.rfq_id = $1
      ORDER BY rp.id
      ${lock ? 'FOR UPDATE OF rp' : ''}`,
    [rfqId, DEAD_PO_STATUSES]
  );
}

/** The item's state from its facts (see the header). */
export function itemState(f) {
  if (f.closed_at) return ITEM_STATES.CLOSED;
  if (f.award_pending) return ITEM_STATES.AWARD_PENDING;
  if (f.finalized || f.live_po) return ITEM_STATES.AWARDED;
  return ITEM_STATES.OPEN;
}

/** Why an item cannot be closed right now; empty when it can. */
export function closeBlockers(f, { bidEnded }) {
  const state = itemState(f);
  if (state === ITEM_STATES.CLOSED) return ['already_closed'];
  if (state === ITEM_STATES.AWARDED) return ['awarded'];
  if (state === ITEM_STATES.AWARD_PENDING) return ['award_pending'];
  const out = [];
  if (f.in_round) out.push('negotiation_round');
  if (f.tech_eval_pending) out.push('tech_eval_pending');
  const allRegretted = f.invited_vendor_count > 0 && f.regretted_vendor_count >= f.invited_vendor_count;
  if (!bidEnded && !allRegretted) out.push('bid_window_open');
  return out;
}

const BLOCKER_TEXT = Object.freeze({
  already_closed: 'already closed',
  awarded: 'already awarded',
  award_pending: 'its award is awaiting approval',
  negotiation_round: 'a negotiation round is open or awaiting approval on it',
  tech_eval_pending: 'a technical evaluation is awaiting a decision on it',
  bid_window_open: 'the bid window is still open',
});

/** The reason the UI should preselect, from what happened on the item. */
function suggestedReason(f) {
  if (f.quoted_vendor_count > 0) return null;
  if (f.invited_vendor_count > 0 && f.regretted_vendor_count >= f.invited_vendor_count) return 'all_vendors_regretted';
  return 'no_quotes_received';
}

function publicClosure(f) {
  if (!f.closed_at) return null;
  return {
    closed_at: f.closed_at,
    closed_by: f.closed_by == null ? null : { id: Number(f.closed_by), name: f.closed_by_name || null },
    reason_code: f.close_reason_code,
    remarks: f.close_remarks || null,
  };
}

/**
 * The RFQ's outcome from its item states:
 *   in_progress        something is open or awaiting award approval
 *   fully_awarded      every item awarded
 *   partially_awarded  some awarded, the rest closed without award
 *   not_awarded        every item closed without award (or no items)
 */
export function awardOutcome(summary) {
  if (summary.open > 0 || summary.award_pending > 0) return 'in_progress';
  if (summary.total === 0 || summary.awarded === 0) return 'not_awarded';
  return summary.closed_no_award > 0 ? 'partially_awarded' : 'fully_awarded';
}

export function summarise(states) {
  const s = { total: states.length, awarded: 0, award_pending: 0, closed_no_award: 0, open: 0 };
  for (const st of states) {
    if (st === ITEM_STATES.AWARDED) s.awarded += 1;
    else if (st === ITEM_STATES.AWARD_PENDING) s.award_pending += 1;
    else if (st === ITEM_STATES.CLOSED) s.closed_no_award += 1;
    else s.open += 1;
  }
  return s;
}

/**
 * Item summaries for many RFQs in one statement, for list and dashboard
 * responses: rfqId → { items: {total, awarded, award_pending, closed_no_award,
 * open}, award_outcome }. Same state rules as itemState.
 */
export async function getAwardOutcomes(rfqIds, dbCtx = db) {
  const ids = [...new Set((rfqIds || []).map(positiveInt).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await dbCtx.any(
    `SELECT x.rfq_id,
            count(*)::int AS total,
            count(*) FILTER (WHERE x.st = 'closed_no_award')::int AS closed_no_award,
            count(*) FILTER (WHERE x.st = 'award_pending')::int AS award_pending,
            count(*) FILTER (WHERE x.st = 'awarded')::int AS awarded,
            count(*) FILTER (WHERE x.st = 'open')::int AS open
       FROM (
         SELECT rp.rfq_id,
                CASE
                  WHEN rp.closed_at IS NOT NULL THEN 'closed_no_award'
                  WHEN EXISTS (SELECT 1 FROM tbl_approval_instances ai
                                WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'PENDING'
                                  AND ai.entity_id = rp.id) THEN 'award_pending'
                  WHEN EXISTS (SELECT 1 FROM tbl_quote_finalization qf
                                WHERE qf.rfq_id = rp.rfq_id AND qf.product_variant_id = rp.product_variant_id
                                  AND qf.variant = rp.variant)
                    OR EXISTS (SELECT 1 FROM tbl_purchase_order_product pop
                                 JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
                                WHERE pop.rfq_product_id = rp.id
                                  AND po.status::text <> ALL($2::text[])) THEN 'awarded'
                  ELSE 'open'
                END AS st
           FROM tbl_rfq_products rp
          WHERE rp.rfq_id = ANY($1::int[])
       ) x
      GROUP BY x.rfq_id`,
    [ids, DEAD_PO_STATUSES]
  );
  for (const r of rows) {
    const items = {
      total: r.total, awarded: r.awarded, award_pending: r.award_pending,
      closed_no_award: r.closed_no_award, open: r.open,
    };
    out.set(Number(r.rfq_id), { items, award_outcome: awardOutcome(items) });
  }
  return out;
}

/**
 * What closing would do, for the Close RFQ and Close items dialogs. Read-only.
 * Creator only (the only person who can act on it).
 */
export async function getClosePreview(user, rfqId, dbCtx = db) {
  const rfq = await loadRfq(dbCtx, rfqId);
  assertCreator(rfq, user);
  const bidEnded = isBidEnded(rfq);
  const facts = await getRfqItemFacts(dbCtx, rfq.id);
  const items = facts.map((f) => {
    const state = itemState(f);
    const blockers = closeBlockers(f, { bidEnded });
    return {
      rfq_product_id: Number(f.id),
      product_name: f.product_name,
      state,
      closable: blockers.length === 0,
      blockers,
      suggested_reason: state === ITEM_STATES.OPEN ? suggestedReason(f) : null,
      quoted_vendor_count: f.quoted_vendor_count,
      invited_vendor_count: f.invited_vendor_count,
      regretted_vendor_count: f.regretted_vendor_count,
      closure: publicClosure(f),
    };
  });
  const summary = summarise(items.map((i) => i.state));

  // What POST /rfq/close-rfq/:id would cancel or leave behind (closeRFQ).
  const [pendingPos, draftPos, pendingAwards, activeRounds] = await Promise.all([
    dbCtx.any(
      `SELECT id, po_number FROM tbl_rfq_purchase_order
        WHERE rfq_id = $1 AND status = 'pending_approval' ORDER BY id`,
      [rfq.id]
    ),
    dbCtx.any(
      `SELECT id, po_number FROM tbl_rfq_purchase_order
        WHERE rfq_id = $1 AND status = 'draft' ORDER BY id`,
      [rfq.id]
    ),
    dbCtx.one(
      `SELECT count(*)::int AS n FROM tbl_approval_instances
        WHERE entity_type = 'NEGOTIATION_QUOTE' AND status = 'PENDING'
          AND entity_id IN (SELECT id FROM tbl_rfq_products WHERE rfq_id = $1)`,
      [rfq.id]
    ),
    dbCtx.one(
      `SELECT count(*)::int AS n FROM tbl_negotiation_rounds
        WHERE rfq_id = $1 AND status = 'ACTIVE'`,
      [rfq.id]
    ),
  ]);

  const poRef = (r) => ({ po_id: Number(r.id), po_number: r.po_number ?? null });
  return {
    rfq: {
      id: Number(rfq.id),
      rfq_no: rfq.rfq_no,
      status: Number(rfq.status),
      is_published: Number(rfq.is_published),
      bid_ended: bidEnded,
    },
    items,
    summary,
    award_outcome: awardOutcome(summary),
    reasons: ITEM_CLOSE_REASONS,
    on_close_rfq: {
      can_close: Number(rfq.status) === 1,
      items_to_close: items.filter((i) => i.state === ITEM_STATES.OPEN).map((i) => i.rfq_product_id),
      pending_po_approvals_cancelled: pendingPos.map(poRef),
      pending_award_approvals_cancelled: pendingAwards.n,
      active_rounds_cancelled: activeRounds.n,
      draft_pos_kept: draftPos.map(poRef),
    },
  };
}

async function writeClosureRows(t, { rfqId, itemIds, action, reasonCode, remarks, userId }) {
  if (!itemIds.length) return;
  await t.none(
    `INSERT INTO tbl_rfq_product_closure (rfq_id, rfq_product_id, action, reason_code, remarks, acted_by)
     SELECT $1, v.id, $3, $4, $5, $6 FROM unnest($2::int[]) AS v(id)`,
    [rfqId, itemIds, action, reasonCode, remarks, userId]
  );
}

/** Vendors who quoted (did not regret) the given items: they are told it closed. */
async function vendorsWhoQuoted(t, rfqId, itemIds) {
  if (!itemIds.length) return [];
  const rows = await t.any(
    `SELECT DISTINCT q.created_by AS vendor_id
       FROM tbl_rfq_products rp
       JOIN tbl_quote_items qi ON qi.product_variant_id = rp.product_variant_id AND qi.variant = rp.variant
       JOIN tbl_quotes q ON q.id = qi.quote_id AND q.rfq_id = rp.rfq_id
      WHERE rp.rfq_id = $1 AND rp.id = ANY($2::int[]) AND COALESCE(q.is_regret, 0) <> 1`,
    [rfqId, itemIds]
  );
  return rows.map((r) => Number(r.vendor_id));
}

/**
 * Close items without award.
 *
 * @param {object} t transaction
 * @param {object} user req.user
 * @param {number} rfqId
 * @param {{rfq_product_ids:number[], reason_code:string, remarks?:string}} input
 * @returns {Promise<{rfq, closed:number[], already_closed:number[], closed_items:Array<{rfq_product_id, product_name}>, notify_vendor_ids:number[]}>}
 * @throws RfqItemClosureError NOT_FOUND (RFQ or items), FORBIDDEN (not the
 *   creator), CONFLICT (RFQ not live, or an item cannot be closed — details
 *   list each item with its blockers), VALIDATION (input).
 */
export async function closeItems(t, user, rfqId, { rfq_product_ids, reason_code, remarks } = {}) {
  const ids = idList(rfq_product_ids);
  const note = cleanRemarks(remarks);
  checkReason(reason_code, note);

  const rfq = await loadRfq(t, rfqId, { forUpdate: true });
  assertCreator(rfq, user);
  assertLive(rfq);

  const facts = await getRfqItemFacts(t, rfq.id, { lock: true });
  const byId = new Map(facts.map((f) => [Number(f.id), f]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new RfqItemClosureError('NOT_FOUND', 'Some items are not on this RFQ', { rfq_product_ids: missing });
  }

  const bidEnded = isBidEnded(rfq);
  const alreadyClosed = [];
  const toClose = [];
  const refused = [];
  for (const id of ids) {
    const f = byId.get(id);
    const blockers = closeBlockers(f, { bidEnded });
    if (blockers[0] === 'already_closed') alreadyClosed.push(id);
    else if (blockers.length) refused.push({ rfq_product_id: id, product_name: f.product_name, blockers });
    else toClose.push(id);
  }
  if (refused.length) {
    const first = refused[0];
    throw new RfqItemClosureError(
      'CONFLICT',
      `"${first.product_name}" can't be closed: ${BLOCKER_TEXT[first.blockers[0]]}.`,
      { items: refused }
    );
  }

  if (toClose.length) {
    const res = await t.result(
      `UPDATE tbl_rfq_products
          SET closed_at = now(), closed_by = $3, close_reason_code = $4, close_remarks = $5
        WHERE rfq_id = $1 AND id = ANY($2::int[]) AND closed_at IS NULL`,
      [rfq.id, toClose, positiveInt(user?.id), reason_code, note]
    );
    // The rows are locked above, so anything else is a fault, not a race.
    if (res.rowCount !== toClose.length) {
      throw new Error(`closeItems: expected ${toClose.length} rows, closed ${res.rowCount}`);
    }
    await writeClosureRows(t, {
      rfqId: rfq.id, itemIds: toClose, action: 'close', reasonCode: reason_code, remarks: note, userId: positiveInt(user?.id),
    });
  }

  return {
    rfq: { id: Number(rfq.id), rfq_no: rfq.rfq_no, title: rfq.title, is_tender: Number(rfq.is_tender) === 1 },
    closed: toClose,
    already_closed: alreadyClosed,
    closed_items: toClose.map((id) => ({ rfq_product_id: id, product_name: byId.get(id).product_name })),
    notify_vendor_ids: await vendorsWhoQuoted(t, rfq.id, toClose),
  };
}

/**
 * Reopen items closed without award. Vendors can quote them again only after
 * the bid date is extended (the normal edit rules).
 *
 * @param {{rfq_product_ids:number[], remarks:string}} input remarks required
 * @returns {Promise<{rfq, reopened:number[], already_open:number[]}>}
 */
export async function reopenItems(t, user, rfqId, { rfq_product_ids, remarks } = {}) {
  const ids = idList(rfq_product_ids);
  const note = cleanRemarks(remarks);
  if (!note) throw invalid('Say why the item is being reopened', { field: 'remarks' });

  const rfq = await loadRfq(t, rfqId, { forUpdate: true });
  assertCreator(rfq, user);
  assertLive(rfq);

  const rows = await t.any(
    `SELECT id, closed_at FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id FOR UPDATE`,
    [rfq.id]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new RfqItemClosureError('NOT_FOUND', 'Some items are not on this RFQ', { rfq_product_ids: missing });
  }
  const toReopen = ids.filter((id) => byId.get(id).closed_at);
  const alreadyOpen = ids.filter((id) => !byId.get(id).closed_at);

  if (toReopen.length) {
    await t.none(
      `UPDATE tbl_rfq_products
          SET closed_at = NULL, closed_by = NULL, close_reason_code = NULL, close_remarks = NULL
        WHERE rfq_id = $1 AND id = ANY($2::int[]) AND closed_at IS NOT NULL`,
      [rfq.id, toReopen]
    );
    await writeClosureRows(t, {
      rfqId: rfq.id, itemIds: toReopen, action: 'reopen', reasonCode: null, remarks: note, userId: positiveInt(user?.id),
    });
  }
  return {
    rfq: { id: Number(rfq.id), rfq_no: rfq.rfq_no, title: rfq.title, is_tender: Number(rfq.is_tender) === 1 },
    reopened: toReopen,
    already_open: alreadyOpen,
  };
}

/**
 * Parse the optional item-closure part of a Close RFQ request:
 *   { item_reason_code?, item_remarks?, items?: [{rfq_product_id, reason_code, remarks?}] }
 * Missing reason → rfq_closed (remarks default to the RFQ close comment).
 */
export function parseCloseRfqItemInput(body = {}, closeComment = null) {
  const defaultRemarks = cleanRemarks(body.item_remarks, 'item_remarks') ?? cleanRemarks(closeComment, 'comment');
  let defaultReason = RFQ_CLOSED_REASON;
  if (body.item_reason_code != null && body.item_reason_code !== '') {
    checkReason(body.item_reason_code, defaultRemarks, 'item_reason_code');
    defaultReason = body.item_reason_code;
  }
  const overrides = new Map();
  if (body.items != null) {
    if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) throw invalid('items must be a list', { field: 'items' });
    for (const it of body.items) {
      const id = positiveInt(it?.rfq_product_id);
      if (!id) throw invalid('Item ids must be positive integers', { field: 'items' });
      const r = cleanRemarks(it.remarks, 'items.remarks') ?? defaultRemarks;
      checkReason(it.reason_code, r, 'items.reason_code');
      overrides.set(id, { reason_code: it.reason_code, remarks: r });
    }
  }
  return { defaultReason, defaultRemarks, overrides };
}

/**
 * Inside closeRFQ's transaction, after its status write and cancellations:
 * close every item still open (no award, no live PO), so a closed RFQ never
 * has an item without an outcome. Items already awarded or closed are left
 * as they are.
 *
 * @returns {Promise<number[]>} the item ids closed
 */
export async function closeLeftoverItemsTx(t, { rfqId, userId, defaultReason, defaultRemarks, overrides = new Map() }) {
  const facts = await getRfqItemFacts(t, rfqId, { lock: true });
  // award_pending cannot survive closeRFQ (it cancels those approvals first),
  // so an item with a finalization reads as awarded here, as it always has.
  const open = facts.filter((f) => !f.closed_at && !f.finalized && !f.live_po).map((f) => Number(f.id));
  const unknown = [...overrides.keys()].filter((id) => !facts.some((f) => Number(f.id) === id));
  if (unknown.length) {
    throw new RfqItemClosureError('NOT_FOUND', 'Some items are not on this RFQ', { rfq_product_ids: unknown });
  }
  if (!open.length) return [];

  // Group by (reason, remarks) so each group is one UPDATE and one INSERT.
  const groups = new Map();
  for (const id of open) {
    const o = overrides.get(id) || { reason_code: defaultReason, remarks: defaultRemarks };
    const key = JSON.stringify([o.reason_code, o.remarks]);
    if (!groups.has(key)) groups.set(key, { ...o, ids: [] });
    groups.get(key).ids.push(id);
  }
  for (const g of groups.values()) {
    await t.none(
      `UPDATE tbl_rfq_products
          SET closed_at = now(), closed_by = $3, close_reason_code = $4, close_remarks = $5
        WHERE rfq_id = $1 AND id = ANY($2::int[]) AND closed_at IS NULL`,
      [rfqId, g.ids, positiveInt(userId), g.reason_code, g.remarks]
    );
    await writeClosureRows(t, {
      rfqId, itemIds: g.ids, action: 'close', reasonCode: g.reason_code, remarks: g.remarks, userId: positiveInt(userId),
    });
  }
  return open;
}

/**
 * Which of the given quote lines are on items closed without award.
 * lines: [{product_variant_id, variant}] as the quote endpoints receive them.
 * @returns {Promise<Array<{rfq_product_id, product_variant_id, variant}>>}
 */
export async function findClosedItems(dbCtx, rfqId, lines) {
  const pvs = [];
  const variants = [];
  for (const l of lines || []) {
    const pv = positiveInt(l?.product_variant_id);
    if (!pv) continue;
    pvs.push(pv);
    variants.push(l.variant == null || l.variant === '' ? null : Number(l.variant));
  }
  if (!pvs.length || !positiveInt(rfqId)) return [];
  const rows = await dbCtx.any(
    `SELECT DISTINCT rp.id, rp.product_variant_id, rp.variant
       FROM tbl_rfq_products rp
       JOIN unnest($2::int[], $3::int[]) AS l(pv, v)
         ON rp.product_variant_id = l.pv AND rp.variant IS NOT DISTINCT FROM l.v
      WHERE rp.rfq_id = $1 AND rp.closed_at IS NOT NULL`,
    [positiveInt(rfqId), pvs, variants]
  );
  return rows.map((r) => ({
    rfq_product_id: Number(r.id),
    product_variant_id: Number(r.product_variant_id),
    variant: r.variant == null ? null : Number(r.variant),
  }));
}

/** Answer a failed closure request (called after the transaction). */
export function sendItemClosureError(res, err) {
  if (err instanceof RfqItemClosureError) {
    return res.status(err.httpStatus).json({
      status: err.code === 'NOT_FOUND' ? 2 : 0,
      message: err.message,
      code: err.code,
      details: err.details,
    });
  }
  return null;
}
