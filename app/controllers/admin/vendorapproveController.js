import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

// import vendorModel from '../../models/vendorModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';

import Config from '../../config/app.config.js';
import { logError, sendMail, generatePassword } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';

const cryptr = new Cryptr(Config.cryptR.secret);

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
      const { name, email, mobile, organization_name } = req.body;
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

        /*  let dynamic_html = fs
          .readFileSync(`${Config.template_path}/user_register_template.txt`)
          .toString();
        for (let index = 0; index < html_variables.length; index++) {
          const element = html_variables[index];
          let dynamic_key = Object.keys(element)[0];
          let replace_char = html_variables[index][dynamic_key];
          let replace_var = `[${dynamic_key.toLowerCase()}]`;

          dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
        } */

        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Work wise | Registration`, // Subject line
          // html: dynamic_html // plain text body
          html: `Dear ${name}, Your login credential userid:${email} and password ${password}`
        });

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
      const { name, email, mobile, organization_name } = req.body;
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
            ? `${Config.download_url}/vendor_approve/${req.files.logo[0].filename}`
            : null,
        status: status || 1,
        show_in_website: show_in_website || 1,
        datasheet_file:
          req?.files?.tds?.length > 0
            ? `${Config.download_url}/vendor_approve/${req.files.tds[0].filename}`
            : null
        // qap_file: req?.files?.qap?.length > 0 ? req.files.qap[0].filename : null
      };
      vendorApproveObj = Object.fromEntries(
        Object.entries(vendorApproveObj).filter(
          ([key, value]) => value !== null
        )
      );
      console.log('vendorApproveObj-->', vendorApproveObj);
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
            ? `${Config.download_url}/vendor_approve/${req.files.logo[0].filename}`
            : checkVendorApproveID[0].logo,
        status: status || 1,
        datasheet_file:
          req?.files?.tds?.length > 0
            ? `${Config.download_url}/vendor_approve/${req.files.tds[0].filename}`
            : checkVendorApproveID[0].tds
        /* qap_file:
          req?.files?.qap?.length > 0
            ? req.files.qap[0].filename
            : checkVendorApproveID[0].qap */
      };
      console.log('vendorApproveObj-->', vendorApproveObj);
      vendorApproveObj = Object.fromEntries(
        Object.entries(vendorApproveObj).filter(
          ([key, value]) => value !== undefined
        )
      );
      await vendorapproveModel.updateVendorApprove(
        vendorApproveObj,
        vendorApproveID
      );

      /*  if (req?.files?.qap_file?.length > 0) {
        const file_link = `${Config.upload.vendor_approve}/${checkVendorApproveID[0].qap_file}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
          }
        });
      }
      if (req?.files?.datasheet_file?.length > 0) {
        const file_link = `${Config.upload.vendor_approve}/${checkVendorApproveID[0].datasheet_file}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
          }
        });
      }
      if (req?.files?.vendor_logo?.length > 0) {
        const file_link = `${Config.upload.vendor_approve}/${checkVendorApproveID[0].vendor_logo}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
          }
        });
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
  }
};
export default vendorController;
