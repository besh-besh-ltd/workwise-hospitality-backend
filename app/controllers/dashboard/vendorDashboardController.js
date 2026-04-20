import vendorDashboardModel from '../../models/vendorDashboardModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';

const vendorDashboardController = {
  getOpportunities: async (req, res) => {
    try {
      const vendor_id = req.user.id;
      const { start_date, end_date } = req.query;
      const data = await vendorDashboardModel.getOpportunities(
        vendor_id,
        start_date || '2025-01-01',
        end_date || new Date().toISOString().split('T')[0]
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getPerformance: async (req, res) => {
    try {
      const vendor_id = req.user.id;
      const { start_date, end_date } = req.query;
      const data = await vendorDashboardModel.getPerformance(
        vendor_id,
        start_date || '2025-01-01',
        end_date || new Date().toISOString().split('T')[0]
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },

  getInsights: async (req, res) => {
    try {
      const vendor_id = req.user.id;
      const { start_date, end_date } = req.query;
      const data = await vendorDashboardModel.getInsights(
        vendor_id,
        start_date || '2025-01-01',
        end_date || new Date().toISOString().split('T')[0]
      );
      res.status(200).json({ status: 1, data }).end();
    } catch (error) {
      logError(error);
      res.status(400).json({ status: 3, message: Config.errorText.value }).end();
    }
  },
};

export default vendorDashboardController;
