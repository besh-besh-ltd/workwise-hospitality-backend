import express from 'express';
import { buyerGuard } from './guards.js';
import {
  getAwaitingDeliveries,
  getReceiveContext,
  createGrn,
  listGrns,
  getGrn,
  updateGrn,
  postGrn,
  discardGrn,
  reverseGrn,
  uploadGrnAttachment,
  deleteGrnAttachment,
} from '../../controllers/inventory/receiveController.js';
import {
  getGrnPdf,
} from '../../controllers/inventory/documentController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/receive/awaiting', ...buyerGuard, getAwaitingDeliveries);
router.get('/receive/po/:poId', ...buyerGuard, getReceiveContext);
router.post('/grn', ...buyerGuard, createGrn);
router.get('/grn', ...buyerGuard, listGrns);
router.get('/grn/:id', ...buyerGuard, getGrn);
router.put('/grn/:id', ...buyerGuard, updateGrn);
router.post('/grn/:id/post', ...buyerGuard, postGrn);
router.delete('/grn/:id', ...buyerGuard, discardGrn);
router.post('/grn/:id/reverse', ...buyerGuard, reverseGrn);
router.post('/grn/:id/attachments', ...buyerGuard, uploadGrnAttachment);
router.delete('/grn/:id/attachments/:attId', ...buyerGuard, deleteGrnAttachment);
router.get('/grn/:id/pdf', ...buyerGuard, getGrnPdf);

export default router;
