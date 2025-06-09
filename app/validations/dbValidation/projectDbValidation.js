import projectModel from '../../models/projectModel.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import Config from '../../config/app.config.js';

const validateDbBody = {
    project_exist: async ( req, res, next) => {
        try {
            // Skip validation for admin users
            if (req.user.user_type === 7) {
                return next();
            }
            let errors = {};
            let err = 0;
            const user_id = req.user.id;
            let {name} = req.body;
            if(name){
                const projectNameExist = await projectModel.projectExist(name,user_id);
                if(projectNameExist.length > 0) {
                    err++;
                    errors.project_name = 'Project Name already Exist';
                }
            }
            // if name exist then return here with the above errors
            if (err > 0) {
                res
                  .status(400)
                  .json({
                    status: 2,
                    errors
                  })
                  .end();
              } else {
                next(); // if name does  not exist then go to the next middleware
              }

        }catch (err) {
            logError(err);
            res
              .status(400)
              .json({
                status: 3,
                message: Config.errorText.value
              })
              .end();
          }
    }
}

export { validateDbBody };