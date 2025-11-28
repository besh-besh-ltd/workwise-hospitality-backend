import {Router} from 'express';
import projectController from '../../controllers/project/projectController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import { validateBody,validateParam } from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/projectDbValidation.js';
import passport from '../../middleware/passport.js';
import { projectSchemas } from '../../validations/paramValidation/projectValidation.js';
import { acl, noAcl } from '../../helper/common.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const projectRoutes = Router();

// route for creating the project
projectRoutes.post(
    '/create',
    passportSignIn,
    acl([2, 7, 8]),
    validateBody(projectSchemas.create),
    validateDbBody.project_exist,
    projectController.create
)

projectRoutes.post(
    '/upload-file',
    passportSignIn,
    acl([2, 7, 8]),
    projectSchemas.projectFileUploadHandler, 
    validateBody(projectSchemas.saveFiles),
    projectController.saveProjectFiles
)

// route for getting the project details using project id
projectRoutes.post(
    '/:project_id',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.project_id),
    projectController.getProjectById
)

// route for getting the project table data using project id
projectRoutes.get(
    '/:project_id',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.project_id),
    projectController.getProjectTableDataById
)

projectRoutes.get('/project-budget/:project_id',
    passportSignIn,
    noAcl([3]),
    validateParam(projectSchemas.project_id),
    projectController.getProjectBudget
)
//For fetching available budget By Ayush
projectRoutes.get('/available-budget/:project_id',
    passportSignIn,
    noAcl([3]),   //Exclude from ACL
    validateParam(projectSchemas.project_id),
    projectController.getProjectAvailableBudget
)

// route for getting all Projects
projectRoutes.get(
    '/',
    passportSignIn,
    hospitalityMiddleware.attachHospitalityContext(),
    projectController.getAllProjects
)

// route for updating the existing project 
projectRoutes.put(
    '/update/:project_id',
    passportSignIn,
    acl([2, 7, 8]),
    validateBody(projectSchemas.update),
    validateParam(projectSchemas.project_id), 
    projectController.update
)

// route for getting all projects of the user with projectid and projectName
projectRoutes.get(
    '/name/list',
    passportSignIn,
    // acl([2, 7]),
    projectController.getIdAndNameOfProjects
)

// Changes by Agnij 14-01-2025 [Added routes for project team operations]

// Route for getting team members of a project
projectRoutes.get(
    '/:project_id/team',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.project_id),
    projectController.getProjectTeamMembers
)

// Route for adding a team member to a project
projectRoutes.post(
    '/:project_id/team',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.project_id),
    validateBody(projectSchemas.addTeamMember),
    projectController.addTeamMember
)

// Route for removing a team member from a project
projectRoutes.delete(
    '/:project_id/team',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.project_id),
    validateBody(projectSchemas.removeTeamMember),
    projectController.removeTeamMember
)

// Route for getting all projects where the current user is a team member
projectRoutes.get(
    '/team/user-projects',
    passportSignIn,
    projectController.getUserProjects
)
// Route for getting all projects assigned to a specific user
projectRoutes.get(
    '/user/:user_id/projects',
    passportSignIn,
    acl([2, 7, 8]),
    validateParam(projectSchemas.user_id),
    projectController.getUserProjectsByUserId
)

export default projectRoutes;