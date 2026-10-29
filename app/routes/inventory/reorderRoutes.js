import express from 'express';
import { buyerGuard } from './guards.js';
import {
  getReorder,
  createReorderMrDraft,
} from '../../controllers/inventory/reorderController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/reorder', ...buyerGuard, getReorder);
router.post('/reorder/mr-draft', ...buyerGuard, createReorderMrDraft);

export default router;
