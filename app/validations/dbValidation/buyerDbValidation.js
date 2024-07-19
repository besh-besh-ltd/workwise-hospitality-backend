import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import buyerModel from '../../models/buyerModel.js';

const validateDbBody = {
  buyer_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let buyerId = req.params.id;
      if (buyerId) {
        let buyerIdExists = await buyerModel.buyerIdExist(buyerId);
        if (buyerIdExists.length == 0) {
          err++;
          errors.id = 'Buyer not found';
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
  buyer_block_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let BuyerId = req.params.id;
      let status = req.body.status;

      if (BuyerId) {
        const buyerIDExists = await buyerModel.buyerIdExist(BuyerId);
        if (buyerIDExists.length == 0) {
          err++;
          errors.id = 'Buyer not found';
        }
        if (status == 1 && buyerIDExists[0].status == 2) {
          err++;
          errors.status = 'Buyer already blocked';
        } else if (status == 0 && buyerIDExists[0].status == 1) {
          err++;
          errors.status = 'Buyer already unblocked';
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
  buyer_email_mobile_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { email, mobile } = req.body;
      let buyerId = req.params.id;

      if (email) {
        const buyerEmailExists = await buyerModel.otherBuyerEmailExist(
          email,
          buyerId
        );
        if (buyerEmailExists.length > 0) {
          err++;
          errors.email = 'Email already exists';
        }
      }
      if (mobile) {
        const buyerMobileExists = await buyerModel.otherBuyerMobileExist(
          mobile,
          buyerId
        );
        if (buyerMobileExists.length > 0) {
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
  buyer_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let buyerId = req.params.id;
      let status = req.body.status;

      if (buyerId) {
        const buyerIDExists = await buyerModel.buyerIdExist(buyerId);
        if (buyerIDExists.length == 0) {
          err++;
          errors.id = 'Buyer not found';
        }
        if (status == 1 && buyerIDExists[0].status == 1) {
          err++;
          errors.status = 'Buyer already accepted';
        } else if (status == 0 && buyerIDExists[0].status == 0) {
          err++;
          errors.status = 'Buyer already rejected';
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
