import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import hospitalityModel from '../../models/hospitalityModel.js';
import projectModel from '../../models/projectModel.js';

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
        created_by: req.user.id
      };

      const created = await hospitalityModel.createCompany(payload);
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
          updated_by: req.user.id
        },
        company.id
      );

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
        status: req.body.status?.trim() || 'Active',
        created_by: req.user.id
      };

      const created = await hospitalityModel.createHotel(payload);

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
                    role: 'member',
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
                    role: 'member',
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
  }
};

export default HospitalityController;


