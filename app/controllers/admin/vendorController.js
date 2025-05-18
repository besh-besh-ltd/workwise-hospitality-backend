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
        created_by
      );

      let vendorCount = await vendorModel.getVendorListCount(
        organization,
        verified,
        name,
        email,
        status,
        dateFrom,
        dateTo,
        created_by
      );

      console.log('Filters:', { organization, verified, name, email, status, dateFrom, dateTo, created_by });

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
      console.log(req.files);
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
        ptr_project_name,
        ptr_project_description,
        ptr_project_start_date,
        ptr_project_end_date,
        about_vendor_company,
        spocs
      } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      let orgChar = organization_name
        .match(/[a-zA-Z]/g)
        .join('')
        .toLowerCase();
      let capitalizeFourOrganizationLetter = `${orgChar
        .charAt(0)
        .toUpperCase()}${orgChar.substring(1, 4)}`;
      let password = `${capitalizeFourOrganizationLetter}@${mobile.substring(
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
        mobile: mobile || null,
        website: website || null,
        postal_code: postal_code || null,
        user_type: '3',
        password: generatePassword(password),
        status: '0',
        new_profile_image: req.files.logo?.[0]?.location || null,
        original_profile_image: req.files.logo?.[0]?.location || null,
        created_by: createdBy,
        organization_name: organization_name || null
      };

      let companyObj = {
        profile: about_vendor_company || null,
        logo: req.files.logo?.[0]?.location || null,
        email: email || null,
        mobile: mobile || null,
        company_name: organization_name || null,
        nature_of_business: nature_business || null,
        established_year: estd_year || null,
        gstin: gstin || null,
        import_export_code: import_export_code || null,
        cin: cin || null,
        turnover: turn_over || null,
        no_of_employess: total_employees || null,
        project_name: ptr_project_name || null,
        project_description: ptr_project_description || null,
        project_start_date: ptr_project_start_date || null,
        project_end_date: ptr_project_end_date || null
      };


      let vendor = await productModel.vendor_register(vendorObj);

    // Check if spocs array is provided and has valid objects
if (Array.isArray(spocs) && spocs.length > 0) {
  // Iterate through each SPOC object in the array
  for (const spoc of spocs) {
    // Validate if at least one field in the SPOC is not empty
    if (spoc.spoc_email || spoc.spoc_name) {
      // Add vendor ID to the SPOC object
      spoc.user_id = vendor[0].id;
      // Insert the SPOC details into the table
      await userModel.add_user_spoc(spoc);
    }
  }
}

      companyObj.user_id = vendor[0].id;
      await productModel.addCompany(companyObj);

      if (req.files?.ptr_track && req.files?.ptr_track.length > 0) {
        const pathname = req.files.ptr_track[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.ptr_track[0].originalname || null,
          doc_type: 'ptr',
          user_id: vendor[0].id
        };
        await productModel.addFile(filesObj);
      }
      
      if (req.files?.certifications && req.files?.certifications.length > 0) {
        const pathname = req.files.certifications[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.certifications[0].originalname || null,
          doc_type: 'crt',
          user_id: vendor[0].id
        };
        await productModel.addFile(filesObj);
      }
      if (req.files?.brochure && req.files?.brochure.length > 0) {
        const pathname = `${Config.download_url}/user_image/${req.files.brochure[0].filename}`;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.brochure[0].originalname || null,
          doc_type: 'brochure',
          user_id: vendor[0].id
        };
        await productModel.addFile(filesObj);
      }

      addDefaultNotifications(vendor[0].id);

      if (vendor[0].id) {
        let html_variables = [{ name: name }];

        
        const spocList = await vendorModel.getSpocDetails(vendor[0]?.id)

        // console.log(" vendor contoller 229 spoc console ", vendor[0].id, spocList)

              
      //   let mailRecipients = {
      //     from: Config.webmasterMail,
      //     subject: `Work Wise | Registration`,
      //    html: `Dear ${name}, Your login credential userid:${email} and password ${password}`
      // };

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
            html: dunamicHtmlTemplate
        };
  
        if (spocList && spocList.length > 0) {
          mailRecipients.to = spocList.map(spoc => spoc.email);
          mailRecipients.cc = email;
        } else {
          mailRecipients.to = email;
        }

        sendMail(mailRecipients);

        // sendMail({
        //   from: Config.webmasterMail, // sender address
        //   to: email, // list of receivers
        //   subject: `Work wise | Registration`, // Subject line
        //   // html: dynamic_html // plain text body
        //   html: `Dear ${name}, Your login credential userid:${email} and password ${password}`
        // });

        let checkFreeSubscription =
          await subscriptionModel.checkFreeSubscription();
        if (checkFreeSubscription.length > 0) {
          const startDate = moment(); // Replace with the actual start date

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
            user_id: vendor[0].id,
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
            vendor[0].id
          );
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
              user_id: vendor[0].id
            };
            await subscriptionModel.createUserSubscriptionFeature(
              userSubscriptionFeatureObj
            );
          }
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
      const spocDetails = await vendorModel.getSpocDetails(vendorId);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails,
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
      let companyDetails = await vendorModel.getCompanyDetails(vendorId);
      let files = await vendorModel.getFiles(vendorId);
      let spocDetails = await vendorModel.getSpocDetails(vendorId);
      resObj.spocDetails = spocDetails;
      resObj.vendorDetails = vendorDetails[0];
      resObj.companyDetails = companyDetails[0];
      resObj.files = files || [];
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
        // sales_spoc_name,
        // sales_spoc_position,
        // sales_spoc_business_email,
        // sales_spoc_mobile,
        gstin,
        import_export_code,
        cin,
        turn_over,
        total_employees,
        ptr_project_name,
        ptr_project_description,
        ptr_project_start_date,
        ptr_project_end_date,
        about_vendor_company
      } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      // let fileName = req?.file?.filename;
      // let originalFilename = req?.file?.originalname;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      let vendorObj = {
        name: name || vendorDetails[0].name,
        email: email || vendorDetails[0].email,
        address: address || vendorDetails[0].address,
        city: city || vendorDetails[0].city,
        state: state || vendorDetails[0].state,
        country: country || vendorDetails[0].country,
        mobile: mobile || vendorDetails[0].mobile,
        website: website || vendorDetails[0].website,
        postal_code: postal_code || vendorDetails[0].postal_code,
        new_profile_image: req.files.logo?.[0]?.location,
        original_profile_image: vendorDetails[0].original_profile_image,
        updated_by: updatedBy,
        organization_name:
          organization_name || vendorDetails[0].organization_name
      };
      await productModel.updateVendorDetail(vendorObj, vendorId);

      let companyDetails = await vendorModel.getCompanyDetails(vendorId);

      if (companyDetails.length > 0) {
        let companyObj = {
          profile: about_vendor_company || companyDetails[0].profile,
          logo:
            req.files?.logo
              ? req.files?.logo[0].location
              : companyDetails[0].logo,
          email: email || companyDetails[0].email,
          mobile: mobile || companyDetails[0].mobile,
          company_name: organization_name || companyDetails[0].company_name,
          nature_of_business:
            nature_business || companyDetails[0].nature_of_business,
          established_year: estd_year || companyDetails[0].established_year,
          // spoc_name: sales_spoc_name || companyDetails[0].spoc_name,
          // spoc_role: sales_spoc_position || companyDetails[0].spoc_role,
          // spoc_email: sales_spoc_business_email || companyDetails[0].spoc_email,
          // spoc_mobile: sales_spoc_mobile || companyDetails[0].spoc_mobile,
          gstin: gstin || companyDetails[0].gstin,
          import_export_code:
            import_export_code || companyDetails[0].import_export_code,
          cin: cin || companyDetails[0].cin,
          turnover: turn_over || companyDetails[0].turnover,
          no_of_employess: total_employees || companyDetails[0].no_of_employess,
          project_name: ptr_project_name || companyDetails[0].project_name,
          project_description:
            ptr_project_description || companyDetails[0].project_description,
          project_start_date:
            ptr_project_start_date || companyDetails[0].project_start_date,
          project_end_date:
            ptr_project_end_date || companyDetails[0].project_end_date
        };

        companyObj.user_id = vendorId;
        await productModel.updateCompany(companyObj);
      } else {
        let companyObj = {
          profile: about_vendor_company || null,
          logo:
            req.files?.logo && req.files?.logo.length > 0
              ? `${Config.download_url}/user_image/${req.files.logo[0].filename}`
              : null,
          email: email || null,
          mobile: mobile || null,
          company_name: organization_name || null,
          nature_of_business: nature_business || null,
          established_year: estd_year || null,
          // spoc_name: sales_spoc_name || null,
          // spoc_role: sales_spoc_position || null,
          // spoc_email: sales_spoc_business_email || null,
          // spoc_mobile: sales_spoc_mobile || null,
          gstin: gstin || null,
          import_export_code: import_export_code || null,
          cin: cin || null,
          turnover: turn_over || null,
          no_of_employess: total_employees || null,
          project_name: ptr_project_name || null,
          project_description: ptr_project_description || null,
          project_start_date: ptr_project_start_date || null,
          project_end_date: ptr_project_end_date || null
        };
        companyObj.user_id = vendorId;
        await productModel.addCompany(companyObj);
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
      if (req.files?.certifications && req.files?.certifications.length > 0) {
        const pathname = req.files.certifications[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.certifications[0].originalname || null,
          doc_type: 'crt',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }
      if (req.files?.brochure && req.files?.brochure.length > 0) {
        const pathname = req.files.brochure[0].location;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.brochure[0].originalname || null,
          doc_type: 'brochure',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }

      /* if (fileName) {
        if (vendorDetails[0].new_profile_image) {
          const file_link = `${Config.upload.user_image}/${vendorDetails[0].new_profile_image}`;
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
          message: 'Vendor successfully updated'
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


      const response = await vendorModel.updateUserSpoc(name, email, mobile, role, userId, spocId);

      if (response.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            message: `spoc of ${response[0].role.toUpperCase()} ${response[0].name} updated`
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

      const spocExist = await userModel.check_exactly_same_spoc({spoc_name, spoc_email:spoc_email.toLowerCase(), spoc_mobile, spoc_role, user_id});

      if(spocExist<1){
        const response = await userModel.add_user_spoc({spoc_name, spoc_email:spoc_email.toLowerCase(), spoc_mobile, spoc_role, user_id});
        res
        .status(200)
        .json({
          status: 1,
          message: `${response[0].name} as ${response[0].role.toUpperCase()} role added to your spoc`
        })
        .end();
      }else{
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
};
export default vendorController;
