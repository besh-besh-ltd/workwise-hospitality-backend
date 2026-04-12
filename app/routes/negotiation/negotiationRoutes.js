import { Router } from 'express';
import { acl } from '../../helper/common.js';
import { can } from '../../middleware/auth.js';
import negotiationController from '../../controllers/negotiation/negotiationController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';
import noLogin from '../../middleware/noLogin.js';

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

// Get all rounds for an RFQ (supports vendor token-based access from email)
NegotiationRoutes.get(
  '/rounds/:rfq_id',
  noLogin.vendorTokenOrJwt,
  negotiationController.getRounds
);

// Get active round for a product (supports vendor token-based access from email)
NegotiationRoutes.get(
  '/rounds/:rfq_id/active',
  noLogin.vendorTokenOrJwt,
  negotiationController.getActiveRound
);

// Get all active rounds for an RFQ (supports vendor token-based access from email)
NegotiationRoutes.get(
  '/rounds/:rfq_id/active-all',
  noLogin.vendorTokenOrJwt,
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
  hospitalityMiddleware.requireActiveSubscription,
  negotiationController.submitVendorQuote
);

// Get vendor's negotiation status for a specific product (supports vendor token-based access)
NegotiationRoutes.get(
  '/rounds/:rfq_id/product/:rfq_product_id/vendor-status',
  noLogin.vendorTokenOrJwt,
  negotiationController.getVendorNegotiationStatus
);

// Get all vendor's negotiation statuses for an RFQ (supports vendor token-based access)
NegotiationRoutes.get(
  '/rounds/:rfq_id/vendor-status',
  noLogin.vendorTokenOrJwt,
  negotiationController.getAllVendorNegotiationStatus
);

// ============= NEGOTIATION QUOTES APPROVAL =============

// Submit selected negotiation quotes for approval
NegotiationRoutes.post(
  '/quotes/submit-for-approval',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.requireHospitality,
  negotiationController.submitQuotesForApproval
);

// Get quote approval status for a product
NegotiationRoutes.get(
  '/quotes/:rfq_product_id/approval-status',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.checkHospitality(false),
  negotiationController.getQuoteApprovalStatus
);

// Approve negotiation quotes
NegotiationRoutes.post(
  '/quotes/:rfq_product_id/approve',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.requireHospitality,
  negotiationController.approveQuotes
);

// Reject negotiation quotes
NegotiationRoutes.post(
  '/quotes/:rfq_product_id/reject',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.requireHospitality,
  negotiationController.rejectQuotes
);

export default NegotiationRoutes;

