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
// Every payload passes through tokenView: redactForReceiveToken (no price,
// cost, value, tax or buyer-contact key at any depth) plus a token-only strip
// of the camelCase "who" keys (postedBy, receivedByName, ...), so no buyer
// user's id or name reaches a link, including on reversals. Drafts are not
// offered to a token: it posts straight away, and the buyer's drafts at the
// hotel stay hidden.
//
// A link only receives (spec §10.3: "the token path is not extended to
// mark-out or counts"), and never maps items or sets conversions (posting does
// still create the stock item row for a product on first receipt, as any
// receipt does):
//   - no mark-out on arrival: the context offers no departments and no
//     mark-out default, and a line asking for one is refused;
//   - no item mapping (refused) and no unit conversions: a supplied uomFactor
//     is ignored, the buyer's stored conversion always applies, and a line
//     without one (needsUomFactor in the context) is refused with
//     UOM_FACTOR_REQUIRED "Ask the buyer to set the unit conversion …".

import { InventoryError } from './errors.js';
import { clientEventIdOf } from './grnCommon.js';
import {
  getReceiveContext,
  postGrn,
  addGrnAttachment,
  assertGrnAttachmentAccess,
  attachmentUrl,
  SITE_REP_ACTOR,
} from './grnService.js';
import { getPoContext, listPoLines } from './planCore.js';
import { TOKEN_EXPIRES_AT_SQL } from '../../helper/receiveToken.js';
import { redactForReceiveToken } from '../../helper/receiveTokenView.js';

// camelCase keys naming a buyer user: postedBy, postedByName, receivedBy,
// receivedByName, and any later createdBy / uploadedByName alike.
const USER_IDENTITY_KEY = /[a-z]By(Name)?$/;

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function stripUserIdentity(value) {
  if (Array.isArray(value)) return value.map(stripUserIdentity);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!USER_IDENTITY_KEY.test(key)) out[key] = stripUserIdentity(v);
  }
  return out;
}

/** A payload as a link may see it: no commercial, buyer-contact or buyer-user key at any depth. */
const tokenView = (value) => stripUserIdentity(redactForReceiveToken(value));

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

const present = (v) => v != null && v !== '';

/**
 * The receipt as a link may send it: refuses mark-out and item mapping, drops
 * uomFactor (a link never sets or changes a conversion).
 */
function linkLines(input) {
  if (input.markOutOnArrival === true) {
    throw new InventoryError('VALIDATION', "Mark-out isn't available from a receive link", {
      field: 'markOutOnArrival', code_detail: 'MARK_OUT_NOT_ALLOWED',
    });
  }
  const lines = Array.isArray(input.lines) ? input.lines : [];
  return lines.map((l, index) => {
    const poLineId = positiveInt(l?.poLineId);
    if (present(l?.markOutDepartmentId) || l?.markOutOnArrival === true) {
      throw new InventoryError('VALIDATION', "Mark-out isn't available from a receive link", {
        field: 'markOutDepartmentId', index, poLineId, code_detail: 'MARK_OUT_NOT_ALLOWED',
      });
    }
    if (present(l?.mapToInvItemId)) {
      throw new InventoryError('VALIDATION', 'Only the buyer can link a line to a stock item', {
        field: 'mapToInvItemId', index, poLineId, code_detail: 'MAPPING_NOT_ALLOWED',
      });
    }
    const rest = { ...(l || {}) };
    delete rest.uomFactor;
    delete rest.markOutOnArrival;
    return rest;
  });
}

const isUomFactorRequired = (err) =>
  err instanceof InventoryError && err.code === 'VALIDATION' && err.details?.code_detail === 'UOM_FACTOR_REQUIRED';

/** B1's "set the conversion" refusal, worded for someone who cannot set it. */
async function uomRefusalForLink(t, poId, lines, err) {
  const poLineId = positiveInt(err.details?.poLineId);
  const poLine = (await listPoLines(t, poId)).find((l) => l.id === poLineId);
  const productName = poLine?.productName ?? 'this item';
  const index = lines.findIndex((l) => positiveInt(l?.poLineId) === poLineId);
  return new InventoryError('VALIDATION', `Ask the buyer to set the unit conversion for ${productName} first`, {
    ...err.details,
    field: 'uomFactor',
    index: index >= 0 ? index : undefined,
    productName,
  });
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
    `SELECT ${TOKEN_EXPIRES_AT_SQL} AS expires_at
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
  return tokenView({
    ...out,
    // No mark-out from a link: no default to pre-fill, no departments to pick.
    lines: out.lines.map((l) => ({ ...l, defaultMarkOutOnArrival: false })),
    departments: [],
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
  return tokenView({
    ...grn,
    attachments: (grn.attachments || []).filter((a) => ownIds.has(a.id)),
  });
}

const scanSessionTaken = () =>
  new InventoryError('CONFLICT', 'This scan session belongs to another receipt', { field: 'clientEventId' });

/**
 * A clientEventId already on a GRN this link did not post (a buyer's draft, a
 * buyer's receipt, another link's receipt) is not this link's to replay or to
 * post over: postGrn would otherwise post the link's lines over a buyer draft
 * that carries the key. Only a receipt this link posted replays.
 */
async function assertOwnScanSession(t, tokenId, clientEventId) {
  const key = clientEventIdOf(clientEventId);
  if (!key) return;
  const row = await t.oneOrNone(`SELECT received_by_token_id FROM tbl_grn WHERE client_event_id = $1`, [key]);
  if (row && Number(row.received_by_token_id) !== tokenId) throw scanSessionTaken();
}

/**
 * POST /token/grn: record and post a receipt at the token's hotel.
 * posted_by and received_by stay NULL; received_by_token_id is the token.
 * A replayed clientEventId answers with the original GRN (replayed:true).
 *
 * @param {object} t transaction
 * @param {{tokenId:number, poId:number, hotelId:number|null}} receiveToken
 * @param {object} input GrnInput (poId optional, hotelId ignored, post must not be
 *   false, no markOutDepartmentId / mapToInvItemId, uomFactor ignored)
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
  const lines = linkLines(input);
  await assertOwnScanSession(t, tokenId, input.clientEventId);

  let result;
  try {
    result = await postGrn(
      t,
      SITE_REP_ACTOR,
      { input: { ...input, lines, poId, hotelId, post: true } },
      { viaToken }
    );
  } catch (err) {
    // A refusal thrown in JS leaves the transaction usable for the name
    // lookup; rethrowing rolls back anything postGrn wrote.
    if (isUomFactorRequired(err)) throw await uomRefusalForLink(t, poId, lines, err);
    throw err;
  }
  const { grn } = result;
  // A replay can only ever return a receipt this link posted, and a new post
  // must be a GRN this request created (a buyer draft carries its creator; a
  // link's own receipt has none). The second check covers a buyer draft saved
  // with the same key between the check above and postGrn's lookup; throwing
  // rolls back the post over it.
  const row = await t.one(`SELECT created_by, received_by_token_id FROM tbl_grn WHERE id = $1`, [grn.id]);
  if (Number(row.received_by_token_id) !== tokenId || row.created_by != null) throw scanSessionTaken();
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
  return { ...out, attachment: tokenView(out.attachment) };
}

export default { getTokenReceiveContext, postTokenGrn, assertTokenGrn, addTokenGrnAttachment };
