// What a site-rep receive-token holder may see of a PO.
//
// The token holder is someone at the hotel with an emailed link and no account.
// They need the PO's identity and status, the vendor, and each line's product,
// quantity and unit, enough to check a delivery against it. They must not see
// what the PO costs, what the vendor quoted, who at the buyer raised or
// approved it, or the other people holding links to it.
//
// redactForReceiveToken returns a copy of any value (a PO row, a list of rows,
// a receive context) with two kinds of key removed, at any depth:
//   - any key whose name matches COMMERCIAL_KEY (prices, rates, amounts,
//     values, taxes and GST/GSTIN, discounts, freight, costs, totals, charges);
//   - the keys in TOKEN_HIDDEN_KEYS: buyer contact details, approval internals,
//     the site-rep links themselves, and documents or terms that carry prices
//     (the PO PDF, invoice uploads, the vendor's quote files and comments).
//
// The legacy GRN token page reads id, po_number, status, rfq_id,
// project_details, finalized_vendor_name/_email, delivery_period and
// po_approved_on, all of which survive. Vendor contact details are kept on
// purpose: the person receiving the goods is the one who calls the vendor.

export const COMMERCIAL_KEY = /price|rate|amount|value|tax|gst|discount|freight|cost|total|charge/i;

export const TOKEN_HIDDEN_KEYS = Object.freeze([
  // Buyer contact details and the buyer's own people.
  'initiated_by',
  'initiated_by_name',
  'initiated_by_email',
  'initiated_by_phone',
  'buyer_address',
  'logged_in_user',
  'created_by',
  'uploaded_by',
  'reminder_users',
  // Approval internals.
  'is_approver',
  'approval_status',
  'approval_history',
  'approval_instance_id',
  'selected_hierarchy',
  'hold',
  'replaces_po_id',
  // The links themselves (other reps' names, emails, phones).
  'site_rep',
  'site_reps',
  // Documents and terms that carry prices or commercial terms.
  'po_pdf_url',
  'documents',
  'terms_and_conditions',
  'payment_milestones',
  'tasks',
  'hsn_codes',
  'quote_id',
  'vendor_comment',
  'vendor_global_comment',
  'vendor_rejection_reason',
  'vendor_quote_term_files',
  'vendor_quote_product_files',
  'vendor_tech_eval_files',
  'buyer_tech_eval_files',
]);

const HIDDEN = new Set(TOKEN_HIDDEN_KEYS);

const isHiddenKey = (key) => HIDDEN.has(key) || COMMERCIAL_KEY.test(key);

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A redacted copy of `value` for a receive-token holder. Never mutates the input. */
export function redactForReceiveToken(value) {
  if (Array.isArray(value)) return value.map(redactForReceiveToken);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (isHiddenKey(key)) continue;
    out[key] = redactForReceiveToken(v);
  }
  return out;
}
