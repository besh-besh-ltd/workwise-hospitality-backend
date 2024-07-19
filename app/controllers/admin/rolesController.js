// import notificationModel from '../../models/notificationModel.js';
import rolesModel from '../../models/rolesModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  generatePassword
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

const cryptr = new Cryptr(Config.cryptR.secret);

const rolesController = {
  createSubadmin: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { name, email, mobile, password } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;

      let admObj = {
        name,
        email,
        mobile,
        register_as: 5,
        status: 1,
        password: generatePassword(password),
        createdBy,
        fileName,
        originalFilename
      };
      // console.log('notificationObj', notificationObj);
      // return false;
      let subadminId = await rolesModel.createSubadminUser(admObj);

      if (subadminId) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Subadmin created successfully'
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
  subadminList: async (req, res, next) => {
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
      /* if (req.query.status) {
        status = req.query.status;
      }
      if (req.query.notification_type) {
        notification_type = req.query.notification_type;
      } */

      let subadminList = await rolesModel.getSubAdminList(limit, offset, name);
      let subadminCount = await rolesModel.getSubAdminCount(name);
      res
        .status(200)
        .json({
          status: 1,
          data: subadminList,
          total_count: subadminCount.count
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
  subadminDrop: async (req, res, next) => {
    try {
      let subadminList = await rolesModel.getSubAdminDrop();
      res
        .status(200)
        .json({
          status: 1,
          data: subadminList
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
  menuList: async (req, res, next) => {
    try {
      let menuList = await rolesModel.getMenuList();
      res
        .status(200)
        .json({
          status: 1,
          data: menuList
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
  subadminDetails: async (req, res, next) => {
    try {
      let subadminId = req.params.id;
      let subadminDetails = await rolesModel.getSubadminDetails(subadminId);
      res
        .status(200)
        .json({
          status: 1,
          data: subadminDetails
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
  rolePermissionDetails: async (req, res, next) => {
    try {
      let subadminId = req.params.id;

      let permissionDetails = await rolesModel.getRolePermissionDetails(
        subadminId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: permissionDetails
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
  updateSubadmin: async (req, res, next) => {
    try {
      let subadminId = req.params.id;
      let updatedBy = req.user.id;
      const { name, mobile } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      // let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let subadminObj = {
        name,

        mobile,
        fileName,
        originalFilename,
        updatedBy
      };
      await rolesModel.updateSubadmin(subadminId, subadminObj);

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
          message: 'Subadmin updated successfully'
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
  addRolePermission: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { user_id, menu_id } = req.body;
      if (menu_id.length > 0) {
        await rolesModel.deletePermissionByUserId(user_id);
      }
      menu_id.map(async (ele) => {
        await rolesModel.addRolePermission(ele, user_id);
      });
      res
        .status(200)
        .json({
          status: 1,
          message: 'Role permission created successfully'
        })
        .end();
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
  updateRolePermission: async (req, res, next) => {
    try {
      let user_id = req.params.id;
      let updatedBy = req.user.id;
      const { menu_id } = req.body;
      // console.log('menu_id--', menu_id);
      // console.log('user_id--', user_id);
      //return false;
      if (menu_id.length > 0) {
        await rolesModel.deletePermissionByUserId(user_id);
      }
      menu_id.map(async (ele) => {
        await rolesModel.addRolePermission(ele, user_id);
      });

      res
        .status(200)
        .json({
          status: 1,
          message: 'Role permission updated successfully'
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
      const { title, notification_type, status, content, send_to } = req.body;

      let notificationObj = {
        title,
        notification_type,
        status,
        content,
        send_to,
        createdBy
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

  updateNotification: async (req, res, next) => {
    try {
      let notificationId = req.params.id;
      let updatedBy = req.user.id;
      const { title, notification_type, status, content, send_to } = req.body;
      // let fileName = req?.file?.filename;
      // let originalFilename = req?.file?.originalname;
      // let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let notificationObj = {
        title,
        notification_type,
        status,
        content,
        send_to
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
  }
};
export default rolesController;
