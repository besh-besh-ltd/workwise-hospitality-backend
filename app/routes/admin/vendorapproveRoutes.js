import { Router } from 'express';

// import vendorController from '../../controllers/admin/vendorController.js';
import vendorapproveController from '../../controllers/admin/vendorapproveController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/vendorValidation.js';
import { validateDbBody } from '../../validations/dbValidation/vendorDbValidation.js';

import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const vendorapproveRoutes = Router();

vendorapproveRoutes.get(
  '/vendor-approve-list',
  passportSignIn,
  vendorapproveController.vendorApproveList
);
vendorapproveRoutes.post(
  '/add-vendor-approve',
  passportSignIn,
  schema_posts.add_vendor_approve,
  validateDbBody.vendor_approve_exists,
  vendorapproveController.addVendorApprove
);
vendorapproveRoutes.get(
  '/all-vendor-approve-list',
  passportSignIn,
  vendorapproveController.allVendorApproveList
);
vendorapproveRoutes.get(
  '/vendor-approve-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_approve_id_exists,
  vendorapproveController.vendorApproveDetails
);

vendorapproveRoutes.put(
  '/update-vendor-approve/:id',
  passportSignIn,
  validateParam(schemas.id),
  // validateDbBody.vendor_approve_id_exists,
  schema_posts.add_vendor_approve,
  validateDbBody.vendor_approve_update_exists,

  vendorapproveController.updateVendorApprove
);


export default vendorapproveRoutes;
