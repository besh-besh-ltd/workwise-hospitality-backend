import userModel from '../../models/userModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import notificationModel from '../../models/notificationModel.js';
import couponModel from '../../models/couponModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  generateOTPRandomNo,
  generateRandomString,
  sendMail,
  notificationMail,
  convertSixDigit,
  addDefaultNotifications,
  getDateRange
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
import JWT from 'jsonwebtoken';
import xlsx from 'xlsx';
//var FCM = new fcm(certPath);
import webpush from 'web-push';
import rfqModel from '../../models/rfqModel.js';
import vendorModel from '../../models/vendorModel.js';
import productModel from '../../models/productModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';
import whatsappNotificationAISensy from '../../helper/whatsappNotificationAISensy.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import { pgp } from '../../config/dbConn.js';


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

var global_subscription = '';


/**
this function will continue buyer company registration, 
save max account limit for buyer company, and send email to registered user email
 */
const continueBuyerCompanyRegistration = async (inputData, company_id)=>{

  const buyer_company_max_account_data = {
        max_top_management: parseInt(inputData.max_top_management) || 0,
        max_procurement: parseInt(inputData.max_procurement) || 0,
        max_engineering: parseInt(inputData.max_engineering) || 0,
        max_finance: parseInt(inputData.max_finance) || 0
      };

      const accountLimitSaved = await userModel.insertBuyerAccountLimits(buyer_company_max_account_data, company_id)


          const emailHeaderContent = `<h2>Hello ${inputData.name || ''},</h2>`
          const emailContainerContent = `
          <div style="font-size:16px; font-family: 'Roboto', sans-serif;"> 
           <p>Welcome to WorkWise! Your admin account has been created successfully. </p>
            <p style="margin-bottom:0px;"><strong>Login Details:</strong></p>
            <ul>
            <li> <strong> Email: </strong> ${inputData.email} </li>
            <li> <strong>Password: </strong> ${inputData.password} </li>
            </ul>
            <p>You can log in to your account using this link: <a href="https://letsworkwise.com/?user_registered=1" >Click Here</a></p>
            <p style="font-size: 14px; color: #777;"><em>For security reasons, we recommend changing your password after your first login.</em></p>    
          </div>`

        const dynamic_html = generateEmailTemplate(emailHeaderContent, emailContainerContent)
        
        const mailRecipients = {
          from: Config.webmasterMail,
          to: inputData.email,
          subject: `Welcome to WorkWise - Account Created`,
          html: dynamic_html
        };

        sendMail(mailRecipients);

        return accountLimitSaved
}


/**
 send email to vendor emaill,
 created this saprate function so that for vendor if we need to perform any operation saprately we can do here, currently only email is not of them
 */
const continueVendorCompanyRegistration = async (inputData, company_id)=>{
      const emailHeader = ` <h2>Dear ${inputData.organization_name || inputData.name } </h2>`
          
      const emailContent = `
           <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
             <p>Thank you for registering with us! Your login credentials are as follows:</p>
                <ul style="list-style-type: none; padding: 0;">
                 <li><strong>Email:</strong> ${inputData.email}</li>
                 <li><strong>Password:</strong> ${inputData.password}</li>
             </ul>
             <p>Your account is currently under review. We will notify you as soon as it is approved.</p>
             <p>Meanwhile, please save this email securely as it contains your login credentials.</p>
             <p>We appreciate your patience and look forward to having you on board!</p>
           </div>
            `
           const dunamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent)

          let mailRecipients = {
            from: Config.webmasterMail,
            subject: `Work Wise | Registration`,
            html: dunamicHtmlTemplate,
            to: inputData.email
        }

        sendMail(mailRecipients);
}



const add_vendor_product = async (productDetails, vendorId) => {
  try {
    let errors = {};
    let err = 0;

    let { name, categories, approved_id, master_id } = productDetails;

    if (categories.length > 0) {
      for await (const categoryId of categories) {
        let categoryExist = await productModel.parentIdExists(categoryId);
        if (categoryExist.length == 0) {
          err++;
          errors.categories = 'Category not found';
        }
      }
    } else {
      err++;
      errors.categories = 'Please select a category';
    }

    let prodNameExists = await productModel.checkVariantExistsForVendor(
      vendorId,
      master_id,
    );
    if (prodNameExists.length > 0) {
      err++;
      errors.name = 'Product is already mapped with vendor';
    }

    if (master_id) {
      let findProduct = await productModel.check_product(master_id);
      if (findProduct.length == 0) {
        err++;
        errors.master_id = 'Product not found';
      }
    }

    if (err > 0) {
      return errors
    }

  } catch (err) {
    logError(err);
    return err;
  }
}


const UsersController = {
  userBookDemo: async (req, res, next) => {
    try {
      const { mobile } = req.body;

      const bookDemoResult = userModel.user_book_demo(mobile);

      // send whatsapp message to user
      const payload = { name:" ", phone:mobile }
      const sendWhatsapp =  await whatsappNotificationAISensy.contactUsFormWhatsAppMessage(payload);

      //  send email to Admin 
      const emailHeader = ` <h5> Book A Call </h5> `
      const emailContainer = ` 
      <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
     <p> New Demo Request Received </p>
     <p> User Mobile No - ${mobile} </p>
       </div>
      `
      const dynamicEmailHtml = generateEmailTemplate(emailHeader, emailContainer)

      sendMail({
        from: Config.webmasterMail, // sender address
        to: "siddharth@letsworkwise.com", // list of receivers
        cc:"mukul@letsworkwise.com",
        subject: `Work wise | Book A Call - Request `, // Subject line
        html: dynamicEmailHtml // plain text body
      });


      res
        .status(200)
        .json({
          status: true,
          message: 'Call booked!'
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

  company_registration: async (req, res, next) => {
    try {
       const { name, email, mobile, organization_name, user_type, password, address, country, whatsapp, 
        state, city, postal_code, gstin, cin, profile, nature_of_business, type_of_business, turnover, no_of_employess, 
       import_export_code,established_year,website, is_private, status} = req.body;

       const current_user = req.user || null

      const user_data = {
        name: name || null,
        email: email?.toLowerCase() || null,
        mobile: mobile || null,
        user_type: user_type || null,
        status: status !== undefined ? status : (user_type == 7 ? 1 : 0),
        password: generatePassword(password), 
        address: address || null,
        created_by:current_user?.id || null,
        updated_by:current_user?.id || null,
        country: country || null,
        whatsapp: whatsapp || null,
        token: null,
        state: state || null,
        city: city || null,
        postal_code: postal_code || null
      };

      const company_data = {
        company_name: organization_name || null,
        profile: profile || null,
        nature_of_business: nature_of_business || null,
        type_of_business: type_of_business || null,
        turnover: turnover || null,
        no_of_employess: no_of_employess || null,
        import_export_code: import_export_code || null,
        gstin: gstin || null,
        cin: cin || null,
        logo:  req.file?.location || null, 
        established_year: established_year || null,
        website: website || null,
        location: address || null,
        is_private: is_private || 0,
       };

      //  Register company, this model register detail in both tables tbl_user and tbl_company
       const {company_id} = await userModel.company_registration(user_data, company_data)         
      // user_type 7 is for buyer company registration, 3 is for vendor registration
        if (user_type == 7 && company_id) {
           await  continueBuyerCompanyRegistration(req.body, company_id)
        }
       else if (user_type == 3 && company_id) {
           await  continueVendorCompanyRegistration(req.body, company_id)
        }

        res
          .status(200)
          .json({
            status: 1,
            message: `Registered ${ user_type == 3? "Vendor" : "Buyer" } successfully`,
            company_id: company_id,
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

  registerBuyerAnonymously: async (userData) => {
    try {
      const { name, companyName, email, mobile } = userData;

      if(!userData.password) {
        userData.password = generateRandomString(8);
      }

      const user_data = {
        name: name || null,
        email: email?.toLowerCase() || null,
        mobile: mobile || null,
        user_type: 7,
        status: 1,
        password: generatePassword(userData.password)
      };

      const company_data = {
        company_name: companyName || null,
        is_private: 0
      };

      const { company_id, user } = await userModel.company_registration(
        user_data,
        company_data
      );
      await continueBuyerCompanyRegistration(userData, company_id);

      return {
        ...user,
        password: userData.password
      };
    } catch (error) {
      throw error;
    }
  },


/**
 * mukul - 09-06-2025 created
 * - Update company details and location (for company admin only).
 * - Updates `tbl_company` with company info and Updates `tbl_users` with location info (assuming each spoc handel saprate office linked to SPOC user, main office we assume with admin only).
 * - Two separate queries used since it's an infrequent operation.
 * - Can be refactored later to separate location table if needed and for a more optmize controller logic.
 */
  update_company_detail: async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const user_id = req.user.id
    const reqData = req.body;

    const reqCompanyData = {
      company_name: reqData?.company_name?.trim(),
      profile: reqData?.about_company?.trim(),
      website: reqData?.website?.trim(),
      gstin: reqData?.gstin?.trim(),
      established_year: reqData?.established_year,
      nature_of_business: reqData?.nature_of_business,
      turnover: reqData?.turnover,
      no_of_employess: reqData?.no_of_employess,
      import_export_code: reqData?.import_export_code,
      cin: reqData?.cin,
    };

    //  this data stpred in tbl_user but belongs to company, we are storing it here because one comapny may have mulriple location and tehy always has one spoc for each location, ( if this is not work we move this to the tbl_ocmpany )
    const reqLocationData = {
      state: reqData?.state,
      city: reqData?.city,
      country: reqData?.country,
      address: reqData?.street_address?.trim(),
      postal_code:reqData?.postal_code,
      updated_at: new Date(), // this value  depends on server date and time
    }

    await rfqModel.updateWhere(
      "tbl_company",
      reqCompanyData,
      `id = ${company_id}`
    );

    await rfqModel.updateWhere(
      "tbl_users",
      reqLocationData,
      `id = ${user_id}`
    );

    return res.status(200).json({
      status: 1,
      message: "Company profile updated successfully",
    });
  } catch (err) {
    logError(err);
    return res.status(400).json({
      status: false,
      message: Config.errorText.value,
    });
  }
},

create_buyer_company_users: async (req, res, next) => {
  try {
    const { name, email, mobile, user_type, password } = req.body;
    const { company_id: companyID, id: loginUserID } = req.user;

    // Prepare user details
    const userDetails = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      mobile: mobile.trim(),
      user_type,
      status: 1,
      password: generatePassword(password),
      created_by: loginUserID,
      company_id: companyID
    };

    // Fetch company limits and current active user count concurrently
    const [companyLimits, activeUsers] = await Promise.all([
      rfqModel.checkIfExists("tbl_company_buyer_account_limit", `company_id = ${companyID}`),
      rfqModel.checkIfExists("tbl_users", `company_id = ${companyID} AND user_type = ${user_type} AND is_deleted = 0`)
    ]);

    if (!companyLimits.length) {
      return res.status(400).json({ status: false, message: "Company account limits not set." }).end();
    }

    const limits = companyLimits[0];
    const maxMap = {
      8: limits.max_top_management,
      2: limits.max_procurement,
      9: limits.max_engineering,
      10: limits.max_finance
    };
    const maxAllowed = maxMap[user_type];
    const currentCount = activeUsers.length;

    if (maxAllowed === undefined) {
      return res.status(400).json({ status: false, message: "Invalid user_type." }).end();
    }

    if (currentCount >= maxAllowed) {
      return res.status(400).json({
        status: false,
        message: `You have reached the maximum number of allowed accounts for this role`
      }).end();
    }

    // Insert user
    const insertResult = await rfqModel.insert("tbl_users", userDetails);
    const createdUser = insertResult[0];

            //activate default subscription
        let checkFreeSubscription =
          await subscriptionModel.checkFreeSubscription();
          const startDate = Moment(); // Replace with the actual start date

          const billingCycleMonths = checkFreeSubscription[0].duration;

          // Calculate the end date by adding the billing cycle and subtracting one day
          const endDate = startDate
            .clone()
            .add(billingCycleMonths, 'months')
            .subtract(1, 'day');
          const renewDate = startDate.clone().add(billingCycleMonths, 'months');


          let UserSubscriptionObj = {
            user_id: createdUser.id,
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
            createdUser.id
          );

          let subscriptionMappingDetails =
            await subscriptionModel.getSubscriptionMappingDetails(
              checkFreeSubscription[0].id
            );
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
              user_id: createdUser.id
            };
            await subscriptionModel.createUserSubscriptionFeature(
              userSubscriptionFeatureObj
            );
          }


    // Build account type label
    const accountTypeMap = {
      8: "Management",
      2: "Procurement",
      9: "Engineering",
      10: "Finance"
    };
    const accountTypeLabel = accountTypeMap[user_type] || "User";

    // Compose and send email
    const emailHeader = `<h2>Hello ${name},</h2>`;
    const emailContent = `
      <div style="font-size:16px; font-family:'Roboto',sans-serif;">
        <p>Welcome to WorkWise, your account has been successfully registered.</p>
        <p><strong>Login Details:</strong></p>
        <ul>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Password:</strong> ${password}</li>
          <li><strong>Mobile:</strong> ${mobile}</li>
          <li><strong>Account Type:</strong> ${accountTypeLabel}</li>
        </ul>
        <p>Login here: <a href="https://letsworkwise.com/?user_registered=1">Click Here</a></p>
        <p style="font-size:14px;color:#777;"><em>Please change your password after first login for security.</em></p>
      </div>`;

    const emailHTML = generateEmailTemplate(emailHeader, emailContent);
    const mailRecipients = {
      from: Config.webmasterMail,
      to: email,
      subject: "Welcome to WorkWise - Account Created",
      html: emailHTML
    };

    console.log('Sending email to:', email);
    console.log('Email HTML:', emailHTML);

    sendMail(mailRecipients);

    return res.status(200).json({
      status: true,
      message: "User account created successfully",
    }).end();

  } catch (err) {
    console.error("create_buyer_company_users error:", err);
    return res.status(500).json({
      status: false,
      message: "Error creating buyer company user.",
      error: err.message
    }).end();
  }
},

// Changes by Agnij 14-01-2025 [Added controller method to get company users]
get_company_users: async (req, res, next) => {
  try {
    const { company_id: companyID } = req.user;
    
    // Get all users for this company
    const users = await userModel.getCompanyUsers(companyID);
    
    // Map user_type to role names for better readability
    const userTypeMap = {
      7: "Admin",
      8: "Management",
      2: "Procurement",
      9: "Engineering",
      10: "Finance"
    };
    
    const formattedUsers = users
      .filter(user => user.user_type !== 7)
      .map(user => ({
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.user_type,
        role_name: userTypeMap[user.user_type] || "Unknown",
        status: user.status === 1 ? "active" : "inactive",
        created_at: user.created_at
      }));

    
    res.status(200).json({
      status: true,
      message: "Company users retrieved successfully",
      data: formattedUsers
    }).end();
    
  } catch (err) {
    logError(err);
    res.status(400).json({
      status: false,
      message: err.message || Config.errorText.value
    }).end();
  }
},

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
        email: email.toLowerCase(),
        mobile,
        organization_name,
        register_as,
        password: generatePassword(password),
        status
      };
      
      let user_id = await userModel.user_register(userObj);

      
      // create company profile if user type is vendor 
      if (user_id && register_as == '3') {
        const cmpObj = {
          company_name: userObj.name,
          location: null,
          email: userObj.email,
          mobile: userObj.mobile,
          gstin: null,
          cin: null,
          profile: null,
          nature_of_business: null,
          type_of_business: null,
          turnover: null,
          no_of_employess: null,
          certifications: null,
          import_export_code: null,
        }

        await userModel.companyProfileCreate(cmpObj, user_id[0].id);
      }

      if (user_id) {
        let html_variables = [{ name: name }];
        let dynamic_html = '';
        if (register_as == '2') {
          
          const emailHeaderContent = `<h2>Hello ${name || ''},</h2>`
          const emailContainerContent = `
          <div style="font-size:16px; font-family: 'Roboto', sans-serif;"> 
           <p> Welcome to WorkWise! Your admin account has been created successfully. </p>
            <p style="margin-bottom:0px;"><strong>Login Details:</strong></p>
            <ul>
            <li> <strong> Email: </strong> ${email} </li>
            <li> <strong>Password: </strong> ${password} </li>
            </ul>
            <p>You can log in to your account using this link: <a href="https://letsworkwise.com/?user_registered=1" >Click Here</a></p>
            <p style="font-size: 14px; color: #777;"><em>For security reasons, we recommend changing your password after your first login.</em></p>    
          </div>`

          dynamic_html = generateEmailTemplate(emailHeaderContent, emailContainerContent)
          
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
            to: userObj.email, // list of receivers
            subject: findDynamicNotification[0].title, // Subject line
            html: findDynamicNotification[0].content // plain text body
          });
        } else {


          const spocList = await vendorModel.getSpocDetails(user_id[0].id)

          // console.log(" user contoller 151 spoc console ", user_id[0]?.id, spocList)

          let mailRecipients = {
            from: Config.webmasterMail,
            subject: `Work Wise | Registration`,
            html: dynamic_html
          };

          if (spocList && spocList.length > 0) {
            mailRecipients.to = spocList.map(spoc => spoc.email);
            mailRecipients.cc = userObj.email;
          } else {
            mailRecipients.to = userObj.email;
          }

          sendMail(mailRecipients);


        }

        addDefaultNotifications(user_id[0].id);

        //activate default subscription
        let checkFreeSubscription =
          await subscriptionModel.checkFreeSubscription();
        // added check for vendor
        // if the user is vendor then it will not get into subscription check
        if (checkFreeSubscription.length > 0 && register_as != '3') {
          const startDate = Moment(); // Replace with the actual start date

          const billingCycleMonths = checkFreeSubscription[0].duration;

          // Calculate the end date by adding the billing cycle and subtracting one day
          const endDate = startDate
            .clone()
            .add(billingCycleMonths, 'months')
            .subtract(1, 'day');
          const renewDate = startDate.clone().add(billingCycleMonths, 'months');


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

          let subscriptionMappingDetails =
            await subscriptionModel.getSubscriptionMappingDetails(
              checkFreeSubscription[0].id
            );
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
      let err_msg = 'Invalid email or password or OTP not verified';
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
        // console.log('terst123');
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
      const email = req.body.email?.toLowerCase() || '';
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
        const verificationLink = `${process.env.FRONT_BASE_URL || "http://letsworkwise.com"}/validate-otp?otp=${otpseq}`;

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



        const spocList = await vendorModel.getSpocDetails(user_detail[0]?.id)

        // console.log(" user contoller 630 spoc console ", user_detail[0]?.id, spocList)

        let mailRecipients = {
          from: Config.webmasterMail,
          subject: `Work wise | Forgot Password OTP`,
          html: dynamic_html
        };

        if (spocList && spocList.length > 0) {
          mailRecipients.to = spocList.map(spoc => spoc.email);
          mailRecipients.cc = user_detail[0].email;
        } else {
          mailRecipients.to = user_detail[0].email;
        }

        sendMail(mailRecipients);

        // sendMail({
        //   from: Config.webmasterMail, // sender address
        //   to: email, // list of receivers
        //   subject: `Work wise | Forgot Password OTP `, // Subject line
        //   html: dynamic_html // plain text body
        // });

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

/**
 * Updates user profile details with permission-based access control
 * 
 * This function handles updating user profile information with the following features:
 * - Permission-based access: Company admins (user_type 7) can update other users within their company
 * - Self-update: All users can update their own profile information
 * - Status updates: Only allowed for non-admin users and only by admins
 * - Field validation: Trims and formats input data
 * - Tracking: Records who made the update and when
 * 
 * @param {Object} req - Express request object containing:
 *   - user: The authenticated user making the request (from passport middleware)
 *   - body: Request payload with fields to update (name, email, mobile, status, user_id)
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Object} JSON response with status and message
 */
update_user_detail: async (req, res, next) => {
  try {
    const loggedInUser = req.user;
    const reqData = req.body;
    const isAdmin = loggedInUser.user_type === 7;
    
    // Determine target user ID
    let targetUserId = reqData.user_id && isAdmin ? reqData.user_id : loggedInUser.id;
    
    // Check permissions - only admins can update other users
    if (reqData.user_id && !isAdmin) {
      return res.status(403).json({
        status: false,
        message: "Only company administrators can update other users"
      });
    }
    
    // Build update data with tracking information
    const updateData = {
      updated_at: currentDateTime(),
      updated_by: loggedInUser.id
    };
    
    // Add user-provided fields to update data with proper formatting
    if (reqData.name !== undefined) updateData.name = reqData.name?.trim();
    if (reqData.email !== undefined) updateData.email = reqData.email?.trim().toLowerCase();
    if (reqData.mobile !== undefined) updateData.mobile = reqData.mobile?.trim();
    
    // Status updates: Only for non-admin users and only by admins
    if (reqData.status !== undefined && targetUserId !== loggedInUser.id) {
      // Check if target user is not an admin (user_type 7)
      const targetUser = await userModel.userExistsById(targetUserId);
      if (targetUser && targetUser.user_type !== 7) {
        updateData.status = reqData.status;
      }
    }
    
    // Execute update using updateWhere for all cases
    // For admin updating another user: Ensure company_id matches
    // For self-update: Only filter by user's own ID
    const whereClause = isAdmin && targetUserId !== loggedInUser.id
      ? `id = ${targetUserId} AND company_id = ${loggedInUser.company_id}`
      : `id = ${targetUserId}`;
      
    await rfqModel.updateWhere(
      "tbl_users",
      updateData,
      whereClause
    );

    return res.status(200).json({
      status: 1,
      message: "User profile updated successfully"
    });
  } catch (err) {
    logError(err);
    return res.status(400).json({
      status: false,
      message: Config.errorText.value
    });
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
          req.file.location,
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

      // if req.is_verified is true then there must be token in the query
      if (!req.is_verified && !req.query.token) {
        return res
          .status(401)
          .json({
            status: 0,
            message: 'Access denied. Please provide a valid token.'
          });
      }

      // if user try to uplaod file without login
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

      let user_id = req.user.id;
      const user = await userModel.userinfo(user_id);
      // now getting spoc details of the user
      const spoc = await vendorModel.getSpocDetails(user_id, false);
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
        user.spoc = spoc;
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
          email = response.data.email?.toLowerCase();
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
      const { variant_id } = req.query;
      const vendorApproveList = await userModel.get_vendorapprove_list(variant_id);
      if (vendorApproveList) {
        res
          .status(200)
          .json({
            status: 1,
            data: vendorApproveList
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
    
    try {
      let user_id;

      // if req.is_verified is true then there must be token in the query
      if (!req.is_verified && !req.query.token) {
        return res
          .status(401)
          .json({
            status: 0,
            message: 'Access denied. Please provide a valid token.'
          });
      }

      // if user try to uplaod file without login
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

      user_id = req.user.id;

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

enhance_vendor_profile: async (req, res, next) => {
  try {
    const user_id = req.user.id;
    const user_type = req.user.user_type; // assuming this is set in passport
    const { text_content,payment_terms, record_id , is_approved , doc_type } = req.body;

    const files = req.files && req.files.file ? req.files.file : [];

    // If admin (user_type = 1) → just approve instead of inserting
    if (user_type === 1) {
      if (!record_id) {
        return res.status(400).json({
          status: 0,
          message: "record_id required for approval"
        }).end();
      }

      await userModel.approveAsset(record_id,is_approved, user_id);

      return res.status(200).json({
        status: 1,
        message: "Vendor profile approved successfully"
      }).end();
    }

    // // Normal vendor upload flow
    // if (!files.length && !text_content) {
    //   return res.status(400).json({
    //     status: 0,
    //     message: "No files or text provided"
    //   }).end();
    // }
  console.log("doc type ", doc_type);
    const result = await userModel.insertAssets(
      user_id,
      files,
      text_content,
      payment_terms,
      doc_type
    );

    res.status(200).json({
      status: 1,
      message: "Vendor profile updated successfully",
      inserted_ids: result.map(r => r.id)
    }).end();

  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  }
},

upload_payment_terms :  async (req, res, next) => {
  try {
    const { terms } = req.body;
    const user_id = req.user?.id || null;

    // ✅ Validation
    if (!Array.isArray(terms) || terms.length === 0) {
      return res.status(400).json({
        status: 0,
        message: "Invalid or empty payment terms data",
      });
    }
    //First delete the existing payment terms
    await rfqModel.delete('tbl_vendor_payment_terms', { created_by: user_id });
    // 🧩 Prepare data for DB insert
    const dataArray = terms.map((t) => ({
      value: t.value || 0,
      type: t.type || null,
      days: t.days || null,
      created_by: user_id,
      timestamp: currentDateTime(),
      comment: t.comment || null,
    }));

    // 🗝️ Define column keys (must match your table `tbl_payment_terms`)
    const keys = new pgp.helpers.ColumnSet(
      ["value", "type", "days", "created_by", "timestamp", "comment"],
      { table: "tbl_payment_terms" }
    );

    // 🧠 Use model helper
    const insertedRows = await rfqModel.insertArray(dataArray, keys, "tbl_vendor_payment_terms");

    return res.status(200).json({
      status: 1,
      message: "Payment terms added successfully",
      data: insertedRows,
    });

  } catch (error) {
    console.error("Error in upload_payment_terms:", error);
    next(error);
  }
},

get_payment_terms: async (req, res, next) => {
  try {
    const { vendor_id, type } = req.query;

    // 🧠 Determine whose payment terms to fetch
    let user_id;

    if (type === "buyer" && vendor_id) {
      // Buyer is requesting vendor's terms → use vendor_id from query
      user_id = vendor_id;
    } else if (type === "vendor") {
      // Vendor is requesting their own terms → use logged-in user ID
      user_id = req.user?.id;
    }

    // 🚨 If no valid user_id found
    if (!user_id) {
      return res.status(400).json({
        status: 0,
        message:
          "Missing vendor ID or unauthorized request. Please provide vendor_id when type is 'buyer'.",
      });
    }

    // ✅ Fetch payment terms from DB
    const terms = await rfqModel.findAll("tbl_vendor_payment_terms", {
      created_by: user_id,
    });

    return res.status(200).json({
      status: 1,
      data: terms || [],
    });
  } catch (error) {
    console.error("Error in get_payment_terms:", error);
    next(error);
  }
},

get_vendor_profile_documents  : async (req, res, next) => {
  try {
    let user_id = req.user.id;
    

    const user_type = req.user // assuming this is set in passport
    let result;
   

 const user = await rfqModel.findAll(
  'tbl_vendor_profile',
  { vendor_id: user_id }
);



    if (user) {
      res.status(200).json({
        status: 1,
        data: user
      }).end();
    }
    else if(result.length>0){
      res.status(200).json({
        status: 1,
        data: result
      }).end();
    }
  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  }
},

get_vendor_profile_reviews : async (req , res , next) => {
  try {
    let user_id = req.user.id;
    const reviews = await userModel.getVendorReviews(user_id);

    res.status(200).json({
      status: 1,
      data: reviews
    }).end();
  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    }).end();
  } 

    
},

publish_profile_reviews: async (req, res, next) => {
  try {
    const { review_ids } = req.body;
    const user_id = req.user.id; // vendor ID from auth

    if (!review_ids || !Array.isArray(review_ids) || review_ids.length === 0) {
      return res.status(400).json({ status: 0, message: "review_ids array is required" });
    }

    const payload = {
      review_ids,
      user_id
    };

    await userModel.publishProfileReviews(payload);

    res.status(200).json({
      status: 1,
      message: "Review publish status updated"
    });
  } catch (error) {
    logError(error);
    res.status(400).json({
      status: 3,
      message: Config.errorText.value
    });
  }
},




  // uploading the documents for the users without authenticatiion
  upload_document_without_auth: async (req, res, next) => {
   
    try {

      // we havfe successfully saved to the server, 
      // now we have to give the reponse to the frontend.

      if (req.files) {
        const dataArray = [];
        req.files.file.map((item) => {
          dataArray.push({
            file_name: item.originalname,
            new_file_name: item.filename,
            file_path: `${Config.base_url}/user_document_without_auth/${item.filename}`,
            file_type: item.mimetype,
          });
        });

        res
          .status(200)
          .json({
            status: 1,
            data: dataArray
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
    let user_id = req.params.vendor_id;
    let user = {};

    try {
      // let user_id = req.user.id;
      let subscription = false;
      if (!req.is_verified || !req.user.subscription_plan_id) {
        user = await userModel.vendorinfo(user_id);
      } else {
        subscription = true;
        user = await userModel.vendorinfo(user_id, req.user.id);
      }

      // Get Spoc Details of the vendor - only approved ones for public view
      const spoc_details = await vendorModel.getSpocDetails(user_id, 1); // 1 = approved status only
      user = {
        ...user,
        spoc_details
      };

      if (user) {
        res
          .status(200)
          .json({
            status: 1,
            data: user,
            subscription: subscription,
            logged_In: req.is_verified
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

  subscriptionDetails: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { coupon_code, sub_id } = req.body;
      const user_type = req.user.user_type;

      let today = dateFormat(new Date(), 'yyyy-mm-dd');
      let subscriptionList =
        await subscriptionModel.getBuyerSubscriptionDetails(today, sub_id, user_type);
      let couponDetails = await couponModel.checkCouponCodeExists(
        coupon_code,
        today,
        user_type,
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

  subscriptionPayment: async (req, res, next) => {
    try {
      let { sub_id, coupon_code } = req.body;
      const user_type = req.user.user_type;

      let subscriptionDetails =
        await subscriptionModel.subscriptionIdExist(sub_id, user_type);
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
          today,
          user_type,
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
  test_razorpay_webhook: async (req, res) => {
    try {
      let subscriptionPaymentObj = {
          status: 1,
          after_payment_response: "Requested Body",
          payment_id: "Some id",
          method: "rzpy",
          order_id: req.body.order_id,
          receipt: "Some receipt",
          date: Moment().format('YYYY-MM-DD')
        };

        console.log(
          'subscriptionPaymentObj ==>>>>>>>>>',
          subscriptionPaymentObj
        );
        let paymentUpdate = await subscriptionModel.updateSubscriptionPayment(
          subscriptionPaymentObj
        );
        console.log("PAYMENT UPDATE => ", paymentUpdate);

        
        if (paymentUpdate.length > 0) {
          const condition = `user_id = ${parseInt(
            paymentUpdate[0].user_id
          )} AND status = 1 AND end_date > CURRENT_DATE ORDER BY end_date DESC LIMIT 1`;
          let activeSubscripton = await rfqModel.checkIfExists(
            'tbl_user_subscriptions',
            condition
          );
  
          if (activeSubscripton && activeSubscripton.length > 0) {
            activeSubscripton = activeSubscripton[0];
  
            const subscriptionObj = {
              status: 3
            };
            await subscriptionModel.updateBuyerSubscription(
              subscriptionObj,
              activeSubscripton.id
            );
  
            await userModel.updateUserAccount(paymentUpdate[0].user_id, {
              subscription_plan_id: null
            });
          }

          let userSubscription = await subscriptionModel.updateUserSubscription(
            paymentUpdate[0].user_subscriptions_id,
            paymentUpdate[0].user_id
          );
          console.log(
            '🚀 ~ razorpay_webhook: ~ userSubscription:',
            userSubscription
          );
          await subscriptionModel.updateUserSubscriptionId(
            userSubscription[0].plan_id,
            paymentUpdate[0].user_id
          );
          res
            .status(200)
            .json({
              status: 1,
              message: "Successfully Triggered the Webhook!"
            })
            .end();
        } else {
          res
            .status(400)
            .json({
              status: 3,
              message: "Payment Update Not Found!"
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
  razorpay_webhook: async (req, res) => {
    try {
      // console.log(req);

      const requestedBody = JSON.stringify(req.body);
      // console.error(
      //   'requestedBody---',
      //   requestedBody,
      //   req.body.payload?.payment?.entity?.order_id,
      //   req.body.event
      // );
      const receivedSignature = req.headers['x-razorpay-signature'];

      let valid = Razorpay.validateWebhookSignature(
        JSON.stringify(req.body),
        receivedSignature,
        Config.razorpay.razorpay_signature
      );
      // console.error(valid);
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
        // console.log(
        //   'subscriptionPaymentObj ==>>>>>>>>>',
        //   subscriptionPaymentObj
        // );
        let paymentUpdate = await subscriptionModel.updateSubscriptionPayment(
          subscriptionPaymentObj
        );
        // console.log('paymentUpdate==>>>>>>>>>>', paymentUpdate);
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
          // console.log(
          //   'totalDiscount====>>>>>>>>>>>>>',
          //   totalDiscount,
          //   totalDiscount > 0 ? 'abbbbceeee' : 'elseeeeeee'
          // );

          let htmlPdf = `<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center" style="table-layout: fixed;border-collapse: collapse;border-spacing:0;font-family:Tahoma,Arial,sans-serif;color:#000000;margin: 0 auto 10px;width: 100%;min-width:615px;max-width:615px;background-color: #ffffff;padding: 0;font-size: 12px;">
  <tbody>
    <tr>
      <td style="padding:0;font-size: 18px;font-weight: bold; font-family:Tahoma,Arial,sans-serif;color:#000000;"> Invoice <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
          <tbody>
            <tr>
              <td style="padding: 10px 0 5px; font-weight: bold;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Invoice number</td>
              <td style="padding: 10px 0 5px; font-weight: bold;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${orderEntity.receipt
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
              <td style="padding: 10px 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;"> 1st Floor, 271 Business Park, Model Industrial Estate, near Virwani Industrial Estate </td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">off Western Express Highway, Vishveshwar Nagar </td>
            </tr>
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">Goregaon, Mumbai, Maharashtra 400063</td>
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
            ${userDetails.company_name
              ? `<tr>
              <td style="padding: 10px 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.company_name}</td>
            </tr>`
              : ''
            }
            ${userDetails.name
              ? `<tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.name}</td>
            </tr>`
              : ''
            }
            ${userDetails.address
              ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.address}</td>
          </tr>`
              : ''
            }
            ${userDetails.city_name
              ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.city_name}</td>
          </tr>`
              : ''
            }
            ${userDetails.state_name
              ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">${userDetails.state_name}</td>
          </tr>`
              : ''
            }            
            <tr>
              <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">India</td>
            </tr>
            ${userDetails.email
              ? `<tr>
            <td style="padding: 0 0 10px;font-size: 12px;font-family:Tahoma,Arial,sans-serif;color:#000000;">
              <a style="text-decoration: none;color: #000000;" href="mailto:${userDetails.email}">${userDetails.email}</a>
            </td>
          </tr>`
              : ''
            }
          ${userDetails.gstin
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
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #979797;">${planDetails[0].plan_name
            } </td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal;text-align: center; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #979797;">1</td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal;font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: center;border-top: 1px solid #979797;">₹ ${paymentUpdate[0].subscription_charge
            }</td>
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;text-align: right;border-top: 1px solid #979797;">₹ ${paymentUpdate[0].subscription_charge
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
        ${totalDiscount > 0
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
            <td style="padding:10px 0;font-size: 12px;font-weight: normal; font-family:Tahoma,Arial,sans-serif;color:#000000;vertical-align: top;border-top: 1px solid #d3d3d3;text-align: right;">₹ ${paymentUpdate[0].amount
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


          const spocList = await vendorModel.getSpocDetails(paymentUpdate[0].user_id)

          // console.log(" user contoller spoc 2025 console ", paymentUpdate[0]?.id, spocList)

          let mailRecipients = {
            from: Config.webmasterMail,
            subject: `Work Wise | Subscription Plan`,
            html: dynamic_html
          };

          if (spocList && spocList.length > 0) {
            mailRecipients.to = spocList.map(spoc => spoc.email);
            mailRecipients.cc = userDetails.email;
          } else {
            mailRecipients.to = userDetails.email;
          }

          sendMail(mailRecipients);

          // sendMail({
          //   from: Config.webmasterMail, // sender address
          //   to: userDetails.email, // list of receivers
          //   subject: `Work wise | Subscription Plan`, // Subject line
          //   html: dynamic_html // plain text body
          // });

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
      const { reviewed_to, description, quality_of_work, on_time_delivery, trustworthiness_reliability, overall_rating } = req.body;

      // Calculate the average rating
      const rating = (overall_rating + trustworthiness_reliability + on_time_delivery + quality_of_work) / 4;

      let reviewObj = {
        reviewed_by: user_id,
        reviewed_to,
        rating,
        description,
        quality_of_work,
        on_time_delivery,
        trustworthiness_reliability,
        overall_rating
      };

      let review = await notificationModel.addVendorReview(reviewObj);

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
      const { sms, type_id } = req.body;
      const email = req.body.email?.toLowerCase() || '';

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
    const user_id = req.user.id;
    try {
      if (req.user.user_type == 2 || req.user.user_type == 8) {
        // Buyer
        const total_rfqs = await rfqModel.getAllRfqByUser( user_id );
        const active_rfqs = await rfqModel.getAllRfqByUser(user_id, 1);
        // const closed_rfqs = await rfqModel.getClosedRfqs(user_id);
        // const completed_rfqs = await rfqModel.getCompletedRfqs(user_id);
        const active_quotes = await rfqModel.getActiveQuotes(user_id, 1);
        const pending_responses = Math.max(parseInt(active_rfqs.count) - parseInt(active_quotes.count), 0);

        const total_projects = await rfqModel.getAllProjects( user_id, false );
        const active_projects = await rfqModel.getAllProjects( user_id, true );
        const closed_projects = Math.max(parseInt(total_projects.count) - parseInt(active_projects.count), 0);

        // getting the data of all rfqs of a buyer
        let page, limit, offset;
        if (req.body.page && req.body.page > 0) {
          page = req.body.page;
          limit = req.body.limit || Config.globalAdminLimit;
          offset = (page - 1) * limit;
        } else {
          limit = Config.globalAdminLimit;
          offset = 0;
        }

        let { project_id, sort, reverse_auction, rfq_type } = req.body;
        if (project_id == -1) {
          project_id = null;
        }
        if (rfq_type == '') {
          rfq_type = null;
        }
        if (reverse_auction == '-1') {
          reverse_auction = null;
        }

        const rfq_data_for_notificaton = await rfqModel.getAllBuyerRfq(limit, offset, user_id, project_id, sort, reverse_auction, rfq_type);

        let temp_rfqs = rfq_data_for_notificaton.map((item) => {
          delete item.products;
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

        let recente_received_quotes = await rfqModel.getRecentQuotes(req.user.id);
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

        let rfq_data = await rfqModel.getAllBuyerRfq(limit, offset, user_id, project_id, sort, reverse_auction, rfq_type)
        // let cost = await rfqModel.getAllRfqCost(req.user.id, 2);

        data = {
          total_rfqs: parseInt(total_rfqs.count),
          active_rfqs: parseInt(active_rfqs.count),
          // completed_rfqs: parseInt(completed_rfqs.count),
          // closed_rfqs: parseInt(closed_rfqs.count),
          pending_responses,
          quotes_received: parseInt(active_quotes.count),
          total_projects: parseInt(total_projects.count),
          active_projects: parseInt(active_projects.count),
          closed_projects,
          notificaiton_data: readable_notification_date_data,
          rfq_data,
          // savings: parseInt(cost.total_price_formatted * 0.05)
        }
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
  },
  getDashboardAnalytics: async (req, res, next) => {
    const user_id = req.user.id;
    const chartFilter = req.query.chart_filter || null;
    const dataType = req.query.data_type || null;
    const product_id = req.query.product || null;
    const vendor_ids = req.query.vendor ? req.query.vendor.split(",").map(id => parseInt(id, 10)) : null;
    let data = {};

    try {
      const { startDate, endDate } = getDateRange(chartFilter);
      switch (dataType) {
        case 'quotes':
            data = await rfqModel.getQuotesChartData(user_id, chartFilter, startDate, endDate, product_id, vendor_ids);
            break;
        case 'quote_costing':
            data = await rfqModel.getQuoteCostingData(user_id, chartFilter, startDate, endDate, product_id, vendor_ids);
            break;
        default:
            break;
    }    

      res
        .status(200)
        .json({
          status: 1,
          data
        })
        .end();
    } catch (error) {
      console.log(error)
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
  addPrivateVendor: async (req, res, next) => {

    // No need to check subscription when buyer is adding its vendor or new vendor

    // if (!req.user.subscription_plan_id) {
    //   res
    //     .status(400)
    //     .json({
    //       status: 3,
    //       message: 'You need to purchase subscription to add vendor'
    //     })
    //     .end();
    //   return;
    // }

    try {
      const { vendorName, phone, productList, is_private } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      const buyerId = req.user.id; // Getting buyerId from the authenticated user

      let obj = {
        buyerId,
        vendorName,
        email,
        phone,
        productList,
        is_private: !(req.body.is_private) ? 0 : is_private,
      }

      // If user does not exist, proceed with inserting data into the tbl_temp_user table
      const result = await userModel.insertBuyerPrivateVendor(obj);

      // Sending the response back to the client
      res.status(201).json({
        status: 1,
        message: 'Vendor successfully added. Please wait for vendor review.',
        data: result
      });

    } catch (error) {
      logError(error);
      let message = error == "Error: Vendor_In_Review" ? "This vendor has already been added by you. Please wait while we review the vendor details" : Config.errorText.value;

      return res
        .status(400)
        .json({
          status: 3,
          message: message
        })
        .end();
    }
  },

  addApprovedPrivateVendor: async (req, res, next) => {

    try {

      const { vendorName, email, phone, is_private } = req.body;
      let { productDetails } = req.body
      const buyerId = req.user.id;

      let obj = {
        buyerId,
        vendorName,
        email: email.toLowerCase(),
        phone,
        productList: "Products already added by buyer.",
        is_private: !(req.body.is_private) || req.body.is_private == 0 ? 0 : 1,
      }

      let vendorId = null;
      let userEmailExists = null;
      let companyExists = null;

      if (email && phone) {
        const phoneWithoutCode = phone.replace(/^\+\d+\D*/, '');
       
        userEmailExists = await userModel.user_exist(email.toLowerCase(), phoneWithoutCode);
        if (userEmailExists.length > 0 && userEmailExists[0].user_type == 3) {
          vendorId = userEmailExists[0].id;
          companyExists = await userModel.getCompanyDetail(vendorId);
        }
      }

      if (userEmailExists.length == 0) {
        // new vendor on our portal

        let createdBy = req.user.id;

        let userDetails = [{
          buyer_id: buyerId,
          vendor_name: vendorName,
          email: email.toLowerCase(),
          mobile: phone,
          productDetails,
          is_private: 1
        }];
        const buyer = await userModel.getUserById(buyerId);
        const buyerName = buyer[0].name;
        let orgChar = userDetails[0].vendor_name.match(/[a-zA-Z]/g)?.join('').toLowerCase();
        let capitalizeFourOrganizationLetter = `${orgChar.charAt(0).toUpperCase()}${orgChar.substring(1, 4)}`;
        let password = `${capitalizeFourOrganizationLetter}@${userDetails[0].mobile.substring(
          6,
          10
        )}`;

        let vendorObj = {
          name: userDetails[0].vendor_name || null,
          email: userDetails[0].email || null,
          mobile: userDetails[0].mobile || null,
          user_type: '3',
          password: generatePassword(password),
          status: '1',
          created_by: createdBy,
          organization_name: userDetails[0].vendor_name || null
        };

        let companyObj = {
          email: userDetails[0].email || null,
          mobile: userDetails[0].mobile || null,
          company_name: userDetails[0].vendor_name || null,
          is_private: userDetails[0].is_private,
        };

        const {company_id, user_id} = await userModel.company_registration(vendorObj, companyObj);


        await userModel.mapBuyerToVendor(userDetails[0].buyer_id, user_id);


        // send whatsapp notification
        const payload = {
          mobile:userDetails[0].mobile ,
          buyerName:buyerName,
          email:userDetails[0].email,
          password:password

        }
        // await whatsappNotificationAISensy.buyerAddedVendorNotificationToVendor(payload)

        vendorId = user_id;

        addDefaultNotifications(user_id);

        if (user_id) {

          const spocList = await vendorModel.getSpocDetails(user_id);

          const headerContent = `<h2>Hello ${userDetails[0].vendor_name || 'Vendor'},</h2>`;


          // Email body content
               const containerContent = `
               <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
                 <p>
                   We are pleased to inform you that <strong>${buyerName}</strong> has added you as a preferred vendor on the Workwise platform.
                   Going forward, <strong>${buyerName}</strong> will manage their procurement activities through Workwise.
                 </p>
                 <p>
                   To ensure you receive all enquiries promptly, Login to your account.
                   Your login credentials are provided below:
                 </p>
                 <p><strong>Email:</strong> ${userDetails[0]?.email || '[Vendor Email]'}</p>
                 <p><strong>Password:</strong> ${password || '[Temporary Password]'}</p>
                 <p>
                   We recommend changing your password after your first login for security reasons.
                 </p>
                 <a href="https://letsworkwise.com"
                   style="background-color: #059669; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
                    Login
                 </a>    
                 <p style="margin-top:20px; text-align:center;">
                   We look forward to supporting your business growth.
                 </p>
             
                
               </div>`;
             
            // Generate final email layout
            const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

          sendMail({
            from: `${buyerName}  ${Config.masterEmail}`,
            to: spocList?.length ? spocList.map(spoc => spoc.email) : userDetails[0].email,
            cc: spocList?.length ? userDetails[0].email : '',
            subject: `${buyerName} Added You on Workwise`,
            html: dynamicHTML
          });
        }
      }

      let errors = [];

      for (let i = 0; i < productDetails?.length; i++) {
        const newErrors = add_vendor_product(productDetails[i], vendorId);
        // console.log("newErrors: ", newErrors)
        if (newErrors.length > 0) {
          errors.push({
            productName: productDetails[i].name,
            errors: newErrors,
          });
          continue;
        }

        // if no error then move further to map variant with vendor
        let {
          approved_id,
          approved_name,
          master_id,
        } = productDetails[i];

        const productResult = await productModel.getProductByVariant(master_id)
        let productId = productResult?.[0]?.id

        if (approved_id) {
          if (typeof approved_id === 'string') {
            approved_id = JSON.parse(approved_id);
          }
          else if (!Array.isArray(approved_id)) {
            approved_id = [approved_id];
          }
        }

        let vendorApproveId = [];
        if (!approved_id && approved_name) {
          let findVendorApprove = await vendorapproveModel.findVendorApproveByName(approved_name);
          if (findVendorApprove.length === 0) {
            let vendorApproveObj = {
              vendor_approve: approved_name,
              status: 1
            };
            let createVendorApprove = await vendorapproveModel.createVendorApprove(vendorApproveObj);
            vendorApproveId = [createVendorApprove.id];
          } else {
            vendorApproveId = [findVendorApprove[0].id];
          }
        } else {
          vendorApproveId = approved_id;
        }

        let mappingObj = {
          product_variant_id: master_id,
          vendor_id: vendorId,
          is_approved: false,
          created_by: req.user.id,
          updated_by: req.user.id,
        }

        let mappingResult = await productModel.createProductVariantVendorMapping(mappingObj)

        if (vendorApproveId.length > 0 && mappingResult) {
          let productApproveArray = [];
          vendorApproveId.forEach((item) => {
            productApproveArray.push({
              product_id: productId,
              variant_vendor_mapping_id: mappingResult.id,
              vendor_approve_id: item
            });
          });

          await productModel.addProductApproveBy(productApproveArray, productId);
        }
      }


      if (userEmailExists.length > 0) {
        if (userEmailExists[0].user_type == 3) {

          await userModel.mapBuyerToVendor(req.user.id, userEmailExists[0].id);
          // console.log(companyExists)
          if (companyExists?.[0].is_private == 0) {
            res
              .status(200)
              .json({
                status: 1,
                message: "This vendor is already registered as a PUBLIC vendor in our system. They have now been added to your preferred vendor list."
              })
              .end();
            return;
          } else {

            if (is_private) {
              res
                .status(200)
                .json({
                  status: 1,
                  message: "This vendor is already registered as a PRIVATE vendor in our system. They have now been added to your preferred vendor list."
                })
                .end();
              return;
            } else {
              obj.status = 3;
              const result = await userModel.insertBuyerPrivateVendor(obj);
              res
                .status(200)
                .json({
                  status: 1,
                  data: result,
                  message: "Vendor has been sent to the admin for review to make their profile PUBLIC. They have also been added to your preferred vendor list."
                })
                .end();
              return;
            }

          }

        } else {
          return res.status(400).json({
            status: 1,
            message: "User already registered but not as a vendor. Please enter a valid email and phone number for a vendor."
          }).end();
        }
      }

      if (is_private) {
        res.status(201).json({
          status: 1,
          message: 'Vendor has been successfully added as PRIVATE.'
        });
      } else {
        obj.status = 3;
        const result = await userModel.insertBuyerPrivateVendor(obj);

        res.status(201).json({
          status: 1,
          message: 'Vendor has been successfully added as PRIVATE and sent to the admin for review to make their profile PUBLIC.',
          data: result
        });
      }

    } catch (error) {
      logError(error);
      let message = error == "Error: Vendor_In_Review" ? "This vendor has already been sent to the admin for review to make their profile PUBLIC. Please wait while the vendor details are being reviewed" : Config.errorText.value;

      return res
        .status(400)
        .json({
          status: 3,
          message: message
        })
        .end();
    }
  },

  getBuyerPrivateVendors: async (req, res, next) => {
    try {
      const buyerId = req.user.id;

      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 10;

      const data = await userModel.getBuyerPrivateVendors(buyerId, limit, page);
      const count = await userModel.getBuyerPrivateVendorsCount(buyerId);

      res.status(200).json({
        status: 1,
        message: 'Vendor details retrieved successfully.',
        data,
        count
      });
    } catch (error) {
      next(error);
    }
  },
  buyerExcelUploadVendor: async (req, res, next) => {
    try {

      // No need to check subscription when buyer is adding its vendor or new vendor

      // if (!req.user.subscription_plan_id) {
      //   res
      //     .status(400)
      //     .json({
      //       status: 3,
      //       message: 'You need to purchase subscription to add vendor'
      //     })
      //     .end();
      //   return;
      // }


      let file = req.file;

      // checing the is_private field
      let is_private = parseInt(req.body.is_private);

      // when is_private does not send with request
      if (!req.body.is_private) {
        is_private = 0;
      }

      // convert excel to json
      const workbook = xlsx.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet);

      // validation error array ko keep monitor all products
      const validationErrors = [];

      // success vendor messages
      const vendorsMapped = [];

      //  run loop on excel data
      for await (const [index, value] of jsonData.entries()) {

        // trim all inputs
        const vendorName = (value["Vendor Name"] || "").trim();
        const email = (value["Vendor Email"]?.toLowerCase() || "").trim();
        const rawMobile = (value["Vendor company owner/hr/official contact number"] || "").toString();
        const mobile = rawMobile.replace(/^\+91-\+91/, '+91').substring(0, 15);
        const productList = (value["Product List (ex-pipe,valve)"] || "").trim();

        // now check validation for vendor name number and email

        const errors = validateBulkVendorInputs(vendorName, email, mobile, productList);
        if (errors.length > 0) {
          const errObj = {
            vendorName: vendorName,
            vendorEmail: email,
            Row: index + 1,
            errors: errors
          }
          validationErrors.push(errObj);
          continue;
        }

        // now these are those vendors which do not have errors 
        // so we are moving forward for the insertion and other validation check
        if (email && mobile) {
          const userEmailExists = await userModel.user_exist(email, mobile);
          if (userEmailExists.length > 0) {
            //  check whether the user is vendor or not by checking thier user_type==3
            if (userEmailExists[0].user_type == 3) {
              // case 1 -> whethtr the vendor is public
              if (userEmailExists.is_private == 0) {
                await userModel.mapBuyerToVendor(req.user.id, userEmailExists[0].id);
                const addVendor = {
                  "index": index + 1,
                  "email": userEmailExists[0].email,
                  "phone": userEmailExists[0].mobile,
                  "message": "This vendor is already registered as a PUBLIC vendor in our system. They have now been added to your preferred vendor list."
                }
                vendorsMapped.push(addVendor);
                continue;
              } else {
                // case 2 -> whether the vendor is private
                await userModel.mapBuyerToVendor(req.user.id, userEmailExists[0].id);
                const addVendor = {
                  "index": index + 1,
                  "email": userEmailExists[0].email,
                  "phone": userEmailExists[0].mobile,
                  "message": "This vendor is already registered as a PRIVATE vendor in our system. They have now been added to your preferred vendor list."
                }
                vendorsMapped.push(addVendor);
                continue;
              }
            } else {
              const addVendor = {
                "index": index + 1,
                "email": userEmailExists[0].email,
                "phone": userEmailExists[0].mobile,
                "message": "Unable to add this vendor. Please ensure the credentials belong to a valid vendor account."
              }
              vendorsMapped.push(addVendor);
              continue;
            }

          }
        }

        // function where new vendor is adding for review
        try {

          const buyerId = req.user.id; // Getting buyerId from the authenticated user

          const obj = {
            buyerId,
            vendorName,
            email,
            phone: mobile,
            productList,
            is_private
          }

          // If user does not exist, proceed with inserting data into the tbl_temp_user table
          const result = await userModel.insertBuyerPrivateVendor(obj);

          // Sending the response back to the client
          if (result) {
            const addVendor = {
              "index": index + 1,
              "email": email,
              "phone": mobile,
              "message": 'Vendor successfully added. Please wait for vendor review.',
            }
            vendorsMapped.push(addVendor);
          }

        } catch (error) {
          logError(error);
          let message = error == "Error: Vendor_In_Review" ? "This vendor has already been added by you. Please wait while we review the vendor details" : Config.errorText.value;
          const addVendor = {
            "index": index + 1,
            "email": email,
            "phone": mobile,
            "message": message,
          }
          vendorsMapped.push(addVendor);
        }

      }
      // check if all row are failed in our validation
      if (validationErrors.length === jsonData.length) {
        return res
          .status(400)
          .json({
            status: 3,
            message: "All rows have validation errors. Please check your data and try again.",
            errorsObj: validationErrors
          })
          .end();
        // Exit early if every row has an error
      }

      res
        .status(200)
        .json({
          status: 1,
          addVendor: vendorsMapped,
          errorsObj: validationErrors,
        })


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




  getTopVendorsandProducts: async (req, res) => {
    try {
      
      const user_id = req.user.id;

      const vendorData = await vendorModel.topVendorsWithProducts(user_id);
      const productData = await productModel.topProductsWithVendors(user_id);

      res.status(200)
      .json({
        status: 1,
        data:{
          vendorData,
          productData
        }
      })


    } catch (error) {
      console.log("ERROR --------- ", error)
      logError("Error in getting top vendors and products for user dashboard: ", error);
      res.status(400)
      .json({
        status: 3,
        message: Config.errorText.value
      })
      .end();
    }
  },

  getFinalizedProducts: async (req, res) => {
    try {      
      const user_id = req.user.id;
      const data = await vendorModel.getFinalizedProducts(user_id);

      res.status(200)
      .json({
        status: 1,
        data
      })

    } catch (error) {
      logError("Error in getting finalized products for user dashboard: ", error);
      res.status(400)
      .json({
        status: 3,
        message: Config.errorText.value
      })
      .end();
    }
  },

  getFinalizedVendors: async (req, res) => {
    try {      
      const user_id = req.user.id;
      const data = await vendorModel.getFinalizedVendors(user_id);

      res.status(200)
      .json({
        status: 1,
        data
      })

    } catch (error) {
      logError("Error in getting finalized vendors for user dashboard: ", error);
      res.status(400)
      .json({
        status: 3,
        message: Config.errorText.value
      })
      .end();
    }
  },

  searchVendorsByName: async (req, res) => {

    try {  
      const buyer_id = req.user.id;
      const {vendor_name} = req.body;

      if(vendor_name.length<3){
        return res.status(200)
        .json({
          status: 1,
          data: []
        })
        .end();
      }

      const data = await rfqModel.searchVendorsByName(buyer_id, vendor_name);

      return res.status(200)
      .json({
        status: 1,
        data
      })
      .end();
     
    } catch (error) {
      logError("Error in searching vendors for user dashboard: ", error);
      return res.status(400)
      .json({
        status: 3,
        message: Config.errorText.value
      })
      .end();
    }
  },


  // Changes by Agnij 10-06-2025 [Added function to get buyer account limits]
  getBuyerAccountLimits: async (req, res) => {
    try {
      const company_id = req.params?.company_id || req.user?.company_id;
      
      const accountLimits = await userModel.getBuyerAccountLimits(company_id);
      
      // Return the first object from the array, or default values if no data
      const rawData = accountLimits.length > 0 ? accountLimits[0] : {};
      const limitsData = {
        max_top_management: parseInt(rawData.max_top_management) || 0,
        max_procurement: parseInt(rawData.max_procurement) || 0,
        max_engineering: parseInt(rawData.max_engineering) || 0,
        max_finance: parseInt(rawData.max_finance) || 0,
        used_top_management: parseInt(rawData.used_top_management) || 0,
        used_procurement: parseInt(rawData.used_procurement) || 0,
        used_engineering: parseInt(rawData.used_engineering) || 0,
        used_finance: parseInt(rawData.used_finance) || 0
      };

      res
        .status(200)
        .json({
          status: 1,
          data: limitsData,
          message: "Account limits retrieved successfully",
        })
        .end();

    } catch (error) {
      console.error("Error getting buyer account limits:", error);
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


};

// this is the function where new vendor is adding for review 

// validation check for buyer who is adding the excel sheet for adding the vendor
const validateBulkVendorInputs = (vendorName, email, mobile, productList) => {
  let errors = [];

  // Function to validate product list format allowing a trailing comma

  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const isValidPhoneNumber = (phone) => {
    return phone.toString().length > 15 ? true : false;
  };

  // checking the vendor name
  if (!vendorName) {
    errors.push("Missing Vendor Name");
  }

  // checking vendor email
  if (!email) {
    errors.push('Missing Vendor Email');
  } else if (!isValidEmail(email)) {
    errors.push('Invalid Vendor Email');
  }

  // checking mobile number
  if (!mobile) {
    errors.push('Missing Vendor Contact Number');
  } else if (isValidPhoneNumber(mobile)) {
    errors.push('Invalid Vendor Contact Number (not more then 15 digit)');
  }

  // checking product list
  if (!productList) {
    errors.push('Missing Product List')
  }

  // Checking product list
  if (!productList) {
    errors.push('Missing Product List');
    // } else if (!isValidProductList(productList)) { // Added validation for product list
    //   errors.push('Invalid Product List (should be a string of items separated by commas, e.g., "p1,p2,p3" or "p1,p2,p3,")');
    // }
  }

  return errors;

}


export default UsersController;
