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
           ON nk_e.vendor_id = nk_s.vendor_id AND nk_e.status IN ('ACTIVE', 'SUSPENDED')
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

export default { orgKeySelect, orgEntitiesOfKeys };
