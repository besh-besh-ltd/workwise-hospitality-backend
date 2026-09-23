import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { noAcl } from '../../helper/common.js';
import reportsController from '../../controllers/reports/reportsController.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });
const ReportsRoutes = Router();

// noAcl([3]) keeps vendors off every buyer report surface at the route, and the
// controller refuses them again — the catalogue is a list of what a company
// buys and from whom, which no supplier should see.
ReportsRoutes.use(passportSignIn, noAcl([3]));

// What may this user run? The response is already filtered by entitlement, so
// the page renders straight from it.
ReportsRoutes.get('/catalogue', reportsController.catalogue);

// POST rather than GET for both run endpoints: the filter payload is a nested
// object, and a report URL should not be shoulder-surfable or land in an
// access log with the period and business units a user was looking at.
ReportsRoutes.post('/:key/preview', reportsController.preview);
ReportsRoutes.post('/:key/download', reportsController.download);

ReportsRoutes.get('/exports', reportsController.exportHistory);

export default ReportsRoutes;
