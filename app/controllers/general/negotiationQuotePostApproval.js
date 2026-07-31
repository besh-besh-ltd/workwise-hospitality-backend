import {
  getApprovalInstanceById,
  recordLifecycleEvent,
  resetQuoteFinalizationForSendback,
} from '../../models/generalModel.js';
import { logError } from '../../helper/common.js';
import { draftPO, buildAuthoritativePOPayload } from '../po/purchaseOrderController.js';
import { autoInitiateRFQPOs } from '../../models/purchaseOrderModel.js';
import rfqModel from '../../models/rfqModel.js';
import db from '../../config/dbConn.js';

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
      await db.tx(async (t) => {
        const authPayload = await buildAuthoritativePOPayload(metadata.po_payload, t);
        txResult = await draftPO(authPayload, metadata.po_user, t);

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
    } else if (metadata.rfq_id && metadata.selected_quotes?.length > 0 && metadata.is_tender !== 1) {
      // Path B: Negotiation flow — construct PO from selected quotes
      const rfqProductId = metadata.rfq_product_id || instance.entity_id;
      const rfq = await rfqModel.checkIfExists('tbl_rfq', `id = ${metadata.rfq_id}`);
      const rfqData = rfq[0];

      if (rfqData) {
        let lastDraftResult = null;
        await db.tx(async (t) => {
          // Get the finalization submitter (who initiated the NEGOTIATION_QUOTE approval)
          const poCreator = await t.oneOrNone('SELECT id, company_id FROM tbl_users WHERE id = $1', [instance.initiated_by]);
          let poUser;
          if (poCreator) {
            poUser = { id: poCreator.id, company_id: poCreator.company_id };
          } else {
            // Fallback: use the approver's user record (matches the previous inline
            // implementation where this fallback used req.user, which was always
            // the approver acting on the request).
            const approver = await t.oneOrNone('SELECT id, company_id FROM tbl_users WHERE id = $1', [approver_user_id]);
            poUser = approver
              ? { id: approver.id, company_id: approver.company_id }
              : { id: approver_user_id, company_id: null };
          }

          const product = await rfqModel.getRfqProductById(rfqProductId, metadata.rfq_id, t);
          if (product) {
            for (const selectedQuote of metadata.selected_quotes) {
              try {
                const vendorQuoteItem = await t.oneOrNone(
                  `SELECT qi.quantity, qi.unit, qi.unit_price, qi.id as quote_item_id,
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

                  lastDraftResult = await draftPO({
                    rfq_id: metadata.rfq_id,
                    project_id: rfqData.project_id,
                    total_value: totalValue,
                    quote_item_id: vendorQuoteItem.quote_item_id,
                    product_info: {
                      rfq_product_id: rfqProductId,
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
                  }, poUser, t);
                }
              } catch (poError) {
                logError(`Error creating PO for vendor ${selectedQuote.vendor_id}`, poError);
              }
            }
          }

          await recordLifecycleEvent({
            entity_type: 'RFQ',
            entity_id: metadata.rfq_id,
            stage: 'NEGOTIATION_QUOTES_APPROVED',
            action: 'APPROVE',
            performed_by: approver_user_id,
            metadata: {
              approval_instance_id: parseInt(approval_instance_id),
              rfq_product_id: rfqProductId,
              quote_ids: metadata.selected_quotes.map(q => q.quote_id),
              vendor_ids: metadata.selected_quotes.map(q => q.vendor_id)
            },
            remarks: comment,
            txContext: t
          });
        });
        // Post-commit auto-initiate for the legacy negotiation flow.
        if (lastDraftResult?.should_auto_initiate && lastDraftResult?.rfq_id) {
          try {
            await autoInitiateRFQPOs(lastDraftResult.rfq_id, approver_user_id);
          } catch (e) {
            logError('[negotiationQuotePostApproval] auto-initiate batch failed', e);
          }
        }
      }
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
