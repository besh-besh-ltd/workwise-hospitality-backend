// ============================================================================
// poScope.js
// ----------------------------------------------------------------------------
// The tenant-scope WHERE fragment for anything that reads purchase orders.
//
// This lived inside poDashboardModel.js and was private to it. The Reports
// module reads the same rows through different queries, and a second copy of a
// security predicate is how two surfaces end up disagreeing about who may see
// what — which is precisely the class of bug the comment below records. One
// definition, two callers.
// ============================================================================

import { buildScopeExistsClause } from "../../services/authorizationService.js";

// ---------------------------------------------------------------------------
// Scope WHERE fragment builder.
// Returns { clause, values, nextIndex } where `clause` references the PO alias
// `po` and the RFQ alias `rfq` (the caller MUST join tbl_rfq rfq ON rfq.id =
// po.rfq_id).
//
// SECURITY (rewritten — cross-hotel leak, ₹2.8 crore exposure in production):
//   This builder used to take hotel and department ONLY from the optional
//   `x-hotel-ids` / `x-department-id` request headers, and emitted the hotel
//   predicate just `if (scope.hotelIds.length > 0)`. Omitting the header made
//   the hotel filter disappear entirely, degrading the query to "every PO in
//   every company the user is mapped to". There was no process axis at all,
//   and company came from tbl_hospitality_user_mappings, which is
//   company-granular and discards the user's hotel binding.
//
//   Measured on production for user 168 (RBAC scope = company 5 / hotel 6):
//   GET /po/list returned 163 POs across 15 business units / ₹4,86,12,564;
//   the correctly scoped answer is 45 POs / 1 unit / ₹2,06,56,844.
//
//   The authoritative predicate is now buildScopeExistsClause() from
//   authorizationService — the same company × hotel × department × process
//   EXISTS shape the RFQ listing uses (rfqModel.js:3916-3931). Because
//   tbl_rfq_purchase_order has no hotel_id / department_id / process_id
//   columns, the predicate correlates against the JOINED `rfq` alias (and the
//   `aa` ARC alias for call-off POs, which carries all four axes too).
//
//   Headers remain supported but only as a NARROWING facet, intersected with
//   the scoped set — never as the scope source.
//
// Permission choice: the clause matches on `awarding.read` OR `rfq.read` OR
// `boq.read`. `awarding.read` alone would strand the 1 production user who
// holds rfq.read without it; rfq/boq.read alone would strand the 3 who hold
// awarding.read without those. This also matches the documented convention in
// authorizationService.assertCanReadParentRfq(), which deliberately gates PO
// detail on the parent RFQ's read permission because the seeded buyer roles do
// not all carry every entity-specific read permission. All three variants
// enforce the identical 4-axis scope, so the choice widens *who* can see the
// PO list, never *which* rows any one of them sees.
// ---------------------------------------------------------------------------
export const PO_SCOPE_PERMISSIONS = ["awarding.read", "rfq.read", "boq.read"];

// OR-composition of the canonical EXISTS clause across the accepted
// permissions for one entity alias. Returns { clause, nextIndex }.
export function scopedExistsFor(userId, alias, values, startIndex) {
  let i = startIndex;
  const clauses = [];
  for (const perm of PO_SCOPE_PERMISSIONS) {
    const built = buildScopeExistsClause(userId, perm, alias, i);
    clauses.push(built.clause);
    values.push(...built.params);
    i += built.paramsConsumed;
  }
  return { clause: `(${clauses.join(" OR ")})`, nextIndex: i };
}

export function buildScopeClause(scope, values, startIndex) {
  let i = startIndex;
  const parts = [];
  const hcIds = scope.hospitalityCompanyIds;

  // Header-derived hotel / department facets. These NARROW an already-scoped
  // set; they are applied in both branches below and can never widen it.
  const narrowFor = (alias, conds) => {
    if (scope.hotelIds && scope.hotelIds.length > 0) {
      const hIdx = i++;
      values.push(scope.hotelIds);
      conds.push(`${alias}.hotel_id = ANY($${hIdx}::int[])`);
    }
    if (scope.departmentId) {
      const dIdx = i++;
      values.push(scope.departmentId);
      conds.push(`${alias}.department_id = $${dIdx}`);
    }
  };

  // Legacy fallback: the user has no hospitality mappings at all, so there is
  // no RBAC scope row to correlate against — scope on the buyer company id
  // stored directly on the PO header. Previously this branch returned early
  // and DROPPED the hotel/department facets entirely; they are now applied.
  if (Array.isArray(hcIds) && hcIds.length === 0) {
    parts.push(`po.company_id = $${i++}`);
    values.push(scope.companyId);
    const legacyConds = [];
    narrowFor("rfq", legacyConds);
    if (legacyConds.length) parts.push(legacyConds.join(" AND "));
    return { clause: parts.join(" AND "), values, nextIndex: i };
  }

  // Super admin (hcIds === null) keeps the "all companies" behaviour: no
  // per-row scope predicate, only the optional narrowing facets.
  if (hcIds === null) {
    const adminConds = [];
    narrowFor("rfq", adminConds);
    parts.push(adminConds.length ? adminConds.join(" AND ") : "TRUE");
    return { clause: parts.join(" AND "), values, nextIndex: i };
  }

  // Scoped path. RFQ-backed POs correlate through the joined `rfq` alias;
  // call-off POs (no rfq_id) correlate through their ARC via a self-contained
  // EXISTS, so this works regardless of the caller's join block (CO8).
  const rfqScoped = scopedExistsFor(scope.userId, "rfq", values, i);
  i = rfqScoped.nextIndex;
  const rfqConds = [rfqScoped.clause];
  narrowFor("rfq", rfqConds);

  const arcScoped = scopedExistsFor(scope.userId, "aa", values, i);
  i = arcScoped.nextIndex;
  const arcConds = [arcScoped.clause];
  narrowFor("aa", arcConds);

  parts.push(`(
    (${rfqConds.join(" AND ")})
    OR (po.is_call_off = TRUE AND EXISTS (
      SELECT 1 FROM tbl_arc_contract cc
        JOIN tbl_arc aa ON aa.id = cc.arc_id
       WHERE cc.id = po.arc_contract_id AND ${arcConds.join(" AND ")}
    ))
  )`);

  return { clause: parts.join(" AND "), values, nextIndex: i };
}
