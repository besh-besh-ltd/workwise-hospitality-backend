import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import generalModel from '../../models/generalModel.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import projectModel from '../../models/projectModel.js';
import rfqModel from '../../models/rfqModel.js';

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
      const companies = await hospitalityModel.getCompaniesByBuyer(company.id);

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
        fee_amount: req.body.fee_amount ? parseInt(req.body.fee_amount, 10) : null
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

  getUserMappings: async (req, res) => {
    try {
      const userId = parseInt(req?.query?.userId, 10) || req.user.id;
      const mappings = await hospitalityModel.getUserMappings(userId);

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

      const mappings = await hospitalityModel.getUserMappingsForCompany(
        hospitalityCompanyId,
        mappingType,
        mappingType === 1 ? hotelId : null
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
      const contexts = await hospitalityModel.getUserContexts(req.user.id);
      return res.status(200).json({
        status: 1,
        data: contexts
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

      //  fetch mapped hotels
      const mappedHotels = await rfqModel.checkIfExists('tbl_rfq_hotel_mappings', `rfq_id = ${rfq_id}`);
      
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
          You have been added as a business unit under <strong>${hotel.company_name}</strong> on the WorkWise platform.
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
        subject: `WorkWise - Complete Payment for ${hotel.name}`,
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

  // Create Razorpay payment order for hotel onboarding (public endpoint - no auth required)
  createHotelPaymentOrder: async (req, res) => {
    try {
      const { hotel_id } = req.body;

      if (!hotel_id) {
        return res.status(400).json({ status: 0, message: 'hotel_id is required' });
      }

      const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
      if (!hotel) {
        return res.status(404).json({ status: 0, message: 'Business unit not found' });
      }

      if (!hotel.fee_amount || hotel.fee_amount <= 0) {
        return res.status(400).json({ status: 0, message: 'Fee amount not configured' });
      }

      // Check for existing successful payment
      const existingPayment = await hospitalityModel.getHotelPayment(hotel_id);
      if (existingPayment && existingPayment.payment_status === 'success') {
        return res.status(200).json({
          status: 1,
          data: { already_paid: true, payment_id: existingPayment.id }
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
  verifyHotelPayment: async (req, res) => {
    try {
      const { hotel_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;

      if (!hotel_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
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
        // Update hotel status to active
        await hospitalityModel.updateHotelPaymentStatus(hotel_id, 'active');

        // Send confirmation email using the standard WorkWise template (don't fail if email fails)
        try {
          const hotel = await hospitalityModel.getHotelPaymentDetails(hotel_id);
          if (hotel?.email) {
            const { sendMail } = await import('../../helper/common.js');
            const { generateEmailTemplate } = await import('../../helper/notificationEmailLayout.js');

            const headerContent = `<h2 style=\"margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827;\">Payment Successful</h2>`;
            const containerContent = `
              <p style=\"font-size: 15px; color: #4b5563; margin: 0 0 16px;\">
                Your business unit <strong>${hotel.name}</strong> has been successfully activated on the WorkWise platform.
              </p>
              <div style=\"background: #f0fdf4; padding: 14px 18px; border-radius: 10px; border: 1px solid #bbf7d0; margin: 16px 0 8px;\">
                <p style=\"margin: 0; color: #166534; font-size: 14px;\">
                  <strong>Amount Paid:</strong> ₹ ${hotel.fee_amount?.toLocaleString('en-IN') || hotel.fee_amount}<br/>
                  <strong>Payment ID:</strong> ${razorpay_payment_id}
                </p>
              </div>
              <p style=\"font-size: 13px; color: #6b7280; margin: 12px 0 0;\">
                You can now start using your WorkWise business unit or contact your administrator for any assistance.
              </p>
            `;

            const html = generateEmailTemplate(headerContent, containerContent, null);

            await sendMail({
              from: Config.webmasterMail,
              to: hotel.email,
              subject: `WorkWise - Payment Confirmed for ${hotel.name}`,
              html
            });
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
  }

};

export default HospitalityController;


