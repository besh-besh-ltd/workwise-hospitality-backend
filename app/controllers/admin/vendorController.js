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
import jwtHelper from '../../helper/jwtHelper.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import moment from 'moment';

const cryptr = new Cryptr(Config.cryptR.secret);

const vendorController = {
  vendorList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      if (req.query.name) {
        name = req.query.name;
      }
      if (req.query.organization) {
        organization = req.query.organization;
      }
      if (req.query.verified) {
        verified = req.query.verified;
      }

      let vendorList = await vendorModel.getVendorList(
        limit,
        offset,
        organization,
        verified,
        name
      );
      let vendorCount = await vendorModel.getVendorListCount(
        organization,
        verified,
        name
      );
      res
        .status(200)
        .json({
          status: 1,
          data: vendorList,
          total_count: vendorCount.count
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
        email,
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
        sales_spoc_name,
        sales_spoc_position,
        sales_spoc_business_email,
        sales_spoc_mobile,
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
        status: '1',
        new_profile_image:
          req.files?.image && req.files?.image.length > 0
            ? `${Config.download_url}/user_image/${req.files.image[0].filename}`
            : null,
        original_profile_image:
          req.files?.image && req.files?.image.length > 0
            ? req.files.image[0].originalname
            : null,
        created_by: createdBy,
        organization_name: organization_name || null
      };

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
        spoc_name: sales_spoc_name || null,
        spoc_role: sales_spoc_position || null,
        spoc_email: sales_spoc_business_email || null,
        spoc_mobile: sales_spoc_mobile || null,
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

      companyObj.user_id = vendor[0].id;
      await productModel.addCompany(companyObj);

      if (req.files?.ptr_track && req.files?.ptr_track.length > 0) {
        const pathname = `${Config.download_url}/user_image/${req.files.ptr_track[0].filename}`;
        let filesObj = {
          file_path: pathname || null,
          file_name: req.files.ptr_track[0].originalname || null,
          doc_type: 'ptr',
          user_id: vendor[0].id
        };
        await productModel.addFile(filesObj);
      }
      if (req.files?.certifications && req.files?.certifications.length > 0) {
        const pathname = `${Config.download_url}/user_image/${req.files.certifications[0].filename}`;
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

        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Work wise | Registration`, // Subject line
          // html: dynamic_html // plain text body
          html: `Dear ${name}, Your login credential userid:${email} and password ${password}`
        });

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
      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails
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
          message: `Vendor successfully ${
            status == 1 ? 'unblocked' : 'blocked'
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
        email,
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
        sales_spoc_name,
        sales_spoc_position,
        sales_spoc_business_email,
        sales_spoc_mobile,
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
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      let vendorObj = {
        name: name || vendorDetails[0].name,
        email: email || vendorDetails[0].email,
        address: address || vendorDetails[0].address,
        city: city || vendorDetails[0].city,
        state: state || vendorDetails[0].state,
        mobile: mobile || vendorDetails[0].mobile,
        website: website || vendorDetails[0].website,
        postal_code: postal_code || vendorDetails[0].postal_code,
        new_profile_image:
          req.files?.image && req.files?.image.length > 0
            ? `${Config.download_url}/user_image/${req.files.image[0].filename}`
            : vendorDetails[0].new_profile_image,
        original_profile_image:
          req.files?.image && req.files?.image.length > 0
            ? req.files.image[0].originalname
            : vendorDetails[0].original_profile_image,
        updated_by: updatedBy,
        organization_name:
          organization_name || vendorDetails[0].organization_name
      };
      await productModel.updateVendorDetail(vendorObj);

      let companyDetails = await vendorModel.getCompanyDetails(vendorId);

      if (companyDetails.length > 0) {
        let companyObj = {
          profile: about_vendor_company || companyDetails[0].profile,
          logo:
            req.files?.logo && req.files?.logo.length > 0
              ? `${Config.download_url}/user_image/${req.files.logo[0].filename}`
              : companyDetails[0].logo,
          email: email || companyDetails[0].email,
          mobile: mobile || companyDetails[0].mobile,
          company_name: organization_name || companyDetails[0].company_name,
          nature_of_business:
            nature_business || companyDetails[0].nature_of_business,
          established_year: estd_year || companyDetails[0].established_year,
          spoc_name: sales_spoc_name || companyDetails[0].spoc_name,
          spoc_role: sales_spoc_position || companyDetails[0].spoc_role,
          spoc_email: sales_spoc_business_email || companyDetails[0].spoc_email,
          spoc_mobile: sales_spoc_mobile || companyDetails[0].spoc_mobile,
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
          spoc_name: sales_spoc_name || null,
          spoc_role: sales_spoc_position || null,
          spoc_email: sales_spoc_business_email || null,
          spoc_mobile: sales_spoc_mobile || null,
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
        const pathname = `${Config.download_url}/user_image/${req.files.ptr_track[0].filename}`;
        let filesObj = {
          file_path: pathname || null,
          file_name: req.files.ptr_track[0].originalname || null,
          doc_type: 'ptr',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }
      if (req.files?.certifications && req.files?.certifications.length > 0) {
        const pathname = `${Config.download_url}/user_image/${req.files.certifications[0].filename}`;
        let filesObj = {
          file_path: pathname,
          file_name: req.files.certifications[0].originalname || null,
          doc_type: 'crt',
          user_id: vendorId
        };
        await productModel.addFile(filesObj);
      }
      if (req.files?.brochure && req.files?.brochure.length > 0) {
        const pathname = `${Config.download_url}/user_image/${req.files.brochure[0].filename}`;
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
        sendMail({
          from: Config.webmasterMail, // sender address
          to: userDetail[0].email, // list of receivers
          subject: `Work wise | Registration`, // Subject line
          html: dynamic_html // plain text body
        });
      }

      res
        .status(200)
        .json({
          status: 1,
          message: `Vendor successfully ${
            status == 0 ? 'Disapproved' : 'Approved'
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
    try {
      let vendorList = await vendorModel.getVendorDropdownList();
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
  }
};
export default vendorController;
