import express from 'express';
import passport from 'passport';
import rbacController from '../../controllers/rbac/rbacController.js';
import { acl } from '../../helper/common.js';

const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const router = express.Router();

/* -------- MASTER DATA -------- */
router.get(
  '/departments',
  passportSignIn,
  acl([7, 2]),
  rbacController.getDepartments
);
router.get(
  '/departments/access-matrix',
  passportSignIn,
  acl([7, 2]),
  rbacController.getDepartmentAccessMatrix
);
router.put(
  '/departments/access-matrix',
  passportSignIn,
  acl([7]),
  rbacController.updateDepartmentAccessMatrix
);
router.get('/roles', passportSignIn,acl([7, 2]), rbacController.getRoles);
router.get(
  '/roles/:roleId/permissions',
  passportSignIn,
  acl([7, 2]),
  rbacController.getPermissionsForRole
);
router.post(
  "/roles",
  passportSignIn,
  acl([7, 2]),
  rbacController.createRoleWithPermissions
);
router.put(
  "/roles/:roleId",
  passportSignIn,
  acl([7, 2]),
  rbacController.updateRoleWithPermissions
);
router.get(
  "/permissions",
  passportSignIn,
  acl([7, 2]),
  rbacController.getAllPermissionsGrouped
);
router.get(
  "/me/permissions",
  passportSignIn,
  acl([7, 2]),
  rbacController.getMyPermissionsGrouped
);
router.post(
  "/me/permissions/bulk",
  passportSignIn,
  rbacController.getMyPermissionsForHotels
);
router.get(
  '/users/:userId/roles',
  passportSignIn,
  acl([7, 2]),
  rbacController.getUserRoleScopes
);
router.get(
  '/users/:userId/departments',
  passportSignIn,
  acl([7, 2]),
  rbacController.getUserDepartments
);

export default router;
