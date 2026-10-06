// SQL fragments for POOLED, set-based eligibility (spec §5.2): "the org is eligible if
// any of its ACTIVE entities holds the subscription; the invite goes to the principal".
//
// Set-based eligibility queries (getEligibleVendorsForVariant, resolveArcVendorCoverage,
// the RFQ-edit inline copy) cannot call collapseToPrincipals per vendor, so they map
// every requirement row to an ORG KEY inside the statement and intersect the
// requirement sets on that key. These fragments are the one definition they share.
//
// org_key: the org's principal for an ACTIVE or SUSPENDED org entity, otherwise the
//   vendor itself. Must equal collapseToPrincipals (vendorNetworkModel.mapToPrincipalIds);
//   tests/services/vendorNetwork.eligibility.test.js "org key parity" pins that.
// counts: whether the vendor's own rows (mapping, subscriptions) count for its key:
//   always for a vendor in no org (INVITED/REMOVED rows are "no org"), and for an org
//   entity only when it is ACTIVE with a live login (the subscriptionHolderIdsFor rule).
//   A SUSPENDED entity maps to its principal but contributes nothing.
//
// A vendor in no org has org_key = itself and counts = true, so every query built on
// these fragments gives it exactly its pre-network answer.

import db from "../../config/dbConn.js";

/**
 * Rows `(vendor_id, org_key, counts)` for every vendor_id produced by `sourceSql`
 * (a SELECT of one int column).
 */
export const orgKeySelect = (sourceSql) => `
  SELECT nk_s.vendor_id,
         COALESCE(nk_o.principal_vendor_id, nk_s.vendor_id) AS org_key,
         (nk_e.vendor_id IS NULL
           OR (nk_e.status = 'ACTIVE' AND nk_u.status = 1 AND COALESCE(nk_u.is_deleted, 0) = 0)) AS counts
    FROM (${sourceSql}) AS nk_s(vendor_id)
    LEFT JOIN tbl_vendor_org_entities nk_e
           -- '<> REMOVED' keeps the partial index ix_vn_entities_live_vendor usable.
           ON nk_e.vendor_id = nk_s.vendor_id AND nk_e.status <> 'REMOVED'
          AND nk_e.status IN ('ACTIVE', 'SUSPENDED')
    LEFT JOIN tbl_vendor_orgs nk_o ON nk_o.id = nk_e.org_id
    LEFT JOIN tbl_users nk_u ON nk_u.id = nk_s.vendor_id`;

/**
 * The ACTIVE entity ids of every org whose principal is among the keys produced by
 * `keysSql` (a SELECT of one int column). Used to widen a requirement scan from the
 * directly matched vendors to their org siblings; `counts` still filters afterwards.
 */
export const orgEntitiesOfKeys = (keysSql) => `
  SELECT nm_e.vendor_id
    FROM tbl_vendor_orgs nm_o
    JOIN tbl_vendor_org_entities nm_e ON nm_e.org_id = nm_o.id AND nm_e.status = 'ACTIVE'
   WHERE nm_o.principal_vendor_id IN (${keysSql})`;

/**
 * SQL boolean: the key `keyExpr` may receive an invite. A key that is no org's
 * principal (a vendor in no org) always may, exactly as before networks; an org's
 * principal only with a live login (status 1, not deleted). A dead principal means
 * the org gets no invite at all.
 */
export const keyIsInvitable = (keyExpr) => `(
  NOT EXISTS (SELECT 1 FROM tbl_vendor_orgs ni_o WHERE ni_o.principal_vendor_id = ${keyExpr})
  OR EXISTS (SELECT 1 FROM tbl_users ni_u
              WHERE ni_u.id = ${keyExpr} AND ni_u.status = 1 AND COALESCE(ni_u.is_deleted, 0) = 0))`;

/**
 * The ACTIVE, live-login entities of the org in which the vendor `vendorParam` (an SQL
 * expression, e.g. '$1') is itself ACTIVE; empty when it is not. The single definition
 * behind subscriptionHolderIdsFor (vendorNetworkModel.listActiveSiblingIds) and the
 * statement-inlined holder set in hospitalityModel.hasValidPaidSubscription.
 */
export const activeSiblingIdsSql = (vendorParam) => `
  SELECT ns_e2.vendor_id
    FROM tbl_vendor_org_entities ns_e
    JOIN tbl_vendor_org_entities ns_e2 ON ns_e2.org_id = ns_e.org_id AND ns_e2.status = 'ACTIVE'
    JOIN tbl_users ns_u2
      ON ns_u2.id = ns_e2.vendor_id AND ns_u2.status = 1 AND COALESCE(ns_u2.is_deleted, 0) = 0
   WHERE ns_e.vendor_id = ${vendorParam} AND ns_e.status = 'ACTIVE'`;

/** Map each id to its org key (orgKeySelect), in one query: Map<id, key>. */
export async function orgKeysFor(vendorIds, runner = db) {
  const ids = [...new Set((vendorIds ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const rows = await runner.any(`SELECT vendor_id, org_key FROM (${orgKeySelect("SELECT unnest($1::int[])")}) k`, [ids]);
  return new Map(rows.map((r) => [Number(r.vendor_id), Number(r.org_key)]));
}

export default { orgKeySelect, orgEntitiesOfKeys, keyIsInvitable, activeSiblingIdsSql, orgKeysFor };
