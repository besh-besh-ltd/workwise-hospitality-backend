import buyerModel from '../../models/buyerModel.js';
import rfqModel from '../../models/rfqModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import userModel from '../../models/userModel.js';
import xlsx from 'xlsx';
import fs from 'fs';

const cryptr = new Cryptr(Config.cryptR.secret);

const buyerController = {
  buyerList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name, user_type;
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

      let buyerList = await buyerModel.getBuyerList(
        limit,
        offset,
        organization,
        verified,
        name,
        user_type
      );
      let buyerCount = await buyerModel.getBuyerListCount(
        organization,
        verified,
        name,
        user_type
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
  buyer_subscription_details: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      const subscriberDetails = await subscriptionModel.getSubscriberDetails(
        buyerId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: subscriberDetails
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
        address
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
      let file = req.file;
      
      if (!file) {
        return res.status(400).json({
          status: 2,
          message: 'File is required'
        }).end();
      }

      let jsonData = [];
      
      // Parse file
      if (file.path.endsWith('.xlsx')) {
        const workbook = xlsx.readFile(file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        jsonData = xlsx.utils.sheet_to_json(sheet);
      } else if (file.path.endsWith('.csv')) {
        const csvData = fs.readFileSync(file.path, 'utf8');
        const lines = csvData.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          const row = {};
          headers.forEach((header, index) => {
            row[header] = values[index] || '';
          });
          jsonData.push(row);
        }
      }

      // Clean file
      fs.unlinkSync(file.path);

      if (!jsonData.length) {
        return res.status(400).json({
          status: 2,
          message: 'No data found in file'
        }).end();
      }

      let validMappings = [];
      let unmappedEntries = [];

      // Process data
      for (let i = 0; i < jsonData.length; i++) {
        const row = jsonData[i];
        const buyerEmail = row['Buyer Email']?.trim();
        const vendorEmail = row['Vendor Email']?.trim();
        
        // Skip if both emails missing
        if (!buyerEmail && !vendorEmail) continue;

        if (!buyerEmail || !vendorEmail) {
          unmappedEntries.push({
            row: i + 1,
            buyerEmail: buyerEmail || '',
            vendorEmail: vendorEmail || '',
            reason: 'Missing email'
          });
          continue;
        }

        // Check buyer exists
        const buyerResult = await userModel.user_email_exist(buyerEmail.toLowerCase());
        const buyerData = buyerResult.filter(user => 
          [2, 8].includes(user.user_type) && user.is_deleted === 0
        );
        
        if (!buyerData.length) {
          unmappedEntries.push({
            row: i + 1,
            buyerEmail,
            vendorEmail,
            reason: 'Buyer not found'
          });
          continue;
        }

        // Check vendor exists
        const vendorResult = await userModel.user_email_exist(vendorEmail.toLowerCase());
        const vendorData = vendorResult.filter(user => 
          user.user_type === 3 && user.is_deleted === 0
        );
        
        if (!vendorData.length) {
          unmappedEntries.push({
            row: i + 1,
            buyerEmail,
            vendorEmail,
            reason: 'Vendor not found'
          });
          continue;
        }

        validMappings.push({
          buyer_id: buyerData[0].id,
          vendor_id: vendorData[0].id,
          buyerEmail,
          vendorEmail,
          row: i + 1
        });
      }

      let mappedEntries = [];
      
      // Bulk insert valid mappings
      if (validMappings.length > 0) {
        try {
          const bulkResult = await userModel.bulkMapBuyersToVendors(validMappings);
          mappedEntries = validMappings.map(mapping => ({
            row: mapping.row,
            buyerEmail: mapping.buyerEmail,
            vendorEmail: mapping.vendorEmail,
            status: 'Mapped successfully'
          }));
        } catch (error) {
          // If bulk insert fails, add all to unmapped
          validMappings.forEach(mapping => {
            unmappedEntries.push({
              row: mapping.row,
              buyerEmail: mapping.buyerEmail,
              vendorEmail: mapping.vendorEmail,
              reason: 'Database error'
            });
          });
        }
      }

      res.status(200).json({
        status: 1,
        message: 'Bulk mapping completed',
        data: {
          totalProcessed: jsonData.length,
          successfulMappings: mappedEntries.length,
          failedMappings: unmappedEntries.length,
          mappedEntries,
          unmappedEntries
        }
      }).end();

    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      }).end();
    }
  }

};

export default buyerController;
