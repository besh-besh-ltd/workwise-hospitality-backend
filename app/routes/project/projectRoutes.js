import {Router} from 'express';
import projectController from '../../controllers/project/projectController.js';
import { validateBody,validateParam } from '../../validations/paramValidation/userValidation.js';
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

// route for getting the project details using project id
projectRoutes.post(
    '/:project_id',
    passportSignIn,
    validateParam(projectSchemas.project_id),
    projectController.getProjectById
)

// route for getting all Projects
projectRoutes.get(
    '/',
    passportSignIn,
    projectController.getAllProjects
)

// route for updating the existing project while turing of the status off 
projectRoutes.put(
    '/update/:project_id',
    passportSignIn,
    validateBody(projectSchemas.update),
    validateParam(projectSchemas.project_id), 
    projectController.update
)

// route for getting all projects of the user with projectid and projectName
projectRoutes.get(
    '/name_list',
    passportSignIn,
    projectController.getIdAndNameOfProjects
)




export default projectRoutes;