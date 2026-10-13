import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as prController from '../../controllers/pr/prController.js';

const PrRoutes = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Purchase Requisitions (buyer side). Route gate = acl([2, 8]); every handler
// then derives scope from req.user + the PR row (prAccess) — never can().
//
// Static paths are registered BEFORE the `/:id` routes, and `:id` only matches
// digits, so a later static path can never be swallowed as an id. Anything no
// PR route matches (e.g. `/pr/abc`) falls through to PrNotFound below.

// Create-form pickers.
PrRoutes.get( '/form/hotels',        passportSignIn, acl([2, 8]), prController.formHotels);
PrRoutes.get( '/form/departments',   passportSignIn, acl([2, 8]), prController.formDepartments);
PrRoutes.get( '/search-items',       passportSignIn, acl([2, 8]), prController.searchItems);
PrRoutes.get( '/categories',         passportSignIn, acl([2, 8]), prController.categories);

// Listing, KPIs, duplicate hints (static paths: before /:id).
PrRoutes.get( '/',                   passportSignIn, acl([2, 8]), prController.list);
PrRoutes.get( '/kpis',               passportSignIn, acl([2, 8]), prController.kpis);
PrRoutes.get( '/duplicates',         passportSignIn, acl([2, 8]), prController.duplicates);

// Drafts.
PrRoutes.post('/',                   passportSignIn, acl([2, 8]), prController.create);
PrRoutes.get( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.getById);
PrRoutes.put( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.update);
PrRoutes.post('/:id(\\d+)/cancel',   passportSignIn, acl([2, 8]), prController.cancel);
PrRoutes.post('/:id(\\d+)/copy',     passportSignIn, acl([2, 8]), prController.copy);

// Fallback for any /pr path no route above matched — a non-numeric id, an
// unknown sub-path. It is a SEPARATE router mounted after PrRoutes
// (routes/index.js: `v1.use('/pr', PrRoutes, PrNotFound)`), so it only runs
// once PrRoutes has passed, wherever later tasks register their routes, and it
// answers in the PR error contract instead of the app-wide 405.
export const PrNotFound = Router();
PrNotFound.use(passportSignIn, acl([2, 8]), (req, res) =>
  res.status(404).json({ status: 0, code: 'PR_NOT_FOUND', message: 'Purchase requisition not found' }));

export default PrRoutes;
