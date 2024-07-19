import { Router } from 'express';

import rolesController from '../../controllers/admin/rolesController.js';
import { validateDbBody } from '../../validations/dbValidation/rolesDbValidation.js';

import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/rolesValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const rolesRoutes = Router();

rolesRoutes.post(
  '/create-sub-admin',
  passportSignIn,
  schema_posts.add_subadmin,
  validateDbBody.subadmin_exists,
  rolesController.createSubadmin
);
rolesRoutes.get('/subadmin-list', passportSignIn, rolesController.subadminList);
rolesRoutes.get(
  '/subadmin-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.subadmin_id_exists,
  rolesController.subadminDetails
);
rolesRoutes.put(
  '/update-subadmin/:id',
  passportSignIn,
  validateParam(schemas.id),
  // validateBody(schemas.update_subadmins),
  schema_posts.update_subadmin,
  validateDbBody.subadmin_id_exists,
  rolesController.updateSubadmin
);
rolesRoutes.post(
  '/add-role-permission',
  passportSignIn,
  // schema_posts.add_subadmin,
  // validateDbBody.subadmin_exists,
  rolesController.addRolePermission
);
rolesRoutes.get(
  '/subadmin-dropdown',
  passportSignIn,
  rolesController.subadminDrop
);
rolesRoutes.get(
  '/menu-list-checkbox',
  passportSignIn,
  rolesController.menuList
);
rolesRoutes.get(
  '/roles-permission-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.subadmin_id_exists,
  rolesController.rolePermissionDetails
);
rolesRoutes.put(
  '/update-role-permission/:id',
  passportSignIn,
  validateParam(schemas.id),
  // validateBody(schemas.update_subadmins),
  // schema_posts.update_subadmin,
  validateDbBody.subadmin_id_exists,
  rolesController.updateRolePermission
);

export default rolesRoutes;
