import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as mrController from '../../controllers/mr/mrController.js';

const MrRoutes = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Buyer-side MR endpoints.
// Listing + dashboard counts.
MrRoutes.get( '/',                       passportSignIn, acl([2, 8]), mrController.list);
MrRoutes.post('/list-view',              passportSignIn, acl([2, 8]), mrController.getMrListView);
MrRoutes.get( '/kpis',                   passportSignIn, acl([2, 8]), mrController.dashboardCounts);
MrRoutes.get( '/analytics',              passportSignIn, acl([2, 8]), mrController.analytics);
// Scoped BU + Department options for the dashboard header filters (same
// role-scope matrix as analytics). Static path — registered BEFORE `/:id`.
MrRoutes.get( '/dashboard/filter-options', passportSignIn, acl([2, 8]), mrController.dashboardFilterOptions);
MrRoutes.get( '/approval-preview',       passportSignIn, acl([2, 8]), mrController.approvalPreview);

// Search contracted items (picker).
MrRoutes.get( '/search-contracted-items', passportSignIn, acl([2, 8]), mrController.searchContractedItems);

// Create-form pickers — user's accessible hotels + their mapped departments.
// (Registered BEFORE the dynamic `/:id` so the static paths aren't swallowed.)
MrRoutes.get( '/form/hotels',            passportSignIn, acl([2, 8]), mrController.formHotels);
MrRoutes.get( '/form/departments',       passportSignIn, acl([2, 8]), mrController.formDepartments);

// Detail + mutations.
MrRoutes.get( '/:id',                    passportSignIn, acl([2, 8]), mrController.getById);
MrRoutes.post('/',                       passportSignIn, acl([2, 8]), mrController.createDraft);
MrRoutes.post('/:id/submit',             passportSignIn, acl([2, 8]), mrController.submit);
MrRoutes.post('/:id/cancel',             passportSignIn, acl([2, 8]), mrController.cancel);

export default MrRoutes;
