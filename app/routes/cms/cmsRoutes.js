import { Router } from 'express';
import CmsController from '../../controllers/cms/cmsController.js';
import subscriptionController from '../../controllers/admin/subscriptionController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/userValidation.js';
import { validateDbBody } from '../../validations/dbValidation/userDbValidation.js';
import { acl } from '../../helper/common.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const CmsRoutes = Router();

CmsRoutes.get('/home-banner/:page_id', CmsController.homeBanner);
CmsRoutes.get('/get-cms-data/:page_id', CmsController.cms_data);
CmsRoutes.post('/contact-us', CmsController.contact_us);
CmsRoutes.get(
  '/management-list/:management_type',
  CmsController.management_list
);
CmsRoutes.get('/faq-listing', CmsController.faq_listing);
CmsRoutes.get('/blog-listing', CmsController.blog_listing);
CmsRoutes.get('/media-section', CmsController.media_section);
CmsRoutes.get('/company-list', CmsController.company_list);
CmsRoutes.get('/testimonial-list', CmsController.testimonial_list);
CmsRoutes.get('/product-list', CmsController.product_list);
CmsRoutes.get(
  '/subscription-list',
  passportSignIn,
  acl([2, 4]),
  subscriptionController.buyerSubscriptionList
);

export default CmsRoutes;
