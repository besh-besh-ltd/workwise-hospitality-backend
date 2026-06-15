import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as vendorController from '../../controllers/arc_v2/arcVendorController.js';
import * as contractController from '../../controllers/arc_v2/arcContractController.js';
import * as amendmentController from '../../controllers/arc_v2/arcAmendmentController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Vendor-portal endpoints. Vendor role = user_type 3 per existing convention.
r.get( '/dashboard',                      passportSignIn, acl([3]), vendorController.getVendorDashboard);
r.get( '/requests',                       passportSignIn, acl([3]), vendorController.listRequests);
r.get( '/requests/:arcId',                passportSignIn, acl([3]), vendorController.getRequestDetail);
r.post('/quote/draft',                    passportSignIn, acl([3]), vendorController.saveQuoteDraft);
r.post('/quote/submit',                   passportSignIn, acl([3]), vendorController.submitQuote);
r.post('/quote/withdraw',                 passportSignIn, acl([3]), vendorController.withdrawQuote);

// Amendments — vendor's own requests across every contract (My Amendments).
r.get( '/amendments',                     passportSignIn, acl([3]), amendmentController.listVendorAmendments);

// Contract acceptance + active list.
r.get( '/pending-acceptance',                       passportSignIn, acl([3]), contractController.getPendingAcceptance);
r.get( '/active',                                   passportSignIn, acl([3]), contractController.getVendorActiveContracts);
r.get( '/contracts/:contractId',                    passportSignIn, acl([3]), contractController.getContractDetail);
r.post('/contracts/:contractId/otp/request',        passportSignIn, acl([3]), contractController.requestOtp);
r.post('/contracts/:contractId/otp/verify',         passportSignIn, acl([3]), contractController.verifyOtp);
r.post('/contracts/:contractId/clarification',      passportSignIn, acl([3]), contractController.requestClarification);
r.post('/contracts/:contractId/decline',            passportSignIn, acl([3]), contractController.declineContract);

export default r;
