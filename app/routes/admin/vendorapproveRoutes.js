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

/* vendorRoutes.post(
  '/create-vendor',
  passportSignIn,
  schema_posts.add_vendor,
  validateDbBody.vendor_exists,
  vendorController.addVendor
);
vendorRoutes.get(
  '/vendor-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.vendorDetails
);

vendorRoutes.delete(
  '/delete-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.deleteVendor
);
vendorRoutes.put(
  '/block-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.vendor_block_check,
  vendorController.blockVendor
);
vendorRoutes.put(
  '/update-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  schema_posts.add_vendor,
  validateDbBody.vendor_id_exists,
  validateDbBody.vendor_email_mobile_exists,
  vendorController.updateVendor
);
vendorRoutes.put(
  '/accept-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.vendor_approve_check,
  vendorController.approveVendor
); */

export default vendorapproveRoutes;
