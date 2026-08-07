/**
 * Notification deep-link registry — the single source of truth for every URL
 * that a notification (in-app, email, or web-push) can point a user at.
 *
 * Why this file exists
 * --------------------
 * Before it, six independent URL builders had drifted apart and several of the
 * resulting links were dead. Audited 2026-08-07 against the live `pages/` tree:
 *
 *   - `/dashboard/buyer/rfq-details?id=`        → hard 404 (no such page)
 *   - `/dashboard/buyer/arc-committee?rfq_id=`  → hard 404 (ARC v1, deleted)
 *   - `/dashboard/vendor/rate-contracts/requests/<id>` → 404 (`requests` is a
 *     leaf page, not a directory, so the extra segment matches nothing)
 *   - `/dashboard/vendor/rate-contracts/pending-acceptance` → 404
 *   - `/dashboard`                              → renders "Coming Soon"
 *   - `/dashboard/vendor/order-book?rfq=&po=`   → redirect stub that DROPS the
 *     query string, so the vendor lands on an unfiltered list
 *   - `/dashboard/buyer/quote-compare`          → superseded by quote-comparison
 *   - `/dashboard/buyer/purchase-order?rfq=`    → superseded by purchase-orders/:id
 *
 * Rules
 * -----
 * 1. Every builder returns a ROOT-RELATIVE path. The frontend resolves it
 *    against the current origin, so the same row works on localhost, staging
 *    and production. Absolute URLs baked at write time send a staging user to
 *    production. Use `toAbsoluteUrl()` only when rendering an email.
 * 2. A builder returns `null` when it cannot name the right record. Callers
 *    fall back to the audience's home (`buyerHome()` / `vendorHome()`), never
 *    to a wrong record.
 * 3. ID SEMANTICS ARE NOT INTERCHANGEABLE — see `arcVendorContract` below.
 */

const enc = (v) => encodeURIComponent(String(v));

/** Append only the query params that have a value. */
const withQuery = (path, params = {}) => {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
};

const isPositiveId = (v) =>
  v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

// ─── Landing pages ───────────────────────────────────────────────────────────
// NOT `/dashboard` — that route renders a static "Coming Soon" placeholder.
export const buyerHome  = () => '/dashboard/buyer';
export const vendorHome = () => '/dashboard/vendor';
export const home = (role) => (role === 'vendor' ? vendorHome() : buyerHome());

// ─── RFQ ─────────────────────────────────────────────────────────────────────

/**
 * Buyer RFQ workspace. This is the redesigned single-page lifecycle view that
 * owns the stage timeline and the approval decision card.
 *
 * @param {number} rfqId
 * @param {object} [opts]
 * @param {'overview'|'technical'|'negotiation-award'|'purchase-order'} [opts.stage]
 *        Validated by the page against the server-computed lifecycle; an
 *        unknown value falls back to `default_stage`, so this is safe.
 * @param {boolean} [opts.focusApproval] scrolls the approval card into view.
 */
export const buyerRfqDetail = (rfqId, { stage, focusApproval } = {}) => {
  if (!isPositiveId(rfqId)) return null;
  return withQuery('/dashboard/buyer/rfq-management-details', {
    type: 'buyer-view',
    id: rfqId,
    stage,
    focus: focusApproval ? 'approval' : undefined,
  });
};

export const buyerRfqList = ({ tab } = {}) =>
  withQuery('/dashboard/buyer/rfq-management', { tab });

/** Vendor inquiry workspace. Reads `id` — passing `rfq` renders a blank page. */
export const vendorRfqDetail = (rfqId) =>
  isPositiveId(rfqId)
    ? withQuery('/dashboard/vendor/inquiries-details', { id: rfqId })
    : null;

export const vendorRfqList = () => '/dashboard/vendor/inquiries-received';

// ─── Quote comparison ────────────────────────────────────────────────────────

/**
 * Current comparison surface (`quoteComparison/QuoteComparison.js`), which is
 * also what the RFQ workspace embeds. The legacy `/quote-compare` page still
 * exists but is superseded — do not link to it.
 */
export const buyerQuoteComparison = (rfqId, { rfqProductId, focusApproval } = {}) => {
  if (!isPositiveId(rfqId)) return null;
  return withQuery('/dashboard/buyer/quote-comparison', {
    rfq: rfqId,
    rfq_product_id: rfqProductId,
    focus: focusApproval ? 'approval' : undefined,
  });
};

// ─── Technical evaluation ────────────────────────────────────────────────────

/**
 * Technical-evaluation approvals are actioned on the RFQ workspace's technical
 * stage, not on the standalone evaluation list (which ignores `rfq_id` and
 * would land the approver on an unfiltered list).
 */
export const buyerTechnicalEvaluation = (rfqId) =>
  buyerRfqDetail(rfqId, { stage: 'technical', focusApproval: true });

// ─── Purchase orders ─────────────────────────────────────────────────────────

/** Current buyer PO detail. Fetches by PO id — no rfq param needed. */
export const buyerPoDetail = (poId) =>
  isPositiveId(poId) ? `/dashboard/buyer/purchase-orders/${enc(poId)}` : null;

export const buyerPoList = () => '/dashboard/buyer/purchase-orders';

/**
 * PO approvals live inside the PO detail page. When the PO id is unknown, fall
 * back to the RFQ workspace's purchase-order stage rather than the legacy
 * `/purchase-order?rfq=` page.
 */
export const buyerPoApproval = (poId, rfqId) =>
  buyerPoDetail(poId)
  || buyerRfqDetail(rfqId, { stage: 'purchase-order', focusApproval: true })
  || buyerPoList();

/** Current vendor PO detail. `/dashboard/vendor/order-book` is a retired stub. */
export const vendorPoDetail = (poId) =>
  isPositiveId(poId) ? `/dashboard/vendor/purchase-orders/${enc(poId)}` : null;

export const vendorPoList = () => '/dashboard/vendor/purchase-orders/orders';

// ─── Rate contracts (ARC) ────────────────────────────────────────────────────

/**
 * Buyer ARC workspace — keyed on the **ARC id** (`tbl_arc.id`).
 *
 * @param {'overview'|'technical'|'commercial'|'awarding'|'active'} [stage]
 */
export const buyerArcDetail = (arcId, { stage } = {}) =>
  isPositiveId(arcId)
    ? withQuery(`/dashboard/buyer/rate-contracts/${enc(arcId)}`, { stage })
    : null;

export const buyerArcList = () => '/dashboard/buyer/rate-contracts';

/**
 * Vendor awarded-contract detail — keyed on the **arc_contract id**
 * (`tbl_arc_contract.id`), NOT the ARC id.
 *
 * This distinction is the single most damaging bug this registry replaces. The
 * page calls `GET /v1/arc-v2/vendor/contracts/:contractId`, which loads
 * `tbl_arc_contract` by primary key and then enforces
 * `contract.vendor_id === req.user.id`. Passing an ARC id therefore resolves an
 * unrelated contract row and the vendor is met with 403 "Not the contracted
 * vendor". Measured on staging: 14 of 19 vendor ARC links did exactly that.
 */
export const arcVendorContract = (contractId) =>
  isPositiveId(contractId)
    ? `/dashboard/vendor/rate-contracts/${enc(contractId)}`
    : null;

/** Vendor signing screen for an awarded contract — also arc_contract id. */
export const arcVendorContractAccept = (contractId) =>
  isPositiveId(contractId)
    ? `/dashboard/vendor/rate-contracts/${enc(contractId)}/accept`
    : null;

/**
 * Vendor quote wizard — keyed on the **ARC id**, because it is reached before
 * any contract exists (`GET /v1/arc-v2/vendor/requests/:arcId`).
 */
export const arcVendorQuote = (arcId) =>
  isPositiveId(arcId)
    ? `/dashboard/vendor/rate-contracts/${enc(arcId)}/quote`
    : null;

/**
 * Vendor's open-requests list.
 * `requests` is a leaf page: `/rate-contracts/requests/<id>` matches no route.
 * @param {'submitted'|'awaiting-sign'|'active'} [tab]
 */
export const arcVendorRequests = ({ tab } = {}) =>
  withQuery('/dashboard/vendor/rate-contracts/requests', { tab });

export const arcVendorAmendments = () => '/dashboard/vendor/rate-contracts/amendments';

// ─── Material requisitions ───────────────────────────────────────────────────

export const buyerMrDetail = (mrId) =>
  isPositiveId(mrId) ? `/dashboard/buyer/material-requisitions/${enc(mrId)}` : null;

/** @param {'all'|'for_me'|'drafts'|'pending'|'approved'|'po_released'|'cancelled'} [tab] */
export const buyerMrList = ({ tab } = {}) =>
  withQuery('/dashboard/buyer/material-requisitions/all', { tab });

// ─── Negotiation (RFQ) ───────────────────────────────────────────────────────

export const buyerNegotiationRound = (rfqId) =>
  isPositiveId(rfqId) ? `/dashboard/buyer/negotiation/${enc(rfqId)}` : null;

export const buyerNegotiationApprove = (rfqId) =>
  isPositiveId(rfqId) ? `/dashboard/buyer/negotiation/${enc(rfqId)}/approve` : null;

// ─── Clarifications / queries ────────────────────────────────────────────────

/**
 * One page serves both sides; the role is a query param. Vendor code links to
 * the buyer path with `role=vendor` — `/dashboard/vendor/query` is an
 * unreferenced duplicate.
 */
export const queryThread = (rfqId, role) =>
  isPositiveId(rfqId)
    ? withQuery('/dashboard/buyer/query', {
        rfq_id: rfqId,
        role: role === 'vendor' ? 'vendor' : 'buyer',
      })
    : null;

export const buyerClarifications = (rfqId) =>
  isPositiveId(rfqId)
    ? withQuery('/dashboard/buyer/clarification-management', { rfq_id: rfqId })
    : null;

// ─── Account / subscription ──────────────────────────────────────────────────

export const vendorSubscription = () => '/dashboard/vendor/subscription';
export const vendorProfile      = () => '/dashboard/vendor/editprofile';
export const buyerProfile       = () => '/dashboard/buyer/editprofile';

// ─── Approval-engine entity routing ──────────────────────────────────────────

/**
 * Human-readable labels for every approval entity type that can reach a user.
 * Without an entry here the raw enum leaks into the notification title, e.g.
 * "Action required: Approve ARC_PUBLISH #ID-12".
 */
export const ENTITY_LABELS = Object.freeze({
  RFQ:               'RFQ',
  TENDER:            'Tender',
  TECHNICAL:         'Technical Evaluation',
  NEGOTIATION:       'Negotiation',
  NEGOTIATION_QUOTE: 'Vendor Finalization',
  PO:                'Purchase Order',
  MR:                'Material Requisition',
  ARC:               'Rate Contract',
  ARC_PUBLISH:       'Rate Contract Publication',
  ARC_TECH:          'Rate Contract Technical Evaluation',
  ARC_COMMERCIAL:    'Rate Contract Commercial Evaluation',
  ARC_COMMITTEE:     'Rate Contract Committee Decision',
  ARC_NEGOTIATION:   'Rate Contract Negotiation',
  ARC_AMENDMENT:     'Rate Contract Amendment',
});

export const entityLabel = (entityType) =>
  ENTITY_LABELS[entityType] || 'Approval';

/**
 * Where an approver goes to action a pending approval step.
 *
 * Mirrors the frontend's own routing table
 * (`hooks/usePendingApprovalIndicators.js`) but deep-links to the record rather
 * than the module index wherever the id allows it.
 *
 * Returns `null` when the destination cannot be named — the caller falls back
 * to the approver's home rather than to a wrong record.
 *
 * @param {string} entityType
 * @param {number} entityId
 * @param {object} ctx  extra identifiers carried on the approval instance
 *                      (rfq_id, po_id, arc_id, mr_id, round_id)
 * @param {object} [opts]
 * @param {boolean} [opts.idIsRfq] entityId is itself the RFQ id
 */
export const approvalActionUrl = (entityType, entityId, ctx = {}, opts = {}) => {
  const rfqId = ctx?.rfq_id;
  const arcId = ctx?.arc_id || entityId;

  switch (entityType) {
    case 'RFQ':
    case 'TENDER':
      return buyerRfqDetail(rfqId || entityId, { stage: 'overview', focusApproval: true });

    case 'TECHNICAL':
      return buyerTechnicalEvaluation(rfqId || entityId);

    case 'NEGOTIATION':
      return buyerQuoteComparison(rfqId || entityId, { focusApproval: true });

    case 'NEGOTIATION_QUOTE': {
      // Callers default ctx.rfq_id to `metadata.rfq_id || entity_id`, so an
      // rfq_id equal to the entity id means metadata.rfq_id was missing and all
      // we hold is a product id. Refuse rather than emit `?rfq=<product id>`,
      // which would drop the approver into a different RFQ entirely.
      if (!rfqId) return null;
      if (!opts.idIsRfq && String(rfqId) === String(entityId)) return null;
      // The Approve control sits on one product card deep in the comparison
      // matrix; carry the product so the approver is not left hunting.
      return buyerQuoteComparison(rfqId, {
        rfqProductId: opts.idIsRfq ? undefined : entityId,
        focusApproval: true,
      });
    }

    case 'PO':
      return buyerPoApproval(ctx?.po_id, rfqId || entityId);

    case 'MR':
      return buyerMrDetail(ctx?.mr_id || entityId) || buyerMrList({ tab: 'for_me' });

    // ── ARC family ──────────────────────────────────────────────────────────
    // Every one of these previously fell through to a bare `/dashboard`.
    case 'ARC':
    case 'ARC_PUBLISH':
      return buyerArcDetail(arcId, { stage: 'overview' });

    case 'ARC_TECH':
      return buyerArcDetail(arcId, { stage: 'technical' });

    case 'ARC_COMMERCIAL':
      return buyerArcDetail(arcId, { stage: 'commercial' });

    case 'ARC_COMMITTEE':
      return buyerArcDetail(arcId, { stage: 'awarding' });

    case 'ARC_NEGOTIATION':
      // The round-level approve screen when we know the round, else the ARC.
      return isPositiveId(ctx?.round_id) && isPositiveId(ctx?.arc_id)
        ? `/dashboard/buyer/rate-contracts/${enc(ctx.arc_id)}/negotiation/${enc(ctx.round_id)}/approve`
        : buyerArcDetail(arcId, { stage: 'commercial' });

    case 'ARC_AMENDMENT':
      return buyerArcDetail(ctx?.arc_id, { stage: 'active' }) || buyerArcList();

    default:
      return null;
  }
};

// ─── Absolutiser (emails only) ───────────────────────────────────────────────

/**
 * Emails are read outside the app, so their links must be absolute. In-app
 * `action_url` values must stay relative — see rule 1 at the top of this file.
 *
 * Falls back to the production host only when FRONT_END_WEBSITE is unset, so a
 * missing env var can never produce the literal string "undefined/dashboard/…"
 * (which is what several call sites used to emit).
 */
export const toAbsoluteUrl = (path) => {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = (process.env.FRONT_END_WEBSITE || 'https://hospitality.letsworkwise.com')
    .replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
};

export default {
  buyerHome,
  vendorHome,
  home,
  buyerRfqDetail,
  buyerRfqList,
  vendorRfqDetail,
  vendorRfqList,
  buyerQuoteComparison,
  buyerTechnicalEvaluation,
  buyerPoDetail,
  buyerPoList,
  buyerPoApproval,
  vendorPoDetail,
  vendorPoList,
  buyerArcDetail,
  buyerArcList,
  arcVendorContract,
  arcVendorContractAccept,
  arcVendorQuote,
  arcVendorRequests,
  arcVendorAmendments,
  buyerMrDetail,
  buyerMrList,
  buyerNegotiationRound,
  buyerNegotiationApprove,
  queryThread,
  buyerClarifications,
  vendorSubscription,
  vendorProfile,
  buyerProfile,
  ENTITY_LABELS,
  entityLabel,
  approvalActionUrl,
  toAbsoluteUrl,
};
