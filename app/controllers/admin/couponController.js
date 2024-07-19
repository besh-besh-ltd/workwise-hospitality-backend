import dateFormat from 'dateformat';

import couponModel from '../../models/couponModel.js';

import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';

const couponController = {
  createCoupon: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      let {
        coupon,
        is_percentage,
        discount_amount,
        start_date,
        end_date,
        status
      } = req.body;

      let couponObj = {
        coupon: coupon,
        is_percentage: is_percentage,
        start_date: dateFormat(start_date, 'yyyy-mm-dd'),
        end_date: dateFormat(end_date, 'yyyy-mm-dd'),
        discount_amount: discount_amount,
        created_by: user_id,
        status: status
      };

      await couponModel.addCoupon(couponObj);

      res
        .status(200)
        .json({
          status: 1,
          message: 'Coupon Added'
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
  updateCoupon: async (req, res, next) => {
    try {
      let coupon_id = req.params.id;
      let {
        coupon,
        is_percentage,
        discount_amount,
        start_date,
        end_date,
        status
      } = req.body;

      await couponModel.updateCoupon(
        coupon,
        is_percentage,
        discount_amount,
        dateFormat(start_date, 'yyyy-mm-dd'),
        dateFormat(end_date, 'yyyy-mm-dd'),
        status,
        coupon_id,
        req.user.id
      );

      res
        .status(200)
        .json({
          status: 1,
          message: 'Coupon update successful'
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
  listCoupon: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      let coupon = req.query?.coupon;

      let couponList = await couponModel.getAllCoupon(limit, offset, coupon);
      let couponCount = await couponModel.getAllCouponCount(coupon);
      res
        .status(200)
        .json({
          status: 1,
          data: couponList,
          total_count: couponCount.count
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
  deleteCoupon: async (req, res, next) => {
    try {
      let coupon_id = req.params.id;
      await couponModel.deleteCoupon(coupon_id, req.user.id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Coupon deleted successfully'
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
  addOffer: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      let {
        text,
        price,
        is_percentage,
        subscription_plan_id,
        start_date,
        end_date,
        status
      } = req.body;

      let offerObj = {
        is_percentage: is_percentage,
        text: text,
        price: price,
        start_date: dateFormat(start_date, 'yyyy-mm-dd'),
        end_date: dateFormat(end_date, 'yyyy-mm-dd'),
        created_by: user_id,
        status: status
      };

      let addOffer = await couponModel.addOffer(offerObj);

      for await (const subscription_id of subscription_plan_id) {
        let subscriptionPlansOfferObj = {
          offer_id: addOffer.id,
          subscription_plan_id: subscription_id,
          status: 1
        };
        await couponModel.addSubscriptionPlansOffer(subscriptionPlansOfferObj);
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Offer Added'
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
  offerList: async (req, res, next) => {
    try {
      let offerList = await couponModel.offerList();
      res
        .status(200)
        .json({
          status: 1,
          data: offerList
        })
        .end();
    } catch (error) {
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
  offerDetails: async (req, res, next) => {
    try {
      let { id } = req.value.params;
      let offer_details = await couponModel.offerDetails(id);
      res
        .status(200)
        .json({
          status: 1,
          data: offer_details[0]
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
  updateOffer: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      let offerId = req.value.params.id;
      let {
        text,
        price,
        is_percentage,
        subscription_plan_id,
        start_date,
        end_date,
        status
      } = req.body;
      let offerObj = {
        is_percentage: is_percentage,
        text: text,
        price: price,
        start_date: dateFormat(start_date, 'yyyy-mm-dd'),
        end_date: dateFormat(end_date, 'yyyy-mm-dd'),
        updated_by: user_id,
        status: status
      };
      await couponModel.updateOffer(offerObj, offerId);
      await couponModel.updateSubscriptionPlansOfferMappingInactive(
        offerId,
        subscription_plan_id
      );
      for (let sub = 0; sub < subscription_plan_id.length; sub++) {
        const element = subscription_plan_id[sub];
        let checkMapping = await couponModel.checkSubscriptionPlansOfferMapping(
          [offerId, element]
        );
        if (checkMapping.length > 0) {
          await couponModel.updateSubscriptionPlansOfferMappingActive(
            offerId,
            element
          );
        } else {
          let subscriptionPlansOfferObj = {
            offer_id: offerId,
            subscription_plan_id: element,
            status: 1
          };
          await couponModel.addSubscriptionPlansOffer(
            subscriptionPlansOfferObj
          );
        }
      }
      res
        .status(200)
        .json({
          status: 1,
          message: 'Offer successfully updated'
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
  deleteOffer: async (req, res, next) => {
    try {
      let offerId = req.params.id;
      let offerObj = {
        status: 2,
        updated_by: req.user.id
      };
      await couponModel.deleteOffer(offerObj, offerId);
      await couponModel.updateSubscriptionPlansOfferMappingInactive(offerId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Offer deleted successfully'
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
  }
};
export default couponController;
