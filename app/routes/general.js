import { Router } from 'express';

import passport from '../middleware/passport.js';
import generalController from '../controllers/general/generalController.js';
import { acl, noAcl } from '../helper/common.js';
import { validateBody, validateParam } from '../validations/paramValidation/userValidation.js';
import { hierarchySchema } from '../validations/hierarchyValidation.js';
import { hospitalityApprovalController, processController } from '../controllers/general/generalController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const GeneralRoutes = Router();


GeneralRoutes.get(
  '/states/:id',
  generalController.getStates
);
GeneralRoutes.get(
  '/cities/:id',
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

// Process Management (Universal Business Domains)
GeneralRoutes.post(
  '/hospitality/approval/processes',
  passportSignIn,
  acl([7]),
  processController.createProcess
);
GeneralRoutes.get(
  '/hospitality/approval/processes',
  passportSignIn,
  acl([7, 2]),
  processController.getProcesses
);
GeneralRoutes.put(
  '/hospitality/approval/processes/:id',
  passportSignIn,
  acl([7]),
  processController.updateProcess
);
GeneralRoutes.delete(
  '/hospitality/approval/processes/:id',
  passportSignIn,
  acl([7]),
  processController.deleteProcess
);

// Policy Management
GeneralRoutes.post(
  '/hospitality/approval/policies',
  passportSignIn,
  acl([7]),
  hospitalityApprovalController.upsertApprovalPolicy
);
// SECURITY: this route previously had NO acl() at all, so vendors (user_type 3)
// could reach it and read any tenant's policy by passing their company id in
// the query string. Gated to the same buyer/admin roles as the sibling policy
// routes; the controller additionally checks the company against req.user.
GeneralRoutes.get(
  '/hospitality/approval/policies/match',
  passportSignIn,
  acl([7, 2]),
  hospitalityApprovalController.findMatchingPolicy
);
GeneralRoutes.get(
  '/hospitality/approval/policies',
  passportSignIn,
  acl([7, 2]),
  hospitalityApprovalController.getApprovalPolicies
);
GeneralRoutes.get('/hospitality/approval/policies/:id/department-preview', passportSignIn, acl([7, 2]), hospitalityApprovalController.getDepartmentPreview);
GeneralRoutes.get('/hospitality/approval/policies/:id/pending-impact', passportSignIn, acl([7, 2]), hospitalityApprovalController.getPendingImpact);
GeneralRoutes.get(
  '/hospitality/approval/policies/:id',
  passportSignIn,
  acl([7, 2]),
  hospitalityApprovalController.getApprovalPolicy
);
GeneralRoutes.delete(
  '/hospitality/approval/policies/:id',
  passportSignIn,
  acl([7, 2]),
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
  '/hospitality/approval/pending/counts',
  passportSignIn,
  hospitalityApprovalController.getPendingApprovalCounts
);
GeneralRoutes.get(
  '/hospitality/approval/will-be-final-approver',
  passportSignIn,
  hospitalityApprovalController.willBeFinalApprover
);
GeneralRoutes.get(
  '/hospitality/approval/instance/:id/change-history',
  passportSignIn,
  hospitalityApprovalController.getInstanceChangeHistory
);
GeneralRoutes.get(
  '/hospitality/approval/instance/:id',
  passportSignIn,
  hospitalityApprovalController.getApprovalInstance
);
// SECURITY: also previously ungated. Returns approval instances (approver
// names/emails, company + hotel names) for an arbitrary entity id.
GeneralRoutes.get(
  '/hospitality/approval/entity/:entity_type/:entity_id',
  passportSignIn,
  acl([7, 2]),
  hospitalityApprovalController.getEntityApprovals
);
GeneralRoutes.post(
  '/hospitality/approval/action',
  passportSignIn,
  hospitalityApprovalController.submitApprovalAction
);
// SECURITY: this route had no role gate at all, so vendors (user_type 3) could
// reach a handler that CANCELS approval instances by sequential id. The
// controller's tenant guard is the real control (a vendor resolves to an empty
// company scope and 404s); this mirrors the sibling /submit gate on top of it.
GeneralRoutes.post(
  '/hospitality/approval/cancel',
  passportSignIn,
  noAcl([3]),
  hospitalityApprovalController.cancelApproval
);

export default GeneralRoutes;

