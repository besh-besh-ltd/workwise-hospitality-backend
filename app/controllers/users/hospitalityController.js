import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Moment from 'moment';
import Razorpay from 'razorpay';
import Config from '../../config/app.config.js';
import { logError, sendMail, convertSixDigit } from '../../helper/common.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';
import { generateTaxInvoicePdf, generatePaymentReceivedPdf } from '../../helper/paymentDocuments.js';
import generalModel from '../../models/generalModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import productModel from '../../models/productModel.js';
import projectModel from '../../models/projectModel.js';
import rfqModel from '../../models/rfqModel.js';
import userModel from '../../models/userModel.js';
import db from '../../config/dbConn.js';

const formatErrorResponse = (res, error) => {
  const statusCode = error.statusCode || 400;
  const message = error.message || Config.errorText.value;
  return res.status(statusCode).json({
    status: 3,
    message
  });
};

const HospitalityController = {
  listCompanies: async (req, res) => {
    try {
      const company = req.companyDetails;
      const includeHotels = req.query.include === 'hotels';

      const companies = includeHotels
        ? await hospitalityModel.getCompaniesWithHotelsByBuyer(company.id)
        : await hospitalityModel.getCompaniesByBuyer(company.id);

      return res.status(200).json({
        status: 1,
        data: companies
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createCompany: async (req, res) => {
    try {
      const company = req.companyDetails;
      const payload = {
        buyer_company_id: company.id,
        name: req.body.name?.trim(),
        region: req.body.region?.trim() || null,
        contact_email: req.body.contact_email?.trim() || null,
        registered_office_address: req.body.registered_office_address?.trim() || null,
        corporate_office_address: req.body.corporate_office_address?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        created_by: req.user.id
      };

      const created = await hospitalityModel.createCompany(payload);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        // GST document
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        // PAN document
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        // Cancelled cheque
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        // MSME document
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              created.id,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Hospitality company created successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  updateCompany: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const updated = await hospitalityModel.updateCompany(
        hospitalityCompanyId,
        {
          name: req.body.name?.trim(),
          region: req.body.region?.trim() || null,
          contact_email: req.body.contact_email?.trim() || null,
          registered_office_address: req.body.registered_office_address?.trim() || null,
          corporate_office_address: req.body.corporate_office_address?.trim() || null,
          gst: req.body.gst?.trim() || null,
          pan: req.body.pan?.trim() || null,
          bank_account_number: req.body.bank_account_number?.trim() || null,
          bank_name: req.body.bank_name?.trim() || null,
          ifsc_code: req.body.ifsc_code?.trim() || null,
          account_holder_name: req.body.account_holder_name?.trim() || null,
          msme: req.body.msme?.trim() || null,
          updated_by: req.user.id
        },
        company.id
      );

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'gst',
              req.files.gst[0].location,
              req.body.gst?.trim() || null
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'pan',
              req.files.pan[0].location,
              req.body.pan?.trim() || null
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (req.body.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveCompanyDocument(
              hospitalityCompanyId,
              'msme',
              req.files.msme[0].location,
              req.body.msme?.trim() || null
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: updated,
        message: 'Hospitality company updated successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  listCompanyHotels: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const hotels = await hospitalityModel.getHotelsByCompany(
        hospitalityCompanyId
      );

      return res.status(200).json({
        status: 1,
        data: hotels
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createHotel: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const payload = {
        hospitality_company_id: hospitalityCompanyId,
        name: req.body.name?.trim(),
        city: req.body.city?.trim() || null,
        keys: req.body.keys ? parseInt(req.body.keys, 10) : 0,
        // Status is now driven entirely by payment lifecycle
        status: 'Pending Onboarding',
        full_address: req.body.full_address?.trim() || null,
        state: req.body.state?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        delivery_address: req.body.delivery_address?.trim() || null,
        created_by: req.user.id,
        fee_amount: req.body.fee_amount
          ? parseInt(req.body.fee_amount, 10)
          : 500,
        email: req.body.email?.trim() || null,
        payment_status: 'onboarding'
      };

      const created = await hospitalityModel.createHotel(payload);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              created.id,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Hotel added successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  createHO: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const created = await hospitalityModel.createHOFromCompany(
        hospitalityCompanyId,
        req.user.id
      );

      // Copy company documents to the new HO hotel
      const companyDocs = await hospitalityModel.getCompanyDocuments(hospitalityCompanyId);
      if (companyDocs && companyDocs.length > 0) {
        const docPromises = companyDocs.map(doc =>
          hospitalityModel.saveHotelDocument(
            created.id,
            doc.document_type,
            doc.document_url,
            doc.document_number
          )
        );
        await Promise.all(docPromises);
      }

      return res.status(200).json({
        status: 1,
        data: created,
        message: 'Head Office business unit created successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  updateHotel: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const hotelId = parseInt(req.params.hotel_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const hotelRecord = await hospitalityModel.getHotelById(hotelId);
      if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hotel not found in selected company'
        });
      }

      const payload = {
        name: req.body.name?.trim(),
        city: req.body.city?.trim() || null,
        keys: req.body.keys ? parseInt(req.body.keys, 10) : 0,
        // Allow manual override of status on edit; fall back to existing value
        status: req.body.status?.trim() || hotelRecord.status,
        full_address: req.body.full_address?.trim() || null,
        state: req.body.state?.trim() || null,
        gst: req.body.gst?.trim() || null,
        pan: req.body.pan?.trim() || null,
        bank_account_number: req.body.bank_account_number?.trim() || null,
        bank_name: req.body.bank_name?.trim() || null,
        ifsc_code: req.body.ifsc_code?.trim() || null,
        account_holder_name: req.body.account_holder_name?.trim() || null,
        msme: req.body.msme?.trim() || null,
        delivery_address: req.body.delivery_address?.trim() || null,
        updated_by: req.user.id,
        email: req.body.email?.trim() || null,
        fee_amount: req.body.fee_amount !== undefined && req.body.fee_amount !== null && req.body.fee_amount !== ''
          ? parseInt(req.body.fee_amount, 10)
          : hotelRecord.fee_amount
      };

      const updated = await hospitalityModel.updateHotel(hotelId, payload, record.id);

      // Handle document uploads if files are present
      if (req.files) {
        const documentPromises = [];
        
        if (req.files.gst && req.files.gst[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'gst',
              req.files.gst[0].location,
              payload.gst
            )
          );
        }
        
        if (req.files.pan && req.files.pan[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'pan',
              req.files.pan[0].location,
              payload.pan
            )
          );
        }
        
        if (req.files.cancelled_cheque && req.files.cancelled_cheque[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'cancelled_cheque',
              req.files.cancelled_cheque[0].location,
              null
            )
          );
        }
        
        if (payload.msme && req.files.msme && req.files.msme[0]?.location) {
          documentPromises.push(
            hospitalityModel.saveHotelDocument(
              hotelId,
              'msme',
              req.files.msme[0].location,
              payload.msme
            )
          );
        }
        
        await Promise.all(documentPromises);
      }

      return res.status(200).json({
        status: 1,
        data: updated,
        message: 'Business unit updated successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  mapUsers: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const userIds = req.body.user_ids || [];
      const autoMapProjects = req.body.auto_map_projects === true;
      let hotelId =
        req.body.hotel_id !== undefined && req.body.hotel_id !== null
          ? parseInt(req.body.hotel_id, 10)
          : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      if (mappingType === 1) {
        if (!hotelId) {
          return res.status(400).json({
            status: 2,
            message: 'Hotel is required for hotel level mapping'
          });
        }
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      } else {
        hotelId = null;
      }

      const allowedUsers = await hospitalityModel.filterUsersByCompany(
        userIds,
        company.id
      );
      const sanitizedUserIds = allowedUsers.map((u) => parseInt(u.id, 10));

      if (!sanitizedUserIds.length) {
        return res.status(400).json({
          status: 2,
          message: 'No valid users found for this company'
        });
      }

      const rows = sanitizedUserIds.map((userId) => ({
        user_id: userId,
        hospitality_company_id: record.id,
        hospitality_hotel_id: hotelId,
        mapping_type: mappingType,
        auto_map_projects: autoMapProjects,
        created_by: req.user.id
      }));

      await hospitalityModel.insertUserMappings(rows);

      if (autoMapProjects) {
        const projectMappings =
          await hospitalityModel.getProjectMappingsForContext(
            record.id,
            mappingType,
            hotelId
          );
        if (projectMappings.length) {
          await Promise.all(
            projectMappings.flatMap((mapping) =>
              sanitizedUserIds.map(async (userId) => {
                const isMember = await projectModel.isTeamMember(
                  mapping.project_id,
                  userId
                );
                if (!isMember) {
                  return projectModel.addTeamMember({
                    project_id: mapping.project_id,
                    user_id: userId,
                    role: 2,
                    created_by: req.user.id
                  });
                }
              })
            )
          );
        }
      }

      return res.status(200).json({
        status: 1,
        message: 'Users mapped successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  mapProjects: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const projectIds = req.body.project_ids || [];
      let hotelId =
        req.body.hotel_id !== undefined && req.body.hotel_id !== null
          ? parseInt(req.body.hotel_id, 10)
          : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      if (mappingType === 1) {
        if (!hotelId) {
          return res.status(400).json({
            status: 2,
            message: 'Hotel is required for hotel level mapping'
          });
        }
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== record.id) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      } else {
        hotelId = null;
      }

      const allowedProjects = await hospitalityModel.filterProjectsByCompany(
        projectIds,
        company.id
      );
      const sanitizedProjectIds = allowedProjects.map((p) => parseInt(p.id, 10));

      if (!sanitizedProjectIds.length) {
        return res.status(400).json({
          status: 2,
          message: 'No valid projects found for this company'
        });
      }

      const rows = sanitizedProjectIds.map((projectId) => ({
        project_id: projectId,
        hospitality_company_id: record.id,
        hospitality_hotel_id: hotelId,
        mapping_type: mappingType,
        created_by: req.user.id
      }));

      const inserted = await hospitalityModel.insertProjectMappings(rows);

      if (inserted.length) {
        const autoUsers = await hospitalityModel.getAutoMapUsersForContext(
          record.id,
          mappingType,
          hotelId
        );
        if (autoUsers.length) {
          await Promise.all(
            inserted.flatMap((mapping) =>
              autoUsers.map(async (user) => {
                const isMember = await projectModel.isTeamMember(
                  mapping.project_id,
                  user.user_id
                );
                if (!isMember) {
                  return projectModel.addTeamMember({
                    project_id: mapping.project_id,
                    user_id: user.user_id,
                    role: 2,
                    created_by: req.user.id
                  });
                }
              })
            )
          );
        }
      }

      return res.status(200).json({
        status: 1,
        message: 'Projects mapped successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMappedUserIds: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.query.mapping_type, 10);
      const hotelId = req.query.hotel_id ? parseInt(req.query.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const mappedUsers = await hospitalityModel.getMappedUserIds(
        hospitalityCompanyId,
        mappingType,
        hotelId
      );

      return res.status(200).json({
        status: 1,
        data: mappedUsers.map(u => u.user_id)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMappedProjectIds: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingType = parseInt(req.query.mapping_type, 10);
      const hotelId = req.query.hotel_id ? parseInt(req.query.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const mappedProjects = await hospitalityModel.getMappedProjectIds(
        hospitalityCompanyId,
        mappingType,
        hotelId
      );

      return res.status(200).json({
        status: 1,
        data: mappedProjects.map(p => p.project_id)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getProjectMappings: async (req, res) => {
    try {
      const projectId = parseInt(req.params.project_id, 10);
      const mappings = await hospitalityModel.getProjectMappings(projectId);

      return res.status(200).json({
        status: 1,
        data: mappings
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  deleteProjectMapping: async (req, res) => {
    try {
      const company = req.companyDetails;
      const projectId = parseInt(req.params.project_id, 10);
      const companyId = parseInt(req.body.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const hotelId = req.body.hotel_id ? parseInt(req.body.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(companyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      await hospitalityModel.deleteProjectMappings(
        projectId,
        companyId,
        mappingType,
        hotelId
      );

      // Remove team members that were added via this hospitality context
      const contextUsers = await hospitalityModel.getMappedUserIds(
        companyId,
        mappingType,
        hotelId
      );
      if (contextUsers && contextUsers.length) {
        await Promise.all(
          contextUsers.map((row) =>
            projectModel.removeTeamMember(projectId, row.user_id)
          )
        );
      }

      return res.status(200).json({
        status: 1,
        message: 'Project mapping deleted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getUserMappingsById: async (req, res) => {
    try {
      const userId = parseInt(req.params.user_id, 10);
      if (!userId) {
        return res.status(400).json({ status: 0, message: 'user_id is required' });
      }
      const mappings = await hospitalityModel.getUserMappings(userId);
      return res.status(200).json({ status: 1, data: mappings });
    } catch (error) {
      console.error('Error fetching user mappings:', error);
      return res.status(500).json({ status: 3, message: 'Failed to fetch user mappings' });
    }
  },

  deleteUserMapping: async (req, res) => {
    try {
      const company = req.companyDetails;
      const userId = parseInt(req.params.user_id, 10);
      const companyId = parseInt(req.body.company_id, 10);
      const mappingType = parseInt(req.body.mapping_type, 10);
      const hotelId = req.body.hotel_id ? parseInt(req.body.hotel_id, 10) : null;

      const record = await hospitalityModel.getCompanyById(companyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      await hospitalityModel.deleteUserMappings(userId, companyId, mappingType, hotelId);

      return res.status(200).json({
        status: 1,
        message: 'User mapping deleted successfully'
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  listCompanyUserMappings: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const mappingTypeParam = req.query.mapping_type;
      let mappingType = null;
      if (mappingTypeParam !== undefined) {
        mappingType = parseInt(mappingTypeParam, 10);
        if (![0, 1].includes(mappingType)) {
          return res.status(400).json({
            status: 2,
            message: 'Invalid mapping_type value'
          });
        }
      }
      let hotelId = null;
      if (mappingType === 1) {
        const hotelParam = req.query.hotel_id;
        if (!hotelParam) {
          return res.status(400).json({
            status: 2,
            message: 'hotel_id is required for hotel level mappings'
          });
        }
        hotelId = parseInt(hotelParam, 10);
        const hotelRecord = await hospitalityModel.getHotelById(hotelId);
        if (!hotelRecord || hotelRecord.hospitality_company_id !== hospitalityCompanyId) {
          return res.status(404).json({
            status: 2,
            message: 'Hotel not found in selected company'
          });
        }
      }

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({
          status: 2,
          message: 'Hospitality company not found'
        });
      }

      const includeAll = req.query.include_all === 'true' && mappingType === null;
      const mappings = await hospitalityModel.getUserMappingsForCompany(
        hospitalityCompanyId,
        mappingType,
        mappingType === 1 ? hotelId : null,
        includeAll
      );

      return res.status(200).json({
        status: 1,
        data: mappings
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  getMyContexts: async (req, res) => {
    try {
      const mappings = await hospitalityModel.getUserContexts(req.user.id);

      // Group flat mappings into companies with nested hotels
      const companyMap = {};

      for (const mapping of mappings) {
        const companyId = mapping.hospitality_company_id;

        if (!companyMap[companyId]) {
          companyMap[companyId] = {
            id: companyId,
            name: mapping.company_name,
            isCompanyLevel: false,
            hotels: []
          };
        }

        if (mapping.mapping_type === 0) {
          companyMap[companyId].isCompanyLevel = true;
        }

        if (mapping.mapping_type === 1 && mapping.hospitality_hotel_id) {
          companyMap[companyId].hotels.push({
            id: mapping.hospitality_hotel_id,
            name: mapping.hotel_name
          });
        }
      }

      // For company-level mappings, fetch ALL hotels in those companies
      for (const companyId of Object.keys(companyMap)) {
        if (companyMap[companyId].isCompanyLevel) {
          const allHotels = await hospitalityModel.getHotelsByCompany(
            parseInt(companyId, 10)
          );
          companyMap[companyId].hotels = allHotels.map((h) => ({
            id: h.id,
            name: h.name
          }));
        }
      }

      // Clean up internal flag before sending
      const grouped = Object.values(companyMap).map(({ isCompanyLevel, ...rest }) => rest);

      return res.status(200).json({
        status: 1,
        data: grouped
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  
  /**
   * @created : mukul jatav 
   * get all hotels currently mapped to the specified RFQ.
 */
  getRFQHotels: async (req, res) => {
    try {

      const rfq_id = req.params.rfq_id;

      //  check if rfg exist
      const rfqExist = await rfqModel.checkIfExists('tbl_rfq', `id = ${rfq_id}`);
      if( rfqExist.length === 0 ) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ not found'
        });
      }

      //  fetch mapped hotels with names
      const mappedHotels = await db.any(
        `SELECT rhm.rfq_id, rhm.hotel_id,
                rhm.hotel_id AS hospitality_hotel_id,
                h.name AS hotel_name,
                h.city
         FROM tbl_rfq_hotel_mappings rhm
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = rhm.hotel_id
         WHERE rhm.rfq_id = $1
         ORDER BY h.name`,
        [rfq_id]
      );

      return res.status(200).json({
        status: 1,
        data: mappedHotels
      });

    } catch (error) {
      logError(error);

      //  throw error
       return res.status(500).json({
        message: "failed to fetch hotels",
        error: error
      });
    }
  },

  getHotelDocuments: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);

      if (!hotelId) {
        return res.status(400).json({
          status: 0,
          message: "Hotel ID is required"
        });
      }

      const documents = await hospitalityModel.getHotelDocuments(hotelId);

      return res.status(200).json({
        status: 1,
        data: documents
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Send payment link email to the business unit email
  sendPaymentLink: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);
      const hotel = await hospitalityModel.getHotelPaymentDetails(hotelId);

      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      if (!hotel.email) {
        return res.status(400).json({ status: 0, message: 'No email configured for this business unit' });
      }

      if (!hotel.fee_amount || hotel.fee_amount <= 0) {
        return res.status(400).json({ status: 0, message: 'Fee amount not configured for this business unit' });
      }

      // Generate a payment link URL
      // Prefer configured FRONT_END_WEBSITE, fall back to FRONTEND_URL, then localhost
      const frontendUrl =
        process.env.FRONT_END_WEBSITE ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000';
      const paymentLink = `${frontendUrl}/hotel-payment?hotel_id=${hotelId}`;

      // Send email using the standard WorkWise template
      const { sendMail } = await import('../../helper/common.js');
      const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

      const headerContent = `<h2 style=\"margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;\">Welcome, ${hotel.name}!</h2>`;
      const containerContent = `
        <p style=\"font-size: 15px; color: #4b5563; margin: 0 0 16px;\">
          You have been added as a business unit under <strong>${hotel.company_name}</strong> on the Phileein Hospitality Procurement Platform.
          To activate your business unit, please complete the onboarding payment.
        </p>
        <div style=\"background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;\">
          <p style=\"margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;\">Payment Details</p>
          <p style=\"margin: 0; font-size: 26px; font-weight: 700; color: #158993;\">₹ ${hotel.fee_amount}</p>
        </div>
        <div style=\"text-align: center; margin: 24px 0 12px;\">
          <a href=\"${paymentLink}\"
             style=\"background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;\">
            Complete Payment
          </a>
        </div>
        <p style=\"font-size: 12px; color: #9ca3af; margin: 0; text-align: center;\">
          If the button doesn't work, copy and paste this link into your browser:<br/>
          <a href=\"${paymentLink}\" style=\"color: #158993; word-break: break-all;\">${paymentLink}</a>
        </p>
      `;

      const html = generateEmailTemplate(headerContent, containerContent, null);

      await sendMail({
        from: Config.webmasterMail,
        to: hotel.email,
        subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${hotel.name}`,
        html
      });

      // Update payment status to onboarding (mail sent)
      await hospitalityModel.updateHotelPaymentStatus(hotelId, 'onboarding');

      return res.status(200).json({
        status: 1,
        message: 'Payment link sent successfully',
        data: { email: hotel.email }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Send batch payment links (company-level or BU-level)
  sendBatchPaymentLinks: async (req, res) => {
    try {
      const { company_id, payment_mode, hotel_ids } = req.body;

      // Validate input
      if (!company_id) {
        return res.status(400).json({ status: 0, message: 'company_id is required' });
      }

      if (!payment_mode || !['bu', 'company'].includes(payment_mode)) {
        return res.status(400).json({ status: 0, message: 'payment_mode must be "bu" or "company"' });
      }

      if (!hotel_ids || !Array.isArray(hotel_ids) || hotel_ids.length === 0) {
        return res.status(400).json({ status: 0, message: 'hotel_ids array is required and must not be empty' });
      }

      // Fetch all selected hotels with company information
      const hotels = await hospitalityModel.getHotelsByIds(hotel_ids);

      if (!hotels || hotels.length === 0) {
        return res.status(404).json({ status: 0, message: 'No valid business units found' });
      }

      const { sendMail } = await import('../../helper/common.js');
      const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

      const frontendUrl =
        process.env.FRONT_END_WEBSITE ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000';

      const companyName = hotels[0]?.company_name || 'Your Company';

      if (payment_mode === 'bu') {
        // BU Mode: Validate all hotels have emails
        const hotelsWithoutEmail = hotels.filter(h => !h.email);
        if (hotelsWithoutEmail.length > 0) {
          const hotelNames = hotelsWithoutEmail.map(h => h.name || `ID: ${h.id}`).join(', ');
          return res.status(400).json({
            status: 0,
            message: `Some business units missing email: ${hotelNames}`
          });
        }

        // Send individual payment links to each BU
        const emailPromises = hotels.map(async (hotel) => {
          const paymentLink = `${frontendUrl}/hotel-payment?hotel_id=${hotel.id}`;

          const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Welcome, ${hotel.name}!</h2>`;
          const containerContent = `
            <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
              You have been added as a business unit under <strong>${companyName}</strong> on the Phileein Hospitality Procurement Platform.
              To activate your business unit, please complete the onboarding payment.
            </p>
            <div style="background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;">
              <p style="margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Payment Details</p>
              <p style="margin: 0; font-size: 26px; font-weight: 700; color: #158993;">₹ ${hotel.fee_amount}</p>
            </div>
            <div style="text-align: center; margin: 24px 0 12px;">
              <a href="${paymentLink}"
                 style="background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
                Complete Payment
              </a>
            </div>
            <p style="font-size: 12px; color: #9ca3af; margin: 0; text-align: center;">
              If the button doesn't work, copy and paste this link into your browser:<br/>
              <a href="${paymentLink}" style="color: #158993; word-break: break-all;">${paymentLink}</a>
            </p>
          `;

          const html = generateEmailTemplate(headerContent, containerContent, null);

          await sendMail({
            from: Config.webmasterMail,
            to: hotel.email,
            subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${hotel.name}`,
            html
          });

          await hospitalityModel.updateHotelPaymentStatus(hotel.id, 'onboarding');
        });

        await Promise.all(emailPromises);

        return res.status(200).json({
          status: 1,
          message: `Payment links sent to ${hotels.length} business unit(s)`,
          data: {
            mode: 'bu',
            hotels_count: hotels.length,
            emails: hotels.map(h => h.email)
          }
        });

      } else {
        // Company Mode: Send consolidated payment link
        const companyEmail = hotels[0]?.company_email;

        if (!companyEmail) {
          return res.status(400).json({
            status: 0,
            message: 'Company contact email not configured. Please update company email before sending payment links.'
          });
        }

        const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);
        const hotelIdsParam = hotel_ids.join(',');
        const paymentLink = `${frontendUrl}/hotel-payment?company_id=${company_id}&hotel_ids=${hotelIdsParam}`;

        const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Welcome, ${companyName}!</h2>`;

        const hotelsList = hotels.map(h =>
          `<li style="margin: 8px 0; font-size: 14px; color: #4b5563;">
            <strong>${h.name}</strong> - ₹${h.fee_amount}
          </li>`
        ).join('');

        const containerContent = `
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
            Your business units have been added to the Phileein Hospitality Procurement Platform.
            To activate all business units, please complete the consolidated onboarding payment.
          </p>
          <div style="background: #f9fafb; border-radius: 12px; padding: 16px 20px; margin: 16px 0;">
            <p style="margin: 0 0 12px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Business Units</p>
            <ul style="list-style: none; padding: 0; margin: 0;">${hotelsList}</ul>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;" />
            <p style="margin: 0 0 6px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em;">Total Payment</p>
            <p style="margin: 0; font-size: 26px; font-weight: 700; color: #158993;">₹ ${totalAmount.toFixed(2)}</p>
          </div>
          <div style="text-align: center; margin: 24px 0 12px;">
            <a href="${paymentLink}"
               style="background-color: #158993; color: #ffffff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
              Complete Payment
            </a>
          </div>
          <p style="font-size: 12px; color: #9ca3af; margin: 0; text-align: center;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${paymentLink}" style="color: #158993; word-break: break-all;">${paymentLink}</a>
          </p>
        `;

        const html = generateEmailTemplate(headerContent, containerContent, null);

        await sendMail({
          from: Config.webmasterMail,
          to: companyEmail,
          subject: `Phileein Hospitality Procurement Platform - Complete Payment for ${companyName}`,
          html
        });

        // Update all hotels to onboarding status
        await Promise.all(hotel_ids.map(hotelId =>
          hospitalityModel.updateHotelPaymentStatus(hotelId, 'onboarding')
        ));

        return res.status(200).json({
          status: 1,
          message: 'Consolidated payment link sent successfully',
          data: {
            mode: 'company',
            hotels_count: hotels.length,
            total_amount: totalAmount,
            email: companyEmail
          }
        });
      }
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Create Razorpay payment order for hotel onboarding (public endpoint - no auth required)
  // Supports both single hotel and consolidated company payments
  createHotelPaymentOrder: async (req, res) => {
    try {
      const { hotel_id, company_id, hotel_ids } = req.body;

      // Handle consolidated company payment
      if (company_id && hotel_ids && Array.isArray(hotel_ids) && hotel_ids.length > 0) {
        const hotelIds = hotel_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

        if (hotelIds.length === 0) {
          return res.status(400).json({ status: 0, message: 'Invalid hotel_ids array' });
        }

        const hotels = await hospitalityModel.getHotelsByIds(hotelIds);

        if (!hotels || hotels.length === 0) {
          return res.status(404).json({ status: 0, message: 'No valid business units found' });
        }

        // Verify all hotels belong to the same company
        const companyIds = [...new Set(hotels.map(h => h.hospitality_company_id))];
        if (companyIds.length > 1 || companyIds[0] !== company_id) {
          return res.status(400).json({ status: 0, message: 'All business units must belong to the specified company' });
        }

        // Check if all hotels are already paid or have in-progress payments
        const paymentChecks = await Promise.all(
          hotelIds.map(hotelId => hospitalityModel.getHotelPayment(hotelId))
        );
        const allPaid = paymentChecks.every(payment => payment?.payment_status === 'success');
        if (allPaid) {
          return res.status(200).json({
            status: 1,
            data: { already_paid: true }
          });
        }
        // If any hotel has an in-progress payment, return existing order details
        const inProgressPayment = paymentChecks.find(p => p && ['created', 'pending'].includes(p.payment_status) && p.razorpay_order_id);
        if (inProgressPayment) {
          return res.status(200).json({
            status: 1,
            data: {
              order: { id: inProgressPayment.razorpay_order_id, amount: inProgressPayment.amount, currency: 'INR' },
              payment_id: inProgressPayment.id,
              amount: inProgressPayment.amount / 100,
              razorpay_key: Config.razorpay.razorpay_key
            }
          });
        }

        const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);

        if (totalAmount <= 0) {
          return res.status(400).json({ status: 0, message: 'Total fee amount must be greater than 0' });
        }

        const { default: Razorpay } = await import('razorpay');
        const razorpay = new Razorpay({
          key_id: Config.razorpay.razorpay_key,
          key_secret: Config.razorpay.razorpay_secret
        });

        const amountInPaise = Math.round(totalAmount * 100);
        const receipt = `COMPANY-${company_id}-${Date.now()}`;

        const order = await razorpay.orders.create({
          amount: amountInPaise,
          currency: 'INR',
          receipt,
          payment_capture: 1
        });

        const beforePayload = JSON.stringify(order);

        // Use the first hotel's created_by as the user_id (or 0 if not available)
        const userId = hotels[0]?.created_by || 0;

        const paymentRow = await hospitalityModel.createHotelPayment({
          user_id: userId,
          amount: amountInPaise,
          currency: 'INR',
          payment_status: 'created',
          razorpay_order_id: order.id,
          receipt,
          before_payment_response: beforePayload
        });

        // Update all hotels payment_status to pending
        await Promise.all(hotelIds.map(hotelId =>
          hospitalityModel.updateHotelPaymentStatus(hotelId, 'pending')
        ));

        return res.status(200).json({
          status: 1,
          data: {
            order,
            payment_id: paymentRow.id,
            company_name: hotels[0]?.company_name,
            company_id: company_id,
            hotel_ids: hotelIds,
            hotels: hotels.map(h => ({ id: h.id, name: h.name, fee_amount: h.fee_amount })),
            total_amount: totalAmount,
            razorpay_key: Config.razorpay.razorpay_key
          }
        });
      }

      // Handle single hotel payment (existing logic)
      if (!hotel_id) {
        return res.status(400).json({ status: 0, message: 'hotel_id is required for single hotel payment, or company_id and hotel_ids for consolidated payment' });
      }

      const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      if (!hotel.fee_amount || hotel.fee_amount <= 0) {
        return res.status(400).json({ status: 0, message: 'Fee amount not configured' });
      }

      // Check for existing payment (success, created, or pending)
      const existingPayment = await hospitalityModel.getHotelPayment(hotel_id);
      if (existingPayment && existingPayment.payment_status === 'success') {
        return res.status(200).json({
          status: 1,
          data: { already_paid: true, payment_id: existingPayment.id }
        });
      }
      // If a payment order already exists (created/pending), return the existing order
      if (existingPayment && ['created', 'pending'].includes(existingPayment.payment_status) && existingPayment.razorpay_order_id) {
        return res.status(200).json({
          status: 1,
          data: {
            order: { id: existingPayment.razorpay_order_id, amount: existingPayment.amount, currency: 'INR' },
            payment_id: existingPayment.id,
            hotel_name: hotel.name,
            company_name: hotel.company_name,
            amount: hotel.fee_amount,
            razorpay_key: Config.razorpay.razorpay_key
          }
        });
      }

      const { default: Razorpay } = await import('razorpay');
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });

      const amountInPaise = hotel.fee_amount * 100;
      const receipt = `HOTEL-${hotel_id}-${Date.now()}`;

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        payment_capture: 1
      });

      const beforePayload = JSON.stringify(order);

      const paymentRow = await hospitalityModel.createHotelPayment({
        user_id: hotel.created_by,
        amount: amountInPaise,
        currency: 'INR',
        payment_status: 'created',
        razorpay_order_id: order.id,
        receipt,
        before_payment_response: beforePayload
      });

      // Update hotel payment_status to pending (payment attempt made)
      await hospitalityModel.updateHotelPaymentStatus(hotel_id, 'pending');

      return res.status(200).json({
        status: 1,
        data: {
          order,
          payment_id: paymentRow.id,
          hotel_name: hotel.name,
          company_name: hotel.company_name,
          amount: hotel.fee_amount,
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({ status: 3, message: error.message });
    }
  },

  // Verify Razorpay payment for hotel onboarding (public endpoint)
  // Supports both single hotel and consolidated company payments
  verifyHotelPayment: async (req, res) => {
    try {
      const { hotel_id, company_id, hotel_ids, razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ status: 0, message: 'Missing required payment verification fields' });
      }

      // Verify signature
      const { createHmac } = await import('crypto');
      const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSign = createHmac('sha256', Config.razorpay.razorpay_secret)
        .update(sign)
        .digest('hex');

      const isValid = expectedSign === razorpay_signature;

      const afterPayload = JSON.stringify({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        verified: isValid
      });

      // Update payment record
      await hospitalityModel.updateHotelPayment(payment_id, {
        razorpay_payment_id,
        razorpay_signature,
        payment_status: isValid ? 'success' : 'failed',
        after_payment_response: afterPayload
      });

      if (isValid) {
        // Handle consolidated company payment
        if (company_id && hotel_ids && Array.isArray(hotel_ids) && hotel_ids.length > 0) {
          const hotelIds = hotel_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

          // Update all hotels status to active
          await Promise.all(hotelIds.map(hotelId =>
            hospitalityModel.updateHotelPaymentStatus(hotelId, 'active')
          ));

          // Send confirmation email to company email
          try {
            const hotels = await hospitalityModel.getHotelsByIds(hotelIds);
            if (hotels && hotels.length > 0) {
              const companyEmail = hotels[0]?.company_email;
              const companyName = hotels[0]?.company_name || 'Your Company';
              const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);

              if (companyEmail) {
                const { sendMail } = await import('../../helper/common.js');
                const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

                const hotelsList = hotels.map(h =>
                  `<li style="margin: 8px 0; font-size: 14px; color: #4b5563;">
                    <strong>${h.name}</strong> - ₹${h.fee_amount}
                  </li>`
                ).join('');

                const headerContent = `<h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;">Payment Successful</h2>`;
                const containerContent = `
                  <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px;">
                    All business units for <strong>${companyName}</strong> have been successfully activated on the Phileein Hospitality Procurement Platform.
                  </p>
                  <div style="background: #f0fdf4; padding: 14px 18px; border-radius: 10px; border: 1px solid #bbf7d0; margin: 16px 0 8px;">
                    <p style="margin: 0 0 12px; color: #166534; font-size: 14px; font-weight: 600;">Business Units Activated:</p>
                    <ul style="list-style: none; padding: 0; margin: 0;">${hotelsList}</ul>
                    <hr style="border: none; border-top: 1px solid #bbf7d0; margin: 12px 0;" />
                    <p style="margin: 0; color: #166534; font-size: 14px;">
                      <strong>Total Amount Paid:</strong> ₹ ${totalAmount.toFixed(2)}<br/>
                      <strong>Payment ID:</strong> ${razorpay_payment_id}
                    </p>
                  </div>
                  <p style="font-size: 13px; color: #6b7280; margin: 12px 0 0;">
                    Tax invoice and payment received documents are attached to this email.
                  </p>
                  <p style="font-size: 13px; color: #6b7280; margin: 12px 0 0;">
                    You can now start using your business units or contact your administrator for any assistance.
                  </p>
                `;

                const html = generateEmailTemplate(headerContent, containerContent, null);

                const mailOpts = {
                  from: Config.webmasterMail,
                  to: companyEmail,
                  subject: `Phileein Hospitality Procurement Platform - Payment Confirmed for ${companyName}`,
                  html
                };

                try {
                  const paymentRecord = await hospitalityModel.getPaymentById(payment_id);
                  const receipt = paymentRecord?.receipt || `COMPANY-${company_id}-${Date.now()}`;
                  const amountInRupees = paymentRecord?.amount ? paymentRecord.amount / 100 : totalAmount;
                  const lineItems = hotels.map(h => ({ name: `Business Unit: ${h.name}`, amount: h.fee_amount }));

                  const taxInvoicePdf = await generateTaxInvoicePdf({
                    type: 'Business Unit Onboarding',
                    recipientName: companyName,
                    amount: amountInRupees,
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    receipt,
                    lineItems
                  });
                  const paymentReceivedPdf = await generatePaymentReceivedPdf({
                    recipientName: companyName,
                    amount: amountInRupees,
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    description: `Business Units Onboarding - ${companyName}`
                  });

                  const attachments = [];
                  if (taxInvoicePdf?.filePath && fs.existsSync(taxInvoicePdf.filePath)) {
                    attachments.push({ filename: taxInvoicePdf.fileName, path: taxInvoicePdf.filePath, contentType: 'application/pdf' });
                  }
                  if (paymentReceivedPdf?.filePath && fs.existsSync(paymentReceivedPdf.filePath)) {
                    attachments.push({ filename: paymentReceivedPdf.fileName, path: paymentReceivedPdf.filePath, contentType: 'application/pdf' });
                  }
                  if (attachments.length) mailOpts.attachments = attachments;
                } catch (docErr) {
                  logError('BU payment doc generation failed:', docErr);
                }

                await sendMail(mailOpts);
              }
            }
          } catch (emailError) {
            logError('Email failed but payment verified:', emailError);
          }

          return res.status(200).json({
            status: 1,
            message: 'Payment verified successfully. All business units are now active.',
            data: { verified: true, hotel_ids: hotelIds }
          });
        }

        // Handle single hotel payment (existing logic)
        if (!hotel_id) {
          return res.status(400).json({ status: 0, message: 'hotel_id is required for single hotel payment, or company_id and hotel_ids for consolidated payment' });
        }

        // Update hotel status to active
        await hospitalityModel.updateHotelPaymentStatus(hotel_id, 'active');

        // Send confirmation email with tax invoice and payment received attachments
        try {
          const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
          if (hotel?.email) {
            const { sendMail } = await import('../../helper/common.js');
            const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

            const headerContent = `<h2 style=\"margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;\">Payment Successful</h2>`;
            const containerContent = `
              <p style=\"font-size: 15px; color: #4b5563; margin: 0 0 16px;\">
                Your business unit <strong>${hotel.name}</strong> has been successfully activated on the Phileein Hospitality Procurement Platform.
              </p>
              <div style=\"background: #f0fdf4; padding: 14px 18px; border-radius: 10px; border: 1px solid #bbf7d0; margin: 16px 0 8px;\">
                <p style=\"margin: 0; color: #166534; font-size: 14px;\">
                  <strong>Amount Paid:</strong> ₹ ${hotel.fee_amount?.toLocaleString('en-IN') || hotel.fee_amount}<br/>
                  <strong>Payment ID:</strong> ${razorpay_payment_id}
                </p>
              </div>
              <p style=\"font-size: 13px; color: #6b7280; margin: 12px 0 0;\">
                Tax invoice and payment received documents are attached to this email.
              </p>
              <p style=\"font-size: 13px; color: #6b7280; margin: 12px 0 0;\">
                You can now start using your business unit or contact your administrator for any assistance.
              </p>
            `;

            const html = generateEmailTemplate(headerContent, containerContent, null);

            const mailOpts = {
              from: Config.webmasterMail,
              to: hotel.email,
              subject: `Phileein Hospitality Procurement Platform - Payment Confirmed for ${hotel.name}`,
              html
            };

            try {
              const paymentRecord = await hospitalityModel.getPaymentById(payment_id);
              const receipt = paymentRecord?.receipt || `HOTEL-${hotel_id}-${Date.now()}`;
              const amountInRupees = paymentRecord?.amount ? paymentRecord.amount / 100 : hotel.fee_amount;

              const taxInvoicePdf = await generateTaxInvoicePdf({
                type: 'Business Unit Onboarding',
                recipientName: hotel.company_name || hotel.name,
                amount: amountInRupees,
                paymentId: razorpay_payment_id,
                orderId: razorpay_order_id,
                receipt,
                lineItems: [{ name: `Business Unit: ${hotel.name}`, amount: hotel.fee_amount }]
              });
              const paymentReceivedPdf = await generatePaymentReceivedPdf({
                recipientName: hotel.company_name || hotel.name,
                amount: amountInRupees,
                paymentId: razorpay_payment_id,
                orderId: razorpay_order_id,
                description: `Business Unit Onboarding - ${hotel.name}`
              });

              const attachments = [];
              if (taxInvoicePdf?.filePath && fs.existsSync(taxInvoicePdf.filePath)) {
                attachments.push({ filename: taxInvoicePdf.fileName, path: taxInvoicePdf.filePath, contentType: 'application/pdf' });
              }
              if (paymentReceivedPdf?.filePath && fs.existsSync(paymentReceivedPdf.filePath)) {
                attachments.push({ filename: paymentReceivedPdf.fileName, path: paymentReceivedPdf.filePath, contentType: 'application/pdf' });
              }
              if (attachments.length) mailOpts.attachments = attachments;
            } catch (docErr) {
              logError('BU payment doc generation failed:', docErr);
            }

            await sendMail(mailOpts);
          }
        } catch (emailError) {
          logError('Email failed but payment verified:', emailError);
        }

        return res.status(200).json({
          status: 1,
          message: 'Payment verified successfully. Business unit is now active.',
          data: { verified: true }
        });
      } else {
        return res.status(400).json({
          status: 0,
          message: 'Payment verification failed. Invalid signature.',
          data: { verified: false }
        });
      }
    } catch (error) {
      logError('Payment verification error:', error);
      console.error('Full error details:', error);
      return res.status(400).json({
        status: 3,
        message: error.message || 'Payment verification failed',
        error: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  },

  // Get hotel payment info (public endpoint for payment page)
  getHotelPaymentInfo: async (req, res) => {
    try {
      const hotelId = parseInt(req.params.hotel_id, 10);
      if (!hotelId) {
        return res.status(400).json({ status: 0, message: 'hotel_id is required' });
      }

      const hotel = await hospitalityModel.getHotelPaymentDetails(hotelId);
      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      const existingPayment = await hospitalityModel.getHotelPayment(hotelId);

      return res.status(200).json({
        status: 1,
        data: {
          id: hotel.id,
          name: hotel.name,
          company_name: hotel.company_name,
          fee_amount: hotel.fee_amount,
          payment_status: hotel.payment_status,
          email: hotel.email,
          already_paid: existingPayment?.payment_status === 'success',
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  // Get company-level payment info (consolidated payment for multiple hotels)
  getCompanyPaymentInfo: async (req, res) => {
    try {
      const companyId = parseInt(req.query.company_id, 10);
      const hotelIdsParam = req.query.hotel_ids;

      if (!companyId || !hotelIdsParam) {
        return res.status(400).json({ status: 0, message: 'company_id and hotel_ids are required' });
      }

      const hotelIds = hotelIdsParam.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));

      if (hotelIds.length === 0) {
        return res.status(400).json({ status: 0, message: 'Invalid hotel_ids parameter' });
      }

      const hotels = await hospitalityModel.getHotelsByIds(hotelIds);

      if (!hotels || hotels.length === 0) {
        return res.status(404).json({ status: 0, message: 'No valid business units found' });
      }

      // Verify all hotels belong to the same company
      const companyIds = [...new Set(hotels.map(h => h.hospitality_company_id))];
      if (companyIds.length > 1 || companyIds[0] !== companyId) {
        return res.status(400).json({ status: 0, message: 'All business units must belong to the specified company' });
      }

      const totalAmount = hotels.reduce((sum, h) => sum + parseFloat(h.fee_amount || 0), 0);
      const companyName = hotels[0]?.company_name || 'Company';

      // Check if all hotels are already paid by checking their payment_status field
      // (when payment is verified, hotels are updated to 'active' status)
      const allPaid = hotels.every(hotel => hotel.payment_status === 'active');

      return res.status(200).json({
        status: 1,
        data: {
          company_id: companyId,
          company_name: companyName,
          company_email: hotels[0]?.company_email,
          hotels: hotels.map(h => ({
            id: h.id,
            name: h.name,
            fee_amount: h.fee_amount,
            payment_status: h.payment_status
          })),
          total_amount: totalAmount,
          hotel_ids: hotelIds,
          already_paid: allPaid,
          razorpay_key: Config.razorpay.razorpay_key
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get vendor's hotel and category mappings
   * Returns all active subscriptions for the authenticated vendor
   * Organizes categories into hierarchical structure (main categories with sub-categories)
   *
   * @route GET /api/v1/hospitality/vendor/my-mappings
   * @access Private (Vendors only)
   */
  getVendorMappings: async (req, res) => {
    try {
      const vendorId = req.user.id;

      // Get all active subscriptions from model
      const { hotels, categories } = await hospitalityModel.getVendorHotelCategoryMappings(vendorId);

      // Process categories into hierarchical structure
      // Group by parent_id to identify main categories and their sub-categories
      const mainCategoryMap = new Map();
      const standaloneSubs = [];

      // First pass: Build main categories map
      categories.forEach(cat => {
        if (!cat.parent_id || cat.parent_id === 0) {
          // This is a main category
          if (!mainCategoryMap.has(cat.category_id)) {
            mainCategoryMap.set(cat.category_id, {
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount,
              sub_categories: []
            });
          }
        }
      });

      // Second pass: Attach sub-categories to their parents or mark as standalone
      categories.forEach(cat => {
        if (cat.parent_id && cat.parent_id !== 0) {
          // This is a sub-category
          if (mainCategoryMap.has(cat.parent_id)) {
            // Parent exists in vendor's subscriptions
            const parent = mainCategoryMap.get(cat.parent_id);
            parent.sub_categories.push({
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              parent_category_name: cat.parent_category_name,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount
            });
          } else {
            // Vendor has sub-category but not the parent
            standaloneSubs.push({
              subscription_id: cat.subscription_id,
              category_id: cat.category_id,
              category_name: cat.category_name,
              parent_id: cat.parent_id,
              parent_category_name: cat.parent_category_name,
              start_date: cat.start_date,
              end_date: cat.end_date,
              fee_amount: cat.fee_amount
            });
          }
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          hotels,
          categories: {
            main_categories: Array.from(mainCategoryMap.values()),
            standalone_subcategories: standaloneSubs
          }
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  sendBUCredentials: async (req, res) => {
    try {
      const company = req.companyDetails;
      const hospitalityCompanyId = parseInt(req.params.company_id, 10);
      const hotelId = parseInt(req.params.hotel_id, 10);

      const record = await hospitalityModel.getCompanyById(hospitalityCompanyId);
      if (!record || record.buyer_company_id !== company.id) {
        return res.status(404).json({ status: 2, message: 'Hospitality company not found' });
      }

      const hotel = await hospitalityModel.getHotelById(hotelId);
      if (!hotel || hotel.hospitality_company_id !== hospitalityCompanyId) {
        return res.status(404).json({ status: 2, message: 'Hotel not found in selected company' });
      }

      const users = await hospitalityModel.getUsersForHotelWithPassword(hospitalityCompanyId, hotelId);

      if (!users || users.length === 0) {
        return res.status(200).json({ status: 2, message: 'No users mapped to this business unit' });
      }

      const DEFAULT_PASSWORD = 'Workwise@123';
      const loginUrl = 'https://phileeinhospitality.com';
      let emailsSent = 0;

      for (const user of users) {
        const isDefaultPassword = user.password
          ? await bcrypt.compare(DEFAULT_PASSWORD, user.password)
          : false;

        const employeeCodeLine = user.employee_code
          ? `<li style="padding:4px 0;"><strong>Employee Code:</strong> ${user.employee_code}</li>`
          : '';

        let credentialsBlock;
        if (isDefaultPassword) {
          credentialsBlock = `
            <div style="background-color:#EFF6FF; border-left:4px solid #3B82F6; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0 0 8px 0; font-weight:600; color:#1E40AF;">Your Login Credentials:</p>
              <ul style="list-style:none; padding:0; margin:0;">
                ${employeeCodeLine}
                <li style="padding:4px 0;"><strong>Email:</strong> ${user.email}</li>
                <li style="padding:4px 0;"><strong>Password:</strong> ${DEFAULT_PASSWORD}</li>
              </ul>
            </div>
            <p style="font-size:13px; color:#777; margin-top:8px;"><em>For security reasons, we recommend changing your password after your first login.</em></p>`;
        } else {
          credentialsBlock = `
            <div style="background-color:#FFF7ED; border-left:4px solid #F59E0B; padding:16px; margin:16px 0; border-radius:4px;">
              <p style="margin:0; color:#92400E;">Kindly login with the credentials already provided to you.</p>
              <ul style="list-style:none; padding:0; margin:8px 0 0 0;">
                ${employeeCodeLine}
                <li style="padding:4px 0;"><strong>Email:</strong> ${user.email}</li>
              </ul>
            </div>`;
        }

        const headerContent = `<h2>Hello ${user.name || 'User'},</h2>`;
        const containerContent = `
          <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>Your account has been made active for <strong>${hotel.name}</strong>.</p>
            ${credentialsBlock}
            <div style="text-align:center; margin-top:24px;">
              <a href="${loginUrl}"
                 style="background-color:#3B82F6; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
                Login Now
              </a>
            </div>
          </div>`;

        const htmlContent = generateEmailTemplate(headerContent, containerContent);

        console.log(`\n========== [BU CREDENTIALS EMAIL] ==========`);
        console.log(`To: ${user.email}`);
        console.log(`User: ${user.name}`);
        console.log(`Hotel: ${hotel.name}`);
        console.log(`Default Password: ${isDefaultPassword ? 'YES' : 'NO (changed)'}`);
        console.log(`\n--- FULL HTML ---\n`);
        console.log(htmlContent);
        console.log(`\n========== [END EMAIL] ==========\n`);

        sendMail({
          from: Config.webmasterMail,
          to: user.email,
          subject: `Your Account is Active — ${hotel.name}`,
          html: htmlContent
        });

        emailsSent++;
      }

      return res.status(200).json({
        status: 1,
        message: `Credentials email sent to ${emailsSent} user(s) for ${hotel.name}`
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * GET /api/v1/hospitality/vendor/subscription-status
   * Returns the vendor's full subscription state for the subscription management UI
   */
  getVendorSubscriptionStatus: async (req, res) => {
    try {
      const vendorId = req.user.id;

      // Mark any stale expired subscriptions first
      await hospitalityModel.markExpiredSubscriptions(vendorId);

      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      const allSubs = await hospitalityModel.getVendorSubscriptionStatus(vendorId);

      // Separate current (active/non-expired) and expired subscriptions
      // A subscription is valid if paid (success) OR admin-assigned (payment_id NULL → payment_status NULL)
      const now = Moment().startOf('day');
      const isValidSub = (s) => s.payment_status === 'paid' || s.payment_status === 'success' || !s.payment_status;
      const activeSubs = allSubs.filter(s =>
        Moment(s.end_date).isSameOrAfter(now, 'day') && isValidSub(s)
      );
      const expiredSubs = allSubs.filter(s =>
        Moment(s.end_date).isBefore(now, 'day') && isValidSub(s)
      );
      const pendingSubs = allSubs.filter(s =>
        s.payment_status === 'created' || s.payment_status === 'pending'
        || s.status === 'pending'
      );

      // Build response for active or most recent expired subscription
      const relevantSubs = activeSubs.length > 0 ? activeSubs : expiredSubs;
      const categories = relevantSubs
        .filter(s => s.item_type === 'category')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));
      const subcategories = relevantSubs
        .filter(s => s.item_type === 'subcategory')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));
      const hotels = relevantSubs
        .filter(s => s.item_type === 'hotel')
        .map(s => ({ id: s.item_id, name: s.item_name, fee_amount: s.fee_amount }));

      const endDate = relevantSubs.length > 0 ? relevantSubs[0].end_date : null;
      const startDate = relevantSubs.length > 0 ? relevantSubs[0].start_date : null;
      const daysRemaining = endDate ? Moment(endDate).diff(Moment(), 'days') : 0;
      const totalPaid = relevantSubs.reduce((sum, s) => sum + (parseFloat(s.fee_amount) || 0), 0);

      const isExpired = !hasActiveSub && expiredSubs.length > 0;
      const canRenew = isExpired || (daysRemaining >= 0 && daysRemaining <= 30);

      return res.status(200).json({
        status: 1,
        data: {
          has_active_subscription: hasActiveSub,
          subscription: relevantSubs.length > 0 ? {
            categories,
            subcategories,
            hotels,
            start_date: startDate,
            end_date: endDate,
            total_paid: totalPaid,
            payment_id: relevantSubs[0].razorpay_payment_id || null,
            days_remaining: Math.max(daysRemaining, 0)
          } : null,
          is_expired: isExpired,
          has_pending: pendingSubs.length > 0,
          can_renew: canRenew
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/renew-subscription
   * Dedicated renewal endpoint - auto-populates from previous subscription, vendor can optionally modify
   */
  renewSubscription: async (req, res) => {
    try {
      const vendorId = req.user.id;
      const { categories: reqCategories, subcategories: reqSubcategories, hotels: reqHotels } = req.body;

      // Verify vendor is a hospitality vendor
      const companyDetails = await userModel.getCompanyDetail(vendorId);
      const isHospitalityVendor =
        companyDetails && companyDetails[0] &&
        (companyDetails[0].is_hospitality === 1 || companyDetails[0].is_hospitality === '1');
      if (!isHospitalityVendor) {
        return res.status(400).json({ status: 2, message: 'Hospitality subscription not applicable' });
      }

      // Prevent double-pay: block if vendor already has active subscription
      const hasActiveSub = await hospitalityModel.hasValidPaidSubscription(vendorId);
      if (hasActiveSub) {
        return res.status(400).json({ status: 2, message: 'You already have an active subscription' });
      }

      // Get categories/hotels: use request body if provided, otherwise fall back to expired subscription
      let categoryIds = Array.isArray(reqCategories) && reqCategories.length > 0 ? reqCategories : [];
      let subcategoryIds = Array.isArray(reqSubcategories) && reqSubcategories.length > 0 ? reqSubcategories : [];
      let hotelIds = Array.isArray(reqHotels) && reqHotels.length > 0 ? reqHotels : [];

      if (!categoryIds.length && !hotelIds.length) {
        const expiredSubs = await hospitalityModel.getExpiredSubscriptionsForVendor(vendorId);
        if (expiredSubs && expiredSubs.length > 0) {
          for (const sub of expiredSubs) {
            if (sub.item_type === 'category' && !categoryIds.includes(sub.item_id)) {
              categoryIds.push(sub.item_id);
            } else if (sub.item_type === 'subcategory' && !subcategoryIds.includes(sub.item_id)) {
              subcategoryIds.push(sub.item_id);
            } else if (sub.item_type === 'hotel' && !hotelIds.includes(sub.item_id)) {
              hotelIds.push(sub.item_id);
            }
          }
        }
      }

      if (!categoryIds.length) {
        return res.status(400).json({ status: 2, message: 'No categories selected for subscription renewal' });
      }
      if (!hotelIds.length) {
        return res.status(400).json({ status: 2, message: 'No hotels selected for subscription renewal' });
      }

      // Calculate FY end date with minimum 30-day rule
      const startDate = Moment();
      const currentYear = startDate.year();
      const fyEndThisYear = Moment(`${currentYear}-03-31`, 'YYYY-MM-DD');
      let fyEnd = startDate.isAfter(fyEndThisYear) || startDate.isSame(fyEndThisYear, 'day')
        ? fyEndThisYear.clone().add(1, 'year')
        : fyEndThisYear.clone();

      // Minimum 30-day subscription
      const daysTillEnd = fyEnd.diff(startDate, 'days');
      if (daysTillEnd < 30) {
        fyEnd = fyEnd.add(1, 'year');
      }
      const fyEndDateStr = fyEnd.format('YYYY-MM-DD');

      // Calculate pricing
      let totalAmount = 0;
      const subscriptionRows = [];
      const uniqueCategoryIds = [...new Set(categoryIds)];

      if (uniqueCategoryIds.length) {
        const dbCategories = await productModel.getCategoriesByIds(uniqueCategoryIds);
        const numHotels = hotelIds.length;

        for (const row of dbCategories) {
          const baseFee = row.fee_amount || 500;
          const effectiveFee = numHotels > 0 ? baseFee * numHotels : baseFee;
          totalAmount += effectiveFee;
          subscriptionRows.push({
            vendor_id: vendorId,
            item_type: 'category',
            item_id: row.id,
            fee_amount: effectiveFee,
            start_date: startDate.format('YYYY-MM-DD'),
            end_date: fyEndDateStr,
            status: 'active'
          });
        }
      }

      if (hotelIds.length) {
        const dbHotels = await hospitalityModel.getHotelsByIds(hotelIds);
        for (const row of dbHotels) {
          subscriptionRows.push({
            vendor_id: vendorId,
            item_type: 'hotel',
            item_id: row.id,
            fee_amount: 0,
            start_date: startDate.format('YYYY-MM-DD'),
            end_date: fyEndDateStr,
            status: 'active'
          });
        }
      }

      if (!subscriptionRows.length || totalAmount <= 0) {
        return res.status(400).json({ status: 2, message: 'No valid hospitality items selected for subscription' });
      }

      // Create Razorpay order
      const digit = convertSixDigit(vendorId);
      const razorpay = new Razorpay({
        key_id: Config.razorpay.razorpay_key,
        key_secret: Config.razorpay.razorpay_secret
      });
      const options = {
        amount: totalAmount * 100,
        currency: 'INR',
        receipt: `RNW${digit}`,
        payment_capture: 1
      };
      const razorpayOrder = await razorpay.orders.create(options);

      // Store intended subscription items in payment metadata
      // Subscription rows are only created after successful payment
      const vendorPayment = await hospitalityModel.createVendorPayment({
        vendor_id: vendorId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_payment_id: null,
        razorpay_signature: null,
        amount: totalAmount,
        currency: 'INR',
        payment_status: 'created',
        metadata: {
          subscription_items: subscriptionRows,
          fy_end_date: fyEndDateStr
        }
      });

      return res.status(200).json({
        status: 1,
        data: {
          order_id: razorpayOrder.id,
          amount: totalAmount,
          currency: 'INR',
          end_date: fyEndDateStr,
          categories: uniqueCategoryIds,
          hotels: hotelIds
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * POST /api/v1/hospitality/verify-payment
   * Secure payment verification endpoint - validates Razorpay signature
   */
  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ status: 2, message: 'Missing payment verification parameters' });
      }

      // Validate Razorpay signature
      const generatedSignature = crypto
        .createHmac('sha256', Config.razorpay.razorpay_secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ status: 2, message: 'Payment verification failed - invalid signature' });
      }

      // Find the vendor payment record
      const vendorPayment = await hospitalityModel.getVendorPaymentByOrderId(razorpay_order_id);
      if (!vendorPayment || vendorPayment.length === 0) {
        return res.status(404).json({ status: 2, message: 'Payment record not found' });
      }

      const payment = vendorPayment[0];
      const userId = payment.vendor_id;

      // Mark payment as successful
      await db.none(
        `UPDATE tbl_vendor_payments
         SET razorpay_payment_id = $1,
             razorpay_signature = $2,
             payment_status = 'success'
         WHERE razorpay_order_id = $3`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      );

      // Create subscription rows from payment metadata (rows are only created after payment succeeds)
      const metadata = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
      if (metadata && metadata.subscription_items && metadata.subscription_items.length > 0) {
        const subscriptionRows = metadata.subscription_items.map(row => ({
          ...row,
          vendor_id: userId,
          payment_id: payment.id,
          status: 'active'
        }));
        await hospitalityModel.createVendorHotelCategorySubscription(subscriptionRows);
      }

      // Also link any subscriptions without payment_id (legacy registration flow)
      await db.none(
        `UPDATE tbl_vendor_hotel_category_subscription
         SET payment_id = $1, status = 'active'
         WHERE vendor_id = $2
           AND payment_id IS NULL
           AND status = 'active'`,
        [payment.id, userId]
      );

      // Approve vendor if not already approved
      await userModel.updateUserAccount(userId, { status: 1 });

      // Get subscription details for response and email
      const subscriptions = await db.any(
        `SELECT vhcs.*,
         CASE
           WHEN vhcs.item_type = 'category' THEN c.title
           WHEN vhcs.item_type = 'hotel' THEN h.name
         END AS item_name
         FROM tbl_vendor_hotel_category_subscription vhcs
         LEFT JOIN tbl_category c ON vhcs.item_type = 'category' AND c.id = vhcs.item_id
         LEFT JOIN tbl_hospitality_company_hotels h ON vhcs.item_type = 'hotel' AND h.id = vhcs.item_id
         WHERE vhcs.vendor_id = $1
           AND vhcs.payment_id = $2
           AND vhcs.status = 'active'`,
        [userId, payment.id]
      );

      const categories = subscriptions.filter(s => s.item_type === 'category').map(s => s.item_name);
      const hotels = subscriptions.filter(s => s.item_type === 'hotel').map(s => s.item_name);
      const expiryDate = subscriptions.length > 0 ? subscriptions[0].end_date : null;
      const expiryDateFormatted = expiryDate
        ? Moment(expiryDate).format('MMMM DD, YYYY')
        : 'March 31, ' + (Moment().month() >= 2 ? Moment().year() + 1 : Moment().year());
      const totalAmount = subscriptions.reduce((sum, s) => sum + (parseFloat(s.fee_amount) || 0), 0);

      // Determine if this is a renewal or first-time registration
      const paymentCount = await db.oneOrNone(
        `SELECT COUNT(*) as cnt FROM tbl_vendor_payments
         WHERE vendor_id = $1 AND payment_status IN ('paid', 'success')`,
        [userId]
      );
      const isRenewal = paymentCount && parseInt(paymentCount.cnt) > 1;

      // Send confirmation email
      try {
        const userDetails = await userModel.userinfo(userId);
        const user = Array.isArray(userDetails) ? userDetails[0] : userDetails;
        if (user && user.email) {
          const companyDetail = await userModel.getCompanyDetail(userId);
          const company = companyDetail && companyDetail.length > 0 ? companyDetail[0] : {};

          // Generate invoice
          let invoiceResult = null;
          try {
            invoiceResult = await generateTaxInvoicePdf({
              recipientName: company?.organization_name || company?.name || user?.name,
              amount: totalAmount,
              paymentId: razorpay_payment_id,
              orderId: razorpay_order_id,
              description: isRenewal ? 'Hospitality Vendor Subscription Renewal' : 'Hospitality Vendor Registration'
            });
          } catch (invoiceErr) {
            logError('Invoice generation failed:', invoiceErr);
          }

          const emailSubject = isRenewal
            ? 'Phileein Hospitality - Subscription Renewal Confirmation'
            : 'Phileein Hospitality - Vendor Registration Confirmation';

          const emailHeader = `<h2>Dear ${user.name},</h2>`;
          const emailContent = `
            <p style="font-size: 16px; line-height: 1.6; color: #333;">
              ${isRenewal
                ? 'Your subscription has been successfully renewed and your payment has been processed.'
                : 'Congratulations! Your Vendor registration has been successfully completed and your payment has been processed.'}
            </p>

            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #158993; margin-top: 0;">${isRenewal ? 'Renewal Details' : 'Registration Details'}</h3>
              <p style="margin: 10px 0;"><strong>Company Name:</strong> ${company.organization_name || company.name || 'N/A'}</p>
              <p style="margin: 10px 0;"><strong>Email:</strong> ${user.email}</p>
              <p style="margin: 10px 0;"><strong>Payment Amount:</strong> ₹${totalAmount.toLocaleString('en-IN')}</p>
              <p style="margin: 10px 0;"><strong>Payment ID:</strong> ${razorpay_payment_id}</p>
              <p style="margin: 10px 0;"><strong>Order ID:</strong> ${razorpay_order_id}</p>
            </div>

            ${categories.length > 0 ? `
            <div style="margin: 20px 0;">
              <h3 style="color: #158993;">Selected Categories</h3>
              <ul style="list-style-type: none; padding-left: 0;">
                ${categories.map(cat => `<li style="padding: 5px 0;">• ${cat}</li>`).join('')}
              </ul>
            </div>
            ` : ''}

            ${hotels.length > 0 ? `
            <div style="margin: 20px 0;">
              <h3 style="color: #158993;">Selected Hotels</h3>
              <ul style="list-style-type: none; padding-left: 0;">
                ${hotels.map(hotel => `<li style="padding: 5px 0;">• ${hotel}</li>`).join('')}
              </ul>
            </div>
            ` : ''}

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <p style="margin: 0; font-weight: 600; color: #2e7d32;">
                <strong>Subscription Expiry Date:</strong> ${expiryDateFormatted}
              </p>
            </div>

            <p style="font-size: 16px; line-height: 1.6; color: #333; margin-top: 30px;">
              ${isRenewal
                ? 'Your subscription is now active. You can continue using the Phileein Hospitality platform.'
                : 'Your account has been approved and you can now start using the Phileein Hospitality platform.'}
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONT_END_WEBSITE}/dashboard/vendor"
                 style="background-color: #158993; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: 600;">
                Go to Dashboard
              </a>
            </div>
          `;

          const dynamicHTML = generateEmailTemplate(emailHeader, emailContent);

          const emailOptions = {
            from: Config.webmasterMail,
            to: user.email,
            subject: emailSubject,
            html: dynamicHTML
          };

          // Attach invoice if generated
          const attachments = [];
          if (invoiceResult && invoiceResult.filePath && fs.existsSync(invoiceResult.filePath)) {
            attachments.push({
              filename: invoiceResult.fileName,
              path: invoiceResult.filePath,
              contentType: 'application/pdf'
            });
          }

          // Generate payment received PDF
          try {
            const paymentReceivedPdf = await generatePaymentReceivedPdf({
              recipientName: company?.organization_name || company?.name || user?.name,
              amount: totalAmount,
              paymentId: razorpay_payment_id,
              orderId: razorpay_order_id,
              description: isRenewal ? 'Hospitality Vendor Subscription Renewal' : 'Hospitality Vendor Registration'
            });
            if (paymentReceivedPdf?.filePath && fs.existsSync(paymentReceivedPdf.filePath)) {
              attachments.push({
                filename: paymentReceivedPdf.fileName,
                path: paymentReceivedPdf.filePath,
                contentType: 'application/pdf'
              });
            }
          } catch (docErr) {
            logError('Payment received doc generation failed:', docErr);
          }

          if (attachments.length) emailOptions.attachments = attachments;
          await sendMail(emailOptions);
        }
      } catch (emailError) {
        logError('Verify payment email error:', emailError);
      }

      return res.status(200).json({
        status: 1,
        message: isRenewal ? 'Subscription renewed successfully!' : 'Payment verified successfully!',
        data: {
          is_renewal: isRenewal,
          amount: totalAmount,
          expiry_date: expiryDateFormatted,
          categories,
          hotels,
          order_id: razorpay_order_id,
          payment_id: razorpay_payment_id
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }

};

export default HospitalityController;


