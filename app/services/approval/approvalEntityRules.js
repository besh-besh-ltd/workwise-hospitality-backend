// Entity-specific rules of the shared approval engine.
//
// The engine (app/models/generalModel.js createApprovalInstance, and the
// mid-flight paths in app/services/approvalPropagationService.js) is shared by
// RFQ / PO / ARC / MR / TECHNICAL / … Every rule here is keyed by entity type
// and applies ONLY to the types listed in its set, so adding a type to a set is
// the one, reviewable act that changes engine behaviour for it. Today both sets
// hold exactly 'PR' (purchase requisitions, spec §7).
//
// No imports on purpose: this module is loaded by the model AND the services
// that the model itself imports, so it must stay a leaf.

// Entity types whose initiator may never approve their own instance (spec §7 SoD).
export const SOD_EXCLUDE_INITIATOR = new Set(['PR']);
// Entity types whose policy steps honour min_amount.
export const AMOUNT_GATED = new Set(['PR']);
export const excludesInitiator = (entityType) => SOD_EXCLUDE_INITIATOR.has(String(entityType || '').toUpperCase());
// A step applies when it has no threshold, the entity is not amount-gated, or amount >= min_amount.
// Compare as fixed-point paise (integers) to avoid float error: toPaise('1250000.75') === 125000075n.
export function toPaise(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid money value: ${s}`);
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)) * (s.startsWith('-') ? -1n : 1n);
}
export function stepAppliesAtAmount(entityType, step, amount) {
  if (!AMOUNT_GATED.has(String(entityType || '').toUpperCase())) return true;
  if (step.min_amount === null || step.min_amount === undefined) return true;
  if (amount === null || amount === undefined) return true; // amount unknown → never silently drop a step
  return toPaise(amount) >= toPaise(step.min_amount);
}
// Remove the initiator from a resolved approver id list when SoD applies.
export function filterInitiator(entityType, approverIds, initiatedBy) {
  if (!excludesInitiator(entityType) || !initiatedBy) return approverIds;
  return approverIds.filter(id => Number(id) !== Number(initiatedBy));
}

// ── Helpers built on the rules above ────────────────────────────────────────

/** Paise (BigInt) → canonical 2-decimal string ('50000.00'); null stays null. */
export function formatPaise(p) {
  if (p === null || p === undefined) return null;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Any accepted money input → canonical 2-decimal string, or null. Throws like toPaise. */
export const toMoneyString = (v) => formatPaise(toPaise(v));

/**
 * The options every resolveApprovers() call must pass for an instance of
 * `entityType` started by `initiatedBy`.
 *
 * Delegation is substitution (approvalDelegationModel.applyDelegations): an
 * approver who is away is REPLACED by their delegate. Under SoD a delegate who
 * is the initiator cannot act, and merely filtering them out afterwards would
 * make the delegator's whole approval level vanish — an approver covering via
 * the requester would let the requester skip that level. So, for SoD entity
 * types, a delegation that would land on the initiator is not applied and the
 * original approver keeps the step (the same "never empty a step" rule the
 * delegation model applies to an inactive delegate). filterInitiator() still
 * runs on the result for the initiator's OWN direct eligibility.
 *
 * For every other entity type this returns `{ neverDelegateTo: null }`, which
 * resolveApprovers treats exactly as before.
 */
export function sodResolveOptions(entityType, initiatedBy) {
  return {
    neverDelegateTo: excludesInitiator(entityType) && initiatedBy ? Number(initiatedBy) : null,
  };
}
