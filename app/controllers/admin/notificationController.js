import notificationModel from '../../models/notificationModel.js';
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

const cryptr = new Cryptr(Config.cryptR.secret);

const notificationController = {
  notificationList: async (req, res, next) => {
    try {
      let page, limit, offset, name, status, notification_type;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      if (req.query.name) {
        name = req.query.name;
      }
      if (req.query.status) {
        status = req.query.status;
      }
      if (req.query.notification_type) {
        notification_type = req.query.notification_type;
      }

      let notificationList = await notificationModel.getAdminNotificationList(
        limit,
        offset,
        name,
        status,
        notification_type
      );
      let notificationCount = await notificationModel.getAdminNotificationCount(
        name,
        status,
        notification_type
      );
      res
        .status(200)
        .json({
          status: 1,
          data: notificationList,
          total_count: notificationCount.count
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
  },
  addNotification: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { name, title, notification_type, status, content, send_to } =
        req.body;

      let notificationObj = {
        title,
        notification_type,
        status,
        content,
        send_to,
        createdBy,
        name
      };
      // console.log('notificationObj', notificationObj);
      // return false;
      let notificationId = await notificationModel.addNotificationSetting(
        notificationObj
      );

      if (notificationId) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Notification created successfully'
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  notificationDetails: async (req, res, next) => {
    try {
      let notificationId = req.params.id;
      let notificationDetails = await notificationModel.getNotificationDetails(
        notificationId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: notificationDetails
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
  },
  updateNotification: async (req, res, next) => {
    try {
      let notificationId = req.params.id;
      let updatedBy = req.user.id;
      const { name, title, notification_type, status, content, send_to } =
        req.body;
      // let fileName = req?.file?.filename;
      // let originalFilename = req?.file?.originalname;
      // let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let notificationObj = {
        title,
        notification_type,
        status,
        content,
        send_to,
        name
      };
      await notificationModel.updateNotification(
        notificationId,
        notificationObj
      );

      /*       if (fileName) {
        if (buyerDetails[0].new_profile_image) {
          const file_link = `${Config.upload.user_image}/${buyerDetails[0].new_profile_image}`;
          fs.unlink(file_link, (err) => {
            if (err) console.log(err);
            else {
              //   console.log(file_link);
            }
          });
        }
      } */
      res
        .status(200)
        .json({
          status: 1,
          message: 'Notification updated successfully'
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
  },
  deleteNotification: async (req, res, next) => {
    try {
      let notificationId = req.params.id;
      let updatedBy = req.user.id;
      await notificationModel.deleteNotification(notificationId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Notification deleted successfully'
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
export default notificationController;
