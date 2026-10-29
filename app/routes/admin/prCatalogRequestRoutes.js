import { Router } from 'express';
import passport from '../../middleware/passport.js';
import prCatalogRequestController from '../../controllers/admin/prCatalogRequestController.js';

const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const prCatalogRequestRoutes = Router();
prCatalogRequestRoutes.get('/', passportSignIn, prCatalogRequestController.list);
prCatalogRequestRoutes.post('/:id/fulfil', passportSignIn, prCatalogRequestController.fulfil);
prCatalogRequestRoutes.post('/:id/reject', passportSignIn, prCatalogRequestController.reject);

export default prCatalogRequestRoutes;
