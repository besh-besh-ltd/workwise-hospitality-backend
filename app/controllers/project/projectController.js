import projectModel from "../../models/projectModel.js";
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import rfqModel from "../../models/rfqModel.js";
import db from "../../config/dbConn.js";
import userModel from "../../models/userModel.js";
import hospitalityModel from "../../models/hospitalityModel.js";

/**
 * TENANT gate for a single project.
 *
 * Every handler below used to short-circuit on `user_type === 7` ("Admin can
 * access any project"), which conflates a ROLE with a MEMBERSHIP: Tenant A's
 * admin was reading Tenant B's projects, team rosters and budgets by walking
 * sequential project ids. An admin is an admin *of their own company*, so the
 * admin branch is scoped to their company exactly the way the admin LISTING
 * already is (projectModel.getAllProjectsByCompany: any project owned by — or
 * teamed with — a user of that company).
 *
 * Returns true when the caller may act on the project:
 *   - owner, or
 *   - team member, or
 *   - company admin (user_type 7) AND the project belongs to their company.
 *
 * Non-admins keep exactly the behaviour they had (owner OR member) — this
 * function only ever narrows.
 *
 * Scope is derived from req.user (id / user_type / company_id) — never from the
 * request body, query or headers.
 */
export async function userCanAccessProject(req, projectId) {
  const userId = Number(req.user?.id);
  const projId = Number(projectId);
  if (!userId || !projId) return false;

  // Platform super admin (8) keeps the cross-tenant reach it has everywhere
  // else in the codebase (mrController.isSuperAdmin,
  // resolveHospitalityCompanyScope). user_type 7 is a COMPANY admin and does not.
  if (Number(req.user?.user_type) === 8) return true;

  const isCompanyAdmin = Number(req.user?.user_type) === 7;
  const companyId = req.user?.company_id != null ? Number(req.user.company_id) : null;

  const row = await db.one(
    `SELECT
       EXISTS (SELECT 1 FROM tbl_projects p WHERE p.id = $1 AND p.user_id = $2) AS is_owner,
       EXISTS (SELECT 1 FROM tbl_project_team pt WHERE pt.project_id = $1 AND pt.user_id = $2) AS is_member,
       EXISTS (
         SELECT 1 FROM tbl_projects p
          WHERE p.id = $1
            AND $3::int IS NOT NULL
            AND (
              EXISTS (SELECT 1 FROM tbl_users ou WHERE ou.id = p.user_id AND ou.company_id = $3)
              OR EXISTS (
                SELECT 1 FROM tbl_project_team pt
                  JOIN tbl_users tu ON tu.id = pt.user_id
                 WHERE pt.project_id = p.id AND tu.company_id = $3
              )
            )
       ) AS in_company`,
    [projId, userId, companyId]
  );

  if (row.is_owner || row.is_member) return true;
  return isCompanyAdmin && row.in_company === true;
}

/**
 * TENANT gate for "another user's" data (project rosters keyed by user id).
 * The caller may only ask about users inside their own company.
 */
export async function userIsInSameCompany(req, targetUserId) {
  if (Number(req.user?.user_type) === 8) return true;
  const companyId = req.user?.company_id != null ? Number(req.user.company_id) : null;
  const targetId = Number(targetUserId);
  if (!companyId || !targetId) return false;
  if (targetId === Number(req.user?.id)) return true;
  const row = await db.oneOrNone(
    `SELECT 1 FROM tbl_users WHERE id = $1 AND company_id = $2`,
    [targetId, companyId]
  );
  return !!row;
}

const FORBIDDEN_PROJECT = {
  status: false,
  message: "You don't have permission to access this project"
};

const projectController = {
  create: async (req, res, next) => {
    try {
      const {
        name,
        description,
        location,
        ended_at,
        rfq_type,
        reverse_auction,
        budget
      } = req.body;

      const user_id = req.user.id;

      const tbl_project_data = {
        name,
        description,
        location,
        ended_at: ended_at === '' ? null : ended_at,
        rfq_type,
        reverse_auction,
        budget,
        user_id: user_id // Simply use the user_id from req.user
      };

      const response = await projectModel.createProject(tbl_project_data);
      res.status(200).json({
        status: true,
        message: 'Project Created',
        data: response
      });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  getProjectById: async (req, res, next) => {
    try {
      logger.debug('getProjectById called');

      let project_id = req.params.project_id;
      const user_id = req.user.id;
      const user_type = req.user.user_type;
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let projectDetails;

      // Tenant gate first: admin (user_type 7) is an admin OF THEIR COMPANY,
      // not of every company (see userCanAccessProject).
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json(FORBIDDEN_PROJECT);
      }

      if (user_type === 7) {
        projectDetails = await projectModel.getProjectByIdForAdmin(
          project_id,
          limit,
          offset
        );
      } else {
        // Owner and team member both read through the owner-scoped query.
        projectDetails = await projectModel.getProjectById(
          project_id,
          user_id,
          limit,
          offset
        );
      }

      if (
        !projectDetails ||
        (Array.isArray(projectDetails) && projectDetails.length === 0)
      ) {
        return res.status(404).json({
          status: false,
          message: 'Project not found'
        });
      }
      logger.debug({ rfq: projectDetails[0].rfq }, 'checking the project details');
      res
        .status(200)
        .json({
          status: true,
          data: projectDetails
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getProjectTableDataById: async (req, res, next) => {
    try {
      const project_id = req.params.project_id;
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      let projectDetails;

      // Tenant gate first — role is not membership (see userCanAccessProject).
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json(FORBIDDEN_PROJECT);
      }

      const file = 'yes'; // we want file hence explictly assigning tis value for feching project files and docs.
      if (user_type === 7) {
        projectDetails = await projectModel.getProjectTableDataByIdForAdmin(
          project_id,
          user_id,
          file
        );
      } else {
        const isOwner = await projectModel.checkProjectOwnership(
          project_id,
          user_id
        );
        projectDetails = isOwner
          ? await projectModel.getProjectTableDataById(project_id, user_id, file)
          // Team member: use the admin-shaped query to bypass the owner filter.
          : await projectModel.getProjectTableDataByIdForAdmin(project_id, user_id, file);
      }

      if (
        !projectDetails ||
        (Array.isArray(projectDetails) && projectDetails.length === 0)
      ) {
        return res.status(404).json({
          status: false,
          message: 'Project not found'
        });
      }
      res
        .status(200)
        .json({
          status: true,
          data: projectDetails
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getProjectBudget: async (req, res, next) => {
    try {
      const project_id = req.params.project_id;

      // Tenant gate — role is not membership (see userCanAccessProject).
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json({
          status: false,
          message: "You don't have permission to access this project's budget"
        });
      }

      const projectBudget = await projectModel.getProjectBudget(project_id);
      if (
        !projectBudget ||
        (Array.isArray(projectBudget) && projectBudget.length === 0)
      ) {
        return res.status(404).json({
          status: false,
          message: 'Project budget not found'
        });
      }

      res
        .status(200)
        .json({
          status: true,
          data: projectBudget
        })
        .end();
    } catch (error) {
      logError(error);

      res

        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
 getProjectAvailableBudget: async (req, res, next) => {
  try {
    const { project_id } = req.params;

    let totalBudget = 0;

    // Tenant gate — role is not membership (see userCanAccessProject).
    if (!(await userCanAccessProject(req, project_id))) {
      return res.status(403).json({
        status: false,
        message: "You don't have permission to access this project's available budget",
      });
    }

    const spentArr = await projectModel.getProjectBudget(project_id);
    const totalSpent = spentArr.reduce((sum, b) => sum + Number(b.total_value || 0), 0);

    // Get project budget from rfqModel.
    // Bound rather than interpolated. Not reachable today — the Joi param
    // schema is Joi.number().integer() and userCanAccessProject() above does
    // Number(projectId) and returns false on NaN — but both of those are
    // guards somewhere else, and this line should not depend on them.
    const budgetRows = await rfqModel.checkIfExists('tbl_projects', {
      where: 'id = $1',
      values: [Number(project_id)]
    });
    totalBudget = budgetRows.reduce((sum, b) => sum + Number(b.budget || 0), 0);

    return res.status(200).json({
      status: true,
      data: {
        project_id,
        total_budget : totalBudget,
        available_budget: totalBudget - totalSpent
      }
    });

  } catch (error) {
    next(error);
  }
 },

        

  /**
   * @description This function will return project list, all project to admin user_type 7, and project in which user added as member by admin for non admin users of org.
   *
   * @lastUpdated 12-06-2025 mukul - to return all project by company id
   */
  getAllProjects: async (req, res, next) => {
    try {
      const { id: user_id, company_id, user_type } = req.user;

      let projects = [];

      // get all proejct created by anyone in the company, this is only for company admin
      if (user_type == 7) {
        projects = await projectModel.getAllProjectsByCompany(company_id);
      } else {
        // users can only access their own projects or projects they are a member of
        projects = await projectModel.getAllProjects(user_id);
      }

      // Apply hospitality scope filter when context is present
      if (req.hospitalityContext) {
        const { companyId, hotelId } = req.hospitalityContext;
        const mappedProjects = await hospitalityModel.getProjectIdsForContext(
          companyId,
          hotelId || null
        );
        const allowedIds = new Set(
          mappedProjects.map((row) => Number(row.project_id))
        );
        projects = projects.filter((project) =>
          allowedIds.has(Number(project.id))
        );
      }

      // IMPORTANT: Ensure the response format is consistent
      const responseData = {
        status: true,
        data: projects
      };

      res.status(200).json(responseData).end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },
  update: async (req, res, next) => {
    try {
      const {
        name,
        description,
        location,
        ended_at,
        status,
        rfq_type,
        reverse_auction,
        budget
      } = req.body;

      const user_id = req.user.id;
      const user_type = req.user.user_type;
      const { project_id } = req.params;

      let udpatedProject;

      // Same role-vs-membership defect on the WRITE side: user_type 7/8/2 is
      // every buyer-side account, so any authenticated buyer could rewrite any
      // project's name/status/budget by id. Gate on the tenant first.
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json({
          status: false,
          message: "You don't have permission to update this project"
        });
      }

      if (user_type === 7 || user_type === 8 || user_type === 2) {
        // Admin can update any project
        const tbl_project_data = {
          name,
          description,
          location,
          ended_at,
          status,
          rfq_type,
          reverse_auction,
          project_id,
          budget
        };

        udpatedProject = await projectModel.updateProjectForAdmin(
          tbl_project_data
        );
      } else {
        // Regular users can only update their own projects
        const tbl_project_data = {
          name,
          description,
          location,
          ended_at,
          status,
          user_id,
          rfq_type,
          reverse_auction,
          project_id,
          budget
        };

        udpatedProject = await projectModel.updateProject(tbl_project_data);
      }

      res.status(200).json({
        status: true,
        data: udpatedProject,
        message: `Project ${project_id} Updated Successfully`
      });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: false,
          message: Config.errorText.value
        })
        .end();
    }
  },

  saveProjectFiles: async (req, res) => {
    const { project_id, file_type } = req.body;
    const files = req.files;

    // console.log('Files:------------------------->', files);

    if (!files || !files.length) {
      return res.status(400).json({ status: 2, message: 'No files uploaded' });
    }

    try {
      // project_id arrives in the body and was never authorized — any buyer
      // could attach documents to any tenant's project.
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json({
          status: 2,
          message: "You don't have permission to add files to this project"
        });
      }

      const filesData = files.map((file) => ({
        project_id,
        file_name: file.originalname,
        file_url: file.location,
        file_type
      }));

      await rfqModel.insertArray(
        filesData,
        ['project_id', 'file_name', 'file_url', 'file_type'],
        'tbl_project_files'
      );

      res
        .status(200)
        .json({
          status: 1,
          message: 'Files uploaded successfully',
          files: files,
          file_type
        });
    } catch (err) {
      logError('Error saving files', err);
      res.status(500).json({ status: 3, message: 'Server error' });
    }
  },

  // Get team members for a project
  getProjectTeamMembers: async (req, res, next) => {
    try {
      const { project_id } = req.params;
      // Owner / team member / company admin of the project's own company.
      // The bare `user_type === 7 → allow` short-circuit that used to live here
      // let any tenant's admin read any tenant's roster (names + emails).
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json({
          status: false,
          message: "You don't have permission to access this project's team"
        });
      }

      // Get team members
      const teamMembers = await projectModel.getProjectTeamMembers(project_id);

      // Log the response data structure for debugging
      const responseData = {
        status: true,
        data: teamMembers // This is always an array from the model
      };

      return res.status(200).json(responseData);
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: Config.errorText.value
      });
    }
  },

  // Add a team member to a project
  addTeamMember: async (req, res, next) => {
    try {
      const { project_id } = req.params;
      const { user_id, role } = req.body;
      const current_user_id = req.user.id;

      // Owner, or company admin of the project's OWN company. The previous
      // `user_type === 7 → canModify = true` let any tenant's admin bolt
      // themselves onto any tenant's project.
      const canModify = Number(req.user?.user_type) === 7
        ? await userCanAccessProject(req, project_id)
        : (await projectModel.checkProjectOwnership(project_id, current_user_id)) !== null;

      if (!canModify) {
        return res.status(403).json({
          status: false,
          message:
            "You don't have permission to add team members to this project"
        });
      }

      // Check if the user exists
      const userExists = await userModel.userExistsById(user_id);

      if (!userExists) {
        return res.status(404).json({
          status: false,
          message: 'User not found'
        });
      }

      // Check if the user is already a team member
      const isAlreadyMember = await projectModel.isTeamMember(
        project_id,
        user_id
      );

      if (isAlreadyMember) {
        return res.status(400).json({
          status: false,
          message: 'User is already a team member of this project'
        });
      }

      // Add the team member
      const memberData = {
        project_id: parseInt(project_id),
        user_id: parseInt(user_id),
        role: parseInt(role),
        created_by: parseInt(current_user_id)
      };

      try {
        const result = await projectModel.addTeamMember(memberData);

        // Get full user details to return
        const memberDetails = await projectModel.getTeamMemberDetails(
          result.id
        );

        const responseData = {
          status: true,
          message: 'Team member added successfully',
          data: memberDetails
        };

        return res.status(200).json(responseData);
      } catch (dbError) {
        // Special handling for unique constraint violations (user already added)
        if (
          dbError.message &&
          dbError.message.includes(
            'duplicate key value violates unique constraint'
          )
        ) {
          return res.status(400).json({
            status: false,
            message: 'User is already a team member of this project'
          });
        }

        // Rethrow for general error handling
        throw dbError;
      }
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: err.message || Config.errorText.value
      });
    }
  },

  // Remove a team member from a project
  removeTeamMember: async (req, res, next) => {
    try {
      const { project_id } = req.params;
      const { user_id } = req.body;
      const current_user_id = req.user.id;

      // Owner, or company admin of the project's OWN company (see addTeamMember).
      const canModify = Number(req.user?.user_type) === 7
        ? await userCanAccessProject(req, project_id)
        : (await projectModel.checkProjectOwnership(project_id, current_user_id)) !== null;

      if (!canModify) {
        return res.status(403).json({
          status: false,
          message:
            "You don't have permission to remove team members from this project"
        });
      }

      // Check if the user is a team member
      const isTeamMember = await projectModel.isTeamMember(project_id, user_id);

      if (!isTeamMember) {
        return res.status(404).json({
          status: false,
          message: 'User is not a team member of this project'
        });
      }

      // Remove the team member
      try {
        const result = await projectModel.removeTeamMember(
          parseInt(project_id),
          parseInt(user_id)
        );

        if (result.rowCount === 0) {
          return res.status(404).json({
            status: false,
            message: 'Team member not found or already removed'
          });
        }

        // Create a consistent response
        const responseData = {
          status: true,
          message: 'Team member removed successfully',
          data: { user_id, project_id }
        };

        return res.status(200).json(responseData);
      } catch (dbError) {
        throw dbError;
      }
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: err.message || Config.errorText.value
      });
    }
  },

  // Get all projects where the current user is a team member
  getUserProjects: async (req, res, next) => {
    try {
      const user_id = req.user.id;

      // Get projects where the user is a team member
      const projects = await projectModel.getUserProjects(user_id);

      return res.status(200).json({
        status: true,
        data: projects
      });
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: Config.errorText.value
      });
    }
  },

  getUserProjectsByUserId: async (req, res, next) => {
    try {
      const { user_id } = req.params;

      // Tenant gate: you may only ask about users inside your own company.
      // Without it, any authenticated buyer could enumerate every user's
      // project list (names, budgets, status) by incrementing user_id.
      if (!(await userIsInSameCompany(req, user_id))) {
        return res.status(403).json({
          status: false,
          message: "You don't have permission to access this user's projects"
        });
      }

      // Get projects where the specified user is a team member
      const projects = await projectModel.getUserProjects(user_id);

      return res.status(200).json({
        status: true,
        message: 'User projects retrieved successfully',
        data: projects
      });
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: err.message || Config.errorText.value
      });
    }
  },

  // Get projects filtered by hospitality context (company or hotel)
  getProjectsByHospitalityContext: async (req, res, next) => {
    try {
      const { hospitality_company_id, hotel_id } = req.query;
      const user_id = req.user.id;

      let projectIds = [];

      if (hospitality_company_id || hotel_id) {
        // Get project IDs mapped to the hospitality context
        const mappedProjects = await hospitalityModel.getProjectIdsForContext(
          hospitality_company_id,
          hotel_id
        );
        projectIds = mappedProjects.map(p => p.project_id);
      }

      // Get project names and IDs from the mapped project IDs
      let projects = [];
      if (projectIds.length > 0) {
        const projectData = await db.any(
          `SELECT p.id, p.name 
           FROM tbl_projects p
           LEFT JOIN tbl_project_team pt ON p.id = pt.project_id
           WHERE p.id = ANY($1::int[])
             AND (p.user_id = $2 OR pt.user_id = $2)
           GROUP BY p.id, p.name
           ORDER BY p.name`,
          [projectIds, user_id]
        );
        projects = projectData;
      }

      return res.status(200).json({
        status: true,
        data: projects
      });
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: err.message || Config.errorText.value
      });
    }
  },

  // Get hospitality context (company and hotel) for a project
  getProjectHospitalityContext: async (req, res, next) => {
    try {
      const { project_id } = req.params;

      // Tenant gate — the hospitality context names the owning company/BU.
      if (!(await userCanAccessProject(req, project_id))) {
        return res.status(403).json(FORBIDDEN_PROJECT);
      }

      // Get hospitality mappings for the project
      const mappings = await hospitalityModel.getProjectMappings(project_id);

      if (!mappings || mappings.length === 0) {
        return res.status(200).json({
          status: true,
          data: null
        });
      }

      // Return the first mapping (usually there's one primary context)
      const primaryMapping = mappings[0];

      return res.status(200).json({
        status: true,
        data: {
          hospitality_company_id: primaryMapping.hospitality_company_id,
          company_name: primaryMapping.company_name,
          hotel_id: primaryMapping.hospitality_hotel_id,
          hotel_name: primaryMapping.hotel_name,
          mapping_type: primaryMapping.mapping_type
        }
      });
    } catch (err) {
      logError(err);
      return res.status(400).json({
        status: false,
        message: err.message || Config.errorText.value
      });
    }
  }
};

export default projectController;