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

export default mediaRoutes;
