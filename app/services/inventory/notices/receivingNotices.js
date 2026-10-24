// Receiving notices (spec §10 "Notifications").
//
//   GRN posted / reversed → PO initiator (in-app → the GRN) and vendor (in-app
//                           → the vendor PO's deliveries tab), each with an
//                           email listing accepted / rejected per line
//   GRN rejections        → vendor email only, the rejected lines and reasons
//   short-close / reopen  → vendor and PO initiator (not the initiator when
//                           they did it themselves)
//   RTV dispatched        → vendor (in-app + email)
//
// The initiator is the PO's initiated_by, else the raiser of the MR a call-off
// PO came from; the vendor is finalized_vendor_id. Only active users get
// anything.
//
// Call AFTER the posting transaction commits, with `db` (or a test's
// transaction): the in-app rows go through notificationService.dispatch on
// the global connection. None of these functions throws; a notice problem
// never turns a finished receipt into an error. Each call is tracked so tests
// can wait for fire-and-forget calls with drainReceivingNotices().

import db from '../../../config/dbConn.js';
import config from '../../../config/app.config.js';
import { sendMail, logError } from '../../../helper/common.js';
import { generateEmailTemplate, emailButton } from '../../../helper/notificationEmailLayout.js';
import { dispatch } from '../../notificationService.js';
import {
  inventoryGrn, inventoryPoDeliveries, vendorPoDeliveries, toAbsoluteUrl,
} from '../../notificationLinks.js';
import { loadGrnDocument, loadRtvDocument, formatQty } from '../grnPdf.js';
import { listShortCloses } from '../shortCloseService.js';

const CATEGORY = 'grn';

export const SHORT_CLOSE_REASON_LABELS = Object.freeze({
  vendor_cannot_supply: 'Vendor cannot supply',
  no_longer_needed: 'No longer needed',
  substituted: 'Substituted',
  price_dispute: 'Price dispute',
  other: 'Other',
});

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** (conn, args) with conn optional: notify(t, args), notify(null, args), notify(args). */
function normalize(conn, args) {
  if (conn && typeof conn.oneOrNone === 'function') return [conn, args ?? {}];
  if (args === undefined && conn && typeof conn === 'object') return [db, conn];
  return [db, args ?? {}];
}

// ─── In-flight tracking ─────────────────────────────────────────────────────

const inFlight = new Set();

function track(label, fn) {
  const p = (async () => {
    try {
      await fn();
    } catch (err) {
      logError(`receivingNotices.${label} failed`, err);
    }
  })();
  inFlight.add(p);
  p.then(() => inFlight.delete(p));
  return p;
}

/** Resolves once every notice started so far has settled. Tests only. */
export async function drainReceivingNotices() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

// ─── Delivery helpers ───────────────────────────────────────────────────────

/** Active users by id → {id, name, email}. */
async function activeUsers(conn, ids) {
  const list = [...new Set(ids.map(positiveInt).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await conn.any(
    `SELECT id, name, email FROM tbl_users
      WHERE id = ANY($1::int[]) AND status = 1 AND COALESCE(is_deleted, 0) = 0`,
    [list]
  );
  return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), name: r.name ?? '', email: r.email ?? null }]));
}

/** One in-app notice to one user. */
const notifyInApp = (userId, { type, title, body, data, actionUrl }) =>
  dispatch({ userIds: [userId], category: CATEGORY, type, title, body, data, actionUrl });

/** A small HTML table for emails; cells are escaped. */
function mailTable(headers, rows, { numeric = [] } = {}) {
  const align = (i) => (numeric.includes(i) ? 'right' : 'left');
  const th = headers
    .map((h, i) => `<th style="text-align:${align(i)}; padding:6px 8px; background:#F3F4F6; border:1px solid #E5E7EB; font-size:13px;">${esc(h)}</th>`)
    .join('');
  const trs = rows
    .map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${align(i)}; padding:6px 8px; border:1px solid #E5E7EB; font-size:13px;">${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%; margin:12px 0;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function mailHtml({ name, heading, paragraphs = [], table = '', url, cta }) {
  const header = `<h2>Hello ${esc(name || '')},</h2>`;
  const body = `
    <div style="font-size:15px; font-family:'Roboto', sans-serif; color:#333;">
      <div style="background-color:#DBEAFE; border-left:4px solid #3B82F6; padding:14px 16px; margin:16px 0; border-radius:4px;">
        <p style="margin:0; font-weight:600; color:#1E3A8A;">${esc(heading)}</p>
      </div>
      ${paragraphs.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}
      ${table}
      ${url ? `<div style="text-align:center; margin-top:24px;">${emailButton(url, esc(cta))}</div>` : ''}
      <p style="text-align:center; margin-top:30px;"><strong>— Phileein Hospitality Team</strong></p>
    </div>`;
  return generateEmailTemplate(header, body);
}

/** Send one email; failures are logged, never thrown. */
async function mail(user, subject, html) {
  if (!user?.email) return;
  try {
    await Promise.resolve(sendMail({ from: config.webmasterMail, to: user.email, subject, html }));
  } catch (err) {
    logError('receivingNotices email failed', err);
  }
}

const poLabel = (n, id) => (n ? `PO ${n}` : `PO #${id}`);

// ─── GRN posted ─────────────────────────────────────────────────────────────

function grnLinesTable(doc) {
  return mailTable(
    ['Item', 'Unit', 'Received', 'Accepted', 'Rejected', 'Reason'],
    doc.lines.map((l) => [
      l.productName ?? '', l.unit ?? '', formatQty(l.received), formatQty(l.accepted), formatQty(l.rejected),
      l.rejectionLabel ?? '',
    ]),
    { numeric: [2, 3, 4] }
  );
}

/**
 * GRN posted (or a reversal posted): initiator + vendor, in-app and email.
 * @param {object} t connection (db after commit, or a test transaction)
 * @param {{grnId:number}} args
 * @returns {Promise<void>} never rejects
 */
export function notifyGrnPosted(t, args) {
  const [conn, { grnId } = {}] = normalize(t, args);
  return track('notifyGrnPosted', async () => {
    const id = positiveInt(grnId);
    if (!id) return;
    const doc = await loadGrnDocument(conn, id);
    if (doc.status === 'draft') return;

    const po = poLabel(doc.poNumber, doc.poId);
    const grnNo = doc.grnNumber ?? `GRN #${doc.grnId}`;
    const hotel = doc.hotel.name ?? 'the hotel';
    const counts = doc.isReversal
      ? `${formatQty(Math.abs(doc.totals.accepted))} reversed`
      : `${formatQty(doc.totals.accepted)} accepted, ${formatQty(doc.totals.rejected)} rejected`;
    const type = doc.isReversal ? 'GRN_REVERSED' : 'GRN_POSTED';
    const verb = doc.isReversal ? 'Goods receipt reversed' : 'Goods received';
    const body = `${grnNo} at ${hotel} against ${po}: ${counts}.`;
    const data = { po_id: doc.poId, grn_id: doc.grnId };
    const challan = doc.vendorChallanNo ? `Vendor challan: ${doc.vendorChallanNo}.` : null;
    const table = grnLinesTable(doc);
    const users = await activeUsers(conn, [doc.recipients.initiatorId, doc.recipients.vendorId]);

    const initiator = users.get(doc.recipients.initiatorId);
    if (initiator) {
      const link = inventoryGrn(doc.grnId);
      const title = `${verb}: ${grnNo} for ${po}`;
      await notifyInApp(initiator.id, { type, title, body, data, actionUrl: link });
      await mail(initiator, `${grnNo}: ${verb.toLowerCase()} against ${po}`, mailHtml({
        name: initiator.name, heading: title, paragraphs: [body, challan], table,
        url: toAbsoluteUrl(link), cta: 'Open the goods receipt',
      }));
    }

    const vendor = users.get(doc.recipients.vendorId);
    if (vendor) {
      const link = vendorPoDeliveries(doc.poId);
      const title = `${verb} against ${po} at ${hotel}`;
      await notifyInApp(vendor.id, { type, title, body, data, actionUrl: link });
      await mail(vendor, `${grnNo}: ${verb.toLowerCase()} against ${po}`, mailHtml({
        name: vendor.name, heading: title, paragraphs: [body, challan], table,
        url: toAbsoluteUrl(link), cta: 'Open the deliveries',
      }));
    }
  });
}

/**
 * GRN rejections: the vendor gets an email listing only the rejected lines
 * with their reasons. Nothing when nothing was rejected (or for a reversal).
 */
export function notifyGrnRejections(t, args) {
  const [conn, { grnId } = {}] = normalize(t, args);
  return track('notifyGrnRejections', async () => {
    const id = positiveInt(grnId);
    if (!id) return;
    const doc = await loadGrnDocument(conn, id);
    if (doc.status === 'draft' || doc.isReversal || !doc.hasRejections) return;
    const users = await activeUsers(conn, [doc.recipients.vendorId]);
    const vendor = users.get(doc.recipients.vendorId);
    if (!vendor) return;

    const po = poLabel(doc.poNumber, doc.poId);
    const grnNo = doc.grnNumber ?? `GRN #${doc.grnId}`;
    const rejected = doc.lines.filter((l) => (l.rejected || 0) > 0);
    const heading = `${formatQty(doc.totals.rejected)} rejected on ${grnNo} (${po})`;
    await mail(vendor, `${grnNo}: items rejected on ${po}`, mailHtml({
      name: vendor.name,
      heading,
      paragraphs: [
        `${doc.hotel.name ?? 'The hotel'} rejected part of the delivery against ${po}. The rejected lines and reasons are below.`,
        doc.vendorChallanNo ? `Vendor challan: ${doc.vendorChallanNo}.` : null,
      ],
      table: mailTable(
        ['Item', 'Unit', 'Received', 'Rejected', 'Reason', 'Remarks'],
        rejected.map((l) => [
          l.productName ?? '', l.unit ?? '', formatQty(l.received), formatQty(l.rejected), l.rejectionLabel ?? '', l.remarks ?? '',
        ]),
        { numeric: [2, 3] }
      ),
      url: toAbsoluteUrl(vendorPoDeliveries(doc.poId)),
      cta: 'Open the deliveries',
    }));
  });
}

// ─── Short-close ────────────────────────────────────────────────────────────

/**
 * Short-close (or reopen) of PO quantities: vendor and initiator, in-app and
 * email. The initiator is skipped when they did it themselves.
 * @param {{poId:number, shortCloseIds:number[]}} args tbl_po_short_close ids
 */
export function notifyShortClose(t, args) {
  const [conn, { poId, shortCloseIds } = {}] = normalize(t, args);
  return track('notifyShortClose', async () => {
    const id = positiveInt(poId);
    const ids = Array.isArray(shortCloseIds) ? shortCloseIds.map(positiveInt).filter(Boolean) : [];
    if (!id || !ids.length) return;
    const rows = await listShortCloses(conn, id, { ids });
    if (!rows.length) return;
    const po = await conn.oneOrNone(
      `SELECT po.id, po.po_number, po.finalized_vendor_id, COALESCE(po.initiated_by, mr.raised_by) AS initiator_id
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
        WHERE po.id = $1`,
      [id]
    );
    if (!po) return;

    const reopen = rows.every((r) => r.action === 'reopen');
    const poText = poLabel(po.po_number, id);
    const type = reopen ? 'PO_SHORT_CLOSE_REOPENED' : 'PO_SHORT_CLOSED';
    const total = rows.reduce((s, r) => s + r.qty, 0);

    // "7 UP PEPSI 1.5 LTR 10 kg" per PO line, in first-seen order.
    const perLine = new Map();
    for (const r of rows) {
      const cur = perLine.get(r.poLineId) ?? { name: r.productName ?? 'Item', unit: r.unit ?? '', qty: 0 };
      cur.qty += r.qty;
      perLine.set(r.poLineId, cur);
    }
    const summary = [...perLine.values()].map((l) => `${l.name} ${formatQty(l.qty)}${l.unit ? ` ${l.unit}` : ''}`).join('; ');
    const reasons = [...new Set(rows.map((r) => r.reasonCode).filter(Boolean))]
      .map((c) => SHORT_CLOSE_REASON_LABELS[c] ?? c);
    const title = reopen
      ? `Short-closed quantities reopened on ${poText}`
      : `${poText}: ${formatQty(total)} short-closed`;
    const body = reopen
      ? `${summary} reopened on ${poText} and expected again.`
      : `${summary} will no longer be delivered on ${poText}.${reasons.length ? ` Reason: ${reasons.join(', ')}.` : ''}`;
    const data = { po_id: id, short_close_ids: rows.map((r) => r.id) };
    const table = mailTable(
      ['Item', 'Unit', 'Delivery', 'Qty', 'Reason', 'Remarks'],
      rows.map((r) => [
        r.productName ?? '', r.unit ?? '',
        `${r.hotelName ? `${r.hotelName}, ` : ''}Phase ${r.phaseNo}`,
        formatQty(r.qty),
        r.reasonCode ? (SHORT_CLOSE_REASON_LABELS[r.reasonCode] ?? r.reasonCode) : (reopen ? 'Reopened' : ''),
        r.remarks ?? '',
      ]),
      { numeric: [3] }
    );
    const subject = reopen ? `${poText}: short-closed quantities reopened` : `${poText}: quantities short-closed`;

    const actors = new Set(rows.map((r) => r.actedBy).filter(Boolean));
    const initiatorId = positiveInt(po.initiator_id);
    const vendorId = positiveInt(po.finalized_vendor_id);
    const users = await activeUsers(conn, [initiatorId, vendorId]);

    const vendor = users.get(vendorId);
    if (vendor) {
      const link = vendorPoDeliveries(id);
      await notifyInApp(vendor.id, { type, title, body, data, actionUrl: link });
      await mail(vendor, subject, mailHtml({
        name: vendor.name, heading: title, paragraphs: [body], table, url: toAbsoluteUrl(link), cta: 'Open the deliveries',
      }));
    }
    const initiator = initiatorId && !actors.has(initiatorId) ? users.get(initiatorId) : null;
    if (initiator) {
      const link = inventoryPoDeliveries(id);
      await notifyInApp(initiator.id, { type, title, body, data, actionUrl: link });
      await mail(initiator, subject, mailHtml({
        name: initiator.name, heading: title, paragraphs: [body], table, url: toAbsoluteUrl(link), cta: 'Open the deliveries',
      }));
    }
  });
}

// ─── RTV dispatched ─────────────────────────────────────────────────────────

/** RTV dispatched: the vendor, in-app and email, with the lines and reasons. */
export function notifyRtvDispatched(t, args) {
  const [conn, { rtvId } = {}] = normalize(t, args);
  return track('notifyRtvDispatched', async () => {
    const id = positiveInt(rtvId);
    if (!id) return;
    const doc = await loadRtvDocument(conn, id);
    if (doc.status === 'draft' || doc.status === 'cancelled') return;
    const users = await activeUsers(conn, [doc.recipients.vendorId]);
    const vendor = users.get(doc.recipients.vendorId);
    if (!vendor) return;

    const po = poLabel(doc.poNumber, doc.poId);
    const rtvNo = doc.rtvNumber ?? `RTV #${doc.rtvId}`;
    const hotel = doc.consignor.name ?? 'The hotel';
    const purpose = doc.disposition === 'CREDIT' ? 'against a credit note' : 'for replacement';
    const title = `Goods returned to you: ${rtvNo} on ${po}`;
    const body = `${hotel} is returning ${doc.lines.length} line${doc.lines.length === 1 ? '' : 's'} `
      + `from ${doc.grnNumber ?? 'a goods receipt'} ${purpose}.`;
    const link = vendorPoDeliveries(doc.poId);
    await notifyInApp(vendor.id, {
      type: 'RTV_DISPATCHED', title, body, data: { po_id: doc.poId, rtv_id: doc.rtvId }, actionUrl: link,
    });
    await mail(vendor, `${rtvNo}: goods returned on ${po}`, mailHtml({
      name: vendor.name,
      heading: title,
      paragraphs: [
        body,
        doc.challanNo ? `Gate pass / challan: ${doc.challanNo}.` : null,
        doc.disposition === 'CREDIT'
          ? 'Please issue a credit note for these goods.'
          : 'Please send a replacement for these goods.',
      ],
      table: mailTable(
        ['Item', 'Unit', 'Qty', 'Reason'],
        doc.lines.map((l) => [l.productName ?? '', l.unit ?? '', formatQty(l.qty), l.reason ?? '']),
        { numeric: [2] }
      ),
      url: toAbsoluteUrl(link),
      cta: 'Open the deliveries',
    }));
  });
}

export default {
  notifyGrnPosted, notifyGrnRejections, notifyShortClose, notifyRtvDispatched, drainReceivingNotices,
  SHORT_CLOSE_REASON_LABELS,
};
