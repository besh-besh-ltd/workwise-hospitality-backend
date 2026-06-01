import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import userModel from '../../models/userModel.js';
import { encode } from 'html-entities';
import rfqModel from '../../models/rfqModel.js';
import vendorModel from '../../models/vendorModel.js';

const validateDbBody = {
  user_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;

      if (email) {
        const userEmailExists = await userModel.user_email_exist(email?.toLowerCase());
        if (userEmailExists.length > 0) {
          err++;
          errors.user_name = 'User email already exists';
        }
      }
      if (mobile) {
        const userMobileExists = await userModel.user_mobile_exist(mobile);
        if (userMobileExists.length > 0) {
          err++;
          errors.mobile = 'User mobile already exists';
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
  user_email_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email } = req.body;

      if (email) {
        // const userEmailExists = await userModel.user_email_exist(email);
        const userEmailExists = await userModel.getUserAuthEmail(email?.toLowerCase());
        if (userEmailExists.length < 1) {
          err++;
          errors.user_name = 'User email not exists';
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
          message: 'Please enter a valid email id or employee code'
        })
        .end();
    }
  },
  forgot_otp_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { otp } = req.body;

      if (otp) {
        const userEmailExists = await userModel.user_detail_otp_exists(otp);
        if (userEmailExists.length < 1) {
          err++;
          errors.otp = 'Invalid OTP or already verified';
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
  review_validate: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      let user_type = req.user.user_type;
      let errors = {};
      let err = 0;
      let { reviewed_to } = req.body;

      if (user_id == reviewed_to) {
        err++;
        errors.user_id = 'Self rating is not possibe';
      }

      if (user_type == '1' || user_type == '3' || user_type == '4') {
        err++;
        errors.user_id = 'Only buyer can rate a vendor';
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

  user_id_exists: async (req, res, next) => {
    logger.debug("req received");
    try {
      let errors = {};
      let err = 0;

      var user_id = req.params.user_id;
      if (user_id) {
        const userIdExists = await userModel.user_id_exists(user_id);

        if (userIdExists.length < 1) {
          err++;
          errors.user = 'User not exists';
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
  user_id_profileexists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      //var user_id = req.params.user_id;
      var user_id = req.user.id;
      const { fcm_id } = req.body;

      if (user_id) {
        const userIdExists = await userModel.user_id_exists(user_id);

        if (userIdExists.length < 1) {
          err++;
          errors.user = 'User not exists';
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
  project_access_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { project_id } = req.body;
      const user_id = req.user.id;

      if (project_id && project_id != -1) {
        const rfqProjectExists = await rfqModel.project_access_checker(project_id, user_id);
        if (rfqProjectExists.length < 1) {
          err++;
          errors.unauthorized_project = 'Project does not exist';
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

  spoc_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let userId = req.user.id;
      let spocId = req.params.spoc_id;

      if (userId && spocId) {
        const userIDExists = await vendorModel.SpocExist(userId,spocId);
        if (userIDExists.length == 0) {
          err++;
          errors.invalid_spoc = 'User spoc not found';
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

  rfq_access_check: async (req, res, next) => {
    try {
      const rfq_id =
        req.body.rfq_id ||
        req.body.rfqId ||
        req.query.rfq_id ||
        req.query.rfqId ||
        req.params.rfq_id ||
        req.params.rfqId ||
        req.params.id ||
        req.body.id ||
        req.query.id;
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      const source = req.body.source || req.query.source || req.params.source || "";

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'RFQ ID is required'
        });
      }
      const hasAccess = await userModel.user_rfq_access_review(rfq_id, user_id, user_type);
      if (hasAccess || source.toLowerCase() == 'po') {
        next();
      } else {
        res.status(403).json({
          status: 2,
          message: 'Access forbidden: You are not authorized for this RFQ'
        });
      }
    } catch (err) {
      logError(err);
      res.status(500).json({
        status: 3,
        message: 'An internal server error occurred'
      });
    }
  },

  rfq_access_check_req_body: async (req, res, next) => {
    try {
      const rfq_id =
        req.body.rfq_id ||
        req.body.rfqId ||
        req.query.rfq_id ||
        req.query.rfqId ||
        req.params.rfq_id ||
        req.params.rfqId ||
        req.params.id ||
        req.body.id;

      // Token validation is now handled by vendorTokenOrJwt middleware
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'RFQ ID is required'
        });
      }
      const hasAccess = await userModel.user_rfq_access_review(rfq_id, user_id, user_type);
      if (hasAccess) {
        next();
      } else {
        res.status(403).json({
          status: 2,
          message: 'Access forbidden: You are not authorized for this RFQ'
        });
      }
    } catch (err) {
      logError(err);
      res.status(500).json({
        status: 3,
        message: 'An internal server error occurred'
      });
    }

  },
negotiateModule: async (req, res, next) => {
  try {
    const { productId, vendorIds } = req.body;

    // ✅ Validate input
    if (!productId || !Array.isArray(vendorIds) || vendorIds.length === 0) {
      return res.status(400).json({
        status: 0,
        message: "Missing productId or vendorIds"
      });
    }

    // ✅ Check if product exists
    const productCheck = await rfqModel.checkIfExists(
      "tbl_rfq_products",
      `id = ${productId}`
    );
    if (productCheck.length === 0) {
      return res.status(404).json({
        status: 0,
        message: "Provide a valid Product ID"
      });
    }

    // ✅ Check if all vendors exist
    const vendorWhereClause = `id IN (${vendorIds.join(",")})`;
    const vendorsCheck = await rfqModel.checkIfExists(
      "tbl_users",
      vendorWhereClause
    );

    if (vendorsCheck.length !== vendorIds.length) {
      return res.status(404).json({
        status: 0,
        message: "Some vendor IDs do not exist"
      });
    }

    logger.debug("All vendors exist");

    // Store validated data in req for the next controller
    req.validatedData = { productId, vendorIds };

    // ✅ Pass control to the next middleware/controller
    return next();

  } catch (error) {
    logError("Error in negotiateModule", error);
    return res.status(500).json({
      status: 0,
      message: "Internal server error"
    });
  }
}


  
};

export { validateDbBody };
