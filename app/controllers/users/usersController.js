import userModel from '../../models/userModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import notificationModel from '../../models/notificationModel.js';
import couponModel from '../../models/couponModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  generateOTPRandomNo,
  generateRandomString,
  createPay,
  sendMail,
  notificationMail,
  convertSixDigit,
  addDefaultNotifications
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import FormData from 'form-data';
import Razorpay from 'razorpay';
import Moment from 'moment';
import puppeteer from 'puppeteer';
import fs from 'fs';
import { v4 } from 'uuid';
import admin from 'firebase-admin';
import fcm from 'fcm-notification';
// var serviceAccount = require('../config/privateKey.json');
import serviceAccount from '../../config/privateKey.json' assert { type: 'json' };
const certPath = admin.credential.cert(serviceAccount);
import JWT from 'jsonwebtoken';
var FCM = new fcm(certPath);
import child_process from 'child_process';

import {
  schemas,
  validateBodyController
} from '../../validations/paramValidation/userValidation.js';
import webpush from 'web-push';
import { sendNotification } from '../../services/notificationService.js';

const generatePassword = (password) => {
  var salt = bcrypt.genSaltSync(10);
  var hash = bcrypt.hashSync(password, salt);
  return hash;
};

webpush.setVapidDetails(
  process.env.WEB_PUSH_CONTACT,
  process.env.PUBLIC_VAPID_KEY,
  process.env.PRIVATE_VAPID_KEY
);

const cryptr = new Cryptr(Config.cryptR.secret);
import { v4 as uuidv4 } from 'uuid';
import { log } from 'console';
import rfqModel from '../../models/rfqModel.js';
var global_subscription = '';
const UsersController = {
  user_registration: async (req, res, next) => {
    try {
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { name, email, mobile, organization_name, register_as, password } =
        req.body;
      let status = '0';
      if (register_as == '2') {
        status = '1';
      }

      let userObj = {
        name,
        email,
        mobile,
        organization_name,
        register_as,
        password: generatePassword(password),
        status
      };
      // console.log('userObj', userObj);
      // return false;
      let user_id = await userModel.user_register(userObj);
      // console.log('test user id', user_id);

      if (user_id) {
        let html_variables = [{ name: name }];
        let dynamic_html = '';
        if (register_as == '2') {
          dynamic_html = fs
            .readFileSync(`${Config.template_path}/user_register_template.txt`)
            .toString();
        } else {
          dynamic_html = fs
            .readFileSync(`${Config.template_path}/user_vendor_template.txt`)
            .toString();
        }

        for (let index = 0; index < html_variables.length; index++) {
          const element = html_variables[index];
          let dynamic_key = Object.keys(element)[0];
          let replace_char = html_variables[index][dynamic_key];
          let replace_var = `[${dynamic_key.toLowerCase()}]`;

          dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
        }

        let findDynamicNotification =
          await notificationModel.findDynamicNotification('signup');
        if (
          findDynamicNotification.length > 0 &&
          findDynamicNotification[0].notification_type == 1
        ) {
          notificationMail({
            from: Config.webmasterMail, // sender address
            to: email, // list of receivers
            subject: findDynamicNotification[0].title, // Subject line
            html: findDynamicNotification[0].content // plain text body
          });
        } else {
          sendMail({
            from: Config.webmasterMail, // sender address
            to: email, // list of receivers
            subject: `Work wise | Registration`, // Subject line
            html: dynamic_html // plain text body
          });
        }

        addDefaultNotifications(user_id[0].id);

        let user_type_as = '';
        if (register_as == '2') {
          user_type_as = 'Buyer';
        } else if (register_as == '3') {
          user_type_as = 'Vendor';
        } else {
          user_type_as = 'Other User';
        }
        const notificationData = {
          type: 'Registration',
          title: `${user_type_as} Registered`,
          message: `${user_type_as} Registered successfully`,
          additional_data: {
            user_type: user_type_as
          }
        };
        // const receiverUserIds = [req.params.id];
        await sendNotification(user_id[0].id, '', notificationData);

        //activate default subscription
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
            user_id: user_id[0].id,
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
            user_id[0].id
          );

          // let userDetails = await userModel.user_profile_detail(
          //   user_id[0].id
          // );
          // let planDetails = await subscriptionModel.getSubscriptionDetails(
          //   userSubscription[0].plan_id
          // );
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
              user_id: user_id[0].id
            };
            await subscriptionModel.createUserSubscriptionFeature(
              userSubscriptionFeatureObj
            );
          }
        }

        res
          .status(200)
          .json({
            status: true,

            user_id: user_id,
            message: 'User registered'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  /*   subscribe: async (req, res, next) => {
    const subscription = req.body;
    global_subscription = subscription;
    console.log(subscription);

    const payload = JSON.stringify({
      title: 'Welcome to Workwise!',
      body: 'It works.'
    });

    webpush
      .sendNotification(subscription, payload)
      .then((result) => console.log(result))
      .catch((e) => console.log(e.stack));

    res.status(200).json({ success: true });
  }, */
  subscribe: async (req, res, next) => {
    // const subscription = req.body;

    const { subscription, token } = req.body;
    console.log('subscription', subscription);

    // global_subscription = subscription;
    let error = 0;
    let user = [];
    // console.log('subscription notification --->', subscription);
    // console.log('token notification--->', token);
    JWT.verify(token, Config.jwt.secret, async (err, payload) => {
      if (err) {
        error++;
      } else {
        if (!payload.user) {
          error++;
        }
        if (!payload.sub) {
          error++;
        }
        if (!payload.ag) {
          error++;
        }
        if (!payload.exp) {
          error++;
        } else {
          let current_time = Math.round(new Date().getTime() / 1000);
          if (current_time > payload.exp) {
            error++;
          }
        }
        user = await userModel.getUserById(cryptr.decrypt(payload.sub));
      }

      if (user.length > 0 && error == 0) {
        req.user = user[0];
        // console.log('User detail---', req.user);
        // console.log('Notification endpoint---', subscription.endpoint);
        //return false;
        await userModel.updateNotificationEndpointByUserId(
          subscription ? JSON.stringify(subscription) : null,
          req.user.id
        );
        next();
      } else {
        res.status(401).send('Unauthorized').end();
      }
    });

    /* const payload = JSON.stringify({
      title: 'Welcome to Workwise!',
      body: 'It works.'
    });

    webpush
      .sendNotification(subscription, payload)
      .then((result) => console.log(result))
      .catch((e) => console.log(e.stack)); */

    res.status(200).json({ success: true });
  },

  user_login: async (req, res, next) => {
    try {
      let resJson = {};
      let error = 0;
      let err_msg = 'Invalid username or password or OTP not verified';
      if (req.user.err_msg && req.user.err_msg != '') {
        err_msg = req.user.err_msg;
      }
      const { fcm_id } = req.body;
      if (req.user && req.user.id > 0 && req.query?.conform) {
        let oldDevice = req.user.user_agent
          ? req.get('User-Agent') == req.user.user_agent
          : true;
        let conform = req.query?.conform;
        if (!oldDevice && conform == 'true') {
          await userModel.updateAgent(req.get('User-Agent'), req.user.id);
          let findDynamicNotification =
            await notificationModel.findDynamicNotification(
              'another_user_try_to_login'
            );
          if (
            findDynamicNotification.length > 0 &&
            findDynamicNotification[0].notification_type == 1
          ) {
            notificationMail({
              from: Config.webmasterMail, // sender address
              to: req.user.email, // list of receivers
              subject: findDynamicNotification[0].title, // Subject line
              html: findDynamicNotification[0].content // plain text body
            });
          }
        } else if (!oldDevice && conform == 'false') {
          error++;
          resJson = { status: 4, message: 'You log in with other device' };
        }

        if (error == 0) {
          const userData = {
            user_id: cryptr.encrypt(req.user.id),
            name: req.user.name,
            user_type: req.user.user_type,
            user_agent: cryptr.encrypt(req.get('User-Agent')),
            sessions: ''
          };
          let user_detail = await userModel.user_profile_login_detail(
            req.user.id
          );
          // user_detail = Object.assign({}, ...user_detail);
          // console.log('user_detail-->', user_detail);

          const token = jwtHelper.signAccessTokenUser(userData);
          const payload = JSON.stringify({
            title: `Welcome ${req.user.name}`,
            body: 'Successfully logged In'
          });
          let logObj = {
            user_id: req.user.id,
            user_type: req.user.user_type,
            user_agent: req.get('User-Agent')
          };
          await userModel.insertLoginLog(logObj);
          await userModel.updateAgent(req.get('User-Agent'), req.user.id);

          let findDynamicNotification =
            await notificationModel.findDynamicNotification('login');
          if (
            findDynamicNotification.length > 0 &&
            findDynamicNotification[0].notification_type == 1
          ) {
            notificationMail({
              from: Config.webmasterMail, // sender address
              to: req.user.email, // list of receivers
              subject: findDynamicNotification[0].title, // Subject line
              html: findDynamicNotification[0].content // plain text body
            });
          }
          /* webpush
    .sendNotification(global_subscription, payload)
    .then((result) => console.log(result))
    .catch((e) => console.log(e.stack)); */
          res
            .status(200)
            .json({
              status: 1,
              token,
              user_detail,
              oldDevice: oldDevice,
              message: 'Login success'
            })
            .end();
        } else {
          res.status(400).json(resJson).end();
        }
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: err_msg
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
  renew_token: async (user_id) => {
    try {
      const user = await userModel.user_profile_detail(user_id);
      console.log('user--', user);
      const userData = {
        user_id: cryptr.encrypt(user_id),
        name: user[0].name,
        user_type: user[0].user_type,
        user_agent: cryptr.encrypt(req.get('User-Agent')),
        sessions: ''
      };
      const token = jwtHelper.signAccessTokenUser(userData);
      return token;
    } catch (error) {
      res.status(400).send({ success: false, msg: error.message });
    }
  },
  refresh_token: async (req, res, next) => {
    try {
      const { user_id } = req.body;
      const userData = await userModel.user_profile_detail(user_id);
      // console.log('userData--', userData);
      if (userData) {
        // const tokenData = await renew_token(user_id);
        const secret_jwt = Config.jwt.secret;
        var newSecretJwt = generateRandomString();
        console.log('secret--', secret_jwt);
        const envFilePath = '.env';

        console.log('envFilePath--', envFilePath);
        fs.readFile(envFilePath, 'utf-8', function (err, data) {
          if (err) {
            console.log('err--', err);
            return false;
          } else {
            var newValue = data.replace(
              new RegExp(secret_jwt, 'g'),
              newSecretJwt
            );
          }

          // console.log('newValue--', newValue);
          fs.writeFile(envFilePath, newValue, 'utf-8', function (err, data) {
            if (err) {
              console.log('err2--', err);
              return false;
            } else {
              console.log('Done!');
              const token = JWT.sign(
                {
                  iss: 'Des Technico',
                  sub: user_id,
                  name: userData[0].name,
                  session: '',
                  user: true,
                  ag: cryptr.encrypt(req.get('User-Agent')),
                  iat: Math.round(new Date().getTime() / 1000),
                  exp:
                    Math.round(new Date().getTime() / 1000) + 24 * 60 * 60 * 365
                },
                newSecretJwt
              );
              console.log('token123--', token);
              const response = {
                user_id: user_id,
                token: token
              };
              res.status(200).send({
                success: true,
                msg: 'Refresh token detail',
                data: response
              });
            }
          });
        });

        /*  const usersData = {
          user_id: cryptr.encrypt(user_id),
          name: userData[0].name,
          user_type: userData[0].user_type,
          user_agent: cryptr.encrypt(req.get('User-Agent')),
          sessions: ''
        }; */
        // const token = jwtHelper.signAccessTokenUser(usersData);
        console.log('terst123');
      } else {
        res.status(400).send({ success: false, msg: 'User not exits' });
      }
    } catch (error) {
      res.status(400).send({ success: false, msg: error.message });
    }
  },

  forgot_passw_otp_send: async (req, res, next) => {
    try {
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { email } = req.body;
      if (email) {
        const user_detail = await userModel.getUserAuthEmail(email);
        // console.log('user_detail--', user_detail[0].name);
        // return false;
        // let user_detail = Object.assign({}, ...userEmailExists);
        const verificationToken = v4();

        let userObj = {
          verificationToken,
          email
        };
        let token = await userModel.userVerificationTokenUpdate(userObj);

        var otpseq = generateOTPRandomNo();

        // return false;
        // const verificationLink = `${process.env.FRONT_BASE_URL}/forgot-password/${verificationToken}/${otpseq}`;
        const verificationLink = `${process.env.FRONT_BASE_URL}/validate-otp?otp=${otpseq}`;

        // console.log('verificationLink-->', verificationLink);
        // return false;
        let html_variables = [
          { name: user_detail[0].name },
          { otp: otpseq },
          { link: verificationLink }
        ];
        // console.log('html_variables--', html_variables);
        // return false;
        let dynamic_html = fs
          .readFileSync(`${Config.template_path}/otp_resend_template.txt`)
          .toString();
        for (let index = 0; index < html_variables.length; index++) {
          const element = html_variables[index];
          let dynamic_key = Object.keys(element)[0];
          let replace_char = html_variables[index][dynamic_key];
          let replace_var = `[${dynamic_key.toLowerCase()}]`;

          dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
        }

        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Work wise | Forgot Password OTP `, // Subject line
          html: dynamic_html // plain text body
        });

        let updateOtp = {
          otp: otpseq,
          email: email
        };

        let update_otp = await userModel.update_user_otp_resend(updateOtp);
        res
          .status(200)
          .json({
            status: true,
            otp: otpseq,
            user_id: user_detail.id,
            message: 'Forgot password OTP success'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  forgot_password_otp_authenticate: async (req, res, next) => {
    try {
      let { otp, password } = req.body;

      let user_dtls = await userModel.user_detail_otp_exists(otp);
      // console.log('userDetail-->', user_dtls);
      user_dtls = Object.assign({}, ...user_dtls);
      console.log('user_dtls-->', user_dtls);

      if (user_dtls) {
        password = generatePassword(password);
        let update_password = await userModel.update_forgot_password_status(
          otp,
          password
        );

        // let clear_otp_user = await userModel.clear_forgot_otp_user(otp);

        let findDynamicNotification =
          await notificationModel.findDynamicNotification('password_changed');

        if (
          findDynamicNotification.length > 0 &&
          findDynamicNotification[0].notification_type == 1
        ) {
          /*  notificationMail({
            from: Config.webmasterMail, // sender address
            to: req.user.email, // list of receivers
            subject: findDynamicNotification[0].title, // Subject line
            html: findDynamicNotification[0].content // plain text body
          }); */
          notificationMail({
            from: Config.webmasterMail, // sender address
            to: user_dtls.email, // list of receivers
            subject: findDynamicNotification[0].title, // Subject line
            html: findDynamicNotification[0].content // plain text body
          });
        }
        res
          .status(200)
          .json({
            status: 1,
            message: 'Password created successfully'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Invalid OTP'
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

  update_user_detail: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      let user_type = req.user.user_type;
      // console.log('user_type--->', user_type);
      // return false;
      // let user_id = req.params.user_id;
      // console.log('User detail-->', req.user);
      // return false;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');

      const {
        company_name,
        name,
        location,
        email,
        mobile,
        gstin,
        cin,
        profile,
        linkedin,
        facebook,
        whatsapp,
        skype,
        vendor_approve,
        nature_of_business,
        type_of_business,
        turnover,
        no_of_employess,
        certifications,
        address,
        import_export_code,
        country,
        state,
        city
      } = req.body;

      /*  let companyVendorObj = {
        company_name,
        nature_of_business,
        type_of_business,
        turnover,
        no_of_employess,
        certifications,
        import_export_code
      };

      let cmpVendorObj = Object.fromEntries(
        Object.entries(companyVendorObj).filter(
          ([key, value]) => value !== undefined
        )
      ); */

      let companyObj = {
        company_name,
        location,
        // email,
        mobile,
        gstin,
        cin,
        profile,
        nature_of_business,
        type_of_business,
        turnover,
        no_of_employess,
        certifications,
        import_export_code
      };

      let cmpObj = Object.fromEntries(
        Object.entries(companyObj).filter(([key, value]) => value !== undefined)
      );
      let organization_name = company_name;
      let userObj = {
        organization_name,
        linkedin,
        facebook,
        whatsapp,
        skype,
        name,
        address,
        mobile,
        country,
        state,
        city
      };

      let usrObj = Object.fromEntries(
        Object.entries(userObj).filter(([key, value]) => value !== undefined)
      );

      let user = await userModel.userDetailUpdate(usrObj, user_id);
      let company = '';
      let companyVendor = '';
      let companyDetail = await userModel.getCompanyDetail(user_id);

      if (Object.keys(companyDetail).length < 1) {
        company = await userModel.companyProfileCreate(cmpObj, user_id);
        /* companyVendor = await userModel.companyProfileVendorCreate(
          cmpVendorObj,
          user_id
        ); */
      } else {
        company = await userModel.companyProfileUpdate(cmpObj, user_id);
        /* companyVendor = await userModel.companyProfileVendorUpdate(
          cmpVendorObj,
          user_id
        ); */
      }
      let vendorObj = {
        vendor_approve,
        user_id
      };

      let vndObj = Object.fromEntries(
        Object.entries(vendorObj).filter(([key, value]) => value !== undefined)
      );
      // console.log('vndObj-->', vndObj);
      // return false;
      if (vendor_approve && vendor_approve.length > 0) {
        let vendorApproveDetail = await userModel.getVendorApproveDetail(
          user_id
        );
        //console.log('vendorApproveDetail-->', vendorApproveDetail);
        // return false;
        if (vendorApproveDetail.length > 0) {
          await userModel.deleteVendorApproveDetail(user_id);
        }

        vendor_approve.forEach((item) => {
          let vendorApproveMap = userModel.vendorApproveUserMap(user_id, item);
        });
      }
      // return false;
      /* let vendorApproveUserMap = await userModel.vendorApproveUserMap(
        cmpObj,
        user_id
      ); */

      // console.log('user--', user);
      // return false;
      res
        .status(200)
        .json({
          status: 1,
          message: 'Profile updated successfully'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  update_profile_image: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      // let { password } = req.body;
      let filename = req.file.filename;
      let original_filename = req.file.originalname;

      if (user_id && user_id != '') {
        // password = generatePassword(password);
        let update_password = await userModel.update_profile_image(
          user_id,
          `${Config.download_url}/user_image/${filename}`,
          original_filename
        );

        res
          .status(200)
          .json({
            status: 1,
            message: 'Profile image updated successfully'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User Not exists'
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
  get_profile: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      const user = await userModel.userinfo(user_id);
      if (user) {
        user.password = null;
        if (user.new_profile_image == '') {
          user.profile_image = '';
        } else {
          user.profile_image = `${user.new_profile_image}`;
        }
        const userapprovedbyvendor = await userModel.userapprovedbyvendor(
          user_id
        );
        console.log('userapprovedbyvendor-->', userapprovedbyvendor);
        const b = [];
        let vendor_arr = userapprovedbyvendor.map((ele) => ele.id);

        // return false;
        user.vendor_approve = vendor_arr;
        // console.log('user-->', user);
        // return false;
        res
          .status(200)
          .json({
            status: 1,
            data: user
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User not exist'
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
  get_profile_documents: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      // const user = await userModel.userinfo(user_id);
      const user = await userModel.userFileinfo(user_id);
      if (user) {
        // console.log('user-->', user);
        // return false;
        res
          .status(200)
          .json({
            status: 1,
            data: user
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User not exist'
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
  change_password: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      let { password } = req.body;
      // console.log('user_id--->', user_id);
      // return false;

      // const userDetail = await userModel.user_detail_otp_exists(otp);
      // let user_dtls = Object.assign({}, ...userDetail);
      // console.log('user_dtls-->', user_dtls);

      if (user_id && user_id != '') {
        password = generatePassword(password);
        let update_password = await userModel.update_change_password_status(
          user_id,
          password
        );

        res
          .status(200)
          .json({
            status: 1,
            message: 'Password changed successfully'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Invalid Password'
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
  social_login: async (req, res, next) => {
    try {
      let resJson = {};
      let error = 0;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { login_type, access_token } = req.body;
      let id = '';
      let email = '';
      const apiUrl =
        'https://www.googleapis.com/oauth2/v1/userinfo?access_token=' +
        access_token;

      axios
        .get(apiUrl, {
          headers: {
            'Content-Type': 'application/json'
            // Add any other headers if required
          }
        })
        .then(async (response) => {
          console.log('response--->', response.data.email);
          // return false;
          id = response.data.id;
          email = response.data.email;
          // let user_details = await userModel.social_login_exist(id);
          let user_details = await userModel.user_email_exist(email);
          // console.log('user_details123--->', user_details);
          //  return false;
          if (user_details.length > 0) {
            // console.log('Case 1');
            let oldDevice = user_details[0].user_agent
              ? req.get('User-Agent') == user_details[0].user_agent
              : true;
            let conform = req.query?.conform;
            if (!oldDevice && conform == 'true') {
              await userModel.updateAgent(
                req.get('User-Agent'),
                user_details[0].id
              );
              let findDynamicNotification =
                await notificationModel.findDynamicNotification(
                  'another_user_try_to_login'
                );
              if (
                findDynamicNotification.length > 0 &&
                findDynamicNotification[0].notification_type == 1
              ) {
                notificationMail({
                  from: Config.webmasterMail, // sender address
                  to: user_details[0].email, // list of receivers
                  subject: findDynamicNotification[0].title, // Subject line
                  html: findDynamicNotification[0].content // plain text body
                });
              }
            } else if (!oldDevice && conform == 'false') {
              error++;
              resJson = { status: 4, message: 'You log in with other device' };
            } else if (!conform) {
              error++;
              resJson = { status: 2, message: 'Invalid user' };
            }
            // console.log('conform', conform);
            if (error == 0) {
              const userData = {
                user_id: cryptr.encrypt(user_details[0].id),
                name: user_details[0].name,
                user_agent: cryptr.encrypt(req.get('User-Agent')),
                sessions: ''
              };
              let user_detail = await userModel.user_profile_social_login(
                user_details[0].id
              );
              const sessionId = Math.random().toString(36).substring(7);
              // userData.sessions = sessionId;
              // await userModel.update_session(user_detail.id, sessionId);
              const token = jwtHelper.signAccessTokenUser(userData);

              let logObj = {
                user_id: user_details[0].id,
                user_type: user_details[0].user_type,
                user_agent: req.get('User-Agent')
              };
              await userModel.insertLoginLog(logObj);
              await userModel.updateAgent(
                req.get('User-Agent'),
                user_details[0].id
              );

              let findDynamicNotification =
                await notificationModel.findDynamicNotification('login');
              if (
                findDynamicNotification.length > 0 &&
                findDynamicNotification[0].notification_type == 1
              ) {
                notificationMail({
                  from: Config.webmasterMail, // sender address
                  to: user_details[0].email, // list of receivers
                  subject: findDynamicNotification[0].title, // Subject line
                  html: findDynamicNotification[0].content // plain text body
                });
              }
              res
                .status(200)
                .json({
                  status: 1,
                  token,
                  profile: user_detail,
                  message: 'Login success'
                })
                .end();
            } else {
              res.status(400).json(resJson).end();
            }
          } else {
            // console.log('Case 2');
            let userObj = {
              name: response.data.name,
              email: response.data.email,
              social_login_id: id,
              login_type: login_type,
              filename: response.data.picture,
              user_agent: cryptr.encrypt(req.get('User-Agent'))
            };
            let user_id = await userModel.create_social_users(userObj);
            const userData = {
              user_id: cryptr.encrypt(user_id[0].id),
              name: response.data.name,
              user_agent: cryptr.encrypt(req.get('User-Agent')),
              sessions: ''
            };
            let user_detail = await userModel.user_profile_social_login(
              user_id[0].id
            );

            const sessionId = Math.random().toString(36).substring(7);
            const token = jwtHelper.signAccessTokenUser(userData);
            res
              .status(200)
              .json({
                status: 1,
                token,
                profile: user_detail,
                message: 'Login success'
              })
              .end();
          }
        })
        .catch((error) => {
          console.log('catch block--->');
          // Handle errors
          console.error('Error fetching data:', error);
          res
            .status(400)
            .json({
              status: 3,
              message: 'User not exist'
            })
            .end();
        });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  user_login_otp_send: async (req, res, next) => {
    try {
      const { mobile } = req.body;
      let seq = generateOTPRandomNo();
      let data = new FormData();
      data.append('workingkey', process.env.OTP_WORKINGKEY);
      data.append('sender', process.env.OTP_SENDER);
      data.append('to', mobile);
      data.append(
        'message',
        `Dear customer, Your OTP to login ${seq}. Please do not share OTP. It is valid up to 30min - Regards, MPJ JEWELLERS Team.`
      );

      let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: process.env.OTP_URL,

        data: data
      };

      axios.request(config).then((response) => {
        console.log(JSON.stringify(response.data));
      });

      let user_detail = await userModel.getUserDetailByMobile(mobile);
      let otp_update = await userModel.update_user_otp(seq, user_detail[0].id);

      res
        .status(200)
        .json({
          status: 1,
          message: 'OTP send'
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

  user_detail_by_id: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      const userDetail = await userModel.user_id_exists(user_id);
      if (userDetail && userDetail.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            data: userDetail
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User detail not exist'
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
  vendorapprove_list: async (req, res, next) => {
    try {
      // var user_id = req.user.id;
      const vendorApproveList = await userModel.get_vendorapprove_list();
      if (vendorApproveList && vendorApproveList.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            data: vendorApproveList
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User detail not exist'
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
  upload_documents: async (req, res, next) => {
    console.log('FILES======', req.files.file);
    try {
      var user_id = req.user.id;
      let { doc_type } = req.body;
      if (!doc_type) {
        doc_type = 'general';
      }
      if (req.files) {
        const result = await userModel.uploadFiles(
          req.files.file,
          user_id,
          doc_type
        );

        res
          .status(200)
          .json({
            status: 1,
            data: result
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: 'Please select a file!'
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
  vendor_profile: async (req, res, next) => {
    try {
      // let user_id = req.user.id;
      let user_id = req.params.vendor_id;
      const user = await userModel.vendorinfo(req.user.id, user_id);

      if (user) {
        res
          .status(200)
          .json({
            status: 1,
            data: user
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User not exist'
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

  buyerSubscriptionDetails: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { coupon_code, sub_id } = req.body;
      let today = dateFormat(new Date(), 'yyyy-mm-dd');
      let subscriptionList =
        await subscriptionModel.getBuyerSubscriptionDetails(today, sub_id);
      let couponDetails = await couponModel.checkCouponCodeExists(
        coupon_code,
        today
      );
      // console.log('couponDetails===>>>>>>>>>>>>>>', couponDetails);
      for await (let [
        index,
        availableSubscription
      ] of subscriptionList.entries()) {
        let newSubscriptionPrice = availableSubscription.price;
        let offerDiscountedPrice = 0;
        let newCouponDiscountedPrice = 0;
        let couponDiscountedPrice = 0;
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

        if (couponDetails.length > 0 && couponDetails[0].is_percentage) {
          couponDiscountedPrice =
            newSubscriptionPrice * couponDetails[0].discount_amount;
          if (parseFloat(newSubscriptionPrice) < couponDiscountedPrice) {
            err++;
            errors.coupon_code = 'Invalid coupon code';
          } else {
            newCouponDiscountedPrice = Math.round(
              newSubscriptionPrice - couponDiscountedPrice
            );
          }
        } else if (
          couponDetails.length > 0 &&
          !couponDetails[0].is_percentage
        ) {
          couponDiscountedPrice = couponDetails[0].discount_amount;
          if (
            parseFloat(newSubscriptionPrice) < parseFloat(couponDiscountedPrice)
          ) {
            err++;
            errors.coupon_code = 'Invalid coupon code';
          } else {
            newCouponDiscountedPrice = Math.round(
              newSubscriptionPrice - couponDiscountedPrice
            );
          }
        }

        subscriptionList[index].discount_price = newSubscriptionPrice;
        subscriptionList[index].coupon_discount_price =
          newCouponDiscountedPrice;
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
        res
          .status(200)
          .json({
            status: 1,
            data: subscriptionList
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

  buyerSubscriptionPayment: async (req, res, next) => {
    try {
      let { sub_id, coupon_code } = req.body;
      let subscriptionDetails =
        await subscriptionModel.buyerSubscriptionIdExist(sub_id);
      let offer = [];
      let checkOffers = await subscriptionModel.subscriptionOfferExist(sub_id);
      if (checkOffers.length > 0) {
        let today = dateFormat(new Date(), 'yyyy-mm-dd');
        offer = await subscriptionModel.getOfferDetails(
          checkOffers[0].offer_id,
          today
        );
      }

      // console.log('offer===>>>>', offer);

      const startDate = Moment(); // Replace with the actual start date

      const billingCycleMonths = subscriptionDetails[0].duration;

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
        user_id: req.user.id,
        plan_id: sub_id,
        status: 4, // payment pending
        start_date: startDate.format('YYYY-MM-DD'),
        end_date: endDate.format('YYYY-MM-DD'),
        renew_date: renewDate.format('YYYY-MM-DD')
      };

      let createUserSubscription =
        await subscriptionModel.createUserSubscription(UserSubscriptionObj);

      // offer calculation
      let newSubscriptionPrice = subscriptionDetails[0].price;
      let offerDiscountedPrice = 0;
      if (offer.length > 0 && offer[0].is_percentage) {
        offerDiscountedPrice = newSubscriptionPrice * (offer[0].price / 100);
        newSubscriptionPrice = Math.round(
          newSubscriptionPrice - offerDiscountedPrice
        );
      } else if (offer.length > 0 && !offer[0].is_percentage) {
        offerDiscountedPrice = offer[0].price;
        newSubscriptionPrice = Math.round(
          newSubscriptionPrice - offerDiscountedPrice
        );
      }

      //coupon discount calculation
      let couponDiscountedPrice = 0;
      if (coupon_code) {
        let today = dateFormat(new Date(), 'yyyy-mm-dd');
        let couponDetails = await couponModel.checkCouponCodeExists(
          coupon_code,
          today
        );
        if (couponDetails.length > 0 && couponDetails[0].is_percentage) {
          couponDiscountedPrice =
            newSubscriptionPrice * couponDetails[0].discount_amount;
          newSubscriptionPrice = Math.round(
            newSubscriptionPrice - couponDiscountedPrice
          );
        } else if (
          couponDetails.length > 0 &&
          !couponDetails[0].is_percentage
        ) {
          couponDiscountedPrice = couponDetails[0].discount_amount;
          newSubscriptionPrice = Math.round(
            newSubscriptionPrice - couponDiscountedPrice
          );
        }
      }

      let digit = convertSixDigit(createUserSubscription.id);
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });
      const options = {
        amount: newSubscriptionPrice * 100,
        currency: 'INR',
        receipt: `PAY${digit}`,
        payment_capture: 1
      };
      // console.log('options==>>>>', options);
      let response = await razorpay.orders.create(options);
      // console.log('subscriptionDetails==>>>', subscriptionDetails);

      let subscriptionPaymentObj = {
        user_id: req.user.id,
        user_subscriptions_id: createUserSubscription.id,
        status: 0, // not paid by default
        amount: newSubscriptionPrice, // after offer and appy coupon price
        before_payment_response: response,
        order_id: response.id,
        receipt: `PAY${digit}`,
        subscription_charge: subscriptionDetails[0].price,
        offer_price: offerDiscountedPrice,
        coupon_price: couponDiscountedPrice
      };
      await subscriptionModel.createSubscriptionPayment(subscriptionPaymentObj);

      res
        .status(200)
        .json({
          status: 1,
          data: response.id
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
  razorpay_webhook: async (req, res) => {
    try {
      // console.log(req);

      const requestedBody = JSON.stringify(req.body);
      console.error(
        'requestedBody---',
        requestedBody,
        req.body.payload?.payment?.entity?.order_id,
        req.body.event
      );
      const receivedSignature = req.headers['x-razorpay-signature'];

      let valid = Razorpay.validateWebhookSignature(
        JSON.stringify(req.body),
        receivedSignature,
        Config.razorpay.razorpay_signature
      );
      console.error(valid);
      if (valid && req.body.event == 'order.paid') {
        let paymentEntity = req.body.payload.payment.entity;
        let orderEntity = req.body.payload.order.entity;
        let subscriptionPaymentObj = {
          status: 1,
          after_payment_response: requestedBody,
          payment_id: paymentEntity.id,
          method: paymentEntity.method,
          order_id: paymentEntity.order_id,
          receipt: orderEntity.receipt,
          date: Moment().format('YYYY-MM-DD')
        };
        console.log(
          'subscriptionPaymentObj ==>>>>>>>>>',
          subscriptionPaymentObj
        );
        let paymentUpdate = await subscriptionModel.updateSubscriptionPayment(
          subscriptionPaymentObj
        );
        console.log('paymentUpdate==>>>>>>>>>>', paymentUpdate);
        if (paymentUpdate.length > 0) {
          let userSubscription = await subscriptionModel.updateUserSubscription(
            paymentUpdate[0].user_subscriptions_id,
            paymentUpdate[0].user_id
          );
          // console.log(
          //   '🚀 ~ razorpay_webhook: ~ userSubscription:',
          //   userSubscription
          // );
          await subscriptionModel.updateUserSubscriptionId(
            userSubscription[0].plan_id,
            paymentUpdate[0].user_id
          );

          let userDetails = await userModel.userinfo(paymentUpdate[0].user_id);
          let planDetails = await subscriptionModel.getSubscriptionDetails(
            userSubscription[0].plan_id
          );
          let subscriptionMappingDetails =
            await subscriptionModel.getSubscriptionMappingDetails(
              userSubscription[0].plan_id
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
              user_subscriptions_id: paymentUpdate[0].user_subscriptions_id,
              feature_id: feature_id,
              plan_id: userSubscription[0].plan_id,
              used_feature_count: 0,
              allocated_feature: allocated_feature,
              user_id: paymentUpdate[0].user_id
            };
            // console.log(
            //   '🚀 ~ razorpay_webhook: ~ userSubscriptionFeatureObj:',
            //   userSubscriptionFeatureObj
            // );
            await subscriptionModel.createUserSubscriptionFeature(
              userSubscriptionFeatureObj
            );
          }
          //generate invoice

          // console.log(
          //   'paymentUpdate[0].offer_price',
          //   typeof paymentUpdate[0].offer_price,
          //   typeof paymentUpdate[0].coupon_price
          // );

          let totalDiscount = Math.round(
            parseFloat(paymentUpdate[0].offer_price) +
              parseFloat(paymentUpdate[0].coupon_price)
          );
          console.log(
            'totalDiscount====>>>>>>>>>>>>>',
            totalDiscount,
            totalDiscount > 0 ? 'abbbbceeee' : 'elseeeeeee'
          );

          let htmlPdf = `<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="table-layout: fixed;border-collapse: collapse;border-spacing:0;font-family:Tahoma,Arial,sans-serif;color:#000000;margin: 0 auto 10px;width: 100%;min-width:615px;max-width:615px;background-color: #ffffff;padding: 0;font-size: 12px;">
  <tbody>
    <tr>
      <td style="padding:0;font-size: 18px;font-weight: bold; font-family:Tahoma,Arial,sans-serif;color:#000000;"> Invoice <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tbody>
            <tr>
              <td style="padding: 10px 0 5px; font-weight: bold;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Invoice number</td>
              <td style="padding: 10px 0 5px; font-weight: bold;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${
                orderEntity.receipt
              }</td>
            </tr>
            <tr>
              <td style="font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Date of issue</td>
              <td style="font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${dateFormat(
                userSubscription[0].start_date,
                'yyyy-mm-dd'
              )}</td>
            </tr>
            <tr>
              <td style="font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Date due</td>
              <td style="font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${dateFormat(
                userSubscription[0].end_date,
                'yyyy-mm-dd'
              )}</td>
            </tr>
          </tbody>
        </table>
      </td>
      <td>&nbsp;</td>
      <td width="100px">
        <img src="openai-logo.png" style="width: 80px;max-width: 100%;margin0;" />
      </td>
    </tr>
  </tbody>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="table-layout: fixed;border-collapse: collapse;border-spacing:0;font-family:Tahoma,Arial,sans-serif;color:#000000;margin: 0 auto 10px;width: 100%;min-width:615px;max-width:615px;background-color: #ffffff;padding: 0;font-size: 12px;">
  <tbody>
    <tr>
      <td style="padding:10px 0 0;font-size: 14px;font-weight: bold; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;"> Work Wise <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tbody>
            <tr>
              <td style="padding: 10px 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">548 Suite 804, 8th Floor,</td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Martin Burn Business Park,</td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">San Block , BP 3 Sector V,</td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Salt Lake , Kolkata- 700091</td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">
                <a style="text-decoration: none;color: #000000;" href="mailto:ar@openai.com">support@workwise.com</a>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">IN GST 19AABCD1743K1ZM</td>
            </tr>
          </tbody>
        </table>
      </td>
      <td style="padding:10px 0 0;font-size: 14px;font-weight: bold; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;"> Bill to <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tbody>
            ${
              userDetails.company_name
                ? `<tr>
              <td style="padding: 10px 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.company_name}</td>
            </tr>`
                : ''
            }
            ${
              userDetails.name
                ? `<tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.name}</td>
            </tr>`
                : ''
            }
            ${
              userDetails.address
                ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.address}</td>
          </tr>`
                : ''
            }
            ${
              userDetails.city_name
                ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.city_name}</td>
          </tr>`
                : ''
            }
            ${
              userDetails.state_name
                ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.state_name}</td>
          </tr>`
                : ''
            }            
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">India</td>
            </tr>
            ${
              userDetails.email
                ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">
              <a style="text-decoration: none;color: #000000;" href="mailto:${userDetails.email}">${userDetails.email}</a>
            </td>
          </tr>`
                : ''
            }
          ${
            userDetails.gstin
              ? `<tr>
          <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">IN GST ${userDetails.gstin}</td>
        </tr>`
              : ''
          }
            
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="table-layout: fixed;border-collapse: collapse;border-spacing:0;font-family:Tahoma,Arial,sans-serif;color:#000000;margin: 0 auto 10px;width: 100%;min-width:615px;max-width:615px;background-color: #ffffff;padding: 0;font-size: 12px;">
  <tr>
    <td>
      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
        <thead>
          <tr>
            <th style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: left;width: 355px;">Description</th>
            <th style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: center;width: 20px;">Qty</th>
            <th style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: center;width: 140px;">Unit price</th>
            <th style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: right;width: 140px;">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #979797;">${
              planDetails[0].plan_name
            } </td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal;text-align: center; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #979797;">1</td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: center;border-top: 1px solid #979797;">₹ ${
              paymentUpdate[0].subscription_charge
            }</td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: right;border-top: 1px solid #979797;">₹ ${
              paymentUpdate[0].subscription_charge
            }</td>
          </tr>
        </tbody>
      </table>
    </td>
  </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="table-layout: fixed;border-collapse: collapse;border-spacing:0;font-family:Tahoma,Arial,sans-serif;color:#000000;margin: 0 auto 10px;width: 100%;min-width:615px;max-width:615px;background-color: #ffffff;padding:0;font-size: 12px;">
  <tr>
    <td style="width:250px;padding-top: 20px">&nbsp;</td>
    <td style="width:365px;padding-top: 20px">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
        <tbody>
        ${
          totalDiscount > 0
            ? `<tr>
              <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #d3d3d3;">
                Discount
              </td>
              <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #d3d3d3;text-align: right;">
                ₹ ${totalDiscount}
              </td>
            </tr>`
            : ''
        }
          <tr>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #d3d3d3;">Total</td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #d3d3d3;text-align: right;">₹ ${
              paymentUpdate[0].amount
            }</td>
          </tr>
        </tbody>
      </table>
    </td>
  </tr>
</table>`;

          const browser = await puppeteer.launch({
            headless: 'new'
          });
          const page = await browser.newPage();
          let pdfOptions = { format: 'A4' };
          const outputPath = `${Config.upload.invoice_file}/invoice-${orderEntity.receipt}.pdf`;
          console.log('outputPath ===>> ', outputPath);
          await page.setContent(htmlPdf);
          await page.pdf({
            path: outputPath,
            pdfOptions,
            printBackground: true
          });

          await browser.close();

          await subscriptionModel.updateInvoice(
            `invoice-${orderEntity.receipt}.pdf`,
            paymentUpdate[0].id
          );

          let html_variables = [
            {
              name: userDetails.name
            },
            {
              message: `Your ${planDetails[0].plan_name} Plan is activated.See your invoice 
              ${Config.download_url}/invoice_file/invoice-${orderEntity.receipt}.pdf`
            }
          ];
          let dynamic_html = fs
            .readFileSync(
              `${Config.template_path}/dynamic_message_template.txt`
            )
            .toString();

          for (let index = 0; index < html_variables.length; index++) {
            const element = html_variables[index];
            let dynamic_key = Object.keys(element)[0];
            let replace_char = html_variables[index][dynamic_key];
            let replace_var = `[${dynamic_key.toLowerCase()}]`;

            dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
          }

          sendMail({
            from: Config.webmasterMail, // sender address
            to: userDetails.email, // list of receivers
            subject: `Work wise | Subscription Plan`, // Subject line
            html: dynamic_html // plain text body
          });

          let findDynamicNotification =
            await notificationModel.findDynamicNotification(
              user_successfully_subscribed_a_plan
            );

          if (
            findDynamicNotification.length > 0 &&
            findDynamicNotification[0].notification_type == 1
          ) {
            notificationMail({
              from: Config.webmasterMail, // sender address
              to: userDetails.email, // list of receivers
              subject: findDynamicNotification[0].title, // Subject line
              html: findDynamicNotification[0].content // plain text body
            });
          }
        }
      }

      res
        .status(200)
        .json({
          status: 1
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
  notificationList: async (req, res, next) => {
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
      var user_id = req.user.id;
      const notificationList = await notificationModel.getNotificationList(
        user_id,
        limit,
        offset
      );
      if (notificationList && notificationList.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            data: notificationList
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Notification not exist'
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
  notificationDetail: async (req, res, next) => {
    try {
      // let user_id = req.user.id;
      let notification_id = req.params.notification_id;
      const notificationDetail = await notificationModel.notificationDetail(
        notification_id
      );

      if (notificationDetail) {
        res
          .status(200)
          .json({
            status: 1,
            data: notificationDetail
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'User not exist'
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
  readNotification: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      let notification_id = req.params.notification_id;

      let notification = await notificationModel.statusUpdateNotification(
        notification_id
      );
      if (notification) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Notification status read updated'
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  createVendorReview: async (req, res, next) => {
    try {
      let user_id = req.user.id;
      const { reviewed_to, rating, description } = req.body;
      let reviewObj = {
        reviewed_by: user_id,
        reviewed_to,
        rating,
        description
      };
      // let checkReviewExists = await notificationModel.checkReviewExists(
      //   user_id,
      //   reviewed_to
      // );

      let review = await notificationModel.addVendorReview(reviewObj);
      // if (checkReviewExists.length > 0) {
      //   await notificationModel.updateVendorReview(
      //     reviewObj,
      //     checkReviewExists[0].id
      //   );
      //   review = checkReviewExists[0].id;
      // } else {
      //   review = await notificationModel.addVendorReview(reviewObj);
      // }
      if (review) {
        let findDynamicNotification =
          await notificationModel.findDynamicNotification(
            'vendor_profile_review'
          );

        if (
          findDynamicNotification.length > 0 &&
          findDynamicNotification[0].notification_type == 1
        ) {
          notificationMail({
            from: Config.webmasterMail, // sender address
            to: req.user.email, // list of receivers
            subject: findDynamicNotification[0].title, // Subject line
            html: findDynamicNotification[0].content // plain text body
          });
        }
        res
          .status(200)
          .json({
            status: true,

            message: 'Review added successfully'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  vendorreview_list: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      const vendorReviewList = await userModel.get_vendorreview_list(
        user_id,
        limit,
        offset
      );
      if (vendorReviewList && vendorReviewList.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            data: vendorReviewList
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Review not exist'
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
  communicationSettings: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      const { email, sms, type_id } = req.body;

      const rsp = await userModel.setCommunicationSettings(
        user_id,
        email,
        sms,
        type_id
      );

      res
        .status(200)
        .json({
          status: 1,
          data: rsp
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
  communicationSettingsList: async (req, res, next) => {
    try {
      const rsp = await userModel.communicationSettingsListCTRL();

      res
        .status(200)
        .json({
          status: 1,
          data: rsp
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
  getCommunicationSettings: async (req, res, next) => {
    try {
      var user_id = req.user.id;
      const rsp = await userModel.getCommunicationSettings(user_id);

      res
        .status(200)
        .json({
          status: 1,
          data: rsp
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
  vendorDashboardData: async (req, res, next) => {
    try {
      let dashboardData = {};
      let totalOrders = await rfqModel.getAllVendorRfq(req.user.id);
      dashboardData.totalOrders = totalOrders.count;
      let pendingOrders = await rfqModel.getPendingOrders(req.user.id);
      dashboardData.pendingOrders = pendingOrders.count;
      res
        .status(200)
        .json({
          status: 1,
          data: dashboardData
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
  getDashboardData: async (req, res, next) => {
    let data = {};
    try {
      if (req.user.user_type == 2) {
        // Buyer
        let active_rfqs = await rfqModel.getAllRfqByUser(req.user.id, 1);
        data.active_rfqs = parseInt(active_rfqs.count);
        let completed_rfqs = await rfqModel.getAllRfqByUser(req.user.id, 2);
        data.completed_rfqs = parseInt(completed_rfqs.count);
        let pending_responses = await rfqModel.getPendingResponseCount(
          req.user.id,
          1
        );
        data.pending_responses =
          parseInt(active_rfqs.count) - parseInt(pending_responses.count);
        data.quote_received = parseInt(pending_responses.count);
        let rfq_data_for_notificaton = await rfqModel.getAllBuyerRfq(
          5,
          0,
          req.user.id
        );

        let temp_rfqs = rfq_data_for_notificaton.map((item) => {
          delete item.products;
          delete item.id;
          delete item.comment;
          delete item.response_email;
          delete item.contact_name;
          delete item.contact_number;
          delete item.bid_end_date;
          delete item.location;
          delete item.is_published;
          delete item.created_by;
          delete item.updated_by;
          delete item.status;
          delete item.quotes;
          delete item.vendors;
          item.notification_type = 'rfq_created';
          return item;
        });

        let recente_received_quotes = await rfqModel.getRecentQuotes(
          req.user.id
        );
        recente_received_quotes = recente_received_quotes.filter(
          (item) => item.timestamp != null && item.created_by != null
        );

        let temp_received_quotes = recente_received_quotes
          .slice(0, 5)
          .map((item) => {
            item.notification_type = 'new_quote_received';
            return item;
          });

        let notificaiton_data = [...temp_rfqs, ...temp_received_quotes];
        notificaiton_data.sort((a, b) => {
          const formatTimestamp = (timestamp) => {
            // Check if the timestamp is a string with hyphens (indicating a datetime format)
            if (typeof timestamp === 'string' && timestamp.includes('-')) {
              return Moment(timestamp, 'YYYY-MM-DD HH:mm:ss.SSSSSS').valueOf();
            }
            // Otherwise, assume it's a Unix timestamp in milliseconds
            return parseInt(timestamp, 10);
          };

          const timeA = formatTimestamp(a.timestamp);
          const timeB = formatTimestamp(b.timestamp);

          return timeB - timeA;
        });

        let readable_notification_date_data = notificaiton_data.map((item) => {
          const timestamp = item.timestamp;
          let readableDateTime;

          if (typeof timestamp === 'string' && timestamp.includes('-')) {
            readableDateTime = Moment(
              timestamp,
              'YYYY-MM-DD HH:mm:ss.SSSSSS'
            ).format('YYYY-MM-DD HH:mm:ss');
          } else {
            readableDateTime = Moment(parseInt(timestamp, 10)).format(
              'YYYY-MM-DD HH:mm:ss'
            );
          }

          return {
            ...item,
            readable_date_time: readableDateTime
          };
        });

        data.notificaiton_data = readable_notification_date_data;
        let rfq_data = await rfqModel.getAllBuyerRfq(1000000, 0, req.user.id);
        data.rfq_data = rfq_data;

        let cost = await rfqModel.getAllRfqCost(req.user.id, 2);
        data.savings = parseInt(cost.total_price_formatted * 0.05);
      } else if (req.user.user_type == 3) {
        // Vendor

        let totalOrders = await rfqModel.getAllVendorRfq(req.user.id);
        data.total_rfq_received = parseInt(totalOrders.length);
        let pendingOrders = await rfqModel.getPendingOrders(req.user.id);
        data.quotes_sent = parseInt(pendingOrders.count);
        let closedRFQs = await rfqModel.getClosedRfqs(req.user.id);
        data.closed_rfqs = closedRFQs.length;

        let totalProducts = await rfqModel.getAllProducts(req.user.id);
        data.totalProducts = totalProducts.length;
        let tempFiveProducts = totalProducts.slice(0, 5);
        let temp_products = tempFiveProducts.map((item) => {
          let productObj = {};
          productObj.notification_type = 'add_product';
          productObj.product_id = item.id;
          productObj.product_name = item.name;
          productObj.timestamp = item.created_at;
          productObj.is_review = item.is_review;
          productObj.is_approve = item.is_approve;
          return productObj;
        });
        let totalReviewedProducts = await rfqModel.getAllReviewedProducts(
          req.user.id
        );
        data.totalReviewedProducts = totalReviewedProducts.length;
        let totalPendingProducts = await rfqModel.getAllPendingProducts(
          req.user.id
        );
        data.totalPendingProducts = totalPendingProducts.length;
        let vendor_reviews = await rfqModel.getVendorReviews(req.user.id);
        data.vendor_reviews = vendor_reviews;

        const listRfq = await rfqModel.getRfqByUser(5, 0, req.user.id);
        let temp_rfqs = listRfq.map((item) => {
          delete item.products;
          delete item.id;
          delete item.comment;
          delete item.response_email;
          delete item.contact_name;
          delete item.contact_number;
          delete item.bid_end_date;
          delete item.location;
          delete item.is_published;
          delete item.created_by;
          delete item.updated_by;
          delete item.status;
          item.notification_type = 'new_rfq_received';
          return item;
        });

        const quotes_submitted = await rfqModel.getSubmittedQuotes(
          5,
          req.user.id
        );
        let temp_quotes_submitted = quotes_submitted.map((item) => {
          item.notification_type = 'quote_submitted';
          return item;
        });
        let notificaiton_data = [
          ...temp_rfqs,
          ...temp_quotes_submitted,
          ...temp_products
        ];

        notificaiton_data.sort((a, b) => {
          const formatTimestamp = (timestamp) => {
            // Check if the timestamp is a string with hyphens (indicating a datetime format)
            if (typeof timestamp === 'string' && timestamp.includes('-')) {
              return Moment(timestamp, 'YYYY-MM-DD HH:mm:ss.SSSSSS').valueOf();
            }
            // Otherwise, assume it's a Unix timestamp in milliseconds
            return parseInt(timestamp, 10);
          };

          const timeA = formatTimestamp(a.timestamp);
          const timeB = formatTimestamp(b.timestamp);

          return timeB - timeA;
        });

        let readable_notification_date_data = notificaiton_data.map((item) => {
          const timestamp = item.timestamp;
          let readableDateTime;

          if (typeof timestamp === 'string' && timestamp.includes('-')) {
            readableDateTime = Moment(
              timestamp,
              'YYYY-MM-DD HH:mm:ss.SSSSSS'
            ).format('YYYY-MM-DD HH:mm:ss');
          } else {
            readableDateTime = Moment(parseInt(timestamp, 10)).format(
              'YYYY-MM-DD HH:mm:ss'
            );
          }

          return {
            ...item,
            readable_date_time: readableDateTime
          };
        });

        data.latest_notifications = readable_notification_date_data;
      }
      res
        .status(200)
        .json({
          status: 1,
          data
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
export default UsersController;
