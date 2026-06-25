import { Router } from 'express';
import contractRoutes from './contractRoutes.js';
import evaluationRoutes from './evaluationRoutes.js';
import committeeRoutes from './committeeRoutes.js';
import vendorRoutes from './vendorRoutes.js';
import amendmentRoutes from './amendmentRoutes.js';
import manualRoutes from './manualRoutes.js';

const ArcV2Routes = Router();

// Vendor portal endpoints are mounted under /vendor so the buyer-side
// controllers can keep clean path shapes.
ArcV2Routes.use('/vendor', vendorRoutes);
ArcV2Routes.use('/amendments', amendmentRoutes);
ArcV2Routes.use('/committee', committeeRoutes);
ArcV2Routes.use('/evaluation', evaluationRoutes);
// Manual / backfill data-entry. MUST be mounted BEFORE the root contractRoutes
// so its /:id catch-all doesn't shadow /manual/* paths.
ArcV2Routes.use('/manual', manualRoutes);

// Buyer-side contract (ARC) endpoints live at the root.
ArcV2Routes.use('/', contractRoutes);

export default ArcV2Routes;
