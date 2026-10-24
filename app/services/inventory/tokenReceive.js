// Site-rep token receiving (spec §10.3, task C5): what a receive-link holder
// may see and do. The holder is someone at the hotel with an emailed link and
// no account. receiveTokenAuth has already checked the link is live (not
// expired, revoked, or on a dead or long-closed PO) and set req.receiveToken.
//
// Everything here is bound to that token: its PO, its hotel, and the GRNs it
// posted itself. Ids from the request are never authority:
//   - the PO is always the token's (a different poId in a body is NOT_FOUND);
//   - the hotel is always the token's (a body hotelId is overridden);
//   - attachments go only onto GRNs this token posted.
// Every payload passes through redactForReceiveToken (no price, cost, value,
// tax or buyer-contact key at any depth). Drafts are not offered to a token:
// it posts straight away, and the buyer's drafts at the hotel stay hidden.

import { InventoryError } from './errors.js';
import {
  getReceiveContext,
  postGrn,
  addGrnAttachment,
  assertGrnAttachmentAccess,
  attachmentUrl,
  SITE_REP_ACTOR,
} from './grnService.js';
import { getPoContext } from './planCore.js';
import { RECEIVE_TOKEN_TTL_DAYS } from '../../helper/receiveToken.js';
import { redactForReceiveToken } from '../../helper/receiveTokenView.js';

const notFound = (what = 'Purchase order not found') => new InventoryError('NOT_FOUND', what);

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The token's PO and hotel as service arguments. A hotel-less legacy link on a
 * multi-hotel PO (hotelId null) cannot receive anywhere: CONFLICT TOKEN_NO_HOTEL.
 */
function tokenBinding(receiveToken) {
  const tokenId = positiveInt(receiveToken?.tokenId);
  const poId = positiveInt(receiveToken?.poId);
  if (!tokenId || !poId) throw notFound();
  const hotelId = positiveInt(receiveToken.hotelId);
  if (!hotelId) {
    throw new InventoryError(
      'CONFLICT',
      "This link isn't tied to a hotel. Ask the buyer to send you a new link.",
      { reason: 'TOKEN_NO_HOTEL' }
    );
  }
  return { tokenId, poId, hotelId, viaToken: { tokenId, hotelId } };
}

/** PO_NOT_RECEIVABLE → the reason shown to the rep. */
function notReceivableReason(err) {
  if (err?.details?.receiptStatus === 'received') return 'received';
  if (err?.details?.receiptStatus === 'closed_short') return 'closed_short';
  return 'not_ready';
}

const isNotReceivable = (err) =>
  err instanceof InventoryError && err.code === 'CONFLICT' && err.details?.reason === 'PO_NOT_RECEIVABLE';

/**
 * When the link stops working: its own expiry, or 24 hours after the last
 * posted GRN once the PO is fully received or short-closed (the grace B6's
 * LIVE_TOKEN_SQL allows for attaching paperwork). ISO string.
 */
async function linkExpiresAt(t, tokenId, poId) {
  const row = await t.one(
    `SELECT LEAST(
              COALESCE(tl.expires_at, tl.created_at + interval '${RECEIVE_TOKEN_TTL_DAYS} days'),
              CASE WHEN po.receipt_status IN ('received', 'closed_short')
                   THEN (SELECT MAX(g.posted_at) FROM tbl_grn g WHERE g.po_id = po.id AND g.posted_at IS NOT NULL)
                        + interval '24 hours'
              END
            ) AS expires_at
       FROM tbl_token_login_data tl
       JOIN tbl_rfq_purchase_order po ON po.id = tl.entity_id
      WHERE tl.id = $1 AND tl.entity_id = $2`,
    [tokenId, poId]
  );
  return row.expires_at ? new Date(row.expires_at).toISOString() : null;
}

/**
 * Attachments the token itself added to its GRNs (uploaded_by is NULL for a
 * token upload). A buyer's upload on the same GRN, a priced vendor invoice for
 * instance, is never listed back to the link.
 */
async function tokenAttachments(t, grnIds) {
  if (!grnIds.length) return new Map();
  const rows = await t.any(
    `SELECT id, grn_id, file_name, kind, s3_key FROM tbl_grn_attachment
      WHERE grn_id = ANY($1::int[]) AND uploaded_by IS NULL
      ORDER BY id`,
    [grnIds]
  );
  const byGrn = new Map();
  for (const r of rows) {
    const key = Number(r.grn_id);
    if (!byGrn.has(key)) byGrn.set(key, []);
    byGrn.get(key).push({ id: Number(r.id), fileName: r.file_name, kind: r.kind, url: attachmentUrl(r.s3_key) });
  }
  return byGrn;
}

/** The receipts this token posted (newest first), for attaching paperwork afterwards. */
async function tokenReceipts(t, tokenId) {
  const rows = await t.any(
    `SELECT g.id, g.grn_number, g.status, g.received_at::text AS received_at, g.posted_at,
            (SELECT COUNT(*) FROM tbl_grn_line gl WHERE gl.grn_id = g.id)::int AS line_count
       FROM tbl_grn g
      WHERE g.received_by_token_id = $1 AND g.doc_type = 'RECEIPT' AND g.status <> 'draft'
      ORDER BY g.posted_at DESC NULLS LAST, g.id DESC`,
    [tokenId]
  );
  const files = await tokenAttachments(t, rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    grnNumber: r.grn_number,
    status: r.status,
    receivedAt: r.received_at,
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
    lineCount: Number(r.line_count),
    attachments: files.get(Number(r.id)) || [],
  }));
}

/** The header of a PO that has nothing left to receive (the receive context stops before it). */
async function closedContext(t, poId, hotelId) {
  const ctx = await getPoContext(t, poId);
  const head = await t.one(
    `SELECT po.po_number, COALESCE(vc.company_name, vu.organization_name, vu.name) AS vendor_name,
            h.name AS hotel_name
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_users vu ON vu.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = $2
      WHERE po.id = $1`,
    [poId, hotelId]
  );
  const hotel = { id: hotelId, name: head.hotel_name ?? null };
  return {
    po: {
      id: poId,
      poNumber: head.po_number,
      vendorName: head.vendor_name ?? null,
      isCallOff: ctx.isCallOff,
      departmentId: ctx.departmentId,
    },
    hotel,
    hotelChoices: [hotel],
    lines: [],
    dispatches: [],
    departments: [],
    itemSuggestions: {},
    draft: null,
  };
}

/**
 * GET /token/receive-context: the Receive screen for the token's PO at the
 * token's hotel, without prices or buyer details, plus:
 *   receivable           false when nothing can be received now
 *   notReceivableReason  null | 'received' | 'closed_short' | 'not_ready'
 *   linkExpiresAt        ISO, when this link stops working
 *   receipts             the GRNs this link posted, with the files it attached
 * A PO with nothing left to receive is still a 200 (receivable:false, empty
 * lines), so the page can show "all received" and keep taking paperwork.
 *
 * @param {object} t transaction (the default delivery plan may be created)
 * @param {{tokenId:number, poId:number, hotelId:number|null}} receiveToken
 */
export async function getTokenReceiveContext(t, receiveToken) {
  const { tokenId, poId, hotelId, viaToken } = tokenBinding(receiveToken);
  let out;
  let reason = null;
  try {
    out = await getReceiveContext(t, SITE_REP_ACTOR, { poId, hotelId }, { viaToken, hidePrices: true });
  } catch (err) {
    // Thrown after the token, PO and hotel checks and before anything is written.
    if (!isNotReceivable(err)) throw err;
    reason = notReceivableReason(err);
    out = await closedContext(t, poId, hotelId);
  }
  return redactForReceiveToken({
    ...out,
    // Mapping a line to a stock item needs inventory.update, which a link never has.
    itemSuggestions: {},
    // Drafts at the hotel are the buyer's work in progress, not the link's.
    draft: null,
    receivable: reason == null,
    notReceivableReason: reason,
    linkExpiresAt: await linkExpiresAt(t, tokenId, poId),
    receipts: await tokenReceipts(t, tokenId),
  });
}

/** A Grn as the link may see it: redacted, with only the files the link attached. */
async function tokenGrnView(t, grn) {
  const own = (await tokenAttachments(t, [grn.id])).get(grn.id) || [];
  const ownIds = new Set(own.map((a) => a.id));
  return redactForReceiveToken({
    ...grn,
    attachments: (grn.attachments || []).filter((a) => ownIds.has(a.id)),
  });
}

/**
 * POST /token/grn: record and post a receipt at the token's hotel.
 * posted_by and received_by stay NULL; received_by_token_id is the token.
 * A replayed clientEventId answers with the original GRN (replayed:true).
 *
 * @param {object} t transaction
 * @param {{tokenId:number, poId:number, hotelId:number|null}} receiveToken
 * @param {object} input GrnInput (poId optional, hotelId ignored, post must not be false)
 * @returns {Promise<{grn:object, replayed:boolean, activity:{companyId, hotelId, grnNumber, grnId}}>}
 */
export async function postTokenGrn(t, receiveToken, input = {}) {
  const { tokenId, poId, hotelId, viaToken } = tokenBinding(receiveToken);
  if (input.post === false) {
    throw new InventoryError('VALIDATION', 'A receiving link records the receipt straight away; it cannot save a draft', {
      field: 'post',
    });
  }
  if (input.poId != null && input.poId !== '' && positiveInt(input.poId) !== poId) throw notFound();

  const result = await postGrn(
    t,
    SITE_REP_ACTOR,
    { input: { ...input, poId, hotelId, post: true } },
    { viaToken }
  );
  const { grn } = result;
  // A replay can only ever return a receipt this link posted.
  if (Number(grn.receivedByTokenId) !== tokenId) {
    throw new InventoryError('CONFLICT', 'This scan session belongs to another receipt', { field: 'clientEventId' });
  }
  return {
    grn: await tokenGrnView(t, grn),
    replayed: result.replayed === true,
    activity: { companyId: grn.companyId, hotelId: grn.hotelId, grnNumber: grn.grnNumber, grnId: grn.id },
  };
}

/**
 * The GRN a token may attach files to: one it posted itself, on its PO at its
 * hotel. Anything else is NOT_FOUND. Runs before the upload is stored and again
 * when the file is recorded.
 */
export async function assertTokenGrn(t, receiveToken, grnId) {
  const { tokenId, viaToken } = tokenBinding(receiveToken);
  const id = positiveInt(grnId);
  if (!id) throw notFound('GRN not found');
  const row = await t.oneOrNone(`SELECT received_by_token_id FROM tbl_grn WHERE id = $1`, [id]);
  if (!row || Number(row.received_by_token_id) !== tokenId) throw notFound('GRN not found');
  return assertGrnAttachmentAccess(t, SITE_REP_ACTOR, id, { viaToken });
}

/**
 * POST /token/grn/:id/attachments: record an uploaded file on the token's GRN.
 * @returns {Promise<{attachment:{id, fileName, kind, url}, companyId, hotelId, grnNumber}>}
 */
export async function addTokenGrnAttachment(t, receiveToken, grnId, file) {
  const { viaToken } = tokenBinding(receiveToken);
  await assertTokenGrn(t, receiveToken, grnId);
  const out = await addGrnAttachment(t, SITE_REP_ACTOR, Number(grnId), file, { viaToken });
  return { ...out, attachment: redactForReceiveToken(out.attachment) };
}

export default { getTokenReceiveContext, postTokenGrn, assertTokenGrn, addTokenGrnAttachment };
