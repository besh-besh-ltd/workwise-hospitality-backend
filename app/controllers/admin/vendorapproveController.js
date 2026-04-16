import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

import vendorModel from '../../models/vendorModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';

import Config from '../../config/app.config.js';
import { logError, sendMail, generatePassword } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import jwtHelper from '../../helper/jwtHelper.js';

const cryptr = new Cryptr(Config.cryptR.secret);
// NOT USED
const vendorController = {
  vendorApproveList: async (req, res, next) => {
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
      if (req.query.organization) {
        organization = req.query.organization;
      }
      if (req.query.verified) {
        verified = req.query.verified;
      }

      let vendorList = await vendorapproveModel.getVendorApproveList(
        limit,
        offset,
        organization,
        verified
      );
      let vendorCount = await vendorapproveModel.getVendorListCount(
        organization,
        verified
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
  allVendorApproveList: async (req, res, next) => {
    try {
      let page, limit, offset, verified, name;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      if (req.query?.status) {
        verified = req.query.status;
      }
      if (req.query?.name) {
        name = req.query.name;
      }

      let vendorList = await vendorapproveModel.getAllVendorApproveList(
        limit,
        offset,
        verified,
        name
      );
      let vendorCount = await vendorapproveModel.getAllVendorApproveListCount(
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
      const { name, mobile, organization_name } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let password = `${name.trim().toLowerCase()}${mobile.substring(0, 4)}`;
      let vendorObj = {
        name,
        email,
        mobile,
        organization_name,
        register_as: 3,
        password: generatePassword(password),
        status: 1,
        createdBy,
        fileName,
        originalFilename
      };
      let vendorId = await vendorModel.addVendor(vendorObj);

      if (vendorId) {
        let html_variables = [{ name: name }];


          const spocList = await vendorModel.getSpocDetails(user_details[0]?.id)

          // console.log(" vendor contoller 149 spoc console ", user_details[0]?.id, spocList)
              
          let mailRecipients = {
            from: Config.webmasterMail,
            subject:`Work wise | Registration`,
            html: `Dear ${name}, Your login credential userid:${email} and password ${password}`
          };
    
          if (spocList && spocList.length > 0) {
            mailRecipients.to = spocList.map(spoc => spoc.email);
            mailRecipients.cc = email;
          } else {
            mailRecipients.to = email;
          }
    
          sendMail(mailRecipients);


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
      const { name, mobile, organization_name } = req.body;
      const email = req.body.email?.toLowerCase() || '';
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      let vendorObj = {
        name,
        email,
        mobile,
        organization_name,
        updatedBy,
        fileName,
        originalFilename
      };
      await vendorModel.updateVendor(vendorId, vendorObj);


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
      let status = req.body.status;
      await vendorModel.approveVendor(vendorId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Vendor successfully ${
            status == 0 ? 'Rejected' : 'Approved'
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
  vendorApproveDetails: async (req, res, next) => {
    try {
      let vendorApproveID = req.params.id;
      let vendorApproveDetails = await vendorapproveModel.vendorApproveIDExist(
        vendorApproveID
      );
      res
        .status(200)
        .json({
          status: 1,
          data: vendorApproveDetails
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
  addVendorApprove: async (req, res, next) => {
    try {
      const { name, status, show_in_website } = req.body;
      // console.log('Files-->', req.files);
      let vendorApproveObj = {
        vendor_approve: name,
        vendor_logo:
          req?.files?.logo?.length > 0
            ? req.files.logo[0].location // S3 file URL
            : null,
        status: status || 1,
        show_in_website: show_in_website || 1,
        datasheet_file:
          req?.files?.tds?.length > 0
            ? req.files.tds[0].location // S3 file URL
            : null,
        // Uncomment this when QAP is handled
        // qap_file: req?.files?.qap?.length > 0 ? req.files.qap[0].location : null
      };
      vendorApproveObj = Object.fromEntries(
        Object.entries(vendorApproveObj).filter(
          ([key, value]) => value !== null
        )
      );
  
      await vendorapproveModel.createVendorApprove(vendorApproveObj);
  
      res
        .status(200)
        .json({
          status: 1,
          message: 'Vendor approve successfully added'
        })
        .end();
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
  updateVendorApprove: async (req, res, next) => {
    try {
      let vendorApproveID = req.params.id;
      const { name, status, show_in_website } = req.body;
      const checkVendorApproveID =
        await vendorapproveModel.vendorApproveIDExist(vendorApproveID);
      let vendorApproveObj = {
        vendor_approve: name,
        show_in_website: show_in_website || 1,
        vendor_logo:
          req?.files?.logo?.length > 0
            ? req.files.logo[0].location // updated S3 URL
            : checkVendorApproveID[0]?.vendor_logo,
        status: status || 1,
        datasheet_file:
          req?.files?.tds?.length > 0
            ? req.files.tds[0].location // updated S3 URL
            : checkVendorApproveID[0]?.datasheet_file,
        // qap_file:
        //   req?.files?.qap?.length > 0
        //     ? req.files.qap[0].location
        //     : checkVendorApproveID[0]?.qap_file
      };
  
      // console.log("vendorApproveObj-->", vendorApproveObj);
  
      // Remove undefined keys (if any)
      vendorApproveObj = Object.fromEntries(
        Object.entries(vendorApproveObj).filter(
          ([key, value]) => value !== undefined
        )
      );
      await vendorapproveModel.updateVendorApprove(
        vendorApproveObj,
        vendorApproveID
      );

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
  }
};
export default vendorController;
