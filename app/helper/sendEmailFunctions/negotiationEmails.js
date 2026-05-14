import config from "../../config/app.config.js";
import { sendMail, logError } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';

/**
 * Format a DB timestamp as IST display string.
 * DB stores timestamps without timezone — treat bare strings as UTC before converting.
 */
const formatDateIST = (dateValue) => {
  if (!dateValue) return 'N/A';
  let str = String(dateValue);
  // Append 'Z' to bare timestamps so Date parses as UTC
  if (!str.includes('+') && !str.includes('Z')) {
    str = str.replace(' ', 'T') + 'Z';
  }
  return new Date(str).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
};

// Labels for non-charge built-in fields. Charges (Freight, Packaging, Insurance,
// custom ones) are NOT here — they're resolved via chargeLabels from tbl_charge_names.
const SYSTEM_FIELD_LABELS = {
  base_price: 'Base Price',
  delivery_period: 'Delivery Period',
  payment_terms: 'Payment Terms',
  vendor_tc: 'Vendor T&C',
  comments: 'Comments',
  documents: 'Documents',
};

// Last-resort title-case fallback if a slug isn't in tbl_charge_names anymore.
const titleCase = (s) => String(s)
  .split(/[\s_]+/)
  .map(w => w.length ? w[0].toUpperCase() + w.slice(1) : w)
  .join(' ');

const getFieldLabel = (name, chargeLabels = {}) =>
  SYSTEM_FIELD_LABELS[name] || chargeLabels[name] || titleCase(name);

// Legacy: very old rounds stored mode as a companion `<name>_mode` entry.
const isModeFlagEntry = (name) => typeof name === 'string' && /_mode$/.test(name);

/**
 * Normalize a mode value to a canonical form.
 * Frontend sends 'percentage' or 'absolute'. Some legacy data uses 'amount'.
 * Returns 'percentage' | 'amount' | null.
 */
const normalizeMode = (raw) => {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === 'percentage' || s === 'percent' || s === '%') return 'percentage';
  if (s === 'absolute' || s === 'amount' || s === '₹') return 'amount';
  return null;
};

/**
 * Parse `other_charges` tolerantly — JSONB usually comes through as an array,
 * but some code paths persist it as a stringified JSON.
 */
const getOtherCharges = (vendorQuote) => {
  const raw = vendorQuote?.other_charges;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
};

/**
 * Find the matching entry in other_charges by slug, name, or lowercased name.
 * Canonical shape: { name, slug, amount, amount_mode, tax, tax_mode, comment? }
 */
const findOtherCharge = (otherCharges, fieldName) => {
  if (!Array.isArray(otherCharges) || !fieldName) return null;
  const key = String(fieldName).toLowerCase();
  return otherCharges.find(c => {
    if (!c) return false;
    if (c.slug === fieldName || c.slug === key) return true;
    if (c.name === fieldName) return true;
    if (String(c.name || '').toLowerCase() === key) return true;
    return false;
  }) || null;
};

/**
 * Resolve the vendor's quoted mode from other_charges.
 * Returns 'percentage' | 'amount' | null.
 *
 * NOTE: tbl_quote_items.freight_mode / package_mode are dead writes (always
 * persisted as null by the quote save path) — Freight and Packaging modes,
 * like every other charge, live in the other_charges JSONB array.
 */
const resolveVendorMode = (fieldName, vendorQuote) => {
  if (!vendorQuote) return null;
  const other = findOtherCharge(getOtherCharges(vendorQuote), fieldName);
  if (other) return normalizeMode(other.amount_mode);
  return null;
};

/**
 * Resolve the TARGET mode for a numeric charge (the unit the buyer chose).
 * Priority: mode on the field itself → legacy companion entry → vendor's quoted mode as fallback.
 */
const resolveMode = (field, allFields, vendorQuote) => {
  // 1. Mode embedded directly on the field (current frontend shape)
  const onField = normalizeMode(field?.mode);
  if (onField) return onField;

  // 2. Legacy: companion `<name>_mode` entry
  const fieldName = field?.name;
  const modeEntry = (allFields || []).find(f => f && f.name === `${fieldName}_mode`);
  const fromCompanion = normalizeMode(modeEntry?.target);
  if (fromCompanion) return fromCompanion;

  // 3. Fallback: assume target uses the vendor's mode if buyer didn't specify
  return resolveVendorMode(fieldName, vendorQuote);
};

/**
 * Format vendor's structured payment terms array into a readable string.
 * Shape: [{ value, type: 'advance'|'credit'|'other', days, comment }, ...]
 */
const formatPaymentTermsArray = (terms) => {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const parts = terms.map(t => {
    if (!t) return null;
    const segments = [];
    if (t.value != null) segments.push(`${t.value}%`);
    if (t.type) segments.push(t.type);
    if (t.days) segments.push(`${t.days} days`);
    if (t.comment) segments.push(`(${t.comment})`);
    return segments.join(' ');
  }).filter(Boolean);
  return parts.length > 0 ? parts.join(' + ') : null;
};

/**
 * Look up the vendor's quoted value for a given field.
 * Canonical key for custom charges in other_charges JSONB is `amount`.
 *
 * NOTE: tbl_quote_items.freight_price / package_price are dead writes
 * (always persisted as 0 by the quote save path) — Freight and Packaging
 * amounts live in the other_charges JSONB array, same as every other charge.
 */
const resolveQuotedValue = (fieldName, vendorQuote) => {
  if (!vendorQuote) return null;
  if (fieldName === 'base_price') return vendorQuote.unit_price;
  if (fieldName === 'delivery_period') return vendorQuote.delivery_period;
  if (fieldName === 'payment_terms') {
    return formatPaymentTermsArray(vendorQuote.payment_terms) || vendorQuote.global_payment_term || null;
  }
  if (fieldName === 'comments') return vendorQuote.global_comment || vendorQuote.comment;
  const other = findOtherCharge(getOtherCharges(vendorQuote), fieldName);
  if (other) return other.amount ?? null;
  return null;
};

/**
 * Format a numeric value with its mode unit. Coerces string numbers.
 */
const formatNumberWithMode = (value, mode) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (isNaN(n)) return String(value);
  if (mode === 'percentage') return `${n}%`;
  if (mode === 'amount') return `₹${n.toLocaleString('en-IN')}`;
  // Unknown mode: render number with locale formatting only (no symbol)
  return n.toLocaleString('en-IN');
};

/**
 * Format a single field value for display. Handles dates, documents arrays,
 * percentage/amount charges, and text fallback.
 *
 * Real stored shape: { name, target } — target can be number | string | array.
 */
const formatFieldValue = (fieldName, value, mode) => {
  if (value == null || value === '') return '—';

  if (fieldName === 'base_price') {
    return formatNumberWithMode(value, 'amount');
  }
  if (fieldName === 'delivery_period') {
    const d = new Date(value);
    return isNaN(d.getTime())
      ? String(value)
      : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
  }
  if (fieldName === 'documents' && Array.isArray(value)) {
    return value.length === 0 ? '—' : `${value.length} document(s)`;
  }
  // Numeric charge — render with mode if known
  if (mode) {
    return formatNumberWithMode(value, mode) || '—';
  }
  // Plain number with no mode hint — show with locale formatting (avoids bare "60")
  if (typeof value === 'number' || (!isNaN(Number(value)) && String(value).trim() !== '')) {
    return Number(value).toLocaleString('en-IN');
  }
  return String(value);
};

/**
 * Convert a numeric charge value to absolute ₹ amount given its mode and line total.
 * Returns null when conversion isn't possible (percentage with no usable line total,
 * or value is non-numeric / mode is unknown).
 */
const toAbsoluteAmount = (value, mode, lineTotal) => {
  const n = Number(value);
  if (!isFinite(n)) return null;
  if (mode === 'amount') return n;
  if (mode === 'percentage') {
    const lt = Number(lineTotal);
    if (!isFinite(lt) || lt <= 0) return null;
    return (n / 100) * lt;
  }
  return null;
};

/**
 * Decide whether the buyer's target is worse than the vendor's quoted value
 * (target > quoted — lower is always better for the buyer on base price / charges).
 * Modes may differ; in that case both are normalized to absolute ₹ using
 * lineTotal = vendorQuote.quantity * vendorQuote.unit_price, per spec.
 *
 * Returns true only when we can confidently compare AND target > quoted.
 * Any uncertainty (missing/non-numeric values, no usable line total for mixed-mode)
 * returns false so the row is still shown — never hide on doubt.
 */
const isTargetWorseThanQuoted = (quoted, target, vendorMode, targetMode, vendorQuote) => {
  if (quoted == null || quoted === '') return false;
  if (target == null || target === '') return false;
  const qNum = Number(quoted);
  const tNum = Number(target);
  if (!isFinite(qNum) || !isFinite(tNum)) return false;
  if (vendorMode === targetMode) return tNum > qNum;
  const lineTotal = Number(vendorQuote?.unit_price) * Number(vendorQuote?.quantity);
  const qAmt = toAbsoluteAmount(qNum, vendorMode, lineTotal);
  const tAmt = toAbsoluteAmount(tNum, targetMode, lineTotal);
  if (qAmt == null || tAmt == null) return false;
  return tAmt > qAmt;
};

/**
 * Render the negotiation_fields array as <li> rows showing `<quoted> → <target>`.
 * Skips `_mode` flag entries (they fold into their parent's display).
 *
 * options.hideWorseTargets — set true for the vendor-facing email: rows where the
 * buyer's target is worse (higher) than what the vendor already quoted are dropped,
 * since asking a vendor to "negotiate" up makes no sense.
 */
const renderFieldRows = (fields = [], vendorQuote = null, chargeLabels = {}, options = {}) => {
  const { hideWorseTargets = false } = options;
  return fields
    .filter(f => f && f.name && !isModeFlagEntry(f.name))
    .map(f => {
      const targetMode = resolveMode(f, fields, vendorQuote);
      const vendorMode = resolveVendorMode(f.name, vendorQuote) || targetMode;
      const quoted = resolveQuotedValue(f.name, vendorQuote);
      if (hideWorseTargets && isTargetWorseThanQuoted(quoted, f.target, vendorMode, targetMode, vendorQuote)) {
        return null;
      }
      const targetStr = formatFieldValue(f.name, f.target, targetMode);
      const hasQuoted = quoted != null && quoted !== '' && !(typeof quoted === 'string' && quoted.trim() === '');
      const quotedStr = hasQuoted ? formatFieldValue(f.name, quoted, vendorMode) : null;
      const valueHtml = quotedStr
        ? `<span style="color:#475569;">${quotedStr}</span> <span style="color:#64748B;">→</span> <span style="color:#0F172A; font-weight:600;">${targetStr}</span>`
        : targetStr;
      return `<li style="padding:3px 0;"><strong>${getFieldLabel(f.name, chargeLabels)}:</strong> ${valueHtml}</li>`;
    })
    .filter(Boolean)
    .join('');
};

/**
 * Build per-vendor negotiation fields HTML block for buyer-side emails.
 * Each vendor gets a card showing `<vendor quoted> → <target>` per field.
 *
 * @param {Array} vendorApprovals - from round.vendor_approvals
 * @param {Object} vendorsLookup  - { [vendorId]: vendorName }
 * @param {Object} vendorQuotes   - { [vendorId]: quoteItemRow } from tbl_quote_items
 */
const buildVendorTargetsHtml = (vendorApprovals = [], vendorsLookup = {}, vendorQuotes = {}, chargeLabels = {}) => {
  if (!Array.isArray(vendorApprovals) || vendorApprovals.length === 0) return '';
  const sections = vendorApprovals.map(va => {
    const vendorName = vendorsLookup[va.vendor_id] || `Vendor #${va.vendor_id}`;
    const vendorQuote = vendorQuotes[va.vendor_id] || null;
    const rows = renderFieldRows(va.negotiation_fields || [], vendorQuote, chargeLabels);
    if (!rows) return '';
    return `
      <div style="margin-top:10px; padding:10px 12px; background:#F8FAFC; border:1px solid #E2E8F0; border-radius:6px;">
        <p style="margin:0 0 6px; font-weight:600; color:#1E293B;">${vendorName}</p>
        <p style="margin:0 0 6px; font-size:12px; color:#64748B;">Vendor Quoted → Target</p>
        <ul style="list-style:none; padding-left:0; margin:0;">${rows}</ul>
      </div>`;
  }).filter(Boolean).join('');
  return sections
    ? `<div style="margin-top:16px;"><p style="margin:0 0 4px; font-weight:600; color:#1F2937;">Negotiation Fields & Targets:</p>${sections}</div>`
    : '';
};

/**
 * Build single-vendor negotiation fields HTML block (vendor-side email).
 * Vendor only sees their own quoted → target — no other vendor data exposed.
 * Rows where the buyer's target is worse than the vendor's current quote are
 * hidden — there's nothing to negotiate when the ask is already met or beaten.
 */
const buildSingleVendorTargetsHtml = (fields = [], vendorQuote = null, chargeLabels = {}) => {
  const rows = renderFieldRows(fields, vendorQuote, chargeLabels, { hideWorseTargets: true });
  if (!rows) return '';
  return `
    <div style="margin-top:16px; padding:12px 14px; background:#EFF6FF; border-left:4px solid #3B82F6; border-radius:4px;">
      <p style="margin:0 0 6px; font-weight:600; color:#1E40AF;">Negotiation Fields & Targets:</p>
      <p style="margin:0 0 6px; font-size:12px; color:#3B5BA8;">Your Quoted → Target</p>
      <ul style="list-style:none; padding-left:0; margin:0;">${rows}</ul>
    </div>`;
};

/**
 * Send notification when a negotiation round expires while still pending approval.
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email } of the round creator
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationExpiredNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  commercialEvaluators = [],
  companyName = '',
  businessUnitName = '',
  vendorApprovals = [],
  vendorsLookup = {},
  vendorQuotes = {},
  chargeLabels = {}
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round expiry');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Expired — RFQ #${rfqNo}`;

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A negotiation round that was pending approval has now <strong>expired</strong>.
        </p>

        <div style="background-color:#FEF2F2; border-left:4px solid #EF4444; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:#991B1B; font-weight:600;">Round ${round.round_number || ''} — Expired</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Company:</strong> ${companyName || '—'}</li>
          <li style="padding:4px 0;"><strong>Business Unit:</strong> ${businessUnitName || '—'}</li>
          <li style="padding:4px 0;"><strong>Negotiation End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        ${buildVendorTargetsHtml(vendorApprovals, vendorsLookup, vendorQuotes, chargeLabels)}

        <p style="margin-top:16px;">
          A new negotiation round will be needed if you wish to negotiate again on this product.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const ccEmails = commercialEvaluators
      .map(e => e.email)
      .filter(email => email && email !== initiator.email);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      cc: ccEmails.length > 0 ? ccEmails : undefined,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round expired notification for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round expired notification:", err);
    return false;
  }
};

/**
 * Send notification when an active negotiation round ends (end_date reached).
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {number} params.quoteCount - Number of quotes received during the round
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationRoundEndedNotification = async ({
  round,
  rfqNo,
  productName,
  quoteCount = 0,
  commercialEvaluators = [],
  companyName = '',
  businessUnitName = '',
  vendorApprovals = [],
  vendorsLookup = {},
  vendorQuotes = {},
  chargeLabels = {}
}) => {
  try {
    if (!commercialEvaluators || commercialEvaluators.length === 0) {
      logger.debug('No commercial evaluators to notify for negotiation round end');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Ended — RFQ #${rfqNo}`;

    const quotesMessage = quoteCount > 0
      ? `<strong>${quoteCount} quote(s)</strong> were received during this round. Please review the quotes.`
      : `<strong>No quotes</strong> were received during this round. You may run another round or finalize a vendor.`;

    const statusColor = quoteCount > 0 ? '#059669' : '#D97706';
    const statusBg = quoteCount > 0 ? '#ECFDF5' : '#FFFBEB';
    const statusBorder = quoteCount > 0 ? '#10B981' : '#F59E0B';
    const statusText = quoteCount > 0 ? `${quoteCount} Quote(s) Received` : 'No Quotes Received';

    for (const evaluator of commercialEvaluators) {
      const headerContent = `<h2>Hello ${evaluator.name || 'User'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            A negotiation round has <strong>ended</strong> for the following product.
          </p>

          <div style="background-color:${statusBg}; border-left:4px solid ${statusBorder}; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:${statusColor}; font-weight:600;">Round ${round.round_number || ''} — ${statusText}</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
            <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
            <li style="padding:4px 0;"><strong>Company:</strong> ${companyName || '—'}</li>
            <li style="padding:4px 0;"><strong>Business Unit:</strong> ${businessUnitName || '—'}</li>
            <li style="padding:4px 0;"><strong>Negotiation End Date:</strong> ${formatDateIST(round.end_date)}</li>
          </ul>

          ${buildVendorTargetsHtml(vendorApprovals, vendorsLookup, vendorQuotes, chargeLabels)}

          <p style="margin-top:16px;">
            ${quotesMessage}
          </p>

          <div style="text-align:center; margin-top:24px;">
            <a href="${quoteCompareUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Review Quotes
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: evaluator.email,
        subject,
        html: htmlContent
      });
    }

    logger.info(`Sent negotiation round ended notification to ${commercialEvaluators.length} evaluators for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round ended notification:", err);
    return false;
  }
};

/**
 * Send notification to the initiator when a negotiation round is created.
 * Shows either "submitted and waiting for approval" or "auto-approved and live".
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record (with status)
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email }
 * @param {boolean} params.autoApproved - Whether the round was auto-approved
 */
export const sendNegotiationRoundCreatedNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  autoApproved = false,
  companyName = '',
  businessUnitName = '',
  vendorApprovals = [],
  vendorsLookup = {},
  vendorQuotes = {},
  chargeLabels = {}
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round creation');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;

    const subject = autoApproved
      ? `Negotiation Round Live — RFQ #${rfqNo}`
      : `Negotiation Round Submitted — RFQ #${rfqNo}`;

    const statusBg = autoApproved ? '#ECFDF5' : '#EFF6FF';
    const statusBorder = autoApproved ? '#10B981' : '#3B82F6';
    const statusColor = autoApproved ? '#065F46' : '#1E40AF';
    const statusText = autoApproved ? 'Auto-Approved & Live' : 'Submitted — Awaiting Approval';

    const bodyMessage = autoApproved
      ? 'You have <strong>Initiated</strong> a negotiation round which has now been <strong>auto-approved</strong> and is now <strong>live</strong>. Vendors can submit their quotes.'
      : 'You have <strong>Initiated</strong> a negotiation round which has been <strong>submitted</strong> and is <strong>awaiting approval</strong> from the approval committee.';

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>${bodyMessage}</p>

        <div style="background-color:${statusBg}; border-left:4px solid ${statusBorder}; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:${statusColor}; font-weight:600;">Round ${round.round_number || ''} — ${statusText}</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Company:</strong> ${companyName || '—'}</li>
          <li style="padding:4px 0;"><strong>Business Unit:</strong> ${businessUnitName || '—'}</li>
          <li style="padding:4px 0;"><strong>Negotiation End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        ${buildVendorTargetsHtml(vendorApprovals, vendorsLookup, vendorQuotes, chargeLabels)}

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round created notification (autoApproved=${autoApproved}) for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round created notification:", err);
    return false;
  }
};

/**
 * Send notification to selected vendors when a negotiation round becomes active.
 * Each vendor receives an individual email with round details and a link to submit their quote.
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record (with rfq_id, round_number, end_date)
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {string} params.buyerCompanyName - Buyer company name
 * @param {Array} params.vendors - Array of { id, name, email, token }
 */
export const sendNegotiationRoundVendorNotification = async ({
  round,
  rfqNo,
  productName,
  buyerCompanyName,
  vendors = [],
  companyName = '',
  businessUnitName = '',
  chargeLabels = {}
}) => {
  try {
    if (!vendors || vendors.length === 0) {
      logger.debug('No vendors to notify for negotiation round activation');
      return false;
    }

    const subject = `Negotiation Round — RFQ #${rfqNo}`;

    for (const vendor of vendors) {
      const viewUrl = vendor.token
        ? `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${round.rfq_id}&token=${vendor.token}`
        : `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?rfq=${round.rfq_id}`;

      const headerContent = `<h2>Hello ${vendor.name || 'Vendor'},</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
          <p>
            You have been added to a <strong>Negotiation Round</strong> for the following product.
            Please review the details below and submit your revised quote before the deadline.
          </p>

          <div style="background-color:#EFF6FF; border-left:4px solid #3B82F6; padding:12px 16px; margin:16px 0; border-radius:4px;">
            <span style="color:#1E40AF; font-weight:600;">Round ${round.round_number || ''} — Active</span>
          </div>

          <ul style="list-style:none; padding-left:0; margin-top:16px;">
            <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
            <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
            <li style="padding:4px 0;"><strong>Company:</strong> ${companyName || buyerCompanyName || '—'}</li>
            <li style="padding:4px 0;"><strong>Business Unit:</strong> ${businessUnitName || '—'}</li>
            <li style="padding:4px 0;"><strong>Deadline:</strong> ${formatDateIST(round.end_date)}</li>
          </ul>

          ${buildSingleVendorTargetsHtml(vendor.negotiation_fields || [], vendor.quote || null, chargeLabels)}

          <p style="margin-top:16px;">
            Please submit your best offer before <strong>${formatDateIST(round.end_date)}</strong>.
            Quotes submission after the deadline will be restricted.
          </p>

          <div style="text-align:center; margin-top:24px;">
            <a href="${viewUrl}"
               style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
              Submit Quote
            </a>
          </div>

          <p style="text-align:center; margin-top:30px;">
            <strong>— Phileein Hospitality Team</strong>
          </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      sendMail({
        from: config.webmasterMail,
        to: vendor.email,
        subject,
        html: htmlContent
      });
    }

    logger.info(`Sent negotiation round vendor notifications to ${vendors.length} vendors for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round vendor notification:", err);
    return false;
  }
};

/**
 * Send notification when a negotiation round is fully approved and made live.
 * @param {Object} params
 * @param {Object} params.round - The negotiation round record
 * @param {string} params.rfqNo - RFQ number
 * @param {string} params.productName - Product name
 * @param {Object} params.initiator - { name, email } of the round creator
 * @param {Array} params.commercialEvaluators - Array of { name, email }
 */
export const sendNegotiationRoundApprovedNotification = async ({
  round,
  rfqNo,
  productName,
  initiator,
  commercialEvaluators = [],
  companyName = '',
  businessUnitName = '',
  vendorApprovals = [],
  vendorsLookup = {},
  vendorQuotes = {},
  chargeLabels = {}
}) => {
  try {
    if (!initiator || !initiator.email) {
      logger.debug('No initiator to notify for negotiation round approval');
      return false;
    }

    const quoteCompareUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/buyer/quote-compare?rfq=${round.rfq_id}`;
    const subject = `Negotiation Round Approved & Live — RFQ #${rfqNo}`;

    const headerContent = `<h2>Hello ${initiator.name || 'User'},</h2>`;

    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          A negotiation round has been <strong>fully approved</strong> and is now <strong>live</strong>. Vendors can submit their quotes.
        </p>

        <div style="background-color:#ECFDF5; border-left:4px solid #10B981; padding:12px 16px; margin:16px 0; border-radius:4px;">
          <span style="color:#065F46; font-weight:600;">Round ${round.round_number || ''} — Approved & Live</span>
        </div>

        <ul style="list-style:none; padding-left:0; margin-top:16px;">
          <li style="padding:4px 0;"><strong>RFQ Number:</strong> #${rfqNo}</li>
          <li style="padding:4px 0;"><strong>Product:</strong> ${productName}</li>
          <li style="padding:4px 0;"><strong>Company:</strong> ${companyName || '—'}</li>
          <li style="padding:4px 0;"><strong>Business Unit:</strong> ${businessUnitName || '—'}</li>
          <li style="padding:4px 0;"><strong>Negotiation End Date:</strong> ${formatDateIST(round.end_date)}</li>
        </ul>

        ${buildVendorTargetsHtml(vendorApprovals, vendorsLookup, vendorQuotes, chargeLabels)}

        <div style="text-align:center; margin-top:24px;">
          <a href="${quoteCompareUrl}"
             style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View Quote Compare
          </a>
        </div>

        <p style="text-align:center; margin-top:30px;">
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

    const htmlContent = generateEmailTemplate(headerContent, containerContent);

    const ccEmails = commercialEvaluators
      .map(e => e.email)
      .filter(email => email && email !== initiator.email);

    await sendMail({
      from: config.webmasterMail,
      to: initiator.email,
      cc: ccEmails.length > 0 ? ccEmails : undefined,
      subject,
      html: htmlContent
    });

    logger.info(`Sent negotiation round approved notification for RFQ #${rfqNo}, Round ${round.round_number}`);
    return true;
  } catch (err) {
    logError("Error sending negotiation round approved notification:", err);
    return false;
  }
};
