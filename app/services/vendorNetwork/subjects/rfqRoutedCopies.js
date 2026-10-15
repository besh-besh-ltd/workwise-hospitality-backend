// Routed invite copies for the RFQ subject (Vendor Networks spec §6.3).
//
// A member entity holding a live (PENDING/ACCEPTED) RFQ assignment sees the RFQ through
// copies of its org principal's tbl_rfq_product_vendors rows (routed_from_vendor_id =
// principal). Every path that adds principal rows to an existing RFQ (edit, refresh
// vendors, join open RFQs, tech-eval replacement) calls propagateRoutedCopies afterwards
// so the member's copy never falls behind the principal's invite.
//
// Deliberately dependency-free (only the runner it is given): imported by models and
// helpers that the routing engine's import graph must not reach.

/**
 * Locks the live (PENDING/ACCEPTED) RFQ assignments of `rfqId` FOR SHARE. Any transaction
 * that writes tbl_rfq_product_vendors of an existing RFQ and then propagates takes this
 * FIRST, before its own rpv writes: the engine holds those rows FOR UPDATE and then writes
 * rpv in its hooks, so taking them in the same order (assignments, then rpv) cannot deadlock.
 */
export function lockLiveRfqAssignments(runner, rfqId) {
  return runner.any(
    `SELECT id FROM tbl_vendor_routing_assignments
      WHERE subject_type = 'RFQ' AND subject_id = $1 AND status IN ('PENDING', 'ACCEPTED')
      ORDER BY id
      FOR SHARE`,
    [rfqId]
  );
}

/**
 * One set-based INSERT: for each live RFQ assignment of `rfqId` (only `assignmentId` when
 * given), copy every principal row the assignee lacks (same product_variant + variant).
 * Each org's assignee only gets rows of its OWN principal. Idempotent.
 * Locks the live assignment rows FOR SHARE (re-checking their status after any wait), so
 * no copy is left behind for a member that was just released. A transaction that also
 * WRITES rpv rows before calling this must take lockLiveRfqAssignments first (see there);
 * a caller that holds nothing uses propagateRoutedCopiesLocked; an engine hook (whose rows
 * are already its own) need not.
 * Returns the number of rows added.
 */
export async function propagateRoutedCopies(runner, rfqId, { assignmentId = null } = {}) {
  const res = await runner.result(
    `INSERT INTO tbl_rfq_product_vendors
       (rfq_id, product_variant_id, variant, sheet_id, user_id, routed_from_vendor_id)
     SELECT p.rfq_id, p.product_variant_id, p.variant, p.sheet_id, a.assigned_vendor_id, o.principal_vendor_id
       FROM tbl_vendor_routing_assignments a
       JOIN tbl_vendor_orgs o ON o.id = a.org_id
       JOIN tbl_rfq_product_vendors p ON p.rfq_id = a.subject_id AND p.user_id = o.principal_vendor_id
      WHERE a.subject_type = 'RFQ' AND a.subject_id = $1
        AND a.status IN ('PENDING', 'ACCEPTED')
        AND ($2::int IS NULL OR a.id = $2)
        AND NOT EXISTS (
              SELECT 1 FROM tbl_rfq_product_vendors x
               WHERE x.rfq_id = p.rfq_id AND x.user_id = a.assigned_vendor_id
                 AND x.product_variant_id = p.product_variant_id
                 AND x.variant IS NOT DISTINCT FROM p.variant)
        FOR SHARE OF a`,
    [rfqId, assignmentId]
  );
  return res.rowCount;
}

/**
 * propagateRoutedCopies for a caller that wrote its tbl_rfq_product_vendors rows WITHOUT
 * holding the live assignments first (autocommit writes, a non-transactional recompute).
 * Runs in its own transaction (a savepoint when `runner` is already one): the assignments
 * are locked in one statement and copied in the next, so the copy reads a snapshot taken
 * after any engine transition (an onAccepted catch-up) that held them has committed. A
 * single INSERT ... FOR SHARE that waits re-checks only the locked row and would copy a
 * row that transition just copied a second time (rpv has no unique index).
 */
export function propagateRoutedCopiesLocked(runner, rfqId) {
  return runner.tx(async (t) => {
    await lockLiveRfqAssignments(t, rfqId);
    return propagateRoutedCopies(t, rfqId);
  });
}

export default { lockLiveRfqAssignments, propagateRoutedCopies, propagateRoutedCopiesLocked };
