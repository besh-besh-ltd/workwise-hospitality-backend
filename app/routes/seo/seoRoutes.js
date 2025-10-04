import { Router } from 'express';
import seoController from '../../controllers/seo/seoController.js';

const seoRoutes = Router();

seoRoutes.get('/products/slug', seoController.productSlugForSitemap);
seoRoutes.get('/vendors/sitemap', seoController.vendorSitemap);

export default seoRoutes;
