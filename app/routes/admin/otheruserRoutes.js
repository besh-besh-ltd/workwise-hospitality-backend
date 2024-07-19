import { Router } from 'express';

// import buyerController from '../../controllers/admin/buyerController.js';
import otheruserController from '../../controllers/admin/otherUserController.js';

// import { validateDbBody } from '../../validations/dbValidation/buyerDbValidation.js';
import { validateDbBody } from '../../validations/dbValidation/otherUserDbValidation.js';

/* import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/buyerValidation.js'; */
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/otherUserValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const otheruserRoutes = Router();

otheruserRoutes.get(
  '/other-user-list',
  passportSignIn,
  otheruserController.otheruserList
);
otheruserRoutes.post(
  '/create-other-user',
  passportSignIn,
  schema_posts.add_other_user,
  validateDbBody.other_user_exists,
  otheruserController.addOtherUser
);
otheruserRoutes.get(
  '/other-user-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.other_user_id_exists,
  otheruserController.otherUserDetails
);
otheruserRoutes.put(
  '/block-other-user/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.other_user_id_exists,
  validateDbBody.other_user_block_check,
  otheruserController.blockOtherUser
);
otheruserRoutes.put(
  '/update-other-user/:id',
  passportSignIn,
  validateParam(schemas.id),
  schema_posts.add_other_user_update,
  validateDbBody.other_user_id_exists,
  validateDbBody.other_user_exists,
  otheruserController.updateOtherUser
);

otheruserRoutes.post(
  '/delete-other-user/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.other_user_id_exists,
  otheruserController.deleteOtherUser
);

otheruserRoutes.put(
  '/accept-other-user/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.other_user_approve_check,
  otheruserController.approveOtherUser
);

export default otheruserRoutes;
