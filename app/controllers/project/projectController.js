import projectModel from "../../models/projectModel.js";
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';

const projectController = {
    create: async (req, res, next) => {
        if (!req.user.subscription_plan_id) {
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
            } = req.body;

            const user_id = req.user.id;

            const tbl_project_data = {
              name,
              description,
              location,
              ended_at: ended_at==''?null:ended_at,
              user_id:user_id
            }
            
            const response = await projectModel.createProject(tbl_project_data);
            res
            .status(200)
            .json({
              status: true,
              message:"Project Created"
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
          let page, limit, offset;
        if (req.body.page && req.body.page > 0) {
          page = req.body.page;
          limit = req.body.limit || Config.globalAdminLimit;
          offset = (page - 1) * limit;
        } else {
          limit = Config.globalAdminLimit;
          offset = 0;
        }
        let projectDetails = await projectModel.getProjectById(project_id,user_id,limit,offset);
        res
        .status(200)
        .json({
          status: true,
          data:projectDetails
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
          
          let projects = await projectModel.getAllProjects(user_id);
          res
          .status(200)
          .json({
            status: true,
            data:projects
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
    update: async (req, res, next) => {
      try {

        const {
          description,
          location,
          ended_at,
          status
      } = req.body;

      const user_id = req.user.id;
      const {project_id} = req.params;

      const tbl_project_data = {
        description,
        location,
        ended_at,
        status,
        user_id:user_id,
        project_id:project_id
      }
          
          let udpatedProject = await projectModel.updateProject(tbl_project_data);
          
          res
          .status(200)
          .json({
            status: true,
            data:udpatedProject,
            message:`Project ${project_id} Updated Successfully`
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
    getIdAndNameOfProjects: async (req, res, next) => {
      try {

          const user_id = req.user.id;
          
          let projects = await projectModel.getIdAndNameOfProjects(user_id);
          res
          .status(200)
          .json({
            status: true,
            data:projects
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
    }
    
}
export default projectController;