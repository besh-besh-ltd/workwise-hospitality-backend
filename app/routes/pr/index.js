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
// digits, so a later static path can never be swallowed as an id.

// Create-form pickers.
PrRoutes.get( '/form/hotels',        passportSignIn, acl([2, 8]), prController.formHotels);
PrRoutes.get( '/form/departments',   passportSignIn, acl([2, 8]), prController.formDepartments);
PrRoutes.get( '/search-items',       passportSignIn, acl([2, 8]), prController.searchItems);
PrRoutes.get( '/categories',         passportSignIn, acl([2, 8]), prController.categories);

// Drafts.
PrRoutes.post('/',                   passportSignIn, acl([2, 8]), prController.create);
PrRoutes.get( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.getById);
PrRoutes.put( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.update);
PrRoutes.post('/:id(\\d+)/cancel',   passportSignIn, acl([2, 8]), prController.cancel);
PrRoutes.post('/:id(\\d+)/copy',     passportSignIn, acl([2, 8]), prController.copy);

export default PrRoutes;
