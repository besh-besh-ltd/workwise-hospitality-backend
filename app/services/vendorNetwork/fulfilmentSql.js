// SQL fragments for Group ARC per-hotel fulfilment (spec §6.4): who supplies a hotel on a
// contract. One definition, shared by every path that answers it, so they cannot disagree:
//   - the call-off release (callOffPoService.buildCallOffBuckets): the PO's supplier;
//   - the MR line picker (mrModel.searchContractedItems): the supplier the buyer is shown;
//   - a new ledger row inheriting the hotel's ACCEPTED assignee
//     (arcHotelModel.syncContractLineHotels).
//
// A fulfilling entity counts only while it is ACTIVE in the network whose principal is
// the contract vendor. A removal or suspension commits before its assignments are
// revoked (after commit), and nothing may reach the entity in between.

/**
 * SQL boolean: `vendorExpr` is an ACTIVE entity of the org whose principal is
 * `principalExpr`. The principal itself is its org's ACTIVE PRINCIPAL entity, so it
 * passes too.
 */
export const isActiveFulfiller = (vendorExpr, principalExpr) => `EXISTS (
  SELECT 1
    FROM tbl_vendor_org_entities ff_e
    JOIN tbl_vendor_orgs ff_o ON ff_o.id = ff_e.org_id AND ff_o.principal_vendor_id = ${principalExpr}
   WHERE ff_e.vendor_id = ${vendorExpr} AND ff_e.status = 'ACTIVE')`;

/**
 * SQL int: the effective supplier of a contract at a hotel. The ledger row's fulfilling
 * vendor while it passes isActiveFulfiller, else the contract vendor. A NULL fulfiller
 * (single-hotel ARC, unassigned hotel) gives the contract vendor.
 */
export const effectiveSupplierExpr = (fulfillerExpr, contractVendorExpr) => `(CASE
  WHEN ${fulfillerExpr} IS NOT NULL AND ${isActiveFulfiller(fulfillerExpr, contractVendorExpr)}
  THEN ${fulfillerExpr} ELSE ${contractVendorExpr} END)`;
