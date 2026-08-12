import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import negotiationModel, { getCoveredProductIds, getVendorFieldsForProduct,
  NEG_STATE, NEG_STATE_ORDER, NEG_STATE_PRESENTATION,
  NEG_PARENT_STATE_ORDER, NEG_PARENT_ACTION_STATES } from '../../models/negotiationModel.js';
import moment from 'moment-timezone';
import rfqModel from '../../models/rfqModel.js';
import {
  recordLifecycleEvent,
  createApprovalInstance,
  submitApprovalAction,
  getApprovalInstancesByEntity,
  getApprovalInstanceById,
  findBestMatchingPolicy
} from '../../models/generalModel.js';
import db, { pgp } from '../../config/dbConn.js';
import { executeApprovalAction } from '../../services/approvalActionService.js';
import { resolveHospitalityCompanyId, resolveHospitalityCompanyScope } from '../../helper/arc_v2/resolveHospitalityCompany.js';

// Parse date strings as UTC when no timezone suffix is present
const parseAsUTC = (d) => {
  if (!d) return null;
  if (d instanceof Date) return d;
  const s = String(d);
  if (s.includes('+') || s.includes('Z')) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
};

// A round deadline written the way an Indian buyer reads it. end_date is a
// naive UTC column, so the stored digits are 5h30m behind the wall clock the
// buyer picked — "10:30" is 4 PM, not half past ten in the morning. Any
// message quoting a deadline must convert, or it reads as a different day-part
// entirely.
const formatRoundDeadlineIst = (endDate) => {
  const d = parseAsUTC(endDate);
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  })} IST`;
};
import { draftPO, buildAuthoritativePOPayload } from '../po/purchaseOrderController.js';
import { initiatePurchaseOrder } from '../../models/purchaseOrderModel.js';
import {
  buildQuoteVisibilityMeta,
  createQuoteVisibilityError,
} from '../../helper/quoteVisibility.js';
import { scheduleNegotiationRoundExpiration, removeNegotiationRoundExpiration } from '../../helper/cronManager.js';
import { sendNegotiationRoundCreatedNotification, sendNegotiationRoundApprovedNotification, sendNegotiationRoundVendorNotification } from '../../helper/sendEmailFunctions/negotiationEmails.js';
import rbacModel from '../../models/rbacModel.js';
import userModel from '../../models/userModel.js';
import {
  assertVendorsTechnicallyQualified,
  screenVendorsForTechnicalQualification,
} from '../../services/technicalQualificationService.js';

// Server-derived id for the RBAC read matrix. NEVER read from the body/query/
// headers. Returns null for super admins (user_type 8), which the model treats
// as "no matrix filter".
const readScopeUserId = (req) =>
  Number(req.user?.user_type) === 8 ? null : (req.user?.id ?? null);

const formatErrorResponse = (res, error) => {
  const statusCode = error.statusCode || 400;
  const message = error.message || Config.errorText.value;
  return res.status(statusCode).json({
    status: 3,
    message,
    meta: error.quoteVisibility ? { quoteVisibility: error.quoteVisibility } : undefined,
  });
};

const ensureNegotiationQuoteVisibilityUnlocked = async (rfqId, message) => {
  const rfqData = await rfqModel.getRfqDetailsById(rfqId);
  const quoteVisibility = buildQuoteVisibilityMeta(rfqData);
  if (quoteVisibility.locked) {
    throw createQuoteVisibilityError(quoteVisibility, message);
  }
  return { rfqData, quoteVisibility };
};

/**
 * Resolve company name, business unit (hotel) name, vendor approvals, and a vendorId->name map
 * for use in negotiation email templates. Failures are logged but never thrown — email
 * context is best-effort and should never break the parent flow.
 */
// Built-in non-charge field slugs — these are NOT in tbl_charge_names.
const NON_CHARGE_SYSTEM_SLUGS = new Set([
  'base_price', 'delivery_period', 'payment_terms', 'vendor_tc', 'comments', 'documents'
]);

const buildEmailContext = async (rfqData, round) => {
  let companyName = '';
  let businessUnitName = '';
  const vendorApprovals = Array.isArray(round?.vendor_approvals) ? round.vendor_approvals : [];
  const vendorsLookup = {};
  const vendorQuotes = {};
  const chargeLabels = {};

  try {
    const [companyRow, hotelRow] = await Promise.all([
      rfqData?.hospitality_company_id
        ? db.oneOrNone('SELECT name FROM tbl_hospitality_companies WHERE id = $1', [rfqData.hospitality_company_id])
        : Promise.resolve(null),
      rfqData?.hotel_id
        ? db.oneOrNone('SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1', [rfqData.hotel_id])
        : Promise.resolve(null),
    ]);
    companyName = companyRow?.name || '';
    businessUnitName = hotelRow?.name || '';

    const vendorIds = vendorApprovals.map(va => va.vendor_id).filter(Boolean);
    if (vendorIds.length > 0) {
      const vendorRows = await db.any(
        `SELECT id, COALESCE(organization_name, name) AS name
         FROM tbl_users
         WHERE id IN ($1:csv)`,
        [vendorIds]
      );
      for (const row of vendorRows) {
        vendorsLookup[row.id] = row.name;
      }

      // Fetch each vendor's most recent quote_item per covered product for
      // the "Vendor Quoted → Target" comparison in the email. Multi rounds
      // cover several products; legacy rounds exactly one.
      const coveredIds = getCoveredProductIds(round);
      if (round?.rfq_id && coveredIds.length > 0) {
        const quoteRows = await db.any(
          `SELECT q.created_by AS vendor_id,
                  rp.id AS rfq_product_id,
                  qi.unit_price, qi.quantity, qi.freight_price, qi.freight_mode,
                  qi.package_price, qi.package_mode, qi.tax, qi.tax_mode,
                  qi.delivery_period, qi.comment, qi.other_charges,
                  q.global_payment_term, q.global_comment, q.global_charges,
                  (SELECT json_agg(json_build_object(
                      'value', qpt.value, 'type', qpt.type, 'days', qpt.days, 'comment', qpt.comment
                    ) ORDER BY qpt.id)
                   FROM tbl_quotes_payment_terms qpt WHERE qpt.quote_id = q.id
                  ) AS payment_terms
           FROM tbl_quotes q
           JOIN tbl_quote_items qi ON qi.quote_id = q.id
           JOIN tbl_rfq_products rp
             ON rp.rfq_id = q.rfq_id
             AND rp.product_variant_id = qi.product_variant_id
             AND rp.id = ANY($3::int[])
           WHERE q.rfq_id = $1
             AND q.created_by IN ($2:csv)
           ORDER BY q."timestamp" DESC`,
          [round.rfq_id, vendorIds, coveredIds]
        );
        for (const row of quoteRows) {
          // Flat map (legacy consumers) keyed by vendor: first/latest row wins.
          if (!vendorQuotes[row.vendor_id]) vendorQuotes[row.vendor_id] = row;
          // Per-product map for multi-product email sections.
          if (!vendorQuotes[`${row.vendor_id}:${row.rfq_product_id}`]) {
            vendorQuotes[`${row.vendor_id}:${row.rfq_product_id}`] = row;
          }
        }
      }
    }

    // Resolve display labels for all charge slugs referenced by this round's
    // negotiation_fields. tbl_charge_names maps slug -> human-readable name.
    const chargeSlugs = new Set();
    const collectSlugs = (fields) => {
      for (const f of (fields || [])) {
        if (f?.name && !NON_CHARGE_SYSTEM_SLUGS.has(f.name) && !/_mode$/.test(f.name)) {
          chargeSlugs.add(f.name);
        }
      }
    };
    for (const va of vendorApprovals) {
      collectSlugs(va.negotiation_fields);
    }
    // Multi rounds carry fields in products[].vendor_targets[].fields.
    for (const p of (Array.isArray(round?.products) ? round.products : [])) {
      for (const vt of (p?.vendor_targets || [])) {
        collectSlugs(vt.fields);
      }
    }
    if (chargeSlugs.size > 0) {
      const labelRows = await db.any(
        `SELECT slug, name FROM tbl_charge_names WHERE slug IN ($1:csv)`,
        [[...chargeSlugs]]
      );
      for (const row of labelRows) chargeLabels[row.slug] = row.name;
    }
  } catch (err) {
    logError('Failed to build negotiation email context', err);
  }

  return { companyName, businessUnitName, vendorApprovals, vendorsLookup, vendorQuotes, chargeLabels };
};

/**
 * notifyNegotiationRoundLive
 *
 * The complete "this round is now live" notification bundle:
 *   1. sendNegotiationRoundApprovedNotification — internal: the round's
 *      initiator plus the hotel's commercial evaluators.
 *   2. sendNegotiationRoundVendorNotification  — the VENDOR INVITATION. Without
 *      it the round is live but nobody outside the building knows, so it ends
 *      up expiring with zero quotes.
 *
 * Both mails always travel together. They used to be copy-pasted into
 * approveRound (which sent both), createRound's auto-approve branch (both) and
 * approveVendor (which sent only the internal one — the vendors were never
 * told). This is now the single implementation; every activation path reaches
 * it through activateApprovedNegotiationRound.
 *
 * Best-effort and strictly post-commit: it is only ever invoked for a round
 * that just won the PENDING_APPROVAL -> ACTIVE race, so a double-click cannot
 * send it twice. Failures are logged, never propagated — an SMTP problem must
 * not undo an approval that has already committed.
 */
const notifyNegotiationRoundLive = async (round_id, roundRow, rfqData) => {
  const roundWithContext = await negotiationModel.getRoundWithContext(round_id);
  const round = roundWithContext || roundRow;

  const productName = roundWithContext?.product_name || 'Product';
  const productNames = (roundWithContext?.product_names || [])
    .map(p => p?.product_name)
    .filter(Boolean);

  const emailContext = await buildEmailContext(rfqData, round);

  const initiatorData = await userModel.getUserById(roundRow.created_by);
  const initiator = initiatorData?.[0]
    ? { name: initiatorData[0].name, email: initiatorData[0].email }
    : null;

  const hotelIds = rfqData.hotel_id ? [rfqData.hotel_id] : [];
  const commercialEvaluators = hotelIds.length > 0
    ? await rbacModel.getUsersWithModuleActionsForHotels(hotelIds, 'quote-compare', ['read', 'create'])
    : [];

  if (initiator) {
    await sendNegotiationRoundApprovedNotification({
      round,
      rfqNo: rfqData.rfq_no,
      rfqTitle: rfqData?.title || '',
      productName,
      productNames,
      initiator,
      commercialEvaluators: commercialEvaluators.map(u => ({ name: u.name, email: u.email })),
      companyName: emailContext.companyName,
      businessUnitName: emailContext.businessUnitName,
      vendorApprovals: emailContext.vendorApprovals,
      vendorsLookup: emailContext.vendorsLookup,
      vendorQuotes: emailContext.vendorQuotes,
      chargeLabels: emailContext.chargeLabels
    });
  }

  const vendors = await negotiationModel.getVendorsForRound(round_id);
  if (vendors.length > 0) {
    const vaByVendorId = Object.fromEntries(
      (emailContext.vendorApprovals || []).map(va => [va.vendor_id, va])
    );
    // Multi rounds: per-vendor per-product fields live in products[].
    const productsForVendor = (vid) => (Array.isArray(round?.products) ? round.products : [])
      .map(p => ({
        rfq_product_id: p?.rfq_product_id ?? null,
        is_rfq_level: p?.is_rfq_level === true,
        fields: ((p?.vendor_targets || []).find(vt => Number(vt?.vendor_id) === vid)?.fields) || []
      }))
      .filter(p => p.fields.length > 0);

    const vendorsWithTokens = await Promise.all(
      vendors.map(async (v) => {
        const tokenRows = await rfqModel.getVendorRfqToken(v.id, rfqData.rfq_no);
        return {
          id: v.id,
          name: v.name || v.organization_name || v.company_name,
          email: v.email,
          token: tokenRows?.[0]?.token || null,
          negotiation_fields: vaByVendorId[v.id]?.negotiation_fields || [],
          products: productsForVendor(v.id),
          quote: emailContext.vendorQuotes?.[v.id] || null
        };
      })
    );

    await sendNegotiationRoundVendorNotification({
      round,
      rfqNo: rfqData.rfq_no,
      rfqTitle: rfqData?.title || '',
      productName,
      productNames,
      buyerCompanyName: emailContext.companyName,
      vendors: vendorsWithTokens,
      companyName: emailContext.companyName,
      businessUnitName: emailContext.businessUnitName,
      chargeLabels: emailContext.chargeLabels
    });
  }
};

/**
 * activateNegotiationRoundInTx — the DB half of "this round is fully approved,
 * make it live". Must run inside a transaction.
 *
 * IDEMPOTENT BY CONSTRUCTION. The `WHERE status = 'PENDING_APPROVAL'` predicate
 * IS the claim: exactly one caller can win it, and only the winner runs the
 * side effects. This is what makes a double-click safe — approveRound used to
 * read round.status without a row lock and ignore the engine's
 * `already_completed` flag, so a retry re-sent the approved mail and every
 * vendor invitation (23 production rounds carry multiple APPROVED instances).
 *
 * Ordering note (Fix 2): vendor_approvals[] only flips to APPROVED HERE, i.e.
 * once the WHOLE round is approved. approveRound used to do it unconditionally,
 * outside the fully-approved branch, so on a multi-step ALL policy the first
 * approver marked every vendor APPROVED while the round was still
 * PENDING_APPROVAL.
 *
 * @returns {Promise<{activated: boolean, round: Object|null, rfqData: Object|null}>}
 */
const activateNegotiationRoundInTx = async (t, round_id, actor_user_id, remarks = null) => {
  const round = await t.oneOrNone(
    `UPDATE tbl_negotiation_rounds
        SET status = 'ACTIVE',
            approved_at = NOW(),
            published_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND status = 'PENDING_APPROVAL'
      RETURNING *`,
    [round_id]
  );

  // Lost the race (or the round was never pending) — somebody else already
  // activated it and already notified. Nothing more to do.
  if (!round) return { activated: false, round: null, rfqData: null };

  await negotiationModel.updateAllVendorsStatus(round_id, 'APPROVED', remarks || null, actor_user_id, t);

  const rfqData = round.rfq_id
    ? await t.oneOrNone(`SELECT * FROM tbl_rfq WHERE id = $1`, [round.rfq_id])
    : null;

  if (rfqData) {
    await recordLifecycleEvent({
      entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
      entity_id: round.rfq_id,
      stage: `NEGOTIATION_ROUND_${round.round_number}`,
      action: 'ROUND_PUBLISHED',
      performed_by: actor_user_id,
      metadata: {
        round_id: round_id,
        round_number: round.round_number
      },
      remarks: remarks || null,
      txContext: t
    });
  }

  return { activated: true, round, rfqData };
};

/**
 * activateApprovedNegotiationRound — THE single activation entry point.
 *
 * Every surface that can complete a NEGOTIATION approval converges here:
 *   - the generic engine (POST /general/hospitality/approval/action → the
 *     approvalActionService registry → handleNegotiationPostApproval), which
 *     is what RfqApprovalDecisionCard and the in-app pending-approvals queue
 *     call, and which previously never activated anything at all;
 *   - the dedicated endpoint POST /negotiation/rounds/:id/approve;
 *   - the vendor-level endpoint POST /negotiation/rounds/:id/approve-vendor,
 *     which previously activated the round but never invited the vendors.
 *
 * The DB writes are transactional; the notifications fire only after that
 * transaction commits, so a rollback can never leave vendors holding an
 * invitation to a round that isn't live.
 */
const activateApprovedNegotiationRound = async (round_id, actor_user_id, { remarks = null, txContext = null } = {}) => {
  const exec = (t) => activateNegotiationRoundInTx(t, round_id, actor_user_id, remarks);

  let result;
  if (txContext) {
    result = typeof txContext.tx === 'function' ? await txContext.tx(exec) : await exec(txContext);
  } else {
    result = await db.tx(exec);
  }

  if (result.activated && result.rfqData) {
    // Fire-and-forget, post-commit. Only the caller that won the activation
    // race gets here, so this cannot double-send.
    notifyNegotiationRoundLive(round_id, result.round, result.rfqData)
      .catch((emailErr) => logError('Failed to send negotiation round activation emails', emailErr));
  }

  return result;
};

/**
 * Handle NEGOTIATION post-approval actions.
 * Called after a NEGOTIATION approval instance is fully approved, from EVERY
 * surface — the generic engine dispatcher (approvalActionService's
 * postActionRegistry) and the dedicated negotiation endpoints alike.
 *
 * This function is the convergence point that Fix 1 is about. It used to write
 * finalizations and flip vendor statuses but never set status='ACTIVE',
 * approved_at, published_at, and never sent the vendor invitation — the
 * dedicated endpoint did all of that inline instead. So an approver acting from
 * the RFQ workspace saw "approved" while the round sat in PENDING_APPROVAL until
 * it expired with zero vendor quotes. Activation now lives in ONE place
 * (activateApprovedNegotiationRound) that this handler always calls.
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [options]
 * @param {Object} [options.txContext] - Optional transaction context to participate in
 * @param {Object} [options.instance]  - Pre-loaded approval instance (from the dispatcher)
 * @param {string} [options.comment]   - Approval remarks
 * @returns {Promise<{activated: boolean}>}
 */
const handleNegotiationPostApproval = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    // Get approval instance. The dispatcher pre-loads it; re-validate the
    // entity type either way so a foreign instance can never reach this path.
    const { getApprovalInstanceById } = await import('../../models/generalModel.js');
    const instance = options?.instance || await getApprovalInstanceById(approval_instance_id, 'NEGOTIATION', t);
    if (!instance || instance.entity_type !== 'NEGOTIATION' || instance.status !== 'APPROVED') {
      return { activated: false }; // Not approved yet or not NEGOTIATION type
    }

    const metadata = typeof instance.metadata === 'string'
      ? JSON.parse(instance.metadata)
      : (instance.metadata || {});
    const rfq_product_id = metadata.rfq_product_id || instance.entity_id;
    const rfq_id = metadata.rfq_id;
    const round_id = metadata.round_id || instance.entity_id;
    const remarks = options?.comment ?? null;

    // Legacy shape: a handful of historical NEGOTIATION instances carry
    // selected_quotes and expect the award to be written here. Rounds created
    // by createRound never do (their metadata has no selected_quotes), so for
    // those this block is a no-op.
    //
    // DEADNESS ASSESSMENT (why this is guarded rather than deleted):
    //   1. The entity-type re-validation above means only entity_type
    //      'NEGOTIATION' instances reach this block.
    //   2. The ONLY writer of NEGOTIATION instances is
    //      startApprovalForNegotiationRound (L584), whose metadata has no
    //      selected_quotes key at all.
    //   3. Both dispatch registries (approvalActionService.js L96,
    //      approvalPropagationService.js L425) route NEGOTIATION/APPROVED here
    //      and nowhere else.
    // So nothing the current code writes can reach these INSERTs. It is
    // unreachable-by-construction, but only for rows created by TODAY's code —
    // a historical instance could still carry the key, and that could not be
    // ruled out from this machine. Deleting the block would change behaviour
    // for such a row from "award, unguarded" to "silently no award"; guarding it
    // fails closed instead, and is a strict no-op if the block really is dead.
    if (rfq_id && metadata.selected_quotes && metadata.selected_quotes.length > 0) {
      // Same wholesale rule as every other award path. The difference is the
      // failure channel: this whole function's errors are caught and swallowed
      // below by design (a post-approval hook must not fail the approval that
      // already committed), so a throw here would ALSO skip the round
      // activation that is this function's actual job. Skipping just the award
      // block and logging is therefore the only fail-closed option available —
      // there is no HTTP response to attach a reason to.
      const legacyScreen = await screenVendorsForTechnicalQualification(
        {
          rfq_id,
          rfq_product_id,
          vendor_ids: metadata.selected_quotes.map(q => q.vendor_id),
        },
        t
      );
      if (!legacyScreen.ok) {
        logError(
          `Legacy NEGOTIATION post-approval award BLOCKED on technical qualification ` +
          `(approval_instance_id=${approval_instance_id}, rfq_id=${rfq_id}, ` +
          `rfq_product_id=${rfq_product_id}): ${legacyScreen.message}`
        );
      }
      // Get RFQ data
      const rfq = legacyScreen.ok
        ? await t.oneOrNone(`SELECT * FROM tbl_rfq WHERE id = $1`, [rfq_id])
        : null;

      if (rfq) {
        // Get product details
        const product = await t.oneOrNone(`
          SELECT rp.*, rp.product_variant_id, rp.variant
          FROM tbl_rfq_products rp
          WHERE rp.id = $1
        `, [rfq_product_id]);

        if (product) {
          // Add each selected quote to finalization
          for (const selectedQuote of metadata.selected_quotes) {
            // Check if this vendor is already finalized for this product
            const existingFinalization = await t.oneOrNone(`
              SELECT id FROM tbl_quote_finalization
              WHERE rfq_id = $1
                AND product_variant_id = $2
                AND variant = $3
                AND vendor_id = $4
            `, [rfq_id, product.product_variant_id, product.variant, selectedQuote.vendor_id]);

            if (existingFinalization) {
              // Update existing finalization
              await t.none(`
                UPDATE tbl_quote_finalization
                SET quote_id = $1, created_by = $2, timestamp = NOW()
                WHERE id = $3
              `, [selectedQuote.quote_id, approver_user_id, existingFinalization.id]);
            } else {
              // Insert new finalization record
              await t.none(`
                INSERT INTO tbl_quote_finalization
                (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, timestamp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
              `, [
                rfq_id,
                rfq.rfq_no,
                product.product_variant_id,
                selectedQuote.vendor_id,
                selectedQuote.quote_id,
                approver_user_id,
                product.variant
              ]);
            }
          }

          // Record lifecycle event
          await recordLifecycleEvent({
            entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'APPROVE',
            performed_by: approver_user_id,
            metadata: {
              approval_instance_id: approval_instance_id,
              rfq_product_id: rfq_product_id,
              quote_ids: metadata.selected_quotes.map(q => q.quote_id),
              vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
            },
            txContext: t
          });
        }
      }
    }

    // THE convergence: activate the round, propagate vendor statuses, record
    // ROUND_PUBLISHED and invite the vendors — identically, from every surface.
    if (round_id) {
      return await activateApprovedNegotiationRound(round_id, approver_user_id, { remarks, txContext });
    }
    return { activated: false };
  } catch (negQuoteError) {
    // Log but don't fail the transaction
    logError('Error handling NEGOTIATION post-approval', negQuoteError);
    return { activated: false };
  }
};

/**
 * Handle NEGOTIATION post-rejection actions.
 * Propagates REJECTED status to all vendor_approvals in the round and cancels the round.
 */
const handleNegotiationRejection = async (approval_instance_id, approver_user_id, options = {}) => {
  const txContext = options?.txContext ?? null;
  const t = txContext || db;

  try {
    const { getApprovalInstanceById } = await import('../../models/generalModel.js');
    const instance = await getApprovalInstanceById(approval_instance_id, 'NEGOTIATION', t);
    if (!instance || instance.status !== 'REJECTED') {
      return;
    }

    const metadata = instance.metadata || {};
    const round_id = metadata.round_id || instance.entity_id;
    const comment = options?.comment || null;

    if (round_id) {
      try {
        await negotiationModel.updateAllVendorsStatus(round_id, 'REJECTED', comment, approver_user_id, t);
      } catch (vaErr) {
        logError('Failed to update vendor_approvals on post-rejection', vaErr);
      }

      // Cancel the round
      try {
        await t.none(
          `UPDATE tbl_negotiation_rounds
           SET status = 'CANCELLED', remarks = COALESCE($2, remarks), updated_at = NOW()
           WHERE id = $1 AND status = 'PENDING_APPROVAL'`,
          [round_id, comment]
        );
      } catch (rndErr) {
        logError('Failed to cancel round on post-rejection', rndErr);
      }
    }
  } catch (rejErr) {
    logError('Error handling NEGOTIATION post-rejection', rejErr);
  }
};

/**
 * startApprovalForNegotiation
 *
 * Creates an approval instance for a negotiation round using the centralized approval engine.
 * Uses entity_type: 'NEGOTIATION' and entity_id: roundId (the negotiation round's own ID).
 */
const startApprovalForNegotiation = async (scope, roundId, roundNumber, rfqId, rfqData, userId, txContext, endDate = null) => {
  try {
    // `scope` is either a legacy single product id (number) or
    // { coveredProductIds: [], hasRfqLevel, isMultiProduct } for multi rounds.
    const coveredProductIds = typeof scope === 'object' && scope !== null
      ? (scope.coveredProductIds || [])
      : (scope != null ? [scope] : []);
    const hasRfqLevel = typeof scope === 'object' && scope !== null ? !!scope.hasRfqLevel : false;
    const isMultiProduct = typeof scope === 'object' && scope !== null ? !!scope.isMultiProduct : false;

    // Resolve display names for the committee approval email in one round-trip.
    const t = txContext || db;
    const names = await t.oneOrNone(
      `SELECT
         (SELECT json_agg(COALESCE(PV.name, P.name) ORDER BY rp.id)
            FROM tbl_rfq_products rp
            LEFT JOIN tbl_product_variant PV ON PV.id = rp.product_variant_id
            LEFT JOIN tbl_product P ON P.id = PV.product_id
            WHERE rp.id = ANY($1::int[])) AS product_names,
         (SELECT name FROM tbl_hospitality_companies WHERE id = $2) AS company_name,
         (SELECT name FROM tbl_hospitality_company_hotels WHERE id = $3) AS hotel_name`,
      [coveredProductIds, rfqData.hospitality_company_id, rfqData.hotel_id || null]
    );

    const productNames = (names?.product_names || []).filter(Boolean);

    const result = await createApprovalInstance({
      entity_type: 'NEGOTIATION',
      entity_id: roundId,
      hospitality_company_id: rfqData.hospitality_company_id,
      hotel_id: rfqData.hotel_id || null,
      department_id: rfqData.department_id || null,
      process_id: rfqData.process_id || null,
      initiated_by: userId,
      metadata: {
        round_id: roundId,
        round_number: roundNumber,
        rfq_id: rfqId,
        rfq_number: rfqData.rfq_no,
        rfq_title: rfqData.title || '',
        is_tender: rfqData.is_tender,
        // Singular keys kept for legacy consumers (= first covered product).
        rfq_product_id: coveredProductIds[0] ?? null,
        product_name: productNames[0] || (hasRfqLevel ? 'RFQ-level terms' : ''),
        // Multi-round metadata.
        rfq_product_ids: coveredProductIds,
        product_names: productNames,
        is_multi_product: isMultiProduct,
        has_rfq_level: hasRfqLevel,
        end_date: endDate || null,
        company_name: names?.company_name || '',
        hotel_name: names?.hotel_name || ''
      },
      txContext
    });

    return result;
  } catch (error) {
    // NoApprovalPolicyError already carries the right code/status/data —
    // propagate it as-is so the controller can render a structured 4xx with
    // NO_APPROVAL_POLICY_FOR_PROCESS instead of a generic 500.
    if (error?.code === 'NO_APPROVAL_POLICY_FOR_PROCESS') {
      throw error;
    }
    if (error.message && error.message.includes('No approval policy found')) {
      throw new Error('No approval workflow found for NEGOTIATION. Please configure an approval policy before creating negotiation rounds.');
    }
    throw error;
  }
};

/**
 * startApprovalForNegotiationQuotes
 *
 * Creates an approval instance for selected negotiation quotes.
 * Uses entity_type: 'NEGOTIATION_QUOTE' and entity_id: rfq_product_id.
 *
 * @param {number} rfqProductId - The RFQ product ID (used as entity_id)
 * @param {number} rfqId - The RFQ ID
 * @param {Array} selectedQuotes - Array of selected quote objects with full details
 * @param {Object} rfqData - The RFQ data containing hospitality_company_id, hotel_id, etc.
 * @param {number} userId - The user ID initiating the approval
 * @param {Object} txContext - Transaction context for participating in outer transaction
 * @returns {Promise<Object|null>} - Approval instance result or null if auto-approved
 */
const startApprovalForNegotiationQuotes = async (rfqProductId, rfqId, selectedQuotes, rfqData, userId, txContext) => {
  try {
    const result = await createApprovalInstance({
      entity_type: 'NEGOTIATION_QUOTE',
      entity_id: rfqProductId,
      hospitality_company_id: rfqData.hospitality_company_id,
      hotel_id: rfqData.hotel_id || null,
      department_id: rfqData.department_id || null,
      process_id: rfqData.process_id || null,
      initiated_by: userId,
      metadata: {
        rfq_id: rfqId,
        rfq_number: rfqData.rfq_no,
        rfq_title: rfqData.title || '',
        rfq_product_id: rfqProductId,
        is_tender: rfqData.is_tender,
        selected_quotes: selectedQuotes.map(q => ({
          quote_id: q.id,
          vendor_id: q.vendor_id,
          vendor_name: q.vendor_name || q.organization_name,
          quoted_price: q.quoted_price,
          negotiation_round_id: q.negotiation_round_id,
          submitted_at: q.submitted_at
        })),
        submitted_at: new Date().toISOString()
      },
      txContext
    });

    return result;
  } catch (error) {
    // NoApprovalPolicyError already carries the right code/status/data —
    // propagate it as-is (structured 4xx NO_APPROVAL_POLICY_FOR_PROCESS).
    if (error?.code === 'NO_APPROVAL_POLICY_FOR_PROCESS') {
      throw error;
    }
    // If no policy exists, throw error (don't auto-approve)
    if (error.message && error.message.includes('No approval policy found')) {
      throw new Error('No approval policy found for Quotes Approval. Please configure an approval policy before submitting quotes for approval.');
    }
    throw error;
  }
};

/**
 * addQuotesToFinalization
 *
 * Adds approved negotiation quotes to tbl_quote_finalization.
 * This is called either on auto-approval or after full committee approval.
 *
 * @param {number} rfqId - The RFQ ID
 * @param {number} rfqProductId - The RFQ product ID
 * @param {Array} quotes - Array of approved quote objects
 * @param {number} userId - The user ID who approved/initiated
 * @param {Object} rfqData - The RFQ data
 * @param {Object} txContext - Transaction context
 */
const addQuotesToFinalization = async (rfqId, rfqProductId, quotes, userId, rfqData, txContext) => {
  const t = txContext || db;

  // Get product details using model
  const product = await rfqModel.getRfqProductById(rfqProductId, rfqId, t);

  if (!product) {
    throw new Error('RFQ product not found');
  }

  // ---------------------------------------------------------------------------
  // Technical-qualification guard on the AWARD.
  //
  // This function is the chokepoint: every negotiation-quote award — the
  // auto-approve branch of POST /negotiation/quotes/submit-for-approval, and
  // both the tender and non-tender branches of
  // POST /negotiation/quotes/:rfq_product_id/approve (the latter also drafts
  // POs) — writes tbl_quote_finalization through here, for an ARBITRARY-LENGTH
  // list of vendors, and until now validated nothing but the existence of the
  // product row. POST /rfq/finalize grew a technical gate; this sibling had
  // none, so the gate was bypassable by awarding through negotiation instead —
  // and multi-vendor, so the hole was wider.
  //
  // The check lives HERE, on top of the INSERT, so it also covers callers
  // written later. The two HTTP routes additionally pre-flight the same helper
  // before committing anything, so the normal refusal is a clean 400 rather
  // than a rolled-back transaction; this throw is the backstop, not the UX.
  //
  // Refusal is WHOLESALE, not filter-and-continue — see the rationale on
  // screenVendorsForTechnicalQualification. Since we are inside the caller's
  // transaction, the throw rolls back the whole award rather than leaving a
  // partial one.
  await assertVendorsTechnicallyQualified(
    {
      rfq_id: rfqId,
      rfq_product_id: rfqProductId,
      vendor_ids: quotes.map(q => q.vendor_id),
    },
    t
  );

  for (const quote of quotes) {
    // Check if this vendor is already finalized using model
    const existingFinalization = await rfqModel.getExistingFinalization(
      rfqId, 
      product.product_variant_id, 
      product.variant, 
      quote.vendor_id,
      t
    );

    if (existingFinalization) {
      // Update existing finalization with new quote info
      await t.none(
        `UPDATE tbl_quote_finalization
         SET quote_id = $1, created_by = $2, timestamp = NOW()
         WHERE id = $3`,
        [quote.id, userId, existingFinalization.id]
      );
    } else {
      // Insert new finalization record
      await t.none(
        `INSERT INTO tbl_quote_finalization
         (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          rfqId,
          rfqData.rfq_no,
          product.product_variant_id,
          quote.vendor_id,
          quote.id,
          userId,
          product.variant
        ]
      );
    }
  }
  // Note: ARC creation is now handled immediately during product finalization, not here
};

// Export the helper function for use in general controller
export { handleNegotiationPostApproval, handleNegotiationRejection };

const NegotiationController = {
  /**
   * Create a new negotiation round (product-specific)
   * POST /negotiation/rounds
   */
  createRound: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, target_price, end_date, vendor_targets } = req.body;
      const user_id = req.user.id;

      // ── Normalize the request into a products[] array ──────────────────
      // New shape: { rfq_id, end_date, products: [{rfq_product_id, vendor_targets}, ..., {is_rfq_level, vendor_targets}] }
      // Legacy shape: { rfq_id, rfq_product_id, end_date, vendor_targets } → wrapped into one entry.
      let entries = Array.isArray(req.body.products) ? req.body.products : null;
      const isLegacyShape = !entries || entries.length === 0;
      if (isLegacyShape) {
        if (!rfq_id || !rfq_product_id || !end_date) {
          return res.status(400).json({
            status: 2,
            message: 'rfq_id, rfq_product_id, and end_date are required'
          });
        }
        entries = [{ rfq_product_id, vendor_targets }];
      } else if (!rfq_id || !end_date) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id and end_date are required'
        });
      }

      // Entry-level validation: ≤1 RFQ-level entry, valid + unique product ids,
      // and every entry needs a non-empty vendor_targets array.
      const rfqLevelEntries = entries.filter(p => p?.is_rfq_level === true);
      if (rfqLevelEntries.length > 1) {
        return res.status(400).json({
          status: 2,
          message: 'At most one RFQ-level entry is allowed per round'
        });
      }
      const productEntries = entries.filter(p => p?.is_rfq_level !== true);
      const entryProductIds = productEntries.map(p => parseInt(p?.rfq_product_id));
      if (entryProductIds.some(id => isNaN(id))) {
        return res.status(400).json({
          status: 2,
          message: 'Every product entry must carry a valid rfq_product_id'
        });
      }
      if (new Set(entryProductIds).size !== entryProductIds.length) {
        return res.status(400).json({
          status: 2,
          message: 'Duplicate rfq_product_id entries are not allowed'
        });
      }
      for (const entry of entries) {
        if (!Array.isArray(entry?.vendor_targets) || entry.vendor_targets.length === 0) {
          return res.status(400).json({
            status: 2,
            message: 'Every product entry must carry a non-empty vendor_targets array'
          });
        }
      }

      // Union of vendor ids across all entries. Note: a field needs only a
      // name — `target` is optional when the buyer raises a tax-only demand
      // (`tax_demand`) on the field.
      const vendorIdSet = new Set();
      for (const entry of entries) {
        for (const vt of entry.vendor_targets) {
          const vid = parseInt(vt?.vendor_id);
          if (!isNaN(vid)) vendorIdSet.add(vid);
        }
      }
      const parsedVendorIds = [...vendorIdSet];
      if (parsedVendorIds.length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'vendor_targets must contain valid vendor IDs'
        });
      }

      // Validate end_date is in the future (use moment.utc for consistent timezone handling)
      const endDate = moment.utc(end_date);
      const now = moment.utc();
      if (!endDate.isAfter(now)) {
        return res.status(400).json({
          status: 2,
          message: 'End date must be in the future'
        });
      }
      // Normalise to a naive UTC string before it is persisted. `end_date` is
      // `timestamp without time zone`, and Postgres casts an incoming string by
      // DISCARDING any offset and keeping the literal digits — so a client
      // sending "2026-08-12T18:00:00+05:30" would store 18:00 and be read back
      // by the whole app as 18:00 UTC, i.e. 23:30 IST: a deadline 5h30m later
      // than the buyer chose. The browser happens to send a `Z` string today
      // (NegotiationModal.js sends moment(...).utc()), which is why production
      // data is correct — but that is the client being careful, not the server.
      // Validation already parsed it as UTC above; persist exactly that.
      const endDateUtc = endDate.format('YYYY-MM-DD HH:mm:ss');

      // Check if RFQ exists and get hospitality context
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if (!rfq || rfq.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      const rfqData = rfq[0];
      if (!rfqData.hospitality_company_id) {
        return res.status(400).json({
          status: 2,
          message: 'Negotiation rounds are only available for hospitality RFQs/Tenders'
        });
      }

      const quoteVisibility = buildQuoteVisibilityMeta(rfqData);
      if (quoteVisibility.locked) {
        throw createQuoteVisibilityError(
          quoteVisibility,
          'Negotiation remains view only until the quote submission deadline has passed in IST.'
        );
      }

      // ── Per-entry validation: product exists + vendor eligibility ──────
      // `allVendors` accumulates vendor rows for error-message naming.
      const allVendors = [];
      const seenVendorRows = new Set();
      const collectVendors = (rows) => {
        for (const v of rows) {
          if (!seenVendorRows.has(v.id)) {
            seenVendorRows.add(v.id);
            allVendors.push(v);
          }
        }
      };

      for (const pid of entryProductIds) {
        const product = await rfqModel.getRfqProductById(pid, rfq_id);
        if (!product) {
          return res.status(404).json({
            status: 2,
            message: `Product ${pid} not found in this RFQ`
          });
        }
        const productVendors = await negotiationModel.getVendorsForProductWithStatus(rfq_id, pid);
        collectVendors(productVendors);
        const eligibleIds = new Set(productVendors.map(v => v.id));
        const entry = productEntries.find(p => parseInt(p.rfq_product_id) === pid);
        const entryVendorIds = entry.vendor_targets
          .map(vt => parseInt(vt?.vendor_id))
          .filter(id => !isNaN(id));
        const notEligible = entryVendorIds.filter(id => !eligibleIds.has(id));
        if (notEligible.length > 0) {
          return res.status(400).json({
            status: 2,
            message: `The following vendor ID(s) are not part of product ${pid}: ${notEligible.join(', ')}`
          });
        }
      }

      // RFQ-level entry: vendors must at least belong to the RFQ (any product).
      if (rfqLevelEntries.length === 1) {
        const rfqVendors = await negotiationModel.getVendorsForRfq(rfq_id);
        collectVendors(rfqVendors);
        const rfqVendorIds = new Set(rfqVendors.map(v => v.id));
        const entryVendorIds = rfqLevelEntries[0].vendor_targets
          .map(vt => parseInt(vt?.vendor_id))
          .filter(id => !isNaN(id));
        const notEligible = entryVendorIds.filter(id => !rfqVendorIds.has(id));
        if (notEligible.length > 0) {
          return res.status(400).json({
            status: 2,
            message: `The following vendor ID(s) are not part of this RFQ: ${notEligible.join(', ')}`
          });
        }
      }

      // ── Field-level overlap with active rounds ──────────────────────────
      const activeRounds = await negotiationModel.getActiveRoundsByRfqId(rfq_id, false);
      const vendorNameOf = (vid) => {
        const vendorInfo = allVendors.find(v => v.id === vid);
        return vendorInfo?.organization_name || vendorInfo?.company_name || vendorInfo?.name || vid;
      };

      for (const entry of entries) {
        const isRfqLevelEntry = entry?.is_rfq_level === true;
        const pid = isRfqLevelEntry ? 'RFQ_LEVEL' : parseInt(entry.rfq_product_id);
        const relevantRounds = (activeRounds || []).filter(r => {
          if (isRfqLevelEntry) {
            return Array.isArray(r.products) && r.products.some(p => p?.is_rfq_level === true);
          }
          return getCoveredProductIds(r).includes(pid);
        });

        for (const vt of entry.vendor_targets) {
          const vid = parseInt(vt.vendor_id);
          const newFields = (vt.fields || []).map(f => f?.name).filter(Boolean);
          if (newFields.length === 0) continue;

          for (const round of relevantRounds) {
            if (!Array.isArray(round.vendor_ids) || !round.vendor_ids.includes(vid)) continue;
            const activeFields = getVendorFieldsForProduct(round, vid, pid).map(f => f?.name).filter(Boolean);
            const overlappingFields = newFields.filter(f => activeFields.includes(f));
            if (overlappingFields.length > 0) {
              // Say which of the two situations this actually is. Calling a
              // PENDING_APPROVAL round "active" and telling the buyer to wait
              // for it to "complete" was actively misleading: such a round has
              // never reached the vendor, and it cannot complete — it can only
              // be approved or expire. A buyer sat blocked for 24.5 hours on
              // RFQ #536326 following that advice.
              const isPending = round.status === 'PENDING_APPROVAL';
              const fields = overlappingFields.join(', ');
              const closesAt = formatRoundDeadlineIst(round.end_date);
              return res.status(400).json({
                status: 2,
                code: isPending ? 'ROUND_AWAITING_APPROVAL' : 'ROUND_ACTIVE',
                message: isPending
                  ? `Round ${round.round_number} for ${vendorNameOf(vid)} on ${fields} is still awaiting internal approval, so it has not reached the vendor yet. Approve or reject that round before opening a new one on the same field(s).`
                  : `${vendorNameOf(vid)} has a live negotiation round on ${fields}${closesAt ? `, closing ${closesAt}` : ''}. Select different fields, or wait for that round to close.`,
                data: {
                  round_id: round.id,
                  round_number: round.round_number,
                  round_status: round.status,
                  fields: overlappingFields,
                  end_date: round.end_date
                }
              });
            }
          }
        }
      }

      // Check if approval workflow exists for NEGOTIATION before creating the round
      const approvalPolicy = await findBestMatchingPolicy({
        entity_type: 'NEGOTIATION',
        hospitality_company_id: rfqData.hospitality_company_id,
        hotel_id: rfqData.hotel_id || null,
        department_id: rfqData.department_id || null,
        process_id: rfqData.process_id || null
      });

      if (!approvalPolicy) {
        return res.status(400).json({
          status: 2,
          message: 'No approval workflow found for NEGOTIATION. Please configure an approval policy before creating negotiation rounds.'
        });
      }

      // Round numbering is RFQ-WIDE: one round, one position, however many
      // products it covers. Allocated INSIDE the transaction below — the
      // allocator serialises concurrent creates with a row lock on the parent
      // RFQ, and that lock is only held for the caller's transaction. Declared
      // here because the response message reads it after the commit.
      let round_number;

      // Persistence shape:
      //  - single product entry → legacy columns (rfq_product_id +
      //    vendor_approvals[].negotiation_fields, products NULL) so every
      //    existing read path behaves identically;
      //  - multiple entries or an RFQ-level entry → products JSONB,
      //    rfq_product_id NULL, vendor_approvals as round-wide status only.
      const isMultiShape = entries.length > 1 || rfqLevelEntries.length === 1;

      let vendor_approvals;
      let roundProducts = null;
      let legacyProductId = null;
      if (isMultiShape) {
        vendor_approvals = parsedVendorIds.map(vid => ({
          vendor_id: vid,
          status: 'PENDING',
          remarks: null,
          acted_by: null,
          acted_at: null
        }));
        roundProducts = entries.map(entry => entry?.is_rfq_level === true
          ? { is_rfq_level: true, vendor_targets: entry.vendor_targets }
          : { rfq_product_id: parseInt(entry.rfq_product_id), vendor_targets: entry.vendor_targets });
      } else {
        legacyProductId = entryProductIds[0];
        const vendorTargetsMap = new Map(
          entries[0].vendor_targets.map(v => [parseInt(v.vendor_id), v.fields || []])
        );
        vendor_approvals = parsedVendorIds.map(vid => ({
          vendor_id: vid,
          status: 'PENDING',
          remarks: null,
          acted_by: null,
          acted_at: null,
          negotiation_fields: vendorTargetsMap.get(vid) || []
        }));
      }

      // Create round in transaction
      const result = await db.tx(async (t) => {
        round_number = await negotiationModel.getNextRoundPositionForRfq(rfq_id, t);

        const round = await negotiationModel.createRound({
          rfq_id,
          rfq_product_id: legacyProductId,
          round_number,
          target_price: target_price || null,
          end_date: endDateUtc,
          status: 'PENDING_APPROVAL',
          created_by: user_id,
          vendor_ids: parsedVendorIds,
          vendor_approvals,
          products: roundProducts
        }, t);

        // Cancel stale PENDING approval instances from previous expired/
        // cancelled rounds covering any of this round's products.
        if (entryProductIds.length > 0) {
          await t.none(
            `UPDATE tbl_approval_instances
             SET status = 'CANCELLED', completed_at = NOW()
             WHERE entity_type = 'NEGOTIATION'
               AND status = 'PENDING'
               AND entity_id IN (
                 SELECT nr.id FROM tbl_negotiation_rounds nr
                 WHERE nr.status IN ('EXPIRED', 'CANCELLED')
                   AND (nr.rfq_product_id = ANY($1::int[]) OR EXISTS (
                     SELECT 1 FROM jsonb_array_elements(COALESCE(nr.products,'[]'::jsonb)) p_
                     WHERE (p_->>'rfq_product_id')::int = ANY($1::int[])
                   ))
               )`,
            [entryProductIds]
          );
        }

        // Create approval instance using the centralized approval engine
        const approvalResult = await startApprovalForNegotiation(
          {
            coveredProductIds: entryProductIds,
            hasRfqLevel: rfqLevelEntries.length === 1,
            isMultiProduct: isMultiShape
          },
          round.id,
          round_number,
          rfq_id,
          rfqData,
          user_id,
          t,
          round.end_date
        );

        // If auto-approved (initiator is the only approver), activate immediately
        if (!approvalResult || approvalResult.autoApproved) {
          // Propagate approval to all vendor_approvals entries
          await negotiationModel.updateAllVendorsStatus(round.id, 'APPROVED', null, user_id, t);

          await t.none(
            `UPDATE tbl_negotiation_rounds
             SET status = 'ACTIVE', approved_at = NOW(), published_at = NOW()
             WHERE id = $1`,
            [round.id]
          );
        }

        // Get updated round status
        const updatedRound = await t.oneOrNone(
          `SELECT * FROM tbl_negotiation_rounds WHERE id = $1`,
          [round.id]
        );

        // Record lifecycle event
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: rfq_id,
          stage: round_number === 1 ? 'NEGOTIATION_STARTED' : `NEGOTIATION_ROUND_${round_number}`,
          action: 'CREATE_ROUND',
          performed_by: user_id,
          metadata: {
            round_id: (updatedRound || round).id,
            round_number: round_number,
            rfq_product_id: legacyProductId ?? entryProductIds[0] ?? null,
            rfq_product_ids: entryProductIds,
            has_rfq_level: rfqLevelEntries.length === 1,
            target_price: target_price,
            status: (updatedRound || round).status,
            vendor_ids: parsedVendorIds
          },
          txContext: t
        });

        return updatedRound || round;
      });

      // Schedule expiration cron at exact end_date
      scheduleNegotiationRoundExpiration(result);

      // Send initiation email to the round creator (fire-and-forget)
      const isAutoApproved = result.status === 'ACTIVE';
      (async () => {
        try {
          const initiatorData = await userModel.getUserById(user_id);
          const initiator = initiatorData?.[0] ? { name: initiatorData[0].name, email: initiatorData[0].email } : null;
          const roundWithContext = await negotiationModel.getRoundWithContext(result.id);
          const productNames = (roundWithContext?.product_names || [])
            .map(p => p?.product_name)
            .filter(Boolean);
          const productName = roundWithContext?.product_name
            || productNames[0]
            || (rfqLevelEntries.length === 1 ? 'RFQ-level terms' : 'Product');

          // Resolve company + business unit (hotel) names and vendor name lookup once
          const emailContext = await buildEmailContext(rfqData, roundWithContext || result);

          if (initiator) {
            await sendNegotiationRoundCreatedNotification({
              round: { ...result, rfq_id },
              rfqNo: rfqData.rfq_no,
              rfqTitle: rfqData?.title || '',
              productName,
              productNames,
              initiator,
              autoApproved: isAutoApproved,
              companyName: emailContext.companyName,
              businessUnitName: emailContext.businessUnitName,
              vendorApprovals: emailContext.vendorApprovals,
              vendorsLookup: emailContext.vendorsLookup,
                vendorQuotes: emailContext.vendorQuotes,
                chargeLabels: emailContext.chargeLabels
            });
          }

          // If auto-approved, also notify evaluators and vendors
          if (isAutoApproved) {
            // Notify commercial evaluators (same as organic approval flow)
            const hotelIds = rfqData.hotel_id ? [rfqData.hotel_id] : [];
            const commercialEvaluators = hotelIds.length > 0
              ? await rbacModel.getUsersWithModuleActionsForHotels(hotelIds, 'quote-compare', ['read', 'create'])
              : [];

            // Send only to evaluators (initiator already gets the "Auto-Approved & Live" creation email)
            const evaluatorOnly = commercialEvaluators
              .filter(u => u.email && u.email !== initiator?.email)
              .map(u => ({ name: u.name, email: u.email }));
            if (evaluatorOnly.length > 0) {
              await sendNegotiationRoundApprovedNotification({
                round: roundWithContext || { ...result, rfq_id },
                rfqNo: rfqData.rfq_no,
                rfqTitle: rfqData?.title || '',
                productName,
                productNames,
                initiator: evaluatorOnly[0],
                commercialEvaluators: evaluatorOnly.slice(1),
                companyName: emailContext.companyName,
                businessUnitName: emailContext.businessUnitName,
                vendorApprovals: emailContext.vendorApprovals,
                vendorsLookup: emailContext.vendorsLookup,
                vendorQuotes: emailContext.vendorQuotes,
                chargeLabels: emailContext.chargeLabels
              });
            }

            // Notify vendors — attach each vendor's own negotiation_fields slice
            const vendors = await negotiationModel.getVendorsForRound(result.id);
            if (vendors.length > 0) {
              const vaByVendorId = Object.fromEntries(
                (emailContext.vendorApprovals || []).map(va => [va.vendor_id, va])
              );
              // Multi rounds: per-vendor per-product fields live in products[].
              const productsForVendor = (vid) => (Array.isArray(result.products) ? result.products : [])
                .map(p => ({
                  rfq_product_id: p?.rfq_product_id ?? null,
                  is_rfq_level: p?.is_rfq_level === true,
                  fields: ((p?.vendor_targets || []).find(vt => Number(vt?.vendor_id) === vid)?.fields) || []
                }))
                .filter(p => p.fields.length > 0);
              const vendorsWithTokens = await Promise.all(
                vendors.map(async (v) => {
                  const tokenRows = await rfqModel.getVendorRfqToken(v.id, rfqData.rfq_no);
                  return {
                    id: v.id,
                    name: v.name || v.organization_name || v.company_name,
                    email: v.email,
                    token: tokenRows?.[0]?.token || null,
                    negotiation_fields: vaByVendorId[v.id]?.negotiation_fields || [],
                    products: productsForVendor(v.id),
                    quote: emailContext.vendorQuotes?.[v.id] || null
                  };
                })
              );
              await sendNegotiationRoundVendorNotification({
                round: roundWithContext || { ...result, rfq_id },
                rfqNo: rfqData.rfq_no,
                rfqTitle: rfqData?.title || '',
                productName,
                productNames,
                buyerCompanyName: emailContext.companyName,
                vendors: vendorsWithTokens,
                companyName: emailContext.companyName,
                businessUnitName: emailContext.businessUnitName,
                chargeLabels: emailContext.chargeLabels
              });
            }
          }
        } catch (emailErr) {
          logError('Failed to send round creation email', emailErr);
        }
      })();

      return res.status(200).json({
        status: 1,
        data: result,
        message: `Negotiation round ${round_number} created successfully. ${isAutoApproved ? 'Auto-approved and live.' : 'Awaiting approval.'}`
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all rounds for an RFQ
   * GET /negotiation/rounds/:rfq_id
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getRounds: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = req.query.rfq_product_id ? parseInt(req.query.rfq_product_id) : null;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      // Vendors (user_type 3) see only rounds they are selected for
      const vendorId = req.user.user_type == 3 ? (req.user.vendor_id || req.user.id) : null;

      // P0 FIX (IDOR): this route is reachable by any authenticated buyer and
      // had NO tenant check — any rfq_id returned that RFQ's rounds, including
      // vendor identities/emails and negotiated prices. Buyers must now pass
      // the same RBAC read matrix the listings use.
      //
      // The VENDOR path is untouched: vendors arrive here legitimately via the
      // no-login email token (noLogin.vendorTokenOrJwt) and are already
      // narrowed to their own rounds by vendor_ids above.
      if (!vendorId) {
        const allowed = await negotiationModel.userCanReadRfqNegotiation(
          readScopeUserId(req),
          rfq_id
        );
        if (!allowed) {
          return res.status(403).json({
            status: 0,
            message: 'You do not have access to this RFQ'
          });
        }
      }

      const rounds = await negotiationModel.getRoundsByRfqId(rfq_id, rfq_product_id, vendorId);

      // Enrich each round with assigned vendors
      const enrichedRounds = await Promise.all(
        rounds.map(async (round) => {
          const vendors = await negotiationModel.getVendorsForRound(round.id);
          return { ...round, assigned_vendors: vendors };
        })
      );

      // Get all vendors per product with their active round status (multi
      // rounds cover several products — collect every covered id).
      const vendorsByProduct = {};
      if (rfq_product_id) {
        vendorsByProduct[rfq_product_id] = await negotiationModel.getVendorsForProductWithStatus(rfq_id, rfq_product_id);
      } else {
        const productIds = [...new Set(rounds.flatMap(r => getCoveredProductIds(r)))];
        await Promise.all(
          productIds.map(async (pid) => {
            vendorsByProduct[pid] = await negotiationModel.getVendorsForProductWithStatus(rfq_id, pid);
          })
        );
      }

      return res.status(200).json({
        status: 1,
        data: enrichedRounds,
        vendors: vendorsByProduct
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get active round for a product
   * GET /negotiation/rounds/:rfq_id/active?rfq_product_id=123
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getActiveRound: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = req.query.rfq_product_id ? parseInt(req.query.rfq_product_id) : null;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      // Vendors (user_type 3) see only rounds they are selected for
      const vendorId = req.user.user_type == 3 ? (req.user.vendor_id || req.user.id) : null;
      const round = await negotiationModel.getActiveRound(rfq_id, rfq_product_id, true, vendorId);

      // Vendors (user_type 3) should only see fully approved (ACTIVE) rounds with end_date not yet passed
      const isRoundActive = round && round.status === 'ACTIVE' && parseAsUTC(round.end_date) > new Date();
      if (!round || (req.user.user_type == 3 && !isRoundActive)) {
        return res.status(200).json({
          status: 1,
          data: null,
          message: 'No active round found for this product'
        });
      }

      return res.status(200).json({
        status: 1,
        data: round
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all active rounds for an RFQ (all products)
   * GET /negotiation/rounds/:rfq_id/active-all
   * Note: Approval details should be fetched separately via /hospitality/approval/entity/NEGOTIATION/{rfq_product_id}
   */
  getActiveRounds: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      let rounds = await negotiationModel.getActiveRoundsByRfqId(rfq_id, true);

      // Vendors (user_type 3) should only see rounds assigned to them and fully approved (ACTIVE)
      // Also filter vendor_approvals to only include the current vendor's entry
      if (req.user.user_type == 3) {
        const vendorId = req.user.vendor_id || req.user.id;
        rounds = (rounds || [])
          .filter(r =>
            r.status === 'ACTIVE' && parseAsUTC(r.end_date) > new Date() && Array.isArray(r.vendor_ids) && r.vendor_ids.includes(vendorId)
          )
          .map(({ vendor_ids, ...r }) => ({
            ...r,
            vendor_approvals: (r.vendor_approvals || []).filter(va => va.vendor_id === vendorId),
            // Multi rounds: never leak other vendors' targets in products[].
            products: Array.isArray(r.products)
              ? r.products.map(p => ({
                  ...p,
                  vendor_targets: (p?.vendor_targets || []).filter(vt => Number(vt?.vendor_id) === Number(vendorId))
                }))
              : r.products
          }));
      }

      return res.status(200).json({
        status: 1,
        data: rounds || []
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve a negotiation round (round-level, advances approval step)
   * POST /negotiation/rounds/:id/approve
   */
  approveRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      // SCOPE FIRST (P0 IDOR): this endpoint resolved the round by id and acted
      // on it with no tenant check, so any acl([2,8]) user could approve — and
      // publish to vendors — another hotel's round by guessing an id. The guard
      // runs BEFORE any state read so an out-of-scope caller cannot even learn
      // whether the round exists. Same matrix the read surfaces already use.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      // A round whose deadline has already passed must not be activated. The
      // closer is a one-shot in-memory job and demonstrably misses its window
      // (38 of 806 production rounds closed late), so a stale PENDING_APPROVAL
      // row can outlive its own deadline. Approving it here would publish a
      // round the vendor has no time to answer — and, now that the conflict
      // guard ignores past-deadline rounds, could put two live rounds on the
      // same field at once.
      const roundEndsAt = parseAsUTC(round.end_date);
      if (roundEndsAt && roundEndsAt.getTime() <= Date.now()) {
        return res.status(400).json({
          status: 2,
          message: 'This round\'s deadline has already passed, so it can no longer be approved. Create a new round instead.'
        });
      }

      // Get approval instance and submit APPROVE action
      const instances = await getApprovalInstancesByEntity('NEGOTIATION', round_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending approval instance found for this round'
        });
      }

      // Route through the centralized engine rather than the raw
      // submitApprovalAction primitive + an inline copy of the post-approval
      // work. executeApprovalAction dispatches handleNegotiationPostApproval
      // via approvalActionService's registry — the SAME function the generic
      // endpoint POST /general/hospitality/approval/action reaches — so both
      // surfaces produce identical outcomes (activation, timestamps, vendor
      // statuses, ROUND_PUBLISHED, vendor invitation) and there is no second
      // implementation left to drift or double-fire.
      //
      // The engine returns `already_completed` when the instance was already
      // terminal (double-click, refresh). We no longer act on that; and even if
      // the dispatcher re-runs the handler, activation is claimed by a
      // `WHERE status = 'PENDING_APPROVAL'` update, so the round activates once
      // and the vendors are invited once.
      const approvalResult = await executeApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'APPROVE',
        comment: remarks || null
      });

      const isFullyApproved = approvalResult.instance_status === 'APPROVED';

      return res.status(200).json({
        status: 1,
        data: {
          approved: true,
          allApproved: isFullyApproved,
          published: isFullyApproved,
          alreadyProcessed: approvalResult.already_completed === true
        },
        message: isFullyApproved
          ? 'Round approved and published to vendors'
          : 'Round approved. Waiting for other approvers.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve a specific vendor within a negotiation round (vendor-level)
   * POST /negotiation/rounds/:id/approve-vendor
   */
  approveVendor: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { vendor_id, remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      if (!vendor_id) {
        return res.status(400).json({
          status: 2,
          message: 'vendor_id is required'
        });
      }

      // SCOPE FIRST (P0 IDOR) — see approveRound.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      const vendorEntry = (round.vendor_approvals || []).find(v => v.vendor_id === vendor_id);
      if (!vendorEntry) {
        return res.status(400).json({
          status: 2,
          message: 'Vendor is not part of this negotiation round'
        });
      }

      if (vendorEntry.status === 'APPROVED') {
        return res.status(400).json({
          status: 2,
          message: 'Vendor is already approved'
        });
      }

      await negotiationModel.updateVendorApprovalStatus(round_id, vendor_id, 'APPROVED', remarks, user_id);

      const allVendorsApproved = await negotiationModel.areAllVendorsApproved(round_id);
      let isRoundActive = false;

      // When all vendors are approved, auto-advance the approval engine
      if (allVendorsApproved) {
        const instances = await getApprovalInstancesByEntity('NEGOTIATION', round_id);
        const pendingInstance = instances.find(i => i.status === 'PENDING');

        if (pendingInstance) {
          // Same centralized engine as approveRound and the generic endpoint.
          // This path used to activate the round and send ONLY the internal
          // "round approved" mail — the vendor invitation was missing, so the
          // round went live and the vendors were never told. It now reaches the
          // one shared activation function, which always sends both.
          const approvalResult = await executeApprovalAction({
            approval_instance_id: pendingInstance.id,
            approver_user_id: user_id,
            action: 'APPROVE',
            comment: remarks || 'All vendors approved'
          });

          isRoundActive = approvalResult.instance_status === 'APPROVED';
        }
      }

      const pendingCount = (round.vendor_approvals || []).filter(
        v => v.vendor_id !== vendor_id && v.status !== 'APPROVED'
      ).length;

      return res.status(200).json({
        status: 1,
        data: {
          vendor_id,
          vendor_status: 'APPROVED',
          all_vendors_approved: allVendorsApproved,
          round_active: isRoundActive
        },
        message: isRoundActive
          ? 'All vendors approved. Round is now active and published to vendors.'
          : allVendorsApproved
            ? 'All vendors approved. Progressing through approval steps.'
            : `Vendor approved. ${pendingCount} vendor(s) still pending.`
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Reject a negotiation round
   * POST /negotiation/rounds/:id/reject
   */
  rejectRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'Remarks are required for rejection'
        });
      }

      // SCOPE FIRST (P0 IDOR) — see approveRound.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      // Reject the approval instance if one exists
      const instances = await getApprovalInstancesByEntity('NEGOTIATION', round_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');
      if (pendingInstance) {
        await submitApprovalAction({
          approval_instance_id: pendingInstance.id,
          approver_user_id: user_id,
          action: 'REJECT',
          comment: remarks
        });
      }

      // Propagate rejection to all vendor_approvals entries
      await negotiationModel.updateAllVendorsStatus(round_id, 'REJECTED', remarks, user_id);

      // Cancel the entire round
      await negotiationModel.updateRoundStatus(round_id, 'CANCELLED', {
        remarks: remarks
      });

      // Remove scheduled expiration cron
      removeNegotiationRoundExpiration(round_id);

      // Record lifecycle event for round rejection
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
      const rfqData = rfq?.[0];
      if (rfqData) {
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: round.rfq_id,
          stage: `NEGOTIATION_ROUND_${round.round_number}`,
          action: 'ROUND_REJECTED',
          performed_by: user_id,
          metadata: {
            round_id: round_id,
            round_number: round.round_number,
            rfq_product_id: round.rfq_product_id,
            rfq_product_ids: getCoveredProductIds(round),
            remarks: remarks
          }
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          rejected: true
        },
        message: 'Round rejected successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Reject (disapprove) a specific vendor within a negotiation round
   * POST /negotiation/rounds/:id/reject-vendor
   */
  rejectVendor: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { vendor_id, remarks } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      if (!vendor_id) {
        return res.status(400).json({
          status: 2,
          message: 'vendor_id is required'
        });
      }

      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'Remarks are required for vendor rejection'
        });
      }

      // SCOPE FIRST (P0 IDOR) — see approveRound.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      const vendorEntry = (round.vendor_approvals || []).find(v => v.vendor_id === vendor_id);
      if (!vendorEntry) {
        return res.status(400).json({
          status: 2,
          message: 'Vendor is not part of this negotiation round'
        });
      }

      if (vendorEntry.status === 'REJECTED') {
        return res.status(400).json({
          status: 2,
          message: 'Vendor is already rejected'
        });
      }

      await negotiationModel.updateVendorApprovalStatus(round_id, vendor_id, 'REJECTED', remarks, user_id);

      return res.status(200).json({
        status: 1,
        data: {
          vendor_id,
          vendor_status: 'REJECTED'
        },
        message: 'Vendor rejected. Buyer must re-evaluate and resubmit this vendor.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Resubmit a rejected vendor for re-evaluation
   * POST /negotiation/rounds/:id/resubmit-vendor
   */
  resubmitVendor: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const { vendor_id } = req.body;

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      if (!vendor_id) {
        return res.status(400).json({
          status: 2,
          message: 'vendor_id is required'
        });
      }

      // SCOPE FIRST (P0 IDOR) — see approveRound.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'PENDING_APPROVAL') {
        return res.status(400).json({
          status: 2,
          message: `Round is not pending approval. Current status: ${round.status}`
        });
      }

      const vendorEntry = (round.vendor_approvals || []).find(v => v.vendor_id === vendor_id);
      if (!vendorEntry) {
        return res.status(400).json({
          status: 2,
          message: 'Vendor is not part of this negotiation round'
        });
      }

      if (vendorEntry.status !== 'REJECTED') {
        return res.status(400).json({
          status: 2,
          message: `Only rejected vendors can be resubmitted. Current status: ${vendorEntry.status}`
        });
      }

      await negotiationModel.resubmitRoundVendor(round_id, vendor_id);

      return res.status(200).json({
        status: 1,
        data: {
          vendor_id,
          vendor_status: 'PENDING'
        },
        message: 'Vendor resubmitted for approval.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Close a negotiation round
   * POST /negotiation/rounds/:id/close
   */
  closeRound: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const user_id = req.user.id;
      const { action } = req.body; // 'ANOTHER_ROUND', 'REVERSE_AUCTION', 'SEND_FORWARD'

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      // SCOPE FIRST (P0 IDOR) — see approveRound.
      if (!(await negotiationModel.userCanReadRound(readScopeUserId(req), round_id))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'ACTIVE' && round.status !== 'COMPLETED') {
        return res.status(400).json({
          status: 2,
          message: `Round cannot be closed. Current status: ${round.status}`
        });
      }

      // Update round status
      await negotiationModel.updateRoundStatus(round_id, 'COMPLETED', {
        closed_at: new Date()
      });

      // Remove scheduled expiration cron
      removeNegotiationRoundExpiration(round_id);

      // Record lifecycle event
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${round.rfq_id}`);
      const rfqData = rfq[0];
      await recordLifecycleEvent({
        entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: round.rfq_id,
        stage: `NEGOTIATION_ROUND_${round.round_number}`,
        action: 'ROUND_COMPLETED',
        performed_by: user_id,
        metadata: {
          round_id: round_id,
          round_number: round.round_number,
          next_action: action
        }
      });

      // Handle next action
      if (action === 'SEND_FORWARD') {
        // This would trigger award approval workflow
        // Implementation depends on existing award approval system
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: round.rfq_id,
          stage: 'NEGOTIATION_COMPLETED',
          action: 'SEND_FOR_APPROVAL',
          performed_by: user_id,
          metadata: {
            round_id: round_id
          }
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          closed: true,
          action: action
        },
        message: 'Round closed successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get quotes for a round
   * GET /negotiation/rounds/:id/quotes
   */
  getRoundQuotes: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);

      if (!round_id) {
        return res.status(400).json({
          status: 2,
          message: 'Round ID is required'
        });
      }

      // P0 FIX (IDOR): this route had NO tenant check — any authenticated buyer
      // could read any round's negotiated prices and vendor identities by id.
      // Resolve the round's parent (RFQ or ARC) and apply the same RBAC read
      // matrix the listings use. Runs BEFORE the existence probe and before the
      // quote-visibility check, so an out-of-scope id and an unknown id are
      // indistinguishable — the guard used to sit below the 404, which leaked
      // whether the round existed.
      const allowed = await negotiationModel.userCanReadRound(readScopeUserId(req), round_id);
      if (!allowed) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation round'
        });
      }

      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      await ensureNegotiationQuoteVisibilityUnlocked(
        round.rfq_id,
        'Negotiation quote details are locked until the quote submission deadline has passed in IST.'
      );

      const quotes = await negotiationModel.getRoundQuotes(round_id);

      return res.status(200).json({
        status: 1,
        data: quotes
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Vendor submits quote for a round
   * POST /negotiation/rounds/:id/quote
   */
  submitVendorQuote: async (req, res) => {
    try {
      const round_id = parseInt(req.params.id);
      const vendor_id = req.user.vendor_id || req.user.id; // Adjust based on your auth structure
      const { rfq_product_id, quoted_price, previous_price } = req.body;

      if (!round_id || !rfq_product_id || quoted_price === undefined) {
        return res.status(400).json({
          status: 2,
          message: 'round_id, rfq_product_id, and quoted_price are required'
        });
      }

      // Check if round exists and is active
      const round = await negotiationModel.getRoundById(round_id);
      if (!round) {
        return res.status(404).json({
          status: 2,
          message: 'Round not found'
        });
      }

      if (round.status !== 'ACTIVE') {
        return res.status(400).json({
          status: 2,
          message: `Round is not active. Current status: ${round.status}`
        });
      }

      // Check if vendor is assigned to this round
      const isAssigned = await negotiationModel.isVendorAssignedToRound(round_id, vendor_id);
      if (!isAssigned) {
        return res.status(403).json({
          status: 2,
          message: 'You are not assigned to this negotiation round.'
        });
      }

      // The product must be covered by the round (multi rounds cover several
      // products; legacy rounds exactly one).
      const coveredIds = getCoveredProductIds(round);
      if (!coveredIds.includes(Number(rfq_product_id))) {
        return res.status(400).json({
          status: 2,
          message: 'This product is not part of the negotiation round.'
        });
      }

      // Check if round has expired
      const expirationCheck = await negotiationModel.isRoundExpired(round_id);
      if (expirationCheck.expired) {
        return res.status(400).json({
          status: 2,
          message: 'Round has expired. Quote submission is no longer allowed.'
        });
      }

      // Check if vendor has already submitted a quote for THIS product —
      // "once per round per product".
      const existingQuote = await negotiationModel.getExistingRoundQuote(
        round_id,
        vendor_id,
        Number(rfq_product_id)
      );

      if (existingQuote) {
        return res.status(400).json({
          status: 2,
          message: 'You have already submitted a quote for this product in this negotiation round. Only one submission is allowed per round.'
        });
      }

      // Insert quote (no update allowed)
      const quote = await negotiationModel.upsertRoundQuote({
        negotiation_round_id: round_id,
        vendor_id: vendor_id,
        rfq_product_id: Number(rfq_product_id),
        quoted_price: quoted_price,
        previous_price: previous_price || null
      });

      return res.status(200).json({
        status: 1,
        data: quote,
        message: 'Quote submitted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get vendor's negotiation status for a specific product
   * GET /negotiation/rounds/:rfq_id/product/:rfq_product_id/vendor-status
   */
  getVendorNegotiationStatus: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const vendor_id = req.user.vendor_id || req.user.id;

      if (!rfq_id || !rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id and rfq_product_id are required'
        });
      }

      const status = await negotiationModel.getVendorNegotiationStatus(
        rfq_id,
        rfq_product_id,
        vendor_id
      );

      return res.status(200).json({
        status: 1,
        data: status
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get all active negotiation rounds for an RFQ with vendor's quote status
   * GET /negotiation/rounds/:rfq_id/vendor-status
   */
  getAllVendorNegotiationStatus: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const vendor_id = req.user.vendor_id || req.user.id;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      const rounds = await negotiationModel.getActiveRoundsWithVendorStatus(
        rfq_id,
        vendor_id
      );

      return res.status(200).json({
        status: 1,
        data: rounds
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // ============= NEGOTIATION QUOTES APPROVAL =============

  /**
   * Submit selected negotiation quotes for approval
   * POST /negotiation/quotes/submit-for-approval
   */
  submitQuotesForApproval: async (req, res) => {
    try {
      const { rfq_id, rfq_product_id, quote_ids, quote_source, remarks } = req.body;
      const user_id = req.user.id;
      const isRegularQuotes = quote_source === 'regular';

      // 1. Validate required fields
      if (!rfq_id || !rfq_product_id || !quote_ids || !Array.isArray(quote_ids) || quote_ids.length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id, rfq_product_id, and quote_ids (non-empty array) are required'
        });
      }

      // 2. Validate RFQ exists and is hospitality
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if (!rfq || rfq.length === 0) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      const rfqData = rfq[0];
      if (!rfqData.hospitality_company_id) {
        return res.status(400).json({
          status: 2,
          message: 'Quote approval is only available for hospitality RFQs/Tenders'
        });
      }

      // 3. Validate product belongs to RFQ using model
      const product = await rfqModel.getRfqProductById(rfq_product_id, rfq_id);
      if (!product) {
        return res.status(404).json({
          status: 2,
          message: 'Product not found in this RFQ'
        });
      }

      // 4. Check for existing pending approval for this product
      const existingApprovals = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingApproval = existingApprovals.find(a => a.status === 'PENDING');
      if (pendingApproval) {
        return res.status(400).json({
          status: 2,
          message: `A pending quote approval already exists for this product. Instance ID: ${pendingApproval.id}`
        });
      }

      let quotes;
      if (isRegularQuotes) {
        // 5a. For regular quotes (from tbl_quotes), validate they exist
        quotes = await negotiationModel.getRegularQuotesByIds(quote_ids, rfq_id, rfq_product_id);

        if (quotes.length !== quote_ids.length) {
          return res.status(400).json({
            status: 2,
            message: 'One or more quote IDs are invalid or do not belong to this product'
          });
        }
      } else {
        // 5b. For negotiation round quotes (from tbl_negotiation_round_quotes)
        quotes = await negotiationModel.getQuotesByIds(quote_ids);

        if (quotes.length !== quote_ids.length) {
          return res.status(400).json({
            status: 2,
            message: 'One or more quote IDs are invalid or do not belong to this product'
          });
        }

        // Check all rounds are either completed OR expired (end_date < now)
        const now = moment.utc();
        const invalidRounds = quotes.filter(q => {
          const roundStatus = (q.round_status || '').toUpperCase();
          const isCompleted = roundStatus === 'COMPLETED' || roundStatus === 'CLOSED';
          const endDate = q.round_end_date ? moment.utc(q.round_end_date) : null;
          const isExpired = endDate && endDate.isBefore(now);
          return !isCompleted && !isExpired;
        });
        if (invalidRounds.length > 0) {
          return res.status(400).json({
            status: 2,
            message: 'All selected quotes must be from completed or expired negotiation rounds'
          });
        }
      }

      // 5c. Technical-qualification pre-flight.
      //
      // addQuotesToFinalization enforces this too (it is the write chokepoint),
      // but doing it here as well matters for two reasons. First, the refusal
      // becomes a clean 400 carrying the reason instead of a rolled-back
      // transaction surfacing through the generic error formatter. Second — and
      // this is the substantive part — it blocks a technically disqualified
      // vendor from being put in FRONT OF AN APPROVER at all, not merely from
      // being awarded at the end. Without it, a non-auto-approving policy would
      // happily route the request to an approver whose approval could then never
      // be honoured, which is a dead end the buyer cannot clear from the UI.
      const techScreen = await screenVendorsForTechnicalQualification({
        rfq_id,
        rfq_product_id,
        vendor_ids: quotes.map(q => q.vendor_id),
      });
      if (!techScreen.ok) {
        return res.status(400).json({ status: 2, message: techScreen.message });
      }

      // 6. Execute in transaction
      const result = await db.tx(async (t) => {
        // Create approval instance
        const approvalResult = await startApprovalForNegotiationQuotes(
          rfq_product_id,
          rfq_id,
          quotes,
          rfqData,
          user_id,
          t
        );

        // If auto-approved (no approval required), directly add to finalization
        if (approvalResult && approvalResult.autoApproved) {
          await addQuotesToFinalization(rfq_id, rfq_product_id, quotes, user_id, rfqData, t);

          // Record lifecycle event
          await recordLifecycleEvent({
            entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
            entity_id: rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'AUTO_APPROVE',
            performed_by: user_id,
            metadata: {
              rfq_product_id: rfq_product_id,
              quote_ids: quote_ids,
              vendor_ids: quotes.map(q => q.vendor_id)
            },
            txContext: t
          });

          // For hospitality tenders, also create ARC approval instance
          const requiresArc = rfqData.is_tender === 1 && rfqData.hospitality_company_id;
          let arcApprovalCreated = false;

          if (requiresArc) {
            const existingArcApprovals = await getApprovalInstancesByEntity('ARC', rfq_product_id, t);
            const existingArcApproval = existingArcApprovals.find(inst =>
              inst.status === 'PENDING' || inst.status === 'APPROVED'
            );

            if (!existingArcApproval) {
              const product = await rfqModel.getRfqProductById(rfq_product_id, rfq_id, t);
              const primaryQuote = quotes[0];

              try {
                const arcApprovalResult = await createApprovalInstance({
                  entity_type: 'ARC',
                  entity_id: rfq_product_id,
                  hospitality_company_id: rfqData.hospitality_company_id,
                  hotel_id: rfqData.hotel_id || null,
                  department_id: rfqData.department_id || null,
                  process_id: rfqData.process_id || null,
                  initiated_by: user_id,
                  metadata: {
                    rfq_id: rfq_id,
                    rfq_product_id: rfq_product_id,
                    rfq_number: rfqData.rfq_no,
                    product_variant_id: product?.product_variant_id,
                    variant: product?.variant,
                    vendor_id: primaryQuote.vendor_id,
                    quote_id: primaryQuote.id,
                    is_tender: 1,
                    triggered_by: 'negotiation_quotes_auto_approval',
                    selected_quotes: quotes.map(q => ({
                      quote_id: q.id,
                      vendor_id: q.vendor_id,
                      vendor_name: q.vendor_name || q.organization_name,
                      quoted_price: q.quoted_price
                    }))
                  },
                  txContext: t
                });

                if (arcApprovalResult) {
                  arcApprovalCreated = true;
                  await recordLifecycleEvent({
                    entity_type: 'TENDER',
                    entity_id: rfq_id,
                    stage: 'ARC_SUBMITTED',
                    action: 'SUBMIT_ARC',
                    performed_by: user_id,
                    metadata: {
                      rfq_product_id: rfq_product_id,
                      approval_instance_id: arcApprovalResult.instance?.id,
                      auto_approved: arcApprovalResult.autoApproved || false,
                      triggered_by: 'negotiation_quotes_auto_approval'
                    },
                    txContext: t
                  });
                }
              } catch (arcError) {
                // Log but don't fail finalization if ARC policy not found
                logError('ARC approval creation failed during auto-approval', arcError);
              }
            }
          }

          return {
            autoApproved: true,
            quotes: quotes,
            arcApprovalCreated
          };
        }

        // Record lifecycle event for submission
        await recordLifecycleEvent({
          entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
          entity_id: rfq_id,
          stage: 'NEGOTIATION_QUOTES_SUBMITTED',
          action: 'SUBMIT_FOR_APPROVAL',
          performed_by: user_id,
          metadata: {
            approval_instance_id: approvalResult.instance?.id,
            rfq_product_id: rfq_product_id,
            quote_ids: quote_ids
          },
          remarks: remarks,
          txContext: t
        });

        return {
          autoApproved: false,
          approvalResult: approvalResult,
          quotes: quotes
        };
      });

      if (result.autoApproved) {
        return res.status(200).json({
          status: 1,
          data: {
            status: 'AUTO_APPROVED',
            selected_quotes: result.quotes.map(q => ({
              quote_id: q.id,
              vendor_id: q.vendor_id,
              vendor_name: q.vendor_name || q.organization_name,
              quoted_price: q.quoted_price
            })),
            finalization_complete: true,
            arc_approval_created: result.arcApprovalCreated || false
          },
          message: result.arcApprovalCreated
            ? 'Quotes auto-approved, finalized, and ARC approval submitted'
            : 'Quotes auto-approved and added to finalization'
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          approval_instance_id: result.approvalResult.instance?.id,
          status: 'PENDING',
          selected_quotes: result.quotes.map(q => ({
            quote_id: q.id,
            vendor_id: q.vendor_id,
            vendor_name: q.vendor_name || q.organization_name,
            quoted_price: q.quoted_price
          })),
          total_steps: result.approvalResult.totalSteps,
          current_step: 1
        },
        message: 'Quotes submitted for approval successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get quote approval status for a product
   * GET /negotiation/quotes/:rfq_product_id/approval-status
   */
  getQuoteApprovalStatus: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const latestInstance = instances[0]; // Already ordered by created_at DESC

      if (!latestInstance) {
        return res.status(200).json({
          status: 1,
          data: {
            has_pending_approval: false,
            approval_instance: null
          }
        });
      }

      // Lazy-heal stale APPROVED rows. handlePORejection now cancels the
      // matching NEGOTIATION_QUOTE instance whenever the last vendor on a
      // product is de-finalized, but rejections that happened before that
      // fix shipped left orphaned APPROVED rows behind. The source of truth
      // for "is this approval still in force?" is whether any vendor still
      // has a finalization row for the product — if none do, the approval
      // has been rolled back and this endpoint must not report APPROVED.
      let effectiveStatus = latestInstance.status;
      let effectiveCompletedAt = latestInstance.completed_at;
      if (effectiveStatus === 'APPROVED') {
        const rfqProduct = await db.oneOrNone(
          `SELECT rfq_id, product_variant_id, variant FROM tbl_rfq_products WHERE id = $1`,
          [rfq_product_id]
        );
        if (rfqProduct) {
          const stillFinalized = await db.oneOrNone(
            `SELECT 1 FROM tbl_quote_finalization
              WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3
              LIMIT 1`,
            [rfqProduct.rfq_id, rfqProduct.product_variant_id, rfqProduct.variant]
          );
          if (!stillFinalized) {
            await db.none(
              `UPDATE tbl_approval_instances
                SET status = 'CANCELLED', completed_at = NOW()
                WHERE id = $1 AND status = 'APPROVED'`,
              [latestInstance.id]
            );
            effectiveStatus = 'CANCELLED';
            effectiveCompletedAt = new Date();
          }
        }
      }

      return res.status(200).json({
        status: 1,
        data: {
          has_pending_approval: effectiveStatus === 'PENDING',
          approval_instance: {
            id: latestInstance.id,
            status: effectiveStatus,
            metadata: latestInstance.metadata,
            created_at: latestInstance.created_at,
            completed_at: effectiveCompletedAt
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve negotiation quotes
   * POST /negotiation/quotes/:rfq_product_id/approve
   */
  approveQuotes: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const user_id = req.user.id;
      const { remarks, existing_po_id } = req.body;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      // 1. Get pending approval instance
      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending quote approval found for this product'
        });
      }

      // 1b. Technical-qualification pre-flight — BEFORE the approval action.
      //
      // ORDERING IS THE WHOLE POINT. submitApprovalAction below COMMITS the
      // approval; the award is only written afterwards, in a separate db.tx.
      // A refusal raised from inside that later transaction would roll back the
      // award but NOT the approval, leaving the instance APPROVED with nothing
      // finalized — a state no screen can explain and no action can clear.
      // Checking first means a disqualified vendor costs the approver a 400 and
      // nothing else.
      //
      // This is not redundant with the check at submit time. A vendor can pass
      // technical evaluation when the quotes are submitted and be failed before
      // the approver acts (evaluation reopened, verdict corrected), and
      // approvals created by older code paths never passed a technical check at
      // all. The verdict that binds is the one standing at the moment of award.
      //
      // Both award-carrying metadata shapes are screened:
      //   - selected_quotes[]        — the negotiation multi-vendor award,
      //                                which flows into addQuotesToFinalization.
      //   - po_payload + vendor_id   — the single vendor parked here by
      //                                rfqController.finalize, which drafts a PO
      //                                directly and never touches
      //                                addQuotesToFinalization, so the
      //                                chokepoint guard would miss it.
      const guardMeta = typeof pendingInstance.metadata === 'string'
        ? JSON.parse(pendingInstance.metadata)
        : (pendingInstance.metadata || {});
      const guardVendorIds = Array.isArray(guardMeta.selected_quotes) && guardMeta.selected_quotes.length > 0
        ? guardMeta.selected_quotes.map(q => q.vendor_id)
        : (guardMeta.vendor_id ? [guardMeta.vendor_id] : []);
      if (guardVendorIds.length > 0) {
        // entity_id IS the rfq_product_id for NEGOTIATION_QUOTE, so prefer the
        // route param over metadata and fall back to the product row for rfq_id
        // — older instances do not all carry rfq_id in metadata.
        const guardRfqId = guardMeta.rfq_id
          || (await rfqModel.getRfqProductById(rfq_product_id))?.rfq_id;
        if (guardRfqId) {
          const techScreen = await screenVendorsForTechnicalQualification({
            rfq_id: guardRfqId,
            rfq_product_id,
            vendor_ids: guardVendorIds,
          });
          if (!techScreen.ok) {
            return res.status(400).json({ status: 2, message: techScreen.message });
          }
        }
      }

      // 2. Submit approval action
      const result = await submitApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'APPROVE',
        comment: remarks || null
      });

      const isFullyApproved = result.instance_status === 'APPROVED';
      let arcApprovalCreated = false;

      // 3. If fully approved, add to finalization and create ARC
      if (isFullyApproved) {
        const instance = await getApprovalInstanceById(pendingInstance.id, 'NEGOTIATION_QUOTE');
        const metadata = instance?.metadata || {};

        // Path A: PO payload stored by rfqController.finalize (direct vendor finalization)
        if (metadata.po_payload && metadata.po_user) {
          // Final approver can choose to merge into an existing PO
          const poPayload = { ...metadata.po_payload };
          if (existing_po_id) {
            poPayload.existing_po_id = existing_po_id;
          }

          await db.tx(async (t) => {
            const authPayload = await buildAuthoritativePOPayload(poPayload, t);
            const poResult = await draftPO(authPayload, metadata.po_user, t);

            await recordLifecycleEvent({
              entity_type: metadata.is_tender === 1 ? 'TENDER' : 'RFQ',
              entity_id: metadata.rfq_id,
              stage: 'NEGOTIATION_QUOTES_APPROVED',
              action: 'APPROVE',
              performed_by: user_id,
              metadata: {
                approval_instance_id: pendingInstance.id,
                rfq_product_id: metadata.rfq_product_id,
                vendor_id: metadata.vendor_id,
                quote_id: metadata.quote_id
              },
              txContext: t
            });
          });
        } else if (metadata.rfq_id && metadata.selected_quotes?.length > 0) {
          const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${metadata.rfq_id}`);
          const rfqData = rfq[0];

          // Check if this is a hospitality tender (requires ARC)
          const requiresArc = rfqData.is_tender === 1 && rfqData.hospitality_company_id;

          // Convert metadata quotes to format expected by addQuotesToFinalization
          const quotesForFinalization = metadata.selected_quotes.map(q => ({
            id: q.quote_id,
            vendor_id: q.vendor_id
          }));

          if (requiresArc) {
            // For hospitality tenders: Use transaction to ensure atomicity
            // If ARC creation fails, finalization is rolled back
            await db.tx(async (t) => {
              // Finalize quotes within transaction
              await addQuotesToFinalization(
                metadata.rfq_id,
                rfq_product_id,
                quotesForFinalization,
                user_id,
                rfqData,
                t
              );

              // Record lifecycle event
              await recordLifecycleEvent({
                entity_type: 'TENDER',
                entity_id: metadata.rfq_id,
                stage: 'NEGOTIATION_QUOTES_APPROVED',
                action: 'APPROVE',
                performed_by: user_id,
                metadata: {
                  approval_instance_id: pendingInstance.id,
                  rfq_product_id,
                  quote_ids: metadata.selected_quotes.map(q => q.quote_id),
                  vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
                },
                txContext: t
              });

              // Check if ARC approval already exists
              const existingArcApprovals = await getApprovalInstancesByEntity('ARC', rfq_product_id, t);
              const existingArcApproval = existingArcApprovals.find(inst =>
                inst.status === 'PENDING' || inst.status === 'APPROVED'
              );

              if (!existingArcApproval) {
                // Get product details for metadata
                const product = await rfqModel.getRfqProductById(rfq_product_id, metadata.rfq_id, t);
                const primaryQuote = metadata.selected_quotes[0];

                // Create ARC approval instance - if this fails, transaction rolls back
                const arcApprovalResult = await createApprovalInstance({
                  entity_type: 'ARC',
                  entity_id: rfq_product_id,
                  hospitality_company_id: rfqData.hospitality_company_id,
                  hotel_id: rfqData.hotel_id || null,
                  department_id: rfqData.department_id || null,
                  process_id: rfqData.process_id || null,
                  initiated_by: user_id,
                  metadata: {
                    rfq_id: metadata.rfq_id,
                    rfq_product_id: rfq_product_id,
                    rfq_number: rfqData.rfq_no,
                    product_variant_id: product?.product_variant_id,
                    variant: product?.variant,
                    vendor_id: primaryQuote.vendor_id,
                    quote_id: primaryQuote.quote_id,
                    is_tender: 1,
                    triggered_by: 'negotiation_quotes_approval',
                    selected_quotes: metadata.selected_quotes
                  },
                  txContext: t
                });

                if (arcApprovalResult) {
                  arcApprovalCreated = true;

                  // Record lifecycle event for ARC submission
                  await recordLifecycleEvent({
                    entity_type: 'TENDER',
                    entity_id: metadata.rfq_id,
                    stage: 'ARC_SUBMITTED',
                    action: 'SUBMIT_ARC',
                    performed_by: user_id,
                    metadata: {
                      rfq_product_id: rfq_product_id,
                      approval_instance_id: arcApprovalResult.instance?.id,
                      auto_approved: arcApprovalResult.autoApproved || false,
                      triggered_by: 'negotiation_quotes_approval'
                    },
                    txContext: t
                  });
                }
              } else {
                arcApprovalCreated = true; // Already exists
              }
            });
          } else {
            // For non-hospitality or non-tender: Finalize and create PO drafts
            await db.tx(async (t) => {
              await addQuotesToFinalization(
                metadata.rfq_id,
                rfq_product_id,
                quotesForFinalization,
                user_id,
                rfqData,
                t
              );

              // Record lifecycle event
              await recordLifecycleEvent({
                entity_type: rfqData.is_tender === 1 ? 'TENDER' : 'RFQ',
                entity_id: metadata.rfq_id,
                stage: 'NEGOTIATION_QUOTES_APPROVED',
                action: 'APPROVE',
                performed_by: user_id,
                metadata: {
                  approval_instance_id: pendingInstance.id,
                  rfq_product_id,
                  quote_ids: metadata.selected_quotes.map(q => q.quote_id),
                  vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
                },
                txContext: t
              });

              // Create PO drafts for each finalized vendor (RFQ flow)
              const product = await rfqModel.getRfqProductById(rfq_product_id, metadata.rfq_id, t);
              if (product) {
                for (const selectedQuote of metadata.selected_quotes) {
                  try {
                    // Get vendor's original quote item for quantity/unit.
                    //
                    // `qi.unit` USED TO BE SELECTED HERE AND DOES NOT EXIST.
                    // tbl_quote_items has no unit-of-measure column (see
                    // tests/setup/schema.sql — the pg_dump of the real
                    // database), so this query raised 42703 "column qi.unit does
                    // not exist" on EVERY execution. The consequences were much
                    // worse than a missing unit, because of where the failure
                    // landed:
                    //
                    //   1. submitApprovalAction has already committed the
                    //      approval on its own connection — the instance is
                    //      APPROVED for good.
                    //   2. This query runs inside the surrounding db.tx, AFTER
                    //      addQuotesToFinalization has inserted the award and
                    //      recordLifecycleEvent has logged it.
                    //   3. It throws. The `catch (poError)` below swallows the
                    //      JS error — but a failed statement has already put
                    //      POSTGRES into an aborted transaction, which no JS
                    //      catch can undo. pg-promise's COMMIT degrades to a
                    //      ROLLBACK, silently discarding the award and the
                    //      lifecycle row written in steps 2.
                    //   4. The endpoint still answers 200 "Quotes fully approved
                    //      and finalized".
                    //
                    // Net effect in production: on this branch the approval was
                    // recorded, the caller was told the award succeeded, and
                    // tbl_quote_finalization got nothing at all. Dropping the
                    // phantom column is the whole fix — `unit` was already
                    // written as `vendorQuoteItem.unit || 'N/A'` below, and the
                    // fallback is now simply always taken, which is the value
                    // the column could ever have produced anyway.
                    const vendorQuoteItem = await t.oneOrNone(
                      `SELECT qi.quantity, qi.unit_price, qi.id as quote_item_id,
                              qi.freight_price, qi.freight_mode, qi.package_price, qi.package_mode, qi.tax, qi.tax_mode,
                              qi.other_charges
                       FROM tbl_quote_items qi
                       JOIN tbl_quotes q ON q.id = qi.quote_id
                       WHERE q.rfq_id = $1 AND qi.product_variant_id = $2 AND qi.variant = $3 AND q.created_by = $4
                       ORDER BY q.timestamp DESC LIMIT 1`,
                      [metadata.rfq_id, product.product_variant_id, product.variant, selectedQuote.vendor_id]
                    );

                    if (vendorQuoteItem) {
                      const negotiationPrice = parseFloat(selectedQuote.quoted_price);
                      const quantity = parseFloat(vendorQuoteItem.quantity) || 1;
                      const totalValue = quantity * negotiationPrice;

                      const poResult = await draftPO({
                        rfq_id: metadata.rfq_id,
                        project_id: rfqData.project_id,
                        total_value: totalValue,
                        quote_item_id: vendorQuoteItem.quote_item_id,
                        product_info: {
                          rfq_product_id,
                          quantity: vendorQuoteItem.quantity,
                          unit: vendorQuoteItem.unit || 'N/A',
                          unit_price: negotiationPrice,
                          charges_meta: {
                            freight_price: vendorQuoteItem.freight_price,
                            freight_mode: vendorQuoteItem.freight_mode,
                            package_price: vendorQuoteItem.package_price,
                            package_mode: vendorQuoteItem.package_mode,
                            tax: vendorQuoteItem.tax,
                            tax_mode: vendorQuoteItem.tax_mode,
                            other_charges: vendorQuoteItem.other_charges || []
                          },
                          finalized_vendor_id: selectedQuote.vendor_id
                        }
                      }, { id: instance.initiated_by || user_id, company_id: req.user.company_id }, t);
                    }
                  } catch (poError) {
                    logError(`Error creating PO for vendor ${selectedQuote.vendor_id}`, poError);
                  }
                }
              }
            });
          }
        }
      }

      return res.status(200).json({
        status: 1,
        data: {
          approved: true,
          fully_approved: isFullyApproved,
          finalized: isFullyApproved,
          instance_status: result.instance_status,
          next_step: result.next_step || null,
          arc_approval_created: arcApprovalCreated
        },
        message: isFullyApproved
          ? (arcApprovalCreated
              ? 'Quotes approved, finalized, and ARC approval submitted'
              : 'Quotes fully approved and finalized')
          : 'Approval recorded. Waiting for other approvers.'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Reject negotiation quotes
   * POST /negotiation/quotes/:rfq_product_id/reject
   */
  rejectQuotes: async (req, res) => {
    try {
      const rfq_product_id = parseInt(req.params.rfq_product_id);
      const user_id = req.user.id;
      const { remarks } = req.body;

      if (!rfq_product_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_product_id is required'
        });
      }

      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({
          status: 2,
          message: 'Remarks are required for rejection'
        });
      }

      // 1. Get pending approval instance
      const instances = await getApprovalInstancesByEntity('NEGOTIATION_QUOTE', rfq_product_id);
      const pendingInstance = instances.find(i => i.status === 'PENDING');

      if (!pendingInstance) {
        return res.status(400).json({
          status: 2,
          message: 'No pending quote approval found for this product'
        });
      }

      // 2. Submit the rejection through the centralized engine.
      //
      // This used to call the raw `submitApprovalAction` model primitive and
      // then repeat the rollback inline (reset finalization + record lifecycle
      // event). The generic endpoint POST /general/hospitality/approval/action
      // had no equivalent, because NEGOTIATION_QUOTE carried no REJECTED entry
      // in approvalActionService's postActionRegistry — so a reject taken from
      // the entity-agnostic approval card left the product finalized to the
      // refused vendor.
      //
      // Both surfaces now converge on ONE implementation:
      // handleNegotiationQuoteRejection, reached through the registry.
      // executeApprovalAction dispatches it exactly once (only when the
      // instance actually lands on REJECTED), so there is no inline copy left
      // to double-fire. Post-action failures are logged and swallowed by the
      // dispatcher rather than surfacing as a 4xx here — correct, because the
      // approval transition has already committed at that point.
      await executeApprovalAction({
        approval_instance_id: pendingInstance.id,
        approver_user_id: user_id,
        action: 'REJECT',
        comment: remarks
      });

      return res.status(200).json({
        status: 1,
        data: { rejected: true },
        message: 'Quotes rejected successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getApprovalBundle: async (req, res) => {
    try {
      const rfqId = parseInt(req.params.rfq_id, 10);
      const userId = req.user?.id || null;

      if (!rfqId || isNaN(rfqId)) {
        return res.status(400).json({ status: 2, message: 'Invalid RFQ ID' });
      }

      // The rfq_id arrives straight off the URL and nothing downstream scoped
      // it: the model's query is `WHERE nr.rfq_id = $1` with no tenant
      // predicate, and `userId` was passed only to compute can_user_approve.
      // Any authenticated buyer could therefore read ANY RFQ's negotiation
      // rounds — vendor identities, target prices, approver names and emails —
      // by editing the id in the URL.
      //
      // Gated BEFORE any state read, so an out-of-scope caller cannot even
      // learn whether the RFQ exists. Same matrix, same 403 shape, as the
      // sibling round-detail endpoints.
      if (!(await negotiationModel.userCanReadRfqNegotiations(readScopeUserId(req), rfqId))) {
        return res.status(403).json({
          status: 0,
          message: 'You do not have access to this negotiation'
        });
      }

      const bundle = await negotiationModel.getApprovalBundleForRfq(rfqId, userId);

      return res.status(200).json({
        status: 1,
        data: bundle
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Buyer landing list — every RFQ in negotiation for the active hospitality
   * company/hotel context, with an effective neg_status the frontend buckets
   * into tabs. Scope comes from attachHospitalityContext() (company required,
   * hotel optional).
   */
  listNegotiationRfqs: async (req, res) => {
    try {
      // Scope to ALL the user's companies (super admin → null = all) so multi-
      // company users see their negotiations; the in-page BU facet narrows.
      const companyIds = await resolveHospitalityCompanyScope(req);
      // Company scope alone is NOT sufficient — a hotel-level mapping collapses
      // to company-wide there. The per-row RBAC matrix (userId) is what keeps
      // one hotel's rounds out of another hotel's user's list.
      const rows = await negotiationModel.getNegotiationRfqList({
        companyIds,
        userId: readScopeUserId(req),
      });
      return res.status(200).json({ status: 1, data: rows });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Server-authoritative listing — search / facet / sort / paginate + a
  // "Pending for me" tab, all server-side. Mirrors rfqController.getRfqListView.
  //
  // TWO LEVELS, ONE PIPELINE. `groupBy` selects the row grain:
  //
  //   'parent' (DEFAULT) one row per RFQ / per ARC. This is what the listing
  //                      renders: RFQ 512 has 138 negotiation rounds and users
  //                      read 138 rows as 138 different RFQs.
  //   'round'            one row per negotiation round — the historic shape,
  //                      byte-for-byte. Nothing below branches on the level
  //                      except the row accessors, so the two levels cannot
  //                      drift into disagreeing status vocabularies the way
  //                      the listing and the detail page once did.
  //
  // There is deliberately NO second route: one endpoint, one pipeline.
  getNegotiationListView: async (req, res) => {
    try {
      const userId = req.user?.id;
      const companyIds = await resolveHospitalityCompanyScope(req);
      // Per-row RBAC read matrix. Derived from req.user only — a client can
      // never widen it. Facets, tab_counts, source_counts, total and the page
      // slice are all computed from the rows this returns, so they inherit it.
      const scopeUserId = readScopeUserId(req);
      const body = req.body || {};
      const groupBy = body.groupBy === 'round' ? 'round' : 'parent';
      const isParent = groupBy === 'parent';
      const BUCKETS = Object.values(NEG_STATE);
      // Grouped tabs. The strip carried eight sentence-length labels and wrapped
      // onto a second line; per user the median number of NON-EMPTY status tabs
      // is 2 (max 5). Membership is NEG_PARENT_ACTION_STATES — the same split
      // the parent roll-up already uses — so the two can never drift.
      //
      // awaiting_approval and open_with_vendors read as 0 parents right now but
      // are deliberately INSIDE needs_attention: they are short-lived (median
      // dwell 133 min and 258 min) and are the only two states that ever need a
      // human. Grouping them is fine; dropping them would not be.
      const GROUPS = {
        needs_attention: (b) => NEG_PARENT_ACTION_STATES.has(b),
        closed: (b) => !NEG_PARENT_ACTION_STATES.has(b),
      };
      const tab = ['all', 'for_me', ...Object.keys(GROUPS), ...BUCKETS].includes(body.tab) ? body.tab : 'all';
      // Orthogonal to `tab`: a round's state and whether it waits on the caller
      // are different questions, so the toggle composes with any status tab.
      const needsMyApproval = body.needsMyApproval === true || body.needsMyApproval === 'true';
      const source = ['all', 'RFQ', 'ARC'].includes(body.source) ? body.source : 'all';
      const search = (body.search || '').toString().trim().toLowerCase() || null;
      // Tokenize the term. Two reasons:
      //  1. The UI renders every RFQ/ARC number as "#536299" (cards AND the RFQ
      //     facet label), so users type the '#'. The haystack below is built
      //     from raw column values and contains no '#', so a plain
      //     `hay.includes('#536299')` could never match — searching the number
      //     exactly as displayed returned zero rows.
      //  2. A single substring match also meant multi-word terms like
      //     "orchid 536150" never matched, because the haystack's field order
      //     rarely happens to place those words adjacent.
      // Stripping a LEADING '#' per token (never an interior one) and requiring
      // every token to be present fixes both. The ARC branch inherits the fix
      // for free at BOTH grains — the ARC round and parent queries alike alias
      // `arc_number AS rfq_no`.
      // A term of only '#' collapses to zero tokens and is treated as no search.
      const searchTokens = search
        ? search.split(/\s+/).map((t) => t.replace(/^#+/, '')).filter(Boolean)
        : [];
      // 'rounds' and 'savings' only mean anything on a parent row; on the round
      // grain they fall back to 'recent' rather than 400ing.
      const SORT_KEYS = isParent
        ? ['recent', 'oldest', 'status', 'rounds', 'savings']
        : ['recent', 'oldest', 'status'];
      const sort = SORT_KEYS.includes(body.sort) ? body.sort : 'recent';
      const page = Number(body.page) > 0 ? Number(body.page) : 1;
      const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : 20;
      const f = body.filters || {};
      const asStrArr = (v) => (Array.isArray(v) ? v.map(String) : []);
      const filters = {
        // rfqId keeps working verbatim. NOTE it can never select an ARC parent:
        // ARC rows carry rfq_id = NULL by construction. That is exactly why
        // parentKey exists.
        rfqId: asStrArr(f.rfqId),
        parentKey: asStrArr(f.parentKey),
        status: asStrArr(f.status), buId: asStrArr(f.buId), departmentId: asStrArr(f.departmentId),
        productId: asStrArr(f.productId), vendorId: asStrArr(f.vendorId),
      };

      // 1. fetch the full scoped set. Always fetch both branches so
      // source_counts reflects the full union totals.
      const [rfqRows, arcRows] = await Promise.all([
        isParent
          ? negotiationModel.getNegotiationParentList({ companyIds, userId: scopeUserId })
          : negotiationModel.getNegotiationRoundList({ companyIds, userId: scopeUserId }),
        isParent
          ? negotiationModel.getArcNegotiationParentList({ companyIds, userId: scopeUserId })
          : negotiationModel.getArcNegotiationRoundList({ companyIds, userId: scopeUserId }),
      ]);
      const allRows = [...rfqRows, ...arcRows];
      const source_counts = { all: allRows.length, RFQ: rfqRows.length, ARC: arcRows.length };
      // Narrow to the requested source AFTER computing counts.
      const sourceRows = source === 'RFQ' ? rfqRows : source === 'ARC' ? arcRows : allRows;

      const parseArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } })() : []));

      // Parent identity of a row at EITHER grain. Round rows do not carry a
      // parent_key column (their shape is frozen), so it is derived here for
      // filtering only — deriving it never adds a field to the response.
      const parentKeyOf = (r) =>
        r.parent_key || (r.rfq_id != null ? `RFQ:${r.rfq_id}` : r.arc_id != null ? `ARC:${r.arc_id}` : null);

      // 2. SEARCH — moved AHEAD of tab_counts and facets.
      // It used to run last, so a search from the "All" tab left every tab
      // badge showing its unsearched total and the facet lists full of options
      // that matched nothing on screen. Badges now count what the user can
      // actually see. Scope still bounds everything: search NARROWS the RBAC
      // row set and can never reach outside it.
      const rows = searchTokens.length
        ? sourceRows.filter((r) => {
            const hay = [
              r.title, r.rfq_no, r.hotel_name, r.department_title,
              ...parseArr(r.item_names).map((n) => (n && typeof n === 'object' ? n.product_name : n)),
              ...parseArr(r.vendors).map((v) => v && v.name),
            ].filter(Boolean).join(' ').toLowerCase();
            return searchTokens.every((tk) => hay.includes(tk));
          })
        : sourceRows;

      // 3. bucket + pending-for-me stamping.
      const pendingKeys = new Set(
        rows.length && userId
          ? isParent
            ? await negotiationModel.getPendingNegotiationParentIds(rows.map(parentKeyOf).filter(Boolean), userId)
            : (await negotiationModel.getPendingNegotiationRoundIds(rows.map((r) => r.round_id), userId)).map(Number)
          : []
      );
      for (const r of rows) {
        // neg_status IS the bucket at both grains: negotiationStateCaseSql emits
        // one of the seven NEG_STATE keys per round, and the parent query rolls
        // those up with NEG_PARENT_STATE_ORDER into one of the same seven. Tabs
        // therefore partition the rows — every row lands in exactly one.
        r._bucket = NEG_STATE_PRESENTATION[r.neg_status] ? r.neg_status : NEG_STATE.AWAITING_APPROVAL;
        r._isMyAction = isParent ? pendingKeys.has(parentKeyOf(r)) : pendingKeys.has(Number(r.round_id));
        r.action_required = r._isMyAction;
        r.action_label = r._isMyAction ? 'Approval needed' : null;
        if (isParent) {
          r.vendor_count = parseArr(r.vendors).length;
          r.product_count = parseArr(r.item_names).length;
        }
      }

      // 4. tab counts — over the searched set, so they sum to `all`.
      const tab_counts = { all: rows.length, for_me: 0, needs_attention: 0, closed: 0 };
      for (const k of BUCKETS) tab_counts[k] = 0;
      for (const r of rows) {
        tab_counts[r._bucket] = (tab_counts[r._bucket] || 0) + 1;
        if (GROUPS.needs_attention(r._bucket)) tab_counts.needs_attention++;
        else tab_counts.closed++;
        if (r._isMyAction) tab_counts.for_me++;
      }

      // 5. tab scope.
      const byTab = tab === 'all' ? rows
        : tab === 'for_me' ? rows.filter((r) => r._isMyAction)
        : GROUPS[tab] ? rows.filter((r) => GROUPS[tab](r._bucket))
        : rows.filter((r) => r._bucket === tab);
      const tabRows = needsMyApproval ? byTab.filter((r) => r._isMyAction) : byTab;

      // 6. facets over tab scope.
      const fm = { rfqId: new Map(), parentKey: new Map(), status: new Map(), buId: new Map(), departmentId: new Map(), productId: new Map(), vendorId: new Map() };
      const bump = (m, key, label) => { if (key == null || key === '') return; const e = m.get(key) || { key, label: label || null, count: 0 }; e.count++; if (label && !e.label) e.label = label; m.set(key, e); };
      const STATUS_LABEL = Object.fromEntries(
        Object.entries(NEG_STATE_PRESENTATION).map(([k, v]) => [k, v.label]));
      for (const r of tabRows) {
        if (r.rfq_id != null) bump(fm.rfqId, String(r.rfq_id), `#${r.rfq_no}${r.title ? ` · ${r.title}` : ''}`);
        if (isParent) {
          const pk = parentKeyOf(r);
          if (pk) bump(fm.parentKey, pk, `#${r.rfq_no}${r.title ? ` · ${r.title}` : ''}`);
        }
        bump(fm.status, r._bucket, STATUS_LABEL[r._bucket] || r._bucket);
        if (r.hotel_id != null) bump(fm.buId, String(r.hotel_id), r.hotel_name || `Hotel ${r.hotel_id}`);
        if (r.department_id != null) bump(fm.departmentId, String(r.department_id), r.department_title || `Dept ${r.department_id}`);
        for (const n of parseArr(r.item_names)) if (n) bump(fm.productId, String(n), String(n));
        for (const v of parseArr(r.vendors)) if (v && v.id != null) bump(fm.vendorId, String(v.id), v.name || `Vendor ${v.id}`);
      }
      const toFacet = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count);
      const facets = { rfqId: toFacet(fm.rfqId), status: toFacet(fm.status), buId: toFacet(fm.buId), departmentId: toFacet(fm.departmentId), productId: toFacet(fm.productId), vendorId: toFacet(fm.vendorId) };
      if (isParent) facets.parentKey = toFacet(fm.parentKey);

      // 7. apply facet filters. These NARROW a set that is already scoped —
      // they are never lookup keys. An out-of-scope rfqId / parentKey therefore
      // yields an empty page, not a 403 and not somebody else's data.
      const filtered = tabRows.filter((r) => {
        // r.rfq_id is NULL on ARC rows: guard the null so a literal "null" in
        // the filter cannot select them.
        if (filters.rfqId.length && (r.rfq_id == null || !filters.rfqId.includes(String(r.rfq_id)))) return false;
        const pk = parentKeyOf(r);
        if (filters.parentKey.length && (pk == null || !filters.parentKey.includes(pk))) return false;
        if (filters.status.length && !filters.status.includes(r._bucket)) return false;
        if (filters.buId.length && !filters.buId.includes(String(r.hotel_id))) return false;
        if (filters.departmentId.length && !filters.departmentId.includes(String(r.department_id))) return false;
        if (filters.productId.length && !parseArr(r.item_names).map(String).some((n) => filters.productId.includes(n))) return false;
        if (filters.vendorId.length && !parseArr(r.vendors).some((v) => v && filters.vendorId.includes(String(v.id)))) return false;
        return true;
      });

      // 8. savings, parent grain only.
      // ⚠️ SECURITY: getNegotiationParentSavings reads tbl_quotes /
      // tbl_quote_items / tbl_quote_item_history and applies NO scope of its
      // own. The ids handed to it here are exactly the rfq ids that survived
      // the RBAC-scoped parent query plus every narrowing filter above — never
      // ids taken from the request. Do not move this call above step 1.
      if (isParent) {
        const savingsRows = await negotiationModel.getNegotiationParentSavings(
          filtered.map((r) => r.rfq_id).filter((id) => id != null)
        );
        const byRfq = new Map(savingsRows.map((s) => [Number(s.rfq_id), s]));
        const money = (v) => Math.round(Number(v || 0) * 100) / 100;
        const pct = (saved, base) =>
          Math.abs(Number(base || 0)) > 0.005 ? Math.round((saved / Number(base)) * 1000000) / 10000 : null;
        for (const r of filtered) {
          const s = r.rfq_id != null ? byRfq.get(Number(r.rfq_id)) : null;
          // Signed and UNCLAMPED — prices genuinely go up (14 production RFQs
          // ended above their baseline) and a floor of zero would hide it.
          const saved = s ? money(s.baseline_total) - money(s.achieved_total) : 0;
          const savedAwarded = s ? money(s.baseline_total_awarded) - money(s.achieved_total_awarded) : 0;
          r.baseline_total = s ? money(s.baseline_total) : 0;
          r.achieved_total = s ? money(s.achieved_total) : 0;
          r.saved_value = money(saved);
          r.saved_pct = s ? pct(saved, s.baseline_total) : null;
          r.baseline_total_awarded = s ? money(s.baseline_total_awarded) : 0;
          r.achieved_total_awarded = s ? money(s.achieved_total_awarded) : 0;
          r.saved_value_awarded = money(savedAwarded);
          r.saved_pct_awarded = s ? pct(savedAwarded, s.baseline_total_awarded) : null;
          r.savings_pairs_counted = s ? Number(s.pairs_counted || 0) : 0;
          r.savings_pairs_counted_awarded = s ? Number(s.pairs_counted_awarded || 0) : 0;
          r.baseline_sources = s ? s.baseline_sources : null;
        }
      }

      // 9. sort. The status sort is the ONE place the two grains legitimately
      // differ: a round orders by NEG_STATE_ORDER, a parent by the action-first
      // NEG_PARENT_STATE_ORDER.
      const ORDER = isParent ? NEG_PARENT_STATE_ORDER : NEG_STATE_ORDER;
      const ts = (r) => new Date((isParent ? r.last_activity_at : r.round_created_at) || 0).getTime();
      if (sort === 'oldest') filtered.sort((a, b) => ts(a) - ts(b));
      else if (sort === 'status') filtered.sort((a, b) => (ORDER[a._bucket] ?? 9) - (ORDER[b._bucket] ?? 9));
      else if (sort === 'rounds') filtered.sort((a, b) => Number(b.round_count || 0) - Number(a.round_count || 0));
      else if (sort === 'savings') filtered.sort((a, b) => Number(b.saved_value || 0) - Number(a.saved_value || 0));
      else filtered.sort((a, b) => ts(b) - ts(a));

      // 10. paginate.
      const total = filtered.length;
      const data = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

      return res.status(200).json({ status: 1, data: { rows: data, facets, tab_counts, source_counts, total, page, limit, group_by: groupBy } });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }
};

export default NegotiationController;
