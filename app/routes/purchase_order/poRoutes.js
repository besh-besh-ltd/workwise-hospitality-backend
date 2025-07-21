import { Router } from "express";
import { approvePO, getPOByRFQ, getPODetails } from "../../controllers/po/purchaseOrderController.js";
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const PORoutes = Router();

PORoutes.get('/:po_id', passportSignIn, getPODetails);
PORoutes.get('/rfq/:rfq_id', passportSignIn, getPOByRFQ);
PORoutes.post('/approve/:po_id', passportSignIn, approvePO);

export default PORoutes;