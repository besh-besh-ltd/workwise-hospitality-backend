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

// Titles can arrive HTML-entity-encoded ("A &amp; B"). A subject line or
// spreadsheet cell is plain text, so decode (once) and collapse whitespace.
// Tags are NOT stripped: titles are plain text and "Size <10 and >5" is real.
export function cleanRefTitle(value) {
  if (value == null) return "";
  const decoded = String(value).replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return decoded.replace(/\s+/g, " ").trim();
}

// Longest title shown in a subject / export cell (before the ellipsis).
export const REF_TITLE_MAX = 80;

// Cap at `max` characters plus "…", cutting on a word boundary when one falls
// in the back half of the cap.
function capTitle(text, max = REF_TITLE_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:·-]+$/, "")}…`;
}

// Hard backstop for text bound for a varchar(255) column (tbl_notifications.title).
export function clampText(value, max = 255) {
  const s = String(value ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const clean = (v) => cleanRefTitle(v);
// "ARC-2026-0018" / "ARC 5" already carry the prefix; "ARCADE-1" / "MRP-5" do not.
const withPrefix = (value, prefix) => (new RegExp(`^${prefix}([-\\s]|$)`, "i").test(value) ? value : `${prefix} ${value}`);

export function buildVendorPoReference(row) {
  if (!row) return "";
  const rfqNo = row.rfq_no != null ? clean(row.rfq_no) : "";
  const arcNumber = clean(row.arc_number);
  const arcTitle = capTitle(clean(row.arc_title));
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
  const title = capTitle(clean(row.rfq_title ?? row.title));
  return title ? `RFQ #${rfqNo} · ${title}` : `RFQ #${rfqNo}`;
}

// Escape LIKE/ILIKE wildcards in user input (no shared helper exists in app/).
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

export default { buildVendorPoReference, cleanRefTitle, escapeLike, clampText, REF_TITLE_MAX };
