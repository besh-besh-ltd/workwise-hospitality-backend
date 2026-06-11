import { Router } from 'express';
import passport from '../../middleware/passport.js';
import { acl } from '../../helper/common.js';
import * as evalController from '../../controllers/arc_v2/arcEvaluationController.js';

const r = Router();
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

// Tech eval setup + responses + scoring + submit.
r.post('/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), evalController.setupTechEval);
r.get( '/items/:itemId/tech-eval',          passportSignIn, acl([2, 8]), evalController.getTechEvalForItem);
r.post('/tech-eval/response',               passportSignIn, acl([2, 8]), evalController.recordVendorResponse);
r.post('/tech-eval/score',                  passportSignIn, acl([2, 8]), evalController.scoreResponse);
r.post('/:arcId/tech-eval/submit',          passportSignIn, acl([2, 8]), evalController.submitTechEval);

// Commercial eval.
r.get( '/:arcId/comm-eval',                 passportSignIn, acl([2, 8]), evalController.getCommEval);
r.post('/:arcId/comm-eval/allocation',      passportSignIn, acl([2, 8]), evalController.saveAllocation);
r.post('/:arcId/comm-eval/finalize',        passportSignIn, acl([2, 8]), evalController.finalizeCommEval);
r.post('/:arcId/comm-eval/send-back',       passportSignIn, acl([2, 8]), evalController.sendBackCommEval);

export default r;
