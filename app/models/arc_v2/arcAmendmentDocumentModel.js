import crypto from 'crypto';
import db from '../../config/dbConn.js';

/**
 * Addendum document data access. The addendum is the signed artefact that
 * binds an approved amendment. It reuses tbl_arc_contract_signature_otp for
 * OTP (scoped via arc_amendment_document_id) so vendors sign with the same
 * mechanism as the original contract.
 */
const arcAmendmentDocumentModel = {
  nextAddendumNumber: async (arcContractId, txContext = null) => {
    const row = await (txContext || db).one(
      `SELECT COALESCE(MAX(addendum_number), 0) + 1 AS n
         FROM tbl_arc_amendment_document WHERE arc_contract_id = $1`,
      [arcContractId]
    );
    return Number(row.n);
  },

  create: async ({ arc_amendment_id, arc_contract_id, addendum_number, document_s3_url, document_hash }, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_amendment_document
         (arc_amendment_id, arc_contract_id, addendum_number, document_s3_url, document_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_signature') RETURNING *`,
      [arc_amendment_id, arc_contract_id, addendum_number, document_s3_url ?? null, document_hash ?? null]
    );
  },

  // Full context for rendering + ownership checks.
  getByIdFull: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT d.*, am.amendment_type, am.payload, am.amendment_from, am.amendment_to,
              am.arc_contract_id AS am_contract_id, c.vendor_id, c.arc_id,
              v.name AS vendor_name, v.email AS vendor_email
         FROM tbl_arc_amendment_document d
         JOIN tbl_arc_amendment am ON am.id = d.arc_amendment_id
         JOIN tbl_arc_contract   c  ON c.id  = d.arc_contract_id
         LEFT JOIN tbl_users     v  ON v.id  = c.vendor_id
        WHERE d.id = $1`,
      [id]
    );
  },

  getByAmendmentId: async (amendmentId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM tbl_arc_amendment_document WHERE arc_amendment_id = $1`,
      [amendmentId]
    );
  },

  listForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT d.*, am.amendment_type, am.amendment_from, am.amendment_to, c.vendor_id
         FROM tbl_arc_amendment_document d
         JOIN tbl_arc_amendment am ON am.id = d.arc_amendment_id
         JOIN tbl_arc_contract   c  ON c.id  = d.arc_contract_id
        WHERE c.arc_id = $1
        ORDER BY d.arc_contract_id, d.addendum_number`,
      [arcId]
    );
  },

  listForVendor: async (vendorId, txContext = null) => {
    return (txContext || db).any(
      `SELECT d.*, am.amendment_type, c.arc_id, a.arc_number, a.title AS arc_title
         FROM tbl_arc_amendment_document d
         JOIN tbl_arc_amendment am ON am.id = d.arc_amendment_id
         JOIN tbl_arc_contract   c  ON c.id  = d.arc_contract_id
         JOIN tbl_arc            a  ON a.id  = c.arc_id
        WHERE c.vendor_id = $1 AND d.status = 'awaiting_signature'
        ORDER BY d.generated_at DESC`,
      [vendorId]
    );
  },

  markSigned: async (id, { url, hash, signedBy, signedAt }, txContext = null) => {
    return (txContext || db).one(
      `UPDATE tbl_arc_amendment_document
          SET status = 'signed',
              document_s3_url = COALESCE($2, document_s3_url),
              document_hash   = COALESCE($3, document_hash),
              signed_by = $4, signed_by_vendor_at = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id, url ?? null, hash ?? null, signedBy, signedAt]
    );
  },

  markVoided: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_arc_amendment_document
          SET status = 'voided', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id]
    );
  },

  // ============================================================
  // Addendum-scoped OTP (reuses the contract OTP table).
  // ============================================================
  createOtp: async (addendumDocumentId, arcContractId, vendorUserId, { ttlSeconds = 600 } = {}, txContext = null) => {
    const runner = txContext || db;
    const code = (Math.floor(Math.random() * 900000) + 100000).toString();
    const otpHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await runner.none(
      `INSERT INTO tbl_arc_contract_signature_otp
         (arc_contract_id, vendor_user_id, otp_hash, expires_at, attempts, arc_amendment_document_id)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      [arcContractId, vendorUserId, otpHash, expiresAt, addendumDocumentId]
    );
    return { code, expiresAt };
  },

  verifyOtp: async (addendumDocumentId, vendorUserId, code, { maxAttempts = 5 } = {}, txContext = null) => {
    const runner = txContext || db;
    const candidate = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_contract_signature_otp
        WHERE arc_amendment_document_id = $1 AND vendor_user_id = $2 AND verified_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [addendumDocumentId, vendorUserId]
    );
    if (!candidate) return { ok: false, reason: 'no_otp' };
    if (candidate.attempts >= maxAttempts) return { ok: false, reason: 'too_many_attempts' };
    if (new Date(candidate.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    if (hash !== candidate.otp_hash) {
      await runner.none(`UPDATE tbl_arc_contract_signature_otp SET attempts = attempts + 1 WHERE id = $1`, [candidate.id]);
      return { ok: false, reason: 'mismatch' };
    }
    await runner.none(`UPDATE tbl_arc_contract_signature_otp SET verified_at = CURRENT_TIMESTAMP WHERE id = $1`, [candidate.id]);
    return { ok: true };
  },
};

export default arcAmendmentDocumentModel;
