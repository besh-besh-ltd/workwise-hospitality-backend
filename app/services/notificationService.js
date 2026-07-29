import webpush from 'web-push';
import db from '../config/dbConn.js';
import notificationModel from '../models/notificationModel.js';
import pushSubscriptionModel from '../models/pushSubscriptionModel.js';
import { emitToUser } from '../util/socket.js';
import { logger } from '../util/logger.js';
import { logError } from '../helper/common.js';

const publicVapidKey =
  process.env.VAPID_PUBLIC_KEY ||
  'BMlcHp3X2DtYmsKkev81HR4CJeOqxTyLEZC0JU3Fnxi7qaKqM7-qOWvgPCb4Q9FmFW6-hyc9AG4w4BtrHTkwO2c';
const privateVapidKey =
  process.env.VAPID_PRIVATE_KEY ||
  'U10j4lgXBPb5esS3hat9I1M92p59vXbMGBsOZLasjgE';
const vapidSubject =
  process.env.VAPID_SUBJECT || 'mailto:tech@letsworkwise.com';

webpush.setVapidDetails(vapidSubject, publicVapidKey, privateVapidKey);

export const getVapidPublicKey = () => publicVapidKey;

/**
 * Resolve a heterogeneous recipient list into unique numeric user IDs.
 * Accepts: number IDs, { id }, { user_id }, { email }, or arrays of these.
 * Falls back to a DB lookup by email only when no ID is supplied — keeps the
 * common case (callers already have IDs) free of extra queries.
 */
export const resolveRecipientUserIds = async (recipients = []) => {
  const arr = Array.isArray(recipients) ? recipients : [recipients];
  const ids = new Set();
  const emailsToLookup = [];

  for (const r of arr) {
    if (r == null) continue;
    if (typeof r === 'number' && !Number.isNaN(r)) { ids.add(r); continue; }
    if (typeof r === 'string') {
      const n = Number(r);
      if (!Number.isNaN(n) && /^\d+$/.test(r)) { ids.add(n); continue; }
      if (r.includes('@')) { emailsToLookup.push(r); continue; }
      continue;
    }
    if (typeof r === 'object') {
      const id = r.id || r.user_id || r.userId;
      if (id != null) { ids.add(Number(id)); continue; }
      if (r.email) emailsToLookup.push(r.email);
    }
  }

  if (emailsToLookup.length > 0) {
    try {
      const rows = await db.any(
        `SELECT id, email FROM tbl_users WHERE email IN ($1:csv)`,
        [emailsToLookup]
      );
      rows.forEach((row) => row && row.id != null && ids.add(Number(row.id)));
    } catch (err) {
      logError('resolveRecipientUserIds lookup failed', err);
    }
  }

  return Array.from(ids);
};

/**
 * Send a notification to one or more users across all wired channels.
 *
 *   1. Persists one tbl_notifications row per recipient (source of truth → bell)
 *   2. Fans out web-push to every saved subscription for those users
 *      (prunes the subscription row on 404/410)
 *   3. Emits a socket event to room `user:<id>` so an open tab updates live
 *
 * Email is NOT sent from here — existing sendMail() flows remain untouched.
 */
export const dispatch = async ({
  userIds = [],
  senderUserId = null,
  category = null,
  type = null,
  title,
  body,
  data = {},
  actionUrl = null
}) => {
  const recipients = (Array.isArray(userIds) ? userIds : [userIds])
    .filter((id) => id != null);

  if (recipients.length === 0 || !title) return [];

  const created = [];

  for (const recipientId of recipients) {
    try {
      const row = await notificationModel.createForRecipient({
        sender_user_id: senderUserId,
        recipient_user_id: recipientId,
        category,
        type,
        title,
        message: body,
        additional_data: data,
        action_url: actionUrl
      });
      created.push(row);

      emitToUser(recipientId, 'notification:new', {
        id: row.id,
        title,
        body,
        category,
        type,
        action_url: actionUrl,
        created_at: row.created_at,
        is_read: 0
      });
    } catch (err) {
      logError('notificationService.dispatch persist failed', err);
    }
  }

  try {
    const subs = await pushSubscriptionModel.listByUserIds(recipients);
    const payload = JSON.stringify({
      title,
      body,
      data: { url: actionUrl || '/', category, type }
    });

    await Promise.all(
      subs.map((sub) =>
        webpush
          .sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth }
            },
            payload
          )
          .catch(async (err) => {
            const status = err && err.statusCode;
            if (status === 404 || status === 410) {
              await pushSubscriptionModel.deleteById(sub.id);
              logger.info(
                { endpoint: sub.endpoint },
                'Pruned expired push subscription'
              );
            } else {
              logError('webpush sendNotification failed', err);
            }
          })
      )
    );
  } catch (err) {
    logError('notificationService.dispatch push fanout failed', err);
  }

  return created;
};

/**
 * Legacy single-recipient helper, kept so existing call sites keep working.
 * New code should call dispatch().
 */
const sendNotification = async (
  senderUserId,
  receiverUserIds = [],
  data,
  payload,
  subscription
) => {
  const { type, title, message, additional_data } = data || {};
  await dispatch({
    userIds: receiverUserIds,
    senderUserId,
    type,
    title,
    body: message,
    data: additional_data || {}
  });

  if (subscription && payload) {
    webpush
      .sendNotification(subscription, JSON.stringify(payload))
      .catch((err) => logError('webpush sendNotification (legacy) failed', err));
  }
};

export { sendNotification };
