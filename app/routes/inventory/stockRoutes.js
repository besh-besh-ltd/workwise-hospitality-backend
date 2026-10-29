import express from 'express';
import { buyerGuard } from './guards.js';
import {
  getStock,
  getStockItem,
  getStockLedger,
  postOut,
  listOut,
  getOut,
  createAdjustment,
  listAdjustments,
  getAdjustment,
  approveAdjustment,
  rejectAdjustment,
  getInventoryOverview,
} from '../../controllers/inventory/stockController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/stock', ...buyerGuard, getStock);
router.get('/stock/:hotelId/items/:invItemId', ...buyerGuard, getStockItem);
router.get('/stock/:hotelId/items/:invItemId/ledger', ...buyerGuard, getStockLedger);
router.post('/out', ...buyerGuard, postOut);
router.get('/out', ...buyerGuard, listOut);
router.get('/out/:id', ...buyerGuard, getOut);
router.post('/adjustments', ...buyerGuard, createAdjustment);
router.get('/adjustments', ...buyerGuard, listAdjustments);
router.get('/adjustments/:id', ...buyerGuard, getAdjustment);
router.post('/adjustments/:id/approve', ...buyerGuard, approveAdjustment);
router.post('/adjustments/:id/reject', ...buyerGuard, rejectAdjustment);
router.get('/overview', ...buyerGuard, getInventoryOverview);

export default router;
