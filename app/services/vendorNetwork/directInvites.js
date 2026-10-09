// Direct RFQ invites written by the buyer's edit paths (Vendor Networks spec §6.3).
//
// A network member reaches an RFQ only through a routed copy of its principal's invite
// (tbl_rfq_product_vendors.routed_from_vendor_id). A buyer edit that re-sends a vendor
// list (a stale screen, or the member picked by hand) must not turn that member into a
// DIRECT invitee: a direct row gives it quote rights of its own (assertOrgMayQuote) and
// hides the RFQ from its org's routing queue. So every vendor id an edit path is about to
// invite directly goes through here first: an ACTIVE or SUSPENDED org entity becomes its
// principal (the pooled-eligibility rule, mapToPrincipalIds), and a vendor that already
// holds any row on the line (direct or routed) is not invited again.

import { mapToPrincipalIds } from "../../models/vendorNetworkModel.js";
import { orgKeysFor } from "./orgKeySql.js";

/**
 * The ids to INSERT as direct invite rows for one RFQ line, from the ids an edit asked
 * for. Ascending, distinct; [] when nothing new remains. Runs on `runner` (the edit's tx).
 */
export async function directInviteIdsForLine(runner, { rfqId, productVariantId, variant }, vendorIds) {
  const asked = (vendorIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!asked.length) return [];
  const ids = await mapToPrincipalIds(asked, runner);
  if (!ids.length) return [];
  const held = await runner.any(
    `SELECT DISTINCT user_id FROM tbl_rfq_product_vendors
      WHERE rfq_id = $1 AND product_variant_id = $2
        AND COALESCE(variant, 0) = COALESCE($3::int, 0)
        AND user_id = ANY($4::int[])`,
    [rfqId, productVariantId, variant ?? 0, ids]
  );
  const heldIds = new Set(held.map((r) => Number(r.user_id)));
  return ids.map(Number).filter((id) => !heldIds.has(id));
}

/**
 * A vendor picker's rows with every ACTIVE/SUSPENDED org entity replaced by its org's
 * principal (the pooled rule, orgKeysFor): a member is never offered for a direct invite,
 * its org is, once, at the position of the org's first row. Rows of vendors in no org are
 * untouched (duplicates included, as before). `excludeIds` is applied to the principals.
 *
 * `principalRows(ids)` loads the replacement rows for principal ids, in the picker's own
 * row shape; `idOf(row)` reads a row's vendor id.
 */
export async function collapsePickerRowsToPrincipals(rows, { idOf, principalRows, excludeIds = [] }, runner) {
  if (!rows?.length) return rows ?? [];
  const keyOf = await orgKeysFor(rows.map(idOf), runner);
  const excluded = new Set((excludeIds ?? []).map(Number));
  const ownIds = new Set(rows.map((r) => Number(idOf(r))));
  const missing = [...new Set(rows.map((r) => keyOf.get(Number(idOf(r)))))].filter(
    (k) => k != null && !ownIds.has(k) && !excluded.has(k)
  );
  const principalById = new Map(
    (missing.length ? await principalRows(missing) : []).map((r) => [Number(idOf(r)), r])
  );

  const out = [];
  const placed = new Set();
  for (const row of rows) {
    const id = Number(idOf(row));
    const key = keyOf.get(id) ?? id;
    if (excluded.has(key)) continue;
    if (key === id) {
      out.push(row); // a vendor in no org, or a principal's own row: as before
      continue;
    }
    // a member: its org is offered once, through the principal (its own row if listed)
    if (ownIds.has(key) || placed.has(key)) continue;
    const principal = principalById.get(key);
    if (principal) {
      out.push(principal);
      placed.add(key);
    }
  }
  return out;
}

export default { directInviteIdsForLine, collapsePickerRowsToPrincipals };
