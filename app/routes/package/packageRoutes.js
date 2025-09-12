// packageRoutes.js
import { Router } from 'express';
import packageController from '../../controllers/package/packageController.js';

const routes = Router();

routes.get('/', packageController.list);
routes.get('/:id', packageController.getById);
routes.post('', packageController.create);
routes.put('/:id', packageController.update);
routes.delete(':/id', packageController.remove);

routes.post('/:id/items', packageController.addItem);
routes.delete('items/:itemId', packageController.removeItem);

routes.post('/:id/vendors', packageController.addVendor);
routes.delete('/vendors/:id', packageController.removeVendor);

export default routes;
