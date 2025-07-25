import { Router } from "express";
import { approvePO, createMilestoneController, deleteMilestoneController, getMilestonesController, getPOByRFQ, getPODetails, updateMilestoneController } from "../../controllers/po/purchaseOrderController.js";
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

export default PORoutes;