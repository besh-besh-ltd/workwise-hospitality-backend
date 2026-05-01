import { Router } from 'express';
import authRoutes from './authRoutes.js';
import buyerRoutes from './buyerRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import otheruserRoutes from './otheruserRoutes.js';
import productRoutes from './productRoutes.js';
import vendorRoutes from './vendorRoutes.js';
import vendorapproveRoutes from './vendorapproveRoutes.js';
import cmsRoutes from './cmsRoutes.js';
import subscriptionRoutes from './subscriptionRoutes.js';
import rolesRoutes from './rolesRoutes.js';
import rfqRoutes from './rfqRoutes.js';
import maintenanceRoutes from './maintenanceRoutes.js';
// import userRoutes from './userRoutes.js';

// import userRoutes from './userRoutes.js';

const admin = Router();
admin.use('/auth', authRoutes);
admin.use('/buyer', buyerRoutes);
admin.use('/notification', notificationRoutes);
admin.use('/other', otheruserRoutes);
admin.use('/vendor', vendorRoutes);
admin.use('/vendorapprove', vendorapproveRoutes);
admin.use('/cms', cmsRoutes);
admin.use('/product', productRoutes);
admin.use('/subscription', subscriptionRoutes);
admin.use('/roles', rolesRoutes);
admin.use('/rfq', rfqRoutes);
admin.use('/maintenance', maintenanceRoutes);

// admin.use('/user', userRoutes);

export default admin;
