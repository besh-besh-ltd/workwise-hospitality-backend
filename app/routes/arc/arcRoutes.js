import { Router } from 'express';
import { acl } from '../../helper/common.js';
import arcController from '../../controllers/arc/arcController.js';
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

export default ArcRoutes;

