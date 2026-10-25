import {
  getApprovalInstanceById,
  recordLifecycleEvent,
  resetQuoteFinalizationForSendback,
} from '../../models/generalModel.js';
import { logError } from '../../helper/common.js';
import { notifyDraftCreated } from '../../services/po/poInitiateNotifier.js';
import { draftPO, buildAuthoritativePOPayload } from '../po/purchaseOrderController.js';
import { autoInitiateRFQPOs } from '../../models/purchaseOrderModel.js';
import rfqModel from '../../models/rfqModel.js';
import db from '../../config/dbConn.js';
import { PoDecisionError } from '../../services/po/poDecisionError.js';
import { bindParkedAward, instanceOwnsRfq } from '../../services/po/awardQuoteBinding.js';

/**
 * Why an approved award drafted no PO, worded for the RFQ/Tender timeline,
 * chosen by the refusal's code: a PO on hold or a merge target that went stale
 * is not an award that "does not match", and the remark is what tells the
 * buyer what to do next.
 */
export const noPoRemark = (code) => {
  const head = 'Quote approval completed but no purchase order was drafted: ';
  const rerun = ' Re-run commercial finalization for this product.';
  switch (code) {
    case 'MISSING_PO_PAYLOAD':
      return `${head}the approval instance carries no po_payload.${rerun}`;
    case 'AWARD_QUOTE_NOT_FOUND':
    case 'AWARD_QUOTE_MISMATCH':
      return `${head}the approved award does not match a quote of this RFQ product by its vendor.${rerun}`;
    case 'PO_ON_HOLD':
      return `${head}the purchase order already raised for this product is on hold, waiting for information. ` +
        'Answer or withdraw that request, then re-run commercial finalization for this product.';
    case 'PO_MERGE_TARGET_INVALID':
      return `${head}the purchase order chosen to merge the award into is no longer a draft of this RFQ for the vendor.${rerun}`;
    default:
      return `${head}the purchase order could not be drafted (${code || 'unknown reason'}).${rerun}`;
  }
};

/**
 * An APPROVED quote approval that did not become a PO, on the RFQ/Tender
 * timeline: the NEGOTIATION_QUOTES_APPROVED_NO_PO lifecycle row, its remark
 * chosen by `reason` (noPoRemark). Written only to the timeline of an RFQ the
 * instance's own company owns: an instance whose metadata names another
 * company's RFQ (a forged one) is logged, never written onto that RFQ. Best
 * effort: the approval has already committed, so a failure here is logged,
 * never thrown.
 *
 * @param {object} args
 * @param {object} args.instance        the tbl_approval_instances row
 * @param {number} args.approverUserId
 * @param {object} args.metadata        the instance's parsed metadata
 * @param {string} args.reason          MISSING_PO_PAYLOAD or a PoDecisionError code
 */
export const recordApprovedWithoutPo = async ({ instance, approverUserId, metadata, reason }) => {
  const rfqId = metadata.rfq_id || null;
  const rfqProductId = metadata.rfq_product_id || instance?.entity_id;
  if (!rfqId) return;
  try {
    if (!(await instanceOwnsRfq(db, instance, rfqId))) {
      logError(
        `[negotiationQuotePostApproval] NO_PO not recorded: approval_instance_id=${instance?.id} ` +
        `(company ${instance?.hospitality_company_id}) names rfq_id=${rfqId}, which is not its company's.`
      );
      return;
    }
    // is_tender normally rides on the metadata (Path A reads it the same
    // way). Fall back to the RFQ row when it is absent so the event lands on
    // the right timeline either way.
    let isTender = metadata.is_tender;
    if (isTender === undefined || isTender === null) {
      const rfqRow = await db.oneOrNone('SELECT is_tender FROM tbl_rfq WHERE id = $1', [rfqId]);
      isTender = rfqRow?.is_tender ?? 0;
    }

    await recordLifecycleEvent({
      entity_type: Number(isTender) === 1 ? 'TENDER' : 'RFQ',
      entity_id: rfqId,
      stage: 'NEGOTIATION_QUOTES_APPROVED_NO_PO',
      action: 'APPROVE',
      performed_by: approverUserId,
      metadata: {
        approval_instance_id: parseInt(instance?.id),
        rfq_product_id: rfqProductId,
        reason,
      },
      remarks: noPoRemark(reason),
    });
  } catch (lifecycleError) {
    logError(
      '[negotiationQuotePostApproval] failed to record NEGOTIATION_QUOTES_APPROVED_NO_PO lifecycle event',
      lifecycleError
    );
  }
};

/**
 * Handle NEGOTIATION_QUOTE post-approval — create the PO once a commercial
 * quote approval is fully approved.
 *
 * Extracted verbatim from generalController.js so the centralized
 * approvalActionService dispatcher can register it uniformly with the other
 * post-action handlers. Behaviour is intentionally identical to the previous
 * inline implementation; the only changes are:
 *   - The function signature matches the dispatcher contract
 *     (approval_instance_id, approver_user_id, ctx).
 *   - The fallback `req.user` user (for `poUser` when the initiator user
 *     row cannot be found) is now derived from the approver_user_id passed
 *     in by the dispatcher. In practice this is the same person — `req.user`
 *     in the previous inline implementation was always the approver acting
 *     on the request — so the behaviour is unchanged.
 *
 * Called by approvalActionService.executeApprovalAction whenever a
 * NEGOTIATION_QUOTE approval instance is fully approved through any surface.
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [ctx]
 * @param {Object} [ctx.instance] - pre-loaded approval instance, optional
 * @param {string} [ctx.comment]
 */
export const handleNegotiationQuotePostApproval = async (approval_instance_id, approver_user_id, ctx = {}) => {
  try {
    const instance = ctx.instance || await getApprovalInstanceById(approval_instance_id);
    if (!instance || instance.entity_type !== 'NEGOTIATION_QUOTE' || instance.status !== 'APPROVED') {
      return;
    }

    const comment = ctx.comment;
    const metadata = typeof instance.metadata === 'string'
      ? JSON.parse(instance.metadata)
      : (instance.metadata || {});

    if (metadata.po_payload && metadata.po_user) {
      // Path A: PO payload stored by rfqController.finalize
      let txResult = null;
      try {
        // The instance's own award: its company owns the RFQ and the payload
        // binds to it. The approval surfaces check this before recording the
        // approval; an instance completed without them (auto-completion) is
        // checked here, and a refusal lands in the catch below.
        await bindParkedAward(db, instance);
        await db.tx(async (t) => {
          // The approval is already recorded and must still get its PO: a merge
          // target parked at finalize that has since left draft is set aside
          // under the PO lock (staleTargetFallback), not refused.
          const authPayload = await buildAuthoritativePOPayload(metadata.po_payload, t);
          txResult = await draftPO(authPayload, metadata.po_user, t, { staleTargetFallback: true });

          const entityType = metadata.is_tender === 1 ? 'TENDER' : 'RFQ';
          await recordLifecycleEvent({
            entity_type: entityType,
            entity_id: metadata.rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'APPROVE',
            performed_by: approver_user_id,
            metadata: {
              approval_instance_id: parseInt(approval_instance_id),
              rfq_product_id: metadata.rfq_product_id,
              vendor_id: metadata.vendor_id,
              quote_id: metadata.quote_id
            },
            remarks: comment,
            txContext: t
          });
        });
      } catch (refusal) {
        // The payload was refused (it does not bind to its RFQ: a quote line
        // that is not, or is no longer, this RFQ product's by the vendor). The
        // approval surfaces bind it before recording the approval, but an
        // instance completed without one (approvalPropagationService
        // auto-completing it after a policy or membership change) gets here
        // already APPROVED. Nothing was drafted; say so on the timeline, as the
        // no-payload branch below does, instead of only in the logs.
        if (!(refusal instanceof PoDecisionError)) throw refusal;
        logError(
          `[negotiationQuotePostApproval] NEGOTIATION_QUOTE approval_instance_id=${approval_instance_id} ` +
          `is APPROVED but its po_payload was refused (${refusal.code}): NO purchase order was drafted.`,
          refusal
        );
        await recordApprovedWithoutPo({
          instance,
          approverUserId: approver_user_id,
          metadata,
          reason: refusal.code || 'PO_PAYLOAD_REFUSED',
        });
        return;
      }
      // Post-commit: tell the initiators, only if this call CREATED the draft.
      if (txResult?.created && txResult?.po_id) void notifyDraftCreated(txResult.po_id);
      // Post-commit auto-initiate. The approver's action just landed the
      // final piece of the award puzzle; if the RFQ is now fully
      // awarded, batch-initiate all its draft POs.
      if (txResult?.should_auto_initiate && txResult?.rfq_id) {
        try {
          await autoInitiateRFQPOs(txResult.rfq_id, approver_user_id);
        } catch (e) {
          logError('[negotiationQuotePostApproval] auto-initiate batch failed', e);
        }
      }
    } else {
      // ---------------------------------------------------------------
      // No po_payload → NO PO. Say so loudly.
      //
      // There used to be a second drafting route here ("Path B") that
      // reconstructed a PO from `metadata.selected_quotes` whenever the
      // instance had an rfq_id, at least one selected quote, and
      // is_tender !== 1. It has been deleted, for three independent
      // reasons — each sufficient on its own:
      //
      //  1. ITS ARITHMETIC WAS WRONG BY ~700x. It took
      //     `selectedQuote.quoted_price` as a UNIT price
      //     (`unit_price: negotiationPrice`, `quantity * negotiationPrice`).
      //     But tbl_negotiation_round_quotes.quoted_price is a landed LINE
      //     TOTAL — negotiationModel.js:157 documents this, and
      //     rfqModel.js:1600 writes it as `qi.total_price AS quoted_price`.
      //     Production (2026-08-01): of 520 non-ARC round-quote rows, 466
      //     equal the quote item's total_price exactly and exactly 1 equals
      //     its unit_price (a quantity-1 line). Mean quantity ~698. So the
      //     branch would have drafted a PO ~700x the award value and stored
      //     a line total in the unit-price column.
      //
      //  2. IT COULD NOT EVEN RUN. Its first statement selected `qi.unit`
      //     from tbl_quote_items — a column that does not exist in
      //     production or in tests/setup/schema.sql. The query raises
      //     42703, the inner catch swallows it, and the trailing
      //     recordLifecycleEvent in the same tx then dies with 25P02
      //     ("current transaction is aborted"). Net effect: no PO, no
      //     lifecycle row, one swallowed stack trace.
      //
      //  3. IT PRODUCED A DIFFERENT PO FROM PATH A ANYWAY — no
      //     server-authoritative pricing recompute, no document-level
      //     global charges, no selected_hierarchy, and no existing_po_id,
      //     so every line would spawn its own PO instead of merging.
      //
      // Path A is the only supported route: rfqController.finalize freezes
      // an authoritative po_payload onto the approval instance, and this
      // handler drafts from it. An instance without one is a data defect
      // upstream, not something to improvise a PO from.
      //
      // The failure mode we are explicitly buying our way out of is
      // SILENCE. Production instance 56 (RFQ 208) matched the old branch's
      // shape but carried is_tender: 1, so the branch's own guard skipped
      // it — no PO, no log, no lifecycle entry. RFQ 208 has had zero POs
      // since 2026-03-11 and nothing anywhere says why. From here on, an
      // approved award that cannot become a PO leaves a record on the
      // RFQ/Tender timeline AND an error in the logs.
      // ---------------------------------------------------------------
      const rfqId = metadata.rfq_id || null;
      const rfqProductId = metadata.rfq_product_id || instance.entity_id;

      logError(
        `[negotiationQuotePostApproval] NEGOTIATION_QUOTE approval_instance_id=${approval_instance_id} ` +
        `is APPROVED but carries no po_payload/po_user — NO purchase order was drafted. ` +
        `rfq_id=${rfqId} rfq_product_id=${rfqProductId}. ` +
        `A PO can only be drafted from the authoritative payload frozen by rfqController.finalize; ` +
        `re-run the commercial finalization for this product to produce one.`
      );

      await recordApprovedWithoutPo({
        instance,
        approverUserId: approver_user_id,
        metadata,
        reason: 'MISSING_PO_PAYLOAD',
      });
    }
  } catch (negQuoteError) {
    logError('Error in NEGOTIATION_QUOTE post-approval (PO creation)', negQuoteError);
  }
};

/**
 * Handle NEGOTIATION_QUOTE post-REJECTION — undo the vendor award that the
 * rejected approval was gating.
 *
 * WHY THIS EXISTS: NEGOTIATION_QUOTE used to be the only entity type in
 * approvalActionService's postActionRegistry with an APPROVED handler and no
 * REJECTED one. Rejecting a vendor finalization through the generic endpoint
 * (POST /general/hospitality/approval/action — what the entity-agnostic
 * RfqApprovalDecisionCard on the RFQ details page calls) therefore flipped the
 * approval instance to REJECTED and stopped there, leaving the product
 * finalized to a vendor whose award had just been refused, and leaving no
 * lifecycle trace of the rejection.
 *
 * This is the SINGLE implementation of that rollback. The dedicated endpoint
 * negotiationController.rejectQuotes used to carry a copy inline; it now routes
 * through executeApprovalAction, so both surfaces reach this function via the
 * registry and it runs exactly once per rejection.
 *
 * Side effects (deliberately in this order — it mirrors what rejectQuotes did):
 *   1. resetQuoteFinalizationForSendback() — archives the tbl_quote_finalization
 *      row into tbl_quote_finalization_history and deletes it, so the vendor
 *      stops seeing the award. Target stage 'NEGOTIATION' keeps the negotiation
 *      rounds intact so the buyer can open a fresh round.
 *   2. A NEGOTIATION_QUOTES_REJECTED lifecycle event on the parent RFQ/Tender.
 *
 * Errors are logged, never rethrown: the approval transition has already
 * committed by the time the dispatcher calls this.
 *
 * @param {number} approval_instance_id
 * @param {number} approver_user_id
 * @param {Object} [ctx]
 * @param {Object} [ctx.instance] - pre-loaded approval instance, optional
 * @param {string} [ctx.comment]  - the rejection remarks
 */
export const handleNegotiationQuoteRejection = async (approval_instance_id, approver_user_id, ctx = {}) => {
  try {
    const instance = ctx.instance || await getApprovalInstanceById(approval_instance_id, 'NEGOTIATION_QUOTE');
    // Idempotency + safety guard: only act on an instance that is genuinely a
    // REJECTED NEGOTIATION_QUOTE. Mirrors handleNegotiationQuotePostApproval's
    // APPROVED guard and handleNegotiationRejection's REJECTED guard.
    if (!instance || instance.entity_type !== 'NEGOTIATION_QUOTE' || instance.status !== 'REJECTED') {
      return;
    }

    const comment = ctx.comment || null;
    const metadata = typeof instance.metadata === 'string'
      ? JSON.parse(instance.metadata)
      : (instance.metadata || {});

    const rfq_id = metadata.rfq_id;
    const rfq_product_id = metadata.rfq_product_id || instance.entity_id;
    if (!rfq_id || !rfq_product_id) return;

    // 1. Reset the vendor finalization so vendors don't keep seeing the award.
    try {
      await resetQuoteFinalizationForSendback(
        rfq_id,
        rfq_product_id,
        approver_user_id,
        comment ? `Quote approval rejected: ${comment}` : 'Quote approval rejected',
        'NEGOTIATION'
      );
    } catch (resetError) {
      logError('Error resetting quote finalization on quote rejection', resetError);
    }

    // 2. Record the rejection on the parent RFQ/Tender timeline.
    const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${parseInt(rfq_id, 10)}`);
    const rfqData = rfq?.[0];

    await recordLifecycleEvent({
      entity_type: rfqData?.is_tender === 1 ? 'TENDER' : 'RFQ',
      entity_id: rfq_id,
      stage: 'NEGOTIATION_QUOTES_REJECTED',
      action: 'REJECT',
      performed_by: approver_user_id,
      metadata: {
        approval_instance_id: parseInt(approval_instance_id, 10),
        rfq_product_id,
        quote_ids: metadata.selected_quotes?.map(q => q.quote_id) || [],
        rejection_reason: comment
      },
      remarks: comment
    });
  } catch (negQuoteRejError) {
    logError('Error in NEGOTIATION_QUOTE post-rejection (finalization reset)', negQuoteRejError);
  }
};
