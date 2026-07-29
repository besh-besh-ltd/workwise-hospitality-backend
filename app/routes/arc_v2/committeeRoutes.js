import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as committeeController from '../../controllers/arc_v2/arcCommitteeController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Committee view — used by the buyer-side committee dashboard.
r.get('/:arcId', passportSignIn, acl([2, 8]), committeeController.getCommitteeView);

// Committee decision — approve / send-back through the central engine.
// executeApprovalAction validates the caller is the current pending approver
// and dispatches handleArcCommitteeApproval / Rejection on terminal states.
r.post('/:arcId/decide', passportSignIn, acl([2, 8]), committeeController.decideCommittee);

export default r;
