import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
// import notificationModel from '../../models/notificationModel.js';
// import notificationModel from '../../models/notificationModel.js';
import rolesModel from '../../models/rolesModel.js';
import { encode } from 'html-entities';

const validateDbBody = {
  subadmin_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;

      if (email) {
        const subadminEmailExists = await rolesModel.subadminEmailExist(email);
        if (subadminEmailExists.length > 0) {
          err++;
          errors.email = 'Email already exists';
        }
      }
      if (mobile) {
        const subadminMobileExists = await rolesModel.subadminMobileExist(
          mobile
        );
        if (subadminMobileExists.length > 0) {
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
  },
  subadmin_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let subadminId = req.params.id;

      if (subadminId) {
        const subadminIDExists = await rolesModel.subadminIDExist(subadminId);
        if (subadminIDExists.length == 0) {
          err++;
          errors.id = 'Sub Admin not found';
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
