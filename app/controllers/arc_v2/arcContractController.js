import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import rbacModel from '../../models/rbacModel.js';
import arcEvalModel, { normalizeArcCharges } from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractModel from '../../models/arc_v2/arcContractModel.js';
import arcContractClarificationModel from '../../models/arc_v2/arcContractClarificationModel.js';
import arcAmendmentModel from '../../models/arc_v2/arcAmendmentModel.js';
import arcAmendmentDocumentModel from '../../models/arc_v2/arcAmendmentDocumentModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { logger } from '../../util/logger.js';
import pricingEngine from '../../services/pricingEngine.js';
import axios from 'axios';
import crypto from 'crypto';
import puppeteer from 'puppeteer';
import { userCanAccessArc } from '../../helper/arc_v2/arcScope.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * ARC v2 — Contract generation, OTP signature, vendor portal endpoints.
 *
 * Contract generation runs as a post-approval hook from
 * arcCommitteeController.handleArcCommitteeApproval — see plan §5.3 "Contract
 * generation (multi-vendor aware)". The hook groups
 * tbl_arc_comm_evaluation_award rows by awarded_vendor_id and creates one
 * contract per vendor with committed_qty = allocated_qty per line.
 *
 * The contract PDF is rendered with Puppeteer right after the approval tx
 * commits (generateContractPdfsForArc → draft copy) and re-rendered as the
 * signed copy on OTP verification; both are uploaded to S3 and the SHA-256 of
 * the PDF bytes is stored as the integrity hash (source of truth).
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

// Authorization: may this caller read/act on this ARC? Scope derives from the
// ARC ROW (company × hotel × department × process) — never from the client.
// One of four byte-identical copies that wrapped the hotel-blind
// rbacModel.getAllAccessibleHotelIds; all four now share the single
// implementation in helper/arc_v2/arcScope.js.
const userCanAccessHotel = userCanAccessArc;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dFmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

// Indian-system amount-in-words (e.g. "One Lakh Twenty Thousand Rupees Only").
function amountInWords(value) {
  let num = Math.round(Number(value) || 0);
  if (num === 0) return 'Zero Rupees Only';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : ''));
  const three = (n) => { const h = Math.floor(n / 100), r = n % 100; return (h ? a[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : ''); };
  let out = '';
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  if (crore) out += two(crore) + ' Crore ';
  if (lakh) out += two(lakh) + ' Lakh ';
  if (thousand) out += two(thousand) + ' Thousand ';
  if (num) out += three(num);
  return out.trim() + ' Rupees Only';
}

// Phase 2 — engine-based per-line pricing for the contract document.
// Replaces the legacy lineFreight() which used the old {value,type:'pct'|'absolute'}
// shape. Now routes through pricingEngine.calculateLineTotal (same engine the
// vendor's quote preview uses) so the document totals always match the stored quote.
// Returns { base, base_tax, chargesTotal, allIn, chargesDisplay } where:
//   allIn = base + base_tax + chargesTotal  (engine `total`)
//   chargesDisplay = ₹ string for non-zero aggregate freight/charges
function lineEngineOut(l) {
  let charges = l.charges;
  if (typeof charges === 'string') { try { charges = JSON.parse(charges); } catch (_) { charges = null; } }
  const canonicalCharges = normalizeArcCharges(charges);
  const engineInput = {
    unit_price:    Number(l.unit_rate || 0),
    quantity:      1,          // contract doc shows per-unit; qty handled in the row value column
    tax:           Number(l.gst_pct || 0),
    tax_mode:      'percentage',
    other_charges: canonicalCharges.map((c) => ({
      name:        c.name ?? null,
      amount:      Number(c.amount ?? 0),
      amount_mode: (c.amount_mode === 'percentage' || c.amount_mode === '%') ? 'percentage' : 'absolute',
      tax:         (c.tax !== null && c.tax !== undefined && c.tax !== '') ? Number(c.tax) : null,
      tax_mode:    (c.tax_mode === 'percentage' || c.tax_mode === '%') ? 'percentage' : 'absolute',
    })),
  };
  const out = pricingEngine.calculateLineTotal(engineInput);
  const chargesTotal = out.charges_total;
  // Build a human-readable display for the charges column.
  let chargesDisplay = '';
  if (chargesTotal > 0 && out.charges.length > 0) {
    chargesDisplay = out.charges.map((c) => `${c.name || 'Charge'}: ₹${Number(c.amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`).join(', ');
  }
  return {
    base:           out.base,
    base_tax:       out.base_tax,
    chargesTotal,
    allIn:          out.total,  // base + base_tax + all charges (incl. charge taxes)
    chargesDisplay,
  };
}

/**
 * Render the canonical Rate Contract Agreement (HTML → PDF source). Modelled
 * on real government / GeM rate-contract documents: title & reference block,
 * recital, parties, scope & period, a formal Schedule of Rates with amount in
 * words, numbered commercial terms, general terms & conditions (precedence,
 * force majeure, indemnity, dispute resolution, termination, confidentiality),
 * compliance record and a formal execution/signature block. `signed` switches
 * the supplier signature between the OTP-sealed copy and the awaiting draft.
 * The HTML is never persisted — only the rendered PDF is stored in S3.
 */
function renderContractDocumentHtml(ctx, vendor, lines, { signed = false, signedAt = null } = {}) {
  const buyerCity = [ctx.hotel_city, ctx.hotel_state].filter(Boolean).join(', ');
  const buyerOrg = ctx.company_name || 'Workwise Hospitality';
  const buyerPoc = ctx.buyer_name || 'Procurement Lead';
  const eligibility = ctx.eligibility_type === 'open' ? 'open competitive tender' : 'invitation-only tender';
  const escJson = ctx.escalation_clause_json || {};
  const escClause = (!escJson.type || escJson.type === 'none')
    ? 'The rates set out in the Schedule are firm and fixed for the entire contract term. No price escalation, on any account whatsoever, shall be admissible.'
    : (escJson.cap_pct
      ? `Price revision is permitted only on movement of the agreed reference index, capped at ${escJson.cap_pct}% over the term, and is subject to the Purchaser's prior written approval.`
      : 'Price revision is permitted only on movement of the agreed reference index and subject to the Purchaser’s prior written approval.');

  let grand = 0;
  const rows = lines.map((l, i) => {
    const basic = Number(l.unit_rate || 0);
    // Phase 2 — engine-computed per-unit all-in price (base + base_tax + charges).
    const engine = lineEngineOut(l);
    const frtDisplay = engine.chargesTotal > 0 ? inr(engine.chargesTotal) : '—';
    // all-in per unit = engine.allIn (base + tax + charges at qty=1)
    const allInPerUnit = engine.allIn;
    const qty = Number(l.committed_qty || 0);
    const value = allInPerUnit * qty;
    grand += value;
    return `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.variant_name || ('Item #' + l.arc_item_id))}<div class="sub">${esc(l.variant_slug || l.arc_item_id)}</div>${engine.chargesDisplay ? `<div class="sub" style="color:#888;font-size:11px">${esc(engine.chargesDisplay)}</div>` : ''}</td>
      <td class="c">${esc(l.uom || '—')}</td>
      <td class="r">${inr(basic)}</td>
      <td class="r">${frtDisplay}</td>
      <td class="r"><strong>${inr(allInPerUnit)}</strong></td>
      <td class="r">${Number(l.gst_pct ?? 0)}%</td>
      <td class="r">${qty.toLocaleString('en-IN')}</td>
      <td class="r"><strong>${inr(value)}</strong></td>
    </tr>`;
  }).join('');

  const supplierSig = signed
    ? `<div class="sig-cursive">${esc(vendor.name)}</div>
       <div class="sig-seal">✔ Electronically signed &amp; verified via OTP</div>
       <div class="sig-on">On ${dFmt(signedAt || new Date())}</div>`
    : `<div class="sig-pending">— signature pending OTP verification —</div>
       <div class="sig-on">Awaiting supplier execution</div>`;

  const statusBadge = signed
    ? '<span class="badge ok">EXECUTED &middot; SIGNED COPY</span>'
    : '<span class="badge warn">AWAITING SUPPLIER SIGNATURE</span>';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Rate Contract ${esc(ctx.arc_number)} — ${esc(vendor.name)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', 'Liberation Serif', serif; color: #1b1b18; font-size: 11px; line-height: 1.55; margin: 0; }
  .doc { max-width: 820px; margin: 0 auto; }
  .letterhead { text-align: center; border-bottom: 2.5px solid #1b3a2f; padding-bottom: 12px; margin-bottom: 6px; }
  .letterhead .org { font-size: 17px; font-weight: bold; letter-spacing: 0.5px; color: #1b3a2f; }
  .letterhead .sub { font-size: 10px; color: #5c5c55; letter-spacing: 2px; text-transform: uppercase; margin-top: 3px; }
  .title { text-align: center; margin: 18px 0 6px; }
  .title h1 { font-size: 16px; letter-spacing: 1px; text-transform: uppercase; margin: 0; color: #1b1b18; }
  .title .name { font-size: 12px; color: #444; font-style: italic; margin-top: 4px; }
  .refbar { display: flex; justify-content: center; gap: 16px; align-items: center; font-size: 10px; color: #5c5c55; margin: 10px 0 6px; }
  .refbar .ref { font-family: 'Courier New', monospace; color: #1b1b18; }
  .badge { display: inline-block; font-size: 9px; font-weight: bold; letter-spacing: 0.5px; padding: 3px 10px; border-radius: 3px; }
  .badge.ok { background: #e6f4ec; color: #0f5132; border: 1px solid #0f5132; }
  .badge.warn { background: #fdf3e7; color: #8a4b08; border: 1px solid #b5731a; }
  .recital { text-align: justify; margin: 16px 0; font-size: 11px; }
  .recital strong { font-variant: small-caps; }
  .parties { display: flex; gap: 16px; margin: 16px 0; }
  .party { flex: 1; border: 1px solid #cfcfc7; padding: 11px 13px; }
  .party .role { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b62; border-bottom: 1px solid #e3e3db; padding-bottom: 4px; margin-bottom: 6px; }
  .party .nm { font-size: 13px; font-weight: bold; color: #1b1b18; }
  .party .meta { font-size: 10px; color: #4a4a44; margin-top: 4px; line-height: 1.5; }
  h2.sec { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: #1b3a2f; border-bottom: 1px solid #1b3a2f; padding-bottom: 3px; margin: 22px 0 9px; }
  .clause { margin: 8px 0; text-align: justify; }
  .clause .cn { font-weight: bold; }
  table.sch { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
  table.sch th { background: #1b3a2f; color: #fff; padding: 7px 7px; text-align: left; font-weight: bold; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
  table.sch td { padding: 7px 7px; border-bottom: 1px solid #e3e3db; vertical-align: top; }
  table.sch td.r, table.sch th.r { text-align: right; }
  table.sch td.c, table.sch th.c { text-align: center; }
  table.sch td .sub { font-size: 8.5px; color: #8a8a82; font-family: 'Courier New', monospace; margin-top: 1px; }
  table.sch tr.total td { border-top: 2px solid #1b3a2f; border-bottom: none; font-weight: bold; padding-top: 9px; }
  .words { margin-top: 8px; font-style: italic; font-size: 10.5px; color: #1b1b18; border-left: 3px solid #1b3a2f; padding: 4px 10px; background: #f6f7f5; }
  .exec { display: flex; gap: 18px; margin-top: 26px; }
  .exec .box { flex: 1; border: 1px solid #cfcfc7; padding: 14px; min-height: 96px; }
  .exec .box.supplier { border-style: dashed; }
  .exec .role { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b62; }
  .exec .pn { font-size: 12px; font-weight: bold; margin-top: 6px; }
  .exec .po { font-size: 9.5px; color: #5c5c55; }
  .sig-cursive { font-family: 'Brush Script MT', 'Snell Roundhand', cursive; font-size: 24px; color: #0f3d2e; margin-top: 12px; }
  .sig-seal { font-size: 9px; color: #0f5132; font-weight: bold; margin-top: 3px; }
  .sig-on { font-size: 9px; color: #5c5c55; margin-top: 2px; }
  .sig-pending { font-size: 10px; color: #8a4b08; font-style: italic; margin-top: 18px; }
  .integrity { margin-top: 22px; border-top: 1px dashed #cfcfc7; padding-top: 8px; font-size: 8.5px; color: #6b6b62; font-family: 'Courier New', monospace; word-break: break-all; }
  .foot { margin-top: 10px; text-align: center; font-size: 8.5px; color: #9a9a92; }
</style></head>
<body><div class="doc">

  <div class="letterhead">
    <div class="org">${esc(buyerOrg)}</div>
    <div class="sub">Procurement &middot; Rate Contract Division</div>
  </div>

  <div class="title">
    <h1>Annual Rate Contract Agreement</h1>
    <div class="name">${esc(ctx.title || '')}</div>
  </div>
  <div class="refbar">
    <span>Contract Ref: <span class="ref">${esc(ctx.arc_number)}</span></span>
    <span>&middot;</span>
    <span>Issued: ${dFmt(ctx.arc_created_at || new Date())}</span>
    <span>&middot;</span>
    ${statusBadge}
  </div>

  <p class="recital">This <strong>Annual Rate Contract</strong> (the &ldquo;Contract&rdquo;) is made and entered into at ${esc(buyerCity || 'the registered office')} on ${dFmt(signed ? (signedAt || new Date()) : (ctx.contract_start_at || new Date()))}, <strong>between</strong> ${esc(buyerOrg)}${ctx.hotel_name ? ', ' + esc(ctx.hotel_name) : ''} (hereinafter the &ldquo;Purchaser&rdquo;), of the one part, <strong>and</strong> ${esc(vendor.name)} (hereinafter the &ldquo;Supplier&rdquo;), of the other part. <strong>Whereas</strong> the Purchaser invited offers through an ${eligibility} for the supply of goods under the category &ldquo;${esc(ctx.category_title || 'procurement')}&rdquo;, and the Supplier&rsquo;s offer having been technically qualified and commercially accepted by the Purchaser&rsquo;s award committee, the parties agree to be bound by the terms set out below.</p>

  <div class="parties">
    <div class="party">
      <div class="role">Purchaser</div>
      <div class="nm">${esc(buyerOrg)}</div>
      <div class="meta">${ctx.hotel_name ? esc(ctx.hotel_name) + '<br/>' : ''}${buyerCity ? esc(buyerCity) + '<br/>' : ''}Authorised signatory: <strong>${esc(buyerPoc)}</strong>${ctx.buyer_designation ? ', ' + esc(ctx.buyer_designation) : ''}<br/>GSTIN: N/A</div>
    </div>
    <div class="party">
      <div class="role">Supplier</div>
      <div class="nm">${esc(vendor.name)}</div>
      <div class="meta">Registered supplier${vendor.email ? '<br/>' + esc(vendor.email) : ''}<br/>Authorised signatory: <strong>${esc(vendor.name)}</strong><br/>GSTIN: ${esc(vendor.gstin || 'N/A')}</div>
    </div>
  </div>

  <h2 class="sec">1. Scope &amp; Contract Period</h2>
  <div class="clause"><span class="cn">1.1</span> The Supplier shall supply the goods listed in the Schedule of Rates (Clause 2) to the Purchaser at the Business Unit <strong>${esc(ctx.hotel_name || 'specified')}</strong>, against call-off purchase orders raised from time to time during the contract period.</div>
  <div class="clause"><span class="cn">1.2</span> This Contract is valid from <strong>${dFmt(ctx.contract_start_at)}</strong> to <strong>${dFmt(ctx.contract_end_at)}</strong> (both days inclusive) and is <strong>non-auto-renewing</strong>. The Purchaser retains a 10% emergency-procurement carve-out outside this Contract.</div>
  <div class="clause"><span class="cn">1.3</span> The quantities stated are indicative annual estimates; the Purchaser undertakes no minimum off-take and shall be liable only for goods actually called off.</div>

  <h2 class="sec">2. Schedule of Rates &amp; Quantities</h2>
  <table class="sch">
    <thead><tr>
      <th class="c">#</th><th>Item / Specification</th><th class="c">UOM</th>
      <th class="r">Basic Rate</th><th class="r">Freight</th><th class="r">Awarded Rate</th>
      <th class="r">GST</th><th class="r">Indic. Qty</th><th class="r">Value (excl. tax)</th>
    </tr></thead>
    <tbody>
      ${rows}
      <tr class="total"><td colspan="8" class="r">Total committed value (exclusive of taxes)</td><td class="r">${inr(grand)}</td></tr>
    </tbody>
  </table>
  <div class="words">Total committed value in words: <strong>${amountInWords(grand)}</strong> (exclusive of applicable taxes).</div>
  <div class="clause" style="margin-top:8px;font-size:10px;color:#5c5c55;">Rates are inclusive of freight and all delivery charges (FOR / DDP destination) save where a freight component is shown separately above, and are exclusive of GST, which shall be charged extra as applicable and reimbursed against valid tax invoices.</div>

  <h2 class="sec">3. Commercial Terms</h2>
  <div class="clause"><span class="cn">3.1 Payment.</span> ${esc(ctx.payment_terms_expected || 'As mutually agreed')} from receipt of goods (GRN) at the receiving Business Unit, against valid invoices raised per call-off purchase order quoting the correct HSN code for each line.</div>
  <div class="clause"><span class="cn">3.2 Delivery &amp; lead time.</span> ${esc(ctx.delivery_expected || 'As agreed per line.')} Partial deliveries are acceptable; each consignment shall be accompanied by a packing list, lot/batch number and the requisite quality/OC certificate.</div>
  <div class="clause"><span class="cn">3.3 Penalty / Liquidated Damages.</span> ${esc(ctx.penalty_clause || 'Liquidated damages for delay and quality rejection shall apply as per the Purchaser’s standard policy.')} Such damages are a genuine pre-estimate of loss and are recoverable from any sums due to the Supplier.</div>
  <div class="clause"><span class="cn">3.4 Price escalation.</span> ${escClause}</div>
  <div class="clause"><span class="cn">3.5 Quality &amp; performance.</span> All goods shall conform strictly to the agreed specifications and approved samples. Goods rejected on quality grounds shall be replaced at the Supplier&rsquo;s cost within the agreed cure period, failing which the Purchaser may procure substitutes at the Supplier&rsquo;s risk and cost.</div>

  <h2 class="sec">4. General Terms &amp; Conditions</h2>
  <div class="clause"><span class="cn">4.1 Order of precedence.</span> In the event of conflict, the executed call-off purchase order shall prevail over this Contract, which in turn shall prevail over any prior correspondence or the Supplier&rsquo;s standard terms.</div>
  <div class="clause"><span class="cn">4.2 Force majeure.</span> Neither party shall be liable for failure or delay caused by events beyond reasonable control (acts of God, war, civil disturbance, statutory restriction or pandemic), provided the affected party gives prompt written notice and uses best efforts to mitigate.</div>
  <div class="clause"><span class="cn">4.3 Indemnity.</span> The Supplier shall indemnify and keep the Purchaser indemnified against all losses, claims and liabilities arising from defective goods, infringement of third-party rights, or breach of this Contract by the Supplier.</div>
  <div class="clause"><span class="cn">4.4 Confidentiality.</span> Each party shall keep confidential all non-public information disclosed under this Contract and use it solely for performance hereof.</div>
  <div class="clause"><span class="cn">4.5 Termination &amp; exit.</span> Either party may terminate for material breach on thirty (30) days&rsquo; written notice if the breach remains uncured. On termination, all open call-off purchase orders shall be honoured at the contracted rates, and the Supplier shall provide a 90-day transition support window.</div>
  <div class="clause"><span class="cn">4.6 Dispute resolution &amp; governing law.</span> This Contract is governed by the laws of India. Disputes shall first be referred to good-faith negotiation between authorised representatives; failing resolution within thirty (30) days, the dispute shall be referred to arbitration by a sole arbitrator under the Arbitration and Conciliation Act, 1996, the seat being ${esc(ctx.hotel_city || 'the Purchaser’s registered office')}, and the courts there having exclusive jurisdiction.</div>
  <div class="clause"><span class="cn">4.7 Amendment.</span> No amendment to this Contract is valid unless made through the Purchaser&rsquo;s formal amendment workflow and accepted by both parties.</div>

  <h2 class="sec">5. Compliance &amp; Documents on Record</h2>
  <div class="clause">The Supplier&rsquo;s compliance documents verified and held on record at the time of award: GST registration certificate; ISO / quality certification; MSME / Udyam registration (where applicable); PAN &amp; CIN; bank-account verification (penny-drop); and sample approval by the Purchaser&rsquo;s commercial evaluator.</div>

  <h2 class="sec">6. Execution</h2>
  <div class="clause" style="font-size:10px;">In witness whereof the parties have caused this Contract to be executed by their duly authorised representatives. The Purchaser&rsquo;s signature is affixed on award-committee approval; the Supplier&rsquo;s signature is affixed by one-time-password (OTP) verification, which the parties agree constitutes a valid electronic signature.</div>
  <div class="exec">
    <div class="box">
      <div class="role">For and on behalf of the Purchaser</div>
      <div class="sig-cursive">${esc(buyerPoc)}</div>
      <div class="sig-seal">✔ Approved by award committee</div>
      <div class="pn">${esc(buyerPoc)}</div>
      <div class="po">${esc(ctx.buyer_designation || 'Authorised Signatory')}, ${esc(buyerOrg)}</div>
    </div>
    <div class="box supplier">
      <div class="role">For and on behalf of the Supplier</div>
      ${supplierSig}
      <div class="pn">${esc(vendor.name)}</div>
      <div class="po">Authorised Signatory</div>
    </div>
  </div>

  <div class="integrity">Document integrity — SHA-256 of this PDF is sealed onto the contract record as the authoritative signature artefact. Contract Ref ${esc(ctx.arc_number)} · ${esc(vendor.name)} · ${signed ? 'Signed copy' : 'Draft pending signature'}.</div>
  <div class="foot">This is a system-generated rate contract document. ${esc(buyerOrg)} · generated electronically.</div>

</div></body></html>`;
}

/**
 * Generate the contract PDF via Puppeteer, upload it to S3, and return the
 * stored URL plus the SHA-256 of the exact PDF bytes — the integrity hash is
 * the source of truth for the signed artefact. Throws on any failure so the
 * caller can decide how to handle it (generation is best-effort; signing falls
 * back to a content hash if PDF/S3 is unavailable).
 */
export async function generateContractPdf(ctx, vendor, lines, contractId, { signed = false, signedAt = null, htmlOverride = null } = {}) {
  // htmlOverride lets the addendum flow reuse this Puppeteer→S3→hash pipeline
  // with its own delta template instead of the rate-contract template.
  const html = htmlOverride || renderContractDocumentHtml(ctx, vendor, lines, { signed, signedAt });
  const tmpPath = path.join(os.tmpdir(), `arc-contract-${contractId}-${signed ? 'signed' : 'draft'}-${Date.now()}.pdf`);
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: tmpPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    await browser.close();
    browser = null;

    const pdfBuffer = fs.readFileSync(tmpPath);
    const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const s3Key = `arc-contract/${ctx.arc_number || 'ARC'}-${contractId}-${signed ? 'signed' : 'draft'}-${Date.now()}.pdf`;
    const up = await uploadToS3(tmpPath, s3Key);
    return { url: up?.url || null, hash };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } }
    try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
  }
}

// Fetch the ARC + buyer scope a contract document needs (one query per ARC).
export async function loadContractDocContext(arcId, runner = db) {
  return runner.oneOrNone(
    `SELECT a.id AS arc_id, a.arc_number, a.title, a.created_at AS arc_created_at,
            a.contract_start_at, a.contract_end_at, a.eligibility_type,
            a.payment_terms_expected, a.delivery_expected, a.penalty_clause, a.escalation_clause_json,
            cat.title AS category_title,
            h.name AS hotel_name, h.city AS hotel_city, h.state AS hotel_state,
            hc.name AS company_name,
            u.name AS buyer_name, u.designation AS buyer_designation, u.email AS buyer_email
       FROM tbl_arc a
       LEFT JOIN tbl_category cat ON cat.id = a.category_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
       LEFT JOIN tbl_users u ON u.id = a.created_by
      WHERE a.id = $1`,
    [arcId]
  );
}

/**
 * Internal helper called by the committee post-approval hook. Returns the
 * generated contract rows.
 */
export async function generateContractsForArc(arcId, { txContext, generatedBy }) {
  const t = txContext || db;
  const comm = await arcEvalModel.getCommEval(arcId, t);
  if (!comm) throw new Error(`Cannot generate contracts: no comm eval for ARC ${arcId}`);
  const awards = await arcEvalModel.listAwards(comm.id, t);

  // Group by awarded_vendor_id.
  const groups = new Map();
  for (const a of awards) {
    if (!groups.has(a.awarded_vendor_id)) groups.set(a.awarded_vendor_id, []);
    groups.get(a.awarded_vendor_id).push(a);
  }

  const arc = await arcModel.getById(arcId, t);
  const acceptanceWindow = new Date();
  acceptanceWindow.setDate(acceptanceWindow.getDate() + 7); // default 7-day window
  const contracts = [];

  // On a clarification-driven REGENERATION a sibling vendor on this ARC may
  // already have signed (split award). Their contract is immutable — never
  // reset it back to awaiting_acceptance. Skip those vendors entirely; only the
  // vendor whose award was re-edited gets a fresh draft.
  const existing = await arcContractModel.listForArc(arcId, t);
  const lockedVendors = new Set(
    existing.filter((c) => c.status === 'active').map((c) => Number(c.vendor_id))
  );

  for (const [vendorId, vendorAwards] of groups) {
    if (lockedVendors.has(Number(vendorId))) continue; // preserve signed sibling
    const contract = await arcContractModel.createContract({
      arc_id:          arcId,
      vendor_id:       vendorId,
      // The draft PDF is rendered + uploaded to S3 right after this tx commits
      // (generateContractPdfsForArc) — kept out of the tx so a slow render
      // never holds the approval transaction open.
      document_s3_url: null,
      awaiting_until:  acceptanceWindow,
    }, t);

    for (const award of vendorAwards) {
      // Pull rate/charges from the awarded quote line snapshot.
      const snapshot = typeof award.awarded_quote_snapshot === 'string'
        ? JSON.parse(award.awarded_quote_snapshot)
        : (award.awarded_quote_snapshot || {});
      await arcContractModel.addLine(contract.id, {
        arc_item_id:            award.arc_item_id,
        unit_rate:              snapshot.rate ?? 0,
        gst_pct:                snapshot.gst_pct ?? null,
        charges:                snapshot.charges || [],
        payment_terms:          snapshot.payment_terms ?? arc.payment_terms_expected ?? null,
        delivery_terms:         snapshot.delivery_terms ?? arc.delivery_expected ?? null,
        committed_qty:          award.allocated_qty,
        awarded_quote_snapshot: snapshot,
      }, t);
    }
    contracts.push(contract);
  }
  return contracts;
}

/**
 * Render + store the draft (awaiting-signature) PDF for every contract on an
 * ARC. Best-effort and OUTSIDE any transaction — call AFTER the committee
 * approval tx commits. A render/S3 failure logs and is swallowed so it never
 * blocks contract generation; the document simply stays pending until retried
 * (e.g. on signing, which always re-renders the signed copy).
 */
export async function generateContractPdfsForArc(arcId) {
  // Never launch a headless browser / hit S3 inside the test harness.
  if (process.env.NODE_ENV === 'test') return;
  try {
    const ctx = await loadContractDocContext(arcId);
    if (!ctx) return;
    const contracts = await arcContractModel.listForArc(arcId);
    for (const c of contracts) {
      if (c.document_s3_url) continue; // already rendered
      try {
        const lines = await arcContractModel.listLines(c.id);
        const { url, hash } = await generateContractPdf(ctx, { name: c.vendor_name, email: c.vendor_email }, lines, c.id, { signed: false });
        await arcContractModel.setDocument(c.id, { url, hash });
        logger.info({ contractId: c.id, url }, '[arcContract] draft PDF generated');
      } catch (perErr) {
        logger.error({ perErr, contractId: c.id }, '[arcContract] draft PDF generation failed (will retry on signing)');
      }
    }
  } catch (err) {
    logger.error({ err, arcId }, '[arcContract.generateContractPdfsForArc]');
  }
}

// ============================================================
// Vendor portal endpoints — review + OTP-sign
// ============================================================

export async function getPendingAcceptance(req, res) {
  try {
    const vendorId = req.user?.id;
    const contracts = await arcContractModel.listForVendor(vendorId, ['awaiting_acceptance']);
    return ok(res, { contracts });
  } catch (err) {
    logger.error({ err }, '[contractController.getPendingAcceptance]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getVendorActiveContracts(req, res) {
  try {
    const vendorId = req.user?.id;
    // Approved-and-live plus the archive: the page's tabs filter between
    // active / expiring / expired client-side.
    const contracts = await arcContractModel.listForVendor(vendorId, ['active','expiring_soon','expired']);
    return ok(res, { contracts });
  } catch (err) {
    logger.error({ err }, '[contractController.getVendorActiveContracts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getContractDetail(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    // Tenant guard — a vendor can only read their own contract.
    if (Number(contract.vendor_id) !== Number(vendorUserId)) {
      return bad(res, 403, 'Not the contracted vendor');
    }

    const [lines, arcInfo, callOffs, amendments] = await Promise.all([
      arcContractModel.listLines(id),
      // ARC context the detail page's hero/doc sections need: term, category,
      // BU, escalation, eligibility, and the buyer contact (creator).
      db.oneOrNone(
        `SELECT a.id AS arc_id, a.arc_number, a.title, a.status AS arc_status,
                a.contract_start_at, a.contract_end_at,
                a.payment_terms_expected, a.delivery_expected, a.penalty_clause,
                a.escalation_clause_json, a.eligibility_type,
                cat.title AS category_title,
                h.name    AS hotel_name, h.city AS hotel_city,
                hc.name   AS company_name,
                u.name    AS buyer_name, u.email AS buyer_email, u.designation AS buyer_designation
           FROM tbl_arc a
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
           LEFT JOIN tbl_users u ON u.id = a.created_by
          WHERE a.id = $1`,
        [contract.arc_id]
      ),
      // Call-off POs issued against this contract.
      db.any(
        `SELECT cp.id AS call_off_id, cp.po_id, cp.quantity, cp.price_applied, cp.released_at,
                po.po_number, po.status AS po_status, po.total_value,
                cl.arc_item_id, pv.name AS variant_name, ai.uom
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract_line cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
          WHERE cp.arc_contract_id = $1
          ORDER BY cp.released_at DESC`,
        [id]
      ),
      // The vendor's amendment requests on this contract (any status), with
      // buyer-side edit history joined. Shaped through vendorView below so
      // approver identities reduce to numbered levels before leaving the API.
      db.any(
        `SELECT am.id, am.amendment_type, am.amendment_from, am.amendment_to,
                am.status, am.reason, am.payload, am.current_step,
                am.approval_chain, am.created_at, am.decided_at,
                ad.id AS addendum_id, ad.status AS addendum_status,
                ad.addendum_number, ad.document_s3_url AS addendum_url,
                COALESCE(eh.edits, '[]'::json) AS edit_history
           FROM tbl_arc_amendment am
           LEFT JOIN tbl_arc_amendment_document ad ON ad.arc_amendment_id = am.id
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'field_changed', e.field_changed,
                      'before_value',  e.before_value,
                      'after_value',   e.after_value,
                      'changed_by',    e.changed_by,
                      'changed_at',    e.changed_at,
                      'comment',       e.comment
                    ) ORDER BY e.changed_at, e.id) AS edits
               FROM tbl_arc_amendment_edit_history e
              WHERE e.arc_amendment_id = am.id
           ) eh ON TRUE
          WHERE am.arc_contract_id = $1
          ORDER BY am.created_at DESC`,
        [id]
      ).catch((err) => {
        if (/relation .* does not exist/i.test(err.message)) return [];
        throw err;
      }),
    ]);
    // Pre-signature clarifications (open + resolved) so the accept page shows
    // pending disputes and, on re-review, how the buyer revised / upheld each.
    const clarifications = await arcContractClarificationModel
      .listForContract(id)
      .catch((err) => {
        if (/relation .* does not exist/i.test(err.message)) return [];
        throw err;
      });
    return ok(res, {
      contract, lines, arc: arcInfo, callOffs,
      amendments: amendments.map(arcAmendmentModel.vendorView),
      clarifications,
    });
  } catch (err) {
    logger.error({ err }, '[contractController.getContractDetail]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function requestOtp(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    if (contract.status !== 'awaiting_acceptance') return bad(res, 409, `Contract not awaiting acceptance (status=${contract.status})`);
    const { code, expiresAt } = await arcContractModel.createOtp(id, vendorUserId);
    await logArcEvent({
      arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED,
      actorId: vendorUserId, payload: { contract_id: id, expires_at: expiresAt },
    });
    // In-app OTP confirmation to the vendor (not email — OTP is its own channel)
    await notifyArcEvent({
      arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED,
      actorId: null, payload: { vendorId: vendorUserId },
    });
    // The OTP would normally be sent via SMS + email helpers. For now return it
    // in dev only (the SMS/email helpers expect tenant SMTP/SMS config).
    const exposeInPayload = process.env.NODE_ENV !== 'production';
    return ok(res, { otp_expires_at: expiresAt, dev_code: exposeInPayload ? code : undefined });
  } catch (err) {
    logger.error({ err }, '[contractController.requestOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function verifyOtp(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const code = req.body?.code;
    if (!code) return bad(res, 400, 'code is required');
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    const result = await arcContractModel.verifyOtp(id, vendorUserId, code);
    if (!result.ok) return bad(res, 400, `OTP verification failed: ${result.reason}`);

    // Render the SIGNED PDF, upload to S3 and hash its bytes — that hash is the
    // legal source of truth, sealed onto the contract. Done OUTSIDE the tx so a
    // slow render doesn't hold it open. If Puppeteer/S3 is unavailable the
    // signing still completes with a deterministic content hash as fallback.
    const signedAt = new Date();
    let documentHash = null;
    let documentUrl = null;
    if (process.env.NODE_ENV !== 'test') {
      try {
        const ctx = await loadContractDocContext(contract.arc_id);
        const lines = await arcContractModel.listLines(id);
        const pdf = await generateContractPdf(ctx, { name: contract.vendor_name, email: contract.vendor_email }, lines, id, { signed: true, signedAt });
        documentHash = pdf.hash;
        documentUrl = pdf.url;
      } catch (pdfErr) {
        logger.error({ pdfErr, contractId: id }, '[contractController.verifyOtp] signed PDF generation failed — falling back to content hash');
      }
    }
    if (!documentHash) {
      // Fallback: hash the canonical contract content so a hash always exists.
      const lines = await arcContractModel.listLines(id);
      documentHash = crypto.createHash('sha256')
        .update(JSON.stringify({ contract_id: id, vendor_id: vendorUserId, signed_at: signedAt.toISOString(), lines }))
        .digest('hex');
    }

    const updated = await db.tx(async (t) => {
      const row = await arcContractModel.setStatus(id, 'active', {
        document_hash: documentHash,
        document_s3_url: documentUrl || undefined,
        signed_by_vendor_at: signedAt,
      }, t);
      await logArcEvent({
        arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_SIGNED,
        actorId: vendorUserId, payload: { contract_id: id, hash: documentHash },
        txContext: t,
      });
      // Promote the ARC to contract_active when every contract on this ARC is signed.
      const remaining = await t.one(
        `SELECT COUNT(*)::int AS c FROM tbl_arc_contract WHERE arc_id = $1 AND status != 'active'`,
        [contract.arc_id]
      );
      let allSigned = false;
      if (remaining.c === 0) {
        await arcModel.setStatus(contract.arc_id, 'contract_active', {}, t);
        await logArcEvent({
          arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_ACTIVE,
          actorId: vendorUserId, payload: {}, txContext: t,
        });
        allSigned = true;
      }
      return { row, allSigned };
    });
    // respond AFTER the commit — never inside db.tx, or the caller can read
    // pre-commit state on its next request (raced the signed→active flip).
    // Notify creator + comm evaluators (BOTH email) + vendor in-app
    await notifyArcEvent({
      arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_SIGNED,
      actorId: vendorUserId, payload: { vendorId: vendorUserId },
    });
    if (updated.allSigned) {
      await notifyArcEvent({ arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_ACTIVE, actorId: vendorUserId, payload: {} });
    }
    return ok(res, { contract: updated.row }, 'Contract signed');
  } catch (err) {
    logger.error({ err }, '[contractController.verifyOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function declineContract(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const reason = req.body?.reason || null;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    // respond AFTER the commit — never inside db.tx, or the caller can read
    // pre-commit state on its next request (mirrors verifyOtp above).
    const updated = await db.tx(async (t) => {
      const row = await arcContractModel.setStatus(id, 'declined', { terminated_reason: reason }, t);
      await logArcEvent({
        arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_DECLINED,
        actorId: vendorUserId, payload: { contract_id: id, reason }, txContext: t,
      });
      return row;
    });
    ok(res, { contract: updated }, 'Contract declined');
    // Notify creator + comm evaluators (BOTH email) post-commit
    await notifyArcEvent({ arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_DECLINED, actorId: vendorUserId, payload: {} });
  } catch (err) {
    logger.error({ err }, '[contractController.declineContract]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// POST /v1/arc-v2/vendor/contracts/:contractId/clarification
//   Body: { items: [{ arc_contract_line_id, field, comment }] }
//   Vendor disputes one field per awarded line BEFORE signing. This rolls the
//   ARC back to the commercial stage (red / "clarification needed"): the
//   committee approval is cancelled, the commercial eval reopens (sent_back),
//   and the contract parks in 'clarification' until the evaluator resolves
//   every dispute and re-finalises. Signing is blocked throughout.
// ============================================================
const CLARIFY_FIELD_COL = {
  base_price: 'unit_rate', gst: 'gst_pct', charges: 'charges',
  committed_qty: 'committed_qty', payment_terms: 'payment_terms', delivery_terms: 'delivery_terms',
};

export async function requestClarification(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!id) return bad(res, 400, 'contractId is required');
    if (!vendorUserId) return bad(res, 401, 'Authentication required');
    if (!items || items.length === 0) return bad(res, 400, 'items[] with at least one disputed line is required');

    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (Number(contract.vendor_id) !== Number(vendorUserId)) return bad(res, 403, 'Not the contracted vendor');
    if (contract.status !== 'awaiting_acceptance') {
      return bad(res, 409, `Clarifications can only be raised while the contract is awaiting acceptance (status=${contract.status})`);
    }

    // NOTE: on a split award a sibling vendor may already be signed (active).
    // That's fine — the clarification only re-edits THIS vendor's award, and
    // contract regeneration preserves any already-active sibling contract
    // (see generateContractsForArc — it skips active vendors).

    // Validate each disputed line belongs to this contract and capture the
    // current value of the disputed field (so the dispute records a baseline).
    const lines = await arcContractModel.listLines(id);
    const lineById = new Map(lines.map((l) => [Number(l.id), l]));
    const prepared = [];
    for (const it of items) {
      const line = lineById.get(Number(it.arc_contract_line_id));
      if (!line) return bad(res, 400, `Line ${it.arc_contract_line_id} is not on this contract`);
      const field = String(it.field || '');
      if (!CLARIFY_FIELD_COL[field]) return bad(res, 400, `Unknown disputed field '${field}'`);
      const comment = String(it.comment || '').trim();
      if (!comment) return bad(res, 400, 'Each disputed line needs a comment explaining the concern');
      prepared.push({
        arc_item_id: line.arc_item_id,
        field,
        vendor_comment: comment,
        old_value: line[CLARIFY_FIELD_COL[field]] ?? null,
      });
    }

    const result = await db.tx(async (t) => {
      const round = await arcContractClarificationModel.nextRound(id, t);
      const created = await arcContractClarificationModel.createMany(
        contract.arc_id, id, vendorUserId, prepared, vendorUserId, round, t
      );

      // SURGICAL by design — awarded means awarded. We do NOT de-finalise the
      // commercial evaluation, cancel the committee, or re-open the allocation
      // matrix. Other vendors' awards (incl. already-signed ones) are untouched.
      // Only THIS contract parks in 'clarification'; the commercial evaluator
      // can solely revise the disputed value or uphold it (no re-allocation),
      // after which the change flows forward through a fresh awarding approval.
      await arcContractModel.setStatus(id, 'clarification', {}, t);
      await logArcEvent({
        arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CLARIFICATION_REQUESTED,
        actorId: vendorUserId,
        payload: { contract_id: id, round, fields: prepared.map((p) => p.field), count: created.length },
        txContext: t,
      });
      return { clarifications: created, round };
    });

    // Notify creator + comm evaluators (BOTH email) post-commit
    await notifyArcEvent({ arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CLARIFICATION_REQUESTED, actorId: vendorUserId, payload: {} });
    return ok(res, result, 'Clarification raised — routed to the commercial evaluator');
  } catch (err) {
    logger.error({ err }, '[contractController.requestClarification]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// GET /v1/arc-v2/contracts/:contractId/vendor-documents
//   Buyer-side: collect the contracted vendor's uploaded compliance documents
//   (GST, PAN, MSME, FSSAI, cancelled cheque) so the active page can offer a
//   one-click "documents bundle". We fetch each S3 object server-side (no
//   browser CORS) and return the bytes base64-encoded; the client zips them.
//   URLs come from our own tbl_vendor_documents — not request input.
// ============================================================
const VDOC_LABEL = {
  pan: 'PAN', gst: 'GST_Certificate', msme: 'MSME_Udyam',
  fssai: 'FSSAI_License', cancelled_cheque: 'Cancelled_Cheque',
};
function extFromDocUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m = p.match(/\.([a-zA-Z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

export async function getVendorDocumentsBundle(req, res) {
  try {
    const contractId = Number(req.params.contractId);
    const contract = await arcContractModel.getById(contractId);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    // Tenant isolation: this endpoint returns the vendor's KYC/bank documents
    // (PAN/GST/MSME/FSSAI/cancelled-cheque). Gate on the contract's ARC hotel —
    // never trust the contractId alone (sequential ids → trivially enumerable).
    const contractArc = await arcModel.getById(contract.arc_id);
    if (!contractArc || !(await userCanAccessHotel(req, contractArc))) {
      return bad(res, 403, 'You do not have access to this contract', 3);
    }
    const vendorId = contract.vendor_id;

    const docs = await db.any(
      `SELECT document_type, document_number, document_url
         FROM tbl_vendor_documents
        WHERE vendor_id = $1
          AND document_type IN ('pan','gst','msme','fssai','cancelled_cheque')
          AND document_url IS NOT NULL AND document_url <> ''
        ORDER BY document_type`,
      [vendorId]
    );

    const files = [];
    for (const d of docs) {
      const ext = extFromDocUrl(d.document_url) || 'pdf';
      const num = d.document_number ? '_' + String(d.document_number).replace(/[^a-zA-Z0-9_-]/g, '') : '';
      const filename = `${VDOC_LABEL[d.document_type] || d.document_type}${num}.${ext}`;
      try {
        const resp = await axios.get(d.document_url, {
          responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024,
        });
        files.push({
          document_type: d.document_type, document_number: d.document_number, filename,
          content_type: resp.headers['content-type'] || 'application/octet-stream',
          content_base64: Buffer.from(resp.data).toString('base64'),
        });
      } catch (e) {
        logger.warn({ err: e.message, contractId, document_type: d.document_type },
          '[contractController.getVendorDocumentsBundle] document fetch failed');
        files.push({ document_type: d.document_type, filename, error: true });
      }
    }
    return ok(res, { vendor_name: contract.vendor_name, vendor_id: vendorId, files });
  } catch (err) {
    logger.error({ err }, '[contractController.getVendorDocumentsBundle]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Buyer-side: consumption rollup for the active dashboard
// ============================================================

export async function getActiveSummary(req, res) {
  try {
    const arcId = Number(req.params.id);
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    // Tenant isolation: active-summary exposes contracts, call-off PO prices,
    // amendment price changes, and buyer PII — gate on the ARC's own hotel_id
    // (super-admin bypass), never trust the id alone.
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }

    // Enrich ARC with display labels the active page needs in its hero.
    const [enrichedArc, contracts, events, callOffs, amendments, addendums] = await Promise.all([
      db.oneOrNone(
        `SELECT a.*,
                cat.title    AS category_title,
                h.name       AS hotel_name,
                h.city       AS hotel_city,
                hc.name      AS company_name,
                d.title      AS department_title,
                u.name       AS buyer_name,
                u.email      AS buyer_email,
                u.designation AS buyer_designation
           FROM tbl_arc a
           LEFT JOIN tbl_category               cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_hospitality_companies  hc  ON hc.id = h.hospitality_company_id
           LEFT JOIN tbl_department             d   ON d.id = a.department_id
           LEFT JOIN tbl_users                  u   ON u.id = a.created_by
          WHERE a.id = $1`,
        [arcId]
      ),
      arcContractModel.listForArc(arcId),
      db.any(
        `SELECT el.id, el.event_type, el.actor_id, el.payload, el.at,
                u.name AS actor_name
           FROM tbl_arc_event_log el
           LEFT JOIN tbl_users u ON u.id = el.actor_id
          WHERE el.arc_id = $1
          ORDER BY el.at DESC
          LIMIT 50`,
        [arcId]
      ),
      // Every call-off PO released against any contract of this ARC.
      // Joined to PO, MR, contract-line and variant so the front-end can
      // render the list without a second round-trip.
      db.any(
        `SELECT cp.id           AS call_off_id,
                cp.po_id,
                cp.mr_id,
                cp.arc_contract_id,
                cp.arc_contract_line_id,
                cp.quantity,
                cp.price_applied,
                cp.released_at,
                po.po_number,
                po.status        AS po_status,
                po.total_value,
                po.finalized_vendor_id AS vendor_id,
                u.name           AS vendor_name,
                mr.mr_number,
                mr.title         AS mr_title,
                cl.arc_item_id,
                ai.product_variant_id,
                pv.name          AS variant_name,
                ai.uom
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract       c  ON c.id  = cp.arc_contract_id
           JOIN tbl_arc_contract_line  cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item           ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
           LEFT JOIN tbl_material_requisition mr ON mr.id = cp.mr_id
           LEFT JOIN tbl_users u ON u.id = po.finalized_vendor_id
          WHERE c.arc_id = $1
          ORDER BY cp.released_at DESC`,
        [arcId]
      ),
      // Amendments for every contract under this ARC (Active + Requested).
      // Joined with the contract so the FE can group them per-vendor, plus
      // the per-amendment edit history (buyer counter-offers) so the review
      // modal's Edit-history tab renders without a second round-trip.
      db.any(
        `SELECT am.*,
                c.vendor_id,
                u.name AS requested_by_name,
                v.name AS vendor_name,
                COALESCE(eh.edits, '[]'::json) AS edit_history
           FROM tbl_arc_amendment am
           JOIN tbl_arc_contract  c ON c.id = am.arc_contract_id
           LEFT JOIN tbl_users u ON u.id = am.requested_by
           LEFT JOIN tbl_users v ON v.id = c.vendor_id
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'id',             e.id,
                      'field_changed',  e.field_changed,
                      'before_value',   e.before_value,
                      'after_value',    e.after_value,
                      'changed_by',     e.changed_by,
                      'changed_by_name', eu.name,
                      'comment',        e.comment,
                      'changed_at',     e.changed_at
                    ) ORDER BY e.changed_at DESC, e.id DESC) AS edits
               FROM tbl_arc_amendment_edit_history e
               LEFT JOIN tbl_users eu ON eu.id = e.changed_by
              WHERE e.arc_amendment_id = am.id
           ) eh ON TRUE
          WHERE c.arc_id = $1
          ORDER BY am.created_at DESC`,
        [arcId]
      ).catch((err) => {
        // Migration may not be applied yet — degrade gracefully, but log
        // loudly: a silent [] here hides "table missing" from the UI.
        if (/relation .* does not exist|column .* does not exist/i.test(err.message)) {
          logger.warn({ err: err.message },
            '[contractController.getActiveSummary] amendments query degraded to [] — apply the amendment migrations (tbl_arc_amendment / tbl_arc_amendment_edit_history)');
          return [];
        }
        throw err;
      }),
      // Addendum documents (per-amendment re-signing artefacts) for every
      // contract under this ARC — the documents tab lists them alongside the
      // original signed contract, never overwriting it.
      arcAmendmentDocumentModel.listForArc(arcId).catch((err) => {
        if (/relation .* does not exist|column .* does not exist/i.test(err.message)) {
          logger.warn({ err: err.message },
            '[contractController.getActiveSummary] addendums query degraded to [] — apply migration 20260615100100_arc_amendment_document');
          return [];
        }
        throw err;
      }),
    ]);

    const summary = await Promise.all(contracts.map(async (c) => ({
      contract:    c,
      consumption: await arcContractModel.consumptionForContract(c.id),
    })));
    return ok(res, { arc: enrichedArc || arc, contracts: summary, events, callOffs, amendments, addendums });
  } catch (err) {
    logger.error({ err }, '[contractController.getActiveSummary]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
