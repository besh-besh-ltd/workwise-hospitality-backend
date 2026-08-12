// negotiationRoundDetailController.js — the "Negotiation Command Center".
//
// GET /api/v1/negotiation/rounds/:id/detail?scope=round|cycle
//
// One request answers everything a buyer needs when a vendor calls about a
// negotiation: where the round stands, what was asked for, what came back, who
// answered and who went quiet, when it closes, where the approval sits, how the
// numbers roll up across the cycle and across every round so far — and which
// actions this particular caller may take.
//
// Deliberately kept OUT of negotiationController.js: that file is 2900 lines of
// write-path workflow, and this is a pure read surface with its own maths.
//
// SECURITY ORDER OF OPERATIONS (do not reorder):
//   1. RBAC read matrix (negotiationModel.userCanReadRound) — BEFORE any state
//      or visibility check, so an out-of-scope caller learns nothing about the
//      round's existence.
//   2. Existence.
//   3. Quote-visibility lock. When negotiated prices are still sealed (the RFQ's
//      IST bid deadline has not passed) the payload keeps round metadata,
//      targets and vendor names but drops EVERY price field and all totals.

import { logError } from '../../helper/common.js';
import negotiationModel, { NEG_STATE } from '../../models/negotiationModel.js';
import rfqModel from '../../models/rfqModel.js';
import { buildQuoteVisibilityMeta } from '../../helper/quoteVisibility.js';

// Server-derived id for the RBAC read matrix. NEVER read from body/query/
// headers. null for super admins (user_type 8), which the model treats as
// "no matrix filter". Mirrors readScopeUserId in negotiationController.js,
// which is module-private there.
const readScopeUserId = (req) =>
  Number(req.user?.user_type) === 8 ? null : (req.user?.id ?? null);

const VALID_SCOPES = new Set(['round', 'cycle']);

// Fields on a line that are safe to expose while prices are sealed. Built as a
// WHITELIST (rather than deleting known price keys) so a field added to the
// line shape later cannot silently leak through the locked path.
const LOCKED_LINE_FIELDS = [
  'line_id',
  'round_id',
  'round_number',
  'round_status',
  'is_rfq_level',
  'rfq_product_id',
  'arc_item_id',
  'product_variant_id',
  'product_name',
  'vendor_id',
  'vendor_name',
  'vendor_contact_name',
  'vendor_email',
  'vendor_mobile',
  'quantity',
  'uom',
  'amount_basis',
  'target_unit',
  'target_mode',
  'has_numeric_target',
  'has_unit_target',
  'numeric_targets',
  'text_targets',
  'responded',
  'responded_at',
  'vendor_approval_status',
  'vendor_approval_remarks',
  'vendor_approval_acted_at',
  'vendor_approval_acted_by',
];

const LOCKED_VENDOR_FIELDS = [
  'vendor_id',
  'vendor_name',
  'vendor_contact_name',
  'vendor_email',
  'vendor_mobile',
  'approval_status',
  'approval_remarks',
  'approval_acted_at',
  'lines',
  'lines_responded',
  'first_responded_at',
  'last_responded_at',
  'has_responded',
];

const LOCKED_HISTORY_FIELDS = [
  'round_id',
  'round_number',
  'status',
  'state',
  'state_label',
  'is_current',
  'end_date',
  'closed_at',
  'created_at',
  'line_count',
  'responded_count',
  'vendors_total',
];

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
};

/**
 * What may this caller do to this round right now?
 *
 * Derived server-side from round state + the caller's negotiation.* grants in
 * the round's own scope, so the page never has to guess (and never renders a
 * button the API would refuse).
 */
export const deriveActions = ({
  state, permissions, locked, vendorApprovalSummary, hasResponses,
  viewerUserId = null, createdByUserId = null,
}) => {
  const p = permissions || {};
  const s = String(state || '');

  // Before vendors are involved at all — the approval gate.
  const preApproval = s === NEG_STATE.AWAITING_APPROVAL;
  // The response window is genuinely still open.
  const windowOpen = s === NEG_STATE.OPEN_WITH_VENDORS;

  // A follow-up round is BLOCKED only while this one is still in flight.
  //
  // The old rule was `!pre && !live && !terminal` with live = ACTIVE |
  // AWAITING_DECISION. Since ENDED maps to AWAITING_DECISION, that counted
  // every one of the 622 ENDED rounds as "live" — so only the 5 COMPLETED
  // rounds in all of production could spawn a follow-up. EXPIRED (171) and
  // CANCELLED (88) were blocked too, and opening a fresh round is precisely
  // the recovery from both: a lapsed round never reached a vendor, and a
  // cancelled one was withdrawn on purpose.
  const canCreateNext = !preApproval && !windowOpen;

  const summary = vendorApprovalSummary || {};
  const anyPending = Number(summary.pending || 0) > 0;
  const anyRejected = Number(summary.rejected || 0) > 0;

  // The author's own escape hatch, and the ONLY action here that is not gated
  // on a permission. `can_reject` requires negotiation.approve, which the buyer
  // who opened the round frequently does not hold — creating a round needs only
  // acl([2, 8]). That asymmetry is what left buyers with no way to clear a
  // round nobody approved: 179 production rounds died waiting, 107 of them
  // blocking their own replacement for over 12 hours.
  //
  // Authorship is checked, not permission — POST /rounds/:id/withdraw enforces
  // exactly the same rule, so this can never render a button the API refuses.
  const isCreator =
    viewerUserId != null && createdByUserId != null &&
    Number(viewerUserId) === Number(createdByUserId);

  return {
    can_approve: !!p.approve && preApproval,
    can_reject: !!p.approve && preApproval,
    can_withdraw: preApproval && isCreator,
    can_approve_vendor: !!p.approve && preApproval && anyPending,
    can_reject_vendor: !!p.approve && preApproval && anyPending,
    can_resubmit_vendor: !!p.approve && preApproval && anyRejected,
    // Closing the window early, or closing out a window that has run down but
    // has not yet been dispositioned. A concluded round has nothing to close.
    can_close:
      !!p.update &&
      [NEG_STATE.OPEN_WITH_VENDORS, NEG_STATE.READY_FOR_DECISION, NEG_STATE.NO_VENDOR_RESPONSE].includes(s),
    can_create_next_round: !!p.create && canCreateNext,
    can_view_quotes: !!p.read && !locked,
    can_submit_quotes_for_approval:
      !!p.update &&
      [NEG_STATE.READY_FOR_DECISION, NEG_STATE.CONCLUDED].includes(s) &&
      !locked &&
      !!hasResponses,
  };
};

/**
 * Strip every price and all aggregates from an assembled payload, keeping the
 * metadata and the targets. Vendor names stay — the negotiation listing already
 * shows them before the deadline, so hiding them here would be theatre.
 */
export const redactForLockedVisibility = (data) => ({
  ...data,
  prices_hidden: true,
  lines: data.lines.map((l) => pick(l, LOCKED_LINE_FIELDS)),
  vendors: data.vendors.map((v) => pick(v, LOCKED_VENDOR_FIELDS)),
  totals: null,
  cumulative: null,
  // The round-history table carries per-round money too — same whitelist
  // discipline as the lines, so a money field added later cannot leak.
  history: (data.history || []).map((h) => pick(h, LOCKED_HISTORY_FIELDS)),
});

const negotiationRoundDetailController = {
  /**
   * GET /negotiation/rounds/:id/detail?scope=round|cycle
   */
  getRoundDetail: async (req, res) => {
    try {
      const roundId = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(roundId) || roundId <= 0) {
        return res.status(400).json({ status: 2, message: 'A numeric round id is required' });
      }

      const scope = req.query.scope == null || req.query.scope === '' ? 'round' : String(req.query.scope);
      if (!VALID_SCOPES.has(scope)) {
        return res.status(400).json({
          status: 2,
          message: "scope must be either 'round' or 'cycle'",
        });
      }

      const scopeUserId = readScopeUserId(req);

      // (1) SCOPE FIRST. Runs before existence and before the visibility check
      //     so an out-of-scope id and an unknown id are indistinguishable.
      const allowed = await negotiationModel.userCanReadRound(scopeUserId, roundId);
      if (!allowed) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round',
        });
      }

      // (2) Existence — the model re-applies the same matrix per row.
      const detail = await negotiationModel.getRoundDetail({
        roundId,
        scope,
        scopeUserId,
        viewerUserId: req.user?.id ?? null,
      });
      if (!detail) {
        return res.status(404).json({ status: 2, message: 'Negotiation round not found' });
      }

      // (3) Quote visibility. Negotiated prices stay sealed until the RFQ's IST
      //     quote deadline passes. ARC rounds have no bid_end_date and are not
      //     gated by this rule.
      let quoteVisibility = { locked: false, timezone: 'Asia/Kolkata', deadline: null, remainingMs: 0, message: null };
      if (detail.parent.source_type === 'RFQ' && detail.parent.rfq_id != null) {
        // getRfqDetailsById resolves a single row (data[0]), not an array.
        quoteVisibility = buildQuoteVisibilityMeta(await rfqModel.getRfqDetailsById(detail.parent.rfq_id));
      }

      // Both underscore keys are internal: `_effective_status` is the legacy
      // raw+deadline status and is dropped entirely; `_state` is the derived
      // seven-state key the action gates read. `round.state` on the payload is
      // the copy the client sees.
      const { _effective_status: _dropped, _state: state, ...payload } = detail;

      // Actions are derived with the lock already accounted for, so the
      // redaction below only ever strips data — it can never widen what the
      // caller is told they may do.
      const body = {
        ...payload,
        quote_visibility: quoteVisibility,
        prices_hidden: false,
        actions: deriveActions({
          state,
          permissions: payload.permissions,
          locked: quoteVisibility.locked,
          vendorApprovalSummary: payload.approval?.vendor_approvals ?? null,
          hasResponses: payload.totals?.lines_responded > 0,
          viewerUserId: req.user?.id ?? null,
          // `created_by` is an object {user_id, name, …}; the flat column is
          // the fallback shape.
          createdByUserId:
            payload.round?.created_by?.user_id ??
            payload.round?.created_by ??
            null,
        }),
      };

      return res
        .status(200)
        .json({ status: 1, data: quoteVisibility.locked ? redactForLockedVisibility(body) : body });
    } catch (error) {
      logError(error);
      return res.status(error.statusCode || 400).json({
        status: 3,
        message: error.message || 'Unable to load the negotiation round',
      });
    }
  },
};

export default negotiationRoundDetailController;
