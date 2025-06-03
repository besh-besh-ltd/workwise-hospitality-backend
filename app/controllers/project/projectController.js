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
                reverse_auction
            } = req.body;

            const user_id = req.user.id;

            const tbl_project_data = {
              name,
              description,
              location,
              ended_at: ended_at === "" ? null : ended_at,
              rfq_type,
              reverse_auction,
              user_id: user_id // Simply use the user_id from req.user
            }
            
            const response = await projectModel.createProject(tbl_project_data);
            res
            .status(200)
            .json({
              status: true,
              message: "Project Created",
              data: response
            })

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
    getProjectById: async(req,res,next) => {
      try {
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
          projectDetails = await projectModel.getProjectByIdForAdmin(project_id, limit, offset);
        } else {
          // Regular user can only access their own projects
          projectDetails = await projectModel.getProjectById(project_id, user_id, limit, offset);
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

    getProjectTableDataById: async(req,res,next) => {
      try {
        const project_id = req.params.project_id;
        const user_id = req.user.id;
        const user_type = req.user.user_type;
          
        let projectDetails;
        
        if (user_type === 7) {
          // Admin can access any project
          projectDetails = await projectModel.getProjectTableDataByIdForAdmin(project_id);
        } else {
          // Regular user can only access their own projects
          projectDetails = await projectModel.getProjectTableDataById(project_id, user_id);
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

    getAllProjects: async (req, res, next) => {
      try {
          const user_id = req.user.id;
          const user_type = req.user.user_type;
          
          let projects = [];
          
          if (user_type === 7) {
            // Changes by Agnij 31 January 2025 [Use model function instead of direct SQL query]
            // Admin users should only see their own projects
            projects = await projectModel.getAllProjectsForAdmin(user_id);
          } else {
            // Regular user query: fetch only their projects
            projects = await projectModel.getAllProjects(user_id);
          }
          // Sort projects with newest first
          projects.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          
          // IMPORTANT: Ensure the response format is consistent
          const responseData = {
            status: true,
            data: projects
          };
          
          res
          .status(200)
          .json(responseData)
          .end();

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
          reverse_auction
      } = req.body;

      const user_id = req.user.id;
      const user_type = req.user.user_type;
      const {project_id} = req.params;

      let udpatedProject;
      
      if (user_type === 7) {
        // Admin can update any project
        const tbl_project_data = {
          description,
          location,
          ended_at,
          status,
          rfq_type,
          reverse_auction,
          project_id
        };
        
        udpatedProject = await projectModel.updateProjectForAdmin(tbl_project_data);
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
          project_id
        };
        
        udpatedProject = await projectModel.updateProject(tbl_project_data);
      }
          
          res
          .status(200)
          .json({
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
          
          res
          .status(200)
          .json({
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
    
        res.status(200).json({ status: 1, message: 'Files uploaded successfully', files: files, file_type });
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
          const projectData = await projectModel.checkProjectOwnership(project_id, user_id);
          
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
          const projectData = await projectModel.checkProjectOwnership(project_id, current_user_id);
          
          canModify = projectData !== null;
        }
        
        if (!canModify) {
          return res.status(403).json({
            status: false,
            message: "You don't have permission to add team members to this project"
          });
        }
        
        // Check if the user exists
        const userExists = await userModel.userExistsById(user_id);
        
        if (!userExists) {
          return res.status(404).json({
            status: false,
            message: "User not found"
          });
        }
        
        // Check if the user is already a team member
        const isAlreadyMember = await projectModel.isTeamMember(project_id, user_id);
        
        if (isAlreadyMember) {
          return res.status(400).json({
            status: false,
            message: "User is already a team member of this project"
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
          const memberDetails = await projectModel.getTeamMemberDetails(result.id);
          
          const responseData = {
            status: true,
            message: "Team member added successfully",
            data: memberDetails
          };
          
          return res.status(200).json(responseData);
        } catch (dbError) {
          // Special handling for unique constraint violations (user already added)
          if (dbError.message && dbError.message.includes('duplicate key value violates unique constraint')) {
            return res.status(400).json({
              status: false,
              message: "User is already a team member of this project"
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
          const projectData = await projectModel.checkProjectOwnership(project_id, current_user_id);
          
          canModify = projectData !== null;
        }
        
        if (!canModify) {
          return res.status(403).json({
            status: false,
            message: "You don't have permission to remove team members from this project"
          });
        }
        
        // Check if the user is a team member
        const isTeamMember = await projectModel.isTeamMember(project_id, user_id);
        
        if (!isTeamMember) {
          return res.status(404).json({
            status: false,
            message: "User is not a team member of this project"
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
              message: "Team member not found or already removed"
            });
          }
          
          // Create a consistent response
          const responseData = {
            status: true,
            message: "Team member removed successfully",
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
          message: "User projects retrieved successfully",
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
}

export default projectController;