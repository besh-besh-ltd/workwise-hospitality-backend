import { Router } from 'express';
import seoController from '../../controllers/seo/seoController.js';

const seoRoutes = Router();

seoRoutes.get('/products/slug', seoController.productSlugForSitemap);

// this api return data for dynamic sitemap for exmaple vendors/sitmap/1.xml page will this api and return producta url combinations  
seoRoutes.get('/vendors/sitemap', seoController.vendorSitemap);

//  this api help us to create dynamic sitemaps like vendors/sitmap/1.xml etc
seoRoutes.get('/vendors/sitemap/dynamic', seoController.vendorSitemapIndex);

export default seoRoutes;
