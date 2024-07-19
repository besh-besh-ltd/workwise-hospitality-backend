import { Router } from 'express';

// import User from './admin/user/index.js';

import Users from './user/index.js';
import Cms from './cms/index.js';
import Product from './product/index.js';
import Admin from './admin/index.js';
import Rfq from './rfq/rfqRoutes.js';
import GeneralRoutes from './general.js';

const v1 = Router();

// v1.use('/user', User);
v1.use('/admin', Admin);
v1.use('/users', Users);
v1.use('/cms', Cms);
v1.use('/products', Product);
v1.use('/rfq', Rfq);
v1.use('/general', GeneralRoutes);

export default v1;
