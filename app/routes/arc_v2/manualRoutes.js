import { Router } from 'express';
import multer from 'multer';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as manualController from '../../controllers/arc_v2/arcManualController.js';

/**
 * ARC v2 — Manual / backfill data-entry routes (spec §6).
 *
 * Mounted at /v1/arc-v2/manual. Every route: passportSignIn + acl([2, 8])
 * (buyer + super-admin). All tenant scope is derived from req.user inside the
 * controller (NEVER from the body); reload-and-verify on every write.
 */
const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Signed-contract PDF upload: buffer in memory, validate + push to S3 in the
// controller (20 MB hard cap per spec §6.4; MIME/extension checks happen there).
const contractDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// §6.1 — override-toggle vendor list (all active vendors + subscribed flag).
r.get('/all-vendors', passportSignIn, acl([2, 8]), manualController.listAllVendors);

// §6.2 — draft create / patch / resume.
r.post('/draft', passportSignIn, acl([2, 8]), manualController.createDraft);
r.patch('/draft/:id', passportSignIn, acl([2, 8]), manualController.patchDraft);
r.get('/draft/:id', passportSignIn, acl([2, 8]), manualController.getDraft);

// §6.3 — stage-by-stage section autosave.
r.put('/draft/:id/section/:section', passportSignIn, acl([2, 8]), manualController.saveSection);

// §6.4 — manual signed-PDF upload (S4/S5).
r.post('/draft/:id/contract/:vendorId/document',
  passportSignIn, acl([2, 8]), contractDocUpload.single('file'), manualController.uploadContractDocument);

// §6.5 — atomic finalize / backfill.
r.post('/draft/:id/finalize', passportSignIn, acl([2, 8]), manualController.finalize);

export default r;
