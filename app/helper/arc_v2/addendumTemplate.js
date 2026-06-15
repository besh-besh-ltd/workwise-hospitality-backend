// Renders the per-amendment Addendum document (delta + reference to original).
// Mirrors the rate-contract template's letterhead/box/integrity styling but
// states ONLY the change this amendment makes — it never restates the whole
// contract. The original signed contract document is left untouched.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtDate = (d) => {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return `${String(x.getDate()).padStart(2, '0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][x.getMonth()]} ${x.getFullYear()}`;
};

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

// Build the human-readable change clause from amendment type + payload. Reads
// the post-edit payload, so a buyer counter-offer (edit-then-approve) is what
// the vendor sees and signs.
export function summariseAmendment(am, lineLabel = null) {
  const p = am.payload && typeof am.payload === 'object'
    ? am.payload
    : (am.payload ? JSON.parse(am.payload) : {});
  const target = lineLabel ? `“${lineLabel}”` : `contract line #${p.arc_contract_line_id}`;
  const window = `effective ${fmtDate(am.amendment_from)}${am.amendment_to ? ` through ${fmtDate(am.amendment_to)}` : ''}`;
  switch (am.amendment_type) {
    case 'price':
      return `The unit rate for ${target} is revised to ${inr(p.new_rate)}, ${window}.`;
    case 'qty':
      return `The committed quantity for ${target} is revised to ${Number(p.new_qty).toLocaleString('en-IN')}, ${window}.`;
    case 'item_add':
      return `A new line is added (variant #${p.product_variant_id}) at ${inr(p.new_rate)} for quantity ${Number(p.new_qty).toLocaleString('en-IN')}, ${window}.`;
    case 'item_remove':
      return `Contract line #${p.arc_contract_line_id} is removed, effective ${fmtDate(am.amendment_from)}.`;
    case 'term':
      return `The contract term is extended; the new contract end date is ${fmtDate(am.amendment_from)}.`;
    default:
      return `Amendment of type ${esc(am.amendment_type)}, effective ${fmtDate(am.amendment_from)}.`;
  }
}

export function renderAddendumHtml(am, ctx, vendor, { addendumNumber, changeSummary, signed = false, signedAt = null }) {
  const buyerOrg = ctx.company_name || 'Purchaser';
  const supplierSig = signed
    ? `<div class="sig-mark">✔ Electronically signed &amp; verified via OTP</div><div class="sig-on">On ${esc(fmtDate(signedAt))}</div>`
    : `<div class="sig-pending">Pending vendor signature</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a;font-size:12px;margin:0}
  .wrap{padding:28px 34px}
  .lh{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px}
  .lh .org{font-size:18px;font-weight:700}
  h1{font-size:16px;margin:18px 0 4px}
  .ref{color:#555;font-size:11px;margin-bottom:14px}
  .recital{background:#f7f7f9;border:1px solid #e3e3e8;border-radius:6px;padding:12px 14px;margin:14px 0;line-height:1.5}
  .change{border-left:3px solid #111;padding:10px 14px;margin:14px 0;font-weight:600}
  .boxes{display:flex;gap:16px;margin-top:26px}
  .box{flex:1;border:1px solid #ccc;border-radius:6px;padding:12px}
  .role{font-size:10px;text-transform:uppercase;color:#777;letter-spacing:.04em}
  .pn{font-weight:600;margin-top:18px}
  .sig-mark{color:#0a7d2c;font-weight:600;margin-top:8px}
  .sig-on{font-size:10px;color:#555;margin-top:2px}
  .sig-pending{color:#a15c00;font-style:italic;margin-top:8px}
  .integrity{margin-top:22px;font-size:10px;color:#666}
  .foot{margin-top:8px;font-size:10px;color:#999}
</style></head><body><div class="wrap">
  <div class="lh"><div class="org">${esc(buyerOrg)}</div></div>
  <h1>Addendum No. ${esc(addendumNumber)} to Rate Contract ${esc(ctx.arc_number)}</h1>
  <div class="ref">Original contract: ${esc(ctx.arc_number)} — ${esc(ctx.title || '')} · Supplier: ${esc(vendor.name)}</div>
  <div class="recital">This Addendum is made to the Rate Contract referenced above between ${esc(buyerOrg)} (“Purchaser”) and ${esc(vendor.name)} (“Supplier”). All other terms of the original Rate Contract remain in full force and effect except as expressly modified below.</div>
  <div class="change">${esc(changeSummary)}</div>
  <div class="boxes">
    <div class="box"><div class="role">For and on behalf of the Purchaser</div><div class="pn">${esc(ctx.buyer_name || 'Authorised Signatory')}</div></div>
    <div class="box"><div class="role">For and on behalf of the Supplier</div>${supplierSig}<div class="pn">${esc(vendor.name)}</div></div>
  </div>
  <div class="integrity">Document integrity — SHA-256 of this PDF is sealed onto the addendum record as the authoritative signature artefact. Addendum ${esc(addendumNumber)} · ${esc(ctx.arc_number)} · ${signed ? 'Signed copy' : 'Draft pending signature'}.</div>
  <div class="foot">System-generated addendum. ${esc(buyerOrg)} · generated electronically.</div>
</div></body></html>`;
}
