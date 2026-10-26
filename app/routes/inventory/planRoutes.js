import express from 'express';
import { buyerGuard } from './guards.js';
import {
  getPoDeliveries,
  savePoDeliveryPlan,
  patchDeliveryDueDate,
} from '../../controllers/inventory/planController.js';
import {
  shortClosePo,
  reopenShortClose,
} from '../../controllers/inventory/shortCloseController.js';
import {
  revokeSiteRep,
} from '../../controllers/inventory/siteRepController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/po/:poId/deliveries', ...buyerGuard, getPoDeliveries);
router.put('/po/:poId/deliveries', ...buyerGuard, savePoDeliveryPlan);
router.patch('/po/:poId/deliveries/:deliveryId', ...buyerGuard, patchDeliveryDueDate);
router.post('/po/:poId/short-close', ...buyerGuard, shortClosePo);
router.post('/po/:poId/short-close/reopen', ...buyerGuard, reopenShortClose);
router.post('/po/:poId/site-rep/revoke', ...buyerGuard, revokeSiteRep);

export default router;
