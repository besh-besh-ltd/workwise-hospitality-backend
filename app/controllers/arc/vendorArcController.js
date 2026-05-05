// vendorArcController.js — Phase 5: vendor-side ARC dashboard.
//
// Endpoints (all scoped to req.user.id):
//   GET /arc/vendor/list           — list ACTIVE / DOC_GENERATED envelopes
//                                     where tbl_arc.vendor_id = req.user.id.
//   GET /arc/vendor/:arc_id        — full envelope: items, hotels, document URL.
//   GET /arc/vendor/:arc_id/document — signed document URL (or persisted URL).
//
// SECURITY: every read is filtered by `vendor_id = req.user.id`. A vendor
// can never see another vendor's contract even if they craft the URL.

import db from '../../config/dbConn.js';
import { logError } from '../../helper/common.js';

const formatErr = (res, err) => {
  const message = err.message || 'Failed to process request';
  return res.status(err.statusCode || 400).json({ status: 3, message });
};

const VendorArcController = {
  /**
   * GET /arc/vendor/list
   * Lists ARC envelopes where the actor is the awarded vendor and the
   * envelope is in an actionable state (PENDING_COMMITTEE shows up too
   * so vendors can see "in progress" tenders, but the doc URL only
   * exists once the envelope reaches DOC_GENERATED / ACTIVE).
   *
   * Query params: status (optional comma-separated), search (rfq_no
   * substring), page, limit.
   */
  list: async (req, res) => {
    try {
      const vendorId = req.user?.id;
      if (!vendorId) return res.status(401).json({ status: 3, message: 'Authentication required' });

      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const offset = (page - 1) * limit;
      const status = (req.query.status || '').split(',').map((s) => s.trim()).filter(Boolean);
      const search = (req.query.search || '').trim();

      const conditions = ['a.vendor_id = $1'];
      const vals = [vendorId];
      let p = 2;
      if (status.length > 0) {
        conditions.push(`a.status = ANY($${p++}::text[])`);
        vals.push(status);
      }
      if (search) {
        conditions.push(`r.rfq_no::text ILIKE $${p++}`);
        vals.push(`%${search}%`);
      }
      const where = conditions.join(' AND ');

      // Count + page in one round trip via window function.
      const rows = await db.any(
        `SELECT a.id AS arc_id, a.rfq_id, a.tender_scope, a.period_from, a.period_to,
                a.status, a.document_url, a.document_generated_at, a.created_at,
                r.rfq_no, r.title AS rfq_title,
                (SELECT COUNT(*) FROM tbl_arc_item ai
                  WHERE ai.arc_id = a.id AND ai.status = 'APPROVED') AS approved_items,
                (SELECT COUNT(*) FROM tbl_arc_hotels ah
                  WHERE ah.arc_id = a.id) AS hotels_count,
                COUNT(*) OVER ()::int AS total_count
         FROM tbl_arc a
         JOIN tbl_rfq r ON r.id = a.rfq_id
         WHERE ${where}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        vals
      );

      const total = rows.length > 0 ? rows[0].total_count : 0;
      const data = rows.map(({ total_count, ...rest }) => rest);

      return res.status(200).json({ status: 1, data, total, page, limit });
    } catch (error) {
      logError(error);
      return formatErr(res, error);
    }
  },

  /**
   * GET /arc/vendor/:arc_id
   * Returns the envelope + items + hotels + document URL when the
   * actor is the awarded vendor. Otherwise 404 (NOT 403 — we don't
   * want to leak existence).
   */
  detail: async (req, res) => {
    try {
      const vendorId = req.user?.id;
      const arcId = parseInt(req.params.arc_id);
      if (!vendorId) return res.status(401).json({ status: 3, message: 'Authentication required' });
      if (!arcId) return res.status(400).json({ status: 3, message: 'arc_id is required' });

      const envelope = await db.oneOrNone(
        `SELECT a.*, r.rfq_no, r.title AS rfq_title
         FROM tbl_arc a
         JOIN tbl_rfq r ON r.id = a.rfq_id
         WHERE a.id = $1 AND a.vendor_id = $2`,
        [arcId, vendorId]
      );
      if (!envelope) return res.status(404).json({ status: 3, message: 'ARC not found' });

      const items = await db.any(
        `SELECT ai.id, ai.product_variant_id, ai.variant, ai.unit_price,
                ai.status, ai.charges_meta,
                pv.name AS product_name
         FROM tbl_arc_item ai
         LEFT JOIN tbl_product_variants pv ON pv.id = ai.product_variant_id
         WHERE ai.arc_id = $1
         ORDER BY ai.id`,
        [arcId]
      );

      const hotels = await db.any(
        `SELECT h.id, h.name, h.city, h.address, hc.name AS company_name
         FROM tbl_arc_hotels ah
         JOIN tbl_hospitality_company_hotels h ON h.id = ah.hotel_id
         LEFT JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
         WHERE ah.arc_id = $1
         ORDER BY h.name`,
        [arcId]
      );

      return res.status(200).json({
        status: 1,
        data: { ...envelope, items, hotels },
      });
    } catch (error) {
      logError(error);
      return formatErr(res, error);
    }
  },

  /**
   * GET /arc/vendor/:arc_id/document
   * Returns the persisted S3 URL (or 404 when the document hasn't been
   * generated yet — DOC_GENERATED / ACTIVE only). Vendor-scoped.
   */
  document: async (req, res) => {
    try {
      const vendorId = req.user?.id;
      const arcId = parseInt(req.params.arc_id);
      if (!vendorId) return res.status(401).json({ status: 3, message: 'Authentication required' });
      if (!arcId) return res.status(400).json({ status: 3, message: 'arc_id is required' });

      const row = await db.oneOrNone(
        `SELECT id, document_url, document_generated_at, status
         FROM tbl_arc
         WHERE id = $1 AND vendor_id = $2`,
        [arcId, vendorId]
      );
      if (!row) return res.status(404).json({ status: 3, message: 'ARC not found' });
      if (!row.document_url) {
        return res.status(404).json({
          status: 3,
          message: 'Document not yet generated for this ARC',
          arc_status: row.status,
        });
      }

      return res.status(200).json({
        status: 1,
        data: {
          arc_id: row.id,
          document_url: row.document_url,
          generated_at: row.document_generated_at,
        },
      });
    } catch (error) {
      logError(error);
      return formatErr(res, error);
    }
  },
};

export default VendorArcController;
