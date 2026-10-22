// ============================================================================
// poReference.js
// ----------------------------------------------------------------------------
// The one place that turns "which RFQ or contract is this PO for?" into text a
// VENDOR reads: email subjects and the Orders export column.
//
//   RFQ PO   ->  RFQ #536894 · <title>            (title omitted when blank)
//   call-off ->  ARC-2026-27-0018 · <arc title> · MR <mr number>
//
// Real arc_number values already read "ARC-2026-27-0018", so the "ARC " prefix
// is added only when the number does not already start with "ARC" (a doubled
// prefix reads as a bug). The MR number gets the same treatment for "MR".
//
// The MR TITLE is deliberately not an input: it is a buyer-internal field and
// must never reach a vendor on any surface.
// ============================================================================

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };

// Titles are stored HTML-entity-encoded in places ("A &amp; B"). A subject line
// or spreadsheet cell is plain text, so decode (once), drop any tag and
// collapse whitespace.
export function cleanRefTitle(value) {
  if (value == null) return "";
  const decoded = String(value).replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const clean = (v) => cleanRefTitle(v);
const withPrefix = (value, prefix) => (new RegExp(`^${prefix}`, "i").test(value) ? value : `${prefix} ${value}`);

export function buildVendorPoReference(row) {
  if (!row) return "";
  const rfqNo = row.rfq_no != null ? clean(row.rfq_no) : "";
  const arcNumber = clean(row.arc_number);
  const arcTitle = clean(row.arc_title);
  const mrNumber = clean(row.mr_number);
  const isCallOff = row.is_call_off === true || (!rfqNo && (arcNumber || arcTitle || mrNumber));

  if (isCallOff) {
    return [
      arcNumber ? withPrefix(arcNumber, "ARC") : "",
      arcTitle,
      mrNumber ? withPrefix(mrNumber, "MR") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (!rfqNo) return "";
  const title = clean(row.rfq_title ?? row.title);
  return title ? `RFQ #${rfqNo} · ${title}` : `RFQ #${rfqNo}`;
}

// Escape LIKE/ILIKE wildcards in user input (no shared helper exists in app/).
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

export default { buildVendorPoReference, cleanRefTitle, escapeLike };
