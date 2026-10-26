import express from 'express';
import { buyerGuard } from './guards.js';
import {
  resolveScan,
  printItemLabels,
  printGrnLabels,
  resolveShortLink,
} from '../../controllers/inventory/scanController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/scan/resolve', ...buyerGuard, resolveScan);
router.post('/labels/items', ...buyerGuard, printItemLabels);
router.post('/labels/grn/:grnId', ...buyerGuard, printGrnLabels);
router.get('/s/resolve', ...buyerGuard, resolveShortLink);

export default router;
