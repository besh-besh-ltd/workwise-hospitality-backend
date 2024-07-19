import { Router } from 'express';
import UsersRoutes from './usersRoutes.js';

const users = Router();
users.use('/', UsersRoutes);

export default users;
