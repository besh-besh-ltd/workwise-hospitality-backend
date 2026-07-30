import { Router } from "express";
import { acceptPO, addSiteRepresentative, approvePO, createMilestoneController, createTaskController, deleteMilestoneController, deleteTaskController, getMilestonesController, getPOByRFQ, getPODetails, getTasksController, initiatePO, markDispatched, markGRN, mergePODrafts, raiseInvoice, regeneratePO, rejectPO, uploadPODocument, updateGST, updateHSNForProduct, updateMilestoneController, updatePO, updateTaskController } from "../../controllers/po/purchaseOrderController.js";
import { listPOs, dashboardKpis, awaitingPOs, poDetailFull, tracking, analytics } from "../../controllers/po/poDashboardController.js";
import { vendorDashboard, vendorListView, vendorPoDetail, vendorPoPdf } from "../../controllers/po/poVendorController.js";
import { poUploadMiddleware } from "../../validations/paramValidation/poValidation.js";
import passport from '../../middleware/passport.js';
import { acl, noAcl } from "../../helper/common.js";
import auth from "../../middleware/auth.js";
import hospitalityMiddleware from '../../middleware/hospitality.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const PORoutes = Router();

// ---------------------------------------------------------------------------
// New PO dashboard / tracking / analytics endpoints (buyer-facing, read-only).
// Registered BEFORE the dynamic `/:po_id` route so the static paths are not
// swallowed by the param route. All use passportSignIn + noAcl([3]) (everyone
// except vendors). Scope is derived from req.user + headers inside the
// controller (see deriveScope) — tenant ids are never taken from body/query.
// ---------------------------------------------------------------------------
PORoutes.get('/list', passportSignIn, noAcl([3]), listPOs);
PORoutes.get('/dashboard/kpis', passportSignIn, noAcl([3]), dashboardKpis);
PORoutes.get('/awaiting', passportSignIn, noAcl([3]), awaitingPOs);
PORoutes.get('/tracking', passportSignIn, noAcl([3]), tracking);
PORoutes.get('/analytics', passportSignIn, noAcl([3]), analytics);
PORoutes.get('/detail/:po_id', passportSignIn, noAcl([3]), poDetailFull);

// ---------------------------------------------------------------------------
// Vendor-facing PO endpoints (vendors only — acl([3])). Registered BEFORE the
// dynamic `/:po_id` route so the static `/vendor/*` paths are not swallowed.
// Scope is the authenticated vendor's id (finalized_vendor_id) derived from
// req.user inside the controller — never from body/query.
// ---------------------------------------------------------------------------
PORoutes.get('/vendor/dashboard', passportSignIn, acl([3]), vendorDashboard);
PORoutes.post('/vendor/list-view', passportSignIn, acl([3]), vendorListView);
PORoutes.get('/vendor/detail/:po_id', passportSignIn, acl([3]), vendorPoDetail);
PORoutes.get('/vendor/detail/:po_id/pdf', passportSignIn, acl([3]), vendorPoPdf);

PORoutes.get('/:po_id', auth.authUserOrGRNToken, getPODetails);
// Edit PO: vendors are NEVER permitted to edit a PO. The hierarchy/creator
// check inside handleUpdatePO is defence-in-depth; this `noAcl([3])` blocks
// vendor user_types at the route layer.
PORoutes.put('/:po_id', passportSignIn, noAcl([3]), updatePO)
// Vendors legitimately call this (Order Book) — the controller skips the buyer
// RBAC gate for user_type 3 and the model scopes them to finalized_vendor_id.
PORoutes.get('/rfq/:rfq_id', passportSignIn, getPOByRFQ);

// Initiate a draft PO (draft -> pending_approval + approval instance + PDF +
// approver emails). This is a STATE-CHANGING operation that shipped as a GET
// with no acl() and no scope check at all, so any authenticated user could
// initiate any tenant's PO. Fixed in three places:
//   1. noAcl([3])       — vendors can never initiate (the vendor Order Book
//                         passes a handleInitiatePO prop that is destructured
//                         but never rendered, so nothing breaks).
//   2. assertPoAccess   — inside the controller, 4-axis tenant scope.
//   3. POST binding     — the correct verb for the effect.
// The GET binding is kept ONLY for backwards compatibility with the deployed
// frontend, whose single call site is frontend/services/po.js
// (handlePOInitialization). Once that switches to POST, delete the GET line.
PORoutes.get('/initiate/:po_id', passportSignIn, noAcl([3]), initiatePO);
PORoutes.post('/initiate/:po_id', passportSignIn, noAcl([3]), initiatePO);
// Bulk-merge multiple draft POs of the same vendor on the same RFQ into one.
// Same buyer-only acl as the other write routes; tenant scope is verified
// inside the model against the kept PO's company_id.
PORoutes.post('/merge-drafts', passportSignIn, noAcl([3]), mergePODrafts);
// Buyer-side PO writes. All of these previously ran with passportSignIn ONLY —
// no role gate and no tenant scope — so a vendor (or any user from any other
// company) could approve, regenerate, re-upload the PDF, or rewrite the GSTIN /
// HSN codes of an arbitrary purchase order by id. noAcl([3]) blocks vendors at
// the route; assertPoAccess enforces the 4-axis tenant scope in the controller.
PORoutes.post('/approve/:po_id', passportSignIn, noAcl([3]), approvePO);
PORoutes.post('/accept/:po_id', passportSignIn, acl([3]), acceptPO);
PORoutes.post('/reject/:po_id', passportSignIn, acl([3]), rejectPO);
PORoutes.post('/regenerate/:po_id', passportSignIn, noAcl([3]), regeneratePO);
PORoutes.post('/upload-pdf/:po_id', passportSignIn, noAcl([3]), poUploadMiddleware, uploadPODocument);
PORoutes.post('/updateGST/:po_id', passportSignIn, noAcl([3]), updateGST);
PORoutes.post('/updateHSN/:po_id', passportSignIn, noAcl([3]), updateHSNForProduct);
PORoutes.post('/raiseInvoice', passportSignIn, acl([3]), hospitalityMiddleware.requireActiveSubscription, raiseInvoice);
PORoutes.post('/markDispatched', passportSignIn, acl([3]), hospitalityMiddleware.requireActiveSubscription, markDispatched);
PORoutes.post('/addSiteRepresentative', passportSignIn, noAcl([3]), addSiteRepresentative);
PORoutes.post('/markGRN', auth.authUserOrGRNToken, noAcl([3]), markGRN);

// Milestone + Task routes. Deliberately NOT noAcl([3]): the vendor Order Book
// creates and edits milestones on its own POs (components/dashboard/vendor/
// order-book/CreateMilestoneModal.js). Tenancy is enforced per row by resolving
// the parent PO and running assertPoAccess, which admits the finalized vendor
// for their own PO and nobody else's — previously ANY authenticated user could
// edit ANY milestone/task by its sequential id.
PORoutes.get('/:po_id/milestones', passportSignIn, getMilestonesController);
PORoutes.post('/milestones', passportSignIn, createMilestoneController);
PORoutes.put('/milestones/:id', passportSignIn, updateMilestoneController);
PORoutes.delete('/milestones/:id', passportSignIn, deleteMilestoneController);

PORoutes.get('/:po_id/tasks', passportSignIn, getTasksController);
PORoutes.post('/tasks', passportSignIn, createTaskController);
PORoutes.put('/tasks/:id', passportSignIn, updateTaskController);
PORoutes.delete('/tasks/:id', passportSignIn, deleteTaskController);

export default PORoutes;