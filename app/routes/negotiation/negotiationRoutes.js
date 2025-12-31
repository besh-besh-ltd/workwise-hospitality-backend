import { Router } from 'express';
import { acl } from '../../helper/common.js';
import negotiationController from '../../controllers/negotiation/negotiationController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const NegotiationRoutes = Router();

// Create negotiation round
NegotiationRoutes.post(
  '/rounds',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  negotiationController.createRound
);

// Get all rounds for an RFQ
NegotiationRoutes.get(
  '/rounds/:rfq_id',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getRounds
);

// Get active round for an RFQ
NegotiationRoutes.get(
  '/rounds/:rfq_id/active',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getActiveRound
);

// Approve a round
NegotiationRoutes.post(
  '/rounds/:id/approve',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  negotiationController.approveRound
);

// Reject a round
NegotiationRoutes.post(
  '/rounds/:id/reject',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  negotiationController.rejectRound
);

// Close a round
NegotiationRoutes.post(
  '/rounds/:id/close',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.requireHospitality,
  negotiationController.closeRound
);

// Get quotes for a round
NegotiationRoutes.get(
  '/rounds/:id/quotes',
  passportSignIn,
  acl([7]),
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getRoundQuotes
);

// Vendor submits quote for a round
NegotiationRoutes.post(
  '/rounds/:id/quote',
  passportSignIn,
  negotiationController.submitVendorQuote
);

export default NegotiationRoutes;

