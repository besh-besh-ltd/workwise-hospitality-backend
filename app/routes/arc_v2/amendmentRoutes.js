import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as amendmentController from '../../controllers/arc_v2/arcAmendmentController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Listing — buyer roles browse via the active page's Amendments tab.
r.get('/',                      passportSignIn, acl([2, 8]),  amendmentController.listAmendments);

// Request — vendor-initiated. The buyer cannot create amendments; they
// only review what vendors propose.
r.post('/request',              passportSignIn, acl([3]),     amendmentController.requestAmendment);

// Review — buyer (or whoever is the current step's approver) approves /
// rejects / edits-then-approves. Drives the locked approval chain.
r.post('/:id/review',           passportSignIn, acl([2, 8]),  amendmentController.reviewAmendment);

// Legacy aliases — still respond with a redirect-style 501.
r.post('/:amendmentId/approve', passportSignIn, acl([2, 8]),  amendmentController.approveAmendment);
r.post('/:amendmentId/reject',  passportSignIn, acl([2, 8]),  amendmentController.rejectAmendment);

export default r;
