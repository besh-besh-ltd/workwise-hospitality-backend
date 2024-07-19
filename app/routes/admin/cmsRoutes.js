import { Router } from 'express';

import cmsController from '../../controllers/admin/cmsController.js';

import { validateDbBody } from '../../validations/dbValidation/cmsDbValidation.js';

import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/cmsValidation.js';
import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const cmsRoutes = Router();

cmsRoutes.post(
  '/create-banner',
  passportSignIn,
  schema_posts.add_banner_image,
  validateBody(schemas.create_banner),
  cmsController.create_banner
);
cmsRoutes.get('/banner-listing', passportSignIn, cmsController.bannerListing);
cmsRoutes.get('/page-list', passportSignIn, cmsController.pageList);

cmsRoutes.post(
  '/update-banner/:banner_id',
  passportSignIn,
  schema_posts.update_banner_image,
  // validateBody(schemas.create_banner),
  validateDbBody.banner_id_exists,
  cmsController.update_banner
);
cmsRoutes.post(
  '/update-logo/:logo_id',
  passportSignIn,
  schema_posts.update_logo_image,
  // validateBody(schemas.create_banner),
  // validateDbBody.banner_id_exists,
  cmsController.update_logo
);
cmsRoutes.get('/logo-listing', passportSignIn, cmsController.logoListing);
cmsRoutes.post(
  '/create-logo',
  passportSignIn,
  schema_posts.add_logo_image,
  validateBody(schemas.create_logo),
  cmsController.create_logo
);
cmsRoutes.get(
  '/banner-detail/:banner_id',
  passportSignIn,
  validateDbBody.banner_id_exists,
  cmsController.bannerDetail
);

cmsRoutes.get(
  '/logo-detail/:logo_id',
  passportSignIn,
  // validateDbBody.banner_id_exists,
  cmsController.logoDetail
);

cmsRoutes.post(
  '/delete-logo/:logo_id',
  passportSignIn,
  // validateParam(schemas.page_content_id),
  // validateDbBody.banner_id_exists,
  cmsController.deleteLogo
);

cmsRoutes.post(
  '/delete-banner/:banner_id',
  passportSignIn,
  // validateParam(schemas.page_content_id),
  validateDbBody.banner_id_exists,
  cmsController.deleteBanner
);

cmsRoutes.post(
  '/create-pagecontent',
  passportSignIn,
  validateBody(schemas.create_pagecontent),
  cmsController.create_pagecontent
);
cmsRoutes.get(
  '/page-content-listing',
  passportSignIn,
  cmsController.pageContentListing
);
cmsRoutes.get(
  '/page-content-detail/:page_id',
  passportSignIn,
  cmsController.pageContentDetails
);
cmsRoutes.post(
  '/update-pagecontent/:page_content_id',
  passportSignIn,
  validateBody(schemas.update_pagecontent),
  cmsController.update_pagecontent
);
cmsRoutes.post(
  '/delete-pagecontent/:page_content_id',
  passportSignIn,
  validateParam(schemas.page_content_id),
  validateDbBody.page_content_id_exists,
  cmsController.deletePageContent
);
cmsRoutes.put(
  '/update-cms-status/:page_content_id',
  passportSignIn,
  // validateParam(schemas.id),
  // validateBody(schemas.approval),
  validateDbBody.page_content_approve_check,
  cmsController.updateCmsPageStatus
);
cmsRoutes.get(
  '/contact-us-list',
  passportSignIn,
  cmsController.contactUsListing
);

cmsRoutes.post(
  '/create-faq',
  passportSignIn,
  // validateBody(schemas.create_faq),
  cmsController.createFaq
);

cmsRoutes.get('/faq-list', passportSignIn, cmsController.faqList);
cmsRoutes.get(
  '/faq-detail/:id',
  passportSignIn,
  validateDbBody.faq_id_exists,
  cmsController.faqDetail
);
cmsRoutes.get(
  '/blog-detail/:id',
  passportSignIn,
  validateDbBody.blog_id_exists,
  cmsController.blogDetail
);
cmsRoutes.put(
  '/update-faq/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.create_faq),
  validateDbBody.faq_id_exists,
  cmsController.updateFaq
);

cmsRoutes.delete(
  '/delete-faq/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.faq_id_exists,
  cmsController.deleteFaq
);
cmsRoutes.post(
  '/create-testimonial',
  passportSignIn,
  schema_posts.create_testimonial,
  cmsController.createTestimonial
);

cmsRoutes.get(
  '/testimonial-list',
  passportSignIn,
  cmsController.testimonialList
);
cmsRoutes.get(
  '/testimonial-detail/:id',
  passportSignIn,
  validateDbBody.testimonial_id_exists,
  cmsController.testimonialDetail
);
cmsRoutes.put(
  '/update-testimonial/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.testimonial_id_exists,
  schema_posts.create_testimonial,
  cmsController.updateTestimonial
);
cmsRoutes.delete(
  '/delete-testimonial/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.testimonial_id_exists,
  cmsController.deleteTestimonial
);
cmsRoutes.get(
  '/blog-category-list',
  passportSignIn,
  cmsController.blogCategoryList
);

cmsRoutes.post(
  '/create-blog',
  passportSignIn,
  schema_posts.create_blog,
  validateDbBody.blog_category_id_exists,
  cmsController.createBlog
);

cmsRoutes.get('/blog-list', passportSignIn, cmsController.blogList);

cmsRoutes.put(
  '/update-blog/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.blog_id_exists,
  schema_posts.create_blog,
  validateDbBody.blog_category_id_exists,
  cmsController.updateBlog
);

cmsRoutes.delete(
  '/delete-blog/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.blog_id_exists,
  cmsController.deleteBlog
);

cmsRoutes.get(
  '/analytics-dashboard',
  passportSignIn,
  cmsController.analytics_dashboard
);

export default cmsRoutes;
