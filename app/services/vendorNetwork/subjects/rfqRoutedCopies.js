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
 * One set-based INSERT: for each live RFQ assignment of `rfqId` (only `assignmentId` when
 * given), copy every principal row the assignee lacks (same product_variant + variant).
 * Each org's assignee only gets rows of its OWN principal. Idempotent.
 * Locks the live assignment rows FOR SHARE: an RFQ write racing a release waits for it and
 * then re-checks the status, so no copy is left behind for a member that just declined.
 * (The engine holds those rows FOR UPDATE and only plain-reads RFQ tables, so this never
 * deadlocks with it; called from inside a hook, the rows are already the hook's own.)
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

export default { propagateRoutedCopies };
