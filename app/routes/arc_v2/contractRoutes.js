import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as arcController from '../../controllers/arc_v2/arcController.js';
import * as arcContractController from '../../controllers/arc_v2/arcContractController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// All routes here require auth; acl gates writes to buyer roles. Per
// architectural memory: use acl(), not can() — the latter relies on
// deprecated x-headers.

// Listing + dashboard counts (read-only — buyer roles).
r.get('/',             passportSignIn, acl([2, 8]), arcController.list);
r.post('/list-view',   passportSignIn, acl([2, 8]), arcController.getArcListView);
r.get('/kpis',         passportSignIn, acl([2, 8]), arcController.dashboardCounts);

// Department / sub-category pickers for the wizard.
r.get('/category-departments', passportSignIn, acl([2, 8]), arcController.getDepartmentsForCategory);
r.get('/hotel-departments',    passportSignIn, acl([2, 8]), arcController.getDepartmentsForHotel);
r.get('/sub-categories',       passportSignIn, acl([2, 8]), arcController.getSubCategories);

// Catalogue pickers for the create wizard.
r.get('/categories',       passportSignIn, acl([2, 8]), arcController.listRootCategories);
r.get('/hotels',           passportSignIn, acl([2, 8]), arcController.listAccessibleHotels);
r.get('/variants',         passportSignIn, acl([2, 8]), arcController.searchProductVariants);
r.get('/eligible-vendors', passportSignIn, acl([2, 8]), arcController.listEligibleVendors);

// Detail + lifecycle spine + active-summary.
r.get('/:id',                  passportSignIn, acl([2, 8]), arcController.getById);
r.get('/:id/lifecycle',        passportSignIn, acl([2, 8]), arcController.getLifecycle);
r.get('/:id/active-summary',   passportSignIn, acl([2, 8]), arcContractController.getActiveSummary);
// Publish-approval chain detail (latest ARC_PUBLISH instance, or null).
r.get('/:id/publish-approval', passportSignIn, acl([2, 8]), arcController.getPublishApproval);
// Bundle of the contracted vendor's uploaded compliance docs (GST/PAN/cheque…).
r.get('/contracts/:contractId/vendor-documents', passportSignIn, acl([2, 8]), arcContractController.getVendorDocumentsBundle);

// Mutations — creator + ARC-roles only.
r.post('/',                    passportSignIn, acl([2, 8]), arcController.createDraft);
r.patch('/:id',                passportSignIn, acl([2, 8]), arcController.updateDraft);
r.post('/:id/publish',         passportSignIn, acl([2, 8]), arcController.publish);
r.post('/:id/withdraw',        passportSignIn, acl([2, 8]), arcController.withdraw);
// Publish-approval decide (approve/reject). Engine-gated inside the controller.
r.post('/:id/publish-approval/decide', passportSignIn, acl([2, 8]), arcController.publishApprovalDecide);
r.post('/:id/terminate',       passportSignIn, acl([2, 8]), arcController.terminate);

export default r;
