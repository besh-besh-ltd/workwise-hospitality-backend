import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as mrController from '../../controllers/mr/mrController.js';

const MrRoutes = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Buyer-side MR endpoints.
// Listing + dashboard counts.
MrRoutes.get( '/',                       passportSignIn, acl([2, 8]), mrController.list);
MrRoutes.get( '/kpis',                   passportSignIn, acl([2, 8]), mrController.dashboardCounts);

// Search contracted items (picker).
MrRoutes.get( '/search-contracted-items', passportSignIn, acl([2, 8]), mrController.searchContractedItems);

// Detail + mutations.
MrRoutes.get( '/:id',                    passportSignIn, acl([2, 8]), mrController.getById);
MrRoutes.post('/',                       passportSignIn, acl([2, 8]), mrController.createDraft);
MrRoutes.post('/:id/submit',             passportSignIn, acl([2, 8]), mrController.submit);
MrRoutes.post('/:id/cancel',             passportSignIn, acl([2, 8]), mrController.cancel);

export default MrRoutes;
