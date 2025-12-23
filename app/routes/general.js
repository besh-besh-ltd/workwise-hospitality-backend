import { Router } from 'express';

import passport from '../middleware/passport.js';
import generalController from '../controllers/general/generalController.js';
import { acl, noAcl } from '../helper/common.js';
import { validateBody, validateParam } from '../validations/paramValidation/userValidation.js';
import { hierarchySchema } from '../validations/hierarchyValidation.js';
import { hospitalityApprovalController } from '../controllers/general/generalController.js';

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
GeneralRoutes.delete(
  '/hierarchy/:id',
  passportSignIn,
  acl([7]),
  generalController.deleteHierarchy
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

GeneralRoutes.get(
  '/getUserHierarchies',
  passportSignIn,
  generalController.getUserHierarchies
);

// --- Hospitality Approval Engine Routes ---

// Policy Management
GeneralRoutes.post(
  '/hospitality/approval/policies',
  passportSignIn,
  acl([7]),
  hospitalityApprovalController.upsertApprovalPolicy
);
GeneralRoutes.get(
  '/hospitality/approval/policies/match',
  passportSignIn,
  hospitalityApprovalController.findMatchingPolicy
);
GeneralRoutes.get(
  '/hospitality/approval/policies',
  passportSignIn,
  acl([7]),
  hospitalityApprovalController.getApprovalPolicies
);
GeneralRoutes.get(
  '/hospitality/approval/policies/:id',
  passportSignIn,
  acl([7]),
  hospitalityApprovalController.getApprovalPolicy
);
GeneralRoutes.delete(
  '/hospitality/approval/policies/:id',
  passportSignIn,
  acl([7]),
  hospitalityApprovalController.deleteApprovalPolicy
);

// Approval Instance Management
GeneralRoutes.post(
  '/hospitality/approval/submit',
  passportSignIn,
  noAcl([3]),
  hospitalityApprovalController.submitApproval
);
GeneralRoutes.get(
  '/hospitality/approval/pending',
  passportSignIn,
  hospitalityApprovalController.getPendingApprovals
);
GeneralRoutes.get(
  '/hospitality/approval/instance/:id',
  passportSignIn,
  hospitalityApprovalController.getApprovalInstance
);
GeneralRoutes.get(
  '/hospitality/approval/entity/:entity_type/:entity_id',
  passportSignIn,
  hospitalityApprovalController.getEntityApprovals
);
GeneralRoutes.post(
  '/hospitality/approval/action',
  passportSignIn,
  hospitalityApprovalController.submitApprovalAction
);
GeneralRoutes.post(
  '/hospitality/approval/cancel',
  passportSignIn,
  hospitalityApprovalController.cancelApproval
);

export default GeneralRoutes;

