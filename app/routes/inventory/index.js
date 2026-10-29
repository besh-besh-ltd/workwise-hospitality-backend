import express from 'express';
import planRoutes from './planRoutes.js';
import receiveRoutes from './receiveRoutes.js';
import rtvRoutes from './rtvRoutes.js';
import vendorRoutes from './vendorRoutes.js';
import setupRoutes from './setupRoutes.js';
import stockRoutes from './stockRoutes.js';
import countRoutes from './countRoutes.js';
import scanRoutes from './scanRoutes.js';
import reorderRoutes from './reorderRoutes.js';
import tokenRoutes from './tokenRoutes.js';

/**
 * Mounted at /api/v1/inventory. Auth is declared per route inside each
 * sub-router (never router.use), so one sub-router's guard cannot swallow
 * requests meant for the next, and the token routes stay outside JWT auth.
 */
const InventoryRoutes = express.Router();

InventoryRoutes.use('/token', tokenRoutes);
InventoryRoutes.use(planRoutes);
InventoryRoutes.use(receiveRoutes);
InventoryRoutes.use(rtvRoutes);
InventoryRoutes.use(vendorRoutes);
InventoryRoutes.use(setupRoutes);
InventoryRoutes.use(stockRoutes);
InventoryRoutes.use(countRoutes);
InventoryRoutes.use(scanRoutes);
InventoryRoutes.use(reorderRoutes);

export default InventoryRoutes;
