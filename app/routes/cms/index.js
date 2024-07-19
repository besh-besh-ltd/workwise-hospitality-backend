import { Router } from 'express';
// import UsersRoutes from './usersRoutes.js';
import CmsRoutes from './cmsRoutes.js';

// const users = Router();
const cms = Router();
// users.use('/', UsersRoutes);
cms.use('/', CmsRoutes);

export default cms;
