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
      const endpoint = req.body && req.body.endpoint;
      if (!endpoint) {
        return res.status(400).json({ status: 0, message: 'endpoint required' });
      }
      await pushSubscriptionModel.deleteByEndpoint(endpoint);
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

      const data = await notificationModel.getByRecipient(userId, limit, offset);
      return res.status(200).json({ status: 1, data });
    } catch (err) {
      logError('userNotification.list error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  unreadCount: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });
      const count = await notificationModel.getUnreadCount(userId);
      return res.status(200).json({ status: 1, data: { count } });
    } catch (err) {
      logError('userNotification.unreadCount error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  },

  markRead: async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      const id = req.params.id;
      if (!userId) return res.status(401).json({ status: 3, message: 'Unauthorized' });
      await notificationModel.markRead(id, userId);
      return res.status(200).json({ status: 1, message: 'Marked read' });
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
      return res.status(200).json({ status: 1, message: 'All marked read' });
    } catch (err) {
      logError('userNotification.markAllRead error', err);
      return res.status(500).json({ status: 3, message: Config.errorText.value });
    }
  }
};

export default userNotificationController;
