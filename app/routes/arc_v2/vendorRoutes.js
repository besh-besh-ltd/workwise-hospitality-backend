import { Router } from 'express';
import multer from 'multer';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as vendorController from '../../controllers/arc_v2/arcVendorController.js';
import * as contractController from '../../controllers/arc_v2/arcContractController.js';
import * as amendmentController from '../../controllers/arc_v2/arcAmendmentController.js';
import * as addendumController from '../../controllers/arc_v2/arcAddendumController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Tech-evidence upload: buffer in memory, validate + push to S3 in the
// controller (15 MB hard cap; finer MIME/extension checks happen there).
const techEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Vendor-portal endpoints. Vendor role = user_type 3 per existing convention.
r.get( '/dashboard',                      passportSignIn, acl([3]), vendorController.getVendorDashboard);
r.get( '/requests',                       passportSignIn, acl([3]), vendorController.listRequests);
r.get( '/requests/:arcId',                passportSignIn, acl([3]), vendorController.getRequestDetail);
r.get( '/requests/:arcId/lifecycle',      passportSignIn, acl([3]), vendorController.getRequestLifecycle);
r.post('/quote/accept-terms',             passportSignIn, acl([3]), vendorController.acceptTerms);
// Phase 2 — engine-driven stateless preview (qty server-derived; never persists).
r.post('/quote/preview',                  passportSignIn, acl([3]), vendorController.previewQuote);
r.post('/quote/draft',                    passportSignIn, acl([3]), vendorController.saveQuoteDraft);
r.post('/quote/submit',                   passportSignIn, acl([3]), vendorController.submitQuote);
r.post('/quote/withdraw',                 passportSignIn, acl([3]), vendorController.withdrawQuote);

// Technical envelope (two-envelope flow) — vendor self-submits clause
// responses + evidence, sealed before the commercial quote (hard two-step).
// Every handler scopes strictly to req.user.id and verifies invitation.
r.get( '/requests/:arcId/tech-clauses',        passportSignIn, acl([3]), vendorController.getTechClausesForVendor);
r.post('/tech-envelope/draft',                 passportSignIn, acl([3]), vendorController.saveTechEnvelopeDraft);
r.post('/tech-envelope/clause/:clauseId/file', passportSignIn, acl([3]), techEvidenceUpload.single('file'), vendorController.uploadTechEvidence);
r.get( '/tech-envelope/file/:fileId',          passportSignIn, acl([3]), vendorController.getOwnTechEvidence);
r.delete('/tech-envelope/file/:fileId',        passportSignIn, acl([3]), vendorController.deleteTechEvidence);
r.post('/tech-envelope/submit',                passportSignIn, acl([3]), vendorController.submitTechEnvelope);

// Amendments — vendor's own requests across every contract (My Amendments).
r.get( '/amendments',                     passportSignIn, acl([3]), amendmentController.listVendorAmendments);

// Addendum re-signing — vendor signs the approved amendment's addendum before
// its effects bind (sign-to-activate gate).
r.get( '/addendums',                      passportSignIn, acl([3]), addendumController.listVendorAddendums);
r.post('/addendums/:id/otp/request',      passportSignIn, acl([3]), addendumController.requestAddendumOtp);
r.post('/addendums/:id/otp/verify',       passportSignIn, acl([3]), addendumController.verifyAddendumOtp);
r.post('/addendums/:id/decline',          passportSignIn, acl([3]), addendumController.declineAddendum);

// Contract acceptance + active list.
r.get( '/pending-acceptance',                       passportSignIn, acl([3]), contractController.getPendingAcceptance);
r.get( '/active',                                   passportSignIn, acl([3]), contractController.getVendorActiveContracts);
r.get( '/contracts/:contractId',                    passportSignIn, acl([3]), contractController.getContractDetail);
r.post('/contracts/:contractId/otp/request',        passportSignIn, acl([3]), contractController.requestOtp);
r.post('/contracts/:contractId/otp/verify',         passportSignIn, acl([3]), contractController.verifyOtp);
r.post('/contracts/:contractId/clarification',      passportSignIn, acl([3]), contractController.requestClarification);
r.post('/contracts/:contractId/decline',            passportSignIn, acl([3]), contractController.declineContract);

export default r;
