import rfqModel from '../../models/rfqModel.js';
import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';

const rfqController = {
  getAllRfqs: async (req, res) => {
    try {
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let { rfq_status, admin_service_status, sort } = req.body;

      if (!rfq_status) {
        rfq_status = null;
      }
      if (!admin_service_status) {
        admin_service_status = null;
      }
      if (!sort) {
        sort = 'DESC';
      }

      const listRfq = await rfqModel.getAllRfqsForAdmin(
        limit,
        offset,
        rfq_status,
        admin_service_status,
        sort
      );
      const count = await rfqModel.getTotalRfqCountForAdmin(
        rfq_status,
        admin_service_status
      );

      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  getAllClientsrfqsForAdmin: async (req, res) => {
    try {
      console.log('Request Query Parameters:', req.query);
      console.log('Request Body Parameters:', req.body);

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || '';

      const {
        dateFilter = 'all',
        startDate = '',
        endDate = '',
        companyIds = []
      } = req.body;

      const result = await rfqModel.getAllClientsrfqsForAdmin(
        page,
        limit,
        search,
        dateFilter,
        startDate,
        endDate,
        companyIds
      );

      res.status(200).json({
        status: 1,
        message: 'Client RFQ list fetched successfully',
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  // getVendorInfoPageForAdmin: async (req, res) => {
  //   try {
  //     const result = await rfqModel.getVendorInfoPageForAdmin();
  //     res.status(200).json({
  //       status: 1,
  //       message: 'Vendor info page data fetched successfully',
  //       data: result
  //     });
  //   } catch (error) {
  //     logError(error);
  //     res.status(400).json({
  //       status: 3,
  //       message: Config.errorText.value
  //     });
  //   }
  // },

  getAllCompaniesListForAdmin: async (req, res) => {
    try {
      const result = await rfqModel.getAllCompaniesListForAdmin();

      res.status(200).json({
        status: 1,
        message: 'Companies list fetched successfully',
        data: result
      });
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  createOrUpdateAdminRfqService: async (req, res) => {
    try {
      const { rfq_id, status, comment } = req.body;
      const subadmin_id = req.user.id;

      if (!rfq_id || !status) {
        return res.status(400).json({
          status: 0,
          message: 'Missing required fields'
        });
      }

      const result = await rfqModel.createOrUpdateAdminRfqService(
        rfq_id,
        subadmin_id,
        status,
        comment
      );

      res.status(200).json({
        status: 1,
        message: 'Admin RFQ service record created or updated successfully',
        data: result
      });
    } catch (error) {
      logError(error);
      res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  getRfqById: async (req, res) => {
    const { id } = req.params;

    try {
      const rfqDetails = await rfqModel.getRfqByIdForAdmin(id);

      if (!rfqDetails || rfqDetails.length === 0) {
        return res
          .status(404)
          .json({
            status: 3,
            message: 'RFQ not found'
          })
          .end();
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'RFQ details fetched successfully',
          data: rfqDetails
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  }
};

export default rfqController;
