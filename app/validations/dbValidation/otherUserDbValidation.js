import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
// import buyerModel from '../../models/buyerModel.js';
import otherUserModel from '../../models/otherUserModel.js';

const validateDbBody = {
  other_user_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let otherUserId = req.params.id;
      if (otherUserId) {
        let otherUserIdExists = await otherUserModel.otherUserIdExist(
          otherUserId
        );
        if (otherUserIdExists.length == 0) {
          err++;
          errors.id = 'Other User not found';
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
  other_user_block_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let otherUserId = req.params.id;
      let status = req.body.status;
      if (otherUserId) {
        const othetUserIDExists = await otherUserModel.otherUserIdExist(
          otherUserId
        );
        if (othetUserIDExists.length == 0) {
          err++;
          errors.id = 'Other User not found';
        }
        if (status == 1 && othetUserIDExists[0].status == 2) {
          err++;
          errors.status = 'Other User already blocked';
        } else if (status == 0 && othetUserIDExists[0].status == 1) {
          err++;
          errors.status = 'Other User already unblocked';
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
  other_user_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;

      if (email) {
        const vendorEmailExists = await otherUserModel.userEmailExist(email);
        if (vendorEmailExists.length > 0) {
          err++;
          errors.email = 'Email already exists';
        }
      }
      if (mobile) {
        const vendorMobileExists = await otherUserModel.userMobileExist(mobile);
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
  other_user_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let otherUserId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;

      if (otherUserId) {
        const otherUserIDExists = await otherUserModel.otherUserIdExist(
          otherUserId
        );
        if (otherUserIDExists.length == 0) {
          err++;
          errors.id = 'Other user ID not found';
        }
        if (status == 1 && otherUserIDExists[0].status == 1) {
          err++;
          errors.status = 'Other user already approved';
        } else if (status == 0 && otherUserIDExists[0].status == 0) {
          err++;
          errors.status = 'Other user already disapproved';
        }
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
  }
};

export { validateDbBody };
