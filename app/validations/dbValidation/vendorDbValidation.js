import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
// import productModel from '../../models/productModel.js';
import vendorModel from '../../models/vendorModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';
import { encode } from 'html-entities';

const validateDbBody = {
  vendor_exists: async (req, res, next) => {
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
  },
  vendor_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;

      if (vendorId) {
        const vendorIDExists = await vendorModel.vendorIDExist(vendorId);
        if (vendorIDExists.length == 0) {
          err++;
          errors.id = 'Vendor not found';
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
  vendor_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;

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

      if (status == 0 && !reject_reason_id && !reject_reason) {
        err++;
        errors.reject_reason_id = 'Reject reason is required';
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
  vendor_approve_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;
      let { name } = req.body;

      const vendorIDExists = await vendorModel.vendorNameExist(name);
      if (vendorIDExists.length > 0) {
        err++;
        errors.vendor_approve = 'Vendor approve already exists';
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
  vendor_approve_update_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorId = req.params.id;
      let { name } = req.body;
      console.log('Name==>', name);
      const vendorIDExists = await vendorModel.vendorNameExist(name);
      console.log('vendorIDExists update==>', vendorIDExists);
      // console.log('vendorIDExists update Idd  ==>', vendorIDExists[0].id);
      // return false;
      if (vendorIDExists.length > 0 && vendorIDExists[0]?.id != vendorId) {
        err++;
        errors.vendor_approve = 'Vendor approve already exists';
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
  },
  vendor_approve_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let vendorApproveID = req.params.id;

      if (vendorApproveID) {
        const checkVendorApproveID =
          await vendorapproveModel.vendorApproveIDExist(vendorApproveID);
        if (checkVendorApproveID.length == 0) {
          err++;
          errors.id = 'Approve Vendor not found';
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
};

export { validateDbBody };
