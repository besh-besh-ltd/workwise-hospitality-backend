import { Router } from 'express';
import sitemapController from '../../controllers/admin/sitemapController.js';

const sitemapRoutes = Router();

sitemapRoutes.get('/vendor-list', sitemapController.vendorProfiles);

export default sitemapRoutes;