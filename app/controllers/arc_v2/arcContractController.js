import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractModel from '../../models/arc_v2/arcContractModel.js';
import arcAmendmentModel from '../../models/arc_v2/arcAmendmentModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import crypto from 'crypto';

/**
 * ARC v2 — Contract generation, OTP signature, vendor portal endpoints.
 *
 * Contract generation runs as a post-approval hook from
 * arcCommitteeController.handleArcCommitteeApproval — see plan §5.3 "Contract
 * generation (multi-vendor aware)". The hook groups
 * tbl_arc_comm_evaluation_award rows by awarded_vendor_id and creates one
 * contract per vendor with committed_qty = allocated_qty per line.
 *
 * The actual PDF rendering (Puppeteer + helper/arc_v2/contractTemplate.hbs)
 * is wired in as a follow-up — for now we generate the contract record with
 * a placeholder document_s3_url so the data flow is exercisable end-to-end.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

/**
 * Internal helper called by the committee post-approval hook. Returns the
 * generated contract rows.
 */
export async function generateContractsForArc(arcId, { txContext, generatedBy }) {
  const t = txContext || db;
  const comm = await arcEvalModel.getCommEval(arcId, t);
  if (!comm) throw new Error(`Cannot generate contracts: no comm eval for ARC ${arcId}`);
  const awards = await arcEvalModel.listAwards(comm.id, t);

  // Group by awarded_vendor_id.
  const groups = new Map();
  for (const a of awards) {
    if (!groups.has(a.awarded_vendor_id)) groups.set(a.awarded_vendor_id, []);
    groups.get(a.awarded_vendor_id).push(a);
  }

  const arc = await arcModel.getById(arcId, t);
  const acceptanceWindow = new Date();
  acceptanceWindow.setDate(acceptanceWindow.getDate() + 7); // default 7-day window
  const contracts = [];

  for (const [vendorId, vendorAwards] of groups) {
    const contract = await arcContractModel.createContract({
      arc_id:          arcId,
      vendor_id:       vendorId,
      // Placeholder document URL — replaced by the renderer once Puppeteer wiring lands.
      document_s3_url: null,
      awaiting_until:  acceptanceWindow,
    }, t);

    for (const award of vendorAwards) {
      // Pull rate/charges from the awarded quote line snapshot.
      const snapshot = typeof award.awarded_quote_snapshot === 'string'
        ? JSON.parse(award.awarded_quote_snapshot)
        : (award.awarded_quote_snapshot || {});
      await arcContractModel.addLine(contract.id, {
        arc_item_id:            award.arc_item_id,
        unit_rate:              snapshot.rate ?? 0,
        gst_pct:                snapshot.gst_pct ?? null,
        charges:                snapshot.charges || [],
        payment_terms:          snapshot.payment_terms ?? arc.payment_terms_expected ?? null,
        delivery_terms:         snapshot.delivery_terms ?? arc.delivery_expected ?? null,
        committed_qty:          award.allocated_qty,
        awarded_quote_snapshot: snapshot,
      }, t);
    }
    contracts.push(contract);
  }
  return contracts;
}

// ============================================================
// Vendor portal endpoints — review + OTP-sign
// ============================================================

export async function getPendingAcceptance(req, res) {
  try {
    const vendorId = req.user?.id;
    const contracts = await arcContractModel.listForVendor(vendorId, ['awaiting_acceptance']);
    return ok(res, { contracts });
  } catch (err) {
    logger.error({ err }, '[contractController.getPendingAcceptance]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getVendorActiveContracts(req, res) {
  try {
    const vendorId = req.user?.id;
    // Approved-and-live plus the archive: the page's tabs filter between
    // active / expiring / expired client-side.
    const contracts = await arcContractModel.listForVendor(vendorId, ['active','expiring_soon','expired']);
    return ok(res, { contracts });
  } catch (err) {
    logger.error({ err }, '[contractController.getVendorActiveContracts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getContractDetail(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    // Tenant guard — a vendor can only read their own contract.
    if (Number(contract.vendor_id) !== Number(vendorUserId)) {
      return bad(res, 403, 'Not the contracted vendor');
    }

    const [lines, arcInfo, callOffs, amendments] = await Promise.all([
      arcContractModel.listLines(id),
      // ARC context the detail page's hero/doc sections need: term, category,
      // BU, escalation, eligibility, and the buyer contact (creator).
      db.oneOrNone(
        `SELECT a.id AS arc_id, a.arc_number, a.title, a.status AS arc_status,
                a.contract_start_at, a.contract_end_at,
                a.payment_terms_expected, a.delivery_expected, a.penalty_clause,
                a.escalation_clause_json, a.eligibility_type,
                cat.title AS category_title,
                h.name    AS hotel_name, h.city AS hotel_city,
                u.name    AS buyer_name, u.email AS buyer_email, u.designation AS buyer_designation
           FROM tbl_arc a
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_users u ON u.id = a.created_by
          WHERE a.id = $1`,
        [contract.arc_id]
      ),
      // Call-off POs issued against this contract.
      db.any(
        `SELECT cp.id AS call_off_id, cp.po_id, cp.quantity, cp.price_applied, cp.released_at,
                po.po_number, po.status AS po_status, po.total_value,
                cl.arc_item_id, pv.name AS variant_name, ai.uom
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract_line cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
          WHERE cp.arc_contract_id = $1
          ORDER BY cp.released_at DESC`,
        [id]
      ),
      // The vendor's amendment requests on this contract (any status), with
      // buyer-side edit history joined. Shaped through vendorView below so
      // approver identities reduce to numbered levels before leaving the API.
      db.any(
        `SELECT am.id, am.amendment_type, am.amendment_from, am.amendment_to,
                am.status, am.reason, am.payload, am.current_step,
                am.approval_chain, am.created_at, am.decided_at,
                COALESCE(eh.edits, '[]'::json) AS edit_history
           FROM tbl_arc_amendment am
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'field_changed', e.field_changed,
                      'before_value',  e.before_value,
                      'after_value',   e.after_value,
                      'changed_by',    e.changed_by,
                      'changed_at',    e.changed_at,
                      'comment',       e.comment
                    ) ORDER BY e.changed_at, e.id) AS edits
               FROM tbl_arc_amendment_edit_history e
              WHERE e.arc_amendment_id = am.id
           ) eh ON TRUE
          WHERE am.arc_contract_id = $1
          ORDER BY am.created_at DESC`,
        [id]
      ).catch((err) => {
        if (/relation .* does not exist/i.test(err.message)) return [];
        throw err;
      }),
    ]);
    return ok(res, {
      contract, lines, arc: arcInfo, callOffs,
      amendments: amendments.map(arcAmendmentModel.vendorView),
    });
  } catch (err) {
    logger.error({ err }, '[contractController.getContractDetail]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function requestOtp(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    if (contract.status !== 'awaiting_acceptance') return bad(res, 409, `Contract not awaiting acceptance (status=${contract.status})`);
    const { code, expiresAt } = await arcContractModel.createOtp(id, vendorUserId);
    await logArcEvent({
      arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_OTP_REQUESTED,
      actorId: vendorUserId, payload: { contract_id: id, expires_at: expiresAt },
    });
    // The OTP would normally be sent via SMS + email helpers. For now return it
    // in dev only (the SMS/email helpers expect tenant SMTP/SMS config).
    const exposeInPayload = process.env.NODE_ENV !== 'production';
    return ok(res, { otp_expires_at: expiresAt, dev_code: exposeInPayload ? code : undefined });
  } catch (err) {
    logger.error({ err }, '[contractController.requestOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function verifyOtp(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const code = req.body?.code;
    if (!code) return bad(res, 400, 'code is required');
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    const result = await arcContractModel.verifyOtp(id, vendorUserId, code);
    if (!result.ok) return bad(res, 400, `OTP verification failed: ${result.reason}`);

    return db.tx(async (t) => {
      // Hash-pin the document. With a real PDF renderer this would hash the
      // generated PDF bytes; for the foundation we hash the contract+vendor+now
      // so the audit trail captures a stable signature artefact.
      const hashInput = JSON.stringify({
        contract_id: id, vendor_id: vendorUserId,
        signed_at: new Date().toISOString(),
      });
      const documentHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      const updated = await arcContractModel.setStatus(id, 'active', {
        document_hash: documentHash,
        signed_by_vendor_at: new Date(),
      }, t);
      await logArcEvent({
        arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_SIGNED,
        actorId: vendorUserId, payload: { contract_id: id, hash: documentHash },
        txContext: t,
      });
      // Promote the ARC to contract_active when every contract on this ARC is signed.
      const remaining = await t.one(
        `SELECT COUNT(*)::int AS c FROM tbl_arc_contract WHERE arc_id = $1 AND status != 'active'`,
        [contract.arc_id]
      );
      if (remaining.c === 0) {
        await arcModel.setStatus(contract.arc_id, 'contract_active', {}, t);
        await logArcEvent({
          arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_ACTIVE,
          actorId: vendorUserId, payload: {}, txContext: t,
        });
      }
      return ok(res, { contract: updated }, 'Contract signed');
    });
  } catch (err) {
    logger.error({ err }, '[contractController.verifyOtp]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function declineContract(req, res) {
  try {
    const id = Number(req.params.contractId);
    const vendorUserId = req.user?.id;
    const reason = req.body?.reason || null;
    const contract = await arcContractModel.getById(id);
    if (!contract) return bad(res, 404, 'Contract not found', 2);
    if (contract.vendor_id !== vendorUserId) return bad(res, 403, 'Not the contracted vendor');
    return db.tx(async (t) => {
      const updated = await arcContractModel.setStatus(id, 'declined', { terminated_reason: reason }, t);
      await logArcEvent({
        arcId: contract.arc_id, eventType: ARC_EVENT_TYPES.CONTRACT_DECLINED,
        actorId: vendorUserId, payload: { contract_id: id, reason }, txContext: t,
      });
      return ok(res, { contract: updated }, 'Contract declined');
    });
  } catch (err) {
    logger.error({ err }, '[contractController.declineContract]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Buyer-side: consumption rollup for the active dashboard
// ============================================================

export async function getActiveSummary(req, res) {
  try {
    const arcId = Number(req.params.id);
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);

    // Enrich ARC with display labels the active page needs in its hero.
    const [enrichedArc, contracts, events, callOffs, amendments] = await Promise.all([
      db.oneOrNone(
        `SELECT a.*,
                cat.title    AS category_title,
                h.name       AS hotel_name,
                h.city       AS hotel_city,
                d.title      AS department_title
           FROM tbl_arc a
           LEFT JOIN tbl_category               cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_department             d   ON d.id = a.department_id
          WHERE a.id = $1`,
        [arcId]
      ),
      arcContractModel.listForArc(arcId),
      db.any(
        `SELECT el.id, el.event_type, el.actor_id, el.payload, el.at,
                u.name AS actor_name
           FROM tbl_arc_event_log el
           LEFT JOIN tbl_users u ON u.id = el.actor_id
          WHERE el.arc_id = $1
          ORDER BY el.at DESC
          LIMIT 50`,
        [arcId]
      ),
      // Every call-off PO released against any contract of this ARC.
      // Joined to PO, MR, contract-line and variant so the front-end can
      // render the list without a second round-trip.
      db.any(
        `SELECT cp.id           AS call_off_id,
                cp.po_id,
                cp.mr_id,
                cp.arc_contract_id,
                cp.arc_contract_line_id,
                cp.quantity,
                cp.price_applied,
                cp.released_at,
                po.po_number,
                po.status        AS po_status,
                po.total_value,
                po.finalized_vendor_id AS vendor_id,
                u.name           AS vendor_name,
                mr.mr_number,
                mr.title         AS mr_title,
                cl.arc_item_id,
                ai.product_variant_id,
                pv.name          AS variant_name,
                ai.uom
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract       c  ON c.id  = cp.arc_contract_id
           JOIN tbl_arc_contract_line  cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item           ai ON ai.id = cl.arc_item_id
           LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
           LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
           LEFT JOIN tbl_material_requisition mr ON mr.id = cp.mr_id
           LEFT JOIN tbl_users u ON u.id = po.finalized_vendor_id
          WHERE c.arc_id = $1
          ORDER BY cp.released_at DESC`,
        [arcId]
      ),
      // Amendments for every contract under this ARC (Active + Requested).
      // Joined with the contract so the FE can group them per-vendor, plus
      // the per-amendment edit history (buyer counter-offers) so the review
      // modal's Edit-history tab renders without a second round-trip.
      db.any(
        `SELECT am.*,
                c.vendor_id,
                u.name AS requested_by_name,
                v.name AS vendor_name,
                COALESCE(eh.edits, '[]'::json) AS edit_history
           FROM tbl_arc_amendment am
           JOIN tbl_arc_contract  c ON c.id = am.arc_contract_id
           LEFT JOIN tbl_users u ON u.id = am.requested_by
           LEFT JOIN tbl_users v ON v.id = c.vendor_id
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'id',             e.id,
                      'field_changed',  e.field_changed,
                      'before_value',   e.before_value,
                      'after_value',    e.after_value,
                      'changed_by',     e.changed_by,
                      'changed_by_name', eu.name,
                      'comment',        e.comment,
                      'changed_at',     e.changed_at
                    ) ORDER BY e.changed_at DESC, e.id DESC) AS edits
               FROM tbl_arc_amendment_edit_history e
               LEFT JOIN tbl_users eu ON eu.id = e.changed_by
              WHERE e.arc_amendment_id = am.id
           ) eh ON TRUE
          WHERE c.arc_id = $1
          ORDER BY am.created_at DESC`,
        [arcId]
      ).catch((err) => {
        // Migration may not be applied yet — degrade gracefully, but log
        // loudly: a silent [] here hides "table missing" from the UI.
        if (/relation .* does not exist|column .* does not exist/i.test(err.message)) {
          logger.warn({ err: err.message },
            '[contractController.getActiveSummary] amendments query degraded to [] — apply the amendment migrations (tbl_arc_amendment / tbl_arc_amendment_edit_history)');
          return [];
        }
        throw err;
      }),
    ]);

    const summary = await Promise.all(contracts.map(async (c) => ({
      contract:    c,
      consumption: await arcContractModel.consumptionForContract(c.id),
    })));
    return ok(res, { arc: enrichedArc || arc, contracts: summary, events, callOffs, amendments });
  } catch (err) {
    logger.error({ err }, '[contractController.getActiveSummary]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
