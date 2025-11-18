import { Router } from 'express';

import passport from '../middleware/passport.js';
import generalController from '../controllers/general/generalController.js';
import { acl } from '../helper/common.js';
import { validateBody, validateParam } from '../validations/paramValidation/userValidation.js';
import { hierarchySchema } from '../validations/hierarchyValidation.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const GeneralRoutes = Router();


GeneralRoutes.get(
  '/states',
  generalController.getStates
);
GeneralRoutes.get(
  '/cities/:id?',
  generalController.getCities
);
GeneralRoutes.get(
  '/countries',
  generalController.getCountries
);
GeneralRoutes.get(
  '/country-codes',
  generalController.getCountryCodes
)
// Route to create Hierarchy from available options
GeneralRoutes.get(
  '/hierarchy',
  passportSignIn,
  acl([7]),
  validateParam(hierarchySchema.getHeirarchies),
  generalController.getHierarchies
);
GeneralRoutes.post(
  '/hierarchy',
  passportSignIn,
  acl([7]),
  validateBody(hierarchySchema.createHeirarchy),
  generalController.createHierarchy
);
GeneralRoutes.put(
  '/hierarchy',
  passportSignIn,
  acl([7]),
  validateBody(hierarchySchema.updateHierarchy),
  generalController.updateHierarchy
);
GeneralRoutes.post(
  '/mapHierarchyToProject',
  passportSignIn,
  acl([7]),
  validateBody(hierarchySchema.mapHierarchyToProject),
  generalController.mapHierarchyToProject
);
GeneralRoutes.post(
  '/setDefaultHierarchy',
  passportSignIn,
  acl([7]),
  validateBody(hierarchySchema.setDefaultHierarchy),
  generalController.setDefaultHierarchy
);

GeneralRoutes.get(
  '/hierarchyTypes',
  passportSignIn,
  generalController.getHierarchyTypes
);

export default GeneralRoutes;
