// import buyerModel from '../../models/buyerModel.js';
import otherUserModel from '../../models/otherUserModel.js';
import vendorModel from '../../models/vendorModel.js';
import Config from '../../config/app.config.js';
// import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import { logError, sendMail, generatePassword } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';
import Moment from 'moment';
import subscriptionModel from '../../models/subscriptionModel.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const otherUserController = {
  otheruserList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name;
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
      if (req.query.organization) {
        organization = req.query.organization;
      }
      if (req.query.verified) {
        verified = req.query.verified;
      }

      let buyerList = await otherUserModel.getOtherUserList(
        limit,
        offset,
        organization,
        verified,
        name
      );
      let buyerCount = await otherUserModel.getOtherUserCount(
        organization,
        verified,
        name
      );
      res
        .status(200)
        .json({
          status: 1,
          data: buyerList,
          total_count: buyerCount.count
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
  otherUserDetails: async (req, res, next) => {
    try {
      let otherUserId = req.params.id;
      let otherUserDetails = await otherUserModel.getOtherUserDetails(
        otherUserId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: otherUserDetails
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
  blockOtherUser: async (req, res, next) => {
    try {
      let otherUserId = req.params.id;
      let updatedBy = req.user.id;
      let status = req.body.status;
      status = status == 1 ? 2 : 1;
      await otherUserModel.blockOtherUser(otherUserId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Other User successfully ${
            status == 1 ? 'unblocked' : 'blocked'
          }`
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
  addOtherUser: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { name, email, mobile, organization_name } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let orgChar = organization_name
        .match(/[a-zA-Z]/g)
        .join('')
        .toLowerCase();
      let capitalizeFourOrganizationLetter = `${orgChar
        .charAt(0)
        .toUpperCase()}${orgChar.substring(1, 4)}`;
      let password = `${capitalizeFourOrganizationLetter}@${mobile.substring(
        6,
        10
      )}`;

      let otherUserObj = {
        name,
        email,
        mobile,
        organization_name,
        register_as: 4,
        password: generatePassword(password),
        status: 1,
        createdBy,
        fileName,
        originalFilename
      };

      let otherUserId = await otherUserModel.addOtherUser(otherUserObj);

      if (otherUserId) {
        let html_variables = [{ name: name }];

        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Work wise | Registration`, // Subject line
          // html: dynamic_html // plain text body
          html: `Dear ${name}, Your login credential Userid :${email} and password ${password}`
        });

        let checkFreeSubscription =
          await subscriptionModel.checkFreeSubscription();
        if (checkFreeSubscription.length > 0) {
          const startDate = Moment(); // Replace with the actual start date

          const billingCycleMonths = checkFreeSubscription[0].duration;

          // Calculate the end date by adding the billing cycle and subtracting one day
          const endDate = startDate
            .clone()
            .add(billingCycleMonths, 'months')
            .subtract(1, 'day');
          const renewDate = startDate.clone().add(billingCycleMonths, 'months');

          // console.log('Start Date:', startDate.format('YYYY-MM-DD'));
          // console.log('End Date:', endDate.format('YYYY-MM-DD'));
          // console.log('Renew Date:', renewDate.format('YYYY-MM-DD'));

          let UserSubscriptionObj = {
            user_id: otherUserId[0].id,
            plan_id: checkFreeSubscription[0].id,
            status: 1, //By default payment done
            start_date: startDate.format('YYYY-MM-DD'),
            end_date: endDate.format('YYYY-MM-DD'),
            renew_date: renewDate.format('YYYY-MM-DD')
          };

          let createUserSubscription =
            await subscriptionModel.createUserSubscription(UserSubscriptionObj);

          await subscriptionModel.updateUserSubscriptionId(
            checkFreeSubscription[0].id,
            otherUserId[0].id
          );
          let subscriptionMappingDetails =
            await subscriptionModel.getSubscriptionMappingDetails(
              checkFreeSubscription[0].id
            );
          // console.log(
          //   'subscriptionMappingDetails==>>>>',
          //   subscriptionMappingDetails
          // );
          for await (const {
            allocated_feature,
            feature_id
          } of subscriptionMappingDetails) {
            let userSubscriptionFeatureObj = {
              user_subscriptions_id: createUserSubscription.id,
              feature_id: feature_id,
              plan_id: checkFreeSubscription[0].id,
              used_feature_count: 0,
              allocated_feature: allocated_feature,
              user_id: otherUserId[0].id
            };
            await subscriptionModel.createUserSubscriptionFeature(
              userSubscriptionFeatureObj
            );
          }
        }
        res
          .status(200)
          .json({
            status: 1,
            message: 'Other User successfully created'
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
  updateOtherUser: async (req, res, next) => {
    try {
      let otherUserId = req.params.id;
      let updatedBy = req.user.id;
      const { name, mobile, organization_name } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let otherUserDetails = await otherUserModel.getOtherUserDetails(
        otherUserId
      );
      let otherUserObj = {
        name,
        mobile,
        organization_name,
        updatedBy,
        fileName,
        originalFilename
      };
      await otherUserModel.updateOtherUser(otherUserId, otherUserObj);

      /* if (fileName) {
        if (otherUserDetails[0].new_profile_image) {
          const file_link = `${Config.upload.user_image}/${otherUserDetails[0].new_profile_image}`;
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
          message: 'Other User successfully updated'
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
  deleteOtherUser: async (req, res, next) => {
    try {
      let otherUserId = req.params.id;
      let updatedBy = req.user.id;
      await otherUserModel.deleteOtherUser(otherUserId, updatedBy);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Other User successfully deleted'
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
  approveOtherUser: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let otherUserId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;
      let reasonId = '';
      if (reject_reason_id && status == 0) {
        reasonId = reject_reason_id;
      } else if (!reject_reason_id && status == 0) {
        let checkRejectReason = await vendorModel.checkRejectReason(
          reject_reason
        );
        if (checkRejectReason.length > 0) {
          reasonId = checkRejectReason[0].id;
        } else {
          let reasonObj = {
            status: 1,
            reject_reason: reject_reason,
            type: 1
          };
          let createReason = await vendorModel.createReason(reasonObj);
          reasonId = createReason[0].id;
        }
      }
      await otherUserModel.approveOtherUser(
        otherUserId,
        updatedBy,
        status,
        reasonId
      );
      res
        .status(200)
        .json({
          status: 1,
          message: `Other User successfully ${
            status == 0 ? 'Disapproved' : 'Approved'
          }`
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
export default otherUserController;
