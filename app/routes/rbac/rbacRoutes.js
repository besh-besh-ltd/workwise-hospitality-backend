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
  acl([7]),
  rbacController.getDepartments
);
router.get('/roles', passportSignIn, acl([7]), rbacController.getRoles);
router.get(
  '/roles/:roleId/permissions',
  passportSignIn,
  acl([7]),
  rbacController.getPermissionsForRole
);


export default router;
