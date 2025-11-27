import { Router } from "express";
import { addSiteRepresentative, approvePO, createMilestoneController, createTaskController, deleteMilestoneController, deleteTaskController, getMilestonesController, getPOByRFQ, getPODetails, getTasksController, initiatePO, markDispatched, raiseInvoice, updateGST, updateHSNForProduct, updateMilestoneController, updatePO, updateTaskController } from "../../controllers/po/purchaseOrderController.js";
import passport from '../../middleware/passport.js';
import { acl, noAcl } from "../../helper/common.js";

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const PORoutes = Router();

PORoutes.get('/:po_id', passportSignIn, getPODetails);
PORoutes.put('/:po_id', passportSignIn, updatePO)
PORoutes.get('/rfq/:rfq_id', passportSignIn, getPOByRFQ);
PORoutes.get('/initiate/:po_id', passportSignIn, initiatePO);
PORoutes.post('/approve/:po_id', passportSignIn, approvePO);
PORoutes.post('/updateGST/:po_id', passportSignIn, updateGST);
PORoutes.post('/updateHSN/:po_id', passportSignIn, updateHSNForProduct);
PORoutes.post('/raiseInvoice', passportSignIn, acl([3]), raiseInvoice);
PORoutes.post('/markDispatched', passportSignIn, acl([3]), markDispatched);
PORoutes.post('/addSiteRepresentative', passportSignIn, noAcl([2]), addSiteRepresentative);

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