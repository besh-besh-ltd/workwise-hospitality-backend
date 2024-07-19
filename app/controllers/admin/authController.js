import adminModel from '../../models/adminModel.js';
import rolesModel from '../../models/rolesModel.js';
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';

const cryptr = new Cryptr(Config.cryptR.secret);

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
  adminProfile: async (req, res, next) => {
    try {
      let userData = {};
      userData.name = req.user.name;
      userData.email = req.user.email;
      userData.profile_image_new = req.user.new_profile_image
        ? req.user.new_profile_image
        : null;

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
