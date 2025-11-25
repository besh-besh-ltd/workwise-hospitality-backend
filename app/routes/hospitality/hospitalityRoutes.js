import { Router } from 'express';
import { acl } from '../../helper/common.js';
import hospitalityController from '../../controllers/users/hospitalityController.js';
import UsersController from '../../controllers/users/usersController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';
import {
  validateBody,
  validateParam,
  schemas
} from '../../validations/paramValidation/hospitalityValidation.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const HospitalityRoutes = Router();

HospitalityRoutes.get(
  '/companies',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  hospitalityController.listCompanies
);

HospitalityRoutes.post(
  '/company',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateBody(schemas.hospitalityCompany),
  hospitalityController.createCompany
);

HospitalityRoutes.put(
  '/company/:company_id',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityCompany),
  hospitalityController.updateCompany
);

HospitalityRoutes.get(
  '/company/:company_id/hotels',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.listCompanyHotels
);

HospitalityRoutes.post(
  '/company/:company_id/hotels',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityHotel),
  hospitalityController.createHotel
);

HospitalityRoutes.post(
  '/company/:company_id/map-users',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityMapUsers),
  hospitalityController.mapUsers
);

HospitalityRoutes.post(
  '/company/:company_id/map-projects',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  validateBody(schemas.hospitalityMapProjects),
  hospitalityController.mapProjects
);

HospitalityRoutes.get(
  '/company/:company_id/mapped-user-ids',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.getMappedUserIds
);

HospitalityRoutes.get(
  '/my-contexts',
  passportSignIn,
  hospitalityController.getMyContexts
);

HospitalityRoutes.get(
  '/company/:company_id/user-mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.listCompanyUserMappings
);

HospitalityRoutes.get(
  '/company/:company_id/mapped-project-ids',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateParam(schemas.companyIdParam),
  hospitalityController.getMappedProjectIds
);

HospitalityRoutes.get(
  '/project/:project_id/mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  hospitalityController.getProjectMappings
);

HospitalityRoutes.get(
  '/user/:user_id/mappings',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  hospitalityController.getUserMappings
);

HospitalityRoutes.delete(
  '/project/:project_id/mapping',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateBody(schemas.deleteMapping),
  hospitalityController.deleteProjectMapping
);

HospitalityRoutes.delete(
  '/user/:user_id/mapping',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  validateBody(schemas.deleteMapping),
  hospitalityController.deleteUserMapping
);

HospitalityRoutes.post(
  '/subscription-payment',
  validateBody(schemas.hospitalitySubscriptionPayment),
  UsersController.hospitalitySubscriptionPayment
);

export default HospitalityRoutes;


