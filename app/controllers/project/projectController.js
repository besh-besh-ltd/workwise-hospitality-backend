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

            console.log(req.body+"...............................................");

            const user_id = req.user.id;

            const tbl_project_data = {
              name,
              description,
              location,
              ended_at,
              user_id:user_id
            }
            
            const response = await projectModel.create_project(tbl_project_data);
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
    }
}
export default projectController;