import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import activityController from '../../controllers/activity/activityController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const ActivityRoutes = Router();

// Company admin only, for this release. D-7 keeps a single all-powerful admin
// seat; when granular admin permissions arrive this is one of the places that
// changes, not every screen.
const adminOnly = [passportSignIn, acl([7]), hospitalityMiddleware.requireHospitality];

ActivityRoutes.get('/', ...adminOnly, activityController.list);
ActivityRoutes.get('/facets', ...adminOnly, activityController.facets);
ActivityRoutes.get('/coverage-gaps', ...adminOnly, activityController.coverageGaps);
ActivityRoutes.get('/:id/changes', ...adminOnly, activityController.changes);

export default ActivityRoutes;
