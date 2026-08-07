import notificationModel from '../../models/notificationModel.js';
import pushSubscriptionModel from '../../models/pushSubscriptionModel.js';
import { getVapidPublicKey } from '../../services/notificationService.js';
import { logError } from '../../helper/common.js';
import Config from '../../config/app.config.js';

const PAGE_LIMIT = 20;

const userNotificationController = {
  vapidPublicKey: (req, res) => {
    res.status(200).json({ status: 1, data: { publicKey: getVapidPublicKey() } });
  },

  pushSubscribe: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const sub = req.body && (req.body.subscription || req.body);
      const endpoint = sub && sub.endpoint;
      const p256dh = sub && sub.keys && sub.keys.p256dh;
      const auth = sub && sub.keys && sub.keys.auth;

      if (!endpoint || !p256dh || !auth) {
        return res
          .status(400)
          .json({ status: 0, message: 'Invalid push subscription payload' });
      }

      await pushSubscriptionModel.upsert({
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: req.headers['user-agent']
      });

      return res.status(200).json({ status: 1, message: 'Subscribed' });
    } catch (err) {
      logError('pushSubscribe error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  pushUnsubscribe: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const endpoint = req.body && req.body.endpoint;
      if (!endpoint) {
        return res.status(400).json({ status: 0, message: 'endpoint required' });
      }
      // Scope the delete to the caller. Deleting by endpoint alone let any
      // authenticated user silence another user's push notifications just by
      // knowing (or guessing) their subscription endpoint.
      await pushSubscriptionModel.deleteByEndpointForUser(endpoint, userId);
      return res.status(200).json({ status: 1, message: 'Unsubscribed' });
    } catch (err) {
      logError('pushUnsubscribe error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  list: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(parseInt(req.query.limit, 10) || PAGE_LIMIT, 100);
      const offset = (page - 1) * limit;

      // Filtering runs in SQL rather than on the loaded page. Filtering a
      // 20-row buffer client-side means "Unread" shows however many of the most
      // recent 20 happen to be unread, which is not what it says.
      const category = typeof req.query.category === 'string' && req.query.category !== 'all'
        ? req.query.category
        : null;
      const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';

      const data = await notificationModel.getByRecipient(userId, limit, offset, {
        category,
        unreadOnly
      });
      // `has_more` lets the client build real paging without a second COUNT
      // over the whole table: ask for one page, learn whether another exists.
      return res.status(200).json({
        status: 1,
        data,
        meta: { page, limit, has_more: data.length === limit }
      });
    } catch (err) {
      logError('userNotification.list error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  // `count` stays in the payload as the undelivered figure because that is what
  // the badge has always rendered; `unread` is additive for the list styling.
  unreadCount: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });
      const { undelivered, unread, total } = await notificationModel.getCounts(userId);
      return res
        .status(200)
        .json({ status: 1, data: { count: undelivered, undelivered, unread, total } });
    } catch (err) {
      logError('userNotification.unreadCount error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  // Drives the inbox filter. Returned from the server so the filter reflects
  // the whole inbox rather than whatever happens to be on the loaded page.
  categories: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });
      const data = await notificationModel.getCategoryCounts(userId);
      return res.status(200).json({ status: 1, data });
    } catch (err) {
      logError('userNotification.categories error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  // Clear a single item you have dealt with. Soft delete — see the migration.
  dismiss: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const result = await notificationModel.dismiss(req.params.id, userId);
      if (!result.rowCount) {
        return res.status(404).json({ status: 2, message: 'Notification not found' });
      }

      const { undelivered, unread, total } = await notificationModel.getCounts(userId);
      return res
        .status(200)
        .json({ status: 1, message: 'Dismissed', data: { undelivered, unread, total } });
    } catch (err) {
      logError('userNotification.dismiss error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  // Undo for a misclick, so opening something by accident is recoverable.
  markUnread: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const result = await notificationModel.markUnread(req.params.id, userId);
      if (!result.rowCount) {
        return res.status(404).json({ status: 2, message: 'Notification not found' });
      }

      const { undelivered, unread, total } = await notificationModel.getCounts(userId);
      return res
        .status(200)
        .json({ status: 1, message: 'Marked unread', data: { undelivered, unread, total } });
    } catch (err) {
      logError('userNotification.markUnread error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  // Called when the bell is opened. Delivery is "you have had the chance to see
  // this", so it clears the badge without touching the read state that drives
  // the unread highlight.
  markDelivered: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
      const delivered = await notificationModel.markDelivered(userId, ids);
      const { undelivered, unread } = await notificationModel.getCounts(userId);

      return res
        .status(200)
        .json({ status: 1, message: 'Marked delivered', data: { delivered, undelivered, unread } });
    } catch (err) {
      logError('userNotification.markDelivered error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  markRead: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      const id = req.params.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });

      const result = await notificationModel.markRead(id, userId);
      // A miss means the id does not exist or belongs to someone else. Reporting
      // 200 either way made a cross-tenant write indistinguishable from success,
      // so the client could never tell its optimistic update had been rejected.
      if (!result.rowCount) {
        return res.status(404).json({ status: 2, message: 'Notification not found' });
      }

      const { undelivered, unread } = await notificationModel.getCounts(userId);
      return res
        .status(200)
        .json({ status: 1, message: 'Marked read', data: { undelivered, unread } });
    } catch (err) {
      logError('userNotification.markRead error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  markAllRead: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });
      await notificationModel.markAllRead(userId);
      const { undelivered, unread } = await notificationModel.getCounts(userId);
      return res
        .status(200)
        .json({ status: 1, message: 'All marked read', data: { undelivered, unread } });
    } catch (err) {
      logError('userNotification.markAllRead error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  }
};

export default userNotificationController;
