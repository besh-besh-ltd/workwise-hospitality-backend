// Site representatives: people outside the system who receive a PO's goods at
// a hotel through an emailed link (spec §10.3; fixes D2 and the D3 storage).
//
// One live link per (PO, hotel). Issuing again for the same hotel revokes the
// previous link and adds a new row rather than rewriting the old one: a GRN
// received through a link points at its row (tbl_grn.received_by_token_id), so
// that row must keep naming the person who used it.
//
// Who may issue or revoke: a buyer who can see the PO (assertPoAccess, else
// 404) AND holds grn.create at the link's hotel (else 403). A link hands its
// holder receiving rights at that hotel, so issuing one needs those rights.
//
// The plain token leaves this module once, for the email; only its sha256 is
// stored and nothing returned to the buyer carries either.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';
import { generateReceiveToken, hashReceiveToken, RECEIVE_TOKEN_TTL_DAYS } from '../../helper/receiveToken.js';
import { sendGRNRepresentativeEmail } from '../../helper/sendEmailFunctions/generalReminderEmails.js';
import { assertPoAccess } from '../../models/purchaseOrderModel.js';
import { InventoryError } from './errors.js';
import { getPoContext } from './planCore.js';
import { assertHotelPermission, hotelIdsWithPermission } from './scope.js';

const CLOSED_PO_STATUSES = new Set(['cancelled', 'rejected', 'rejected_by_vendor']);
const FULLY_RECEIVED = new Set(['received', 'closed_short']);
const EMAIL_SHAPE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const text = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function validateRep({ name, email, phone }) {
  const rep = { name: text(name), email: text(email), phone: text(phone) };
  if (!rep.name || rep.name.length > 99) {
    throw new InventoryError('VALIDATION', 'Enter the site representative\'s name (up to 99 characters)', { field: 'name' });
  }
  if (!EMAIL_SHAPE.test(rep.email) || rep.email.length > 300) {
    throw new InventoryError('VALIDATION', 'Enter a valid email address', { field: 'email' });
  }
  if (!/^[0-9+\-() ]{6,15}$/.test(rep.phone)) {
    throw new InventoryError('VALIDATION', 'Enter a valid phone number (up to 15 characters)', { field: 'phone' });
  }
  return rep;
}

/** The row as the buyer may see it: never the token or its hash. */
const publicRow = (r) => ({
  id: Number(r.id),
  entity_id: Number(r.entity_id),
  hotel_id: r.hotel_id == null ? null : Number(r.hotel_id),
  name: r.name,
  email: r.email,
  phone: r.phone,
  expires_at: r.expires_at,
  created_at: r.created_at,
});

async function emailContext(t, poId, hotelId) {
  return t.one(
    `SELECT po.id, po.po_number, po.status::text AS status,
            COALESCE(vc.company_name, vu.name)         AS vendor_name,
            h.name                                     AS hotel_name,
            (SELECT MIN(d.due_date)::text
               FROM tbl_po_delivery d
              WHERE d.po_id = po.id
                AND (d.hotel_id = $2 OR d.hotel_id IS NULL)
                AND d.status IN ('open', 'partial'))  AS next_due_date
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_users vu   ON vu.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = $2
      WHERE po.id = $1`,
    [poId, hotelId]
  );
}

/**
 * Issue (or re-issue) the receiving link for a PO at one hotel and email it.
 *
 * @param {object} user  req.user
 * @param {{poId:number, hotelId?:number|null, name:string, email:string, phone:string}} input
 *   hotelId is required when the PO delivers to more than one hotel and must be
 *   one of them; a single-hotel PO defaults to its hotel.
 * @returns {Promise<{siteRep:object, revokedIds:number[], companyId:number|null,
 *   hotelId:number, emailSent:boolean}>}
 * @throws PoAccessError (404) when the caller cannot see the PO;
 *   InventoryError VALIDATION | FORBIDDEN | CONFLICT.
 */
export async function issueSiteRepToken(user, input = {}, { conn = db } = {}) {
  const poId = positiveInt(input.poId);
  if (!poId) throw new InventoryError('VALIDATION', 'Invalid purchase order', { field: 'po_id' });
  const rep = validateRep(input);
  const askedHotel = input.hotelId == null || input.hotelId === '' ? null : positiveInt(input.hotelId);
  if (input.hotelId != null && input.hotelId !== '' && !askedHotel) {
    throw new InventoryError('VALIDATION', 'Invalid hotel', { field: 'hotel_id' });
  }

  const token = generateReceiveToken();
  const issued = await conn.tx(async (t) => {
    await assertPoAccess(user, poId, t);
    const ctx = await getPoContext(t, poId, { forUpdate: true });

    if (CLOSED_PO_STATUSES.has(ctx.status)) {
      throw new InventoryError('CONFLICT', 'This purchase order is closed; a receiving link cannot be sent', { poId });
    }
    if (FULLY_RECEIVED.has(ctx.receiptStatus)) {
      throw new InventoryError('CONFLICT', 'Everything on this purchase order has been received', { poId });
    }

    let hotelId;
    if (askedHotel) {
      if (!ctx.hotelIds.includes(askedHotel)) {
        throw new InventoryError('VALIDATION', 'This purchase order does not deliver to that hotel', {
          field: 'hotel_id', hotelIds: ctx.hotelIds,
        });
      }
      hotelId = askedHotel;
    } else if (ctx.hotelIds.length === 1) {
      hotelId = ctx.hotelIds[0];
    } else if (ctx.hotelIds.length === 0) {
      throw new InventoryError('VALIDATION', 'This purchase order has no delivery hotel', { poId });
    } else {
      throw new InventoryError('VALIDATION', 'Choose the hotel this person will receive at', {
        field: 'hotel_id', hotelIds: ctx.hotelIds,
      });
    }

    await assertHotelPermission(t, user, { resource: 'grn', action: 'create', hotelId });

    // The previous link at this hotel stops working. A hotel-less row (issued
    // before links carried a hotel) counts as this hotel's when the PO has one.
    const revoked = await t.any(
      `UPDATE tbl_token_login_data
          SET revoked_at = now()
        WHERE token_type = 'GRN'
          AND entity_id = $1
          AND revoked_at IS NULL
          AND (hotel_id = $2 OR (hotel_id IS NULL AND $3::boolean))
        RETURNING id`,
      [poId, hotelId, ctx.hotelIds.length === 1]
    );

    const row = await t.one(
      `INSERT INTO tbl_token_login_data
         (token_type, entity_id, name, email, phone, added_by, token, token_hash, expires_at, hotel_id)
       VALUES ('GRN', $1, $2, $3, $4, $5, NULL, $6, now() + interval '${RECEIVE_TOKEN_TTL_DAYS} days', $7)
       RETURNING id, entity_id, hotel_id, name, email, phone, expires_at, created_at`,
      [poId, rep.name, rep.email, rep.phone, user.id, hashReceiveToken(token), hotelId]
    );

    return {
      row,
      revokedIds: revoked.map((r) => Number(r.id)),
      companyId: ctx.companyId,
      hotelId,
      mail: await emailContext(t, poId, hotelId),
    };
  });

  // After commit: a mail failure must not undo the link, but the buyer is told.
  let emailSent = false;
  try {
    emailSent = await sendGRNRepresentativeEmail(
      {
        poNumber: issued.mail.po_number,
        status: issued.mail.status,
        vendorName: issued.mail.vendor_name,
        hotelName: issued.mail.hotel_name,
        nextDueDate: issued.mail.next_due_date,
        expiresAt: issued.row.expires_at,
      },
      rep.email,
      token
    );
  } catch (err) {
    logError(`[po ${poId}] site-rep link email failed`, err);
  }

  return {
    siteRep: publicRow(issued.row),
    revokedIds: issued.revokedIds,
    companyId: issued.companyId,
    hotelId: issued.hotelId,
    emailSent: emailSent === true,
  };
}

/**
 * Revoke a PO's live receiving links: one (tokenId) or all of them.
 *
 * Each link needs grn.create at its hotel (a hotel-less legacy link: at any of
 * the PO's hotels). Revoking when nothing is live is a no-op that still needs
 * grn.create at one of the PO's hotels.
 *
 * @param {object} user  req.user
 * @param {{poId:number, tokenId?:number|null}} input
 * @returns {Promise<{poId:number, poNumber:string, revoked:number, tokenIds:number[],
 *   companyId:number|null, hotelIds:number[]}>}
 * @throws PoAccessError (404); InventoryError NOT_FOUND (tokenId not a live link
 *   of this PO) | FORBIDDEN | VALIDATION.
 */
export async function revokeSiteRepTokens(user, input = {}, { conn = db } = {}) {
  const poId = positiveInt(input.poId);
  if (!poId) throw new InventoryError('VALIDATION', 'Invalid purchase order', { field: 'poId' });
  const tokenId = input.tokenId == null || input.tokenId === '' ? null : positiveInt(input.tokenId);
  if (input.tokenId != null && input.tokenId !== '' && !tokenId) {
    throw new InventoryError('VALIDATION', 'Invalid site representative', { field: 'tokenId' });
  }

  return conn.tx(async (t) => {
    await assertPoAccess(user, poId, t);
    const ctx = await getPoContext(t, poId, { forUpdate: true });

    const live = await t.any(
      `SELECT id, hotel_id FROM tbl_token_login_data
        WHERE token_type = 'GRN' AND entity_id = $1 AND revoked_at IS NULL
          AND ($2::int IS NULL OR id = $2::int)
        ORDER BY id
        FOR UPDATE`,
      [poId, tokenId]
    );
    if (tokenId && !live.length) {
      throw new InventoryError('NOT_FOUND', 'Site representative not found', { tokenId });
    }

    const allowed = new Set(await hotelIdsWithPermission(t, user, 'grn', 'create'));
    const anyPoHotel = ctx.hotelIds.some((h) => allowed.has(h));
    const mayRevoke = (row) => (row.hotel_id == null ? anyPoHotel : allowed.has(Number(row.hotel_id)));
    if (!(live.length ? live.every(mayRevoke) : anyPoHotel)) {
      throw new InventoryError('FORBIDDEN', "You don't have permission to manage receiving links for this purchase order", {
        resource: 'grn', action: 'create', poId,
      });
    }

    const ids = live.map((r) => Number(r.id));
    if (ids.length) {
      await t.none(`UPDATE tbl_token_login_data SET revoked_at = now() WHERE id = ANY($1::int[])`, [ids]);
    }
    const hotelIds = [...new Set(live.map((r) => r.hotel_id).filter((h) => h != null).map(Number))];
    return {
      poId, poNumber: ctx.po.po_number, revoked: ids.length, tokenIds: ids, companyId: ctx.companyId, hotelIds,
    };
  });
}

export default { issueSiteRepToken, revokeSiteRepTokens };
