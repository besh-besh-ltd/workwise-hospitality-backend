import { logger } from '../../util/logger.js';
import db from '../../config/dbConn.js';
import arcAmendmentDocumentModel from '../../models/arc_v2/arcAmendmentDocumentModel.js';
import { applyAmendmentApprovalEffects } from '../../services/arcAmendmentLifecycleService.js';
import { voidAmendmentOnDecline, renderAndStoreAddendumPdf } from '../../services/arcAddendumService.js';
import { loadContractDocContext } from './arcContractController.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';

/**
 * ARC v2 — Addendum re-signing controller (vendor portal).
 *
 * The vendor signs the addendum generated when their amendment was approved.
 * OTP reuses the contract signature machinery (scoped to the addendum). Only on
 * signature do the amendment's effects bind (applyAmendmentApprovalEffects).
 * Ownership is always derived from req.user, never the client.
 */

function ok(res, data, message = 'success', status = 1) { return res.status(200).json({ status, message, data }); }
function bad(res, code, message, status = 0) { return res.status(code).json({ status, message }); }

// GET /v1/arc-v2/vendor/addendums — addenda awaiting this vendor's signature.
export async function listVendorAddendums(req, res) {
  try {
    const vendorId = req.user?.id;
    if (!vendorId) return bad(res, 401, 'Unauthenticated');
    const rows = await arcAmendmentDocumentModel.listForVendor(vendorId);
    return ok(res, { addendums: rows });
  } catch (err) {
    logger.error({ err }, '[arcAddendum.listVendorAddendums]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /v1/arc-v2/vendor/addendums/:id/otp/request
export async function requestAddendumOtp(req, res) {
  try {
    const id = Number(req.params.id);
    const vendorUserId = req.user?.id;
    const doc = await arcAmendmentDocumentModel.getByIdFull(id);
    if (!doc) return bad(res, 404, 'Addendum not found', 2);
    if (Number(doc.vendor_id) !== Number(vendorUserId)) return bad(res, 403, 'Not the contracted vendor');
    if (doc.status !== 'awaiting_signature') return bad(res, 409, `Addendum not awaiting signature (status=${doc.status})`);
    const { code, expiresAt } = await arcAmendmentDocumentModel.createOtp(id, doc.arc_contract_id, vendorUserId);
    await logArcEvent({
      arcId: doc.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED,
      actorId: vendorUserId, payload: { addendum_document_id: id, expires_at: expiresAt },
    });
    const expose = process.env.NODE_ENV !== 'production';
    return ok(res, { otp_expires_at: expiresAt, dev_code: expose ? code : undefined });
  } catch (err) {
    logger.error({ err }, '[arcAddendum.requestAddendumOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /v1/arc-v2/vendor/addendums/:id/otp/verify  { code }
export async function verifyAddendumOtp(req, res) {
  try {
    const id = Number(req.params.id);
    const vendorUserId = req.user?.id;
    const code = req.body?.code;
    if (!code) return bad(res, 400, 'code is required');
    const doc = await arcAmendmentDocumentModel.getByIdFull(id);
    if (!doc) return bad(res, 404, 'Addendum not found', 2);
    if (Number(doc.vendor_id) !== Number(vendorUserId)) return bad(res, 403, 'Not the contracted vendor');
    if (doc.status !== 'awaiting_signature') return bad(res, 409, `Addendum not awaiting signature (status=${doc.status})`);

    const result = await arcAmendmentDocumentModel.verifyOtp(id, vendorUserId, code);
    if (!result.ok) return bad(res, 400, `OTP verification failed: ${result.reason}`);

    // Re-render the SIGNED addendum (outside the tx; content-hash fallback so
    // signing never hard-fails when Puppeteer/S3 is unavailable).
    const signedAt = new Date();
    const ctx = await loadContractDocContext(doc.arc_id);
    const vendor = { name: doc.vendor_name, email: doc.vendor_email };
    const { url, hash } = await renderAndStoreAddendumPdf(
      {
        id: doc.arc_amendment_id,
        amendment_type: doc.amendment_type,
        payload: doc.payload,
        amendment_from: doc.amendment_from,
        amendment_to: doc.amendment_to,
      },
      ctx || {}, vendor, doc.addendum_number, { signed: true, signedAt }
    );

    const updated = await db.tx(async (t) => {
      const signedDoc = await arcAmendmentDocumentModel.markSigned(id, { url, hash, signedBy: vendorUserId, signedAt }, t);
      // Bind the amendment effects now (term end-date / windowed live|ended).
      await applyAmendmentApprovalEffects(doc.arc_amendment_id, { actorId: vendorUserId, txContext: t });
      await logArcEvent({
        arcId: doc.arc_id, eventType: ARC_EVENT_TYPES.ADDENDUM_SIGNED,
        actorId: vendorUserId, payload: { addendum_document_id: id, amendment_id: doc.arc_amendment_id, hash }, txContext: t,
      });
      return signedDoc;
    });
    // respond AFTER the commit
    return ok(res, { addendum: updated }, 'Addendum signed');
  } catch (err) {
    logger.error({ err }, '[arcAddendum.verifyAddendumOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// POST /v1/arc-v2/vendor/addendums/:id/decline  { reason? }
export async function declineAddendum(req, res) {
  try {
    const id = Number(req.params.id);
    const vendorUserId = req.user?.id;
    const reason = req.body?.reason || null;
    const doc = await arcAmendmentDocumentModel.getByIdFull(id);
    if (!doc) return bad(res, 404, 'Addendum not found', 2);
    if (Number(doc.vendor_id) !== Number(vendorUserId)) return bad(res, 403, 'Not the contracted vendor');
    if (doc.status !== 'awaiting_signature') return bad(res, 409, `Addendum not awaiting signature (status=${doc.status})`);
    const voided = await db.tx(async (t) => voidAmendmentOnDecline(doc.arc_amendment_id, reason, { actorId: vendorUserId, txContext: t }));
    // respond AFTER the commit
    return ok(res, { amendment: voided }, 'Addendum declined');
  } catch (err) {
    logger.error({ err }, '[arcAddendum.declineAddendum]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
