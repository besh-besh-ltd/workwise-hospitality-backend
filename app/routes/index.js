import { Router } from 'express';

// import User from './admin/user/index.js';

import Users from './user/index.js';
import Product from './product/index.js';
import Admin from './admin/index.js';
import Rfq from './rfq/rfqRoutes.js';
import GeneralRoutes from './general.js';
import seoRoutes from './seo/seoRoutes.js';
import Project from './project/projectRoutes.js';
import PORoutes from './purchase_order/poRoutes.js';
import HospitalityRoutes from './hospitality/hospitalityRoutes.js';
import NegotiationRoutes from './negotiation/negotiationRoutes.js';
import PublicRoutes from './public/publicRoutes.js';
import RbacRoutes from './rbac/rbacRoutes.js';
import ArcRoutes from './arc/arcRoutes.js';
import PricingRoutes from './pricing/pricingRoutes.js';
import UnitsRoutes from './units/unitsRoutes.js';

const v1 = Router();

// v1.use('/user', User);
v1.use('/admin', Admin);
v1.use('/users', Users);
v1.use('/products', Product);
v1.use('/rfq', Rfq);
v1.use('/general', GeneralRoutes);
v1.use('/seo', seoRoutes);
v1.use('/project', Project);
v1.use('/po', PORoutes);
v1.use('/public', PublicRoutes)
v1.use('/hospitality', HospitalityRoutes);
v1.use('/negotiation', NegotiationRoutes);
v1.use('/rbac', RbacRoutes);
v1.use('/arc', ArcRoutes);
v1.use('/pricing', PricingRoutes);
v1.use('/units', UnitsRoutes);

export default v1;
