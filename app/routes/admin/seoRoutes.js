import { Router } from 'express';
import seoController from '../../controllers/admin/seoController.js';

const seoRoutes = Router();

seoRoutes.get('/products/slug', seoController.productSlugForSitemap);

export default seoRoutes;
