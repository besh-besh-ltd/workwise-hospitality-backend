import { Router } from 'express';
import { acl } from '../../helper/common.js';
import arcController from '../../controllers/arc/arcController.js';
import arcReleaseController from '../../controllers/arc/arcReleaseController.js';
import vendorArcController from '../../controllers/arc/vendorArcController.js';
import hospitalityMiddleware from '../../middleware/hospitality.js';
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const ArcRoutes = Router();

// Get list of RFQs for ARC Committee
ArcRoutes.get(
  '/rfqs',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.checkHospitality(false),
  arcController.getRfqList
);

// Get full tender lifecycle data
ArcRoutes.get(
  '/tender/:rfq_id',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.checkHospitality(false),
  arcController.getTenderLifecycle
);

// Perform approval action (approve/reject/send to)
ArcRoutes.post(
  '/tender/:rfq_id/action',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.requireHospitality,
  arcController.performAction
);

// Get ARC document URL
ArcRoutes.get(
  '/document/:approval_instance_id',
  passportSignIn,
  acl([2, 8]), // Procurement and Top Management
  hospitalityMiddleware.checkHospitality(false),
  arcController.getArcDocument
);

// Phase 7 — ARC Release / Direct-PO flow
// Eligible vendors for a (hotel, product_variant) under any active ARC.
ArcRoutes.get(
  '/release/eligible-vendors',
  passportSignIn,
  acl([2, 8]),
  hospitalityMiddleware.checkHospitality(false),
  arcReleaseController.getEligibleVendors
);

// Create a release (call-off) and draft the Contracted PO.
ArcRoutes.post(
  '/release',
  passportSignIn,
  acl([2, 8]),
  hospitalityMiddleware.requireHospitality,
  arcReleaseController.createRelease
);

// Read a release.
ArcRoutes.get(
  '/release/:id',
  passportSignIn,
  acl([2, 8]),
  hospitalityMiddleware.checkHospitality(false),
  arcReleaseController.getRelease
);

// Phase 5 — Vendor-side ARC dashboard. Each handler scopes the read to
// req.user.id so a vendor can only see their own contracts. acl([3])
// blocks buyers/admins; the vendor user_type is the only authorised
// role here.
ArcRoutes.get('/vendor/list', passportSignIn, acl([3]), vendorArcController.list);
ArcRoutes.get('/vendor/:arc_id', passportSignIn, acl([3]), vendorArcController.detail);
ArcRoutes.get('/vendor/:arc_id/document', passportSignIn, acl([3]), vendorArcController.document);

export default ArcRoutes;

