import { Router } from "express";
import { approvePO, createMilestoneController, createTaskController, deleteMilestoneController, deleteTaskController, getMilestonesController, getPOByRFQ, getPODetails, getTasksController, updateMilestoneController, updateTaskController } from "../../controllers/po/purchaseOrderController.js";
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const PORoutes = Router();

PORoutes.get('/:po_id', passportSignIn, getPODetails);
PORoutes.get('/rfq/:rfq_id', passportSignIn, getPOByRFQ);
PORoutes.post('/approve/:po_id', passportSignIn, approvePO);

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