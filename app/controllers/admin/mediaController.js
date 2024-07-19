import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';

// import vendorModel from '../../models/vendorModel.js';
import mediaModel from '../../models/mediaModel.js';

import Config from '../../config/app.config.js';
import { logError, sendMail, generatePassword } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const mediaController = {
  mediaList: async (req, res, next) => {
    try {
      let page, limit, offset, name;
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

      let mediaList = await mediaModel.getMediaList(limit, offset, name);
      let mediaCount = await mediaModel.getMediaListCount(name);
      res
        .status(200)
        .json({
          status: 1,
          data: mediaList,
          total_count: mediaCount.count
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
  upload_documents: async (req, res, next) => {
    console.log('FILES======', req.files.file);
    try {
      var user_id = req.user.id;
      let doc_type = 'media';

      if (req.files) {
        const result = await mediaModel.uploadFiles(
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
  mediaDetails: async (req, res, next) => {
    try {
      let mediaId = req.params.id;
      let mediaDetails = await mediaModel.mediaIDExist(mediaId);
      res
        .status(200)
        .json({
          status: 1,
          data: mediaDetails
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

        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Des Technico | Registration`, // Subject line
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
  }
};
export default mediaController;
