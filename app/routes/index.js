import { Router } from 'express';

// import User from './admin/user/index.js';

import Users from './user/index.js';
import Cms from './cms/index.js';
import Product from './product/index.js';
import Admin from './admin/index.js';
import Rfq from './rfq/rfqRoutes.js';
import GeneralRoutes from './general.js';
import portalTourRoutes from './portalTour/portalTourRoutes.js';
import seoRoutes from './seo/seoRoutes.js';
import Project from './project/projectRoutes.js';

const v1 = Router();

// v1.use('/user', User);
v1.use('/admin', Admin);
v1.use('/users', Users);
v1.use('/cms', Cms);
v1.use('/products', Product);
v1.use('/rfq', Rfq);
v1.use('/general', GeneralRoutes);
v1.use('/portal-tour', portalTourRoutes);
v1.use('/seo', seoRoutes);
v1.use('/project', Project);

export default v1;
