import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import { requireCompanyAdmin } from '../../middleware/companyAdmin.js';
import * as prController from '../../controllers/pr/prController.js';
import * as prAdminController from '../../controllers/pr/prAdminController.js';

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

// Routing preview of an unsaved PR (static path: before /:id).
PrRoutes.post('/routing-preview',    passportSignIn, acl([2, 8]), prController.routingPreview);

// Technical reviewer's queue (static path: before /:id).
PrRoutes.get( '/review-queue',       passportSignIn, acl([2, 8]), prController.reviewQueue);

// Buyer pool + buyers picker (static paths: before /:id). pr.convert on the hotel.
PrRoutes.get( '/pool',               passportSignIn, acl([2, 8]), prController.pool);
PrRoutes.get( '/buyers',             passportSignIn, acl([2, 8]), prController.buyers);

// Convert pool lines into one RFQ draft (static path: before /:id).
// pr.convert on the hotel + rfq.create on the chosen department.
PrRoutes.post('/convert',            passportSignIn, acl([2, 8]), prController.convert);

// Company admin: category → reviewing-department map. Gated by the company
// admin capability (requireCompanyAdmin — admits legacy user_type 7 as well as
// a buyer holding company.admin, so no acl([2, 8]) here); the administered
// company is derived from the admin's account in the controller.
PrRoutes.get(   '/admin/review-routing',              passportSignIn, requireCompanyAdmin, prAdminController.listReviewRouting);
PrRoutes.post(  '/admin/review-routing',              passportSignIn, requireCompanyAdmin, prAdminController.saveReviewRouting);
PrRoutes.delete('/admin/review-routing/:mapId(\\d+)', passportSignIn, requireCompanyAdmin, prAdminController.deleteReviewRouting);

// Drafts.
PrRoutes.post('/',                   passportSignIn, acl([2, 8]), prController.create);
PrRoutes.get( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.getById);
PrRoutes.put( '/:id(\\d+)',          passportSignIn, acl([2, 8]), prController.update);
PrRoutes.post('/:id(\\d+)/cancel',   passportSignIn, acl([2, 8]), prController.cancel);
PrRoutes.post('/:id(\\d+)/copy',     passportSignIn, acl([2, 8]), prController.copy);

// Workflow: submit / withdraw (requester), send back (current-step approver).
// Approve / Reject go through the generic POST /general/hospitality/approval/action.
PrRoutes.post('/:id(\\d+)/submit',    passportSignIn, acl([2, 8]), prController.submit);
PrRoutes.post('/:id(\\d+)/withdraw',  passportSignIn, acl([2, 8]), prController.withdraw);
PrRoutes.post('/:id(\\d+)/send-back', passportSignIn, acl([2, 8]), prController.sendBack);
PrRoutes.get( '/:id(\\d+)/routing-preview', passportSignIn, acl([2, 8]), prController.savedRoutingPreview);

// Technical review: reviewer line edits (own open review's lines), files
// (requester on draft/returned, reviewer on own lines), review outcome.
PrRoutes.put(   '/:id(\\d+)/lines/:lineId(\\d+)/specification',                passportSignIn, acl([2, 8]), prController.editLineSpecification);
PrRoutes.post(  '/:id(\\d+)/lines/:lineId(\\d+)/clauses',                      passportSignIn, acl([2, 8]), prController.addLineClause);
PrRoutes.delete('/:id(\\d+)/lines/:lineId(\\d+)/clauses/:clauseId(\\d+)',      passportSignIn, acl([2, 8]), prController.removeLineClause);
PrRoutes.post(  '/:id(\\d+)/attachments',                                      passportSignIn, acl([2, 8]), prController.addAttachment);
PrRoutes.delete('/:id(\\d+)/attachments/:attId(\\d+)',                         passportSignIn, acl([2, 8]), prController.removeAttachment);
PrRoutes.post(  '/:id(\\d+)/reviews/:reviewId(\\d+)/complete',                 passportSignIn, acl([2, 8]), prController.completeReview);
PrRoutes.post(  '/:id(\\d+)/reviews/:reviewId(\\d+)/send-back',                passportSignIn, acl([2, 8]), prController.sendBackReview);

// Buyer pool actions: assign, map, catalog request, close (pr.convert on the
// PR's hotel); cancel a line (the requester of an approved PR).
PrRoutes.post('/:id(\\d+)/assign',                                 passportSignIn, acl([2, 8]), prController.assign);
PrRoutes.post('/:id(\\d+)/lines/:lineId(\\d+)/map',              passportSignIn, acl([2, 8]), prController.mapLine);
PrRoutes.post('/:id(\\d+)/lines/:lineId(\\d+)/catalog-request',  passportSignIn, acl([2, 8]), prController.catalogRequest);
PrRoutes.post('/:id(\\d+)/lines/:lineId(\\d+)/close',            passportSignIn, acl([2, 8]), prController.closeLine);
PrRoutes.post('/:id(\\d+)/lines/:lineId(\\d+)/cancel',           passportSignIn, acl([2, 8]), prController.cancelLine);

// Fallback for any /pr path no route above matched — a non-numeric id, an
// unknown sub-path. It is a SEPARATE router mounted after PrRoutes
// (routes/index.js: `v1.use('/pr', PrRoutes, PrNotFound)`), so it only runs
// once PrRoutes has passed, wherever later tasks register their routes, and it
// answers in the PR error contract instead of the app-wide 405.
export const PrNotFound = Router();
PrNotFound.use(passportSignIn, acl([2, 8]), (req, res) =>
  res.status(404).json({ status: 0, code: 'PR_NOT_FOUND', message: 'Purchase requisition not found' }));

export default PrRoutes;
