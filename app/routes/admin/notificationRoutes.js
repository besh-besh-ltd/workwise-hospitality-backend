import { Router } from 'express';

import notificationController from '../../controllers/admin/notificationController.js';
import { validateDbBody } from '../../validations/dbValidation/notificationDbValidation.js';

import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/notificationValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const notificationRoutes = Router();

notificationRoutes.get(
  '/notification-list',
  passportSignIn,
  notificationController.notificationList
);
notificationRoutes.post(
  '/create-notification',
  passportSignIn,
  validateBody(schemas.add_notification),
  validateDbBody.add_notification,
  notificationController.addNotification
);

notificationRoutes.get(
  '/notification-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.notification_id_exists,
  notificationController.notificationDetails
);

notificationRoutes.put(
  '/update-notification/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.add_notification),
  validateDbBody.notification_id_exists,
  notificationController.updateNotification
);
notificationRoutes.delete(
  '/delete-notification/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.notification_id_exists,
  notificationController.deleteNotification
);

export default notificationRoutes;
