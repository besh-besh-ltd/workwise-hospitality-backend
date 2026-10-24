import express from 'express';
import { receiveTokenAuth } from '../../middleware/receiveTokenAuth.js';
import {
  getTokenReceiveContext,
  postTokenGrn,
  uploadTokenGrnAttachment,
} from '../../controllers/inventory/tokenController.js';

/** Mounted at /api/v1/inventory/token. Auth is the X-Receive-Token header only (B6 hardens receiveTokenAuth). */
const router = express.Router();

router.get('/receive-context', receiveTokenAuth, getTokenReceiveContext);
router.post('/grn', receiveTokenAuth, postTokenGrn);
router.post('/grn/:id/attachments', receiveTokenAuth, uploadTokenGrnAttachment);

export default router;
