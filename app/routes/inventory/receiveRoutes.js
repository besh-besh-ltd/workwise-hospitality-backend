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
  guardGrnAttachmentUpload,
} from '../../controllers/inventory/receiveController.js';
import { validateBody } from '../../validations/paramValidation/userValidation.js';
import {
  createGrnSchema,
  updateGrnSchema,
  postGrnSchema,
  reverseGrnSchema,
  grnAttachmentUploadMiddleware,
} from '../../validations/paramValidation/inventoryReceiveValidation.js';
import {
  getGrnPdf,
} from '../../controllers/inventory/documentController.js';

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/receive/awaiting', ...buyerGuard, getAwaitingDeliveries);
router.get('/receive/po/:poId', ...buyerGuard, getReceiveContext);
router.post('/grn', ...buyerGuard, validateBody(createGrnSchema), createGrn);
router.get('/grn', ...buyerGuard, listGrns);
router.get('/grn/:id', ...buyerGuard, getGrn);
router.put('/grn/:id', ...buyerGuard, validateBody(updateGrnSchema), updateGrn);
router.post('/grn/:id/post', ...buyerGuard, validateBody(postGrnSchema), postGrn);
router.delete('/grn/:id', ...buyerGuard, discardGrn);
router.post('/grn/:id/reverse', ...buyerGuard, validateBody(reverseGrnSchema), reverseGrn);
// Authorise (grn.update on the GRN's hotel) BEFORE anything is uploaded.
router.post('/grn/:id/attachments', ...buyerGuard, guardGrnAttachmentUpload, grnAttachmentUploadMiddleware, uploadGrnAttachment);
router.delete('/grn/:id/attachments/:attId', ...buyerGuard, deleteGrnAttachment);
router.get('/grn/:id/pdf', ...buyerGuard, getGrnPdf);

export default router;
