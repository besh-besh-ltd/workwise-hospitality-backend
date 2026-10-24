import express from 'express';
import { vendorGuard } from './guards.js';
import {
  getVendorPoDeliveries,
  createDispatch,
  cancelDispatch,
} from '../../controllers/inventory/vendorController.js';

/** Vendor routes: passportSignIn + acl([3]). */
const router = express.Router();

router.get('/vendor/po/:poId/deliveries', ...vendorGuard, getVendorPoDeliveries);
router.post('/vendor/po/:poId/dispatches', ...vendorGuard, createDispatch);
router.post('/vendor/po/:poId/dispatches/:id/cancel', ...vendorGuard, cancelDispatch);

export default router;
