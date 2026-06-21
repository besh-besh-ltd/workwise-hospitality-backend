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

// Tech eval setup + scoring + submit. The buyer-records-response path
// (POST /tech-eval/response) was REMOVED — vendors self-author responses via
// the vendor portal (two-envelope flow); the buyer ONLY scores them.
r.post('/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), TECH_WRITE, evalController.setupTechEval);
r.get( '/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), TECH_READ,  evalController.getTechEvalForItem);
r.post('/tech-eval/score',                  passportSignIn, acl([2, 8]), TECH_WRITE, evalController.scoreResponse);
r.post('/:arcId/tech-eval/submit',          passportSignIn, acl([2, 8]), TECH_WRITE, evalController.submitTechEval);
// Evaluator-side evidence file proxy — ownership/permission-checked stream of
// a vendor's uploaded evidence (no raw public S3 URL). TECH_READ gates it.
r.get( '/tech-eval/evidence/:fileId',       passportSignIn, acl([2, 8]), TECH_READ,  evalController.getTechEvidenceFile);

// Tech-eval approval — chain view + approve/reject/amend through the
// central engine (engine validates the caller is the current approver).
r.get( '/:arcId/tech-eval/approval',        passportSignIn, acl([2, 8]), evalController.getTechEvalApproval);
r.post('/:arcId/tech-eval/decide',          passportSignIn, acl([2, 8]), evalController.decideTechEval);

// Commercial eval.
r.get( '/:arcId/comm-eval',                 passportSignIn, acl([2, 8]), COMM_READ,  evalController.getCommEval);
r.post('/:arcId/comm-eval/allocation',      passportSignIn, acl([2, 8]), COMM_WRITE, evalController.saveAllocation);
r.post('/:arcId/comm-eval/finalize',        passportSignIn, acl([2, 8]), COMM_WRITE, evalController.finalizeCommEval);
r.post('/:arcId/comm-eval/send-back',       passportSignIn, acl([2, 8]), COMM_WRITE, evalController.sendBackCommEval);

// Vendor-clarification resolution — scoped field revise / uphold.
r.post('/:arcId/comm-eval/clarification/:clarificationId/revise', passportSignIn, acl([2, 8]), COMM_WRITE, evalController.reviseClarification);
r.post('/:arcId/comm-eval/clarification/:clarificationId/uphold', passportSignIn, acl([2, 8]), COMM_WRITE, evalController.upholdClarification);

export default r;
