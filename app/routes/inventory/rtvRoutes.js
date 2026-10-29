import express from 'express';
import { buyerGuard } from './guards.js';
import {
  createRtv,
  getRtv,
  dispatchRtv,
  closeRtv,
  cancelRtv,
} from '../../controllers/inventory/rtvController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.post('/rtv', ...buyerGuard, createRtv);
router.get('/rtv/:id', ...buyerGuard, getRtv);
router.post('/rtv/:id/dispatch', ...buyerGuard, dispatchRtv);
router.post('/rtv/:id/close', ...buyerGuard, closeRtv);
router.post('/rtv/:id/cancel', ...buyerGuard, cancelRtv);

export default router;
