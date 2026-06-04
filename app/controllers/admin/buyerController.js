import buyerModel from '../../models/buyerModel.js';
import rfqModel from '../../models/rfqModel.js';
import Config from '../../config/app.config.js';
import { logError, sendMail } from '../../helper/common.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import userModel from '../../models/userModel.js';
import vendorModel from '../../models/vendorModel.js';
import xlsx from 'xlsx';
import fs from 'fs';
import moment from 'moment';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const buyerController = {
  buyerList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name, user_type;
      let is_hospitality = null;
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
      if (req.query.user_type) {
        user_type = req.query.user_type;
      }

      if (
        req.query.is_hospitality !== undefined &&
        req.query.is_hospitality !== null &&
        req.query.is_hospitality !== ''
      ) {
        const parsedHospitality = parseInt(req.query.is_hospitality);
        if (!isNaN(parsedHospitality) && (parsedHospitality === 0 || parsedHospitality === 1)) {
          is_hospitality = parsedHospitality;
        }
      }

      let buyerList = await buyerModel.getBuyerList(
        limit,
        offset,
        organization,
        verified,
        name,
        user_type,
        is_hospitality
      );
      let buyerCount = await buyerModel.getBuyerListCount(
        organization,
        verified,
        name,
        user_type,
        is_hospitality
      );
      res
        .status(200)
        .json({
          status: 1,
          data: buyerList,
          total_count: buyerCount.count
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
  buyerDetails: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: buyerDetails
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
  buyer_rfq_list: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, buyerId);
      let count = await rfqModel.getBuyerRfqCount(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count.length
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
  blockBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      let status = req.body.status;
      status = status == 1 ? 2 : 1;
      await buyerModel.blockBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${status == 1 ? 'unblocked' : 'blocked'}`
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
  updateBuyerAccountLimits: async (req, res, next) => {
    try {
      const company_id = req.params.company_id;
      const { max_top_management, max_procurement, max_engineering, max_finance } = req.body;
      
      const limitsData = {
        max_top_management: parseInt(max_top_management) || 0,
        max_procurement: parseInt(max_procurement) || 0,
        max_engineering: parseInt(max_engineering) || 0,
        max_finance: parseInt(max_finance) || 0
      };

      // Use general updateWhere function
      await rfqModel.updateWhere(
        'tbl_company_buyer_account_limit',
        limitsData,
        `company_id = ${company_id}`
      );

      res
        .status(200)
        .json({
          status: 1,
          message: 'Account limits updated successfully'
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
  updateBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      const {
        name,
        mobile,
        organization_name,
        address,
        is_hospitality
      } = req.body;

      const email = req.body.email?.toLowerCase() || '';
      let fileName = req?.file?.location;   //get file url from s3 bucket
      let originalFilename = req?.file?.originalname;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let buyerObj = {
        name,
        email,
        mobile,
        organization_name: organization_name || null,
        updatedBy,
        fileName,
        originalFilename,
        address: address || null
      };
      
      await buyerModel.updateBuyer(buyerId, buyerObj);

      let resolvedHospitality = null;
      if (is_hospitality !== undefined && is_hospitality !== null && is_hospitality !== '') {
        resolvedHospitality =
          parseInt(is_hospitality, 10) === 1 ? 1 : 0;
      }

      if (resolvedHospitality !== null) {
        await buyerModel.updateBuyerHospitalityFlag(buyerId, resolvedHospitality);
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Buyer successfully updated'
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
  approveBuyer: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let buyerId = req.params.id;
      let status = req.body.status;
      await buyerModel.approveBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${status == 0 ? 'Disapproved' : 'Approved'
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
  deleteBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      await buyerModel.deleteBuyer(buyerId, updatedBy);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Buyer successfully deleted'
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

  reviewBuyerPrivateVendors: async (req, res, next) => {
    try {
      let createdBy = req.user.id;

      // status -1 pending review, 0 disable user profile, 1 active user, 2 rejected  
      const { vendorTempId, status, reject_reason, buyerName, productdetails } = req.body
      
      const userDetails = await rfqModel.checkIfExists('tbl_temp_user', `id = ${vendorTempId}`);
      if (userDetails.length <= 0) {
        return res
          .status(200)
          .json({
            status: 1,
            message: 'user not exist'
          })
          .end();
      }

      // status -1 pending review, 0 disable user profile, 1 active user, 2 rejected  
      if (status == 2) {
        const rejectUser = await userModel.updateStatusInTempUserTable(vendorTempId, status, reject_reason)
        return res
          .status(200)
          .json({
            status: 1,
            data: rejectUser,
            message: "User Rejected"
          })
          .end();
      }

      // For single public vendor upload
      if (status == 3) {
        const result = await userModel.updateIsPrivateOfVendorOnEmail(userDetails[0].email);
        
        await userModel.deleteVendorFromTempUserTable(vendorTempId);
        
        return res
          .status(200)
          .json({
            status: 1,
            data: result,
            message: "Vendor is made public"
          })
          .end();
      }

      return res
      .status(400)
      .json({
        status: 3,
        message: "Invalid status"
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
  getBuyerPrivateVendorList: async (req, res, next) => {
    try {

      const vendorsList = await userModel.getVendorsWithBuyerNames();

      return res
        .status(200)
        .json({
          status: 1,
          data: vendorsList
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
  bulkBuyerVendorMapping: async (req, res, next) => {
    try {
      let jsonData = [];
      try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        jsonData = xlsx.utils.sheet_to_json(sheet);
      } catch (parseError) {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          status: 2,
          message: 'Error parsing file: ' + parseError.message
        }).end();
      }

      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      if (!jsonData.length) {
        return res.status(400).json({
          status: 2,
          message: 'No data found in file'
        }).end();
      }

      const emailPairs = jsonData
        .map((row, index) => ({
          row: index + 1,
          buyerEmail: row['buyer_email']?.trim()?.toLowerCase(),
          vendorEmail: row['vendor_email']?.trim()?.toLowerCase()
        }))
        .filter(item => item.buyerEmail && item.vendorEmail);

      if (!emailPairs.length) {
        return res.status(200).json({
          status: 1,
          message: 'Bulk mapping completed',
          data: {
            totalProcessed: 0,
            successfulMappings: 0,
            failedMappings: 0,
            mappedEntries: [],
            unmappedEntries: []
          }
        }).end();
      }

      // Get the admin's user ID who is performing the bulk mapping
      const adminUserId = req.user.id;
      const result = await userModel.bulkMapBuyersToVendors(emailPairs, adminUserId);

      // Send emails to vendors who were successfully mapped
      if (result.mappedEntries && result.mappedEntries.length > 0) {
        // Group mappings by vendor_id to send one email per vendor
        const vendorMap = new Map();
        result.mappedEntries.forEach(entry => {
          if (entry.vendor_id) {
            if (!vendorMap.has(entry.vendor_id)) {
              vendorMap.set(entry.vendor_id, {
                vendor_id: entry.vendor_id,
                vendor_email: entry.vendor_email_display,
                vendor_name: entry.vendor_name
              });
            }
          }
        });

        // Send email to each unique vendor
        for (const [vendorId, vendorInfo] of vendorMap) {
          try {
            const companyMappings = await vendorModel.getVendorCompanyMappings(vendorId);
            const hasCompanyMappings = companyMappings && companyMappings.length > 0;

            if (hasCompanyMappings) {
              const companyNames = companyMappings
                .map(m => m.company_name)
                .filter(Boolean)
                .join(', ');
              
              const vendorName = vendorInfo.vendor_name || 'Vendor';
              const vendorEmail = vendorInfo.vendor_email;
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
                  <p><strong>Email:</strong> ${vendorEmail || '[Vendor Email]'}</p>
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
                to: spocList?.length ? spocList.map(spoc => spoc.email) : vendorEmail,
                cc: spocList?.length ? vendorEmail : '',
                subject: `${companyNames} Added You on Phileein Hospitality`,
                html: dynamicHTML
              });
            }
          } catch (emailError) {
            // Log email error but don't fail the entire bulk mapping operation
            logError(emailError);
          }
        }
      }

      res.status(200).json({
        status: 1,
        message: 'Bulk mapping completed',
        data: result
      }).end();
    } catch (error) {
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      }).end();
    }
  }

};

export default buyerController;
