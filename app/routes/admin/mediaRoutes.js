import { Router } from 'express';

// import vendorController from '../../controllers/admin/vendorController.js';
import mediaController from '../../controllers/admin/mediaController.js';

import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/mediaValidation.js';
// import { validateDbBody } from '../../validations/dbValidation/vendorDbValidation.js';
import { validateDbBody } from '../../validations/dbValidation/mediaDbValidation.js';

import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const mediaRoutes = Router();

mediaRoutes.get('/media-list', passportSignIn, mediaController.mediaList);
mediaRoutes.post(
  '/upload-file',
  passportSignIn,
  schema_posts.upload_user_document,
  mediaController.upload_documents
);
mediaRoutes.get(
  '/media-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.media_id_exists,
  mediaController.mediaDetails
);
/* mediaRoutes.put(
  '/update-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  schema_posts.add_vendor,
  validateDbBody.media_id_exists,
  mediaController.updateVendor
); */
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

export default mediaRoutes;
