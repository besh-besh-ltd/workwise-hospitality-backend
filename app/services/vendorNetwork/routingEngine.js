// Vendor Networks routing engine (spec §6.2). Task 8 replaces this module with the
// real assignment lifecycle; until then entity suspension/removal (Task 4) calls
// this no-op through the same signature Task 8 implements.

/**
 * Revokes every live (PENDING/ACCEPTED) routing assignment held by `vendorId`.
 * @returns {Promise<number>} the number of assignments revoked
 */
export async function revokeLiveAssignmentsForEntity(vendorId, { actorUserId = null, reason = "ENTITY_REMOVED" } = {}) {
  return 0;
}

export default { revokeLiveAssignmentsForEntity };
