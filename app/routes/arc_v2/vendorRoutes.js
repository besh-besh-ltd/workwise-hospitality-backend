import { refuseGuestSessionMiddleware } from '../../helper/guestSession.js';
import { Router } from 'express';
import multer from 'multer';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import * as vendorController from '../../controllers/arc_v2/arcVendorController.js';
import * as negotiationController from '../../controllers/arc_v2/arcNegotiationController.js';
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

// Every vendor ARC endpoint, read or write, needs the vendor's own sign-in. An emailed-link
// guest session (minted from an RFQ email, for that RFQ only) is refused here, before any
// route runs, with 403 GUEST_SESSION. No ARC email or notification link carries a guest
// token (Tasks 23, 25, 26). Authenticated once for the whole router.
r.use(passportSignIn, refuseGuestSessionMiddleware);

// Vendor-portal endpoints. Vendor role = user_type 3 per existing convention.
r.get( '/dashboard',                      acl([3]), vendorController.getVendorDashboard);
r.get( '/requests',                       acl([3]), vendorController.listRequests);
r.get( '/requests/:arcId',                acl([3]), vendorController.getRequestDetail);
r.get( '/requests/:arcId/lifecycle',      acl([3]), vendorController.getRequestLifecycle);
r.post('/quote/accept-terms',             acl([3]), vendorController.acceptTerms);
// Phase 2 — engine-driven stateless preview (qty server-derived; never persists).
r.post('/quote/preview',                  acl([3]), vendorController.previewQuote);
r.post('/quote/draft',                    acl([3]), vendorController.saveQuoteDraft);
r.post('/quote/submit',                   acl([3]), hospitalityMiddleware.requireNetworkEntityCanOperate, vendorController.submitQuote);
r.post('/quote/withdraw',                 acl([3]), vendorController.withdrawQuote);
// Download the vendor's OWN submitted quote as a comprehensive tabular PDF
// (streamed; vendorId derived from req.user, never the client).
r.get( '/quote/:arcId/pdf',               acl([3]), vendorController.downloadQuotePdf);
// Version history of the vendor's OWN quote submissions (newest-first, vendor-
// isolated — vendorId from req.user, never the client).
r.get( '/quote/:arcId/history',           acl([3]), vendorController.getQuoteHistory);

// Technical envelope (two-envelope flow) — vendor self-submits clause
// responses + evidence, sealed before the commercial quote (hard two-step).
// Every handler scopes strictly to req.user.id and verifies invitation.
r.get( '/requests/:arcId/tech-clauses',        acl([3]), vendorController.getTechClausesForVendor);
r.post('/tech-envelope/draft',                 acl([3]), vendorController.saveTechEnvelopeDraft);
r.post('/tech-envelope/clause/:clauseId/file', acl([3]), techEvidenceUpload.single('file'), vendorController.uploadTechEvidence);
r.get( '/tech-envelope/file/:fileId',          acl([3]), vendorController.getOwnTechEvidence);
r.delete('/tech-envelope/file/:fileId',        acl([3]), vendorController.deleteTechEvidence);
// The BUYER's reference document for a clause — read-only, gated on this
// vendor being invited to the owning ARC (not on owning the file).
r.get( '/tech-envelope/clause-file/:fileId',   acl([3]), vendorController.getClauseReference);
r.post('/tech-envelope/submit',                acl([3]), hospitalityMiddleware.requireNetworkEntityCanOperate, vendorController.submitTechEnvelope);

// Universal (ARC-wide) technical envelope — the vendor's clause responses +
// evidence for the SEPARATE universal configurator. Universal clauses are
// returned inside the existing GET /requests/:arcId/tech-clauses response
// (a `universal` key), and the seal rides the shared /tech-envelope/submit —
// so only draft/upload/get/delete are needed here. Same acl([3]) + req.user
// isolation as the item routes.
r.post('/universal-tech-envelope/draft',                 acl([3]), vendorController.saveUniversalTechEnvelopeDraft);
r.post('/universal-tech-envelope/clause/:clauseId/file', acl([3]), techEvidenceUpload.single('file'), vendorController.uploadUniversalTechEvidence);
r.get( '/universal-tech-envelope/file/:fileId',          acl([3]), vendorController.getOwnUniversalTechEvidence);
r.delete('/universal-tech-envelope/file/:fileId',        acl([3]), vendorController.deleteUniversalTechEvidence);
r.get( '/universal-tech-envelope/clause-file/:fileId',   acl([3]), vendorController.getUniversalClauseReference);

// Amendments — vendor's own requests across every contract (My Amendments).
r.get( '/amendments',                     acl([3]), amendmentController.listVendorAmendments);

// Addendum re-signing — vendor signs the approved amendment's addendum before
// its effects bind (sign-to-activate gate).
r.get( '/addendums',                      acl([3]), addendumController.listVendorAddendums);
r.post('/addendums/:id/otp/request',      acl([3]), addendumController.requestAddendumOtp);
r.post('/addendums/:id/otp/verify',       acl([3]), addendumController.verifyAddendumOtp);
r.post('/addendums/:id/decline',          acl([3]), addendumController.declineAddendum);

// ARC Negotiation (vendor side).
r.get( '/requests/:arcId/negotiation',             acl([3]), negotiationController.listVendorRounds);
r.post('/negotiation/rounds/:roundId/quote',       acl([3]), hospitalityMiddleware.requireNetworkEntityCanOperate, negotiationController.submitVendorQuote);

// Contract acceptance + active list.
r.get( '/pending-acceptance',                       acl([3]), contractController.getPendingAcceptance);
r.get( '/active',                                   acl([3]), contractController.getVendorActiveContracts);
r.get( '/contracts/:contractId',                    acl([3]), contractController.getContractDetail);
r.post('/contracts/:contractId/otp/request',        acl([3]), contractController.requestOtp);
r.post('/contracts/:contractId/otp/verify',         acl([3]), contractController.verifyOtp);
r.post('/contracts/:contractId/clarification',      acl([3]), contractController.requestClarification);
r.post('/contracts/:contractId/decline',            acl([3]), contractController.declineContract);

export default r;
