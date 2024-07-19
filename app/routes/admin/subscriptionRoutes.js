import { Router } from 'express';

import subscriptionController from '../../controllers/admin/subscriptionController.js';

import { validateDbBody } from '../../validations/dbValidation/subscriptionDbValidation.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/subscriptionValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const subscriptionRoutes = Router();

subscriptionRoutes.get(
  '/subscription-list',
  passportSignIn,
  subscriptionController.subscriptionList
);
subscriptionRoutes.get(
  '/subscription-list-dropdown',
  passportSignIn,
  subscriptionController.subscriptionListDropdown
);
subscriptionRoutes.post(
  '/add-subscription',
  passportSignIn,
  validateBody(schemas.add_subscription),
  validateDbBody.feature_id_exists,
  subscriptionController.addSubscription
);
subscriptionRoutes.get(
  '/subscription-feature-list',
  passportSignIn,
  subscriptionController.subscriptionFeatureList
);
subscriptionRoutes.get(
  '/subscription-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.subscription_id_exists,
  subscriptionController.subscriptionDetails
);
subscriptionRoutes.put(
  '/update-subscription/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.add_subscription),
  validateDbBody.subscription_id_exists,
  validateDbBody.feature_id_exists,
  subscriptionController.updateSubscription
);
subscriptionRoutes.delete(
  '/delete-subscription/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.subscription_id_exists,
  subscriptionController.deleteSubscription
);

subscriptionRoutes.get(
  '/all-subscriber-list',
  passportSignIn,
  subscriptionController.getAllSubscribersList
);
subscriptionRoutes.put(
  '/change-subscription-date',
  passportSignIn,
  validateBody(schemas.change_subscription_date),
  validateDbBody.change_subscription_date,
  subscriptionController.changeSubscriptionDate
);

subscriptionRoutes.get(
  '/payment-list',
  passportSignIn,
  subscriptionController.getPaymentList
);

export default subscriptionRoutes;
