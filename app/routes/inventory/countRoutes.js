import express from 'express';
import { buyerGuard } from './guards.js';
import {
  startCount,
  listCounts,
  getCount,
  saveCountLines,
  submitCount,
  approveCount,
  cancelCount,
} from '../../controllers/inventory/countController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.post('/counts', ...buyerGuard, startCount);
router.get('/counts', ...buyerGuard, listCounts);
router.get('/counts/:id', ...buyerGuard, getCount);
router.put('/counts/:id/lines', ...buyerGuard, saveCountLines);
router.post('/counts/:id/submit', ...buyerGuard, submitCount);
router.post('/counts/:id/approve', ...buyerGuard, approveCount);
router.post('/counts/:id/cancel', ...buyerGuard, cancelCount);

export default router;
