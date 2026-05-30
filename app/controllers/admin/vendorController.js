import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

import vendorModel from '../../models/vendorModel.js';
import rfqModel from '../../models/rfqModel.js';
import notificationModel from '../../models/notificationModel.js';
import productModel from '../../models/productModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';

import Config from '../../config/app.config.js';
import {
  logError,
  sendMail,
  generatePassword,
  notificationMail,
  addDefaultNotifications
} from '../../helper/common.js';
import { logger } from '../../util/logger.js';
// import jwtHelper from '../../helper/jwtHelper.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import moment from 'moment';
import userModel from '../../models/userModel.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import { isNumber } from 'razorpay/dist/utils/razorpay-utils.js';
import { pgp } from '../../config/dbConn.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';

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
      let page, limit, offset, organization, verified, name, email, status, source, subscription_plan, is_private, dateFrom, dateTo, created_by , mobile;
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
      source = req?.query?.source || null;
      subscription_plan = req?.query?.subscription_plan ?? null;
      is_private = req?.query?.is_private || null;
      mobile = req.query.mobile || null;

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
        is_hospitality,
        source,
        subscription_plan,
        is_private,
        mobile
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
        is_hospitality,
        source,
        subscription_plan,
        is_private,
        mobile
      );

      // Enrich vendor list with subscription counts
      if (vendorList && vendorList.length > 0) {
        const vendorIds = vendorList.map(v => v.id);
        const subCounts = await hospitalityModel.getVendorSubscriptionCounts(vendorIds);
        const countMap = {};
        subCounts.forEach(sc => { countMap[sc.vendor_id] = sc; });
        vendorList = vendorList.map(v => ({
          ...v,
          active_categories: parseInt(countMap[v.id]?.active_categories || 0),
          active_hotels: parseInt(countMap[v.id]?.active_hotels || 0),
          subscription_status: countMap[v.id]?.subscription_status || 'none'
        }));
      }

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
        subscription_plan,
        spocs,
        vendor_access_type: vendorAccessTypeRaw,
        buyer_company_ids: buyerCompanyIdsRaw,
        is_hospitality,
        locations
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
        source : "admin",
        subscription_plan : subscription_plan || "Free",
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
      let company_locations = [];
      if(locations && locations.length > 0){
       company_locations = locations?.map(loc => ({
        country_id: Number(loc.country) || null,
        state_id: Number(loc.state) || null,
        city_id: Number(loc.city) || null,
        postal_code: Number(loc.postal_code) || null,
        address: loc.address || null,

        company_id: companyId || null,
        created_by: req.user.id,
        created_at: new Date(),
        updated_at: new Date(),
      }));}
      const companyLocationCS = new pgp.helpers.ColumnSet([
        'country_id',
        'state_id',
        'city_id',
        'postal_code',
        'address',
        'company_id',
        'created_by',
        'created_at',
        'updated_at'
      ], { table: 'tbl_company_location' });

      if(company_locations && company_locations.length > 0){
        const result = await rfqModel.insertArray(company_locations ,companyLocationCS ,  'tbl_company_location');
      }

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
                We are pleased to inform you that <strong>${companyNames}</strong> has added you as a preferred vendor on the Phileein Hospitality platform.
                Going forward, <strong>${companyNames}</strong> will manage their procurement activities through Phileein Hospitality.
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
              <a href="https://hospitality.letsworkwise.com"
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
            subject: `${companyNames} Added You on Phileein Hospitality`,
            html: dynamicHTML
          });

          dispatchNotification({
            userIds: [vendorId],
            category: 'account',
            type: 'vendor_added_by_buyer',
            title: `${companyNames} added you as a vendor`,
            body: `You can now receive RFQs from ${companyNames}. Log in to manage enquiries.`,
            data: { vendor_id: vendorId, buyer_company_ids: buyerCompanyIds || [] },
            actionUrl: 'https://hospitality.letsworkwise.com'
          }).catch((err) => logError('dispatch vendor_added_by_buyer failed', err));
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

            dispatchNotification({
              userIds: [vendorId],
              category: 'account',
              type: 'vendor_self_registered',
              title: 'Welcome to Phileein Hospitality',
              body: `Your account is under review. We'll notify you once it's approved.`,
              data: { vendor_id: vendorId },
              actionUrl: 'https://hospitality.letsworkwise.com'
            }).catch((err) => logError('dispatch vendor_self_registered failed', err));
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
      const subscriptionMappings = await hospitalityModel.getVendorSubscriptionMappingsAdmin(vendorId);
      const mappedCompanies = await vendorModel.getVendorCompanyMappings(vendorId);
      const vendorDocuments = await userModel.getVendorDocuments(vendorId);

      let companyLocations = [];
      if (vendorDetails?.[0]?.company_id) {
        companyLocations = await rfqModel.findAll(
          'tbl_company_location',
          { company_id: vendorDetails[0].company_id }
        );
      }

      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails,
          companyDetails: companyDetails || [],
          spocDetails: spocDetails || [],
          subscriptionMappings,
          mappedCompanies: mappedCompanies || [],
          companyLocations: companyLocations || [],
          vendorDocuments: vendorDocuments || []
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
      let companyLocations = await rfqModel.findAll(
        'tbl_company_location',
         {
          company_id : vendorDetails[0].company_id
         }
      )
      
      let files = await vendorModel.getFiles(vendorId);
      let spocDetails = await vendorModel.getSpocDetails(vendorId, false); // Show all SPOCs regardless of status
      let mappedCompanies = await vendorModel.getVendorCompanyMappings(vendorId);
      let vendorDocuments = await userModel.getVendorDocuments(vendorId);
      resObj.spocDetails = spocDetails;
      resObj.vendorDetails = vendorDetails[0];
      resObj.companyDetails = companyDetails[0];
      resObj.files = files || [];
      resObj.companyLocations = companyLocations || [];
      resObj.vendorDocuments = vendorDocuments || [];
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
      resObj.subscriptionMappings = await hospitalityModel.getVendorSubscriptionMappingsAdmin(vendorId);
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
 getVendorLocations: async (req, res, next) => {
  try {
    const company_id = req.params.id;

    // console.log("company_id", company_id)
    let locations;
    const user_type = req.user.user_type; // Get the user type from the request object

    if(user_type ==3 || user_type == 1){
      // If the user is a vendor, ensure to pick the spocs as well.
    locations = await vendorModel.getLocationsByCompanyId(company_id, user_type);

    }
    else{
    locations = await vendorModel.getLocationsByCompanyId(company_id);
  }
    return res.status(200).json({
      status: 1,
      data: locations
    });
  } catch (error) {
    logError(error);
    return res.status(400).json({
      status: 3,
      message: Config.errorText.value
    });
  }
},
 addVendorLocation: async (req, res, next) => {
    try {
      const { company_id, address, postal_code, city, state, country } = req.body;
      const locationData = {
        company_id,
        address,
        postal_code,
        city_id : city,
        state_id :state,
        country_id : country,
        created_by: req.user.id,
      };
      await rfqModel.insert('tbl_company_location', locationData);
      return res.status(200).json({
        status: 1,
        message: 'Location added successfully'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },
  updateVendorLocation: async (req, res, next) => {
    try {
      const { id, company_id, address, postal_code, city, state, country } = req.body;
      const locationData = {
        company_id,
        address,
        postal_code : Number(postal_code) || null,
        city_id : Number(city) || null,
        state_id : Number(state) || null, 
        country_id : Number(country) || null,
        updated_by: req.user.id,
      };

      logger.debug('updateVendorLocation locationData:', locationData)
      await rfqModel.update('tbl_company_location', locationData, id);

      return res.status(200).json({
        status: 1,
        message: 'Location updated successfully'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },
  deleteVendorLocation: async (req, res, next) => {
    try {
      const location_id = req.params.id;
      const deleted = await rfqModel.delete('tbl_company_location', { id: Number(location_id) });
      return res.status(200).json({
        status: 1,
        message: 'Location deleted successfully'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  mapSpocToLocation : async (req, res, next) => {
    try {
      const { spoc_id, location_id } = req.body;
       
      if (!spoc_id || !location_id) {
        return res.status(400).json({
          status: 3,
          message: 'Please provide spoc_id and location_id'
        });
      }
             //Delete the existing mapping if there any
              await rfqModel.delete('tbl_spoc_location_mapping', { location_id });

             //Insert the new mapping
              const spocLocationCS = new pgp.helpers.ColumnSet(
              ["spoc_id", "location_id", "assigned_by"],
              { table: "tbl_spoc_location_mapping" }
            );

            let locationData = [];

            for (const spoc of spoc_id) {
              locationData.push({
                spoc_id: spoc,
                location_id,
                assigned_by: req.user.id,
              });
            }

            await rfqModel.insertArray(
              locationData,
              spocLocationCS,
              "tbl_spoc_location_mapping"
            );


   
      return res.status(200).json({
        status: 1,
        message: 'Location mapped successfully'
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
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
        pan,
        msme,
        bank_name,
        bank_account_number,
        ifsc_code,
        account_holder_name,
        turn_over,
        total_employees,
        about_vendor_company,
        subscription,
        subscription_plan,
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
        subscription_plan_id : subscription_plan || null,
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

      // Save PAN, MSME, bank details to tbl_vendor_documents (not tbl_company)
      if (pan) {
        await userModel.saveVendorDocument(vendorId, 'pan', null, pan);
      }
      if (msme) {
        await userModel.saveVendorDocument(vendorId, 'msme', null, msme);
      }
      if (bank_name || bank_account_number || ifsc_code || account_holder_name) {
        await userModel.saveVendorDocument(vendorId, 'bank_account', null, null, {
          bank_name: bank_name || null,
          bank_account_number: bank_account_number || null,
          ifsc_code: ifsc_code || null,
          account_holder_name: account_holder_name || null
        });
      }

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

      dispatchNotification({
        userIds: [vendorId],
        category: 'account',
        type: status == 0 ? 'vendor_disapproved' : 'vendor_approved',
        title: status == 0
          ? 'Your registration was not approved'
          : 'Your registration has been approved',
        body: status == 0
          ? 'Please contact support if you believe this is in error.'
          : 'You can now receive enquiries and submit quotes.',
        data: { vendor_id: vendorId, status },
        actionUrl: 'https://hospitality.letsworkwise.com'
      }).catch((err) => logError('dispatch vendor_approval_status failed', err));

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
    logError('Error in getVendorProfileDocuments', error);
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
    logError('Error updating vendor document', error);
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
        logger.debug('Adding new spoc');
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

  // ── Vendor Subscription Management ──────────────────────────

  getVendorSubscriptions: async (req, res) => {
    try {
      const vendorId = req.params.id;
      const data = await hospitalityModel.getVendorSubscriptionMappingsAdmin(vendorId);
      res.status(200).json({ status: 1, data });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  upsertVendorSubscriptions: async (req, res) => {
    try {
      const vendorId = parseInt(req.params.id);
      const { subscriptions } = req.body;
      if (!subscriptions || !subscriptions.length) {
        return res.status(400).json({ status: 0, message: 'No subscriptions provided' });
      }
      const rows = subscriptions.map(s => ({
        vendor_id: vendorId,
        item_type: s.item_type,
        item_id: parseInt(s.item_id),
        fee_amount: parseFloat(s.fee_amount) || 0,
        start_date: s.start_date,
        end_date: s.end_date,
        status: s.status || 'active',
        payment_id: s.payment_id || null
      }));
      const result = await hospitalityModel.createVendorHotelCategorySubscription(rows);

      // Auto-map variants for category and subcategory subscriptions (same as registration flow)
      const allCategoryIds = rows
        .filter(r => r.item_type === 'category' || r.item_type === 'subcategory')
        .map(r => r.item_id);

      if (allCategoryIds.length > 0) {
        try {
          const variants = await rfqModel.getProductsByCategories(
            allCategoryIds.map(id => ({ id }))
          );
          if (variants && variants.length > 0) {
            const mappings = variants.map(v => ({
              variant_id: v.variant_id,
              vendor_id: vendorId,
              approved_by: [],
              make_list: []
            }));
            await productModel.bulkInsertVariantVendorMappings(mappings, vendorId);

            // Auto-approve the new mappings
            const variantIds = [...new Set(
              variants.map(v => parseInt(v.variant_id)).filter(Boolean)
            )];
            if (variantIds.length) {
              await productModel.autoApproveVariantMappings(vendorId, variantIds);
            }
          }
        } catch (mappingError) {
          logError(mappingError);
          // Don't fail subscription save if variant mapping fails
        }
      }

      res.status(200).json({ status: 1, data: result, message: 'Subscriptions saved successfully' });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  updateSubscriptionStatus: async (req, res) => {
    try {
      const { sub_id } = req.params;
      const { status } = req.body;
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ status: 0, message: 'Invalid status. Must be active or inactive.' });
      }
      const updated = await hospitalityModel.updateVendorSubscriptionStatus(sub_id, status);
      res.status(200).json({ status: 1, data: updated, message: 'Status updated' });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  deleteSubscription: async (req, res) => {
    try {
      const vendorId = parseInt(req.params.id);
      const { sub_id } = req.params;

      // Get subscription details before deleting to know what to unmap
      const subscription = await hospitalityModel.getSubscriptionById(sub_id);

      const rowCount = await hospitalityModel.deleteVendorSubscription(sub_id);
      if (rowCount === 0) {
        return res.status(404).json({ status: 2, message: 'Subscription not found' });
      }

      // If it was a category or subcategory subscription, clean up variant mappings
      if (subscription && (subscription.item_type === 'category' || subscription.item_type === 'subcategory')) {
        try {
          const categoryId = subscription.item_id;
          const variants = await rfqModel.getProductsByCategories([{ id: categoryId }]);

          if (variants && variants.length > 0) {
            const variantIds = variants.map(v => parseInt(v.variant_id)).filter(Boolean);

            // Check which variants are covered by OTHER active category subscriptions
            const otherActiveCategories = await hospitalityModel.getActiveCategorySubscriptions(vendorId, categoryId);

            if (otherActiveCategories.length > 0) {
              const otherCategoryIds = otherActiveCategories.map(c => c.item_id);
              const coveredVariants = await rfqModel.getProductsByCategories(
                otherCategoryIds.map(id => ({ id }))
              );
              const coveredVariantIds = new Set(
                coveredVariants.map(v => parseInt(v.variant_id))
              );
              // Only remove variants NOT covered by other active categories
              const uncoveredVariantIds = variantIds.filter(id => !coveredVariantIds.has(id));

              if (uncoveredVariantIds.length > 0) {
                await productModel.removeVariantMappingsForVendor(vendorId, uncoveredVariantIds);
              }
            } else {
              // No other active categories covering these variants - remove all
              await productModel.removeVariantMappingsForVendor(vendorId, variantIds);
            }
          }
        } catch (mappingError) {
          logError(mappingError);
          // Don't fail deletion if variant cleanup fails
        }
      }

      res.status(200).json({ status: 1, message: 'Subscription deleted' });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  getHotelsDropdown: async (req, res) => {
    try {
      const hotels = await hospitalityModel.getAllHotelsForAdmin();
      res.status(200).json({ status: 1, data: hotels });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },

  getCategoriesDropdown: async (req, res) => {
    try {
      const categories = await productModel.getCategoryDropdown(500, 0);
      res.status(200).json({ status: 1, data: categories });
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value });
    }
  },
};
export default vendorController;
