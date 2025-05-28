import projectModel from "../../models/projectModel.js";
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import rfqModel from "../../models/rfqModel.js";
import db from "../../config/dbConn.js";

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
          projectDetails = await db.any(
            `SELECT 
              p.*, 
              -- Aggregated RFQ counts
              COUNT(r.id) AS total_rfqs,
              COUNT(CASE WHEN r.status = 0 THEN 1 END) AS closed_rfqs,
              COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs,

              COALESCE(
                  jsonb_object_agg(
                      f.file_type,
                      ARRAY(
                          SELECT json_build_object(
                              'name', file.file_name,
                              'url', file.file_url
                          )
                          FROM tbl_project_files file
                          WHERE file.project_id = p.id AND file.file_type = f.file_type
                      )
                  ) FILTER (WHERE f.file_type IS NOT NULL),
                  '{}'::jsonb
              ) AS files,

              -- Fetch RFQ details with vendors, number of products and quotes, including all RFQ columns
              ARRAY(
                  SELECT json_build_object(
                      -- Fetch all columns of tbl_rfq
                      'rfq_details', row_to_json(r),
                      'no_of_quotes', (
                          SELECT COUNT(*)
                          FROM tbl_quotes tq
                          WHERE tq.rfq_id = r.id
                      ),
                      'vendors', (
                          SELECT json_build_object(
                              'total_vendors', COUNT(DISTINCT trpv.user_id),
                              'quote_received', (
                                  SELECT COUNT(DISTINCT tq.created_by)
                                  FROM tbl_quotes tq
                                  WHERE tq.rfq_id = r.id
                              )
                          )
                          FROM tbl_rfq_product_vendors trpv
                          WHERE trpv.rfq_id = r.id
                          GROUP BY trpv.rfq_id
                      ),
                      'no_of_products', (
                          SELECT COUNT(*)
                          FROM tbl_rfq_products rfq_p
                          WHERE rfq_p.rfq_id = r.id
                      )
                  )
                  FROM tbl_rfq r
                  WHERE r.project_id = p.id
                  ORDER BY r.timestamp DESC
                  LIMIT $2 OFFSET $3
              ) AS rfqs

          FROM 
              tbl_projects p
          LEFT JOIN 
              tbl_rfq r ON r.project_id = p.id
          LEFT JOIN 
              tbl_project_files f ON f.project_id = p.id    
          WHERE 
              p.id = $1
          GROUP BY 
              p.id;
            `,
            [project_id, limit, offset]
          );
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
          projectDetails = await db.any(`
            SELECT t.* 
            FROM tbl_projects t
            WHERE t.id = $1;
          `, [project_id]);
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
            // Admin users should only see their own projects
            projects = await db.any(`
              SELECT 
                p.*, 
                COUNT(r.id) AS total_rfqs,
                COUNT(CASE WHEN r.status = 2 THEN 1 END) AS closed_rfqs,
                COUNT(CASE WHEN r.status = 1 THEN 1 END) AS open_rfqs
              FROM 
                tbl_projects p
              LEFT JOIN 
                tbl_rfq r ON r.project_id = p.id 
              WHERE 
                p.user_id = $1
              GROUP BY 
                p.id
              ORDER BY 
                p.created_at DESC
            `, [user_id]);
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

      // Changes by Agnij 28-05-2025 [Added admin check for updating projects]
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
        
        udpatedProject = await db.oneOrNone(
          `UPDATE tbl_projects
          SET
             status = $1,
             description = $2,
             location = $3,
             ended_at = $4,
             rfq_type = $5,
             reverse_auction = $6,
             updated_at = NOW()
          WHERE
             id = $7
          RETURNING *;`,
         [
             status,        
             description,   
             location,      
             ended_at,      
             rfq_type,
             reverse_auction,
             project_id        
         ]
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
          
          if (user_type === 7) {
            // Admin query: fetch all projects' names and IDs
            projects = await db.any(`
              SELECT 
                p.id,
                p.name 
              FROM 
                tbl_projects p
              ORDER BY 
                p.name ASC
            `);
          } else {
            // Regular user query: fetch only their projects
            projects = await projectModel.getIdAndNameOfProjects(user_id);
          }
          
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
    
}
export default projectController;