import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import couponModel from '../../models/couponModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';

const validateDbBody = {
  create_coupon: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { coupon } = req.body;

      let checkCoupon = await couponModel.couponExists(coupon);
      if (checkCoupon.length > 0) {
        err++;
        errors.coupon = 'Coupon already exist';
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
  update_coupon: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let coupon_id = req.params.id;
      let { coupon } = req.body;

      let checkCouponId = await couponModel.couponIdExists(coupon_id);
      if (checkCouponId.length == 0) {
        err++;
        errors.coupon_id = 'Coupon id not exist';
      }

      if (err == 0 && req.method != 'DELETE') {
        let checkCoupon = await couponModel.couponExistsWithId(
          coupon_id,
          coupon
        );
        if (checkCoupon.length > 0) {
          err++;
          errors.coupon = 'Coupon already exist';
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
  check_coupon_code: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { coupon_code } = req.body;
      let checkCoupon = [];
      if (coupon_code) {
        checkCoupon = await couponModel.couponExists(coupon_code);

        if (checkCoupon.length > 0) {
          //Checking the expiry date of the Coupon Code
          let currentDate = new Date().toISOString().slice(0, 10);
          let start_date = new Date(checkCoupon[0].start_date)
            .toISOString()
            .slice(0, 10);
          let end_date = new Date(checkCoupon[0].end_date)
            .toISOString()
            .slice(0, 10);
          if (currentDate > end_date) {
            err++;
            errors.coupon_code = 'Expired Coupon';
          } else if (currentDate < start_date) {
            err++;
            errors.coupon_code = 'Invalid Coupon Code';
          }
        } else {
          err++;
          errors.coupon_code = 'Invalid Coupon Code';
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
        req.coupon = coupon_code ? checkCoupon[0] : null;
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
  add_offer: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { text, subscription_plan_id } = req.body;
      if (req.method === 'POST') {
        let checkOffer = await couponModel.offerExists(text);
        if (checkOffer.length > 0) {
          err++;
          errors.text = 'Offer already exist';
        }
      }

      if (req.method === 'PUT') {
        let { id } = req.value.params;
        let checkOffer = await couponModel.sameOfferExists(text, id);
        if (checkOffer.length > 0) {
          err++;
          errors.text = 'Offer already exist';
        }
      }

      for await (const subscription_id of subscription_plan_id) {
        let subscriptionIdExist = await subscriptionModel.subscriptionIdExist(
          subscription_id
        );
        if (subscriptionIdExist.length == 0) {
          err++;
          errors.subscription_plan_id = 'Please select valid subscription';
        }
        if (subscriptionIdExist.length > 0 && req.method === 'POST') {
          let subscriptionOfferExist =
            await subscriptionModel.subscriptionOfferExist(subscription_id);
          if (subscriptionOfferExist.length > 0) {
            err++;
            errors.subscription_plan_id = `Subscription (${subscriptionIdExist[0].plan_name}) already has offer`;
          }
        }
        if (subscriptionIdExist.length > 0 && req.method === 'PUT') {
          let { id } = req.value.params;
          let subscriptionOfferExist =
            await subscriptionModel.subscriptionOfferExist(subscription_id, id);
          if (subscriptionOfferExist.length > 0) {
            err++;
            errors.subscription_plan_id = `Subscription (${subscriptionIdExist[0].plan_name}) already has offer`;
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
  offer_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let { id } = req.value.params;
      if (id) {
        const offerIdExists = await couponModel.offerIdExists(id);
        if (offerIdExists.length > 0) {
          next();
        } else {
          errors.id = 'Please enter proper offer id';
          res
            .status(400)
            .json({
              status: 2,
              errors
            })
            .end();
        }
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
