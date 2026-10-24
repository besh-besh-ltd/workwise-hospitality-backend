// Delivery-plan and dispatch notices (task B2). Both run AFTER the change has
// committed and never throw: a notice that fails must not turn a saved plan
// or a recorded dispatch into an error.
//
//   notifyPlanChanged      the vendor, when an accepted PO's plan changes
//                          (in-app + email, with the new schedule; no prices).
//   notifyDispatchCreated  the PO's people, when goods are dispatched: the
//                          dispatch email and GRN reminders the legacy "Mark
//                          dispatched" button always sent, through the same
//                          helpers (generalReminderEmails.sendDispatchedEmail,
//                          cronManager.scheduleGRNReminders).
//
// The PO model, the mailers and the cron manager are imported lazily: this
// file is re-exported by notifier.js, which every inventory service may
// import, and the PO model itself calls back into the inventory services.

import config from '../../../config/app.config.js';
import { sendMail, logError } from '../../../helper/common.js';
import { generateEmailTemplate, emailButton } from '../../../helper/notificationEmailLayout.js';
import { dispatch as dispatchNotification } from '../../notificationService.js';
import { vendorPoDeliveries, toAbsoluteUrl } from '../../notificationLinks.js';
import { displayDate } from '../planDocument.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Tell the vendor their delivery schedule for a PO changed.
 * @param {object} conn db (after commit)
 * @param {{poId:number, actorUserId?:number}} args
 */
export const notifyPlanChanged = async (conn, { poId, actorUserId = null } = {}) => {
  try {
    const id = positiveInt(poId);
    if (!id) return;
    const po = await conn.oneOrNone(
      `SELECT po.id, po.po_number, po.rfq_id, po.finalized_vendor_id, v.name AS vendor_name, v.email AS vendor_email
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
        WHERE po.id = $1`,
      [id]
    );
    if (!po?.finalized_vendor_id) return;

    const rows = await conn.any(
      `SELECT d.hotel_id, h.name AS hotel_name, d.phase_no, d.due_date::text AS due_date, d.remarks,
              pv.name AS product_name, pop.unit, dl.planned_qty::text AS planned_qty
         FROM tbl_po_delivery d
         JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id AND dl.planned_qty > 0
         JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
         LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = d.hotel_id
        WHERE d.po_id = $1
        ORDER BY d.hotel_id IS NULL, d.hotel_id, d.phase_no, pop.id`,
      [id]
    );

    const poLabel = po.po_number ? `PO ${po.po_number}` : `PO #${po.id}`;
    const title = `Delivery schedule updated for ${poLabel}`;
    const body = `The buyer has changed the delivery plan for ${poLabel}. Check the hotels, phases and due dates before you dispatch.`;
    const linkPath = vendorPoDeliveries(id);

    await dispatchNotification({
      userIds: [po.finalized_vendor_id],
      senderUserId: positiveInt(actorUserId),
      category: 'po',
      type: 'po_delivery_plan_changed',
      title,
      body,
      data: { po_id: id, rfq_id: po.rfq_id ?? null },
      actionUrl: linkPath,
    });

    if (!po.vendor_email) return;
    const tableRows = rows.map((r) => `
          <tr>
            <td style="padding:6px 8px; border-bottom:1px solid #eee;">${esc(r.hotel_name || (r.hotel_id == null ? 'To be allocated' : ''))}</td>
            <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:center;">${esc(r.phase_no)}</td>
            <td style="padding:6px 8px; border-bottom:1px solid #eee;">${esc(displayDate(r.due_date) || 'To be scheduled')}</td>
            <td style="padding:6px 8px; border-bottom:1px solid #eee;">${esc(r.product_name || 'Item')}</td>
            <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;">${esc(Number(r.planned_qty))} ${esc(r.unit || '')}</td>
          </tr>`).join('');
    const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>${esc(body)}</p>
        ${rows.length ? `
        <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:12px;">
          <thead><tr style="background:#F3F4F6;">
            <th style="padding:6px 8px; text-align:left;">Hotel</th>
            <th style="padding:6px 8px;">Phase</th>
            <th style="padding:6px 8px; text-align:left;">Due</th>
            <th style="padding:6px 8px; text-align:left;">Item</th>
            <th style="padding:6px 8px; text-align:right;">Qty</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>` : ''}
        <div style="text-align:center; margin-top:24px;">
          ${emailButton(toAbsoluteUrl(linkPath), 'View the delivery plan')}
        </div>
        <p style="text-align:center; margin-top: 30px;"><strong>— Phileein Hospitality Team</strong></p>
      </div>`;
    await Promise.resolve(sendMail({
      from: config.webmasterMail,
      to: po.vendor_email,
      subject: title,
      html: generateEmailTemplate(`<h2>Hello ${esc(po.vendor_name || '')},</h2>`, containerContent),
    })).catch((err) => logError('notifyPlanChanged email failed', err));
  } catch (err) {
    logError(`[po ${poId}] notifyPlanChanged failed`, err);
  }
};

/**
 * The legacy dispatch email + GRN reminders, for a dispatch note just
 * recorded. Reminders are scheduled once per PO (its first dispatch note);
 * the email goes out for every note.
 * @param {object} conn db (after commit)
 * @param {{dispatchId:number}} args
 */
export const notifyDispatchCreated = async (conn, { dispatchId } = {}) => {
  try {
    const did = positiveInt(dispatchId);
    if (!did) return;
    const dispatch = await conn.oneOrNone(
      `SELECT pd.id, pd.po_id, pd.hotel_id,
              (SELECT count(*)::int FROM tbl_po_dispatch x WHERE x.po_id = pd.po_id AND x.id <= pd.id) AS seq
         FROM tbl_po_dispatch pd WHERE pd.id = $1`,
      [did]
    );
    if (!dispatch) return;

    // One row per PO. The legacy query joined the PO's lines and their quote
    // items and read it with t.one, so it threw on any PO with more than one
    // line and on every call-off PO (no quote items): D1.
    const formattedPOData = await conn.oneOrNone(
      `SELECT po.*,
              v.name AS finalized_vendor_name,
              v.email AS finalized_vendor_email,
              COALESCE(
                (SELECT MAX(hh.created_at)
                   FROM tbl_approval_hierarchy_transactions ht
                   JOIN tbl_approval_hierarchy_history hh
                     ON hh.approval_transaction_id = ht.id AND hh.action = 'approved'
                  WHERE ht.hierarchy_type = 'po' AND ht.target_entity_id = po.id),
                (SELECT ai.completed_at FROM tbl_approval_instances ai
                  WHERE ai.id = po.approval_instance_id AND ai.status = 'APPROVED')
              ) AS po_approved_on,
              -- The longest whole-day delivery period among the PO's lines (one
              -- dispatch carries them all), as the legacy mailer expects it.
              (SELECT qi.delivery_period
                 FROM tbl_purchase_order_product pop
                 JOIN tbl_quote_items qi ON qi.id = pop.quote_id
                WHERE pop.purchase_order_id = po.id
                  AND substring(qi.delivery_period FROM '^\\s*([0-9]{1,6})') IS NOT NULL
                ORDER BY substring(qi.delivery_period FROM '^\\s*([0-9]{1,6})')::int DESC
                LIMIT 1) AS delivery_period
         FROM tbl_rfq_purchase_order po
         LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
        WHERE po.id = $1`,
      [dispatch.po_id]
    );
    if (!formattedPOData) return;

    const [{ resolvePoNotificationRecipients }, { sendDispatchedEmail }, { scheduleGRNReminders }] = await Promise.all([
      import('../../../models/purchaseOrderModel.js'),
      import('../../../helper/sendEmailFunctions/generalReminderEmails.js'),
      import('../../../helper/cronManager.js'),
    ]);
    const reminderUsers = await resolvePoNotificationRecipients(formattedPOData, conn);
    // The PO's site representative (a live one; the dispatch hotel's first).
    const grnRepData = await conn.oneOrNone(
      `SELECT id, name, email, phone
         FROM tbl_token_login_data
        WHERE token_type = 'GRN' AND entity_id = $1 AND revoked_at IS NULL
        ORDER BY (hotel_id IS NOT DISTINCT FROM $2::int) DESC, id DESC
        LIMIT 1`,
      [dispatch.po_id, dispatch.hotel_id]
    );

    if (dispatch.seq === 1) {
      try {
        await scheduleGRNReminders(formattedPOData, reminderUsers, grnRepData);
      } catch (err) {
        logError(`[po ${dispatch.po_id}] GRN reminders failed`, err);
      }
    }
    await sendDispatchedEmail(formattedPOData, reminderUsers);
  } catch (err) {
    logError(`[dispatch ${dispatchId}] notifyDispatchCreated failed`, err);
  }
};
