import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import userModel from '../../models/userModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import couponModel from '../../models/couponModel.js';
import { encode } from 'html-entities';
import dateFormat from 'dateformat';
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
  agent_user_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { user_id } = req.body;

      if (user_id) {
        let userEmailExists = await userModel.agent_user_id_exist(user_id);
        userEmailExists = Object.assign({}, ...userEmailExists);
        if (userEmailExists.length < 1) {
          err++;
          errors.user_id = 'User id not exist';
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
  agent_user_email_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;

      if (email) {
        let userEmailExists = await userModel.agent_user_email_exist(email?.toLowerCase());
        userEmailExists = Object.assign({}, ...userEmailExists);
        // console.log('userEmailExists--', userEmailExists);
        // return false;
        if (
          userEmailExists.length > 0 &&
          userEmailExists.profile_status == 'C'
        ) {
          err++;
          errors.email = 'User email already exists';
        }
      }

      if (mobile) {
        let userMobileExists = await userModel.agent_user_mobile_exist(mobile);
        userMobileExists = Object.assign({}, ...userMobileExists);
        if (
          userMobileExists.length > 0 &&
          userMobileExists.profile_status == 'C'
        ) {
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
          message: Config.errorText.value
        })
        .end();
    }
  },
  otp_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { otp } = req.body;

      if (otp) {
        // const userEmailExists = await userModel.user_email_exist(email);
        const userEmailExists = await userModel.user_detail_exists(otp);
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
  verify_link: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email } = req.body;

      if (email) {
        // const userEmailExists = await userModel.user_email_exist(email);
        const userEmailExists = await userModel.user_email_temp_exist(email?.toLowerCase());
        if (userEmailExists.length > 0) {
          err++;
          errors.user_name = 'User email already exists';
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
  mobile_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { mobile } = req.body;

      if (mobile) {
        const userMobileExists = await userModel.user_mobile_exists(mobile);
        if (userMobileExists.length < 1) {
          err++;
          errors.mobile = 'Mobile not registered';
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
  buyer_subscription_and_coupon_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { sub_id, coupon_code } = req.body;
      let subscriptionIdExist =
        await subscriptionModel.buyerSubscriptionIdExist(sub_id);
      if (subscriptionIdExist.length == 0) {
        err++;
        errors.id = 'Please a send a valid subscription plan';
      }

      let today = dateFormat(new Date(), 'yyyy-mm-dd');
      let couponCodeExists = await couponModel.checkCouponCodeExists(
        coupon_code,
        today
      );
      if (couponCodeExists.length == 0) {
        err++;
        errors.coupon_code = 'Invalid coupon code';
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
  buyer_subscription_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { sub_id, coupon_code } = req.body;
      let subscriptionIdExist =
        await subscriptionModel.buyerSubscriptionIdExist(sub_id);
      if (subscriptionIdExist.length == 0) {
        err++;
        errors.id = 'This is not a valid Subscription';
      } else {
        let buyerSubscriptionIdCheck =
          await subscriptionModel.buyerSubscriptionIdCheck(req.user.id);
        if (buyerSubscriptionIdCheck.length > 0) {
          err++;
          errors.id = 'An active subscription plan is already in place';
        }

        if (coupon_code) {
          let today = dateFormat(new Date(), 'yyyy-mm-dd');
          let couponCodeExists = couponModel.checkCouponCodeExists(
            coupon_code,
            today
          );
          if (couponCodeExists.length == 0) {
            err++;
            errors.coupon_code = 'Invalid coupon code';
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
  /*   otp_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { otp } = req.body;

      if (otp) {
        const userOtpExists = await userModel.user_otp_exists(otp);
        if (userOtpExists.length < 1) {
          err++;
          errors.otp = 'OTP invalid';
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

  user_id_exists: async (req, res, next) => {
    console.log("req recived");
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
  application_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      const { application_id } = req.body;

      if (application_id) {
        const applicationIdExists = await userModel.get_application_by_id(
          application_id
        );

        if (applicationIdExists.length < 1) {
          err++;
          errors.application_id = 'Application not exists';
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
  document_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      var document_id = req.params.document_id;
      var user_id = req.user.id;
      //  const { fcm_id } = req.body;

      if (document_id) {
        // const userIdExists = await userModel.user_id_exists(user_id);

        let documentIdExists = await userModel.document_id_exists(document_id);

        documentIdExists = JSON.stringify(documentIdExists);
        documentIdExists = JSON.parse(documentIdExists);
        // console.log('documentIdExists-->', documentIdExists);
        // return false;
        if (documentIdExists.length < 1) {
          err++;
          errors.document_id = 'Document id not exist';
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
  user_university_detail: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      var university_id = req.params.university_id;
      var user_id = req.user.id;
      //  console.log('user_id DB--', user_id);

      if (user_id) {
        const userIdExists = await userModel.user_id_exists(user_id);

        const universityExists = await userModel.university_id_exists(
          university_id
        );

        if (userIdExists.length < 1) {
          err++;
          errors.user = 'User not exists';
        }

        if (universityExists.length < 1) {
          err++;
          errors.fcm = 'University id not exist';
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
  address_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      var address_id = req.params.address_id;

      if (address_id) {
        const userAddressIdExists = await userModel.address_id_exists(
          address_id
        );
        if (userAddressIdExists.length < 1) {
          err++;
          errors.mobile = 'Address ID not exists';
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
  rfq_project_exist: async (req, res, next) => {
    try {

      if (!req.user.subscription_plan_id) {
        res
          .status(400)
          .json({
            status: 3,
            message: 'You need to purchase subscription to create RFQ'
          })
          .end();
        return;
      }

      let errors = {};
      let err = 0;
      let { project_id } = req.body;
      const user_id = req.user.id;

      if (project_id && project_id != -1) {
        const rfqProjectExists = await rfqModel.rfq_project_exist(project_id, user_id);
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
  // not used
  // vendor_exist: async (req, res, next) => {
  //   try {
  //     let errors = {};
  //     let err = 0;
  //     const { vendorName, email, phone, is_private } = req.body;
  //     // let {productDetails} = req.body
  //      const buyerId = req.user.id;

  //     let obj = {
  //       buyerId,
  //       vendorName,
  //       email,
  //       phone,
  //       productList: "Products already added.",
  //       is_private: !(req.body.is_private) || req.body.is_private == 0 ? 0 : 1,
  //     }
  //     // let { email, phone, is_private } = req.body;

  //     if (email && phone) {
  //       const userEmailExists = await userModel.user_exist(email, phone);
  //       if (userEmailExists.length > 0) {

  //         //  check whether the user is vendor or not by checking thier user_type==3
  //         if (userEmailExists[0].user_type == 3) {
  //           // case 1 -> whether the vendor is public
  //           if (userEmailExists.is_private == 0) {
  //             await userModel.mapBuyerToVendor(req.user.id, userEmailExists[0].id);
  //             res
  //               .status(200)
  //               .json({
  //                 status: 1,
  //                 message: "This vendor is already registered as a PUBLIC vendor in our system. They have now been added to your preferred vendor list."
  //               })
  //               .end();
  //             return;
  //           } else {
  //             // case 2 -> whether the vendor is private
  //             await userModel.mapBuyerToVendor(req.user.id, userEmailExists[0].id);
  //             // when buyer adds as private
  //             if(is_private){
  //               res
  //                 .status(200)
  //                 .json({
  //                   status: 1,
  //                   message: "This vendor is already registered as a PRIVATE vendor in our system. They have now been added to your preferred vendor list."
  //                 })
  //                 .end();
  //               return;
  //             }else{
  //               obj.status = 3; // For public vendor pending review
  //               const result = await userModel.insertBuyerPrivateVendor(obj);
  //               res
  //               .status(200)
  //               .json({
  //                 status: 1,
  //                 data : result,
  //                 message: "Vendor has been sent to the admin for review to make their profile PUBLIC. They have also been added to your preferred vendor list."
  //               })
  //               .end();
  //             return;
  //             }

  //           }

  //         } else {
  //           err++;
  //           errors.user_exist = 'Unable to add this vendor. Please ensure the credentials belong to a valid vendor account.';
  //         }


  //       }
  //     }

  //     if (err > 0) {
  //       res
  //         .status(400)
  //         .json({
  //           status: 2,
  //           errors
  //         })
  //         .end();
  //     } else {
  //       next();
  //     }
  //   } catch (err) {
  //     logError(err);
  //     res
  //       .status(400)
  //       .json({
  //         status: 3,
  //         message: Config.errorText.value
  //       })
  //       .end();
  //   }
  // },

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
      const rfq_id  = req.params.id;
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

  rfq_access_check_req_body: async (req, res, next) => {
  
    try {
      const { rfq_id } = req.body;

      // if vendor is not login then we use token from query.
      // if req.is_verified is true then there must be token in the query
    if (!req.is_verified && !req.query.token) {
      return res
      .status(401)
      .json({ 
        status: 0,
        message: 'Access denied. Please provide a valid token.' 
      });
    }
  
      // if user try to send query without login
    // then we take token in the query and take the vendor
  
    const withoutLoginUserToken = !req.is_verified ? req.query.token : null;

    if (withoutLoginUserToken) {
      // Check if the token exists
      const tokenData = await rfqModel.checkIfExists("tbl_vendor_rfq_tokens_non_login", `token = '${withoutLoginUserToken}'`);

      if (!tokenData || tokenData.length === 0) {
        // Token is not valid
        return res
          .status(400)
          .json({
            status: 0,
            message: 'Invalid or expired token!'
          })
          .end();
      }

      // Retrieve user data associated with the token
      const userData = await rfqModel.checkIfExists("tbl_users", `id = ${tokenData[0].vendor_id}`);

      if (!userData || userData.length === 0) {
        // User data is not valid
        return res
          .status(404)
          .json({
            status: 0,
            message: 'User not found!'
          })
          .end();
      }
      // Remove password from user data
      const { password, ...userWithoutPassword } = userData[0];
      // Assign the user data to req.user
      req.user = userWithoutPassword;
    }


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

  }
  
};

export { validateDbBody };
