import Config from '../../config/app.config.js';
import { logError } from '../../helper/common.js';
import rfqModel from '../../models/rfqModel.js';
import negotiationModel from '../../models/negotiationModel.js';
import { getLifecycleHistory } from '../../models/generalModel.js';
import db from '../../config/dbConn.js';

const formatErrorResponse = (res, error) => {
  const message = error.message || Config.errorText.value;
  const statusCode = error.statusCode || 400;

  return res.status(statusCode).json({
    status: 3,
    message
  });
};

const ArcController = {
  /**
   * Get full tender lifecycle data for ARC Committee
   * GET /arc/tender/:rfq_id
   */
  getTenderLifecycle: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const user_id = req.user.id;

      if (!rfq_id) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id is required'
        });
      }

      // Get RFQ/Tender details
      const rfqData = await rfqModel.getRfqById(rfq_id, user_id, req.user.user_type, true);
      const rfq = rfqData.length > 0 ? rfqData[0] : rfqData;

      if (!rfq) {
        return res.status(404).json({
          status: 2,
          message: 'RFQ/Tender not found'
        });
      }

      // Get lifecycle history
      const lifecycleHistory = await getLifecycleHistory('RFQ', rfq_id);

      // Get all quotes with vendor details
      const quotes = await db.any(
        `SELECT 
          q.*,
          u.name as vendor_name,
          u.email as vendor_email,
          u.organization_name,
          c.company_name,
          (
            SELECT json_agg(
              json_build_object(
                'id', qi.id,
                'product_id', qi.product_variant_id,
                'product_name', qi.product_name,
                'quantity', qi.quantity,
                'unit', qi.unit,
                'unit_price', qi.unit_price,
                'freight_price', qi.freight_price,
                'package_price', qi.package_price,
                'tax', qi.tax,
                'total_price', qi.total_price,
                'delivery_period', qi.delivery_period,
                'comment', qi.comment
              )
            )
            FROM tbl_quote_items qi
            WHERE qi.quote_id = q.id
          ) as quote_items
        FROM tbl_quotes q
        LEFT JOIN tbl_users u ON u.id = q.created_by
        LEFT JOIN tbl_company c ON c.id = u.company_id
        WHERE q.rfq_id = $1
        ORDER BY q.created_at DESC`,
        [rfq_id]
      );

      // Get technical evaluation data
      const techEvalData = await db.any(
        `SELECT 
          te.*,
          rp.id as rfq_product_id,
          rp.product_variant_id,
          (
            SELECT json_agg(
              json_build_object(
                'vendor_id', tev.vendor_id,
                'vendor_name', u.name,
                'vendor_email', u.email,
                'is_accepted', tev.is_accepted,
                'score', tev.score,
                'remarks', tev.remarks,
                'created_at', tev.created_at
              )
            )
            FROM tbl_rfq_product_tech_evaluation_vendors tev
            LEFT JOIN tbl_users u ON u.id = tev.vendor_id
            WHERE tev.tech_evaluation_id = te.id
          ) as vendor_evaluations
        FROM tbl_rfq_product_tech_evaluation te
        JOIN tbl_rfq_products rp ON rp.id = te.rfq_product_id
        WHERE te.rfq_id = $1`,
        [rfq_id]
      );

      // Get all negotiation rounds with quotes
      const negotiationRounds = await negotiationModel.getRoundsByRfqId(rfq_id);
      const roundsWithQuotes = await Promise.all(
        (negotiationRounds || []).map(async (round) => {
          const roundQuotes = await negotiationModel.getRoundQuotes(round.id);
          const approvals = await negotiationModel.getRoundApprovals(round.id);
          return {
            ...round,
            quotes: roundQuotes || [],
            approvals: approvals || []
          };
        })
      );

      // Get L1-L5 vendor rankings (finalization data) - ordered by price for each product
      const vendorRankingsByProduct = await db.any(
        `SELECT 
          rp.id as rfq_product_id,
          rp.product_variant_id,
          rp.variant,
          q.id as quote_id,
          q.created_by as vendor_id,
          u.name as vendor_name,
          u.email as vendor_email,
          u.organization_name,
          c.company_name,
          qi.total_price as quoted_price,
          qi.unit_price,
          qi.quantity,
          qi.unit,
          qf.id as finalization_id,
          qf.created_at as finalized_at
        FROM tbl_rfq_products rp
        LEFT JOIN tbl_quote_items qi ON qi.product_variant_id = rp.product_variant_id AND qi.variant = rp.variant
        LEFT JOIN tbl_quotes q ON q.id = qi.quote_id AND q.rfq_id = rp.rfq_id
        LEFT JOIN tbl_quote_finalization qf ON qf.rfq_id = rp.rfq_id 
          AND qf.product_variant_id = rp.product_variant_id 
          AND qf.variant = rp.variant
          AND qf.vendor_id = q.created_by
        LEFT JOIN tbl_users u ON u.id = q.created_by
        LEFT JOIN tbl_company c ON c.id = u.company_id
        WHERE rp.rfq_id = $1 AND q.id IS NOT NULL
        ORDER BY rp.id, qi.total_price ASC`,
        [rfq_id]
      );

      // Group by product and rank L1-L5
      const rankingsByProduct = {};
      vendorRankingsByProduct.forEach((item, index) => {
        const key = `${item.product_variant_id}_${item.variant}`;
        if (!rankingsByProduct[key]) {
          rankingsByProduct[key] = [];
        }
        // Only add if not already added (avoid duplicates)
        const exists = rankingsByProduct[key].some(r => r.vendor_id === item.vendor_id);
        if (!exists && rankingsByProduct[key].length < 5) {
          rankingsByProduct[key].push({
            ...item,
            rank: rankingsByProduct[key].length + 1
          });
        }
      });

      // Get sampling data if available (sampling might be part of tech eval clauses)
      let samplingData = [];
      try {
        samplingData = await db.any(
          `SELECT 
            c.*,
            u.name as vendor_name,
            u.email as vendor_email,
            rp.id as rfq_product_id
          FROM tbl_rfq_product_clauses c
          LEFT JOIN tbl_users u ON u.id = c.vendor_id
          JOIN tbl_rfq_products rp ON rp.id = c.rfq_product_id
          WHERE c.rfq_id = $1 AND c.clause_type = 'sampling'
          ORDER BY c.created_at DESC`,
          [rfq_id]
        );
      } catch (error) {
        // Sampling table might not exist or have different structure
        console.log('Sampling data not available:', error.message);
        samplingData = [];
      }

      return res.status(200).json({
        status: 1,
        data: {
          rfq,
          lifecycleHistory: lifecycleHistory || [],
          quotes: quotes || [],
          techEvaluation: techEvalData || [],
          negotiationRounds: roundsWithQuotes || [],
          vendorRankings: rankingsByProduct,
          sampling: samplingData || []
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Get list of RFQs pending ARC approval
   * GET /arc/rfqs
   */
  getRfqList: async (req, res) => {
    try {
      const user_id = req.user.id;
      const { page = 1, limit = 50, project_id, is_tender } = req.query;

      // Get RFQs that have been approved by finance and are pending ARC approval
      const rfqs = await db.any(
        `SELECT DISTINCT
          r.id,
          r.rfq_no,
          r.is_tender,
          r.company_name,
          r.timestamp,
          r.bid_end_date,
          r.status,
          p.name as project_name,
          (
            SELECT COUNT(*)
            FROM tbl_quotes q
            WHERE q.rfq_id = r.id
          ) as quote_count,
          (
            SELECT COUNT(*)
            FROM tbl_rfq_products rp
            WHERE rp.rfq_id = r.id
          ) as product_count
        FROM tbl_rfq r
        LEFT JOIN tbl_projects p ON p.id = r.project_id
        WHERE r.hospitality_company_id IS NOT NULL
          AND r.status IN (1, 2)
          ${is_tender ? `AND r.is_tender = ${is_tender === '1' ? 1 : 0}` : ''}
          ${project_id ? `AND r.project_id = ${parseInt(project_id)}` : ''}
        ORDER BY r.timestamp DESC
        LIMIT $1 OFFSET $2`,
        [parseInt(limit), (parseInt(page) - 1) * parseInt(limit)]
      );

      const total = await db.one(
        `SELECT COUNT(DISTINCT r.id)
        FROM tbl_rfq r
        WHERE r.hospitality_company_id IS NOT NULL
          AND r.status IN (1, 2)
          ${is_tender ? `AND r.is_tender = ${is_tender === '1' ? 1 : 0}` : ''}
          ${project_id ? `AND r.project_id = ${parseInt(project_id)}` : ''}`,
        []
      );

      return res.status(200).json({
        status: 1,
        data: rfqs,
        total: parseInt(total.count),
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  },

  /**
   * Approve/Reject/Send To stage
   * POST /arc/tender/:rfq_id/action
   */
  performAction: async (req, res) => {
    try {
      const rfq_id = parseInt(req.params.rfq_id);
      const { action, target_stage, remarks } = req.body;
      const user_id = req.user.id;

      if (!rfq_id || !action) {
        return res.status(400).json({
          status: 2,
          message: 'rfq_id and action are required'
        });
      }

      // Validate action
      const validActions = ['approve', 'reject', 'send_to'];
      if (!validActions.includes(action)) {
        return res.status(400).json({
          status: 2,
          message: `Invalid action. Must be one of: ${validActions.join(', ')}`
        });
      }

      // If send_to, target_stage is required
      if (action === 'send_to' && !target_stage) {
        return res.status(400).json({
          status: 2,
          message: 'target_stage is required for send_to action'
        });
      }

      // Record lifecycle event
      const { recordLifecycleEvent } = await import('../../models/generalModel.js');
      
      let stage = 'ARC_REVIEW';
      if (action === 'approve') {
        stage = 'ARC_APPROVED';
      } else if (action === 'reject') {
        stage = 'ARC_REJECTED';
      } else if (action === 'send_to') {
        stage = `SENT_TO_${target_stage.toUpperCase()}`;
      }

      await recordLifecycleEvent({
        entity_type: 'RFQ',
        entity_id: rfq_id,
        stage,
        action: action.toUpperCase(),
        performed_by: user_id,
        metadata: {
          target_stage: target_stage || null,
          action_type: action
        },
        remarks: remarks || null
      });

      // Update RFQ status if needed
      // TODO: Implement status updates based on action

      return res.status(200).json({
        status: 1,
        message: `Action ${action} performed successfully`,
        data: {
          rfq_id,
          action,
          target_stage: target_stage || null,
          stage,
          performed_by: user_id,
          performed_at: new Date()
        }
      });
    } catch (error) {
      logError(error);
      return formatErrorResponse(res, error);
    }
  }
};

export default ArcController;

