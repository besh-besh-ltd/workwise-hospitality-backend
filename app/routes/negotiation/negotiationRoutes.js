import { Router } from 'express';
import { acl } from '../../helper/common.js';
import { can } from '../../middleware/auth.js';
import negotiationController from '../../controllers/negotiation/negotiationController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const NegotiationRoutes = Router();

// Create negotiation round
NegotiationRoutes.post(
  '/rounds',
  passportSignIn,
  acl([2, 8, 3]), // Procurement and Top Management and Vendor (same as RFQ routes)
  // can('negotiation.create'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.requireHospitality,
  negotiationController.createRound
);

// Get all rounds for an RFQ
NegotiationRoutes.get(
  '/rounds/:rfq_id',
  passportSignIn,
  acl([2, 8, 3]), // Procurement and Top Management and Vendor
  // can('negotiation.read'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getRounds
);

// Get active round for a product
NegotiationRoutes.get(
  '/rounds/:rfq_id/active',
  passportSignIn,
  acl([2, 8, 3]), // Procurement and Top Management and Vendor
  // can('negotiation.read'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getActiveRound
);

// Get all active rounds for an RFQ
NegotiationRoutes.get(
  '/rounds/:rfq_id/active-all',
  passportSignIn,
  acl([2, 8, 3]), // Procurement and Top Management and Vendor
  // can('negotiation.read'), // Uncomment after running migration: add_negotiation_permissions.sql
  negotiationController.getActiveRounds
);

// Approve a round
NegotiationRoutes.post(
  '/rounds/:id/approve',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  // can('negotiation.approve'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.requireHospitality,
  negotiationController.approveRound
);

// Reject a round
NegotiationRoutes.post(
  '/rounds/:id/reject',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  // can('negotiation.approve'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.requireHospitality,
  negotiationController.rejectRound
);

// Close a round
NegotiationRoutes.post(
  '/rounds/:id/close',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  // can('negotiation.update'), // Uncomment after running migration: add_negotiation_permissions.sql
  hospitalityMiddleware.requireHospitality,
  negotiationController.closeRound
);

// Get quotes for a round
NegotiationRoutes.get(
  '/rounds/:id/quotes',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  // can('negotiation.read'), // Uncomment after running migration: add_negotiation_permissions.sql
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

