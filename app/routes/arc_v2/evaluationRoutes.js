import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import { requireArcPermission } from '../../middleware/arcPermission.js';
import * as evalController from '../../controllers/arc_v2/arcEvaluationController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Per-ARC module permissions, resolved against the ARC's own hotel/department
// (OR logic — any one key grants). The decide/approval endpoints stay
// engine-gated only: policy approvers may hold no module roles.
const TECH_READ  = requireArcPermission(['arc-tech.read', 'arc-tech.evaluate', 'arc.admin']);
const TECH_WRITE = requireArcPermission(['arc-tech.evaluate', 'arc.admin']);
const COMM_READ  = requireArcPermission(['arc-comm.read', 'arc-comm.evaluate', 'arc.admin']);
const COMM_WRITE = requireArcPermission(['arc-comm.evaluate', 'arc.admin']);

// Tech eval setup + responses + scoring + submit.
r.post('/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), TECH_WRITE, evalController.setupTechEval);
r.get( '/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), TECH_READ,  evalController.getTechEvalForItem);
r.post('/tech-eval/response',               passportSignIn, acl([2, 8]), TECH_WRITE, evalController.recordVendorResponse);
r.post('/tech-eval/score',                  passportSignIn, acl([2, 8]), TECH_WRITE, evalController.scoreResponse);
r.post('/:arcId/tech-eval/submit',          passportSignIn, acl([2, 8]), TECH_WRITE, evalController.submitTechEval);

// Tech-eval approval — chain view + approve/reject/amend through the
// central engine (engine validates the caller is the current approver).
r.get( '/:arcId/tech-eval/approval',        passportSignIn, acl([2, 8]), evalController.getTechEvalApproval);
r.post('/:arcId/tech-eval/decide',          passportSignIn, acl([2, 8]), evalController.decideTechEval);

// Commercial eval.
r.get( '/:arcId/comm-eval',                 passportSignIn, acl([2, 8]), COMM_READ,  evalController.getCommEval);
r.post('/:arcId/comm-eval/allocation',      passportSignIn, acl([2, 8]), COMM_WRITE, evalController.saveAllocation);
r.post('/:arcId/comm-eval/finalize',        passportSignIn, acl([2, 8]), COMM_WRITE, evalController.finalizeCommEval);
r.post('/:arcId/comm-eval/send-back',       passportSignIn, acl([2, 8]), COMM_WRITE, evalController.sendBackCommEval);

export default r;
