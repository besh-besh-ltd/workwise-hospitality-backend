/**
 * Post-commit notices for REQ-0032 recovery actions. Everything here is
 * best-effort: it runs after the transaction has committed, so it must never
 * throw into the request. Each step is wrapped and logged on its own.
 */
import db from '../../config/dbConn.js';
import config from '../../config/app.config.js';
import { sendMail, logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import userModel from '../../models/userModel.js';
import rbacModel from '../../models/rbacModel.js';
import { dispatch as dispatchNotification } from '../notificationService.js';
import { buyerPoDetail, buyerPoList, buyerMrDetail, buyerMrList, toAbsoluteUrl } from '../notificationLinks.js';
import { notifyVendorCallOffAwaitingAcceptance } from '../callOffPoService.js';
import { sendPONotificationToVendor, sendPOAcceptedNotificationToTeam, sendPOAcceptanceRequestToVendor } from '../../controllers/po/purchaseOrderEmails.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function safe(label, fn) {
  try {
    await fn();
  } catch (err) {
    logError(`poRejectionRecoveryNotifier: ${label} failed`, err);
  }
}

/**
 * The vendor withdrew a rejection and accepted the PO.
 *   - the same two mails a normal accept sends (vendor confirmation, internal team)
 *   - RFQ PO: in-app + email to the commercial evaluators
 *   - call-off PO: in-app + email to the requisition raiser
 *
 * @param {{po: object, vendorUserId: number, callOff: null|{raised_by:number|null, mr_id:number|null, mr_number:string|null}}} args
 * @returns {Promise<void>} never rejects
 */
export async function notifyRejectionWithdrawn({ po, vendorUserId, callOff = null }) {
  try {
    await safe('normal accept notices', async () => {
      const rfqDetails = await db.oneOrNone(
        `SELECT r.id, r.rfq_no, r.title, r.created_by, r.hospitality_company_id, r.hotel_id
           FROM tbl_rfq r WHERE r.id = $1`,
        [po.rfq_id]
      );
      const rfqCreator = await userModel.getUserById(rfqDetails?.created_by);
      if (rfqCreator && rfqCreator[0]) {
        sendPONotificationToVendor(po, rfqCreator[0]).catch((err) => {
          logError('Failed to send PO confirmed notification to vendor', err);
        });
      }
      sendPOAcceptedNotificationToTeam(po, rfqDetails).catch((err) => {
        logError('Failed to send PO accepted notification to team', err);
      });
    });

    let vendorName = 'The vendor';
    await safe('vendor lookup', async () => {
      const vendor = (await userModel.getUserById(vendorUserId))?.[0];
      vendorName = vendor?.organization_name || vendor?.name || vendorName;
    });

    if (po.is_call_off) {
      await safe('call-off raiser notice', () => notifyCallOffRaiser({ po, callOff }));
    } else {
      await safe('evaluator notice', () => notifyEvaluators({ po, vendorName }));
    }
  } catch (err) {
    logError('notifyRejectionWithdrawn failed', err);
  }
}

// The RFQ and the commercial evaluators (quote-compare read + create at its
// hotel) to tell about a PO event, optionally leaving one user out (the actor).
async function loadEvaluators(po, { excludeId = null } = {}) {
  const rfq = await db.oneOrNone(`SELECT id, rfq_no, title, hotel_id FROM tbl_rfq WHERE id = $1`, [po.rfq_id]);
  const found = (await rbacModel.getUsersWithModuleActionsForHotels(
    [rfq?.hotel_id], 'quote-compare', ['read', 'create'], null
  )) || [];
  const evaluators = excludeId == null ? found : found.filter((u) => Number(u.id) !== Number(excludeId));
  return { rfq, evaluators };
}

async function notifyEvaluators({ po, vendorName }) {
  const { rfq, evaluators } = await loadEvaluators(po);
  if (!evaluators || evaluators.length === 0) {
    logger.info('No commercial evaluators to notify for withdrawn PO rejection');
    return;
  }
  const poNumber = po.po_number;
  const linkPath = buyerPoDetail(po.id) || buyerPoList();
  const url = toAbsoluteUrl(linkPath);
  const subject = `PO #${poNumber} accepted — ${vendorName} withdrew their rejection`;

  for (const user of evaluators) {
    const html = generateEmailTemplate(
      `<h2>Hello ${esc(user.name)},</h2>`,
      `<div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
         <p>${esc(vendorName)} withdrew their rejection of PO #${esc(poNumber)} and accepted it.</p>
         <p>Nothing more is needed from you. The order is back on track${rfq?.rfq_no ? ` for RFQ #${esc(rfq.rfq_no)}` : ''}.</p>
         <div style="text-align:center; margin-top:24px;">
           <a href="${esc(url)}" style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">View purchase order</a>
         </div>
       </div>`
    );
    Promise.resolve(sendMail({ from: config.webmasterMail, to: user.email, subject, html }))
      .catch((err) => logError('withdrawn-rejection email failed', err));
  }

  await dispatchNotification({
    userIds: evaluators.map((u) => u.id).filter(Boolean),
    category: 'po',
    type: 'po_vendor_rejection_withdrawn',
    title: 'Vendor withdrew their rejection',
    body: `${vendorName} withdrew their rejection of PO #${poNumber} and accepted it.`,
    data: { po_id: po.id, rfq_id: po.rfq_id },
    actionUrl: linkPath,
  });
}

async function notifyCallOffRaiser({ po, callOff }) {
  const raisedBy = Number(callOff?.raised_by);
  if (!raisedBy) return;
  const poNumber = po.po_number;
  const mrId = Number(callOff.mr_id) || null;
  await dispatchNotification({
    userIds: [raisedBy],
    category: 'mr',
    type: 'CALL_OFF_REJECTION_WITHDRAWN',
    title: 'Vendor withdrew their rejection',
    body: `The vendor withdrew their rejection of call-off PO ${poNumber} and accepted it. The contract quantity is reserved again.`,
    data: { po_id: po.id, mr_id: mrId, mr_number: callOff.mr_number, po_number: poNumber },
    actionUrl: buyerMrDetail(mrId) || buyerMrList({ tab: 'for_me' }),
  });
  const raiser = await db.oneOrNone(`SELECT email, name FROM tbl_users WHERE id = $1`, [raisedBy]);
  if (raiser?.email) {
    Promise.resolve(sendMail({
      to: raiser.email,
      subject: `Call-off PO ${poNumber} accepted — the vendor withdrew their rejection`,
      html: `<p>Hello ${esc(raiser.name)},</p>
             <p>The vendor withdrew their rejection of call-off purchase order <strong>${esc(poNumber)}</strong> (requisition <strong>${esc(callOff.mr_number)}</strong>) and accepted it.</p>
             <p>The contract quantity is reserved again.</p>`,
    })).catch((err) => logError('call-off withdrawn email failed', err));
  }
}

/**
 * The buyer sent a vendor-rejected PO back for acceptance.
 *   - vendor: the standard acceptance request a freshly approved PO gets (RFQ
 *     PO), or the call-off release's notice (call-off PO). The note is NEVER
 *     part of anything addressed to the vendor.
 *   - RFQ PO: in-app + email to the commercial evaluators, minus the actor
 *   - call-off PO: in-app to the requisition raiser, unless they are the actor
 * The note appears only in the internal notices.
 *
 * @param {{po: object, actor: {id:number, name?:string}, note: string,
 *   callOff: null|{raised_by:number|null, mr_id:number|null, mr_number:string|null}}} args
 * @returns {Promise<void>} never rejects
 */
export async function notifyPoSentBackToVendor({ po, actor, note, callOff = null }) {
  try {
    let actorName = actor?.name || 'A buyer';
    await safe('actor lookup', async () => {
      const u = (await userModel.getUserById(actor?.id))?.[0];
      actorName = u?.name || actorName;
    });
    let vendorName = 'the vendor';
    await safe('vendor lookup', async () => {
      const v = (await userModel.getUserById(po.finalized_vendor_id))?.[0];
      vendorName = v?.organization_name || v?.name || vendorName;
    });

    if (po.is_call_off) {
      await safe('vendor call-off acceptance request', () => notifyVendorCallOff({ po, callOff }));
      await safe('call-off raiser notice', () => notifyRaiserSentBack({ po, actor, actorName, vendorName, note, callOff }));
    } else {
      await safe('vendor acceptance request', async () => {
        const rfqDetails = await db.oneOrNone(
          `SELECT id, rfq_no, title, created_by FROM tbl_rfq WHERE id = $1`, [po.rfq_id]
        );
        await sendPOAcceptanceRequestToVendor(po, rfqDetails);
      });
      await safe('evaluator notice', () => notifyEvaluatorsSentBack({ po, actor, actorName, vendorName, note }));
    }
  } catch (err) {
    logError('notifyPoSentBackToVendor failed', err);
  }
}

const sentBackBody = ({ actorName, po, vendorName, note }) =>
  `${actorName} sent PO #${po.po_number} back to ${vendorName} for acceptance: “${note}”`;

// The call-off release's own vendor notice, shared with mrController.
async function notifyVendorCallOff({ po, callOff }) {
  const { mail } = await notifyVendorCallOffAwaitingAcceptance({
    po,
    mr: { id: callOff?.mr_id ?? null, mr_number: callOff?.mr_number ?? '', raised_by: callOff?.raised_by ?? null },
    vendorId: po.finalized_vendor_id,
  });
  await mail;
}

async function notifyEvaluatorsSentBack({ po, actor, actorName, vendorName, note }) {
  const { rfq, evaluators } = await loadEvaluators(po, { excludeId: actor?.id });
  if (evaluators.length === 0) {
    logger.info('No other commercial evaluators to notify for a PO sent back to the vendor');
    return;
  }
  const linkPath = buyerPoDetail(po.id) || buyerPoList();
  const url = toAbsoluteUrl(linkPath);
  const subject = `PO #${po.po_number} sent back to ${vendorName} for acceptance`;

  const mails = [];
  for (const user of evaluators) {
    if (!user.email) continue;
    const html = generateEmailTemplate(
      `<h2>Hello ${esc(user.name)},</h2>`,
      `<div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
         <p>${esc(actorName)} sent PO #${esc(po.po_number)} back to ${esc(vendorName)} for acceptance${rfq?.rfq_no ? ` (RFQ #${esc(rfq.rfq_no)})` : ''}.</p>
         <p><strong>Note:</strong> ${esc(note).replace(/\n/g, '<br/>')}</p>
         <p>The order keeps its number, prices and approvals. This note is internal and was not sent to the vendor.</p>
         <div style="text-align:center; margin-top:24px;">
           <a href="${esc(url)}" style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">View purchase order</a>
         </div>
       </div>`
    );
    mails.push(Promise.resolve(sendMail({ from: config.webmasterMail, to: user.email, subject, html }))
      .catch((err) => logError('sent-back email failed', err)));
  }

  await dispatchNotification({
    userIds: evaluators.map((u) => u.id).filter(Boolean),
    senderUserId: actor?.id ?? null,
    category: 'po',
    type: 'po_sent_back_to_vendor',
    title: 'PO sent back to the vendor',
    body: sentBackBody({ actorName, po, vendorName, note }),
    data: { po_id: po.id, rfq_id: po.rfq_id },
    actionUrl: linkPath,
  });
  await Promise.all(mails);
}

async function notifyRaiserSentBack({ po, actor, actorName, vendorName, note, callOff }) {
  const raisedBy = Number(callOff?.raised_by);
  if (!raisedBy || raisedBy === Number(actor?.id)) return;
  const mrId = Number(callOff.mr_id) || null;
  await dispatchNotification({
    userIds: [raisedBy],
    senderUserId: actor?.id ?? null,
    category: 'mr',
    type: 'po_sent_back_to_vendor',
    title: 'PO sent back to the vendor',
    body: sentBackBody({ actorName, po, vendorName, note }),
    data: { po_id: po.id, mr_id: mrId, mr_number: callOff.mr_number, po_number: po.po_number },
    actionUrl: buyerMrDetail(mrId) || buyerMrList({ tab: 'for_me' }),
  });
}

export default { notifyRejectionWithdrawn, notifyPoSentBackToVendor };
