import projectModel from "../../models/projectModel.js";
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import rfqModel from "../../models/rfqModel.js";
import db from "../../config/dbConn.js";
import userModel from "../../models/userModel.js";

const projectController = {
  create: async (req, res, next) => {
    // Skip subscription check for admin users
    if (req.user.user_type !== 7 && !req.user.subscription_plan_id) {
      res
        .status(400)
        .json({
          status: 3,
          message: 'You need to purchase subscription to create RFQ'
        })
        .end();
      return;
    }
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
      console.log('req.params mukul');

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

      if (user_type === 7) {
        // Admin can access any project
        projectDetails = await projectModel.getProjectByIdForAdmin(
          project_id,
          limit,
          offset
        );
      } else {
        // Check if user is the project owner or a team member
        const isOwner = await projectModel.checkProjectOwnership(
          project_id,
          user_id
        );

        if (isOwner) {
          // User is the project owner
          projectDetails = await projectModel.getProjectById(
            project_id,
            user_id,
            limit,
            offset
          );
        } else {
          // Check if user is a team member
          const isMember = await projectModel.isTeamMember(project_id, user_id);

          if (isMember) {
            // User is a team member
            projectDetails = await projectModel.getProjectById(
              project_id,
              user_id,
              limit,
              offset
            );
          } else {
            // User doesn't have access to this project
            return res.status(403).json({
              status: false,
              message: "You don't have permission to access this project"
            });
          }
        }
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
      console.log('checking the project details', projectDetails[0].rfq);
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

      if (user_type === 7) {
        // Admin can access any project
        const file = 'yes';
        projectDetails = await projectModel.getProjectTableDataByIdForAdmin(
           project_id,
            user_id,
            file
        );
      } else {
        // Check if user is the project owner or a team member
        const isOwner = await projectModel.checkProjectOwnership(
          project_id,
          user_id
        );
        const file = 'yes'; // we want file hence explictly assigning tis value for feching project files and docs.
        if (isOwner) {
          // User is the project owner
          projectDetails = await projectModel.getProjectTableDataById(
            project_id,
            user_id,
            file
          );
        } else {
          // Check if user is a team member
          const isMember = await projectModel.isTeamMember(project_id, user_id);
          const file = 'yes';
          if (isMember) {
            // User is a team member, use the admin function to bypass owner check
            projectDetails = await projectModel.getProjectTableDataByIdForAdmin(
            project_id,
            user_id,
            file
            );
          } else {
            // User doesn't have access to this project
            return res.status(403).json({
              status: false,
              message: "You don't have permission to access this project"
            });
          }
        }
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
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      let projectBudget;

      if (user_type === 7) {
        // Admin can access any project budget
        projectBudget = await projectModel.getProjectBudget(project_id);
      } else {
        // Check if user is the project owner or a team member
        const isOwner = await projectModel.checkProjectOwnership(
          project_id,
          user_id
        );
        if (isOwner) {
          // User is the project owner
          projectBudget = await projectModel.getProjectBudget(
            project_id
          );
        } else {
          // Check if user is a team member
          const isMember = await projectModel.isTeamMember(project_id, user_id);

          if (isMember) {
            // User is a team member, use the admin function to bypass owner check

            projectBudget = await projectModel.getProjectBudget(project_id);
          } else {
            // User doesn't have access to this project
            return res.status(403).json({
              status: false,
              message:
                "You don't have permission to access this project's budget"
            });
          }
        }
      }
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
    const user_id = req.user.id;
    const user_type = req.user.user_type;

    let totalSpent = 0;
    let totalBudget = 0;

    // Helper: Get total spent for project
    const getTotalSpent = async () => {
      const spentArr = await projectModel.getProjectBudget(project_id);
      return spentArr.reduce((sum, b) => sum + Number(b.total_value || 0), 0);
    };

    if (user_type === 7) {
      // Admin can access any project's available budget
      totalSpent = await getTotalSpent();
    } else {
      const isOwner = await projectModel.checkProjectOwnership(project_id, user_id);
      if (isOwner) {
        totalSpent = await getTotalSpent();
      } else {
        const isMember = await projectModel.isTeamMember(project_id, user_id);
        if (isMember) {
          totalSpent = await getTotalSpent();
        } else {
          return res.status(403).json({
            status: false,
            message: "You don't have permission to access this project's available budget",
          });
        }
      }
    }

    // Get project budget from rfqModel
    const budgetRows = await rfqModel.checkIfExists('tbl_projects', `id = ${project_id}`);
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

      if (user_type === 7 || user_type === 8 || user_type === 2) {
        // Admin can update any project
        const tbl_project_data = {
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
  getIdAndNameOfProjects: async (req, res, next) => {
    try {
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      let projects;

      projects = await projectModel.getIdAndNameOfProjects(user_id);

      res.status(200).json({
        status: true,
        data: projects
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
      console.error('Error saving files:', err);
      res.status(500).json({ status: 3, message: 'Server error' });
    }
  },

  // Get team members for a project
  getProjectTeamMembers: async (req, res, next) => {
    try {
      const { project_id } = req.params;
      const user_id = req.user.id;
      const user_type = req.user.user_type;

      // Check if the user is allowed to access this project
      let canAccess = false;

      if (user_type === 7) {
        // Admin can access any project
        canAccess = true;
      } else {
        // Regular user can only access their own projects or projects they're a member of
        const projectData = await projectModel.checkProjectOwnership(
          project_id,
          user_id
        );

        if (projectData) {
          canAccess = true;
        } else {
          // Check if user is a team member
          const isMember = await projectModel.isTeamMember(project_id, user_id);
          canAccess = isMember;
        }
      }

      if (!canAccess) {
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
      const user_type = req.user.user_type;

      // Check if the user is allowed to modify this project
      let canModify = false;

      if (user_type === 7) {
        // Admin can modify any project
        canModify = true;
      } else {
        // Regular user can only modify their own projects
        const projectData = await projectModel.checkProjectOwnership(
          project_id,
          current_user_id
        );

        canModify = projectData !== null;
      }

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
      const user_type = req.user.user_type;

      // Check if the user is allowed to modify this project
      let canModify = false;

      if (user_type === 7) {
        // Admin can modify any project
        canModify = true;
      } else {
        // Regular user can only modify their own projects
        const projectData = await projectModel.checkProjectOwnership(
          project_id,
          current_user_id
        );

        canModify = projectData !== null;
      }

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
  }
};

export default projectController;