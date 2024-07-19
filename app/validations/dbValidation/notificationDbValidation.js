import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import notificationModel from '../../models/notificationModel.js';
import { encode } from 'html-entities';

const validateDbBody = {
  /*   vendor_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;

      if (email) {
        const vendorEmailExists = await vendorModel.vendorEmailExist(email);
        if (vendorEmailExists.length > 0) {
          err++;
          errors.email = 'Email already exists';
        }
      }
      if (mobile) {
        const vendorMobileExists = await vendorModel.vendorMobileExist(mobile);
        if (vendorMobileExists.length > 0) {
          err++;
          errors.mobile = 'Mobile already exists';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  }, */
  notification_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let notificationId = req.params.id;
      let name = req.body?.name;

      if (notificationId) {
        const notificationIDExists =
          await notificationModel.notificationIDExist(notificationId);
        if (notificationIDExists.length == 0) {
          err++;
          errors.id = 'Notification not found';
        }
        if (req.method == 'PUT') {
          const otherNotificationNameExists =
            await notificationModel.otherNotificationNameExists(
              name,
              notificationId
            );
          if (otherNotificationNameExists.length > 0) {
            err++;
            errors.name = 'Notification name already exists';
          }
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  add_notification: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let name = req.body.name;

      const notificationNameExists =
        await notificationModel.notificationNameExists(name);
      if (notificationNameExists.length > 0) {
        err++;
        errors.id = 'Notification name already exists';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  }
  /*  vendor_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;
      let status = req.body.status;

      if (vendorId) {
        const vendorIDExists = await vendorModel.vendorIDExist(vendorId);
        if (vendorIDExists.length == 0) {
          err++;
          errors.id = 'Vendor not found';
        }
        if (status == 1 && vendorIDExists[0].status == 1) {
          err++;
          errors.status = 'Vendor already accepted';
        } else if (status == 0 && vendorIDExists[0].status == 0) {
          err++;
          errors.status = 'Vendor already rejected';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  vendor_block_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;
      let status = req.body.status;

      if (vendorId) {
        const vendorIDExists = await vendorModel.vendorIDExist(vendorId);
        if (vendorIDExists.length == 0) {
          err++;
          errors.id = 'Vendor not found';
        }
        if (status == 1 && vendorIDExists[0].status == 2) {
          err++;
          errors.status = 'Vendor already blocked';
        } else if (status == 0 && vendorIDExists[0].status == 1) {
          err++;
          errors.status = 'Vendor already unblocked';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  vendor_email_mobile_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;
      let vendorId = req.params.id;

      if (email) {
        const vendorEmailExists = await vendorModel.otherVendorEmailExist(
          email,
          vendorId
        );
        if (vendorEmailExists.length > 0) {
          err++;
          errors.email = 'Email already exists';
        }
      }
      if (mobile) {
        const vendorMobileExists = await vendorModel.otherVendorMobileExist(
          mobile,
          vendorId
        );
        if (vendorMobileExists.length > 0) {
          err++;
          errors.mobile = 'Mobile already exists';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  } */
};

export { validateDbBody };
