import { Router } from "express";
import { acceptPO, addSiteRepresentative, approvePO, createMilestoneController, createTaskController, deleteMilestoneController, deleteTaskController, getMilestonesController, getPOByRFQ, getPODetails, getTasksController, initiatePO, markDispatched, markGRN, raiseInvoice, regeneratePO, rejectPO, uploadPODocument, updateGST, updateHSNForProduct, updateMilestoneController, updatePO, updateTaskController } from "../../controllers/po/purchaseOrderController.js";
import { poUploadMiddleware } from "../../validations/paramValidation/poValidation.js";
import passport from '../../middleware/passport.js';
import { acl, noAcl } from "../../helper/common.js";
import auth from "../../middleware/auth.js";
import hospitalityMiddleware from '../../middleware/hospitality.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const PORoutes = Router();

PORoutes.get('/:po_id', auth.authUserOrGRNToken, getPODetails);
// Edit PO: vendors are NEVER permitted to edit a PO. The hierarchy/creator
// check inside handleUpdatePO is defence-in-depth; this `noAcl([3])` blocks
// vendor user_types at the route layer.
PORoutes.put('/:po_id', passportSignIn, noAcl([3]), updatePO)
PORoutes.get('/rfq/:rfq_id', passportSignIn, getPOByRFQ);
PORoutes.get('/initiate/:po_id', passportSignIn, initiatePO);
PORoutes.post('/approve/:po_id', passportSignIn, approvePO);
PORoutes.post('/accept/:po_id', passportSignIn, acl([3]), acceptPO);
PORoutes.post('/reject/:po_id', passportSignIn, acl([3]), rejectPO);
PORoutes.post('/regenerate/:po_id', passportSignIn, regeneratePO);
PORoutes.post('/upload-pdf/:po_id', passportSignIn, poUploadMiddleware, uploadPODocument);
PORoutes.post('/updateGST/:po_id', passportSignIn, updateGST);
PORoutes.post('/updateHSN/:po_id', passportSignIn, updateHSNForProduct);
PORoutes.post('/raiseInvoice', passportSignIn, acl([3]), hospitalityMiddleware.requireActiveSubscription, raiseInvoice);
PORoutes.post('/markDispatched', passportSignIn, acl([3]), hospitalityMiddleware.requireActiveSubscription, markDispatched);
PORoutes.post('/addSiteRepresentative', passportSignIn, noAcl([3]), addSiteRepresentative);
PORoutes.post('/markGRN', auth.authUserOrGRNToken, noAcl([3]), markGRN);

// Milestone Routes
PORoutes.get('/:po_id/milestones', passportSignIn, getMilestonesController);
PORoutes.post('/milestones', passportSignIn, createMilestoneController);
PORoutes.put('/milestones/:id', passportSignIn, updateMilestoneController);
PORoutes.delete('/milestones/:id', passportSignIn, deleteMilestoneController);

PORoutes.get('/:po_id/tasks', passportSignIn, getTasksController);
PORoutes.post('/tasks', passportSignIn, createTaskController);
PORoutes.put('/tasks/:id', passportSignIn, updateTaskController);
PORoutes.delete('/tasks/:id', passportSignIn, deleteTaskController);

export default PORoutes;