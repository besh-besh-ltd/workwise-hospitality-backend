// Pure: no imports, no I/O. Kept out of sendEmailFunctions/approvalEmails.js on
// purpose — a dozen suites mock that module wholesale, and a helper living
// there would vanish from every caller under those mocks.

/**
 * Build the identifier + link context for an approval-step email from an
 * approval instance's metadata.
 *
 * PO instances are special: their metadata also carries the RFQ fields, and
 * reading it RFQ-first sent PO approvers to the RFQ workspace (no po_id, so
 * buyerPoApproval fell back) under a subject naming the RFQ number. For a PO
 * the identifier is the PO number and the link carries the PO id — the
 * instance's entity_id IS the PO id, so it backs up a missing metadata.po_id.
 */
export const approvalStepEmailContext = (entityType, entityId, metadata) => {
  const isPo = entityType === 'PO';
  const entityIdentifier = (isPo && metadata?.po_number)
    || metadata?.rfq_number || metadata?.rfq_no || metadata?.po_number || `ID-${entityId}`;
  const extraContext = { rfq_id: metadata?.rfq_id || entityId, rfq_title: metadata?.rfq_title || '', end_date: metadata?.end_date || null, product_name: metadata?.product_name || '', company_name: metadata?.company_name || '', hotel_name: metadata?.hotel_name || '' };
  if (isPo) extraContext.po_id = metadata?.po_id || entityId;
  return { entityIdentifier, extraContext };
};
