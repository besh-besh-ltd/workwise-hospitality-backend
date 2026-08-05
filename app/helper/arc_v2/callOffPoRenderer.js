import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import puppeteer from 'puppeteer';
import db from '../../config/dbConn.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { logger } from '../../util/logger.js';

/**
 * Call-off Purchase Order document renderer (audit CO10).
 *
 * A call-off PO draws down an already-signed Annual Rate Contract, so its
 * document is a crisp dispatch note — buyer/vendor parties, the originating ARC
 * + MR references, the contracted line items at their resolved rates, and the
 * value summary — NOT the full rate-contract template. Mirrors the
 * Puppeteer→S3 pipeline used by the ARC contract renderer.
 *
 * The HTML is never persisted — only the rendered PDF is stored in S3.
 */

function inr(n) {
  const v = Number(n || 0);
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Pure, deterministic HTML for a call-off PO. `ctx` shape:
 *   { po: { po_number, total_value, created_at },
 *     buyer: { company_name, hotel_name },
 *     vendor: { name, email },
 *     arc: { arc_number, arc_title, mr_number },
 *     lines: [{ product_name, quantity, unit, unit_price, gst_pct, total_price }] }
 */
export function renderCallOffPoHtml(ctx) {
  const po = ctx.po || {};
  const buyer = ctx.buyer || {};
  const vendor = ctx.vendor || {};
  const arc = ctx.arc || {};
  const lines = Array.isArray(ctx.lines) ? ctx.lines : [];

  const subtotal = lines.reduce((s, l) => s + Number(l.total_price || 0), 0);
  const rows = lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.product_name || '—')}</td>
      <td class="r">${Number(l.quantity || 0)} ${esc(l.unit || '')}</td>
      <td class="r">${inr(l.unit_price)}</td>
      <td class="r">${l.gst_pct != null ? `${Number(l.gst_pct)}%` : '—'}</td>
      <td class="r">${inr(l.total_price)}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Georgia','Times New Roman',serif; color:#1a1a1a; font-size:12px; margin:0; }
    .doc { padding: 8px 4px; }
    .hd { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1a1a1a; padding-bottom:10px; }
    .hd h1 { font-size:20px; margin:0 0 2px; letter-spacing:0.5px; }
    .tag { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#666; }
    .ref { text-align:right; font-size:11px; }
    .ref b { font-size:13px; }
    .parties { display:flex; gap:24px; margin:16px 0; }
    .party { flex:1; border:1px solid #ddd; border-radius:6px; padding:10px 12px; }
    .party .lbl { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:#888; margin-bottom:4px; }
    .party .nm { font-weight:bold; font-size:13px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; }
    th { background:#1a1a1a; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; padding:7px 8px; text-align:left; }
    td { padding:7px 8px; border-bottom:1px solid #eee; }
    td.c, th.c { text-align:center; } td.r, th.r { text-align:right; }
    .totals { margin-top:12px; margin-left:auto; width:260px; }
    .totals div { display:flex; justify-content:space-between; padding:4px 0; }
    .totals .grand { border-top:2px solid #1a1a1a; font-weight:bold; font-size:14px; padding-top:6px; }
    .note { margin-top:18px; font-size:10px; color:#666; border-top:1px solid #eee; padding-top:8px; line-height:1.5; }
  </style></head><body><div class="doc">
    <div class="hd">
      <div>
        <h1>Call-off Purchase Order</h1>
        <div class="tag">Drawn against Annual Rate Contract</div>
      </div>
      <div class="ref">
        <div><b>${esc(po.po_number || '—')}</b></div>
        <div>Released: ${fmtDate(po.created_at)}</div>
        <div>ARC: ${esc(arc.arc_number || '—')}</div>
        <div>Req: ${esc(arc.mr_number || '—')}</div>
      </div>
    </div>
    <div class="parties">
      <div class="party"><div class="lbl">Buyer</div>
        <div class="nm">${esc(buyer.company_name || '—')}</div>
        <div>${esc(buyer.hotel_name || '')}</div>
      </div>
      <div class="party"><div class="lbl">Supplier</div>
        <div class="nm">${esc(vendor.name || '—')}</div>
        <div>${esc(vendor.email || '')}</div>
      </div>
    </div>
    <table>
      <thead><tr><th class="c">#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">GST</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="c">No line items</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>${inr(subtotal)}</span></div>
      <div class="grand"><span>Total</span><span>${inr(po.total_value != null ? po.total_value : subtotal)}</span></div>
    </div>
    <div class="note">
      Rates are governed by the referenced Annual Rate Contract. This call-off
      is released on approval of the originating material requisition and is
      subject to the supplier's acceptance. Delivery and payment terms follow
      the master contract.
    </div>
  </div></body></html>`;
}

/** Load the document context for a released call-off PO. */
export async function loadCallOffPoContext(poId, runner = db) {
  const head = await runner.oneOrNone(
    `SELECT po.id AS po_id, po.po_number, po.total_value, po.created_at,
            v.name AS vendor_name, v.email AS vendor_email,
            a.arc_number, a.title AS arc_title,
            h.name AS hotel_name, hc.name AS company_name,
            mr.mr_number
       FROM tbl_rfq_purchase_order po
       JOIN tbl_arc_contract c ON c.id = po.arc_contract_id
       JOIN tbl_arc a ON a.id = c.arc_id
       LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
       LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE po.id = $1`,
    [poId]
  );
  if (!head) return null;
  const lines = await runner.any(
    `SELECT pop.quantity, pop.unit, pop.unit_price, pop.total_price,
            cl.gst_pct, pv.name AS product_name
       FROM tbl_purchase_order_product pop
       LEFT JOIN tbl_product_variant pv ON pv.id = pop.product_variant_id
       LEFT JOIN tbl_arc_contract_line cl ON cl.id = pop.arc_contract_line_id
      WHERE pop.purchase_order_id = $1
      ORDER BY pop.id`,
    [poId]
  );
  return {
    po: { po_number: head.po_number, total_value: head.total_value, created_at: head.created_at },
    buyer: { company_name: head.company_name, hotel_name: head.hotel_name },
    vendor: { name: head.vendor_name, email: head.vendor_email },
    arc: { arc_number: head.arc_number, arc_title: head.arc_title, mr_number: head.mr_number },
    lines,
  };
}

/**
 * Render the call-off PO PDF via Puppeteer, upload to S3, and persist
 * po_pdf_url. Best-effort + test-gated: never launches a browser / hits S3 in
 * the test harness, and any failure is swallowed (logged) so it can't undo the
 * already-committed release.
 */
export async function generateCallOffPoPdf(poId) {
  if (process.env.NODE_ENV === 'test') return null;
  const tmpPath = path.join(os.tmpdir(), `calloff-po-${poId}-${Date.now()}.pdf`);
  let browser = null;
  try {
    const ctx = await loadCallOffPoContext(poId);
    if (!ctx) return null;
    const html = renderCallOffPoHtml(ctx);
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
    const s3Key = `call-off-po/${ctx.po.po_number || poId}-${Date.now()}.pdf`;
    const up = await uploadToS3(tmpPath, s3Key);
    const url = up?.url || null;
    if (url) {
      await db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1, updated_at = NOW() WHERE id = $2`, [url, poId]);
    }
    return { url, hash };
  } catch (err) {
    logger.error({ err, poId }, '[callOffPoRenderer.generateCallOffPoPdf] failed (non-fatal)');
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } }
    try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
  }
}
