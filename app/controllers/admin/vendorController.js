import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

import vendorModel from '../../models/vendorModel.js';
import rfqModel from '../../models/rfqModel.js';
import notificationModel from '../../models/notificationModel.js';
import productModel from '../../models/productModel.js';

import Config from '../../config/app.config.js';
import {
  logError,
  sendMail,
  generatePassword,
  notificationMail,
  addDefaultNotifications
} from '../../helper/common.js';
// import jwtHelper from '../../helper/jwtHelper.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import moment from 'moment';
import userModel from '../../models/userModel.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const normalizeVendorAccessType = (value, fallback = null) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = value.toString().toLowerCase();
  if (normalized === 'private') {
    return 'private';
  }
  if (normalized === 'public') {
    return 'public';
  }
  return fallback;
};

const extractBuyerCompanyIds = (input) => {
  if (input === undefined) {
    return { provided: false, ids: [] };
  }

  if (input === null || input === '') {
    return { provided: true, ids: [] };
  }

  let ids = [];

  if (Array.isArray(input)) {
    ids = input
      .map((item) => parseInt(item, 10))
      .filter((item) => !Number.isNaN(item));
  } else if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((item) => parseInt(item, 10))
          .filter((item) => !Number.isNaN(item));
      } else if (!Number.isNaN(parseInt(parsed, 10))) {
        ids = [parseInt(parsed, 10)];
      }
    } catch (error) {
      ids = input
        .split(',')
        .map((item) => parseInt(item.trim(), 10))
        .filter((item) => !Number.isNaN(item));
    }
  } else {
    const parsedId = parseInt(input, 10);
    if (!Number.isNaN(parsedId)) {
      ids = [parsedId];
    }
  }

  ids = [...new Set(ids)];
  return { provided: true, ids };
};

const vendorController = {
  vendorList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name, email, status, dateFrom, dateTo, created_by;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      
      // Extract all filter parameters
      name = req.query.name || null;
      organization = req.query.organization || null;
      verified = req.query.verified || null;
      email = req.query.email?.toLowerCase() || null;
      status = req.query.status !== undefined ? parseInt(req.query.status) : null;
      dateFrom = req.query.date_from || null;
      dateTo = req.query.date_to || null;
      created_by = req.query.created_by || null;
      const is_hospitality = req.query.is_hospitality !== undefined ? parseInt(req.query.is_hospitality) : null;

      let vendorList = await vendorModel.getVendorList(
        limit,
        offset,
        organization,
        verified,
        name,
        email,
        status,
        dateFrom,
        dateTo,
        created_by,
        is_hospitality
      );

      let vendorCount = await vendorModel.getVendorListCount(
        organization,
        verified,
        name,
        email,
        status,
        dateFrom,
        dateTo,
        created_by,
        is_hospitality
      );

      res
        .status(200)
        .json({
          status: 1,
          data: vendorList,
          total_count: vendorCount?.total_vendors,
          deactivated_vendors: vendorCount?.deactivated_vendors,
          active_vendors: vendorCount?.active_vendors,
          deleted_vendors: vendorCount?.deleted_vendors,
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
  addVendor: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const {
        name,
        mobile,
        organization_name,
        address,
        postal_code,
        city,
        state,
        country,
        website,
        nature_business,
        estd_year,
        gstin,
        import_export_code,
        cin,
        turn_over,
        total_employees,
        about_vendor_company,
        subscription,
        spocs,
        vendor_access_type: vendorAccessTypeRaw,
        buyer_company_ids: buyerCompanyIdsRaw,
        is_hospitality
      } = req.body;
      const email = req.body.email?.toLowerCase() || '';

      const vendorAccessType = normalizeVendorAccessType(
        vendorAccessTypeRaw,
        'public'
      );
      const { ids: buyerCompanyIds } = extractBuyerCompanyIds(
        buyerCompanyIdsRaw
      );
      
      let cleanedMobile = mobile || null;
      if (cleanedMobile) {
        cleanedMobile = cleanedMobile.toString().replace(/^\+\d+\-\+\d+/, '+91');
        // Ensure it fits within the database limit
        cleanedMobile = cleanedMobile.substring(0, 15);
      }
      
      let orgChar = organization_name
        .match(/[a-zA-Z]/g)
        .join('')
        .toLowerCase();
      let capitalizeFourOrganizationLetter = `${orgChar
        .charAt(0)
        .toUpperCase()}${orgChar.substring(1, 4)}`;
      let password = `${capitalizeFourOrganizationLetter}@${cleanedMobile.substring(
        6,
        10
      )}`;

      let vendorObj = {
        name: name || null,
        email: email || null,
        address: address || null,
        city: city || null,
        state: state || null,
        country: country || 1,
        mobile: cleanedMobile || null,
        postal_code: postal_code || null,
        user_type: '3',
        password: generatePassword(password),
        status: '0',
        created_by: createdBy,
        organization_name: organization_name || null
      };

      let companyObj = {
        profile: about_vendor_company || null,
        logo: req.files.logo?.[0]?.location || null,
        company_name: organization_name || null,
        nature_of_business: nature_business || null,
        established_year: estd_year || null,
        gstin: gstin || null,
        import_export_code: import_export_code || null,
        cin: cin || null,
        turnover: turn_over || null,
        no_of_employess: total_employees || null,
        website: website || null,
        is_private: vendorAccessType === 'private' ? 1 : 0,
        is_hospitality: is_hospitality === 1 || is_hospitality === '1' || is_hospitality === true || is_hospitality === 'true' ? 1 : 0
      };


      const registrationResult = await userModel.company_registration(vendorObj, companyObj);
      const vendorId = registrationResult.user_id;
      const companyId = registrationResult.company_id;

      // let vendor = await productModel.vendor_register(vendorObj);

    // Check if spocs array is provided and has valid objects
if (Array.isArray(spocs) && spocs.length > 0) {
  // Iterate through each SPOC object in the array
  for (const spoc of spocs) {
    // Validate if at least one field in the SPOC is not empty
    if (spoc.spoc_email || spoc.spoc_name) {
      // Add vendor ID to the SPOC object
      spoc.user_id = vendorId;
      // Insert the SPOC details into the table
      await vendorModel.add_user_spoc(spoc);
    }
  }
}


      if (req.files?.ptr_track && req.files?.ptr_track.length > 0) {
        const pathname = req.files.ptr_track[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.ptr_track[0].originalname || null,
          doc_type: 'ptr',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }
      
      if(subscription && subscription != '-1') {
        const doesSubscriptionExist = await subscriptionModel.subscriptionIdExist(subscription, '3');
        if(doesSubscriptionExist && doesSubscriptionExist.length > 0) {
          const x = doesSubscriptionExist[0].duration;

          let today = dateFormat(new Date(), 'yyyy-mm-dd');
          const todayInMoment = moment(today);
          const endDate = todayInMoment.clone().add(x, 'months').subtract(1, 'day').format('YYYY-MM-DD');
          const renewDate = todayInMoment.clone().add(x, 'months').format('YYYY-MM-DD');

          let UserSubscriptionObj = {
            user_id: vendorId,
            plan_id: doesSubscriptionExist[0].id,
            status: 1, // payment pending
            start_date: today,
            end_date: endDate,
            renew_date: renewDate
          };

          let createUserSubscription =
            await subscriptionModel.createUserSubscription(UserSubscriptionObj);
          
          await userModel.updateUserAccount(vendorId, { subscription_plan_id: doesSubscriptionExist[0].id })
        }
      }

      addDefaultNotifications(vendorId);

      if (buyerCompanyIds && buyerCompanyIds.length > 0) {
        await vendorModel.replaceVendorCompanyMappings(
          vendorId,
          buyerCompanyIds,
          createdBy
        );
      } else {
        await vendorModel.replaceVendorCompanyMappings(vendorId, [], createdBy);
      }

      if (vendorId) {
        const companyMappings = await vendorModel.getVendorCompanyMappings(vendorId);
        const hasCompanyMappings = companyMappings && companyMappings.length > 0;

        if (hasCompanyMappings) {
          const companyNames = companyMappings
            .map(m => m.company_name)
            .filter(Boolean)
            .join(', ');
          
          const vendorName = name || organization_name || 'Vendor';
          const spocList = await vendorModel.getSpocDetails(vendorId);

          const headerContent = `<h2>Hello ${vendorName},</h2>`;

          const containerContent = `
            <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
              <p>
                We are pleased to inform you that <strong>${companyNames}</strong> has added you as a preferred vendor on the Workwise platform.
                Going forward, <strong>${companyNames}</strong> will manage their procurement activities through Workwise.
              </p>
              <p>
                To ensure you receive all enquiries promptly, Login to your account.
                Your login credentials are provided below:
              </p>
              <p><strong>Email:</strong> ${email || '[Vendor Email]'}</p>
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

          const dynamicHTML = generateEmailTemplate(headerContent, containerContent);

          sendMail({
            from: `${companyNames} ${Config.masterEmail}`,
            to: spocList?.length ? spocList.map(spoc => spoc.email) : email,
            cc: spocList?.length ? email : '',
            subject: `${companyNames} Added You on Workwise`,
            html: dynamicHTML
          });
        } else {
          const emailHeader = ` <h2>Dear ${name} </h2>`
              
          const emailContent = `
               <div style="font-size:16px; font-family: 'Roboto', sans-serif;">
                 <p>Thank you for registering with us! Your login credentials are as follows:</p>
                    <ul style="list-style-type: none; padding: 0;">
                     <li><strong>Email:</strong> ${email}</li>
                     <li><strong>Password:</strong> ${password}</li>
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
                to: email
            };

            sendMail(mailRecipients);
        }

        res
          .status(200)
          .json({
            status: 1,
            message: 'Vendor successfully added'
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
  vendorDetails: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      const companyDetails = await userModel.getCompanyDetail(vendorId);
      const spocDetails = await vendorModel.getSpocDetails(vendorId);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails,
          companyDetails: companyDetails || [],
          spocDetails: spocDetails || []
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
  vendor_edit_details: async (req, res, next) => {
    try {
      let resObj = {};
      let vendorId = req.params.id;
      let vendorDetails = await vendorModel.getVendoreditDetails(vendorId);
      let companyDetails = await userModel.getCompanyDetail(vendorId);
      let files = await vendorModel.getFiles(vendorId);
      let spocDetails = await vendorModel.getSpocDetails(vendorId, false); // Show all SPOCs regardless of status
      let mappedCompanies = await vendorModel.getVendorCompanyMappings(vendorId);
      resObj.spocDetails = spocDetails;
      resObj.vendorDetails = vendorDetails[0];
      resObj.companyDetails = companyDetails[0];
      resObj.files = files || [];
      resObj.mappedCompanies = mappedCompanies || [];
      const companyIsPrivate =
        companyDetails &&
        companyDetails[0] &&
        (companyDetails[0].is_private === 1 ||
          companyDetails[0].is_private === '1');
      const companyIsHospitality =
        companyDetails &&
        companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 ||
          companyDetails[0].is_hospitality === '1');
      resObj.vendorAccessType = companyIsPrivate ? 'private' : 'public';
      resObj.isHospitality = companyIsHospitality ? 1 : 0;
      res
        .status(200)
        .json({
          status: 1,
          data: resObj
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
  deleteVendor: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let updatedBy = req.user.id;
      await vendorModel.deleteVendor(vendorId, updatedBy);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Vendor successfully deleted'
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
  blockVendor: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let updatedBy = req.user.id;
      let status = req.body.status;
      status = status == 1 ? 2 : 1;
      await vendorModel.blockVendor(vendorId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Vendor successfully ${status == 1 ? 'unblocked' : 'blocked'
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
  updateVendor: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let updatedBy = req.user.id;
      const {
        name,
        mobile,
        organization_name,
        address,
        postal_code,
        city,
        state,
        country,
        website,
        nature_business,
        estd_year,
        gstin,
        import_export_code,
        cin,
        turn_over,
        total_employees,
        about_vendor_company,
        subscription,
        vendor_access_type: vendorAccessTypeRaw,
        buyer_company_ids: buyerCompanyIdsRaw,
        is_hospitality
      } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      const targetAccessType = normalizeVendorAccessType(
        vendorAccessTypeRaw,
        null
      );
      const {
        provided: buyerCompanyIdsProvided,
        ids: buyerCompanyIds
      } = extractBuyerCompanyIds(buyerCompanyIdsRaw);

      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      let companyDetails = await userModel.getCompanyDetail(vendorId);
      
      const existingIsPrivate =
        companyDetails &&
        companyDetails[0] &&
        (companyDetails[0].is_private === 1 ||
          companyDetails[0].is_private === '1')
          ? 1
          : 0;
      const resolvedIsPrivate =
        targetAccessType === 'private'
          ? 1
          : targetAccessType === 'public'
            ? 0
            : existingIsPrivate;

      const existingIsHospitality =
        companyDetails &&
        companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 ||
          companyDetails[0].is_hospitality === '1')
          ? 1
          : 0;
      const resolvedIsHospitality =
        is_hospitality !== undefined && is_hospitality !== null && is_hospitality !== ''
          ? (is_hospitality === 1 || is_hospitality === '1' || is_hospitality === true || is_hospitality === 'true' ? 1 : 0)
          : existingIsHospitality;

      let existingMappedCompanyIds = [];
      if (!buyerCompanyIdsProvided) {
        const existingMappings = await vendorModel.getVendorCompanyMappings(
          vendorId
        );
        existingMappedCompanyIds = existingMappings
          .map((item) => parseInt(item.company_id, 10))
          .filter((item) => !Number.isNaN(item));
      }

      let companyIdsToMap = buyerCompanyIdsProvided
        ? buyerCompanyIds
        : existingMappedCompanyIds;
      companyIdsToMap = companyIdsToMap
        .map((item) => parseInt(item, 10))
        .filter((item) => !Number.isNaN(item));
      // let vendorObj = {
      //   name: name || vendorDetails[0].name,
      //   email: email || vendorDetails[0].email,
      //   address: address || vendorDetails[0].address,
      //   city: city || vendorDetails[0].city,
      //   state: state || vendorDetails[0].state,
      //   country: country || vendorDetails[0].country,
      //   mobile: mobile || vendorDetails[0].mobile,
      //   postal_code: postal_code || vendorDetails[0].postal_code,
      //   updated_by: updatedBy,
      //   organization_name:
      //     organization_name || vendorDetails[0].organization_name
      // };
      let vendorObj = {
        id: parseInt(vendorId) || null,
        name : name || null,
        email : email || null,
        address : address || null,
        city : city || null ,
        state : state || null,
        country : country || null ,
        mobile : mobile || null,
        postal_code: postal_code || null ,
        organization_name: organization_name || null,
        updated_by : updatedBy || null
      }
      let companyObj = {
        profile: about_vendor_company || null,
        logo: req.files.logo?.[0]?.location || null,
        company_name: organization_name || null,
        nature_of_business: nature_business || [],
        established_year: estd_year || null,
        gstin: gstin || null,
        import_export_code: import_export_code || null,
        cin: cin || null,
        turnover: turn_over || null,
        no_of_employess: total_employees || null,
        website: website || null,
        is_private: resolvedIsPrivate,
        is_hospitality: resolvedIsHospitality
      };

      const result = await userModel.update_companyDetails(vendorObj, companyObj);

      if (subscription) {
        const condition = `user_id = ${parseInt(
          vendorId
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

          await userModel.updateUserAccount(vendorId, {
            subscription_plan_id: null
          });
        }
        
        if (subscription != '-1') {
          const doesSubscriptionExist = await subscriptionModel.subscriptionIdExist(subscription, '3');
          if(doesSubscriptionExist && doesSubscriptionExist.length > 0) {
            const x = doesSubscriptionExist[0].duration;

            let today = dateFormat(new Date(), 'yyyy-mm-dd');
            const todayInMoment = moment(today);
            const endDate = todayInMoment.clone().add(x, 'months').subtract(1, 'day').format('YYYY-MM-DD');
            const renewDate = todayInMoment.clone().add(x, 'months').format('YYYY-MM-DD');

            let UserSubscriptionObj = {
              user_id: vendorId,
              plan_id: doesSubscriptionExist[0].id,
              status: 1, // payment pending
              start_date: today,
              end_date: endDate,
              renew_date: renewDate
            };

            await subscriptionModel.createUserSubscription(UserSubscriptionObj);
            
            await userModel.updateUserAccount(vendorId, { subscription_plan_id: doesSubscriptionExist[0].id })
          }
        }
      }

      await vendorModel.replaceVendorCompanyMappings(
        vendorId,
        companyIdsToMap,
        updatedBy
      );

      // let companyDetails = await userModel.getCompanyDetail(vendorId);

      // if (companyDetails.length > 0) {
      //   let companyObj = {
      //     profile: about_vendor_company || companyDetails[0].profile,
      //     logo:
      //       req.files?.logo
      //         ? req.files?.logo[0].location
      //         : companyDetails[0].logo,
      //     website: website || vendorDetails[0].website,
      //     company_name: organization_name || companyDetails[0].company_name,
      //     nature_of_business:
      //       nature_business || companyDetails[0].nature_of_business,
      //     established_year: estd_year || companyDetails[0].established_year,
      //     gstin: gstin || companyDetails[0].gstin,
      //     import_export_code:
      //       import_export_code || companyDetails[0].import_export_code,
      //     cin: cin || companyDetails[0].cin,
      //     turnover: turn_over || companyDetails[0].turnover,
      //     no_of_employess: total_employees || companyDetails[0].no_of_employess,
      //   };

      //   await productModel.updateCompany(companyObj);
      // } else {
      //   let companyObj = {
      //     profile: about_vendor_company || null,
      //     logo:
      //       req.files?.logo && req.files?.logo.length > 0
      //         ? `${Config.download_url}/user_image/${req.files.logo[0].filename}`
      //         : null,
      //     email: email || null,
      //     mobile: mobile || null,
      //     company_name: organization_name || null,
      //     nature_of_business: nature_business || null,
      //     website: website || vendorDetails[0].website,
      //     established_year: estd_year || null,
      //     gstin: gstin || null,
      //     import_export_code: import_export_code || null,
      //     cin: cin || null,
      //     turnover: turn_over || null,
      //     no_of_employess: total_employees || null,
      //   };
      //   companyObj.user_id = vendorId;
      //   await productModel.addCompany(companyObj);
      // }

      if (req.files?.ptr_track && req.files?.ptr_track.length > 0) {
        const pathname = req.files.ptr_track[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.ptr_track[0].originalname || null,
          doc_type: 'ptr',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }
      if(result)
      {
         res
        .status(200)
        .json({
          status: 1,
          message: 'Vendor successfully updated'
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
  approveVendor: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let vendorId = req.params.id;
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

      await vendorModel.approveVendor(vendorId, updatedBy, status, reasonId);

      let userDetail = await vendorModel.userDetailById(vendorId);
      let html_variables = [{ name: userDetail[0].name }];
      let dynamic_html = '';
      if (status == 1) {
        dynamic_html = fs
          .readFileSync(`${Config.template_path}/user_register_template.txt`)
          .toString();
      } else {
        dynamic_html = fs
          .readFileSync(`${Config.template_path}/user_disapprove_template.txt`)
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
        await notificationModel.findDynamicNotification(
          status == 0
            ? 'vendor_registration_rejected_notification'
            : 'vendor_registration_approval_notification'
        );

      if (
        findDynamicNotification.length > 0 &&
        findDynamicNotification[0].notification_type == 1
      ) {
        notificationMail({
          from: Config.webmasterMail, // sender address
          to: userDetail[0].email, // list of receivers
          subject: findDynamicNotification[0].title, // Subject line
          html: findDynamicNotification[0].content // plain text body
        });
      } else {

        
        const spocList = await vendorModel.getSpocDetails(vendorId)

        // console.log(" vendor contoller 690 spoc console ", vendorId, spocList)

              
        let mailRecipients = {
          from: Config.webmasterMail,
          subject: `Work Wise | Registration`,
          html: dynamic_html
        };
  
        if (spocList && spocList.length > 0) {
          mailRecipients.to = spocList.map(spoc => spoc.email);
          mailRecipients.cc = userDetail[0].email;
        } else {
          mailRecipients.to = userDetail[0].email;
        }

        sendMail(mailRecipients);

      }

      res
        .status(200)
        .json({
          status: 1,
          message: `Vendor successfully ${status == 0 ? 'Disapproved' : 'Approved'
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

  getVendorProfileDocuments: async (req, res, next) => {
  try {
    const user_type = req.user.user_type;

    // 🔹 Only allow admin (user_type = 1)
    if (user_type !== 1) {
      return res.status(403).json({
        status: 0,
        message: "Unauthorized access"
      });
    }

    // 🔹 Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { data, total } = await userModel.getAllVendorAssets({ limit, offset });

    return res.status(200).json({
      status: 1,
      data,
      total_items: total,
      total_pages: Math.ceil(total / limit),
      current_page: page
    });
  } catch (error) {
    console.error("Error in getVendorProfileDocuments:", error);
    logError(error);
    return res.status(500).json({
      status: 3,
      message: Config.errorText.value
    });
  }
 },

  approveVendorProfileDocuments: async (req, res, next) => {
  try {
    const { id, is_approved } = req.body;

    const user_id = req.user.id;  //for approval 

    

    // Prepare data for update
    const updateData = {
      is_approved: is_approved,
      approved_by : user_id
    };

    // Call the update model
    const result = await rfqModel.update(
      'tbl_vendor_profile', // table_name
      updateData,           // data to update
      id,                   // primary_key value   
    );

    // Check if update was successful
    if (result &&  result.length > 0) {
      res.status(200).json({
        status: 1,
        message: "Vendor profile document status updated successfully",
        data: result
      });
    } else {
      res.status(404).json({
        status: 0,
        message: "Document not found or no changes made"
      });
    }

  } catch (error) {
    console.error('Error updating vendor document:', error);
    res.status(500).json({
      status: 3,
      message: "Internal server error"
    });
  }
 },
  buyerCompanyDropdown: async (req, res, next) => {
    try {
      const search = req.query?.search || null;
      const limitParam = parseInt(req.query?.limit, 10);
      const limit = Number.isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);
      const dropdown = await vendorModel.getBuyerCompanyDropdown(search, limit);
      res
        .status(200)
        .json({
          status: 1,
          data: dropdown
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
  vendorDropdownList: async (req, res, next) => {
    const search = req.query.search;
    try {
      let vendorList = await vendorModel.getVendorDropdownList(search);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorList
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
  rejectReasonDropdownList: async (req, res, next) => {
    try {
      let type = req.query?.type || 1;
      let rejectReasonDropdownList = await vendorModel.rejectReasonDropdownList(
        type
      );
      res
        .status(200)
        .json({
          status: 1,
          data: rejectReasonDropdownList
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
  vendor_rfq_list: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getRfqByUser(limit, offset, vendorId);
      res
        .status(200)
        .json({
          status: 1,
          data: listRfq
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
  updateSpoc: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      const userId = req.params.id;
      const spocId = req.params.spoc_id;
      
      // Extract all possible fields
      const { spoc_name, spoc_email, spoc_mobile, spoc_role, status } = req.body;
 
      const name = spoc_name ?? null;
      const email = spoc_email?.toLowerCase() ?? null;
      const mobile = spoc_mobile ?? null;
      const role = spoc_role ?? null;
      const statusValue = status !== undefined ? parseInt(status) : null;

      // Validate status if provided
      if (statusValue !== null && ![0, 1, 2].includes(statusValue)) {
        err++;
        errors.invalid_status = 'Invalid status value. Must be 0 (disapproved), 1 (approved), or 2 (pending)';
      }

      // Only validate other fields if they are being updated
      if (name !== null || email !== null || mobile !== null || role !== null) {
        if (!name && !email && !mobile && !role) {
          err++;
          errors.empty_fields = 'All fields are empty or missing.';
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
        return;
      }

      const response = await vendorModel.updateUserSpoc(name, email, mobile, role, userId, spocId, statusValue);

      if (response.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            message: `SPOC ${response[0].name} updated successfully`
          })
          .end();
      } else {
        res
          .status(200)
          .json({
            status: 1,
            message: `No Update`
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
  deleteSpoc : async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      const userId = req.params.id;
      const spocId = req.params.spoc_id;

      if(!userId && !spocId){
        err++;
        errors.empty_fields = 'All fields are empty or missing.';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
        return;
      }
     const deletedSpoc = await vendorModel.deleteSpoc(userId, spocId);
     if (deletedSpoc) {
      res.status(200).json({
        status: 1,   
        message: 'spoc deleted successfully'
      }).end();
     }

    }
    catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,  
        message: Config.errorText.value
      }).end();
    }
    },


  addSpoc: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      const user_id = req.params.id;
      const { spoc_name, spoc_email, spoc_mobile, spoc_role } = req.body;
 
      const name = spoc_name ?? null;
      const email = spoc_email?.toLowerCase() ?? null;
      const mobile = spoc_mobile ?? null;
      const role = spoc_role ?? null;

      if (!name && !email && !mobile && !role) {
        err++;
        errors.empty_fields = 'All fields are empty or missing.';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
        return;
      }

      const spocExist = await vendorModel.check_exactly_same_spoc({spoc_name, spoc_email:spoc_email.toLowerCase(), spoc_mobile, spoc_role, user_id});

      if(spocExist<1){
        // Set initial status based on who's creating the SPOC
        // Auto-approve (status=1) if:
        // 1. Creator is admin (user_type=1)
        // 2. Creator is vendor (user_type=3)
        // 3. Creator is subadmin (user_type=5)
        // Otherwise, set as pending (status=2)
        const creatorType = parseInt(req.user.user_type ?? req.user.register_as ?? 0, 10);
        const initialStatus = [1, 3, 5].includes(creatorType) ? 1 : 2;

        const response = await vendorModel.add_user_spoc({
          spoc_name, 
          spoc_email: email,
          spoc_mobile, 
          spoc_role, 
          user_id,
          status: initialStatus,
          created_by: req.user.id
        });
        res
        .status(200)
        .json({
          status: 1,
          message: `${response[0].name} as ${response[0].role.toUpperCase()} role added to your spoc${initialStatus === 1 ? ' and auto-approved' : ''}`
        })
        .end();
      } else {
        res
        .status(200)
        .json({
          status: 1,
          message: `spoc already exist`
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
  getAdminUsers: async (req, res, next) => {
    try {
      const adminUsers = await vendorModel.getAdminUsers();
      res
        .status(200)
        .json({
          status: 1,
          data: adminUsers
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
  spocList: async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 10;
      const page = parseInt(req.query.page, 10) || 1;
      const offset = (page - 1) * limit;

      const spocs = await vendorModel.getAllSpocs(limit, offset);
      const total = spocs.length > 0 ? spocs[0].total_count : 0;
      res.status(200).json({
        status: 1,
        data: spocs,
        total,
        page,
        limit
      });
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },
};
export default vendorController;
