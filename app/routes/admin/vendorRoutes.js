import { Router } from 'express';

import vendorController from '../../controllers/admin/vendorController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/vendorValidation.js';
import { validateDbBody } from '../../validations/dbValidation/vendorDbValidation.js';

import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const vendorRoutes = Router();

vendorRoutes.get('/vendor-list', passportSignIn, vendorController.vendorList);
vendorRoutes.post(
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
vendorRoutes.get(
  '/vendor-edit-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.vendor_edit_details
);
vendorRoutes.get(
  '/vendor-rfq-list/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.vendor_rfq_list
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
);

vendorRoutes.get(
  '/reject-reason-dropdown-list',
  passportSignIn,
  vendorController.rejectReasonDropdownList
);

vendorRoutes.get(
  '/vendor-dropdown-list',
  passportSignIn,
  vendorController.vendorDropdownList
);

export default vendorRoutes;
