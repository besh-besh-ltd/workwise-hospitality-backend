import subscriptionModel from '../../models/subscriptionModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import dateFormat from 'dateformat';
import Moment from 'moment';
import excelJS from 'exceljs';

const subscriptionController = {
  subscriptionList: async (req, res, next) => {
    try {
      let subscriptionList = await subscriptionModel.getSubscriptionList();
      res
        .status(200)
        .json({
          status: 1,
          data: subscriptionList
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
  subscriptionListDropdown: async (req, res, next) => {
    try {
      let subscriptionList =
        await subscriptionModel.getSubscriptionListDropdown();
      res
        .status(200)
        .json({
          status: 1,
          data: subscriptionList
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
  addSubscription: async (req, res, next) => {
    try {
      let values = req.body;

      let subscriptionObj = {
        plan_name: values.name,
        price: values.price || 0.0,
        duration: values.duration,
        plan_type: values.type,
        status: values.status || 1, // default is active
        created_by: req.user.id
      };
      let subscriptionId = await subscriptionModel.createSubscription(
        subscriptionObj
      );

      for await (const { feature_id, allocated_feature } of values.feature) {
        let featurePlanObj = {
          plan_id: subscriptionId.id,
          feature_id: feature_id,
          allocated_feature: allocated_feature
        };

        await subscriptionModel.createFeaturePlanMapping(featurePlanObj);
      }
      res
        .status(200)
        .json({
          status: 1,
          message: 'Subscription Plan Added'
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
  subscriptionFeatureList: async (req, res, next) => {
    try {
      let subscriptionFeatureList =
        await subscriptionModel.getSubscriptionFeatureList();
      res
        .status(200)
        .json({
          status: 1,
          data: subscriptionFeatureList
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
  subscriptionDetails: async (req, res, next) => {
    try {
      let subscriptionId = req.params.id;
      let subscriptionDetails = await subscriptionModel.getSubscriptionDetails(
        subscriptionId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: subscriptionDetails
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
  updateSubscription: async (req, res, next) => {
    try {
      let values = req.body;
      let subscriptionId = req.params.id;

      let subscriptionObj = {
        plan_name: values.name,
        price: values.price || 0.0,
        duration: values.duration,
        plan_type: values.type,
        status: values.status || 1, // default is active
        updated_by: req.user.id
      };
      await subscriptionModel.updateSubscription(
        subscriptionObj,
        subscriptionId
      );
      //delete previous mapping with subscription
      await subscriptionModel.deleteFeaturePlanMapping(subscriptionId);

      for await (const { feature_id, allocated_feature } of values.feature) {
        let featurePlanObj = {
          plan_id: subscriptionId,
          feature_id: feature_id,
          allocated_feature: allocated_feature
        };

        await subscriptionModel.createFeaturePlanMapping(featurePlanObj);
      }
      res
        .status(200)
        .json({
          status: 1,
          message: 'Subscription Plan updated'
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
  deleteSubscription: async (req, res, next) => {
    try {
      let subscriptionId = req.params.id;
      await subscriptionModel.deleteSubscription(subscriptionId, req.user.id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Subscription Plan Deleted'
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
  buyerSubscriptionList: async (req, res, next) => {
    try {
      let today = dateFormat(new Date(), 'yyyy-mm-dd');
      let subscriptionList = await subscriptionModel.getBuyerSubscriptionList(
        today
      );

      let buyerSubscriptionIdCheck =
        await subscriptionModel.buyerSubscriptionIdCheck(req.user.id);
      // console.log(subscriptionList);
      for await (let [
        index,
        availableSubscription
      ] of subscriptionList.entries()) {
        if (buyerSubscriptionIdCheck.length > 0) {
          if (availableSubscription.id == buyerSubscriptionIdCheck[0].plan_id) {
            subscriptionList[index].active = true;
            subscriptionList[index].start_date =
              buyerSubscriptionIdCheck[0].start_date;
            subscriptionList[index].end_date =
              buyerSubscriptionIdCheck[0].end_date;
          } else {
            subscriptionList[index].active = false;
            subscriptionList[index].start_date = null;
            subscriptionList[index].end_date = null;
          }
        } else {
          subscriptionList[index].active = false;
          subscriptionList[index].start_date = null;
          subscriptionList[index].end_date = null;
        }
        // console.log(availableSubscription, index);
        let newSubscriptionPrice = Math.round(availableSubscription.price);
        let offerDiscountedPrice = 0;
        if (
          availableSubscription.Offers.length > 0 &&
          availableSubscription.Offers[0].is_percentage
        ) {
          offerDiscountedPrice =
            newSubscriptionPrice *
            (availableSubscription.Offers[0].price / 100);
          newSubscriptionPrice = Math.round(
            newSubscriptionPrice - offerDiscountedPrice
          );
        } else if (
          availableSubscription.Offers.length > 0 &&
          !availableSubscription.Offers[0].is_percentage
        ) {
          offerDiscountedPrice = availableSubscription.Offers[0].price;
          newSubscriptionPrice = Math.round(
            newSubscriptionPrice - offerDiscountedPrice
          );
        }

        subscriptionList[index].discount_price = newSubscriptionPrice;
      }

      res
        .status(200)
        .json({
          status: 1,
          data: subscriptionList
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
  getAllSubscribersList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      if (req.query?.download == 'true') {
        offset = 0;
        limit = 'ALL';
      }

      let subscriptionId = req.query?.id;
      let search = req.query?.search;
      let userType = req.query?.user_type;
      let verificationStatus = req.query?.status;
      let expire = req.query?.expire;
      let subscribersList = await subscriptionModel.getSubscribersList(
        limit,
        offset,
        subscriptionId,
        search,
        userType,
        verificationStatus,
        expire
      );
      let subscribersCount = await subscriptionModel.getSubscribersCount(
        subscriptionId,
        search,
        userType,
        verificationStatus,
        expire
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Subscribers');

        // Add headers
        worksheet.columns = [
          { header: 'S no.', key: 's_no', width: 5 },
          { header: 'Name', key: 'name', width: 20 },
          { header: 'Email', key: 'email', width: 20 },
          { header: 'Customer Type', key: 'user_type', width: 20 },
          { header: 'Subscription Plan', key: 'plan_name', width: 20 },
          { header: 'Status', key: 'user_status', width: 20 },
          { header: 'Subscribed On', key: 'start_date', width: 20 },
          { header: 'Next Renewal', key: 'renew_date', width: 20 },
          { header: 'Invoice', key: 'invoice_file', width: 20 }
        ];

        let counter = 1;

        subscribersList.forEach((sub) => {
          sub.s_no = counter;
          sub.user_status = sub.user_status == 1 ? 'Verified' : 'Not Verified';
          sub.user_type = sub.user_type == 2 ? 'Buyer' : 'Other user';
          sub.start_date = dateFormat(sub.start_date, 'dd-mm-yyyy');
          sub.renew_date = dateFormat(sub.renew_date, 'dd-mm-yyyy');
          worksheet.addRow(sub); // Add data in worksheet

          counter++;
        });

        // Making first line in excel bold
        worksheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true };
        });

        // Set content type and disposition
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=subscribers.xlsx'
        );

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: subscribersList,
            total_count: subscribersCount.count
          })
          .end();
      }
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
  changeSubscriptionDate: async (req, res, next) => {
    try {
      let { id, new_date } = req.body;

      new_date = Moment(new_date);

      const renewDate = new_date.clone().add(1, 'day');
      // console.log('dateFormat(new_date', dateFormat(new_date, 'yyyy-mm-dd'));
      // console.log(renewDate.format('YYYY-MM-DD'));

      let userSubscriptionsObj = {
        end_date: dateFormat(new_date, 'yyyy-mm-dd'),
        renew_date: renewDate.format('YYYY-MM-DD')
      };
      await subscriptionModel.updateBuyerSubscription(userSubscriptionsObj, id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Subscription date changed successfully'
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
  getPaymentList: async (req, res, next) => {
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
      if (req.query?.download == 'true') {
        offset = 0;
        limit = 'ALL';
      }

      let { start_date, end_date, payment_status, search } = req.query;
      if (start_date) {
        start_date = dateFormat(start_date, 'yyyy-mm-dd');
      }
      if (end_date) {
        end_date = dateFormat(end_date, 'yyyy-mm-dd');
      }

      let paymentList = await subscriptionModel.getPaymentList(
        limit,
        offset,
        start_date,
        end_date,
        payment_status,
        search
      );
      let paymentListCount = await subscriptionModel.paymentListCount(
        start_date,
        end_date,
        payment_status,
        search
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Payments');

        // Add headers
        worksheet.columns = [
          { header: 'S no.', key: 's_no', width: 5 },
          { header: 'Name', key: 'name', width: 20 },
          { header: 'Email', key: 'email', width: 20 },
          { header: 'Mobile', key: 'mobile', width: 20 },
          { header: 'Customer Type', key: 'user_type', width: 20 },
          { header: 'Status', key: 'user_status', width: 20 },
          { header: 'Payment Date', key: 'date', width: 20 },
          { header: 'Invoice', key: 'invoice_file', width: 20 },
          { header: 'Subscription Paid', key: 'amount', width: 20 },
          {
            header: 'Subscription Charge',
            key: 'subscription_charge',
            width: 20
          },
          { header: 'Offer', key: 'offer_price', width: 20 },
          { header: 'Coupon', key: 'coupon_price', width: 20 },
          { header: 'Method', key: 'method', width: 20 }
        ];

        let counter = 1;

        paymentList.forEach((pay) => {
          pay.s_no = counter;
          pay.user_status = pay.user_status == 1 ? 'Verified' : 'Not Verified';
          pay.user_type = pay.user_type == 2 ? 'Buyer' : 'Other user';
          pay.date = dateFormat(pay.date, 'dd-mm-yyyy');
          worksheet.addRow(pay); // Add data in worksheet

          counter++;
        });

        // Making first line in excel bold
        worksheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true };
        });

        // Set content type and disposition
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=payments.xlsx'
        );

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: paymentList,
            total_count: paymentListCount.count
          })
          .end();
      }
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
export default subscriptionController;
