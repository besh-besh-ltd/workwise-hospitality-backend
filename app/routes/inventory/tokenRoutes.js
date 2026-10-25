import express from 'express';
import { receiveTokenAuth } from '../../middleware/receiveTokenAuth.js';
import { receiveTokenRateLimit } from '../../middleware/receiveTokenRateLimit.js';
import {
  getTokenReceiveContext,
  postTokenGrn,
  uploadTokenGrnAttachment,
  guardTokenGrnAttachmentUpload,
} from '../../controllers/inventory/tokenController.js';
import { validateBody } from '../../validations/paramValidation/userValidation.js';
import { tokenGrnSchema } from '../../validations/paramValidation/inventoryTokenValidation.js';
import { grnAttachmentUploadMiddleware } from '../../validations/paramValidation/inventoryReceiveValidation.js';

/**
 * Mounted at /api/v1/inventory/token. Auth is the X-Receive-Token header only.
 * Rate limit (60 per 10 minutes per token) first, so a capped link costs no
 * query; then the token; then validation. Attachments are authorised (a GRN
 * this link posted) BEFORE the upload middleware stores anything.
 */
const router = express.Router();
const tokenGuard = [receiveTokenRateLimit, receiveTokenAuth];

router.get('/receive-context', ...tokenGuard, getTokenReceiveContext);
router.post('/grn', ...tokenGuard, validateBody(tokenGrnSchema), postTokenGrn);
router.post(
  '/grn/:id/attachments',
  ...tokenGuard,
  guardTokenGrnAttachmentUpload,
  grnAttachmentUploadMiddleware,
  uploadTokenGrnAttachment
);

export default router;
