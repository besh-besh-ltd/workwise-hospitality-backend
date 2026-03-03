import { Router } from 'express';
import maintenanceController from '../../controllers/admin/maintenanceController.js';
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const maintenanceRoutes = Router();

maintenanceRoutes.post(
  '/send-maintenance-email',
  passportSignIn,
  maintenanceController.sendMaintenanceEmail
);

maintenanceRoutes.get(
  '/recipient-count',
  passportSignIn,
  maintenanceController.getRecipientCount
);

export default maintenanceRoutes;
