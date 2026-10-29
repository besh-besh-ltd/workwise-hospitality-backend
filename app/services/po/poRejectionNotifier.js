// "PO X was rejected" — tells the people who can act on a rejected PO what
// happened, why, and where to go next.
//
// WHO (deduplicated, never the approver who rejected, active buyers only):
//   - the RFQ creator
//   - the PO creator (tbl_rfq_purchase_order.initiated_by)
//   - whoever initiated the PO's latest approval instance (ruling R20)
//   - the commercial evaluators: whoever raised the latest award approval
//     (NEGOTIATION_QUOTE instance) for each product on the PO, and whoever
//     finalized the award the rejection just archived
//     (tbl_quote_finalization_history.created_by).
// Vendors are never told: a rejection is an internal decision.
//
// This replaces notifyPoSentBack, which told only the PO creator to "amend and
// resubmit" — something a rejected PO cannot do. A rejection de-finalizes the
// vendor, so the work is a re-award in commercial evaluation, or, for a PO that
// is not needed any more, closing the RFQ.
//
// WHEN: after the rejecting transaction commits. Never throws: a notification
// problem must not turn a committed rejection into an error.

import db from "../../config/dbConn.js";
import config from "../../config/app.config.js";
import { sendMail, logError } from "../../helper/common.js";
import { logger } from "../../util/logger.js";
import { generateEmailTemplate, emailButton } from "../../helper/notificationEmailLayout.js";
import { clampText } from "../../helper/poReference.js";
import { quoteInSentence } from "../../helper/quoteInSentence.js";
import { dispatch as dispatchNotification } from "../notificationService.js";
import {
  buyerNegotiationCreateRound,
  buyerPoDetail,
  buyerQuoteComparison,
  buyerRfqDetail,
  toAbsoluteUrl,
} from "../notificationLinks.js";
import { reasonLabel } from "./poSendBackReasons.js";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Everyone who should hear about this rejection, minus the actor. */
async function loadRecipients(poId, actorId) {
  return db.any(
    `WITH po AS (
       SELECT id, rfq_id, initiated_by, finalized_vendor_id
         FROM tbl_rfq_purchase_order WHERE id = $1
     ),
     lines AS (
       SELECT pop.rfq_product_id, rp.product_variant_id, rp.variant
         FROM tbl_purchase_order_product pop
         JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
        WHERE pop.purchase_order_id = $1
     ),
     candidates AS (
       SELECT r.created_by AS user_id FROM tbl_rfq r JOIN po ON po.rfq_id = r.id
       UNION
       SELECT initiated_by FROM po
       UNION
       -- Whoever pressed Initiate on the PO's latest approval (often the
       -- commercial approver who raised it). Same choice as
       -- poInitiateGuide.getPoApprovalInitiators: latest instance, any status.
       (SELECT ai.initiated_by
          FROM tbl_approval_instances ai
         WHERE ai.entity_type = 'PO' AND ai.entity_id = $1
         ORDER BY ai.id DESC
         LIMIT 1)
       UNION
       SELECT nq.initiated_by
         FROM lines l
         JOIN LATERAL (
           SELECT ai.initiated_by
             FROM tbl_approval_instances ai
            WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
              AND ai.entity_id = l.rfq_product_id
            ORDER BY ai.created_at DESC, ai.id DESC
            LIMIT 1
         ) nq ON TRUE
       UNION
       SELECT h.created_by
         FROM lines l
         CROSS JOIN po
         JOIN LATERAL (
           SELECT qfh.created_by
             FROM tbl_quote_finalization_history qfh
            WHERE qfh.rfq_id = po.rfq_id
              AND qfh.product_variant_id = l.product_variant_id
              AND qfh.variant IS NOT DISTINCT FROM l.variant
              AND qfh.vendor_id = po.finalized_vendor_id
            ORDER BY qfh.id DESC
            LIMIT 1
         ) h ON TRUE
     )
     SELECT u.id AS user_id, u.name, u.email
       FROM tbl_users u
      WHERE u.id IN (SELECT user_id FROM candidates WHERE user_id IS NOT NULL)
        AND u.id <> $2
        AND u.status = 1
        AND u.is_deleted = 0
        AND COALESCE(u.user_type, 0) <> 3
      ORDER BY u.id`,
    [poId, actorId || 0]
  );
}

/** Title, body and link for one rejection. Exported for the copy tests. */
export function buildRejectionCopy({ po, actorName, route, reasonCategory, comment }) {
  const poLabel = `PO ${po.po_number || `#${po.id}`}`;
  const who = actorName || "an approver";
  const label = reasonLabel(reasonCategory);
  const quoted = quoteInSentence(comment);
  const cancelled = route === "CANCEL";

  const title = clampText(cancelled ? `${poLabel} cancelled by ${who}` : `${poLabel} rejected by ${who}`);
  const rfqPart = po.rfq_no ? `RFQ ${po.rfq_no}` : "the RFQ";
  const body = cancelled
    ? `${poLabel} was rejected by ${who}: ${label}.${quoted} It was cancelled as not needed. Please close ${rfqPart} if nothing else is required.`
    : `${poLabel} was rejected by ${who}: ${label}.${quoted} It is back in commercial evaluation for re-award.`;

  let linkPath = null;
  if (po.rfq_id) {
    if (cancelled) linkPath = buyerRfqDetail(po.rfq_id);
    else if (reasonCategory === "RENEGOTIATE") linkPath = buyerNegotiationCreateRound(po.rfq_id);
    else linkPath = buyerQuoteComparison(po.rfq_id);
  }
  if (!linkPath) linkPath = buyerPoDetail(po.id);

  const button = cancelled
    ? "Open the RFQ"
    : reasonCategory === "RENEGOTIATE"
    ? "Start a negotiation round"
    : "Go to Quote Comparison";

  return { title, body, linkPath, button };
}

// Notifications still running, so tests can wait for them deterministically.
const inFlight = new Set();

/**
 * Tell the RFQ creator, PO creator, approval initiator and commercial
 * evaluators that a PO was rejected. Call after the rejecting transaction commits.
 * @param {{poId:number, actorId:number, route:'COMMERCIAL'|'CANCEL', reasonCategory:string, comment?:string}} args
 * @returns {Promise<void>}
 */
export function notifyPoRejected(args) {
  const p = notifyPoRejectedNow(args);
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

/**
 * Resolves once every rejection notification started so far has settled. For
 * tests only: production code never calls it.
 */
export async function drainPoRejectedNotifications() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

async function notifyPoRejectedNow({ poId, actorId, route, reasonCategory, comment }) {
  try {
    const po = await db.oneOrNone(
      `SELECT po.id, po.po_number, po.status::text AS status, po.rfq_id, r.rfq_no
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.id = $1`,
      [poId]
    );
    // The transaction may have rolled back after all.
    if (!po || !["rejected", "cancelled"].includes(po.status)) return;

    const [actor, recipients] = await Promise.all([
      actorId ? db.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [actorId]) : null,
      loadRecipients(po.id, actorId),
    ]);
    if (!recipients.length) {
      logger.info({ po_id: po.id }, "[poRejectionNotifier] no one to notify");
      return;
    }

    const { title, body, linkPath, button } = buildRejectionCopy({
      po,
      actorName: actor?.name,
      route,
      reasonCategory,
      comment,
    });

    await dispatchNotification({
      userIds: recipients.map((r) => r.user_id),
      senderUserId: actorId || null,
      category: "po",
      type: route === "CANCEL" ? "po_cancelled" : "po_rejected",
      title,
      body,
      data: {
        po_id: po.id,
        rfq_id: po.rfq_id,
        rfq_no: po.rfq_no || null,
        route,
        reason_category: reasonCategory,
        comment: comment || null,
      },
      actionUrl: linkPath,
    });

    const url = toAbsoluteUrl(linkPath);
    const mails = [];
    for (const r of recipients) {
      if (!r.email) continue;
      try {
        const headerContent = `<h2>Hello ${esc(r.name || "")},</h2>`;
        const containerContent = `
          <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <div style="background-color:#FEE2E2; border-left:4px solid #EF4444; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0; font-weight:600; color:#991B1B;">${esc(title)}</p>
            </div>
            <p>${esc(body)}</p>
            <div style="text-align:center; margin-top:24px;">
              ${emailButton(url, button)}
            </div>
            <p style="text-align:center; margin-top: 30px;">
              <strong>— Phileein Hospitality Team</strong>
            </p>
          </div>`;
        const sent = sendMail({
          from: config.webmasterMail,
          to: r.email,
          subject: title,
          html: generateEmailTemplate(headerContent, containerContent),
        });
        mails.push(Promise.resolve(sent).catch((e) => logError("poRejectionNotifier email failed", e)));
      } catch (e) {
        logError("poRejectionNotifier email build failed", e);
      }
    }
    await Promise.all(mails);
    logger.info({ po_id: po.id, recipients: recipients.length, route }, "[poRejectionNotifier] rejection notified");
  } catch (e) {
    logError("notifyPoRejected failed", e);
  }
}
