import adminModel from '../../models/adminModel.js';
import rolesModel from '../../models/rolesModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  sendMail,
  generatePassword
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import { logger } from '../../util/logger.js';

const cryptr = new Cryptr(Config.cryptR.secret);

// A reset link is a bearer credential for the highest-privilege account in the
// system, so the window is short and the number mailable per window is capped.
const RESET_TOKEN_TTL_MINUTES = 30;
const RESET_MAX_ISSUES_PER_WINDOW = 5;

/**
 * The emailed token is random and never stored; only its digest is. A dump of
 * tbl_users therefore yields no usable reset links. SHA-256 rather than bcrypt
 * is correct here: the input is 256 bits of entropy, so there is no dictionary
 * to slow down, and verification has to be one indexed lookup.
 */
const hashResetToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const renderTemplate = (fileName, variables) => {
  let html = fs.readFileSync(`${Config.template_path}/${fileName}`).toString();
  for (const [key, value] of Object.entries(variables)) {
    html = html.replaceAll(`[${key}]`, value);
  }
  return html;
};

const authController = {
  login: async (req, res, next) => {
    try {
      if (req.user && req.user.id > 0) {
        const userData = {
          user_id: cryptr.encrypt(req.user.id),
          name: req.user.name,
          user_agent: cryptr.encrypt(req.get('User-Agent'))
        };
        const token = jwtHelper.signAccessToken(userData);
        let userAccess = 'all';
        if (req.user.user_type != 1) {
          userAccess = await rolesModel.findUserAccess(req.user.id);
        }
        res
          .status(200)
          .json({
            status: 1,
            token,
            user_access: userAccess,
            message: 'Login success'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Invalid username or password'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  /**
   * Requires the current password even though the caller already holds a valid
   * token. A JWT sitting in localStorage on an unlocked machine is a weaker
   * claim than knowledge of the password, and this is the endpoint that would
   * let someone turn that access into permanent access.
   */
  changePassword: async (req, res, next) => {
    try {
      const { current_password, password } = req.body;
      const admin = await adminModel.getAdminAuthById(req.user.id);

      if (!admin) {
        return res
          .status(400)
          .json({ status: 2, message: 'Admin account not found' })
          .end();
      }

      const currentMatches = await bcrypt.compare(
        current_password,
        admin.password
      );
      if (!currentMatches) {
        return res
          .status(400)
          .json({ status: 0, message: 'Current password is incorrect' })
          .end();
      }

      const sameAsCurrent = await bcrypt.compare(password, admin.password);
      if (sameAsCurrent) {
        return res
          .status(400)
          .json({
            status: 0,
            message: 'New password must be different from the current password'
          })
          .end();
      }

      await adminModel.updateAdminPassword(
        admin.id,
        generatePassword(password)
      );

      // Notification only. The change has already committed, so a failed send
      // must not turn into a failed request.
      sendMail({
        to: admin.email,
        from: Config.webmasterMail,
        subject: 'Work wise | Your admin password was changed',
        html: renderTemplate('dynamic_message_template.txt', {
          name: admin.name || 'Admin',
          message:
            'Your WorkWise admin password was just changed. If this was not you, contact support immediately.'
        })
      }).catch((err) =>
        logger.error({ err }, 'admin change-password notification failed')
      );

      return res
        .status(200)
        .json({ status: 1, message: 'Password changed successfully' })
        .end();
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({ status: 3, message: Config.errorText.value })
        .end();
    }
  },

  /**
   * Answers identically whether or not the address belongs to an admin. This
   * route is unauthenticated, and confirming which addresses are admin accounts
   * would hand an attacker a target list.
   */
  forgotPassword: async (req, res, next) => {
    const genericResponse = () =>
      res
        .status(200)
        .json({
          status: 1,
          message:
            'If that email belongs to an admin account, a reset link is on its way.'
        })
        .end();

    try {
      const email = String(req.body.email || '').toLowerCase();
      const admin = await adminModel.getAdminByEmail(email);

      if (!admin) {
        logger.info(
          { email },
          'admin forgot-password requested for unknown address'
        );
        return genericResponse();
      }

      const alreadyIssued = await adminModel.liveResetIssueCount(admin.id);
      if (alreadyIssued >= RESET_MAX_ISSUES_PER_WINDOW) {
        logger.warn(
          { adminId: admin.id, alreadyIssued },
          'admin forgot-password throttled'
        );
        return genericResponse();
      }

      const token = crypto.randomBytes(32).toString('hex');
      await adminModel.setAdminResetToken(
        admin.id,
        hashResetToken(token),
        RESET_TOKEN_TTL_MINUTES
      );

      // Hospitality has its own admin host; admin.letsworkwise.com is a
      // different vertical, and pointing a reset link there would send the
      // token to a panel that cannot consume it.
      const adminBaseUrl = (
        process.env.ADMIN_BASE_URL || 'https://admin.hospitality.letsworkwise.com'
      ).replace(/\/+$/, '');
      const resetLink = `${adminBaseUrl}/reset-password?token=${token}`;

      await sendMail({
        to: admin.email,
        from: Config.webmasterMail,
        subject: 'Work wise | Reset your admin password',
        html: renderTemplate('admin_password_reset_template.txt', {
          name: admin.name || 'Admin',
          link: resetLink,
          ttl: RESET_TOKEN_TTL_MINUTES
        })
      });

      return genericResponse();
    } catch (error) {
      logError(error);
      // Still generic: a 500 here would itself become an enumeration oracle.
      return genericResponse();
    }
  },

  /**
   * Consumes the emailed token. Invalid, expired and already-used links all
   * produce one message, so the response cannot be used to probe which.
   */
  resetPassword: async (req, res, next) => {
    const invalidLink = () =>
      res
        .status(400)
        .json({
          status: 0,
          message: 'This reset link is invalid or has expired'
        })
        .end();

    try {
      const { token, password } = req.body;
      const tokenHash = hashResetToken(token);

      const admin = await adminModel.findAdminByResetTokenHash(tokenHash);
      if (!admin) {
        return invalidLink();
      }

      const rowsChanged = await adminModel.consumeAdminResetToken(
        admin.id,
        tokenHash,
        generatePassword(password)
      );

      // Lost the race against a concurrent use of the same link.
      if (rowsChanged === 0) {
        return invalidLink();
      }

      sendMail({
        to: admin.email,
        from: Config.webmasterMail,
        subject: 'Work wise | Your admin password was reset',
        html: renderTemplate('dynamic_message_template.txt', {
          name: admin.name || 'Admin',
          message:
            'Your WorkWise admin password was just reset. If this was not you, contact support immediately.'
        })
      }).catch((err) =>
        logger.error({ err }, 'admin reset-password notification failed')
      );

      return res
        .status(200)
        .json({ status: 1, message: 'Password reset successfully' })
        .end();
    } catch (error) {
      logError(error);
      return res
        .status(400)
        .json({ status: 3, message: Config.errorText.value })
        .end();
    }
  },

  adminProfile: async (req, res, next) => {
    try {
      let userData = {};
      userData.name = req.user.name;
      userData.email = req.user.email;
      userData.profile_image_new = req.user.new_profile_image
        ? req.user.new_profile_image
        : null;
      userData.user_type = req.user.user_type;

      res
        .status(200)
        .json({
          status: 1,
          data: userData
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  }
};
export default authController;
