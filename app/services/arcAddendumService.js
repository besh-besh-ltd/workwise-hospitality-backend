import crypto from 'crypto';
import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { logArcEvent, ARC_EVENT_TYPES } from './arcEventLogService.js';
import arcAmendmentDocumentModel from '../models/arc_v2/arcAmendmentDocumentModel.js';
import { renderAddendumHtml, summariseAmendment } from '../helper/arc_v2/addendumTemplate.js';
import { loadContractDocContext, generateContractPdf } from '../controllers/arc_v2/arcContractController.js';

/**
 * Addendum re-signing service.
 *
 * The post-approval gate: an approved amendment no longer binds its effects
 * immediately. Instead `prepareAddendumForSignature` renders the addendum and
 * parks the amendment in 'awaiting_signature'. The vendor signs the addendum
 * (OTP) — only then does arcAmendmentLifecycleService.applyAmendmentApprovalEffects
 * run and flip the amendment to live/ended. `voidAmendmentOnDecline` is the
 * terminal path when the vendor declines.
 */

/**
 * Render + store the addendum PDF. Mirrors verifyOtp's PDF strategy: Puppeteer
 * is skipped under the test harness and a deterministic content hash is the
 * fallback whenever a render is unavailable, so the document row always carries
 * a hash. Returns { url, hash, changeSummary }.
 */
export async function renderAndStoreAddendumPdf(am, ctx, vendor, addendumNumber, { signed = false, signedAt = null } = {}) {
  const changeSummary = summariseAmendment(am);
  const html = renderAddendumHtml(am, ctx, vendor, { addendumNumber, changeSummary, signed, signedAt });
  let url = null;
  let hash = null;
  if (process.env.NODE_ENV !== 'test') {
    try {
      const pdf = await generateContractPdf(ctx, vendor, [], `addendum-${am.id}`, { signed, signedAt, htmlOverride: html });
      url = pdf.url;
      hash = pdf.hash;
    } catch (err) {
      logger.error({ err, amendmentId: am.id }, '[arcAddendum] PDF render failed — falling back to content hash');
    }
  }
  if (!hash) {
    hash = crypto.createHash('sha256')
      .update(JSON.stringify({
        amendment_id: am.id,
        addendum: addendumNumber,
        signed,
        signed_at: signedAt ? new Date(signedAt).toISOString() : null,
        summary: changeSummary,
      }))
      .digest('hex');
  }
  return { url, hash, changeSummary };
}

/**
 * Approval post-hook replacement: instead of binding effects, generate the
 * addendum and park the amendment in 'awaiting_signature'. Idempotent — a
 * second call when an addendum already exists just re-parks and returns it.
 * Returns the addendum document row, or null if the amendment is terminal.
 */
export async function prepareAddendumForSignature(amendmentId, { actorId = null, txContext = null } = {}) {
  const runner = txContext || db;
  const am = await runner.oneOrNone(
    `SELECT am.*, c.arc_id, c.vendor_id, v.name AS vendor_name, v.email AS vendor_email
       FROM tbl_arc_amendment am
       JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
       LEFT JOIN tbl_users v ON v.id = c.vendor_id
      WHERE am.id = $1`,
    [amendmentId]
  );
  if (!am) return null;
  if (['rejected', 'live', 'ended', 'voided'].includes(am.status)) return null;

  const existing = await arcAmendmentDocumentModel.getByAmendmentId(amendmentId, runner);
  if (existing) {
    if (am.status !== 'awaiting_signature') {
      await runner.none(
        `UPDATE tbl_arc_amendment SET status = 'awaiting_signature', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [amendmentId]
      );
    }
    return existing;
  }

  const ctx = await loadContractDocContext(am.arc_id, runner);
  const vendor = { name: am.vendor_name, email: am.vendor_email };
  const addendumNumber = await arcAmendmentDocumentModel.nextAddendumNumber(am.arc_contract_id, runner);
  const { url, hash } = await renderAndStoreAddendumPdf(am, ctx || {}, vendor, addendumNumber, { signed: false });

  const doc = await arcAmendmentDocumentModel.create({
    arc_amendment_id: amendmentId,
    arc_contract_id:  am.arc_contract_id,
    addendum_number:  addendumNumber,
    document_s3_url:  url,
    document_hash:    hash,
  }, runner);

  await runner.none(
    `UPDATE tbl_arc_amendment SET status = 'awaiting_signature', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [amendmentId]
  );
  await logArcEvent({
    arcId: am.arc_id,
    eventType: ARC_EVENT_TYPES.AMENDMENT_AWAITING_SIGNATURE,
    actorId,
    payload: { amendment_id: amendmentId, addendum_document_id: doc.id, addendum_number: addendumNumber },
    txContext: runner,
  });
  return doc;
}

/**
 * Vendor declined the addendum: void the addendum + amendment. Terminal — the
 * contract is unchanged and the vendor may submit a fresh amendment later.
 * Returns the updated amendment row.
 */
export async function voidAmendmentOnDecline(amendmentId, reason, { actorId = null, txContext = null } = {}) {
  const runner = txContext || db;
  const am = await runner.oneOrNone(
    `SELECT am.id, am.status, c.arc_id
       FROM tbl_arc_amendment am
       JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
      WHERE am.id = $1`,
    [amendmentId]
  );
  if (!am) return null;
  if (['live', 'ended', 'voided', 'rejected'].includes(am.status)) return am;

  await runner.none(
    `UPDATE tbl_arc_amendment_document SET status = 'voided', updated_at = CURRENT_TIMESTAMP WHERE arc_amendment_id = $1`,
    [amendmentId]
  );
  const row = await runner.one(
    `UPDATE tbl_arc_amendment SET status = 'voided', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
    [amendmentId]
  );
  await logArcEvent({
    arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_SIGN_DECLINED, actorId,
    payload: { amendment_id: amendmentId, reason }, txContext: runner,
  });
  await logArcEvent({
    arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_VOIDED, actorId,
    payload: { amendment_id: amendmentId }, txContext: runner,
  });
  return row;
}
