import express from 'express';
import { vendorGuard } from './guards.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import {
  getVendorPoDeliveries,
  createDispatch,
  cancelDispatch,
} from '../../controllers/inventory/vendorController.js';

/**
 * Vendor routes: passportSignIn + acl([3]). Dispatching (and withdrawing a
 * dispatch) needs a live subscription, as the legacy /po/markDispatched and
 * /po/raiseInvoice do; reading the deliveries does not.
 */
const router = express.Router();
const issuedPoGate = hospitalityMiddleware.requireActiveSubscriptionForIssuedPo;

router.get('/vendor/po/:poId/deliveries', ...vendorGuard, getVendorPoDeliveries);
router.post('/vendor/po/:poId/dispatches', ...vendorGuard, issuedPoGate, createDispatch);
router.post('/vendor/po/:poId/dispatches/:id/cancel', ...vendorGuard, issuedPoGate, cancelDispatch);

export default router;
