import {Router} from 'express';
import projectController from '../../controllers/project/projectController.js';
import { validateBody } from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/projectDbValidation.js';
import passport from '../../middleware/passport.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';
import { acl } from '../../helper/common.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const projectRoutes = Router();

// route for creating the project
projectRoutes.post(
    '/create',
    passportSignIn,
    acl([2]),
    validateBody(projectSchemas.create),
    validateDbBody.project_exist,
    projectController.create
)

export default projectRoutes;