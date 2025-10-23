import { Router } from 'express';
import seoController from '../../controllers/seo/seoController.js';

const seoRoutes = Router();

seoRoutes.get('/products/slug', seoController.productSlugForSitemap);

// this api return data for dynamic sitemap for exmaple vendors/sitmap/1.xml page will this api and return producta url combinations  
seoRoutes.get('/vendors/sitemap', seoController.vendorSitemap);

//  this api help us to create dynamic sitemaps like vendors/sitmap/1.xml etc
seoRoutes.get('/vendors/sitemap/dynamic', seoController.vendorSitemapIndex);

seoRoutes.get('/vendors/categories', seoController.categorySitemap);

//this pai fpr creating indexes 1.xml , 2.xml etc for categories sitemaps
seoRoutes.get('/vendors/sitemap/cateories', seoController.categorySitemapIndex);

export default seoRoutes;
