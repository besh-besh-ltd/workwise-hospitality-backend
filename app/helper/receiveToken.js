// Site-rep receive tokens (spec §10.3, fixes D3).
//
// A token is 32 random bytes, base64url (43 chars). Only its sha256 hex is
// stored (tbl_token_login_data.token_hash); the plain token exists once, in the
// email link, and is never logged or returned to the buyer.
//
// A token is live while:
//   - it is not revoked and not past expires_at (14 days from issue);
//   - its PO is not cancelled or rejected;
//   - its PO is not fully received / short-closed, with a 24-hour grace after
//     the last posted GRN so the receiver can still attach the paperwork.
//
// Rows issued before hashing hold the plain token in `token` and NULL
// token_hash / expires_at. Such a row is accepted only while it is unrevoked and
// younger than 14 days (created_at + 14 days), and on its first use it is
// upgraded in place: hash stored, plain token erased, expiry pinned to
// created_at + 14 days. After that it is an ordinary hashed token. A legacy row
// past 14 days is refused and left untouched.

import crypto from 'crypto';
import db from '../config/dbConn.js';

export const RECEIVE_TOKEN_TTL_DAYS = 14;
export const RECEIVE_TOKEN_HEADER = 'X-Receive-Token';

// base64url, the new 43-char tokens and the legacy HMAC ones alike. Anything
// else is refused before it reaches the database.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

const DEAD_PO_STATUSES = ['cancelled', 'rejected', 'rejected_by_vendor'];

/** A fresh token: 32 random bytes, base64url. */
export const generateReceiveToken = () => crypto.randomBytes(32).toString('base64url');

/** sha256 hex of a token, the only form that is stored. */
export const hashReceiveToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

export const isWellFormedReceiveToken = (token) => typeof token === 'string' && TOKEN_SHAPE.test(token);

/**
 * SQL predicate: token row `tl` (joined to its PO `po`) is live. Shared by the
 * lookup and the listing so the two can never disagree.
 */
export const LIVE_TOKEN_SQL = `
      tl.token_type = 'GRN'
  AND tl.revoked_at IS NULL
  AND COALESCE(tl.expires_at, tl.created_at + interval '${RECEIVE_TOKEN_TTL_DAYS} days') > now()
  AND po.status::text <> ALL ('{${DEAD_PO_STATUSES.join(',')}}'::text[])
  AND NOT (
        po.receipt_status IN ('received', 'closed_short')
    AND COALESCE((SELECT MAX(g.posted_at) FROM tbl_grn g
                   WHERE g.po_id = po.id AND g.posted_at IS NOT NULL),
                 '-infinity'::timestamptz) < now() - interval '24 hours'
  )`;

const TOKEN_COLUMNS = `tl.id, tl.entity_id, tl.hotel_id, tl.name, tl.email, tl.phone, tl.token_type`;

const toTokenRecord = (row, hotelId) => ({
  id: Number(row.id),
  poId: Number(row.entity_id),
  hotelId: hotelId == null ? null : Number(hotelId),
  name: row.name,
  email: row.email,
  phone: row.phone,
  tokenType: row.token_type,
});

/** The PO's only hotel, or null when it has none or several. */
async function singlePoHotel(conn, poId) {
  // Lazy: planCore pulls in the PO model graph, which this helper (imported by
  // the auth middleware) must not load eagerly.
  const { getPoContext } = await import('../services/inventory/planCore.js');
  try {
    const ctx = await getPoContext(conn, poId);
    return ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null;
  } catch {
    return null;
  }
}

async function lookupHashed(conn, hash, poId) {
  return conn.oneOrNone(
    `SELECT ${TOKEN_COLUMNS}
       FROM tbl_token_login_data tl
       JOIN tbl_rfq_purchase_order po ON po.id = tl.entity_id
      WHERE tl.token_hash = $1
        AND ($2::int IS NULL OR tl.entity_id = $2::int)
        AND ${LIVE_TOKEN_SQL}`,
    [hash, poId]
  );
}

async function lookupLegacy(conn, token, poId) {
  return conn.oneOrNone(
    `SELECT ${TOKEN_COLUMNS}
       FROM tbl_token_login_data tl
       JOIN tbl_rfq_purchase_order po ON po.id = tl.entity_id
      WHERE tl.token_hash IS NULL
        AND tl.token = $1
        AND ($2::int IS NULL OR tl.entity_id = $2::int)
        AND ${LIVE_TOKEN_SQL}
      ORDER BY tl.id DESC
      LIMIT 1`,
    [token, poId]
  );
}

/**
 * The live token `token` names (bound to `poId` when given), or null.
 * Stamps last_used_at; upgrades a legacy plain-token row on its first use.
 *
 * @param {string} token  the plain token as presented
 * @param {{poId?:number|null, conn?:object}} [opts]
 * @returns {Promise<null|{id:number, poId:number, hotelId:number|null,
 *   name:string, email:string, phone:string, tokenType:string}>}
 *   hotelId is the token's hotel, else the PO's only hotel, else null (a
 *   multi-hotel PO with a hotel-less legacy token: no posting allowed).
 */
export async function findLiveReceiveToken(token, { poId = null, conn = db } = {}) {
  if (!isWellFormedReceiveToken(token)) return null;
  const boundPo = poId == null ? null : Number(poId);
  if (boundPo != null && !(Number.isInteger(boundPo) && boundPo > 0)) return null;

  const hash = hashReceiveToken(token);
  let row = await lookupHashed(conn, hash, boundPo);

  if (!row) {
    const legacy = await lookupLegacy(conn, token, boundPo);
    if (!legacy) return null;
    const hotelId = legacy.hotel_id ?? (await singlePoHotel(conn, legacy.entity_id));
    try {
      row = await conn.oneOrNone(
        `UPDATE tbl_token_login_data
            SET token_hash   = $2,
                token        = NULL,
                expires_at   = COALESCE(expires_at, created_at + interval '${RECEIVE_TOKEN_TTL_DAYS} days'),
                hotel_id     = COALESCE(hotel_id, $3),
                last_used_at = now()
          WHERE id = $1 AND token_hash IS NULL
          RETURNING id, entity_id, hotel_id, name, email, phone, token_type`,
        [legacy.id, hash, hotelId]
      );
    } catch (err) {
      if (err?.code === '23505') return null; // hash already taken: refuse
      throw err;
    }
    // A concurrent first use upgraded it a moment ago: read it as hashed.
    if (!row) row = await lookupHashed(conn, hash, boundPo);
    if (!row) return null;
    return toTokenRecord(row, row.hotel_id ?? (await singlePoHotel(conn, row.entity_id)));
  }

  await conn.none(`UPDATE tbl_token_login_data SET last_used_at = now() WHERE id = $1`, [row.id]);
  return toTokenRecord(row, row.hotel_id ?? (await singlePoHotel(conn, row.entity_id)));
}

/** req.user for a token caller (the shape assertPoAccess and the activity log expect). */
export const tokenRequestUser = (tok) => ({
  id: -1, // marker: token login, not a user
  name: tok.name,
  email: tok.email,
  phone: tok.phone,
  tokenLoginId: tok.id,
  tokenType: tok.tokenType,
  entityId: tok.poId,
  hotelId: tok.hotelId,
  is_token_user: true,
});

export default {
  RECEIVE_TOKEN_TTL_DAYS,
  RECEIVE_TOKEN_HEADER,
  LIVE_TOKEN_SQL,
  generateReceiveToken,
  hashReceiveToken,
  isWellFormedReceiveToken,
  findLiveReceiveToken,
  tokenRequestUser,
};
