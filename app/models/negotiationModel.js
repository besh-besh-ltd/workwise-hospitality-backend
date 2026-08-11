import db, { pgp } from '../config/dbConn.js';

// Helper: parse date strings as UTC when no timezone suffix is present
// PostgreSQL returns timestamp without time zone as bare strings (e.g. "2026-03-27 18:54:00")
// which new Date() would incorrectly interpret as local time
const parseAsUTC = (dateValue) => {
  if (!dateValue) return null;
  if (dateValue instanceof Date) return dateValue;
  const str = String(dateValue);
  if (str.includes('+') || str.includes('Z')) return new Date(str);
  return new Date(str.replace(' ', 'T') + 'Z');
};

// ============= READ-SCOPE (RBAC MATRIX) =============
// P0 FIX: the negotiation listings used to scope rows to the caller's
// hospitality COMPANY only. That leaked every hotel's negotiation rounds —
// vendor identities and negotiated prices included — to any user mapped to the
// company, because resolveHospitalityCompanyScope() collapses a hotel-level
// mapping (mapping_type = 1) into a company-wide read.
//
// The authoritative per-row scope is the RBAC matrix in tbl_user_role_scopes,
// exactly as the RFQ listing already enforces it (rfqModel.getRfqList).
// NULL on an axis of a scope row means "all" for that axis:
//   company  — must match exactly (never NULL in the table)
//   hotel    — NULL = every hotel under the company
//   dept     — NULL = every department (also matched when the row has no dept)
//   process  — NULL = every process
//
// `userParam` is a literal SQL expression yielding the caller's user id (a
// pg-promise placeholder such as '$3'). It is NULL only for super admins
// (user_type 8), who legitimately read everything.
//
// The permission resource is 'negotiation' (verified in production:
// tbl_permissions holds negotiation × {read,create,update,delete,approve}).
// Note the resource_type enum ALSO contains a legacy misspelling
// 'negotitation' which nothing is seeded under — do not use it.
export const negotiationReadScopeSql = (alias, userParam) =>
  `(${userParam}::int IS NULL OR EXISTS (
       SELECT 1
         FROM tbl_user_role_scopes _urs
         JOIN tbl_role_permissions _rp ON _rp.role_id = _urs.role_id
         JOIN tbl_permissions _p       ON _p.id = _rp.permission_id
        WHERE _urs.user_id = ${userParam}::int
          AND _p.resource = 'negotiation'::resource_type
          AND _p.action = 'read'
          AND _urs.company_id = ${alias}.hospitality_company_id
          AND (_urs.hotel_id IS NULL OR _urs.hotel_id = ${alias}.hotel_id)
          AND (
            ${alias}.department_id IS NULL
            OR _urs.department_id IS NULL
            OR _urs.department_id = ${alias}.department_id
          )
          AND (_urs.process_id IS NULL OR _urs.process_id = ${alias}.process_id)
     ))`;

// ============= MULTI-PRODUCT ROUND HELPERS =============
// A round either targets a single product (legacy: rfq_product_id NOT NULL,
// per-vendor fields in vendor_approvals[].negotiation_fields) or multiple
// products (products JSONB: [{rfq_product_id, vendor_targets}, ...,
// {is_rfq_level: true, vendor_targets}]).

// SQL predicate: does round `nr` cover product <paramRef>? Works for both
// legacy and multi shapes. `paramRef` is a pg-promise placeholder ('$2' etc).
export const coversProductSql = (paramRef, alias = 'nr') =>
  `(${alias}.rfq_product_id = ${paramRef} OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) cp_
     WHERE (cp_->>'rfq_product_id')::int = ${paramRef}))`;

// LATERAL emitting `product_names` json array for every product the round
// covers: [{rfq_product_id, product_name}, ...]. NULL for rfq-level-only.
export const productNamesLateralSql = (alias = 'nr') =>
  `LEFT JOIN LATERAL (
     SELECT json_agg(json_build_object(
              'rfq_product_id', rp_.id,
              'product_name', COALESCE(PV_.name, P_.name, 'Product #' || rp_.product_variant_id)
            ) ORDER BY rp_.id) AS product_names
     FROM tbl_rfq_products rp_
     LEFT JOIN tbl_product_variant PV_ ON PV_.id = rp_.product_variant_id
     LEFT JOIN tbl_product P_ ON P_.id = PV_.product_id
     WHERE rp_.id = ${alias}.rfq_product_id
        OR rp_.id IN (
          SELECT (p_->>'rfq_product_id')::int
          FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) p_
          WHERE p_->>'rfq_product_id' IS NOT NULL
        )
   ) pn_ ON true`;

// Same predicate, generalised to "does round `nr` cover ANY of <paramRef>?"
// (`paramRef` is an int[] placeholder). Used by the round-detail API, which has
// to gather every sibling / prior round touching the products of one round.
export const coversAnyProductSql = (paramRef, alias = 'nr') =>
  `(${alias}.rfq_product_id = ANY(${paramRef}::int[]) OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) cp_
     WHERE (cp_->>'rfq_product_id')::int = ANY(${paramRef}::int[])))`;

// ARC counterpart of coversAnyProductSql (ARC rounds key on arc_item_id).
export const coversAnyArcItemSql = (paramRef, alias = 'nr') =>
  `(${alias}.arc_item_id = ANY(${paramRef}::bigint[]) OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(COALESCE(${alias}.products,'[]'::jsonb)) ca_
     WHERE (ca_->>'arc_item_id')::bigint = ANY(${paramRef}::bigint[])))`;

// Product ids covered by a round row (legacy fallback to rfq_product_id).
export const getCoveredProductIds = (round) => {
  if (Array.isArray(round?.products) && round.products.length > 0) {
    return round.products
      .map(p => p?.rfq_product_id)
      .filter(id => id != null)
      .map(Number);
  }
  return round?.rfq_product_id != null ? [Number(round.rfq_product_id)] : [];
};

// Per-vendor negotiation fields for one product (or 'RFQ_LEVEL') of a round.
export const getVendorFieldsForProduct = (round, vendorId, rfqProductId) => {
  if (Array.isArray(round?.products) && round.products.length > 0) {
    const entry = round.products.find(p => rfqProductId === 'RFQ_LEVEL'
      ? p?.is_rfq_level === true
      : Number(p?.rfq_product_id) === Number(rfqProductId));
    const vt = (entry?.vendor_targets || []).find(v => Number(v?.vendor_id) === Number(vendorId));
    return vt?.fields || [];
  }
  const va = (round?.vendor_approvals || []).find(v => Number(v?.vendor_id) === Number(vendorId));
  return va?.negotiation_fields || [];
};

// Security: when a vendor reads a round, their view of products[] must only
// carry their own vendor_targets — other vendors' targets must never leak.
export const stripProductsForVendor = (round, vendorId) => {
  if (round && Array.isArray(round.products)) {
    round.products = round.products.map(p => ({
      ...p,
      vendor_targets: (p?.vendor_targets || []).filter(
        vt => Number(vt?.vendor_id) === Number(vendorId)
      ),
    }));
  }
  return round;
};

// Backfill the singular `product_name` for multi rounds (first covered
// product) so legacy consumers keep rendering something sensible.
const normalizeProductNames = (row) => {
  if (!row) return row;
  if (!row.product_name && Array.isArray(row.product_names) && row.product_names.length > 0) {
    row.product_name = row.product_names[0]?.product_name || null;
  }
  return row;
};

// ============================================================================
// ROUND DETAIL ("Negotiation Command Center")
// ============================================================================
//
// Everything below backs GET /negotiation/rounds/:id/detail. The maths is
// deliberately explicit because two production facts make naive versions wrong:
//
//   * For RFQ rounds `tbl_negotiation_round_quotes.quoted_price` is the landed
//     LINE TOTAL (it is written straight from tbl_quote_items.total_price at
//     both vendor-quote write sites), while a `base_price` target in
//     vendor_approvals[].negotiation_fields is a UNIT price. Subtracting one
//     from the other is wrong by roughly (quantity x tax).
//     => achieved_pct is a LINE-TOTAL ratio, requested_pct is a UNIT ratio,
//        and BOTH are taken off the same baseline so they are comparable.
//
//   * For ARC rounds the same column holds a UNIT rate (arcNegotiationController
//     writes `Number(rate)`), and previous_price IS populated there. The two
//     sources therefore need different bases — see `amount_basis` on each line.
//
// Savings are SIGNED and never clamped: prices genuinely go up (production
// rounds 890 and 891 both came back higher than the baseline). Note that
// dashboardModel.getNegotiationSavingsData clamps with Math.max(x, 0); this
// module deliberately does not.

// Target field names that are free text and must NEVER enter numeric maths.
// Verified against production: payment_terms (469 occurrences), documents (83),
// comment (56), comments (31), global_comment (9), delivery_period (2).
export const NEGOTIATION_TEXT_TARGET_FIELDS = new Set([
  'payment_terms',
  'documents',
  'comment',
  'comments',
  'global_comment',
  'delivery_period',
  'vendor_tc',
]);

const MONEY_EPSILON = 0.005;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const round4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const isoOrNull = (v) => {
  const d = parseAsUTC(v);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

// The (product | arc item | rfq-level) slots a round negotiates over.
export const getRoundItemSlots = (round) => {
  const prods = Array.isArray(round?.products) ? round.products : [];
  if (prods.length > 0) {
    return prods.map((p) =>
      p?.is_rfq_level === true || p?.is_arc_level === true
        ? { rfq_product_id: null, arc_item_id: null, is_rfq_level: true }
        : {
            rfq_product_id: p?.rfq_product_id != null ? Number(p.rfq_product_id) : null,
            arc_item_id: p?.arc_item_id != null ? Number(p.arc_item_id) : null,
            is_rfq_level: false,
          }
    );
  }
  if (round?.rfq_product_id != null) {
    return [{ rfq_product_id: Number(round.rfq_product_id), arc_item_id: null, is_rfq_level: false }];
  }
  if (round?.arc_item_id != null) {
    return [{ rfq_product_id: null, arc_item_id: Number(round.arc_item_id), is_rfq_level: false }];
  }
  return [{ rfq_product_id: null, arc_item_id: null, is_rfq_level: true }];
};

// PER_ITEM (legacy single product) | MULTI_ITEM | WHOLE_RFQ.
export const getRoundMode = (round) => {
  const slots = getRoundItemSlots(round);
  const itemSlots = slots.filter((s) => !s.is_rfq_level);
  if (itemSlots.length === 0) return 'WHOLE_RFQ';
  const prods = Array.isArray(round?.products) ? round.products : [];
  return prods.length > 0 ? 'MULTI_ITEM' : 'PER_ITEM';
};

// Every vendor the round touches — vendor_ids is NULL on 71 production rounds,
// so vendor_approvals and products[].vendor_targets are folded in as well.
export const getRoundVendorIds = (round) => {
  const set = new Set();
  (Array.isArray(round?.vendor_ids) ? round.vendor_ids : []).forEach((v) => {
    if (v != null) set.add(Number(v));
  });
  (Array.isArray(round?.vendor_approvals) ? round.vendor_approvals : []).forEach((va) => {
    if (va?.vendor_id != null) set.add(Number(va.vendor_id));
  });
  (Array.isArray(round?.products) ? round.products : []).forEach((p) =>
    (p?.vendor_targets || []).forEach((vt) => {
      if (vt?.vendor_id != null) set.add(Number(vt.vendor_id));
    })
  );
  return [...set].sort((a, b) => a - b);
};

// Split a vendor's negotiation_fields into numeric asks and free-text asks.
// A numeric field whose target does not parse as a finite number is demoted to
// text — never guessed at.
export const splitTargetFields = (fields) => {
  const numeric = [];
  const text = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    const name = f?.name != null ? String(f.name) : null;
    if (!name) continue;
    const rawTarget = f?.target;
    if (NEGOTIATION_TEXT_TARGET_FIELDS.has(name)) {
      text.push({ name, target: rawTarget == null ? null : String(rawTarget), demand: f?.demand == null ? null : String(f.demand) });
      continue;
    }
    const parsed = num(rawTarget);
    if (parsed == null) {
      text.push({ name, target: rawTarget == null ? null : String(rawTarget), demand: f?.demand == null ? null : String(f.demand) });
      continue;
    }
    numeric.push({ name, target: parsed, mode: f?.mode ? String(f.mode) : null });
  }
  return { numeric, text };
};

// Effective status: the raw column plus the end_date check the listings apply.
export const getEffectiveRoundStatus = (round, now = Date.now()) => {
  const status = String(round?.status || '').toUpperCase();
  const end = parseAsUTC(round?.end_date);
  const past = end ? end.getTime() <= now : false;
  if (status === 'ACTIVE') return past ? 'AWAITING_DECISION' : 'ACTIVE';
  if (status === 'ENDED') return 'AWAITING_DECISION';
  return status || 'UNKNOWN';
};

// ============= NEGOTIATION STATE TAXONOMY =============
//
// ONE vocabulary for both surfaces (listing row + round-detail page). The raw
// `tbl_negotiation_rounds.status` column collapses genuinely different
// situations into the same word, so every user-facing state is derived here and
// nowhere else.
//
// Production distribution of the raw column (886 rounds, verified 2026-07-30):
//   ENDED 622 · EXPIRED 171 · CANCELLED 88 · COMPLETED 5.
//   DRAFT / PENDING_APPROVAL / ACTIVE are reachable in code, zero rows today.
//
// Why the raw column is not enough:
//   • EXPIRED is written ONLY by the approval-deadline cron (cronManager.js)
//     when a round is still PENDING_APPROVAL at its end date. All 171 have
//     0 approvals, 0 publishes and 0 vendor quotes — they never reached a
//     vendor. That is a completely different event from CANCELLED (88, of
//     which 29 were approved, 29 published and 14 collected quotes).
//   • ENDED covers three unrelated situations: nobody replied (177), replies
//     are sitting there waiting for a decision (92), and the decision has
//     already been taken downstream (353).
//
// Derivation inputs, all of which the callers must supply:
//   status            raw tbl_negotiation_rounds.status
//   endDate           raw end_date (UTC-naive)
//   responseCount     rows in tbl_negotiation_round_quotes for the round
//   hasApprovedQuote  an APPROVED NEGOTIATION_QUOTE approval instance exists
//                     on one of the round's products FOR A VENDOR THAT QUOTED
//                     IN THIS ROUND. The vendor match is what makes it "quotes
//                     from THIS round" rather than "this product was finalised
//                     at some point" — the loose form marks 545/622 ENDED
//                     rounds concluded, including superseded earlier rounds.
export const NEG_STATE = {
  AWAITING_APPROVAL: 'awaiting_approval',
  OPEN_WITH_VENDORS: 'open_with_vendors',
  READY_FOR_DECISION: 'ready_for_decision',
  NO_VENDOR_RESPONSE: 'no_vendor_response',
  CONCLUDED: 'concluded',
  LAPSED: 'lapsed',
  CANCELLED: 'cancelled',
};

// Labels are SENTENCE CASE everywhere. The listing used to render Title Case
// ("Pending Approval") while the detail page rendered sentence case ("Pending
// approval") for the same round; one table now feeds both.
export const NEG_STATE_PRESENTATION = {
  [NEG_STATE.AWAITING_APPROVAL]: {
    label: 'Awaiting your approval',
    description: 'Waiting for an internal approver before vendors are notified.',
    tone: 'committee',
    badge: 'committee',
    order: 0,
  },
  [NEG_STATE.OPEN_WITH_VENDORS]: {
    label: 'Open with vendors',
    description: 'Vendors invited and can still submit revised prices.',
    tone: 'active',
    badge: 'active',
    order: 1,
  },
  [NEG_STATE.READY_FOR_DECISION]: {
    label: 'Ready for your decision',
    description: 'Window closed and vendors responded — choose which quotes to take forward.',
    tone: 'awaiting',
    badge: 'awaiting',
    order: 2,
  },
  [NEG_STATE.NO_VENDOR_RESPONSE]: {
    label: 'Closed — no vendor response',
    description: 'Window closed, no vendor replied. Nothing to evaluate.',
    tone: 'closed',
    badge: 'expired',
    order: 3,
  },
  [NEG_STATE.CONCLUDED]: {
    label: 'Concluded',
    description: 'Quotes from this round were selected and approved.',
    tone: 'success',
    badge: 'active',
    order: 4,
  },
  [NEG_STATE.LAPSED]: {
    label: 'Lapsed — never approved',
    description:
      'The approval deadline passed before anyone approved it, so this round never reached vendors.',
    tone: 'expired',
    badge: 'expired',
    order: 5,
  },
  [NEG_STATE.CANCELLED]: {
    label: 'Cancelled',
    description: 'Someone cancelled this round deliberately.',
    tone: 'danger',
    badge: 'expired',
    order: 6,
  },
};

// Lifecycle sort order for the listing's "Lifecycle order" sort.
export const NEG_STATE_ORDER = Object.fromEntries(
  Object.entries(NEG_STATE_PRESENTATION).map(([k, v]) => [k, v.order])
);

// ============= PARENT (RFQ / ARC) ROLL-UP STATE =============
//
// The listing groups by PARENT, so an RFQ with 138 rounds is ONE row and needs
// ONE status. That status is a ROLL-UP over the states present, not the latest
// round's state and NOT NEG_STATE_ORDER.
//
// The precedence is ACTION-FIRST: rungs 0-2 need a human, rungs 3-6 do not.
//
//   0 awaiting_approval   an approver is blocking
//   1 open_with_vendors   vendors can still move the number
//   2 ready_for_decision  the buyer is blocking
//   3 concluded           a decision was taken
//   4 no_vendor_response  nobody replied
//   5 lapsed              never approved in time
//   6 cancelled           deliberately stopped
//
// This is DELIBERATELY NOT NEG_STATE_ORDER. The round-level order puts
// no_vendor_response ABOVE concluded, which is right for one round ("this
// round got nothing") and wrong for an RFQ. Measured on production
// 2026-08-01: 15 of the 124 RFQs in negotiation contain at least one
// no-response round AND at least one concluded round. Under the round-level
// order all 15 would head their card "Closed — no vendor response" while a
// later round of the same RFQ had actually concluded.
//
// NEG_STATE_ORDER is left untouched: the round listing's "Lifecycle order"
// sort and the round-detail page both read it.
export const NEG_PARENT_STATE_ORDER = Object.freeze({
  [NEG_STATE.AWAITING_APPROVAL]: 0,
  [NEG_STATE.OPEN_WITH_VENDORS]: 1,
  [NEG_STATE.READY_FOR_DECISION]: 2,
  [NEG_STATE.CONCLUDED]: 3,
  [NEG_STATE.NO_VENDOR_RESPONSE]: 4,
  [NEG_STATE.LAPSED]: 5,
  [NEG_STATE.CANCELLED]: 6,
});

// Rungs 0-2 — the parent is waiting on a person. Drives the "needs attention"
// split on the parent card.
export const NEG_PARENT_ACTION_STATES = Object.freeze(
  new Set([NEG_STATE.AWAITING_APPROVAL, NEG_STATE.OPEN_WITH_VENDORS, NEG_STATE.READY_FOR_DECISION])
);

// Precedence, most-urgent first. Single source of truth for both the JS
// roll-up and the SQL CASE below, so the two can never drift.
const NEG_PARENT_PRECEDENCE = Object.entries(NEG_PARENT_STATE_ORDER)
  .sort((a, b) => a[1] - b[1])
  .map(([state]) => state);

/**
 * Roll a parent's round states up to ONE state. Pure; the SQL CASE below is a
 * transcription of it and negotiation.listView.parent.test.js asserts they
 * agree. Unknown states are ignored; an empty set yields null.
 */
export const rollUpNegotiationStates = (states) => {
  const present = new Set((Array.isArray(states) ? states : []).map((s) => String(s)));
  for (const state of NEG_PARENT_PRECEDENCE) {
    if (present.has(state)) return state;
  }
  return null;
};

// SQL transcription of rollUpNegotiationStates, for use in the GROUP BY of the
// parent queries. `stateExpr` is the per-round state expression of the
// subquery being aggregated (i.e. the output of negotiationStateCaseSql).
export const negotiationParentStateCaseSql = (stateExpr) =>
  `CASE
     ${NEG_PARENT_PRECEDENCE.map(
       (s) => `WHEN bool_or(${stateExpr} = '${s}') THEN '${s}'`
     ).join('\n     ')}
     ELSE NULL
   END`;

// jsonb object carrying one count per NEG_STATE key. Every key is always
// present (zero when absent) so the client can render a fixed set of chips
// without null-guarding each one.
export const negotiationStateCountsSql = (stateExpr) =>
  `jsonb_build_object(${Object.values(NEG_STATE)
    .map((s) => `'${s}', COUNT(*) FILTER (WHERE ${stateExpr} = '${s}')::int`)
    .join(', ')})`;

/**
 * Derive the user-facing state of ONE round. Pure — the SQL CASE in the two
 * listing queries below is a literal transcription of this ladder, and
 * negotiation.statusTaxonomy.test.js asserts the two agree.
 */
export const deriveNegotiationState = (
  { status, endDate = null, responseCount = 0, hasApprovedQuote = false } = {},
  now = Date.now()
) => {
  const raw = String(status || '').toUpperCase();
  if (raw === 'DRAFT' || raw === 'PENDING_APPROVAL') return NEG_STATE.AWAITING_APPROVAL;
  if (raw === 'EXPIRED') return NEG_STATE.LAPSED;
  if (raw === 'CANCELLED') return NEG_STATE.CANCELLED;

  const end = parseAsUTC(endDate);
  const windowOpen = end == null || end.getTime() > now;
  if (raw === 'ACTIVE' && windowOpen) return NEG_STATE.OPEN_WITH_VENDORS;

  // COMPLETED is concluded by definition, even on the one production round
  // that reached it with zero vendor responses.
  if (raw === 'COMPLETED') return NEG_STATE.CONCLUDED;

  // ENDED, or ACTIVE whose window has closed.
  if (Number(responseCount || 0) === 0) return NEG_STATE.NO_VENDOR_RESPONSE;
  if (hasApprovedQuote) return NEG_STATE.CONCLUDED;
  return NEG_STATE.READY_FOR_DECISION;
};

export const negotiationStatePresentation = (state) =>
  NEG_STATE_PRESENTATION[state] || {
    label: 'Unknown',
    description: 'This round is in a state the application does not recognise.',
    tone: 'neutral',
    badge: 'draft',
    order: 9,
  };

// SQL transcription of deriveNegotiationState. `alias` is the rounds table
// alias, `quotesExpr` an int expression for the round's response count and
// `approvedExpr` a boolean expression for hasApprovedQuote.
export const negotiationStateCaseSql = (alias, quotesExpr, approvedExpr) =>
  `CASE
     WHEN ${alias}.status IN ('DRAFT','PENDING_APPROVAL') THEN '${NEG_STATE.AWAITING_APPROVAL}'
     WHEN ${alias}.status = 'EXPIRED'   THEN '${NEG_STATE.LAPSED}'
     WHEN ${alias}.status = 'CANCELLED' THEN '${NEG_STATE.CANCELLED}'
     WHEN ${alias}.status = 'ACTIVE'
          AND (${alias}.end_date IS NULL OR ${alias}.end_date > (now() AT TIME ZONE 'UTC'))
       THEN '${NEG_STATE.OPEN_WITH_VENDORS}'
     WHEN ${alias}.status = 'COMPLETED' THEN '${NEG_STATE.CONCLUDED}'
     WHEN COALESCE(${quotesExpr}, 0) = 0 THEN '${NEG_STATE.NO_VENDOR_RESPONSE}'
     WHEN ${approvedExpr} THEN '${NEG_STATE.CONCLUDED}'
     ELSE '${NEG_STATE.READY_FOR_DECISION}'
   END`;

// LATERAL: has any vendor that quoted in THIS round had its quote approved
// downstream (APPROVED NEGOTIATION_QUOTE on the same rfq_product, same vendor)?
// See the NEG_STATE header for why the vendor match is load-bearing.
export const approvedQuoteLateralSql = (alias = 'nr', out = 'aq') =>
  `LEFT JOIN LATERAL (
     SELECT EXISTS (
       SELECT 1
         FROM tbl_negotiation_round_quotes _nrq
         JOIN tbl_approval_instances _ai
           ON _ai.entity_type = 'NEGOTIATION_QUOTE'
          AND _ai.status = 'APPROVED'
          AND _ai.entity_id = _nrq.rfq_product_id
          AND (_ai.metadata->>'vendor_id') ~ '^[0-9]+$'
          AND (_ai.metadata->>'vendor_id')::int = _nrq.vendor_id
        WHERE _nrq.negotiation_round_id = ${alias}.id
     ) AS has_approved_quote
   ) ${out} ON TRUE`;

// ============= ROUND POSITION (the displayed "Round N of M") =============
//
// PRODUCT DEFINITION (authoritative):
//   "round_number means the number of the current round in the whole RFQ, not
//    product-wise. If this RFQ had 3 rounds for 3 different products, then a
//    round for a brand-new product 4 should get round 4, not round 1."
//
// One round = one position, regardless of how many products it covers.
//
// The STORED column does not obey that definition. The legacy allocator
// (getNextRoundNumber, per rfq_product_id) restarted at 1 for every product,
// so on RFQ 512 eight different rounds are stored as `round_number = 1` and
// the highest stored value is 4 across 138 rounds. Rendering the stored value
// gives "Round 1 of 138" eight times over.
//
// So the NUMERATOR is computed at read time and the stored column is left
// alone — no migration, and legacy and new rows both come out right:
//
//   ROW_NUMBER() OVER (PARTITION BY <parent> ORDER BY created_at, id)
//
// and the DENOMINATOR is the matching COUNT(*) OVER (PARTITION BY <parent>).
//
// Window-frame correctness: both listing queries filter on RFQ/ARC-level
// predicates only (company, hotel, and the RBAC read matrix all resolve
// against the parent), so for any parent either every one of its rounds is in
// the result set or none is. The window therefore sees the complete parent and
// the position is exact — it is NOT a position within the visible page.
export const roundPositionSql = (partitionExpr, alias = 'nr') =>
  `ROW_NUMBER() OVER (PARTITION BY ${partitionExpr} ORDER BY ${alias}.created_at, ${alias}.id)::int`;

export const roundTotalSql = (partitionExpr) => `COUNT(*) OVER (PARTITION BY ${partitionExpr})::int`;

// Supplementary context, NOT the denominator: how many rounds touched the same
// product(s) as this one. Useful on the detail page ("4 rounds on this
// product") but it never divides the position.
export const roundCycleLateralSql = (alias = 'nr') =>
  `LEFT JOIN LATERAL (
     SELECT COALESCE(array_agg(DISTINCT _pid) FILTER (WHERE _pid IS NOT NULL), '{}'::int[]) AS ids
       FROM (
         SELECT ${alias}.rfq_product_id AS _pid
         UNION ALL
         SELECT (_p->>'rfq_product_id')::int
           FROM jsonb_array_elements(COALESCE(${alias}.products, '[]'::jsonb)) _p
       ) _s
   ) mine ON TRUE
   LEFT JOIN LATERAL (
     SELECT COUNT(*)::int AS rounds_on_products,
            COALESCE(MAX(_nr2.round_number), ${alias}.round_number)::int AS max_round_number_on_products
       FROM tbl_negotiation_rounds _nr2
      WHERE _nr2.rfq_id = ${alias}.rfq_id
        AND (
          CASE WHEN cardinality(mine.ids) = 0
               THEN _nr2.rfq_product_id IS NULL
                    AND COALESCE(jsonb_array_length(_nr2.products), 0) = 0
               ELSE _nr2.rfq_product_id = ANY(mine.ids)
                    OR EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements(COALESCE(_nr2.products, '[]'::jsonb)) _c
                          WHERE (_c->>'rfq_product_id')::int = ANY(mine.ids))
          END
        )
   ) cyc ON TRUE`;

// ARC counterpart. ARC rounds are already allocated per contract
// (arcNegotiationModel.getNextRoundNumber takes only arcId), so stored value
// and computed position agree there — the position is still computed so both
// branches answer identically.
export const arcRoundCycleLateralSql = (alias = 'nr') =>
  `LEFT JOIN LATERAL (
     SELECT COUNT(*)::int AS rounds_on_products,
            COALESCE(MAX(_nr2.round_number), ${alias}.round_number)::int AS max_round_number_on_products
       FROM tbl_negotiation_rounds _nr2
      WHERE _nr2.source_type = 'ARC'
        AND _nr2.source_id = ${alias}.source_id
   ) cyc ON TRUE`;

// Given a landed line total, recover the matching unit price by finding the
// quote-item revision that produced it. Falls back to arithmetic only when no
// revision matches (percentage tax is the only mode production uses here).
const resolveUnitForAmount = (facts, amount) => {
  if (amount == null || !facts) return { unit: null, source: null };
  const cur = num(facts.total_price);
  if (cur != null && Math.abs(cur - amount) < MONEY_EPSILON) {
    return { unit: num(facts.unit_price), source: 'current_quote' };
  }
  const history = Array.isArray(facts.history_rows) ? facts.history_rows : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = num(history[i]?.total_price);
    if (h != null && Math.abs(h - amount) < MONEY_EPSILON) {
      return { unit: num(history[i]?.unit_price), source: 'quote_history' };
    }
  }
  const qty = num(facts.quantity);
  const tax = num(facts.tax);
  if (qty && qty !== 0) {
    const uplift = String(facts.tax_mode || 'percentage') === 'percentage' && tax != null ? 1 + tax / 100 : 1;
    if (uplift !== 0) return { unit: amount / (qty * uplift), source: 'derived' };
  }
  return { unit: null, source: null };
};

// Baseline resolution. The ORDER is the contract; `baseline_source` on every
// line reports which rung was used, because the derivation varies enough that
// presenting the number without its provenance would be dishonest.
//
//   previous_price -> prior_round -> quote_history -> current_quote
//
// Production distribution over the 520 legacy round-quote rows:
//   previous_price 0 · prior_round 78 · quote_history 411 · current_quote 31.
export const resolveBaseline = ({ sourceType, roundQuote, priorRoundQuote, facts }) => {
  const isArc = sourceType === 'ARC';

  const prev = num(roundQuote?.previous_price);
  if (prev != null) {
    return { amount: prev, source: 'previous_price', round_id: null, captured_at: null };
  }

  if (priorRoundQuote && num(priorRoundQuote.quoted_price) != null) {
    return {
      amount: num(priorRoundQuote.quoted_price),
      source: 'prior_round',
      round_id: Number(priorRoundQuote.negotiation_round_id),
      captured_at: priorRoundQuote.submitted_at || null,
    };
  }

  if (isArc) {
    const rate = num(facts?.arc_line_rate);
    if (rate != null) return { amount: rate, source: 'current_quote', round_id: null, captured_at: null };
    return { amount: null, source: null, round_id: null, captured_at: null };
  }

  const history = Array.isArray(facts?.history_rows) ? facts.history_rows : [];
  if (history.length > 0 && num(history[0]?.total_price) != null) {
    return {
      amount: num(history[0].total_price),
      source: 'quote_history',
      round_id: null,
      captured_at: history[0]?.timestamp || null,
    };
  }

  const cur = num(facts?.total_price);
  if (cur != null) return { amount: cur, source: 'current_quote', round_id: null, captured_at: null };

  return { amount: null, source: null, round_id: null, captured_at: null };
};

// Assemble one (round x item x vendor) line. Pure — all IO already done.
const buildLine = ({ round, slot, vendorId, roundQuote, priorRoundQuote, facts, parentSourceType }) => {
  const isArc = parentSourceType === 'ARC';
  const amountBasis = isArc ? 'unit' : 'line_total';

  const fields = getVendorFieldsForProduct(
    round,
    vendorId,
    slot.is_rfq_level ? 'RFQ_LEVEL' : (slot.rfq_product_id ?? slot.arc_item_id)
  );
  const { numeric, text } = splitTargetFields(fields);
  const basePriceTarget = numeric.find((t) => t.name === 'base_price') || null;
  const targetUnit = basePriceTarget ? basePriceTarget.target : null;

  const quantity = num(facts?.quantity);
  const responded = !!roundQuote;
  const rawQuoted = num(roundQuote?.quoted_price);

  const baseline = resolveBaseline({ sourceType: parentSourceType, roundQuote, priorRoundQuote, facts });

  let achievedLineTotal = null;
  let achievedUnit = null;
  let baselineLineTotal = null;
  let baselineUnit = null;

  if (isArc) {
    achievedUnit = rawQuoted;
    baselineUnit = baseline.amount;
    if (quantity != null) {
      achievedLineTotal = achievedUnit == null ? null : achievedUnit * quantity;
      baselineLineTotal = baselineUnit == null ? null : baselineUnit * quantity;
    }
  } else {
    achievedLineTotal = rawQuoted;
    achievedUnit = resolveUnitForAmount(facts, rawQuoted).unit;
    baselineLineTotal = baseline.amount;
    baselineUnit = resolveUnitForAmount(facts, baseline.amount).unit;
  }

  const canScore = responded && baselineLineTotal != null && achievedLineTotal != null;
  const savedValue = canScore ? baselineLineTotal - achievedLineTotal : null;
  const achievedPct =
    canScore && Math.abs(baselineLineTotal) > MONEY_EPSILON
      ? (savedValue / baselineLineTotal) * 100
      : null;
  const requestedPct =
    targetUnit != null && baselineUnit != null && Math.abs(baselineUnit) > 1e-9
      ? ((baselineUnit - targetUnit) / baselineUnit) * 100
      : null;
  const targetLineTotal =
    targetUnit != null && baselineUnit != null && baselineLineTotal != null && Math.abs(baselineUnit) > 1e-9
      ? baselineLineTotal * (targetUnit / baselineUnit)
      : null;

  const targetMet =
    targetLineTotal != null && achievedLineTotal != null
      ? achievedLineTotal <= targetLineTotal + MONEY_EPSILON
      : null;

  let outcome;
  if (!responded) outcome = 'no_response';
  else if (baselineLineTotal == null || achievedLineTotal == null) outcome = 'no_baseline';
  else if (savedValue < -MONEY_EPSILON) outcome = 'regressed';
  else if (Math.abs(savedValue) <= MONEY_EPSILON) outcome = 'unchanged';
  else if (targetMet === true) outcome = 'target_met';
  else if (targetMet === false) outcome = 'target_missed';
  else outcome = 'improved';

  const approvalEntry = (Array.isArray(round.vendor_approvals) ? round.vendor_approvals : []).find(
    (va) => Number(va?.vendor_id) === Number(vendorId)
  );

  const notes = [];
  if (baseline.source === 'quote_history') {
    const historyCount = Array.isArray(facts?.history_rows) ? facts.history_rows.length : 0;
    if (historyCount > 1) {
      notes.push(
        'Quote history is overwritten in place with no round linkage; the earliest revision was used as the baseline.'
      );
    }
  }
  if (baseline.source === 'current_quote' && responded) {
    notes.push('No earlier price is on record for this vendor and item — the current quote was used as the baseline.');
  }

  return {
    line_id: `${round.id}:${slot.is_rfq_level ? 'RFQ_LEVEL' : slot.rfq_product_id ?? slot.arc_item_id}:${vendorId}`,
    round_id: Number(round.id),
    round_number: Number(round.round_number),
    round_status: round.status,
    is_rfq_level: !!slot.is_rfq_level,
    rfq_product_id: slot.rfq_product_id ?? null,
    arc_item_id: slot.arc_item_id ?? null,
    product_variant_id: facts?.product_variant_id != null ? Number(facts.product_variant_id) : null,
    product_name: facts?.product_name ?? (slot.is_rfq_level ? 'Whole RFQ' : null),
    vendor_id: Number(vendorId),
    vendor_name: facts?.vendor_name ?? null,
    vendor_contact_name: facts?.vendor_contact_name ?? null,
    vendor_email: facts?.vendor_email ?? null,
    vendor_mobile: facts?.vendor_mobile ?? null,
    quantity,
    uom: facts?.uom ?? null,
    amount_basis: amountBasis,
    baseline_line_total: round2(baselineLineTotal),
    baseline_unit: baselineUnit == null ? null : round4(baselineUnit),
    baseline_source: baseline.source,
    baseline_round_id: baseline.round_id,
    baseline_captured_at: isoOrNull(baseline.captured_at),
    target_unit: targetUnit == null ? null : round4(targetUnit),
    target_mode: basePriceTarget?.mode ?? null,
    target_line_total: round2(targetLineTotal),
    has_numeric_target: numeric.length > 0,
    has_unit_target: targetUnit != null,
    achieved_line_total: round2(achievedLineTotal),
    achieved_unit: achievedUnit == null ? null : round4(achievedUnit),
    responded,
    responded_at: isoOrNull(roundQuote?.submitted_at),
    requested_pct: round4(requestedPct),
    achieved_pct: round4(achievedPct),
    saved_value: round2(savedValue),
    target_met: targetMet,
    outcome,
    vendor_approval_status: approvalEntry?.status ?? null,
    vendor_approval_remarks: approvalEntry?.remarks ?? null,
    vendor_approval_acted_at: isoOrNull(approvalEntry?.acted_at),
    vendor_approval_acted_by: approvalEntry?.acted_by ?? null,
    numeric_targets: numeric,
    text_targets: text,
    notes,
  };
};

const EMPTY_SOURCE_COUNTS = () => ({
  previous_price: 0,
  prior_round: 0,
  quote_history: 0,
  current_quote: 0,
  none: 0,
});

// Aggregate a set of lines. Money is summed only over lines that actually have
// BOTH a baseline and an achieved figure, so baseline_total - achieved_total is
// always a like-for-like difference.
export const summariseLines = (lines) => {
  const sources = EMPTY_SOURCE_COUNTS();
  let baselineTotal = 0;
  let achievedTotal = 0;
  let targetBaselineTotal = 0;
  let targetTotal = 0;
  let targetAchievedTotal = 0;
  let scored = 0;
  let targetScored = 0;

  let responded = 0;
  let withTarget = 0;
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let metCount = 0;

  for (const l of lines) {
    sources[l.baseline_source || 'none'] += 1;
    if (l.responded) responded += 1;
    if (l.has_numeric_target) withTarget += 1;

    if (l.saved_value != null) {
      scored += 1;
      baselineTotal += l.baseline_line_total;
      achievedTotal += l.achieved_line_total;
      if (l.saved_value > MONEY_EPSILON) improved += 1;
      else if (l.saved_value < -MONEY_EPSILON) regressed += 1;
      else unchanged += 1;
    }
    if (l.target_line_total != null && l.baseline_line_total != null) {
      targetBaselineTotal += l.baseline_line_total;
      targetTotal += l.target_line_total;
      if (l.achieved_line_total != null) {
        targetAchievedTotal += l.achieved_line_total;
        targetScored += 1;
      }
    }
    if (l.target_met === true) metCount += 1;
  }

  const savedValue = baselineTotal - achievedTotal;
  const savedPct = scored > 0 && Math.abs(baselineTotal) > MONEY_EPSILON ? (savedValue / baselineTotal) * 100 : null;
  const requestedPct =
    targetBaselineTotal > MONEY_EPSILON ? ((targetBaselineTotal - targetTotal) / targetBaselineTotal) * 100 : null;
  const attainmentPct =
    savedPct != null && requestedPct != null && Math.abs(requestedPct) > 1e-9 ? (savedPct / requestedPct) * 100 : null;
  const targetMet = targetScored > 0 ? targetAchievedTotal <= targetTotal + MONEY_EPSILON : null;

  const vendorIds = new Set(lines.map((l) => l.vendor_id));
  const vendorsResponded = new Set(lines.filter((l) => l.responded).map((l) => l.vendor_id));

  return {
    currency: 'INR',
    lines_total: lines.length,
    lines_responded: responded,
    lines_awaiting: lines.length - responded,
    lines_scored: scored,
    lines_with_numeric_target: withTarget,
    lines_improved: improved,
    lines_regressed: regressed,
    lines_unchanged: unchanged,
    lines_target_met: metCount,
    vendors_total: vendorIds.size,
    vendors_responded: vendorsResponded.size,
    baseline_total: round2(baselineTotal),
    achieved_total: round2(achievedTotal),
    target_baseline_total: targetBaselineTotal > 0 ? round2(targetBaselineTotal) : null,
    target_total: targetBaselineTotal > 0 ? round2(targetTotal) : null,
    saved_value: round2(savedValue),
    saved_pct: round4(savedPct),
    requested_pct: round4(requestedPct),
    attainment_pct: round4(attainmentPct),
    target_met: targetMet,
    baseline_sources: sources,
  };
};

// Per-vendor roll-up — "who responded and who didn't", with money.
export const summariseVendors = (lines) => {
  const byVendor = new Map();
  for (const l of lines) {
    if (!byVendor.has(l.vendor_id)) {
      byVendor.set(l.vendor_id, {
        vendor_id: l.vendor_id,
        vendor_name: l.vendor_name,
        vendor_contact_name: l.vendor_contact_name,
        vendor_email: l.vendor_email,
        vendor_mobile: l.vendor_mobile,
        approval_status: l.vendor_approval_status,
        approval_remarks: l.vendor_approval_remarks,
        approval_acted_at: l.vendor_approval_acted_at,
        lines: 0,
        lines_responded: 0,
        first_responded_at: null,
        last_responded_at: null,
        baseline_total: 0,
        achieved_total: 0,
        _scored: 0,
      });
    }
    const v = byVendor.get(l.vendor_id);
    v.lines += 1;
    if (l.responded) {
      v.lines_responded += 1;
      if (l.responded_at) {
        if (!v.first_responded_at || l.responded_at < v.first_responded_at) v.first_responded_at = l.responded_at;
        if (!v.last_responded_at || l.responded_at > v.last_responded_at) v.last_responded_at = l.responded_at;
      }
    }
    if (l.saved_value != null) {
      v.baseline_total += l.baseline_line_total;
      v.achieved_total += l.achieved_line_total;
      v._scored += 1;
    }
  }
  return [...byVendor.values()]
    .map((v) => {
      const saved = v.baseline_total - v.achieved_total;
      const { _scored, ...rest } = v;
      return {
        ...rest,
        has_responded: v.lines_responded > 0,
        baseline_total: round2(v.baseline_total),
        achieved_total: round2(v.achieved_total),
        saved_value: round2(saved),
        saved_pct: _scored > 0 && Math.abs(v.baseline_total) > MONEY_EPSILON ? round4((saved / v.baseline_total) * 100) : null,
      };
    })
    .sort((a, b) => String(a.vendor_name || '').localeCompare(String(b.vendor_name || '')));
};

const negotiationModel = {
  // ============= NEGOTIATION ROUNDS =============

  /**
   * Create a new negotiation round (product-specific).
   *
   * Polymorphic via (source_type, source_id) — defaults to 'RFQ'+rfq_id when
   * source_type/source_id aren't supplied, so existing RFQ callers don't need
   * to change. ARC commercial-eval callers pass source_type='ARC' + source_id
   * (the arc id) and leave rfq_id null.
   */
  createRound: async (roundData, txContext = null) => {
    const {
      rfq_id,
      rfq_product_id = null,
      round_number,
      target_price,
      end_date,
      status = 'DRAFT',
      created_by,
      remarks = null,
      vendor_ids = null,
      vendor_approvals = null,
      source_type,
      source_id,
      products = null
    } = roundData;

    // A round is either single-product (legacy: rfq_product_id) or
    // multi-product (products JSONB) — never neither.
    if (!rfq_product_id && !(Array.isArray(products) && products.length > 0)) {
      throw new Error('Either rfq_product_id or a non-empty products array is required');
    }

    const resolvedSourceType = source_type || (rfq_id ? 'RFQ' : null);
    const resolvedSourceId   = source_id   ?? rfq_id;

    if (!resolvedSourceType || !resolvedSourceId) {
      throw new Error('source_type + source_id (or rfq_id for RFQ flow) is required');
    }

    return (txContext || db).one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, vendor_approvals, source_type, source_id, products)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb)
       RETURNING *`,
      [rfq_id, rfq_product_id, round_number, target_price, end_date, status, created_by, remarks, vendor_ids, JSON.stringify(vendor_approvals || []), resolvedSourceType, resolvedSourceId, products ? JSON.stringify(products) : null]
    );
  },

  /**
   * Get round by ID
   */
  getRoundById: async (roundId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_negotiation_rounds WHERE id = $1`,
      [roundId]
    );
  },

  /**
   * P0 FIX (IDOR): may this buyer read the negotiation data of `rfqId`?
   * Applies the SAME RBAC read matrix as the listings, so a user cannot pull a
   * different hotel's rounds — and with them vendor identities, emails and
   * negotiated prices — by putting another RFQ's id in the URL.
   *
   * `userId` null = super admin (user_type 8) → allowed.
   * A missing RFQ returns false (callers answer 404/403 identically, so an id
   * probe cannot distinguish "does not exist" from "not yours").
   */
  userCanReadRfqNegotiation: async (userId, rfqId) => {
    if (userId == null) return true;
    if (!rfqId) return false;
    const row = await db.oneOrNone(
      `SELECT 1 AS ok
         FROM tbl_rfq rfq
        WHERE rfq.id = $2::int
          AND ${negotiationReadScopeSql('rfq', '$1')}`,
      [Number(userId), Number(rfqId)]
    );
    return !!row;
  },

  /**
   * P0 FIX (IDOR): may this buyer read round `roundId`? Resolves the round's
   * parent — tbl_rfq for RFQ rounds, tbl_arc for ARC rounds — and applies the
   * same matrix against whichever one owns it.
   *
   * `userId` null = super admin (user_type 8) → allowed.
   */
  /**
   * Can this user read the negotiation data belonging to an RFQ?
   *
   * The RFQ-level twin of `userCanReadRound`, applying the identical read
   * matrix to the parent rather than to one round. The approval-bundle
   * endpoint is keyed by rfq_id, so the round-level gate cannot express the
   * question it needs to ask.
   *
   * `userId == null` means super-admin (see readScopeUserId) and bypasses,
   * matching every other gate in this model.
   */
  userCanReadRfqNegotiations: async (userId, rfqId) => {
    if (userId == null) return true;
    if (!rfqId) return false;
    const row = await db.oneOrNone(
      `SELECT 1 AS ok
         FROM tbl_rfq rfq
        WHERE rfq.id = $2::int
          AND ${negotiationReadScopeSql('rfq', '$1')}`,
      [Number(userId), Number(rfqId)]
    );
    return !!row;
  },

  userCanReadRound: async (userId, roundId) => {
    if (userId == null) return true;
    if (!roundId) return false;
    const row = await db.oneOrNone(
      `SELECT 1 AS ok
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
        WHERE nr.id = $2::int
          AND (
            (rfq.id IS NOT NULL AND ${negotiationReadScopeSql('rfq', '$1')})
            OR (a.id IS NOT NULL AND ${negotiationReadScopeSql('a', '$1')})
          )`,
      [Number(userId), Number(roundId)]
    );
    return !!row;
  },

  // ============= ROUND DETAIL (Negotiation Command Center) =============

  /**
   * Rounds by id, joined to their polymorphic parent, with the SAME RBAC read
   * matrix `userCanReadRound` applies — re-evaluated per row.
   *
   * This is the only door into the detail API's data. Sibling expansion and
   * cumulative roll-up both go through it rather than assuming "these rounds
   * share a parent, so they share a scope": `nr.rfq_id` and `nr.source_id` are
   * independent columns, so a sibling by (source_type, source_id, round_number)
   * can legitimately belong to a different RFQ — and therefore a different
   * hotel — than the round being viewed.
   *
   * `userId` null = super admin (user_type 8) → no matrix filter.
   */
  getScopedRoundsByIds: async (roundIds, userId) => {
    const ids = (roundIds || []).map(Number).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return [];
    return db.any(
      `SELECT nr.*,
              u.name        AS created_by_name,
              u.email       AS created_by_email,
              u.mobile      AS created_by_mobile,
              u.designation AS created_by_designation,
              rfq.id                     AS parent_rfq_id,
              rfq.rfq_no                 AS parent_rfq_no,
              rfq.title                  AS parent_rfq_title,
              rfq.bid_end_date           AS parent_bid_end_date,
              rfq.status                 AS parent_rfq_status,
              rfq.is_tender              AS parent_is_tender,
              rfq.vendor_clarification_date AS parent_vendor_clarification_date,
              a.id                       AS parent_arc_id,
              a.arc_number               AS parent_arc_number,
              a.title                    AS parent_arc_title,
              a.status                   AS parent_arc_status,
              a.submission_end_at        AS parent_arc_submission_end_at,
              COALESCE(rfq.hospitality_company_id, a.hospitality_company_id) AS parent_company_id,
              COALESCE(rfq.hotel_id, a.hotel_id)                             AS parent_hotel_id,
              COALESCE(rfq.department_id, a.department_id)                   AS parent_department_id,
              COALESCE(rfq.process_id, a.process_id)                         AS parent_process_id,
              hc.name  AS parent_company_name,
              h.name   AS parent_hotel_name,
              d.title  AS parent_department_name
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
         LEFT JOIN tbl_hospitality_companies hc      ON hc.id = COALESCE(rfq.hospitality_company_id, a.hospitality_company_id)
         LEFT JOIN tbl_hospitality_company_hotels h  ON h.id  = COALESCE(rfq.hotel_id, a.hotel_id)
         LEFT JOIN tbl_department d                  ON d.id  = COALESCE(rfq.department_id, a.department_id)
        WHERE nr.id = ANY($2::int[])
          AND (
            (rfq.id IS NOT NULL AND ${negotiationReadScopeSql('rfq', '$1')})
            OR (a.id IS NOT NULL AND ${negotiationReadScopeSql('a', '$1')})
          )
        ORDER BY nr.round_number ASC, nr.id ASC`,
      [userId == null ? null : Number(userId), ids]
    );
  },

  /**
   * Ids of every round in the same CYCLE — INCLUDING the round itself.
   *
   * A cycle is one wave of negotiation across the parent: under the legacy
   * per-product allocator, creating "round 2" for three products wrote three
   * rows all stored as round_number = 2, and those three are one cycle.
   * Production holds sibling groups of up to 46 rounds, spread over as much as
   * 50 days, so they are NOT identifiable by creation time.
   *
   * This used to group by (source_type, source_id, round_number). It cannot any
   * more: the allocator now stores the round's RFQ-WIDE POSITION (see
   * getNextRoundPositionForRfq), which is unique per parent, so every cycle
   * would collapse to a single round and the detail page's scope=cycle would
   * silently degrade into scope=round.
   *
   * The re-key is the round's ITEM-WISE CYCLE ORDINAL: its chronological place
   * among the rounds on the same parent that touch at least one of ITS OWN
   * items (rounds carrying no items — RFQ-level and ARC rounds — group with the
   * other item-less rounds). That is precisely what the legacy stored value
   * meant — "the k-th round on this product" — expressed so that it is read off
   * the data instead of off a column whose meaning changed. Two rounds are
   * siblings when their ordinals match.
   *
   * Verified on production (2026-08-01): for all 886 rounds the sibling set this
   * returns is byte-identical to what the round_number grouping returned, and
   * the per-product ordinal equals the stored round_number on all 885 legacy
   * single-product rows. Nothing about existing data moves; only rows written
   * by the new allocator, which the old rule would have orphaned, land in the
   * cycle they belong to.
   *
   * Deliberately unscoped: the caller intersects this with getScopedRoundsByIds
   * so it can report how many siblings were withheld without ever revealing
   * their contents.
   */
  getSiblingRoundIds: async (roundId) => {
    const rows = await db.any(
      `WITH me AS (
         SELECT nr.source_type, nr.source_id
           FROM tbl_negotiation_rounds nr
          WHERE nr.id = $1::int
       ), family AS (
         SELECT nr.id, nr.created_at, items.ids
           FROM tbl_negotiation_rounds nr
           JOIN me ON me.source_type IS NOT DISTINCT FROM nr.source_type
                  AND me.source_id   IS NOT DISTINCT FROM nr.source_id
           CROSS JOIN LATERAL (
             SELECT COALESCE(array_agg(DISTINCT _pid) FILTER (WHERE _pid IS NOT NULL), '{}'::int[]) AS ids
               FROM (
                 SELECT nr.rfq_product_id AS _pid
                 UNION ALL
                 SELECT (_p->>'rfq_product_id')::int
                   FROM jsonb_array_elements(COALESCE(nr.products, '[]'::jsonb)) _p
               ) _s
           ) items
       ), ranked AS (
         SELECT f.id,
                (SELECT COUNT(*)
                   FROM family g
                  WHERE (g.created_at, g.id) <= (f.created_at, f.id)
                    AND CASE WHEN cardinality(f.ids) = 0
                             THEN cardinality(g.ids) = 0
                             ELSE g.ids && f.ids
                        END)::int AS cycle_no
           FROM family f
       )
       SELECT r.id
         FROM ranked r
        WHERE r.cycle_no = (SELECT cycle_no FROM ranked WHERE id = $1::int)
        ORDER BY r.id`,
      [Number(roundId)]
    );
    return rows.map((r) => Number(r.id));
  },

  /**
   * Every round on the same parent that touches at least one of `rfqProductIds`
   * / `arcItemIds`, scoped to the caller. Backs both round-history denominators
   * and the cumulative roll-up.
   */
  getRelatedRoundIds: async ({ sourceType, sourceId, rfqProductIds = [], arcItemIds = [], userId }) => {
    const products = (rfqProductIds || []).map(Number).filter(Number.isFinite);
    const items = (arcItemIds || []).map(Number).filter(Number.isFinite);
    const rows = await db.any(
      `SELECT nr.id, nr.round_number, nr.status, nr.end_date, nr.created_at, nr.closed_at
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
        WHERE nr.source_type = $1
          AND nr.source_id = $2::int
          AND (
            ($3::int[] IS NOT NULL AND array_length($3::int[], 1) > 0 AND ${coversAnyProductSql('$3')})
            OR ($4::bigint[] IS NOT NULL AND array_length($4::bigint[], 1) > 0 AND ${coversAnyArcItemSql('$4')})
          )
          AND (
            (rfq.id IS NOT NULL AND ${negotiationReadScopeSql('rfq', '$5')})
            OR (a.id IS NOT NULL AND ${negotiationReadScopeSql('a', '$5')})
          )
        ORDER BY nr.round_number ASC, nr.id ASC`,
      [sourceType, Number(sourceId), products, items, userId == null ? null : Number(userId)]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      round_number: Number(r.round_number),
      status: r.status,
      end_date: r.end_date,
      created_at: r.created_at,
      closed_at: r.closed_at,
    }));
  },

  /**
   * The displayed "Round N" for every round on one parent, plus the "of M".
   *
   * Position is this round's place in the parent's chronology — one round, one
   * position, however many products it covers. Computed rather than read off
   * `round_number`, which restarts at 1 per product on every legacy row (see
   * roundPositionSql). Returns { positions: Map<roundId, n>, total }.
   *
   * Scoped with the same RBAC matrix as countScopedRoundsOnParent so the "of M"
   * here and there cannot disagree. That matrix resolves against the parent, so
   * a caller who can see one round of an RFQ can see all of them — the position
   * is never a position within a partially-visible set.
   */
  getRoundDisplayPositions: async ({ sourceType, sourceId, userId }) => {
    const rows = await db.any(
      `SELECT nr.id,
              ROW_NUMBER() OVER (ORDER BY nr.created_at, nr.id)::int AS position,
              COUNT(*) OVER ()::int AS total
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
        WHERE nr.source_type = $1
          AND nr.source_id = $2::int
          AND (
            (rfq.id IS NOT NULL AND ${negotiationReadScopeSql('rfq', '$3')})
            OR (a.id IS NOT NULL AND ${negotiationReadScopeSql('a', '$3')})
          )`,
      [sourceType, Number(sourceId), userId == null ? null : Number(userId)]
    );
    return {
      positions: new Map(rows.map((r) => [Number(r.id), Number(r.position)])),
      total: rows.length ? Number(rows[0].total) : 0,
    };
  },

  /**
   * Which of these rounds have a vendor quote that was taken forward and
   * APPROVED downstream? Returns a Set of round ids.
   *
   * Same predicate as approvedQuoteLateralSql — the vendor match is what makes
   * this "quotes from THIS round" rather than "this product was finalised at
   * some point". ARC rounds have no NEGOTIATION_QUOTE counterpart, so they
   * never appear here.
   */
  getRoundsWithApprovedQuote: async (roundIds) => {
    const ids = (roundIds || []).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return new Set();
    const rows = await db.any(
      `SELECT DISTINCT nrq.negotiation_round_id AS round_id
         FROM tbl_negotiation_round_quotes nrq
         JOIN tbl_approval_instances ai
           ON ai.entity_type = 'NEGOTIATION_QUOTE'
          AND ai.status = 'APPROVED'
          AND ai.entity_id = nrq.rfq_product_id
          AND (ai.metadata->>'vendor_id') ~ '^[0-9]+$'
          AND (ai.metadata->>'vendor_id')::int = nrq.vendor_id
        WHERE nrq.negotiation_round_id = ANY($1::int[])`,
      [ids]
    );
    return new Set(rows.map((r) => Number(r.round_id)));
  },

  /** Vendor response count (distinct vendor × item) per round id. */
  getRoundResponseCounts: async (roundIds) => {
    const ids = (roundIds || []).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return new Map();
    const rows = await db.any(
      `SELECT nrq.negotiation_round_id AS round_id,
              COUNT(DISTINCT (nrq.vendor_id, COALESCE(nrq.rfq_product_id, nrq.arc_item_id)))::int AS n
         FROM tbl_negotiation_round_quotes nrq
        WHERE nrq.negotiation_round_id = ANY($1::int[])
        GROUP BY nrq.negotiation_round_id`,
      [ids]
    );
    return new Map(rows.map((r) => [Number(r.round_id), Number(r.n)]));
  },

  /** Count of every round on the parent that the caller may read. */
  countScopedRoundsOnParent: async ({ sourceType, sourceId, userId }) => {
    const row = await db.one(
      `SELECT COUNT(*)::int AS n
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
        WHERE nr.source_type = $1
          AND nr.source_id = $2::int
          AND (
            (rfq.id IS NOT NULL AND ${negotiationReadScopeSql('rfq', '$3')})
            OR (a.id IS NOT NULL AND ${negotiationReadScopeSql('a', '$3')})
          )`,
      [sourceType, Number(sourceId), userId == null ? null : Number(userId)]
    );
    return row.n;
  },

  /** Raw vendor responses for a set of rounds. */
  getRoundQuotesForRounds: async (roundIds) => {
    const ids = (roundIds || []).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return [];
    return db.any(
      `SELECT nrq.id, nrq.negotiation_round_id, nrq.vendor_id, nrq.rfq_product_id,
              nrq.arc_item_id, nrq.quoted_price, nrq.previous_price, nrq.submitted_at
         FROM tbl_negotiation_round_quotes nrq
        WHERE nrq.negotiation_round_id = ANY($1::int[])
        ORDER BY nrq.negotiation_round_id, nrq.vendor_id, nrq.id`,
      [ids]
    );
  },

  /**
   * Pricing + identity facts for a set of (rfq_id, rfq_product_id, vendor_id)
   * triples: the vendor's live quote item, its full revision history, the RFQ
   * quantity/unit spec, and vendor contact details.
   *
   * The (product_variant_id, variant) pair is the real key into
   * tbl_quote_items — product_variant_id alone is NOT unique within a quote
   * (271+ production quotes carry several variants of the same variant id).
   */
  getRfqLineFacts: async (triples) => {
    const rows = (triples || []).filter((t) => t && t.rfq_id != null && t.vendor_id != null);
    if (rows.length === 0) return [];
    return db.any(
      `WITH t AS (
         SELECT * FROM unnest($1::int[], $2::int[], $3::int[]) AS x(rfq_id, rfq_product_id, vendor_id)
       )
       SELECT t.rfq_id, t.rfq_product_id, t.vendor_id,
              rp.product_variant_id, rp.variant,
              COALESCE(pv.name, p.name, 'Product #' || rp.product_variant_id) AS product_name,
              COALESCE(c.company_name, u.organization_name, u.name)           AS vendor_name,
              u.name   AS vendor_contact_name,
              u.email  AS vendor_email,
              u.mobile AS vendor_mobile,
              qitem.id           AS quote_item_id,
              qitem.unit_price,
              qitem.total_price,
              qitem.tax,
              qitem.tax_mode,
              COALESCE(NULLIF(regexp_replace(COALESCE(qitem.quantity, ''), '[^0-9.\\-]', '', 'g'), ''),
                       NULLIF(regexp_replace(COALESCE(spec.qty, ''), '[^0-9.\\-]', '', 'g'), '')) AS quantity,
              spec.uom,
              hist.rows AS history_rows
         FROM t
         LEFT JOIN tbl_rfq_products rp     ON rp.id = t.rfq_product_id
         LEFT JOIN tbl_product_variant pv  ON pv.id = rp.product_variant_id
         LEFT JOIN tbl_product p           ON p.id = pv.product_id
         LEFT JOIN tbl_users u             ON u.id = t.vendor_id
         LEFT JOIN tbl_company c           ON c.id = u.company_id
         LEFT JOIN LATERAL (
           SELECT q.id FROM tbl_quotes q
            WHERE q.rfq_id = t.rfq_id AND q.created_by = t.vendor_id
            ORDER BY q.id DESC LIMIT 1
         ) vq ON TRUE
         LEFT JOIN LATERAL (
           SELECT qi.* FROM tbl_quote_items qi
            WHERE qi.quote_id = vq.id
              AND qi.product_variant_id = rp.product_variant_id
              AND qi.variant = rp.variant
            ORDER BY qi.id DESC LIMIT 1
         ) qitem ON TRUE
         LEFT JOIN LATERAL (
           SELECT MAX(CASE WHEN lower(s.title) = 'quantity' THEN s.value END) AS qty,
                  MAX(CASE WHEN lower(s.title) = 'unit'     THEN s.value END) AS uom
             FROM tbl_rfq_products_specs s
            WHERE s.rfq_id = t.rfq_id
              AND s.product_variant_id = rp.product_variant_id
              AND s.variant = rp.variant
         ) spec ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'unit_price', h.unit_price,
                    'total_price', h.total_price,
                    'timestamp', h.timestamp
                  ) ORDER BY h.timestamp ASC, h.id ASC) AS rows
             FROM tbl_quote_item_history h
            WHERE h.quote_item_id = qitem.id
         ) hist ON TRUE`,
      [rows.map((t) => t.rfq_id), rows.map((t) => t.rfq_product_id), rows.map((t) => t.vendor_id)]
    );
  },

  /**
   * ARC counterpart of getRfqLineFacts. ARC negotiation stores a UNIT rate in
   * quoted_price (see arcNegotiationController.submitRevisedRate), so the
   * "current quote" rung of the baseline ladder is the vendor's live
   * tbl_arc_quote_line rate rather than a quote-item total.
   */
  getArcLineFacts: async (triples) => {
    const rows = (triples || []).filter((t) => t && t.arc_id != null && t.vendor_id != null);
    if (rows.length === 0) return [];
    return db.any(
      `WITH t AS (
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[]) AS x(arc_id, arc_item_id, vendor_id)
       )
       SELECT t.arc_id, t.arc_item_id, t.vendor_id,
              ai.product_variant_id,
              COALESCE(pv.name, p.name, 'Item #' || ai.product_variant_id) AS product_name,
              COALESCE(c.company_name, u.organization_name, u.name)        AS vendor_name,
              u.name   AS vendor_contact_name,
              u.email  AS vendor_email,
              u.mobile AS vendor_mobile,
              ai.indicative_qty AS quantity,
              ai.uom,
              aql.rate AS arc_line_rate,
              aql.gst_pct AS arc_line_gst_pct
         FROM t
         LEFT JOIN tbl_arc_item ai        ON ai.id = t.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_product p          ON p.id = pv.product_id
         LEFT JOIN tbl_users u            ON u.id = t.vendor_id
         LEFT JOIN tbl_company c          ON c.id = u.company_id
         LEFT JOIN LATERAL (
           SELECT aq.id FROM tbl_arc_quote aq
            WHERE aq.arc_id = t.arc_id AND aq.vendor_id = t.vendor_id
            ORDER BY aq.id DESC LIMIT 1
         ) vq ON TRUE
         LEFT JOIN LATERAL (
           SELECT l.rate, l.gst_pct FROM tbl_arc_quote_line l
            WHERE l.arc_quote_id = vq.id AND l.arc_item_id = t.arc_item_id
            ORDER BY l.id DESC LIMIT 1
         ) aql ON TRUE`,
      [rows.map((t) => t.arc_id), rows.map((t) => t.arc_item_id), rows.map((t) => t.vendor_id)]
    );
  },

  /**
   * Approval instances (entity_type NEGOTIATION) for a set of rounds, with
   * steps, approvers and the "is it waiting on me?" flag.
   */
  getRoundApprovalState: async (roundIds, viewerUserId) => {
    const ids = (roundIds || []).map(Number).filter(Number.isFinite);
    if (ids.length === 0) return [];
    // Same two-shape resolution the listing toggle uses — see
    // negotiationInstanceRoundIdSql. Reading entity_id alone left the detail
    // page's approval card empty on every legacy-shape instance.
    const roundIdExpr = negotiationModel.negotiationInstanceRoundIdSql('i');
    const instances = await db.any(
      `SELECT i.id, (${roundIdExpr}) AS entity_id, i.status, i.current_step, i.approval_policy_id,
              i.created_at, i.completed_at, i.initiated_by,
              iu.name AS initiated_by_name, iu.email AS initiated_by_email
         FROM tbl_approval_instances i
         ${negotiationModel.negotiationInstanceRoundJoinSql('i')}
         LEFT JOIN tbl_users iu ON iu.id = i.initiated_by
        WHERE i.entity_type IN ('NEGOTIATION','ARC_NEGOTIATION')
          AND (${roundIdExpr}) = ANY($1::int[])
        ORDER BY i.created_at DESC, i.id DESC`,
      [ids]
    );
    if (instances.length === 0) return [];

    const instanceIds = instances.map((i) => Number(i.id));
    const [steps, approvers] = await Promise.all([
      db.any(
        `SELECT s.id, s.approval_instance_id, s.step_order, s.decision_rule, s.status, s.completed_at
           FROM tbl_approval_instance_steps s
          WHERE s.approval_instance_id = ANY($1::int[])
          ORDER BY s.step_order ASC, s.id ASC`,
        [instanceIds]
      ),
      db.any(
        `SELECT sa.id, sa.approval_instance_step_id, sa.approver_user_id, sa.status,
                sa.comment, sa.acted_at, sa.removed_at,
                u.name AS approver_name, u.email AS approver_email, u.mobile AS approver_mobile
           FROM tbl_approval_step_approvers sa
           JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
           LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
          WHERE s.approval_instance_id = ANY($1::int[])
          ORDER BY sa.id ASC`,
        [instanceIds]
      ),
    ]);

    const approversByStep = new Map();
    for (const a of approvers) {
      const key = Number(a.approval_instance_step_id);
      if (!approversByStep.has(key)) approversByStep.set(key, []);
      approversByStep.get(key).push(a);
    }
    const stepsByInstance = new Map();
    for (const s of steps) {
      const key = Number(s.approval_instance_id);
      if (!stepsByInstance.has(key)) stepsByInstance.set(key, []);
      stepsByInstance.get(key).push(s);
    }

    return instances.map((inst) => {
      const instSteps = (stepsByInstance.get(Number(inst.id)) || []).map((s) => ({
        step_id: Number(s.id),
        step_order: Number(s.step_order),
        decision_rule: s.decision_rule,
        status: s.status,
        completed_at: isoOrNull(s.completed_at),
        approvers: (approversByStep.get(Number(s.id)) || [])
          .filter((a) => a.removed_at == null)
          .map((a) => ({
            user_id: Number(a.approver_user_id),
            name: a.approver_name,
            email: a.approver_email,
            mobile: a.approver_mobile,
            status: a.status,
            comment: a.comment,
            acted_at: isoOrNull(a.acted_at),
          })),
      }));
      const currentStep = instSteps.find((s) => s.step_order === Number(inst.current_step)) || null;
      const pendingWith =
        inst.status === 'PENDING' && currentStep
          ? currentStep.approvers.filter((a) => a.status === 'PENDING')
          : [];
      return {
        instance_id: Number(inst.id),
        round_id: Number(inst.entity_id),
        status: inst.status,
        current_step: inst.current_step == null ? null : Number(inst.current_step),
        total_steps: instSteps.length,
        policy_id: inst.approval_policy_id == null ? null : Number(inst.approval_policy_id),
        created_at: isoOrNull(inst.created_at),
        completed_at: isoOrNull(inst.completed_at),
        initiated_by: {
          user_id: inst.initiated_by == null ? null : Number(inst.initiated_by),
          name: inst.initiated_by_name,
          email: inst.initiated_by_email,
        },
        steps: instSteps,
        pending_with: pendingWith,
        is_pending_for_me:
          viewerUserId != null && pendingWith.some((a) => Number(a.user_id) === Number(viewerUserId)),
      };
    });
  },

  /**
   * The caller's negotiation.* permissions IN THE SCOPE OF one round's parent.
   * Same 4-axis matrix as the read gate, just not pinned to action='read'.
   * `userId` null = super admin → everything.
   */
  getNegotiationPermissionsForRound: async (userId, roundId) => {
    const all = { read: true, create: true, update: true, approve: true, delete: true };
    if (userId == null) return all;
    const rows = await db.any(
      `SELECT DISTINCT _p.action::text AS action
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_arc a   ON a.id = nr.source_id AND nr.source_type = 'ARC'
         JOIN tbl_user_role_scopes _urs ON _urs.user_id = $1::int
         JOIN tbl_role_permissions _rp  ON _rp.role_id = _urs.role_id
         JOIN tbl_permissions _p        ON _p.id = _rp.permission_id
        WHERE nr.id = $2::int
          AND _p.resource = 'negotiation'::resource_type
          AND (
            (rfq.id IS NOT NULL
             AND _urs.company_id = rfq.hospitality_company_id
             AND (_urs.hotel_id IS NULL OR _urs.hotel_id = rfq.hotel_id)
             AND (rfq.department_id IS NULL OR _urs.department_id IS NULL OR _urs.department_id = rfq.department_id)
             AND (_urs.process_id IS NULL OR _urs.process_id = rfq.process_id))
            OR
            (a.id IS NOT NULL
             AND _urs.company_id = a.hospitality_company_id
             AND (_urs.hotel_id IS NULL OR _urs.hotel_id = a.hotel_id)
             AND (a.department_id IS NULL OR _urs.department_id IS NULL OR _urs.department_id = a.department_id)
             AND (_urs.process_id IS NULL OR _urs.process_id = a.process_id))
          )`,
      [Number(userId), Number(roundId)]
    );
    const granted = new Set(rows.map((r) => r.action));
    return {
      read: granted.has('read'),
      create: granted.has('create'),
      update: granted.has('update'),
      approve: granted.has('approve'),
      delete: granted.has('delete'),
    };
  },

  /**
   * Assemble the full round-detail payload.
   *
   * @param {number}  roundId
   * @param {'round'|'cycle'} scope
   * @param {number|null} scopeUserId  RBAC matrix user id (null = super admin)
   * @param {number|null} viewerUserId real caller id, used for "pending for me"
   * @returns {Promise<object|null>} null when the round does not exist OR is
   *          out of scope — callers must answer both identically.
   */
  getRoundDetail: async ({ roundId, scope = 'round', scopeUserId = null, viewerUserId = null }) => {
    const primary = (await negotiationModel.getScopedRoundsByIds([roundId], scopeUserId))[0];
    if (!primary) return null;

    const sourceType = String(primary.source_type || 'RFQ').toUpperCase();
    const sourceId = Number(primary.source_id);

    // ── Scope expansion ──────────────────────────────────────────────────────
    let scopeRounds = [primary];
    let cycle = null;
    if (scope === 'cycle') {
      const siblingIds = await negotiationModel.getSiblingRoundIds(roundId);
      // Re-apply the predicate: siblings are NOT implicitly in scope.
      const scoped = await negotiationModel.getScopedRoundsByIds(siblingIds, scopeUserId);
      scopeRounds = scoped.length > 0 ? scoped : [primary];
      cycle = {
        round_number: Number(primary.round_number),
        sibling_round_ids: scopeRounds.map((r) => Number(r.id)),
        sibling_count: scopeRounds.length,
        excluded_sibling_count: Math.max(siblingIds.length - scopeRounds.length, 0),
      };
    }

    // ── Item + vendor grid across the scope ──────────────────────────────────
    const slotsByRound = new Map();
    const vendorsByRound = new Map();
    const productIds = new Set();
    const arcItemIds = new Set();
    for (const r of scopeRounds) {
      const slots = getRoundItemSlots(r);
      slotsByRound.set(Number(r.id), slots);
      vendorsByRound.set(Number(r.id), getRoundVendorIds(r));
      slots.forEach((s) => {
        if (s.rfq_product_id != null) productIds.add(s.rfq_product_id);
        if (s.arc_item_id != null) arcItemIds.add(s.arc_item_id);
      });
    }

    // ── Rounds sharing these items (denominators + cumulative) ───────────────
    const relatedRounds =
      productIds.size > 0 || arcItemIds.size > 0
        ? await negotiationModel.getRelatedRoundIds({
            sourceType,
            sourceId,
            rfqProductIds: [...productIds],
            arcItemIds: [...arcItemIds],
            userId: scopeUserId,
          })
        : [];
    const roundsOnParent = await negotiationModel.countScopedRoundsOnParent({
      sourceType,
      sourceId,
      userId: scopeUserId,
    });

    // Cumulative set: rounds 1..N on the same items, CANCELLED excluded.
    const currentRoundNumber = Number(primary.round_number);
    const cumulativeRoundIds = relatedRounds
      .filter((r) => r.round_number <= currentRoundNumber && String(r.status).toUpperCase() !== 'CANCELLED')
      .map((r) => r.id);

    // Every round on the same items — this is what the page's "Every round on
    // this record" table lists, so its lines have to be assembled too. The set
    // is per-product (max 9 rounds anywhere in production), not per-RFQ, so
    // widening it here is cheap. `findPrior` only ever looks BACKWARDS from a
    // line's own round number, so adding later rounds cannot disturb the
    // baseline resolution of the round being viewed.
    const historyRoundIds = relatedRounds.map((r) => r.id);
    const allRoundIds = [
      ...new Set([...scopeRounds.map((r) => Number(r.id)), ...cumulativeRoundIds, ...historyRoundIds]),
    ];
    const allRounds = await negotiationModel.getScopedRoundsByIds(allRoundIds, scopeUserId);
    const roundsById = new Map(allRounds.map((r) => [Number(r.id), r]));

    // ── Facts ────────────────────────────────────────────────────────────────
    const roundQuotes = await negotiationModel.getRoundQuotesForRounds(allRoundIds);
    const quoteKey = (roundIdKey, itemId, vendorId) => `${roundIdKey}|${itemId ?? 'null'}|${vendorId}`;
    const quotesByKey = new Map();
    for (const q of roundQuotes) {
      const itemId = sourceType === 'ARC' ? q.arc_item_id : q.rfq_product_id;
      quotesByKey.set(quoteKey(Number(q.negotiation_round_id), itemId == null ? null : Number(itemId), Number(q.vendor_id)), q);
    }

    // Prior-round lookup index: (item, vendor) → responses ordered by round no.
    const priorIndex = new Map();
    for (const q of roundQuotes) {
      const r = roundsById.get(Number(q.negotiation_round_id));
      if (!r) continue;
      const itemId = sourceType === 'ARC' ? q.arc_item_id : q.rfq_product_id;
      const key = `${itemId ?? 'null'}|${Number(q.vendor_id)}`;
      if (!priorIndex.has(key)) priorIndex.set(key, []);
      priorIndex.get(key).push({ ...q, round_number: Number(r.round_number) });
    }
    for (const arr of priorIndex.values()) arr.sort((x, y) => x.round_number - y.round_number || x.id - y.id);
    const findPrior = (itemId, vendorId, roundNumber) => {
      const arr = priorIndex.get(`${itemId ?? 'null'}|${vendorId}`) || [];
      let best = null;
      for (const q of arr) if (q.round_number < roundNumber) best = q;
      return best;
    };

    // Facts are fetched for every (item, vendor) pair across the union of the
    // scope rounds and the cumulative rounds so one query serves both.
    const factTriples = new Map();
    for (const r of allRounds) {
      const slots = slotsByRound.get(Number(r.id)) || getRoundItemSlots(r);
      const vendors = vendorsByRound.get(Number(r.id)) || getRoundVendorIds(r);
      for (const s of slots) {
        for (const v of vendors) {
          const key =
            sourceType === 'ARC'
              ? `${sourceId}|${s.arc_item_id ?? 'null'}|${v}`
              : `${Number(r.rfq_id ?? sourceId)}|${s.rfq_product_id ?? 'null'}|${v}`;
          if (!factTriples.has(key)) {
            factTriples.set(
              key,
              sourceType === 'ARC'
                ? { arc_id: sourceId, arc_item_id: s.arc_item_id, vendor_id: v }
                : { rfq_id: Number(r.rfq_id ?? sourceId), rfq_product_id: s.rfq_product_id, vendor_id: v }
            );
          }
        }
      }
    }
    const factRows =
      sourceType === 'ARC'
        ? await negotiationModel.getArcLineFacts([...factTriples.values()])
        : await negotiationModel.getRfqLineFacts([...factTriples.values()]);
    const factsByKey = new Map();
    for (const f of factRows) {
      const key =
        sourceType === 'ARC'
          ? `${Number(f.arc_id)}|${f.arc_item_id == null ? 'null' : Number(f.arc_item_id)}|${Number(f.vendor_id)}`
          : `${Number(f.rfq_id)}|${f.rfq_product_id == null ? 'null' : Number(f.rfq_product_id)}|${Number(f.vendor_id)}`;
      factsByKey.set(key, f);
    }

    const linesForRound = (r) => {
      const slots = slotsByRound.get(Number(r.id)) || getRoundItemSlots(r);
      const vendors = vendorsByRound.get(Number(r.id)) || getRoundVendorIds(r);
      const out = [];
      for (const s of slots) {
        for (const v of vendors) {
          const itemId = sourceType === 'ARC' ? s.arc_item_id : s.rfq_product_id;
          const factKey =
            sourceType === 'ARC'
              ? `${sourceId}|${s.arc_item_id ?? 'null'}|${v}`
              : `${Number(r.rfq_id ?? sourceId)}|${s.rfq_product_id ?? 'null'}|${v}`;
          out.push(
            buildLine({
              round: r,
              slot: s,
              vendorId: v,
              roundQuote: quotesByKey.get(quoteKey(Number(r.id), itemId, v)) || null,
              priorRoundQuote: findPrior(itemId, v, Number(r.round_number)),
              facts: factsByKey.get(factKey) || null,
              parentSourceType: sourceType,
            })
          );
        }
      }
      return out;
    };

    const lines = scopeRounds.flatMap(linesForRound);
    const totals = summariseLines(lines);
    const vendors = summariseVendors(lines);

    // ── Cumulative across rounds 1..N on the same items ──────────────────────
    const cumulativeRounds = cumulativeRoundIds.map((id) => roundsById.get(id)).filter(Boolean);
    const cumulativeLines = cumulativeRounds.flatMap(linesForRound);
    const cumulativeByPair = new Map();
    for (const l of cumulativeLines) {
      const key = `${l.rfq_product_id ?? l.arc_item_id ?? 'RFQ_LEVEL'}|${l.vendor_id}`;
      if (!cumulativeByPair.has(key)) cumulativeByPair.set(key, []);
      cumulativeByPair.get(key).push(l);
    }
    let cumBaseline = 0;
    let cumAchieved = 0;
    let cumPairs = 0;
    for (const arr of cumulativeByPair.values()) {
      arr.sort((a, b) => a.round_number - b.round_number || a.round_id - b.round_id);
      const first = arr.find((l) => l.baseline_line_total != null);
      const lastResponded = [...arr].reverse().find((l) => l.achieved_line_total != null);
      if (first && lastResponded) {
        cumBaseline += first.baseline_line_total;
        cumAchieved += lastResponded.achieved_line_total;
        cumPairs += 1;
      }
    }
    const cumSaved = cumBaseline - cumAchieved;
    const cumulative = {
      from_round_number: cumulativeRounds.length ? Math.min(...cumulativeRounds.map((r) => Number(r.round_number))) : null,
      to_round_number: cumulativeRounds.length ? Math.max(...cumulativeRounds.map((r) => Number(r.round_number))) : null,
      round_ids: cumulativeRounds.map((r) => Number(r.id)),
      rounds_counted: cumulativeRounds.length,
      pairs_counted: cumPairs,
      baseline_total: round2(cumBaseline),
      achieved_total: round2(cumAchieved),
      saved_value: round2(cumSaved),
      saved_pct: cumPairs > 0 && Math.abs(cumBaseline) > MONEY_EPSILON ? round4((cumSaved / cumBaseline) * 100) : null,
      excludes_cancelled: true,
    };

    // ── Approval + permissions ───────────────────────────────────────────────
    const [approvalInstances, permissions, approvedQuoteRoundIds, responseCounts, displayPositions] =
      await Promise.all([
        negotiationModel.getRoundApprovalState(scopeRounds.map((r) => Number(r.id)), viewerUserId),
        negotiationModel.getNegotiationPermissionsForRound(scopeUserId, roundId),
        // ARC rounds have no NEGOTIATION_QUOTE counterpart — skip the query.
        sourceType === 'ARC' ? Promise.resolve(new Set()) : negotiationModel.getRoundsWithApprovedQuote(allRoundIds),
        negotiationModel.getRoundResponseCounts(allRoundIds),
        negotiationModel.getRoundDisplayPositions({ sourceType, sourceId, userId: scopeUserId }),
      ]);

    // The displayed "Round N". Falls back to the stored column only when the
    // parent lookup somehow misses the round, which cannot happen through the
    // normal path (the round is by definition one of its parent's rounds).
    const positionOf = (roundIdLike, fallback) =>
      displayPositions.positions.get(Number(roundIdLike)) ?? (fallback == null ? null : Number(fallback));

    // The cumulative tile says "rounds 3–7". Those endpoints were read off the
    // stored column, which restarts at 1 per product — so a four-round product
    // sequence claimed "rounds 1–4" while the page header said "Round 7 of
    // 138". Restate them as positions so every number on the page shares one
    // basis.
    const cumulativePositions = cumulativeRounds.map((r) => positionOf(r.id, r.round_number)).filter((n) => n != null);
    cumulative.from_round_number = cumulativePositions.length ? Math.min(...cumulativePositions) : null;
    cumulative.to_round_number = cumulativePositions.length ? Math.max(...cumulativePositions) : null;

    const vendorApprovals = Array.isArray(primary.vendor_approvals) ? primary.vendor_approvals : [];
    const approval = {
      instances: approvalInstances,
      status: approvalInstances[0]?.status ?? null,
      pending_with: approvalInstances[0]?.pending_with ?? [],
      is_pending_for_me: approvalInstances.some((i) => i.is_pending_for_me),
      vendor_approvals: {
        total: vendorApprovals.length,
        approved: vendorApprovals.filter((v) => String(v?.status).toUpperCase() === 'APPROVED').length,
        rejected: vendorApprovals.filter((v) => String(v?.status).toUpperCase() === 'REJECTED').length,
        pending: vendorApprovals.filter((v) => !['APPROVED', 'REJECTED'].includes(String(v?.status).toUpperCase())).length,
      },
    };

    const effectiveStatus = getEffectiveRoundStatus(primary);
    const endDate = parseAsUTC(primary.end_date);
    const now = Date.now();

    // ── The ONE user-facing state, derived exactly as the listing derives it ──
    // FIX 2: the listing labelled a round "Cancelled" while this page's header
    // read "Expired", because the page read the raw column and the listing read
    // a derived one. Both now come out of deriveNegotiationState.
    const stateFor = (r) =>
      deriveNegotiationState(
        {
          status: r.status,
          endDate: r.end_date,
          responseCount: responseCounts.get(Number(r.id)) || 0,
          hasApprovedQuote: approvedQuoteRoundIds.has(Number(r.id)),
        },
        now
      );
    const state = stateFor(primary);
    const statePresentation = negotiationStatePresentation(state);

    // ── History: every round on the same items, each scoped to itself ────────
    // Was never emitted, so the page's "Every round on this record" table was
    // permanently empty. Figures are per-round — no cumulative number is ever
    // presented as a round number.
    const history = relatedRounds
      .map((r) => {
        const full = roundsById.get(Number(r.id));
        const rowLines = full ? linesForRound(full) : [];
        const rowTotals = summariseLines(rowLines);
        const rowState = stateFor(full || r);
        const pres = negotiationStatePresentation(rowState);
        return {
          round_id: Number(r.id),
          // Position in the whole parent, same basis as the hero — so a history
          // row and the page it links to never show different numbers.
          round_number: positionOf(r.id, r.round_number),
          stored_round_number: Number(r.round_number),
          status: r.status,
          state: rowState,
          state_label: pres.label,
          is_current: Number(r.id) === Number(primary.id),
          end_date: isoOrNull(r.end_date),
          closed_at: isoOrNull(r.closed_at),
          created_at: isoOrNull(r.created_at),
          line_count: rowTotals.lines_total,
          responded_count: rowTotals.lines_responded,
          vendors_total: rowTotals.vendors_total,
          baseline_value: rowLines.length ? rowTotals.baseline_total : null,
          achieved_value: rowLines.length ? rowTotals.achieved_total : null,
          saved_value: rowTotals.lines_scored > 0 ? rowTotals.saved_value : null,
          saved_pct: rowTotals.saved_pct,
        };
      })
      .sort((a, b) => a.round_number - b.round_number || a.round_id - b.round_id);

    return {
      scope,
      cycle,
      round: {
        round_id: Number(primary.id),
        // DISPLAYED position in the whole RFQ/ARC. The stored column restarts
        // at 1 per product on legacy rows and is carried separately.
        round_number: positionOf(primary.id, primary.round_number),
        stored_round_number: Number(primary.round_number),
        status: primary.status,
        effective_status: effectiveStatus,
        state,
        state_label: statePresentation.label,
        state_description: statePresentation.description,
        state_tone: statePresentation.tone,
        state_badge: statePresentation.badge,
        response_count: responseCounts.get(Number(primary.id)) || 0,
        has_approved_quote: approvedQuoteRoundIds.has(Number(primary.id)),
        is_open: effectiveStatus === 'ACTIVE',
        is_expired: endDate ? endDate.getTime() <= now : false,
        mode: getRoundMode(primary),
        source_type: sourceType,
        source_id: sourceId,
        // THE denominator: every round on this RFQ/ARC.
        rounds_on_parent: roundsOnParent,
        total_rounds: roundsOnParent,
        // Context only — "4 rounds on this product" beside "Round 7 of 138".
        rounds_on_products: relatedRounds.length,
        target_price: num(primary.target_price),
        remarks: primary.remarks ?? null,
        end_date: isoOrNull(primary.end_date),
        time_remaining_ms: endDate ? endDate.getTime() - now : null,
        created_at: isoOrNull(primary.created_at),
        updated_at: isoOrNull(primary.updated_at),
        approved_at: isoOrNull(primary.approved_at),
        published_at: isoOrNull(primary.published_at),
        closed_at: isoOrNull(primary.closed_at),
        created_by: {
          user_id: primary.created_by == null ? null : Number(primary.created_by),
          name: primary.created_by_name ?? null,
          email: primary.created_by_email ?? null,
          mobile: primary.created_by_mobile ?? null,
          designation: primary.created_by_designation ?? null,
        },
      },
      parent: {
        source_type: sourceType,
        rfq_id: primary.parent_rfq_id == null ? null : Number(primary.parent_rfq_id),
        rfq_no: primary.parent_rfq_no == null ? null : Number(primary.parent_rfq_no),
        arc_id: primary.parent_arc_id == null ? null : Number(primary.parent_arc_id),
        arc_number: primary.parent_arc_number ?? null,
        title: primary.parent_rfq_title ?? primary.parent_arc_title ?? null,
        status: primary.parent_rfq_status ?? primary.parent_arc_status ?? null,
        is_tender: primary.parent_is_tender == null ? null : Number(primary.parent_is_tender),
        bid_end_date: primary.parent_bid_end_date ?? null,
        vendor_clarification_date: isoOrNull(primary.parent_vendor_clarification_date),
        submission_end_at: isoOrNull(primary.parent_arc_submission_end_at),
        hospitality_company_id: primary.parent_company_id == null ? null : Number(primary.parent_company_id),
        company_name: primary.parent_company_name ?? null,
        hotel_id: primary.parent_hotel_id == null ? null : Number(primary.parent_hotel_id),
        hotel_name: primary.parent_hotel_name ?? null,
        department_id: primary.parent_department_id == null ? null : Number(primary.parent_department_id),
        department_name: primary.parent_department_name ?? null,
        process_id: primary.parent_process_id == null ? null : Number(primary.parent_process_id),
      },
      lines,
      totals,
      cumulative,
      vendors,
      history,
      approval,
      permissions,
      _effective_status: effectiveStatus,
      _state: state,
    };
  },

  /**
   * Get all rounds for an RFQ (optionally filtered by product).
   * When vendorId is provided, returns only rounds where that vendor is in vendor_ids.
   */
  getRoundsByRfqId: async (rfqId, rfqProductId = null, vendorId = null) => {
    let query = `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1`;

    const values = [rfqId];

    if (rfqProductId) {
      values.push(rfqProductId);
      query += ` AND ${coversProductSql(`$${values.length}`)}`;
    }

    if (vendorId) {
      values.push(vendorId);
      query += ` AND $${values.length} = ANY(nr.vendor_ids)`;
    }

    // NULLS LAST keeps legacy per-product grouping while multi rounds
    // (rfq_product_id NULL) sort by round number.
    query += ` ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number ASC, nr.created_at DESC`;

    const rows = await db.any(query, values);
    rows.forEach(normalizeProductNames);
    // Vendor reads must not leak other vendors' targets.
    if (vendorId) rows.forEach(r => stripProductsForVendor(r, vendorId));
    return rows;
  },

  /**
   * Buyer landing list: every RFQ that has at least one negotiation round,
   * scoped to a hospitality company (and optionally a single hotel). One row
   * per RFQ, rolled up to the RFQ's LATEST round (max created_at), with the
   * aggregated facets the Negotiation list page renders (hotel, department,
   * product names, vendor names) plus an effective `neg_status` string the
   * page buckets into its tabs.
   *
   * neg_status mapping (latest round, with end_date check):
   *   DRAFT | PENDING_APPROVAL                 → 'pending_approval'
   *   ACTIVE & end_date in future (or null)    → 'active'
   *   ACTIVE & end_date passed, or ENDED       → 'awaiting_decision'
   *   COMPLETED                                → 'completed'
   *   CANCELLED | EXPIRED                       → 'cancelled'
   *
   * Stored timestamps are UTC-naive (timestamp without time zone), so compare
   * end_date against now() converted to UTC.
   */
  // DEPRECATED — DEAD (no callers) AND WRONG. Superseded by
  // getPendingNegotiationParentIds. Two defects, both fixed there:
  //   * `nr.id = i.entity_id` drops the 69 legacy instances whose entity_id is
  //     an rfq_product id, including every currently-PENDING one. Use
  //     negotiationInstanceRoundIdSql instead — it resolves 884/884.
  //   * no `sa.removed_at IS NULL`, so a removed approver still counts.
  // Left in place rather than deleted; do not wire it into anything new.
  //
  // Of the given RFQ ids, which have a negotiation approval waiting on the user
  // (current-step pending approver). NEGOTIATION instances key on the round id
  // (→ round.rfq_id); NEGOTIATION_QUOTE instances key on the rfq_product id
  // (→ product.rfq_id).
  getPendingNegotiationRfqIds: async (rfqIds, userId) => {
    if (!Array.isArray(rfqIds) || rfqIds.length === 0 || !userId) return [];
    const rows = await db.any(
      `SELECT DISTINCT rfq_id FROM (
         SELECT nr.rfq_id
           FROM tbl_approval_instances i
           JOIN tbl_negotiation_rounds nr ON nr.id = i.entity_id
           JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type = 'NEGOTIATION' AND i.status = 'PENDING'
            AND nr.rfq_id = ANY($1::int[])
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
         UNION
         SELECT rp.rfq_id
           FROM tbl_approval_instances i
           JOIN tbl_rfq_products rp ON rp.id = i.entity_id
           JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type = 'NEGOTIATION_QUOTE' AND i.status = 'PENDING'
            AND rp.rfq_id = ANY($1::int[])
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
       ) t`,
      [rfqIds.map(Number), Number(userId)]
    );
    return rows.map((r) => Number(r.rfq_id));
  },

  // ============= NEGOTIATION APPROVAL INSTANCE → ROUND ID =============
  //
  // `tbl_approval_instances` rows of entity_type NEGOTIATION / ARC_NEGOTIATION
  // come in TWO shapes, and reading only `entity_id` silently drops 69 of 884
  // production instances — including EVERY currently-PENDING one, which is why
  // the listing's "Pending for me" tab has been permanently 0.
  //
  //   modern (815 rows) entity_id = tbl_negotiation_rounds.id
  //   legacy  (69 rows) entity_id = tbl_rfq_products.id, and the real round id
  //                     lives in metadata->>'round_id'
  //
  // The legacy shape cannot be detected by "does entity_id resolve to a round?"
  // — 41 of those 69 have an entity_id that COLLIDES with a real (unrelated)
  // round id. The tie-break that works on all 884 is metadata->>'rfq_id':
  // the true round is the one whose rfq_id matches the instance's metadata.
  //
  // Resolution ladder (verified: 884/884 resolve, 815 direct + 69 via metadata):
  //   1. entity_id resolves to a round AND (no metadata rfq_id, or that round's
  //      rfq_id matches it)                            → entity_id
  //   2. otherwise metadata->>'round_id' resolves       → that round
  //
  // Shared by getPendingNegotiationRoundIds and getRoundApprovalState so the
  // listing toggle and the detail page's approval card can never disagree.
  negotiationInstanceRoundJoinSql: (instanceAlias = 'i') => `
         LEFT JOIN tbl_negotiation_rounds _nrd ON _nrd.id = ${instanceAlias}.entity_id
         LEFT JOIN tbl_negotiation_rounds _nrm
                ON _nrm.id = CASE WHEN (${instanceAlias}.metadata->>'round_id') ~ '^[0-9]+$'
                                  THEN (${instanceAlias}.metadata->>'round_id')::int END`,

  negotiationInstanceRoundIdSql: (instanceAlias = 'i') => `
         CASE
           WHEN _nrd.id IS NOT NULL
                AND (
                  (${instanceAlias}.metadata->>'rfq_id') IS NULL
                  OR (${instanceAlias}.metadata->>'rfq_id') !~ '^[0-9]+$'
                  OR _nrd.rfq_id = (${instanceAlias}.metadata->>'rfq_id')::int
                )
             THEN _nrd.id
           ELSE _nrm.id
         END`,

  // Per-ROUND equivalent of getPendingNegotiationRfqIds: round ids whose
  // NEGOTIATION or ARC_NEGOTIATION approval instance is PENDING with the
  // current user a pending approver at the current step.
  // (No NEGOTIATION_QUOTE union — those are product-level, not a round.)
  getPendingNegotiationRoundIds: async (roundIds, userId) => {
    if (!Array.isArray(roundIds) || roundIds.length === 0 || !userId) return [];
    const roundIdExpr = negotiationModel.negotiationInstanceRoundIdSql('i');
    const rows = await db.any(
      `SELECT DISTINCT (${roundIdExpr}) AS round_id
         FROM tbl_approval_instances i
         ${negotiationModel.negotiationInstanceRoundJoinSql('i')}
         -- The RESOLVED round, not _nrd. roundIdExpr's CASE prefers _nrm (the
         -- legacy metadata shape) whenever the instance carries an rfq_id, and
         -- _nrd can match an unrelated round whose id collides with the
         -- entity_id. Reading _nrd.end_date directly gets the wrong round's
         -- deadline on exactly the legacy shape this query exists to support.
         LEFT JOIN tbl_negotiation_rounds _nrr ON _nrr.id = (${roundIdExpr})
         JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
         JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
        WHERE i.entity_type IN ('NEGOTIATION','ARC_NEGOTIATION') AND i.status = 'PENDING'
          AND (${roundIdExpr}) = ANY($1::int[])
          AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
          AND sa.removed_at IS NULL
          -- The round's vendor window must still be open. ApproveRoundPage
          -- already filters end_date > now, so without the same condition
          -- here a round whose window closed renders "Approval needed" and
          -- then lands the approver on "No rounds awaiting your approval" —
          -- and approving it would publish a round to vendors who can no
          -- longer answer. Six production instances leaked into exactly that
          -- state in March 2026 when the deadline cron ended the round without
          -- cancelling its approval instance.
          AND (_nrr.end_date IS NULL OR _nrr.end_date > (now() AT TIME ZONE 'UTC'))`,
      [roundIds.map(Number), Number(userId)]
    );
    return rows.map((r) => Number(r.round_id)).filter(Number.isFinite);
  },

  // `userId` drives the RBAC read matrix (see negotiationReadScopeSql). Pass
  // null ONLY for super admins (user_type 8). The companyIds clause is kept as
  // defence in depth — both must hold.
  getNegotiationRfqList: async ({ companyIds = null, hotelIds = null, userId = null }) => {
    return db.any(
      `WITH neg AS (
         SELECT nr.rfq_id,
                COUNT(*)::int AS total_rounds,
                MAX(nr.round_number) AS latest_round_number,
                (ARRAY_AGG(nr.id ORDER BY nr.created_at DESC))[1] AS latest_round_id
           FROM tbl_negotiation_rounds nr
          WHERE nr.rfq_id IS NOT NULL
          GROUP BY nr.rfq_id
       )
       SELECT rfq.id                AS rfq_id,
              rfq.rfq_no,
              rfq.title,
              rfq.is_tender,
              rfq.hotel_id,
              h.name                AS hotel_name,
              rfq.department_id,
              d.title               AS department_title,
              neg.total_rounds,
              neg.latest_round_number,
              lr.status             AS latest_round_status,
              lr.end_date,
              lr.created_at         AS latest_round_created_at,
              lr.approved_at,
              lr.published_at,
              lr.closed_at,
              COALESCE(array_length(lr.vendor_ids, 1), 0)::int AS invited_count,
              CASE
                WHEN lr.status IN ('DRAFT','PENDING_APPROVAL') THEN 'pending_approval'
                WHEN lr.status = 'ACTIVE'
                     AND (lr.end_date IS NULL OR lr.end_date > (now() AT TIME ZONE 'UTC')) THEN 'active'
                WHEN lr.status = 'ACTIVE' THEN 'awaiting_decision'
                WHEN lr.status = 'ENDED' THEN 'awaiting_decision'
                WHEN lr.status = 'COMPLETED' THEN 'completed'
                WHEN lr.status IN ('CANCELLED','EXPIRED') THEN 'cancelled'
                ELSE 'pending_approval'
              END AS neg_status,
              COALESCE(q.quotes_received, 0)::int AS quotes_received,
              COALESCE(items.item_names, '[]'::json) AS item_names,
              COALESCE(vend.vendors, '[]'::jsonb) AS vendors
         FROM neg
         JOIN tbl_rfq rfq ON rfq.id = neg.rfq_id
         JOIN tbl_negotiation_rounds lr ON lr.id = neg.latest_round_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rfq.hotel_id
         LEFT JOIN tbl_department d ON d.id = rfq.department_id
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.rfq_product_id))::int AS quotes_received
             FROM tbl_negotiation_round_quotes nrq
            WHERE nrq.negotiation_round_id = lr.id
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(DISTINCT COALESCE(PV.name, P.name))
                    FILTER (WHERE COALESCE(PV.name, P.name) IS NOT NULL) AS item_names
             FROM tbl_rfq_products rp
             LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
             LEFT JOIN tbl_product P ON P.id = PV.product_id
            WHERE rp.rfq_id = rfq.id
         ) items ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name)) AS vendors
             FROM tbl_negotiation_rounds nr2
             CROSS JOIN LATERAL unnest(COALESCE(nr2.vendor_ids, '{}'::int[])) AS vid(vendor_id)
             JOIN tbl_users u ON u.id = vid.vendor_id
            WHERE nr2.rfq_id = rfq.id
         ) vend ON TRUE
        WHERE ($1::int[] IS NULL OR rfq.hospitality_company_id = ANY($1::int[]))
          AND ($2::int[] IS NULL OR rfq.hotel_id = ANY($2::int[]))
          AND ${negotiationReadScopeSql('rfq', '$3')}
        ORDER BY lr.created_at DESC`,
      [companyIds, hotelIds, userId]
    );
  },

  // Round-level list: ONE ROW PER negotiation round (an RFQ with 6 rounds yields
  // 6 rows). Mirrors getNegotiationRfqList's status CASE, scope WHERE and facet
  // columns, but everything is per-round. Per-round products honour both legacy
  // (rfq_product_id) and multi-product (products JSONB) shapes.
  // `userId` drives the RBAC read matrix (see negotiationReadScopeSql). Pass
  // null ONLY for super admins (user_type 8). The companyIds clause is kept as
  // defence in depth — both must hold.
  getNegotiationRoundList: async ({ companyIds = null, hotelId = null, userId = null }) => {
    return db.any(
      `SELECT nr.id                 AS round_id,
              -- The DISPLAYED round number: this round's position in the whole
              -- RFQ, computed at read time. The stored column restarts at 1 per
              -- product on every legacy row, so it is carried separately for
              -- diagnostics and never rendered. See roundPositionSql.
              ${roundPositionSql('nr.rfq_id')} AS round_number,
              nr.round_number       AS stored_round_number,
              nr.created_at         AS round_created_at,
              ${roundTotalSql('nr.rfq_id')} AS total_rounds,
              ${roundTotalSql('nr.rfq_id')} AS rounds_on_parent,
              -- Context only, never the denominator.
              cyc.rounds_on_products,
              rfq.id                AS rfq_id,
              rfq.rfq_no,
              rfq.title,
              rfq.is_tender,
              rfq.hotel_id,
              h.name                AS hotel_name,
              rfq.department_id,
              d.title               AS department_title,
              nr.status             AS round_status,
              nr.end_date,
              nr.approved_at,
              nr.published_at,
              nr.closed_at,
              COALESCE(array_length(nr.vendor_ids, 1), 0)::int AS invited_count,
              ${negotiationStateCaseSql('nr', 'q.quotes_received', 'aq.has_approved_quote')} AS neg_status,
              COALESCE(aq.has_approved_quote, false) AS has_approved_quote,
              COALESCE(q.quotes_received, 0)::int AS quotes_received,
              COALESCE(items.item_names, '[]'::json) AS item_names,
              COALESCE(vend.vendors, '[]'::jsonb) AS vendors,
              'RFQ'::text AS source_type,
              NULL::int   AS arc_id,
              NULL::text  AS arc_number
         FROM tbl_negotiation_rounds nr
         JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rfq.hotel_id
         LEFT JOIN tbl_department d ON d.id = rfq.department_id
         ${roundCycleLateralSql('nr')}
         ${approvedQuoteLateralSql('nr', 'aq')}
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.rfq_product_id))::int AS quotes_received
             FROM tbl_negotiation_round_quotes nrq
            WHERE nrq.negotiation_round_id = nr.id
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(DISTINCT COALESCE(PV.name, P.name))
                    FILTER (WHERE COALESCE(PV.name, P.name) IS NOT NULL) AS item_names
             FROM tbl_rfq_products rp
             LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
             LEFT JOIN tbl_product P ON P.id = PV.product_id
            WHERE rp.id = nr.rfq_product_id
               OR rp.id IN (
                 SELECT (p_->>'rfq_product_id')::int
                 FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
                 WHERE p_->>'rfq_product_id' IS NOT NULL
               )
         ) items ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name)) AS vendors
             FROM unnest(COALESCE(nr.vendor_ids, '{}'::int[])) AS vid(vendor_id)
             JOIN tbl_users u ON u.id = vid.vendor_id
         ) vend ON TRUE
        WHERE nr.rfq_id IS NOT NULL
          AND ($1::int[] IS NULL OR rfq.hospitality_company_id = ANY($1::int[]))
          AND ($2::int IS NULL OR rfq.hotel_id = $2)
          AND ${negotiationReadScopeSql('rfq', '$3')}
        ORDER BY nr.created_at DESC`,
      [companyIds, hotelId, userId]
    );
  },

  // ARC negotiation round list: one row per ARC negotiation round, shaped to the
  // EXACT same column contract as getNegotiationRoundList so the controller's
  // bucket/facet/sort/paginate logic works over the concatenated array unchanged.
  // Scoped to a.hospitality_company_id = ANY(companyIds) — same guard as the RFQ branch.
  getArcNegotiationRoundList: async ({ companyIds = null, hotelId = null, userId = null }) => {
    return db.any(
      `SELECT nr.id                 AS round_id,
              -- Same read-time position as the RFQ branch. ARC allocation is
              -- already contract-wide, so this agrees with the stored value.
              ${roundPositionSql('nr.source_id')} AS round_number,
              nr.round_number       AS stored_round_number,
              nr.created_at         AS round_created_at,
              ${roundTotalSql('nr.source_id')} AS total_rounds,
              ${roundTotalSql('nr.source_id')} AS rounds_on_parent,
              cyc.rounds_on_products,
              NULL::int             AS rfq_id,
              a.arc_number          AS rfq_no,
              a.title               AS title,
              0                     AS is_tender,
              a.hotel_id,
              h.name                AS hotel_name,
              a.department_id,
              d.title               AS department_title,
              nr.status             AS round_status,
              nr.end_date,
              nr.approved_at,
              nr.published_at,
              nr.closed_at,
              COALESCE(array_length(nr.vendor_ids, 1), 0)::int AS invited_count,
              -- There is no ARC counterpart of the NEGOTIATION_QUOTE approval
              -- entity -- an approved ARC round applies its revised prices
              -- straight onto the contract -- so hasApprovedQuote is
              -- structurally false here and COMPLETED is the only route to
              -- 'concluded'.
              ${negotiationStateCaseSql('nr', 'q.quotes_received', 'false')} AS neg_status,
              false                 AS has_approved_quote,
              COALESCE(q.quotes_received, 0)::int AS quotes_received,
              COALESCE(items.item_names, '[]'::json) AS item_names,
              COALESCE(vend.vendors, '[]'::jsonb) AS vendors,
              'ARC'::text           AS source_type,
              a.id                  AS arc_id,
              a.arc_number          AS arc_number
         FROM tbl_negotiation_rounds nr
         JOIN tbl_arc a ON a.id = nr.source_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN tbl_department d ON d.id = a.department_id
         ${arcRoundCycleLateralSql('nr')}
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.arc_item_id))::int AS quotes_received
             FROM tbl_negotiation_round_quotes nrq
            WHERE nrq.negotiation_round_id = nr.id
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT json_agg(DISTINCT pv.name) FILTER (WHERE pv.name IS NOT NULL) AS item_names
             FROM tbl_arc_item ai
             LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
            WHERE ai.id = nr.arc_item_id
               OR ai.id IN (
                 SELECT (p_->>'arc_item_id')::int
                   FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
                  WHERE p_->>'arc_item_id' IS NOT NULL
               )
         ) items ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name)) AS vendors
             FROM unnest(COALESCE(nr.vendor_ids, '{}'::int[])) AS vid(vendor_id)
             JOIN tbl_users u ON u.id = vid.vendor_id
         ) vend ON TRUE
        WHERE nr.source_type = 'ARC'
          AND ($1::int[] IS NULL OR a.hospitality_company_id = ANY($1::int[]))
          AND ($2::int IS NULL OR a.hotel_id = $2)
          AND ${negotiationReadScopeSql('a', '$3')}
        ORDER BY nr.created_at DESC`,
      [companyIds, hotelId, userId]
    );
  },

  // ==========================================================================
  // PARENT-LEVEL LIST — ONE ROW PER RFQ / ARC
  // ==========================================================================
  //
  // The round-level list above returns one row per round. RFQ 512 has 138 of
  // them, and users read 138 rows as 138 different RFQs. Production carries 886
  // rounds over 124 distinct RFQs (median 2 rounds, max 138), so grouping
  // collapses 45 pages to 7.
  //
  // These two functions are the SAME query as getNegotiationRoundList /
  // getArcNegotiationRoundList, wrapped as a subquery and GROUPed BY the
  // parent. negotiationStateCaseSql and approvedQuoteLateralSql are reused
  // verbatim inside the subquery, so a round's state means exactly the same
  // thing at both levels; only the roll-up on top is new.
  //
  // SCOPE: the RBAC read matrix is applied INSIDE the subquery, against the
  // parent (rfq / a) exactly as the round-level queries apply it. Grouping over
  // an already-scoped set cannot widen scope. Every round of a visible parent is
  // visible (the matrix resolves entirely against parent columns), so the
  // correlated sub-selects below — which re-read the parent's rounds by
  // rfq_id / source_id to union vendors and products — cannot widen it either.
  //
  // `userId` drives the RBAC read matrix (see negotiationReadScopeSql). Pass
  // null ONLY for super admins (user_type 8). The companyIds clause is kept as
  // defence in depth — both must hold.
  getNegotiationParentList: async ({ companyIds = null, hotelId = null, userId = null }) => {
    const stateExpr = 'r.neg_status';
    return db.any(
      `SELECT 'RFQ:' || r.rfq_id            AS parent_key,
              'RFQ'::text                   AS source_type,
              r.rfq_id,
              NULL::int                     AS arc_id,
              NULL::text                    AS arc_number,
              r.rfq_no,
              r.title,
              r.is_tender,
              r.hotel_id,
              r.hotel_name,
              r.department_id,
              r.department_title,
              COUNT(*)::int                 AS round_count,
              ${negotiationStateCountsSql(stateExpr)} AS state_counts,
              ${negotiationParentStateCaseSql(stateExpr)} AS neg_status,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.READY_FOR_DECISION}')::int AS ready_for_decision_count,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.OPEN_WITH_VENDORS}')::int  AS open_with_vendors_count,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.AWAITING_APPROVAL}')::int  AS awaiting_approval_count,
              MIN(r.round_created_at)       AS first_round_at,
              -- Latest thing that happened anywhere on this parent: any round
              -- transition, or the most recent vendor response.
              GREATEST(MAX(r.round_created_at), MAX(r.approved_at),
                       MAX(r.published_at), MAX(r.closed_at), MAX(r.last_quote_at))
                                            AS last_activity_at,
              -- The next thing that WILL happen: earliest still-future window
              -- close across the parent's rounds. NULL when nothing is pending.
              MIN(r.end_date) FILTER (WHERE r.end_date > (now() AT TIME ZONE 'UTC'))
                                            AS next_deadline,
              -- Distinct vendor responses across the whole parent (a vendor that
              -- re-quoted the same product in six rounds counts once).
              (SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.rfq_product_id))::int
                 FROM tbl_negotiation_round_quotes nrq
                 JOIN tbl_negotiation_rounds nr2 ON nr2.id = nrq.negotiation_round_id
                WHERE nr2.rfq_id = r.rfq_id) AS quotes_received,
              -- Vendors invited to ANY round of this parent.
              COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name))
                          FROM tbl_negotiation_rounds nr2
                          CROSS JOIN LATERAL unnest(COALESCE(nr2.vendor_ids, '{}'::int[])) AS vid(vendor_id)
                          JOIN tbl_users u ON u.id = vid.vendor_id
                         WHERE nr2.rfq_id = r.rfq_id), '[]'::jsonb) AS vendors,
              -- Products ACTUALLY NEGOTIATED — the union of every round's
              -- rfq_product_id and its products JSONB. NOT every product on the
              -- RFQ: an 80-line RFQ may have negotiated 3 of them.
              COALESCE((SELECT json_agg(DISTINCT pnames.nm)
                          FROM tbl_negotiation_rounds nr2
                          CROSS JOIN LATERAL (
                            SELECT nr2.rfq_product_id AS pid
                            UNION ALL
                            SELECT (p_->>'rfq_product_id')::int
                              FROM jsonb_array_elements(COALESCE(nr2.products, '[]'::jsonb)) p_
                             WHERE p_->>'rfq_product_id' IS NOT NULL
                          ) ids
                          JOIN tbl_rfq_products rp ON rp.id = ids.pid
                          LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
                          LEFT JOIN tbl_product P ON P.id = PV.product_id
                          CROSS JOIN LATERAL (SELECT COALESCE(PV.name, P.name) AS nm) pnames
                         WHERE nr2.rfq_id = r.rfq_id
                           AND COALESCE(PV.name, P.name) IS NOT NULL), '[]'::json) AS item_names
         FROM (
           SELECT rfq.id                AS rfq_id,
                  rfq.rfq_no,
                  rfq.title,
                  rfq.is_tender,
                  rfq.hotel_id,
                  h.name                AS hotel_name,
                  rfq.department_id,
                  d.title               AS department_title,
                  nr.id                 AS round_id,
                  nr.created_at         AS round_created_at,
                  nr.end_date,
                  nr.approved_at,
                  nr.published_at,
                  nr.closed_at,
                  ${negotiationStateCaseSql('nr', 'q.quotes_received', 'aq.has_approved_quote')} AS neg_status,
                  q.last_quote_at
             FROM tbl_negotiation_rounds nr
             JOIN tbl_rfq rfq ON rfq.id = nr.rfq_id
             LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rfq.hotel_id
             LEFT JOIN tbl_department d ON d.id = rfq.department_id
             ${approvedQuoteLateralSql('nr', 'aq')}
             LEFT JOIN LATERAL (
               SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.rfq_product_id))::int AS quotes_received,
                      MAX(nrq.submitted_at) AS last_quote_at
                 FROM tbl_negotiation_round_quotes nrq
                WHERE nrq.negotiation_round_id = nr.id
             ) q ON TRUE
            WHERE nr.rfq_id IS NOT NULL
              AND ($1::int[] IS NULL OR rfq.hospitality_company_id = ANY($1::int[]))
              AND ($2::int IS NULL OR rfq.hotel_id = $2)
              AND ${negotiationReadScopeSql('rfq', '$3')}
         ) r
        GROUP BY r.rfq_id, r.rfq_no, r.title, r.is_tender,
                 r.hotel_id, r.hotel_name, r.department_id, r.department_title
        ORDER BY last_activity_at DESC NULLS LAST`,
      [companyIds, hotelId, userId]
    );
  },

  // ARC counterpart, shaped to the EXACT same column contract so the
  // controller's search / facet / sort / paginate pipeline works over the
  // concatenated array unchanged. ARC parents carry rfq_id = NULL — which is
  // precisely why filters.parentKey exists alongside filters.rfqId.
  getArcNegotiationParentList: async ({ companyIds = null, hotelId = null, userId = null }) => {
    const stateExpr = 'r.neg_status';
    return db.any(
      `SELECT 'ARC:' || r.arc_id            AS parent_key,
              'ARC'::text                   AS source_type,
              NULL::int                     AS rfq_id,
              r.arc_id,
              r.arc_number,
              r.arc_number                  AS rfq_no,
              r.title,
              0                             AS is_tender,
              r.hotel_id,
              r.hotel_name,
              r.department_id,
              r.department_title,
              COUNT(*)::int                 AS round_count,
              ${negotiationStateCountsSql(stateExpr)} AS state_counts,
              ${negotiationParentStateCaseSql(stateExpr)} AS neg_status,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.READY_FOR_DECISION}')::int AS ready_for_decision_count,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.OPEN_WITH_VENDORS}')::int  AS open_with_vendors_count,
              COUNT(*) FILTER (WHERE ${stateExpr} = '${NEG_STATE.AWAITING_APPROVAL}')::int  AS awaiting_approval_count,
              MIN(r.round_created_at)       AS first_round_at,
              GREATEST(MAX(r.round_created_at), MAX(r.approved_at),
                       MAX(r.published_at), MAX(r.closed_at), MAX(r.last_quote_at))
                                            AS last_activity_at,
              MIN(r.end_date) FILTER (WHERE r.end_date > (now() AT TIME ZONE 'UTC'))
                                            AS next_deadline,
              (SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.arc_item_id))::int
                 FROM tbl_negotiation_round_quotes nrq
                 JOIN tbl_negotiation_rounds nr2 ON nr2.id = nrq.negotiation_round_id
                WHERE nr2.source_type = 'ARC' AND nr2.source_id = r.arc_id) AS quotes_received,
              COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name))
                          FROM tbl_negotiation_rounds nr2
                          CROSS JOIN LATERAL unnest(COALESCE(nr2.vendor_ids, '{}'::int[])) AS vid(vendor_id)
                          JOIN tbl_users u ON u.id = vid.vendor_id
                         WHERE nr2.source_type = 'ARC' AND nr2.source_id = r.arc_id), '[]'::jsonb) AS vendors,
              COALESCE((SELECT json_agg(DISTINCT pv.name)
                          FROM tbl_negotiation_rounds nr2
                          CROSS JOIN LATERAL (
                            SELECT nr2.arc_item_id AS aid
                            UNION ALL
                            SELECT (p_->>'arc_item_id')::bigint
                              FROM jsonb_array_elements(COALESCE(nr2.products, '[]'::jsonb)) p_
                             WHERE p_->>'arc_item_id' IS NOT NULL
                          ) ids
                          JOIN tbl_arc_item ai ON ai.id = ids.aid
                          LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
                         WHERE nr2.source_type = 'ARC' AND nr2.source_id = r.arc_id
                           AND pv.name IS NOT NULL), '[]'::json) AS item_names
         FROM (
           SELECT a.id                  AS arc_id,
                  a.arc_number,
                  a.title,
                  a.hotel_id,
                  h.name                AS hotel_name,
                  a.department_id,
                  d.title               AS department_title,
                  nr.id                 AS round_id,
                  nr.created_at         AS round_created_at,
                  nr.end_date,
                  nr.approved_at,
                  nr.published_at,
                  nr.closed_at,
                  -- No ARC counterpart of the NEGOTIATION_QUOTE approval entity
                  -- exists, so hasApprovedQuote is structurally false and
                  -- COMPLETED is the only route to 'concluded'. Same as the
                  -- ARC round-level list.
                  ${negotiationStateCaseSql('nr', 'q.quotes_received', 'false')} AS neg_status,
                  q.last_quote_at
             FROM tbl_negotiation_rounds nr
             JOIN tbl_arc a ON a.id = nr.source_id
             LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
             LEFT JOIN tbl_department d ON d.id = a.department_id
             LEFT JOIN LATERAL (
               SELECT COUNT(DISTINCT (nrq.vendor_id, nrq.arc_item_id))::int AS quotes_received,
                      MAX(nrq.submitted_at) AS last_quote_at
                 FROM tbl_negotiation_round_quotes nrq
                WHERE nrq.negotiation_round_id = nr.id
             ) q ON TRUE
            WHERE nr.source_type = 'ARC'
              AND ($1::int[] IS NULL OR a.hospitality_company_id = ANY($1::int[]))
              AND ($2::int IS NULL OR a.hotel_id = $2)
              AND ${negotiationReadScopeSql('a', '$3')}
         ) r
        GROUP BY r.arc_id, r.arc_number, r.title,
                 r.hotel_id, r.hotel_name, r.department_id, r.department_title
        ORDER BY last_activity_at DESC NULLS LAST`,
      [companyIds, hotelId, userId]
    );
  },

  // ==========================================================================
  // PARENT SAVINGS — the money on a parent card
  // ==========================================================================
  //
  // ⚠️ SECURITY: this query reads tbl_quotes / tbl_quote_items /
  // tbl_quote_item_history and carries NO scope predicate of its own. It is a
  // pure "given these rfq ids, price them" function. CALLERS MUST PASS ONLY
  // RFQ IDS THAT ALREADY SURVIVED THE SCOPED PARENT QUERY. Never call it with
  // ids taken from a request body, a facet, or a filter.
  //
  // TWO figures per parent, because they answer different questions:
  //   * all-vendor  — every vendor that participated. Same basis as the round
  //     page's `cumulative` tile, so the two levels agree when a user drills in.
  //   * awarded     — only the vendor whose quote was actually APPROVED
  //     (an APPROVED NEGOTIATION_QUOTE whose metadata.vendor_id matches). This
  //     is the realised benefit. It is null/zero for parents with no approved
  //     quote (36 of the 124 production RFQs) — correct, not a bug.
  //
  // METHOD. Per (vendor, rfq_product) pair, over the parent's NON-CANCELLED
  // rounds: BASELINE from the EARLIEST round, ACHIEVED from the LATEST round.
  // Values are SIGNED and NEVER clamped — 14 production RFQs genuinely ended
  // higher than they started, and hiding that would be a lie.
  //
  // The baseline uses the documented ladder (see resolveBaseline):
  //
  //     previous_price -> prior_round -> quote_history -> current_quote
  //
  // evaluated AT THE EARLIEST ROUND, which is what makes the span the full
  // negotiation rather than its last leg. Two notes on the rungs:
  //
  //   * `prior_round` means "an earlier round's price for this pair". At the
  //     earliest round there is, by construction, no earlier round — so within
  //     one RFQ that rung can only fire as a fallback when the vendor's quote
  //     item has no revision history at all. It is placed accordingly (below
  //     quote_history) rather than left as dead code. Measured on production
  //     both placements give byte-identical totals: 0 multi-round pairs lack
  //     quote history.
  //   * the NAIVE "first round price vs last round price" rule is NOT used. It
  //     returns 0 for 91 of 101 priced RFQs because only 78 of 428 (rfq,
  //     vendor, product) triples appear in more than one round at all —
  //     ₹3.43 lakh total, against ₹98.46 lakh for the ladder.
  //
  // Production totals for the ladder as implemented (measured 2026-08-01):
  //   all vendors  baseline ₹8,04,14,568  saved ₹98,45,639
  //   awarded only baseline ₹6,26,64,916  saved ₹64,67,966
  //
  // ARC parents are not priced here: ARC round quotes carry a UNIT rate against
  // a different fact table, and ARC has no NEGOTIATION_QUOTE award entity to
  // define an "awarded" subset. They report null savings.
  getNegotiationParentSavings: async (rfqIds) => {
    const ids = [...new Set((rfqIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    return db.any(
      `WITH r AS (
         SELECT nr.id, nr.rfq_id, nr.created_at
           FROM tbl_negotiation_rounds nr
          WHERE nr.rfq_id = ANY($1::int[])
            AND COALESCE(nr.source_type, 'RFQ') <> 'ARC'
            AND nr.status <> 'CANCELLED'
       ), q AS (
         SELECT r.rfq_id, nrq.vendor_id, nrq.rfq_product_id,
                nrq.quoted_price, nrq.previous_price,
                ROW_NUMBER() OVER (PARTITION BY r.rfq_id, nrq.vendor_id, nrq.rfq_product_id
                                       ORDER BY r.created_at, r.id, nrq.id)                AS rn_asc,
                ROW_NUMBER() OVER (PARTITION BY r.rfq_id, nrq.vendor_id, nrq.rfq_product_id
                                       ORDER BY r.created_at DESC, r.id DESC, nrq.id DESC) AS rn_desc,
                DENSE_RANK() OVER (PARTITION BY r.rfq_id, nrq.vendor_id, nrq.rfq_product_id
                                       ORDER BY r.created_at DESC, r.id DESC)              AS dr_desc
           FROM tbl_negotiation_round_quotes nrq
           JOIN r ON r.id = nrq.negotiation_round_id
          WHERE nrq.rfq_product_id IS NOT NULL
       ), pair AS (
         SELECT e.rfq_id, e.vendor_id, e.rfq_product_id,
                e.previous_price,
                e.quoted_price AS first_quoted,
                mx.n_rounds,
                l.quoted_price AS achieved
           FROM q e
           JOIN q l ON l.rfq_id = e.rfq_id AND l.vendor_id = e.vendor_id
                   AND l.rfq_product_id = e.rfq_product_id AND l.rn_desc = 1
           JOIN LATERAL (
             SELECT MAX(z.dr_desc) AS n_rounds
               FROM q z
              WHERE z.rfq_id = e.rfq_id AND z.vendor_id = e.vendor_id
                AND z.rfq_product_id = e.rfq_product_id
           ) mx ON TRUE
          WHERE e.rn_asc = 1
       ), facts AS (
         SELECT p.*,
                qi.total_price AS cur_total,
                hist.first_total,
                EXISTS (
                  SELECT 1 FROM tbl_approval_instances ai
                   WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
                     AND ai.status = 'APPROVED'
                     AND ai.entity_id = p.rfq_product_id
                     AND (ai.metadata->>'vendor_id') ~ '^[0-9]+$'
                     AND (ai.metadata->>'vendor_id')::int = p.vendor_id
                ) AS is_awarded
           FROM pair p
           LEFT JOIN tbl_rfq_products rp ON rp.id = p.rfq_product_id
           LEFT JOIN LATERAL (
             SELECT qq.id FROM tbl_quotes qq
              WHERE qq.rfq_id = p.rfq_id AND qq.created_by = p.vendor_id
              ORDER BY qq.id DESC LIMIT 1
           ) vq ON TRUE
           LEFT JOIN LATERAL (
             SELECT qi2.* FROM tbl_quote_items qi2
              WHERE qi2.quote_id = vq.id
                AND qi2.product_variant_id = rp.product_variant_id
                AND qi2.variant = rp.variant
              ORDER BY qi2.id DESC LIMIT 1
           ) qi ON TRUE
           LEFT JOIN LATERAL (
             SELECT h.total_price FROM tbl_quote_item_history h
              WHERE h.quote_item_id = qi.id
              ORDER BY h.timestamp ASC, h.id ASC LIMIT 1
           ) hist(first_total) ON TRUE
       ), scored AS (
         SELECT f.rfq_id, f.achieved, f.is_awarded,
                COALESCE(f.previous_price,
                         f.first_total,
                         CASE WHEN f.n_rounds > 1 THEN f.first_quoted END,
                         f.cur_total) AS baseline,
                CASE WHEN f.previous_price IS NOT NULL           THEN 'previous_price'
                     WHEN f.first_total    IS NOT NULL           THEN 'quote_history'
                     WHEN f.n_rounds > 1                         THEN 'prior_round'
                     WHEN f.cur_total      IS NOT NULL           THEN 'current_quote'
                     ELSE NULL END AS baseline_source
           FROM facts f
       )
       SELECT rfq_id,
              COUNT(*) FILTER (WHERE baseline IS NOT NULL AND achieved IS NOT NULL)::int AS pairs_counted,
              COALESCE(SUM(baseline)  FILTER (WHERE baseline IS NOT NULL AND achieved IS NOT NULL), 0) AS baseline_total,
              COALESCE(SUM(achieved)  FILTER (WHERE baseline IS NOT NULL AND achieved IS NOT NULL), 0) AS achieved_total,
              COUNT(*) FILTER (WHERE is_awarded AND baseline IS NOT NULL AND achieved IS NOT NULL)::int AS pairs_counted_awarded,
              COALESCE(SUM(baseline)  FILTER (WHERE is_awarded AND baseline IS NOT NULL AND achieved IS NOT NULL), 0) AS baseline_total_awarded,
              COALESCE(SUM(achieved)  FILTER (WHERE is_awarded AND baseline IS NOT NULL AND achieved IS NOT NULL), 0) AS achieved_total_awarded,
              jsonb_build_object(
                'previous_price', COUNT(*) FILTER (WHERE baseline_source = 'previous_price')::int,
                'prior_round',    COUNT(*) FILTER (WHERE baseline_source = 'prior_round')::int,
                'quote_history',  COUNT(*) FILTER (WHERE baseline_source = 'quote_history')::int,
                'current_quote',  COUNT(*) FILTER (WHERE baseline_source = 'current_quote')::int,
                'none',           COUNT(*) FILTER (WHERE baseline_source IS NULL)::int
              ) AS baseline_sources
         FROM scored
        GROUP BY rfq_id`,
      [ids]
    );
  },

  // Of the given PARENT KEYS ('RFQ:<id>' / 'ARC:<id>'), which have a negotiation
  // approval waiting on this user right now (a pending approver at the current
  // step)?
  //
  // Replaces getPendingNegotiationRfqIds, which was dead AND wrong on two
  // counts:
  //   * it joined `nr.id = i.entity_id`, which drops the 69 legacy instances
  //     whose entity_id is an rfq_product id — including every currently
  //     PENDING one, so the toggle was permanently empty. Resolution now goes
  //     through negotiationInstanceRoundIdSql, which resolves 884/884.
  //   * it omitted `sa.removed_at IS NULL`, so a REMOVED approver still counted
  //     as pending.
  // Both fixes match getPendingNegotiationRoundIds, so the round listing and
  // the parent listing can never disagree about who owes an action.
  //
  // Unlike the round-level version this DOES union the NEGOTIATION_QUOTE
  // instances: they key on tbl_rfq_products.id, which is not a round but IS
  // unambiguously one RFQ.
  getPendingNegotiationParentIds: async (parentKeys, userId) => {
    const keys = (parentKeys || []).map(String).filter(Boolean);
    if (keys.length === 0 || !userId) return [];
    const roundIdExpr = negotiationModel.negotiationInstanceRoundIdSql('i');
    const rows = await db.any(
      `SELECT DISTINCT t.parent_key FROM (
         SELECT CASE WHEN nr.source_type = 'ARC' THEN 'ARC:' || nr.source_id
                     ELSE 'RFQ:' || nr.rfq_id END AS parent_key
           FROM tbl_approval_instances i
           ${negotiationModel.negotiationInstanceRoundJoinSql('i')}
           JOIN tbl_negotiation_rounds nr ON nr.id = (${roundIdExpr})
           JOIN tbl_approval_instance_steps s
             ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type IN ('NEGOTIATION','ARC_NEGOTIATION') AND i.status = 'PENDING'
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
            AND sa.removed_at IS NULL
            -- The round's vendor window must still be open. ApproveRoundPage
            -- filters end_date > now, so without the same condition here a
            -- parent renders "Approval needed" and then lands the approver on
            -- "No rounds awaiting your approval" — and approving would publish
            -- a round to vendors who can no longer answer. Six production
            -- instances leaked into that state in March 2026 when the deadline
            -- cron ended the round without cancelling its approval instance.
            AND (nr.end_date IS NULL OR nr.end_date > (now() AT TIME ZONE 'UTC'))
         UNION
         -- NO deadline condition on this branch. NEGOTIATION_QUOTE instances
         -- are product-level award approvals with no round window at all —
         -- 118 of them are live in production across 10 approvers.
         SELECT 'RFQ:' || rp.rfq_id AS parent_key
           FROM tbl_approval_instances i
           JOIN tbl_rfq_products rp ON rp.id = i.entity_id
           JOIN tbl_approval_instance_steps s
             ON s.approval_instance_id = i.id AND s.step_order = i.current_step
           JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
          WHERE i.entity_type = 'NEGOTIATION_QUOTE' AND i.status = 'PENDING'
            AND sa.approver_user_id = $2 AND sa.status = 'PENDING'
            AND sa.removed_at IS NULL
       ) t
        WHERE t.parent_key = ANY($1::text[])`,
      [keys, Number(userId)]
    );
    return rows.map((r) => r.parent_key);
  },

  /**
   * Get active round for a product.
   * When vendorId is provided, returns only the round assigned to that vendor.
   * When vendorId is omitted, returns the most recent active round (admin view).
   */
  getActiveRound: async (rfqId, rfqProductId, includeEnded = false, vendorId = null) => {
    if (!rfqProductId) {
      throw new Error('rfq_product_id is required');
    }

    const statusFilter = includeEnded
      ? `('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')`
      : `('PENDING_APPROVAL', 'ACTIVE')`;

    // When not including ended rounds, also exclude rounds whose end_date has passed
    const endDateFilter = includeEnded ? '' : `AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())`;

    let row;
    if (vendorId) {
      row = await db.oneOrNone(
        `SELECT
          nr.*,
          u.name as created_by_name,
          u.email as created_by_email,
          COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
          pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
           AND ${coversProductSql('$2')}
           AND nr.status IN ${statusFilter}
           ${endDateFilter}
           AND $3 = ANY(nr.vendor_ids)
         ORDER BY nr.round_number DESC
         LIMIT 1`,
        [rfqId, rfqProductId, vendorId]
      );
    } else {
      row = await db.oneOrNone(
        `SELECT
          nr.*,
          u.name as created_by_name,
          u.email as created_by_email,
          COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
          pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
           AND ${coversProductSql('$2')}
           AND nr.status IN ${statusFilter}
           ${endDateFilter}
         ORDER BY nr.round_number DESC
         LIMIT 1`,
        [rfqId, rfqProductId]
      );
    }

    normalizeProductNames(row);

    // F-NEGO-001: when a vendor is reading the round, scope vendor_approvals
    // to that vendor only — never expose other vendors' approval entries
    // (which carry their custom_charges, approval status, and acted-by ids).
    if (row && vendorId && Array.isArray(row.vendor_approvals)) {
      row.vendor_approvals = row.vendor_approvals.filter(
        (elem) => Number(elem?.vendor_id) === Number(vendorId)
      );
    }
    // Same rule for multi-product rounds: strip products[].vendor_targets
    // down to the requesting vendor.
    if (row && vendorId) stripProductsForVendor(row, vendorId);

    return row;
  },

  /**
   * Get all active rounds for an RFQ (multiple products)
   */
  getActiveRoundsByRfqId: async (rfqId, includeEnded = false) => {
    const statusFilter = includeEnded
      ? `('PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'CLOSED')`
      : `('PENDING_APPROVAL', 'ACTIVE')`;

    // When not including ended rounds, also exclude rounds whose end_date has passed
    // (cron may not have updated the status to ENDED yet)
    const endDateFilter = includeEnded ? '' : `AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())`;

    const rows = await db.any(
      `SELECT
        nr.*,
        u.name as created_by_name,
        u.email as created_by_email,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_users u ON u.id = nr.created_by
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1
         AND nr.status IN ${statusFilter}
         ${endDateFilter}
       ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number DESC`,
      [rfqId]
    );
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get next round number for a product
   */
  getNextRoundNumber: async (rfqId, rfqProductId) => {
    if (!rfqProductId) {
      throw new Error('rfq_product_id is required');
    }

    const result = await db.oneOrNone(
      `SELECT COALESCE(MAX(round_number), 0) + 1 as next_round
       FROM tbl_negotiation_rounds
       WHERE rfq_id = $1 AND rfq_product_id = $2`,
      [rfqId, rfqProductId]
    );
    return result ? parseInt(result.next_round) : 1;
  },

  /**
   * MAX(round_number) + 1 across the RFQ.
   *
   * ⚠️ NO LONGER USED FOR ALLOCATION, and must not be reintroduced. It is not
   * correct under the product definition: stored values are legacy per-product
   * numbers, so on RFQ 512 (138 rounds, highest stored value 4) it returns 5
   * where the true next position is 139. negotiationController.createRound now
   * calls getNextRoundPositionForRfq. Kept only because callers outside this
   * repo's hot path may still import it; prefer the position function.
   */
  getNextRoundNumberForRfq: async (rfqId) => {
    const result = await db.oneOrNone(
      `SELECT COALESCE(MAX(round_number), 0) + 1 as next_round
       FROM tbl_negotiation_rounds
       WHERE rfq_id = $1`,
      [rfqId]
    );
    return result ? parseInt(result.next_round) : 1;
  },

  /**
   * The RFQ-wide POSITION a new round is stored with, per the product
   * definition ("how many rounds were there in this RFQ"). WIRED UP at
   * negotiationController.createRound, inside its transaction.
   *
   * The three consumers that read the OLD meaning were all dealt with in the
   * same change:
   *
   *   dashboardModel — the savings baseline was
   *     `JOIN tbl_negotiation_rounds nr ON ... AND nr.round_number = 1`. All
   *     four sites now call getNegotiationParentSavings instead, which never
   *     reads round_number. (That join was already wrong on its own terms: it
   *     reached 274 of 441 production quote pairs and scored 243 of those at
   *     ₹0 by comparing a round with itself.)
   *   getSiblingRoundIds — re-keyed onto the item-wise cycle ordinal; see the
   *     note there, and the production proof that the grouping is unchanged.
   *   the legacy approval fallback below (`metadata.round_number`) — reachable
   *     only for instances that are BOTH keyed by rfq_product_id AND carry no
   *     metadata.round_id. Production has zero such rows: all 884 NEGOTIATION
   *     instances carry metadata.round_id, and every new one is created with
   *     entity_id = round.id as well (startApprovalForNegotiation), so new rows
   *     cannot reach that rung.
   *
   * Three more consumers need only CHRONOLOGICAL order, which RFQ-wide
   * numbering preserves — and it preserves it even across mixed data, because
   * a new position is COUNT(*) + 1 and no RFQ in production has a stored
   * round_number exceeding its own round count (checked: 0 of 124), so every
   * newly written value is strictly greater than every legacy value on the same
   * RFQ. Those are: getRoundDetail's `findPrior` (walks backwards from a line's
   * own number), its cumulative-set filter (`round_number <= current`), and the
   * `last_round` / `ORDER BY nr.round_number DESC` picks in rfqController and
   * quoteCompareViewModel.
   *
   * RACE: two concurrent creates on the same RFQ both read the same count and
   * both store the same number. There is no unique constraint on
   * (rfq_id, round_number) — production already holds 46 rounds sharing one
   * value — so this cannot error, it can only produce a duplicate stored value.
   * The row lock below removes it: taking a lock on the parent RFQ serialises
   * concurrent allocations within the caller's transaction. Pass the
   * transaction context, or the lock is released immediately and buys nothing.
   */
  getNextRoundPositionForRfq: async (rfqId, txContext = null) => {
    const conn = txContext || db;
    await conn.oneOrNone(`SELECT id FROM tbl_rfq WHERE id = $1 FOR UPDATE`, [Number(rfqId)]);
    const result = await conn.oneOrNone(
      `SELECT COUNT(*)::int + 1 AS next_position
         FROM tbl_negotiation_rounds
        WHERE rfq_id = $1`,
      [Number(rfqId)]
    );
    return result ? Number(result.next_position) : 1;
  },

  /**
   * Update round status
   */
  updateRoundStatus: async (roundId, status, additionalData = {}) => {
    const updates = ['status = $2'];
    const values = [roundId, status];
    let paramIndex = 3;

    if (additionalData.approved_at !== undefined) {
      updates.push(`approved_at = $${paramIndex}`);
      values.push(additionalData.approved_at);
      paramIndex++;
    }

    if (additionalData.published_at !== undefined) {
      updates.push(`published_at = $${paramIndex}`);
      values.push(additionalData.published_at);
      paramIndex++;
    }

    if (additionalData.closed_at !== undefined) {
      updates.push(`closed_at = $${paramIndex}`);
      values.push(additionalData.closed_at);
      paramIndex++;
    }

    if (additionalData.remarks !== undefined) {
      updates.push(`remarks = $${paramIndex}`);
      values.push(additionalData.remarks);
      paramIndex++;
    }

    updates.push('updated_at = NOW()');

    return db.one(
      `UPDATE tbl_negotiation_rounds
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      values
    );
  },

  // ============= ROUND APPROVALS =============

  /**
   * Create approval records for a round (for all committee members)
   */
  createRoundApprovals: async (roundId, approverUserIds) => {
    if (!approverUserIds || approverUserIds.length === 0) {
      return [];
    }

    const rows = approverUserIds.map(userId => ({
      negotiation_round_id: roundId,
      approver_user_id: userId,
      status: 'PENDING'
    }));

    const columnSet = new pgp.helpers.ColumnSet(
      ['negotiation_round_id', 'approver_user_id', 'status'],
      { table: 'tbl_negotiation_round_approvals' }
    );

    const query = pgp.helpers.insert(rows, columnSet) + ' RETURNING *';
    return db.any(query);
  },

  /**
   * Get all approvals for a round
   */
  getRoundApprovals: async (roundId) => {
    return db.any(
      `SELECT 
        nra.*,
        u.name as approver_name,
        u.email as approver_email
       FROM tbl_negotiation_round_approvals nra
       LEFT JOIN tbl_users u ON u.id = nra.approver_user_id
       WHERE nra.negotiation_round_id = $1
       ORDER BY nra.created_at ASC`,
      [roundId]
    );
  },

  /**
   * Get approval for a specific user and round
   */
  getUserApproval: async (roundId, userId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_approvals
       WHERE negotiation_round_id = $1 AND approver_user_id = $2`,
      [roundId, userId]
    );
  },

  /**
   * Update approval status
   */
  updateApproval: async (roundId, userId, status, remarks = null) => {
    return db.one(
      `UPDATE tbl_negotiation_round_approvals
       SET status = $3,
           remarks = $4,
           acted_at = NOW()
       WHERE negotiation_round_id = $1 AND approver_user_id = $2
       RETURNING *`,
      [roundId, userId, status, remarks]
    );
  },

  /**
   * Check if all approvals are complete
   */
  areAllApprovalsComplete: async (roundId) => {
    const result = await db.one(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_count
       FROM tbl_negotiation_round_approvals
       WHERE negotiation_round_id = $1`,
      [roundId]
    );

    return {
      allApproved: parseInt(result.total) > 0 && 
                   parseInt(result.approved_count) === parseInt(result.total),
      hasRejection: parseInt(result.rejected_count) > 0,
      total: parseInt(result.total),
      approved: parseInt(result.approved_count),
      rejected: parseInt(result.rejected_count)
    };
  },

  // ============= ROUND QUOTES =============

  /**
   * Create or update vendor quote for a round
   */
  upsertRoundQuote: async (quoteData) => {
    const {
      negotiation_round_id,
      vendor_id,
      rfq_product_id,
      quoted_price,
      previous_price
    } = quoteData;

    // Insert-only (one submission per round); conflict will throw
    return db.one(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price]
    );
  },

  /**
   * Get all quotes for a round
   */
  getRoundQuotes: async (roundId) => {
    return db.any(
      `SELECT 
        nrq.*,
        u.name as vendor_name,
        u.email as vendor_email,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.negotiation_round_id = $1
       ORDER BY nrq.submitted_at DESC`,
      [roundId]
    );
  },

  /**
   * Get quotes for a specific vendor in a round
   */
  getVendorRoundQuotes: async (roundId, vendorId) => {
    return db.any(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2`,
      [roundId, vendorId]
    );
  },

  /**
   * Check if round end date has passed
   */
  isRoundExpired: async (roundId) => {
    const result = await db.oneOrNone(
      `SELECT end_date, status
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId]
    );

    if (!result) return null;

    // Check both status and end_date as fallback in case cron hasn't fired yet
    const endDatePassed = parseAsUTC(result.end_date) <= new Date();
    const expired = (result.status !== 'ACTIVE' && result.status !== 'PENDING_APPROVAL') || endDatePassed;
    return {
      expired,
      endDate: result.end_date,
      status: result.status
    };
  },

  /**
   * Get vendor's negotiation quote status for a product (checks active rounds).
   * Only considers rounds where the vendor is assigned.
   */
  getVendorNegotiationStatus: async (rfqId, rfqProductId, vendorId) => {
    // Find the latest negotiation round assigned to this vendor covering this product
    const latestRound = await db.oneOrNone(
      `SELECT nr.*,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        pn_.product_names
       FROM tbl_negotiation_rounds nr
       LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       ${productNamesLateralSql('nr')}
       WHERE nr.rfq_id = $1
         AND ${coversProductSql('$2')}
         AND $3 = ANY(nr.vendor_ids)
       ORDER BY
         CASE WHEN nr.status = 'ACTIVE' THEN 0 ELSE 1 END,
         nr.round_number DESC,
         nr.created_at DESC
       LIMIT 1`,
      [rfqId, rfqProductId, vendorId]
    );

    if (!latestRound) {
      return {
        hasActiveRound: false,
        hasRound: false,
        round: null,
        vendorQuote: null,
        hasSubmittedQuote: false
      };
    }

    normalizeProductNames(latestRound);
    // Per-product negotiation fields for this vendor (multi rounds carry them
    // in products[]; legacy in vendor_approvals[].negotiation_fields).
    const negotiationFields = getVendorFieldsForProduct(latestRound, vendorId, rfqProductId);
    stripProductsForVendor(latestRound, vendorId);
    if (Array.isArray(latestRound.vendor_approvals)) {
      latestRound.vendor_approvals = latestRound.vendor_approvals.filter(
        (elem) => Number(elem?.vendor_id) === Number(vendorId)
      );
    }

    // Check if vendor has submitted a quote for this round + product (multi
    // rounds carry one quote row per covered product — without the product
    // filter oneOrNone would throw on >1 row).
    const vendorQuote = await db.oneOrNone(
      `SELECT * FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
      [latestRound.id, vendorId, rfqProductId]
    );

    // Check both status and end_date as fallback in case cron hasn't fired yet
    const endDatePassed = parseAsUTC(latestRound.end_date) <= new Date();
    const effectiveStatus = (latestRound.status === 'ACTIVE' && endDatePassed) ? 'ENDED' : latestRound.status;
    const isActive = effectiveStatus === 'ACTIVE';
    const isExpired = effectiveStatus === 'ENDED' || effectiveStatus === 'EXPIRED' || effectiveStatus === 'CLOSED' || effectiveStatus === 'COMPLETED';

    return {
      hasActiveRound: isActive,
      hasRound: true,
      round: {
        ...latestRound,
        negotiation_fields_for_product: negotiationFields,
        isExpired
      },
      vendorQuote: vendorQuote,
      hasSubmittedQuote: !!vendorQuote
    };
  },

  /**
   * Get latest rounds for an RFQ (per product) with vendor quote status.
   * Only returns rounds where the vendor is assigned via the vendor_ids array column.
   */
  getActiveRoundsWithVendorStatus: async (rfqId, vendorId) => {
    // Latest round per COVERED product assigned to this vendor. A multi
    // round (rfq_product_id NULL, products JSONB) is unnested into one row
    // per covered product so per-product lock/badge logic keeps working.
    const latestRounds = await db.any(
      `SELECT DISTINCT ON (cp.covered_product_id) nr.*,
        cp.covered_product_id,
        COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
        nrq.id as vendor_quote_id,
        nrq.quoted_price as vendor_quoted_price,
        nrq.submitted_at as vendor_submitted_at
       FROM tbl_negotiation_rounds nr
       CROSS JOIN LATERAL (
         SELECT nr.rfq_product_id AS covered_product_id
         WHERE nr.rfq_product_id IS NOT NULL
         UNION
         SELECT (p_->>'rfq_product_id')::int
         FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
         WHERE p_->>'rfq_product_id' IS NOT NULL
       ) cp
       LEFT JOIN tbl_rfq_products rp ON rp.id = cp.covered_product_id
       LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
       LEFT JOIN tbl_product P ON P.id = PV.product_id
       LEFT JOIN tbl_negotiation_round_quotes nrq
         ON nrq.negotiation_round_id = nr.id
         AND nrq.vendor_id = $2
         AND nrq.rfq_product_id = cp.covered_product_id
       WHERE nr.rfq_id = $1
         AND $2 = ANY(nr.vendor_ids)
       ORDER BY cp.covered_product_id,
         CASE WHEN nr.status = 'ACTIVE' THEN 0 ELSE 1 END,
         nr.round_number DESC,
         nr.created_at DESC`,
      [rfqId, vendorId]
    );

    return latestRounds.map(round => {
      // Check both status and end_date as fallback in case cron hasn't fired yet
      const endDatePassed = parseAsUTC(round.end_date) <= new Date();
      const effectiveStatus = (round.status === 'ACTIVE' && endDatePassed) ? 'ENDED' : round.status;
      const isExpired = effectiveStatus === 'ENDED' || effectiveStatus === 'EXPIRED' || effectiveStatus === 'CLOSED' || effectiveStatus === 'COMPLETED';
      const coveredProductId = round.covered_product_id ?? round.rfq_product_id;
      stripProductsForVendor(round, vendorId);
      if (Array.isArray(round.vendor_approvals)) {
        round.vendor_approvals = round.vendor_approvals.filter(
          (elem) => Number(elem?.vendor_id) === Number(vendorId)
        );
      }
      return {
        ...round,
        // Per-product identity for consumers that key by rfq_product_id.
        rfq_product_id: coveredProductId,
        negotiation_fields_for_product: getVendorFieldsForProduct(round, vendorId, coveredProductId),
        isExpired,
        isActive: effectiveStatus === 'ACTIVE',
        hasSubmittedQuote: !!round.vendor_quote_id
      };
    });
  },

  /**
   * Insert vendor quote for negotiation round (only insert, no update)
   */
  insertRoundQuote: async (quoteData) => {
    const {
      negotiation_round_id,
      vendor_id,
      rfq_product_id,
      quoted_price,
      previous_price
    } = quoteData;

    return db.one(
      `INSERT INTO tbl_negotiation_round_quotes
        (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price]
    );
  },

  // ============= QUOTE APPROVAL FUNCTIONS =============

  /**
   * Get regular quotes (from tbl_quotes) by IDs for approval
   */
  getRegularQuotesByIds: async (quoteIds, rfqId, rfqProductId) => {
    if (!quoteIds || quoteIds.length === 0) {
      return [];
    }
    return db.any(
      `SELECT
        q.id,
        q.id as quote_id,
        q.rfq_id,
        q.created_by as vendor_id,
        qi.unit_price as quoted_price,
        qi.total_price,
        qi.freight_price,
        qi.tax,
        qi.package_price,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_quotes q
       JOIN tbl_rfq_products rp ON rp.id = $3
       JOIN tbl_quote_items qi ON qi.quote_id = q.id AND qi.product_variant_id = rp.product_variant_id AND qi.variant = rp.variant
       LEFT JOIN tbl_users u ON u.id = q.created_by
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE q.id = ANY($1)
         AND q.rfq_id = $2
         AND COALESCE(q.is_regret, 0) != 1`,
      [quoteIds, rfqId, rfqProductId]
    );
  },

  /**
   * Get quotes by IDs with vendor details
   */
  getQuotesByIds: async (quoteIds) => {
    if (!quoteIds || quoteIds.length === 0) {
      return [];
    }
    return db.any(
      `SELECT
        nrq.*,
        nr.status as round_status,
        nr.round_number,
        nr.rfq_id,
        nr.end_date as round_end_date,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.id = ANY($1)`,
      [quoteIds]
    );
  },

  /**
   * Get all quotes for a product across all completed rounds
   */
  getCompletedRoundQuotesForProduct: async (rfqProductId) => {
    return db.any(
      `SELECT
        nrq.*,
        nr.round_number,
        nr.target_price,
        nr.rfq_id,
        u.name as vendor_name,
        u.organization_name,
        c.company_name
       FROM tbl_negotiation_round_quotes nrq
       JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
       LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nrq.rfq_product_id = $1
         AND nr.status = 'COMPLETED'
       ORDER BY nr.round_number DESC, nrq.quoted_price ASC`,
      [rfqProductId]
    );
  },

  /**
   * Check if quote already exists for a vendor in a round
   * @param {number} negotiation_round_id - Negotiation round ID
   * @param {number} vendor_id - Vendor ID
   * @param {number} rfq_product_id - RFQ Product ID
   * @param {Object} txContext - Optional transaction context
   * @returns {Promise<Object>} - Existing quote if found
   */
  getExistingRoundQuote: async (negotiation_round_id, vendor_id, rfq_product_id, txContext = null) => {
    const dbContext = txContext || db;
    return dbContext.oneOrNone(
      `SELECT id, submitted_at FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
      [negotiation_round_id, vendor_id, rfq_product_id]
    );
  },

  getApprovalBundleForRfq: async (rfqId, userId) => {
    // 1. Get all rfq_product_ids and round_ids for this RFQ
    // NEGOTIATION instances use round_id as entity_id; NEGOTIATION_QUOTE uses product_id
    const [products, rounds] = await Promise.all([
      db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = $1`, [rfqId]),
      db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqId])
    ]);
    const productIds = products.map(p => p.id);
    const roundIds = rounds.map(r => r.id);
    if (productIds.length === 0) {
      return { negotiation_instances: {}, negotiation_quote_instances: {}, rounds_history: [] };
    }

    // Lazy-heal stale APPROVED NEGOTIATION_QUOTE rows. handlePORejection
    // cancels these when the last vendor on a product is de-finalized, but
    // rejections that pre-date that fix left orphaned APPROVED rows behind,
    // causing the negotiation modal to keep showing products as "Approved"
    // after the PO that consumed the approval was rejected. Source of truth
    // for "is this approval still in force?" is whether ANY vendor still has
    // a finalization row for the product — if none do, the approval has been
    // rolled back. Heal in-place before assembling the bundle so the modal
    // sees the corrected status.
    await db.none(
      `UPDATE tbl_approval_instances
          SET status = 'CANCELLED', completed_at = NOW()
        WHERE entity_type = 'NEGOTIATION_QUOTE'
          AND status = 'APPROVED'
          AND entity_id IN (
            SELECT rp.id FROM tbl_rfq_products rp
            WHERE rp.rfq_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM tbl_quote_finalization qf
                WHERE qf.rfq_id = rp.rfq_id
                  AND qf.product_variant_id = rp.product_variant_id
                  AND qf.variant = rp.variant
              )
          )`,
      [rfqId]
    );

    // Combine both ID sets for querying (NEGOTIATION uses roundIds, NEGOTIATION_QUOTE uses productIds)
    const allEntityIds = [...new Set([...productIds, ...roundIds])];

    // 2. Fetch rounds history, approval instances, steps, approvers, and actions in parallel
    const [roundsHistory, instances, allSteps, allApprovers, allActions] = await Promise.all([
      // Full rounds history for the RFQ
      db.any(
        `SELECT nr.*, u.name as created_by_name, u.email as created_by_email,
                COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) as product_name,
                pn_.product_names
         FROM tbl_negotiation_rounds nr
         LEFT JOIN tbl_users u ON u.id = nr.created_by
         LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
         LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
         LEFT JOIN tbl_product P ON P.id = PV.product_id
         ${productNamesLateralSql('nr')}
         WHERE nr.rfq_id = $1
         ORDER BY nr.rfq_product_id NULLS LAST, nr.round_number ASC, nr.created_at DESC`,
        [rfqId]
      ),
      // All approval instances for NEGOTIATION (entity_id = round_id) and NEGOTIATION_QUOTE (entity_id = product_id)
      db.any(
        `SELECT
           i.*,
           p.entity_type as policy_entity_type,
           p.hospitality_company_id as policy_company_id,
           p.hotel_id as policy_hotel_id,
           p.department_id as policy_department_id,
           hc.name as company_name,
           hh.name as hotel_name,
           d.title as department_name,
           initiator.name as initiated_by_name,
           initiator.email as initiated_by_email,
           initiator.designation as initiated_by_designation
         FROM tbl_approval_instances i
         JOIN tbl_approval_policies p ON i.approval_policy_id = p.id
         LEFT JOIN tbl_hospitality_companies hc ON i.hospitality_company_id = hc.id
         LEFT JOIN tbl_hospitality_company_hotels hh ON i.hotel_id = hh.id
         LEFT JOIN tbl_department d ON i.department_id = d.id
         LEFT JOIN tbl_users initiator ON i.initiated_by = initiator.id
         WHERE i.entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
           AND i.entity_id = ANY($1::int[])
         ORDER BY i.created_at DESC`,
        [allEntityIds]
      ),
      // All steps for those instances
      db.any(
        `SELECT s.*, ps.approval_type, ps.approver_source_type, ps.approver_source_id
         FROM tbl_approval_instance_steps s
         LEFT JOIN tbl_approval_policy_steps ps ON s.policy_step_id = ps.id
         WHERE s.approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
             AND entity_id = ANY($1::int[])
         )
         ORDER BY s.step_order ASC`,
        [allEntityIds]
      ),
      // All approvers for those steps
      db.any(
        `SELECT
           sa.*,
           u.name as user_name,
           u.email as user_email,
           u.designation as user_designation,
           (
             SELECT d.title
             FROM tbl_user_department ud
             JOIN tbl_department d ON d.id = ud.department_id
             WHERE ud.user_id = u.id
             ORDER BY ud.id DESC
             LIMIT 1
           ) AS user_department
         FROM tbl_approval_step_approvers sa
         JOIN tbl_users u ON sa.approver_user_id = u.id
         WHERE sa.approval_instance_step_id IN (
           SELECT s.id FROM tbl_approval_instance_steps s
           WHERE s.approval_instance_id IN (
             SELECT id FROM tbl_approval_instances
             WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
               AND entity_id = ANY($1::int[])
           )
         )`,
        [allEntityIds]
      ),
      // All actions for those instances
      db.any(
        `SELECT
           a.id, a.approval_instance_id, a.approval_instance_step_id,
           a.approver_user_id, a.action, a.comment,
           a.created_at AT TIME ZONE 'UTC' AS created_at,
           u.name as actor_name,
           u.email as actor_email
         FROM tbl_approval_actions a
         JOIN tbl_users u ON a.approver_user_id = u.id
         WHERE a.approval_instance_id IN (
           SELECT id FROM tbl_approval_instances
           WHERE entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE')
             AND entity_id = ANY($1::int[])
         )
         ORDER BY a.created_at ASC`,
        [allEntityIds]
      )
    ]);

    // 3. Index steps and approvers by instance/step
    const stepsByInstance = {};
    for (const step of allSteps) {
      if (!stepsByInstance[step.approval_instance_id]) {
        stepsByInstance[step.approval_instance_id] = [];
      }
      stepsByInstance[step.approval_instance_id].push(step);
    }

    const approversByStep = {};
    for (const approver of allApprovers) {
      if (!approversByStep[approver.approval_instance_step_id]) {
        approversByStep[approver.approval_instance_step_id] = [];
      }
      approversByStep[approver.approval_instance_step_id].push(approver);
    }

    const actionsByInstance = {};
    for (const action of allActions) {
      if (!actionsByInstance[action.approval_instance_id]) {
        actionsByInstance[action.approval_instance_id] = [];
      }
      actionsByInstance[action.approval_instance_id].push(action);
    }

    // 4. Assemble full instance details (matching getApprovalInstanceDetails contract)
    const negotiationInstances = {};
    const negotiationQuoteInstances = {};

    for (const inst of instances) {
      const steps = (stepsByInstance[inst.id] || []).map(step => {
        const approvers = approversByStep[step.id] || [];
        return { ...step, approvers };
      });

      // Compute can_user_approve
      let canUserApprove = false;
      let userApprovalStepId = null;
      if (userId) {
        for (const step of steps) {
          if (step.step_order === inst.current_step && inst.status === 'PENDING') {
            const userApprover = step.approvers.find(
              ap => ap.approver_user_id === userId && ap.status === 'PENDING'
            );
            if (userApprover) {
              canUserApprove = true;
              userApprovalStepId = step.id;
              break;
            }
          }
        }
      }

      // Compute total_steps
      const totalSteps = steps.length;

      const assembled = {
        id: inst.id,
        entity_type: inst.entity_type,
        entity_id: inst.entity_id,
        status: inst.status,
        current_step: inst.current_step,
        total_steps: totalSteps,
        created_at: inst.created_at,
        completed_at: inst.completed_at,
        metadata: inst.metadata,
        initiated_by: {
          user_id: inst.initiated_by,
          name: inst.initiated_by_name,
          email: inst.initiated_by_email,
          designation: inst.initiated_by_designation
        },
        policy: {
          id: inst.approval_policy_id,
          hospitality_company_id: inst.policy_company_id,
          hotel_id: inst.policy_hotel_id,
          department_id: inst.policy_department_id
        },
        scope: {
          hospitality_company_id: inst.hospitality_company_id,
          company_name: inst.company_name,
          hotel_id: inst.hotel_id,
          hotel_name: inst.hotel_name,
          department_id: inst.department_id,
          department_name: inst.department_name
        },
        can_user_approve: canUserApprove,
        user_approval_step_id: userApprovalStepId,
        steps,
        action_history: actionsByInstance[inst.id] || []
      };

      // Group by entity_type and entity_id
      const targetMap = inst.entity_type === 'NEGOTIATION' ? negotiationInstances : negotiationQuoteInstances;
      const entityId = String(inst.entity_id);
      if (!targetMap[entityId]) {
        targetMap[entityId] = [];
      }
      targetMap[entityId].push(assembled);
    }

    // 5. Attach round-level approvals to rounds_history
    // New rounds use entity_id = round.id; old rounds used entity_id = rfq_product_id.
    // Try round.id first, then fall back to matching via metadata.round_id from the product bucket.
    const enrichedRounds = roundsHistory.map(round => {
      normalizeProductNames(round);
      let roundApprovals = negotiationInstances[String(round.id)] || [];
      if (roundApprovals.length === 0) {
        // Backward compat: old instances keyed by rfq_product_id
        const productBucket = negotiationInstances[String(round.rfq_product_id)] || [];
        roundApprovals = productBucket.filter(inst => {
          if (!inst.metadata) return false;
          // New instances: match by round_id in metadata
          if (inst.metadata.round_id) {
            return inst.metadata.round_id === round.id || inst.metadata.round_id === String(round.id);
          }
          // Old instances without round_id: match by round_number if available, otherwise include
          if (inst.metadata.round_number != null) {
            return inst.metadata.round_number === round.round_number || inst.metadata.round_number === String(round.round_number);
          }
          return true;
        });
      }
      return {
        ...round,
        approvals: roundApprovals.length > 0
          ? roundApprovals[0].steps?.flatMap(s => s.approvers.map(a => ({
              id: a.id,
              approver_name: a.user_name,
              approver_email: a.user_email,
              status: a.status,
              acted_at: a.acted_at,
              comment: a.comment
            })))
          : []
      };
    });

    return {
      negotiation_instances: negotiationInstances,
      negotiation_quote_instances: negotiationQuoteInstances,
      rounds_history: enrichedRounds
    };
  },

  // ============= ROUND EXPIRATION SCHEDULING =============

  /**
   * Get rounds that need rescheduling on server startup (future end_date, still pending or active)
   */
  getRoundsForReschedule: async () => {
    // LEFT JOIN on tbl_rfq_products: multi-product rounds have a NULL
    // rfq_product_id — an INNER JOIN would silently drop them from the
    // expiry scheduler and they would never end.
    const rows = await db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date > NOW()
    `);
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get rounds that expired during server downtime (past end_date, still pending or active)
   */
  getExpiredRoundsDuringDowntime: async () => {
    // LEFT JOIN — see getRoundsForReschedule note (multi rounds have NULL
    // rfq_product_id).
    const rows = await db.any(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
        AND nr.end_date <= NOW()
    `);
    rows.forEach(normalizeProductNames);
    return rows;
  },

  /**
   * Get the count of quotes submitted for a specific negotiation round
   */
  getQuoteCountForRound: async (roundId) => {
    const result = await db.one(
      `SELECT COUNT(*)::int AS count FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = $1`,
      [roundId]
    );
    return result.count;
  },

  /**
   * Get round by ID with RFQ and product info (for cron expiration handler)
   */
  getRoundWithContext: async (roundId) => {
    // LEFT JOIN — see getRoundsForReschedule note (multi rounds have NULL
    // rfq_product_id).
    const row = await db.oneOrNone(`
      SELECT nr.*, r.rfq_no, r.hotel_id,
             rp.product_variant_id,
             COALESCE(PV.name, P.name, 'Product #' || rp.product_variant_id) AS product_name,
             pn_.product_names
      FROM tbl_negotiation_rounds nr
      JOIN tbl_rfq r ON r.id = nr.rfq_id
      LEFT JOIN tbl_rfq_products rp ON rp.id = nr.rfq_product_id
      LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
      LEFT JOIN tbl_product P ON P.id = PV.product_id
      ${productNamesLateralSql('nr')}
      WHERE nr.id = $1
    `, [roundId]);
    return normalizeProductNames(row);
  },

  // ============= ROUND VENDOR ASSIGNMENT =============

  /**
   * Get vendor IDs currently assigned to PENDING_APPROVAL or ACTIVE rounds for a product.
   * Uses the vendor_ids integer array column on tbl_negotiation_rounds.
   */
  getVendorsInActiveRounds: async (rfqId, rfqProductId) => {
    const rows = await db.any(
      `SELECT nr.vendor_ids
       FROM tbl_negotiation_rounds nr
       WHERE nr.rfq_id = $1
         AND ${coversProductSql('$2')}
         AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
         AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
         AND nr.vendor_ids IS NOT NULL`,
      [rfqId, rfqProductId]
    );
    // Flatten all vendor_ids arrays into a unique set
    const allIds = new Set();
    for (const row of rows) {
      if (Array.isArray(row.vendor_ids)) {
        row.vendor_ids.forEach(id => allIds.add(id));
      }
    }
    return [...allIds];
  },

  /**
   * Check if a vendor is assigned to a specific round
   */
  isVendorAssignedToRound: async (roundId, vendorId) => {
    const result = await db.oneOrNone(
      `SELECT $2 = ANY(vendor_ids) AS assigned
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId, vendorId]
    );
    return result ? result.assigned : false;
  },

  /**
   * Get all vendors for a product with their active negotiation round status.
   * Returns every vendor with `in_active_round` flag and `active_round_number` so
   * the frontend can show which vendors are available vs already in a round.
   */
  getVendorsForProductWithStatus: async (rfqId, rfqProductId) => {
    return db.any(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.organization_name,
         c.company_name,
         CASE WHEN active_nr.id IS NOT NULL THEN true ELSE false END AS in_active_round,
         active_nr.id AS active_round_id,
         active_nr.round_number AS active_round_number,
         active_nr.status AS active_round_status
       FROM tbl_rfq_products rp
       JOIN tbl_rfq_product_vendors rpv
         ON rpv.rfq_id = rp.rfq_id
         AND rpv.product_variant_id = rp.product_variant_id
         AND rpv.variant = rp.variant
       JOIN tbl_users u ON u.id = rpv.user_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       LEFT JOIN LATERAL (
         SELECT nr.id, nr.round_number, nr.status
         FROM tbl_negotiation_rounds nr
         WHERE nr.rfq_id = $2
           AND ${coversProductSql('$1')}
           AND nr.status IN ('PENDING_APPROVAL', 'ACTIVE')
           AND (nr.status != 'ACTIVE' OR nr.end_date > NOW())
           AND u.id = ANY(nr.vendor_ids)
         ORDER BY nr.round_number DESC
         LIMIT 1
       ) active_nr ON true
       WHERE rp.id = $1
         AND rp.rfq_id = $2
       ORDER BY
         CASE WHEN active_nr.id IS NOT NULL THEN 1 ELSE 0 END,
         COALESCE(c.company_name, u.organization_name, u.name)`,
      [rfqProductId, rfqId]
    );
  },

  /**
   * Distinct vendors across every product of an RFQ — used to validate the
   * vendor list of an RFQ-level (no product) negotiation entry.
   */
  getVendorsForRfq: async (rfqId) => {
    return db.any(
      `SELECT DISTINCT u.id, u.name, u.email, u.organization_name, c.company_name
       FROM tbl_rfq_products rp
       JOIN tbl_rfq_product_vendors rpv
         ON rpv.rfq_id = rp.rfq_id
         AND rpv.product_variant_id = rp.product_variant_id
         AND rpv.variant = rp.variant
       JOIN tbl_users u ON u.id = rpv.user_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE rp.rfq_id = $1`,
      [rfqId]
    );
  },

  /**
   * Get vendor details for a specific round (from vendor_ids array column)
   */
  getVendorsForRound: async (roundId) => {
    return db.any(
      `SELECT u.id, u.name, u.email, u.organization_name, c.company_name
       FROM tbl_negotiation_rounds nr
       JOIN LATERAL unnest(nr.vendor_ids) AS vid ON true
       JOIN tbl_users u ON u.id = vid
       LEFT JOIN tbl_company c ON c.id = u.company_id
       WHERE nr.id = $1
         AND nr.vendor_ids IS NOT NULL
       ORDER BY COALESCE(c.company_name, u.organization_name, u.name)`,
      [roundId]
    );
  },

  // ============= VENDOR-LEVEL APPROVAL =============

  /**
   * Update a single vendor's approval status within a round's vendor_approvals JSONB.
   * Returns the updated round row.
   */
  updateVendorApprovalStatus: async (roundId, vendorId, status, remarks, actedBy, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           CASE
             WHEN (elem->>'vendor_id')::int = $2
             -- Merge instead of rebuild so extra keys on the entry (e.g.
             -- legacy negotiation_fields) survive the status update.
             THEN elem || jsonb_build_object(
               'status', $3::text,
               'remarks', $4::text,
               'acted_by', $5::int,
               'acted_at', NOW()::text
             )
             ELSE elem
           END
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, vendorId, status, remarks || null, actedBy]
    );
  },

  /**
   * Bulk update all vendor approval statuses in a round.
   * Used when the entire round is approved/rejected at the round level.
   */
  updateAllVendorsStatus: async (roundId, status, remarks, actedBy, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           elem || jsonb_build_object(
             'status', $2::text,
             'remarks', $3::text,
             'acted_by', $4::int,
             'acted_at', NOW()::text
           )
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, status, remarks || null, actedBy]
    );
  },

  /**
   * Check if all vendors in a round have been approved.
   */
  areAllVendorsApproved: async (roundId, txContext = null) => {
    const result = await (txContext || db).one(
      `SELECT
         (jsonb_array_length(vendor_approvals) > 0)
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(vendor_approvals) AS elem
           WHERE elem->>'status' != 'APPROVED'
         ) AS all_approved
       FROM tbl_negotiation_rounds
       WHERE id = $1`,
      [roundId]
    );
    return result.all_approved;
  },

  /**
   * Reset a rejected vendor back to PENDING for re-evaluation.
   */
  resubmitRoundVendor: async (roundId, vendorId, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_negotiation_rounds
       SET vendor_approvals = (
         SELECT jsonb_agg(
           CASE
             WHEN (elem->>'vendor_id')::int = $2
             -- Merge instead of rebuild so extra keys on the entry (e.g.
             -- legacy negotiation_fields) survive the reset.
             THEN elem || jsonb_build_object(
               'status', 'PENDING',
               'remarks', null,
               'acted_by', null,
               'acted_at', null
             )
             ELSE elem
           END
         )
         FROM jsonb_array_elements(vendor_approvals) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [roundId, vendorId]
    );
  }
};

export default negotiationModel;

