import dashboardModel from '../../models/dashboardModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';

/**
 * Resolves scope from tbl_hospitality_user_mappings.
 * Returns { buyer_company_id, hotel_ids } or null (sends 403).
 */
const resolveScope = async (req, res) => {
  const user_id = req.user.id;
  const { hotel_ids } = req.query;
  const selectedHotelIds = hotel_ids ? hotel_ids.split(',').map(Number).filter(Boolean) : [];

  const scope = await dashboardModel.resolveUserScope(user_id, selectedHotelIds);
  if (!scope) {
    res.status(403).json({ status: 0, message: 'No hospitality access found for this user' }).end();
    return null;
  }
  return scope;
};

const dashboardController = {
  getActionCenter: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getActionCenterData(scope.buyer_company_id, req.user.id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getProcurementSnapshot: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getProcurementSnapshotData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getNegotiationSavings: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getNegotiationSavingsData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getCostIntelligence: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date, product_variant_id, duration_type } = req.query;
      const pvId = product_variant_id ? parseInt(product_variant_id, 10) : null;
      const data = await dashboardModel.getCostIntelligenceData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date, pvId, duration_type);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getCategoryInsights: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getCategoryInsightsData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getWorkflowEfficiency: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getWorkflowEfficiencyData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getSmartInsights: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getSmartInsightsData(scope.buyer_company_id, scope.hotel_ids, start_date, end_date);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getRejectedPOs: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const data = await dashboardModel.getRejectedPOsDetail(scope.buyer_company_id, scope.hotel_ids);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getPendingApprovals: async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { start_date, end_date } = req.query;
      const data = await dashboardModel.getPendingApprovalsDetail(scope.buyer_company_id, req.user.id, start_date || '2025-01-01', end_date || new Date().toISOString().split('T')[0]);
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },
};

export default dashboardController;
