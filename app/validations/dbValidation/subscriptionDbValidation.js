import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import subscriptionModel from '../../models/subscriptionModel.js';

const validateDbBody = {
  feature_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { feature, status, type } = req.body;
      for await (const { feature_id, allocated_feature } of feature) {
        let featureIdExist = await subscriptionModel.featureIdExist(feature_id);
        if (featureIdExist.length == 0) {
          err++;
          errors.feature = 'Please select a valid Feature';
        }
      }
      if (status == 1 && type == 'f') {
        let planId = req.params.id;
        let checkFreeSubscription =
          await subscriptionModel.checkFreeSubscription(planId);
        if (checkFreeSubscription.length > 0) {
          err++;
          errors.status = 'You already have an active free subscription';
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
  subscription_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let subscriptionId = req.params.id;
      let subscriptionIdExist = await subscriptionModel.subscriptionIdExist(
        subscriptionId
      );
      if (subscriptionIdExist.length == 0) {
        err++;
        errors.id = 'This is not a valid Subscription';
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
  change_subscription_date: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { id, user_id, plan_id } = req.body;
      let subscriptionExist = await subscriptionModel.checkBuyerSubscription(
        id,
        user_id,
        plan_id
      );
      if (subscriptionExist.length == 0) {
        err++;
        errors.id = 'This is not a valid Subscription';
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
