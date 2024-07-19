import buyerModel from '../../models/buyerModel.js';
import rfqModel from '../../models/rfqModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

const cryptr = new Cryptr(Config.cryptR.secret);

const buyerController = {
  buyerList: async (req, res, next) => {
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

      let buyerList = await buyerModel.getBuyerList(
        limit,
        offset,
        organization,
        verified,
        name
      );
      let buyerCount = await buyerModel.getBuyerListCount(
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
  buyerDetails: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: buyerDetails
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
  buyer_rfq_list: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, buyerId);
      let count = await rfqModel.getBuyerRfqCount(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count.length
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
  buyer_subscription_details: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      const subscriberDetails = await subscriptionModel.getSubscriberDetails(
        buyerId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: subscriberDetails
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
  blockBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      let status = req.body.status;
      status = status == 1 ? 2 : 1;
      await buyerModel.blockBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${status == 1 ? 'unblocked' : 'blocked'}`
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
  updateBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      const {
        name,
        email,
        mobile,
        organization_name,
        address,
        dob,
        country,
        linkedin,
        facebook,
        whatsapp,
        skype
      } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let buyerObj = {
        name,
        email,
        mobile,
        organization_name: organization_name || null,
        updatedBy,
        fileName,
        originalFilename,
        address: address || null,
        dob: dateFormat(dob, 'yyyy-mm-dd'),
        country: country || null,
        linkedin: linkedin || null,
        facebook: facebook || null,
        whatsapp: whatsapp || null,
        skype: skype || null
      };
      await buyerModel.updateBuyer(buyerId, buyerObj);

      /* if (fileName) {
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
          message: 'Buyer successfully updated'
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
  approveBuyer: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let buyerId = req.params.id;
      let status = req.body.status;
      await buyerModel.approveBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${
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
  },
  deleteBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      await buyerModel.deleteBuyer(buyerId, updatedBy);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Buyer successfully deleted'
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
  /*  buyerDetails: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails
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
  } */
};
export default buyerController;
