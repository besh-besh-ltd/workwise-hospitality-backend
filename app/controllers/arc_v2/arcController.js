import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import { resolveHospitalityCompanyId } from '../../helper/arc_v2/resolveHospitalityCompany.js';

/**
 * ARC v2 — Buyer-side controller for the ARC root entity.
 *
 * Endpoints surfaced by app/routes/arc_v2/contractRoutes.js. Wizard flow:
 *   POST   /             → createDraft
 *   PATCH  /:id          → updateDraft
 *   POST   /:id/publish  → publish (Draft → Floated)
 *   POST   /:id/withdraw → withdraw (creator-only)
 *   POST   /:id/terminate → terminate
 *   GET    /             → list (with filter presets — sidebar sub-links)
 *   GET    /:id          → getById
 *   GET    /kpis         → dashboardCounts (sidebar live badges)
 *   GET    /category-departments?category_id= → departments allowed for category × user
 *   GET    /sub-categories?category_id=        → sub-categories under a category
 *
 * Permissions enforced by acl() at the route layer.
 */

function ok(res, data, message = 'success') {
  return res.status(200).json({ status: 1, message, data });
}
function bad(res, status, message, code = 0) {
  return res.status(status).json({ status: code, message });
}

function generateArcNumber(now = new Date()) {
  const yyyy = now.getFullYear();
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `ARC-${yyyy}-${rand}`;
}

export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    if (!body.title || !body.category_id || !body.hospitality_company_id ||
        !body.hotel_id || !body.department_id || !body.process_id) {
      return bad(res, 400, 'title, category_id, hospitality_company_id, hotel_id, department_id, process_id are required');
    }
    const data = {
      arc_number: body.arc_number || generateArcNumber(),
      title: body.title,
      description: body.description,
      category_id: body.category_id,
      sub_category_ids: Array.isArray(body.sub_category_ids) ? body.sub_category_ids : [],
      hospitality_company_id: body.hospitality_company_id,
      hotel_id: body.hotel_id,
      department_id: body.department_id,
      process_id: body.process_id,
      submission_start_at: body.submission_start_at,
      submission_end_at: body.submission_end_at,
      contract_start_at: body.contract_start_at,
      contract_end_at: body.contract_end_at,
      technical_response_required: !!body.technical_response_required,
      sample_required: !!body.sample_required,
      eligibility_type: body.eligibility_type || 'open',
      escalation_clause_json: body.escalation_clause_json || {},
      payment_terms_expected: body.payment_terms_expected,
      delivery_expected: body.delivery_expected,
      penalty_clause: body.penalty_clause,
      created_by: userId,
    };
    return db.tx(async (t) => {
      const arc = await arcModel.createDraft(data, t);
      // Seed items if any were provided up-front (multi-step wizard might add them later via PATCH).
      const items = Array.isArray(body.items) ? body.items : [];
      const createdItems = [];
      for (const it of items) {
        if (!it.product_variant_id || it.indicative_qty == null) continue;
        createdItems.push(await arcModel.addItem(arc.id, it, t));
      }
      // Invitations (if invitation-only).
      if (data.eligibility_type === 'invitation' && Array.isArray(body.invited_vendor_ids)) {
        await arcModel.setInvitations(arc.id, body.invited_vendor_ids, t);
      }
      await logArcEvent({
        arcId: arc.id, eventType: ARC_EVENT_TYPES.CREATED,
        actorId: userId, payload: { items: createdItems.length },
        txContext: t,
      });
      return ok(res, { arc, items: createdItems }, 'ARC draft created');
    });
  } catch (err) {
    logger.error({ err }, '[arcController.createDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function updateDraft(req, res) {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const existing = await arcModel.getById(id);
    if (!existing) return bad(res, 404, 'ARC not found', 2);
    if (existing.status !== 'draft') return bad(res, 409, 'Only drafts can be edited');
    const updated = await arcModel.updateDraft(id, body);
    return ok(res, { arc: updated }, 'ARC draft updated');
  } catch (err) {
    logger.error({ err }, '[arcController.updateDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function publish(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (arc.status !== 'draft') return bad(res, 409, `Cannot publish ARC in status ${arc.status}`);
    // Minimal completeness validation. The wizard surfaces validation errors
    // earlier — this is the server-side fail-safe.
    const missing = [];
    if (!arc.submission_start_at) missing.push('submission_start_at');
    if (!arc.submission_end_at)   missing.push('submission_end_at');
    if (!arc.contract_start_at)   missing.push('contract_start_at');
    if (!arc.contract_end_at)     missing.push('contract_end_at');
    if (new Date(arc.submission_end_at) >= new Date(arc.contract_start_at)) missing.push('submission_end_at < contract_start_at');
    const items = await arcModel.listItems(id);
    if (items.length === 0) missing.push('at_least_one_item');
    if (missing.length > 0) return bad(res, 400, `Missing or invalid: ${missing.join(', ')}`);

    return db.tx(async (t) => {
      const updated = await arcModel.setStatus(id, 'floated', {}, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.PUBLISHED,
        actorId: userId, payload: { item_count: items.length },
        txContext: t,
      });
      return ok(res, { arc: updated }, 'ARC floated');
    });
  } catch (err) {
    logger.error({ err }, '[arcController.publish]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function withdraw(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (arc.created_by !== userId) return bad(res, 403, 'Only the creator can withdraw');
    if (!['floated','submission_closed'].includes(arc.status)) {
      return bad(res, 409, `Cannot withdraw ARC in status ${arc.status}`);
    }
    return db.tx(async (t) => {
      const updated = await arcModel.setStatus(id, 'draft', {}, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.WITHDRAWN,
        actorId: userId, payload: { previous_status: arc.status },
        txContext: t,
      });
      return ok(res, { arc: updated }, 'ARC withdrawn back to draft');
    });
  } catch (err) {
    logger.error({ err }, '[arcController.withdraw]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function terminate(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const reason = req.body?.reason;
    if (!reason) return bad(res, 400, 'reason is required');
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    return db.tx(async (t) => {
      const updated = await arcModel.setStatus(id, 'terminated', { closed_reason: reason }, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.TERMINATED,
        actorId: userId, payload: { reason, previous_status: arc.status },
        txContext: t,
      });
      return ok(res, { arc: updated }, 'ARC terminated');
    });
  } catch (err) {
    logger.error({ err }, '[arcController.terminate]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function list(req, res) {
  try {
    const { hospitality_company_id, hotel_ids, department_ids, statusGroup, page, limit } = req.query;
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const result = await arcModel.list({
      hospitality_company_id: hcId,
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
      statusGroup: statusGroup || 'all',
      page:  Number(page || 1),
      limit: Number(limit || 20),
    });
    return ok(res, result);
  } catch (err) {
    logger.error({ err }, '[arcController.list]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getById(req, res) {
  try {
    const id = Number(req.params.id);
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    const [items, invitations] = await Promise.all([
      arcModel.listItems(id),
      arcModel.listInvitations(id),
    ]);
    return ok(res, { arc, items, invitations });
  } catch (err) {
    logger.error({ err }, '[arcController.getById]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function dashboardCounts(req, res) {
  try {
    const { hospitality_company_id, hotel_ids, department_ids } = req.query;
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const counts = await arcModel.dashboardCounts({
      hospitality_company_id: hcId,
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
    });
    return ok(res, { counts });
  } catch (err) {
    logger.error({ err }, '[arcController.dashboardCounts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getDepartmentsForCategory(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    const userId     = req.user?.id;
    const hcId       = Number(req.query.hospitality_company_id || req.user?.hospitality_company_id);
    if (!categoryId || !userId || !hcId) {
      return bad(res, 400, 'category_id, user, and hospitality_company_id are required');
    }
    const departments = await arcModel.getDepartmentsForCategoryAndUser({
      category_id: categoryId,
      user_id: userId,
      hospitality_company_id: hcId,
    });
    return ok(res, { departments });
  } catch (err) {
    logger.error({ err }, '[arcController.getDepartmentsForCategory]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getSubCategories(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    if (!categoryId) return bad(res, 400, 'category_id is required');
    const rows = await db.any(
      `SELECT id, title FROM tbl_category WHERE parent_id = $1 AND COALESCE(is_deleted, 0) = 0 ORDER BY title`,
      [categoryId]
    );
    return ok(res, { sub_categories: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.getSubCategories]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns the top-level categories (parent_id NULL or 0) for the wizard.
export async function listRootCategories(req, res) {
  try {
    const rows = await db.any(
      `SELECT id, title
         FROM tbl_category
        WHERE (parent_id IS NULL OR parent_id = 0)
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY title`
    );
    return ok(res, { categories: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listRootCategories]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns the user's accessible hotels for the BU picker.
export async function listAccessibleHotels(req, res) {
  try {
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const rows = await db.any(
      `SELECT id, hospitality_company_id, name, city, keys
         FROM tbl_hospitality_company_hotels
        WHERE hospitality_company_id = $1
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY name`,
      [hcId]
    );
    return ok(res, { hotels: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listAccessibleHotels]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns product variants belonging to a category (and optional sub-categories).
export async function searchProductVariants(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    if (!categoryId) return bad(res, 400, 'category_id is required');
    const subCatIds = req.query.sub_category_ids
      ? String(req.query.sub_category_ids).split(',').map(Number).filter(Boolean)
      : [];
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const limit  = Math.min(Number(req.query.limit || 100), 500);

    const conds  = ['COALESCE(pv.status, 1) = 1'];
    const args   = [categoryId];
    let p = 2;
    if (subCatIds.length > 0) {
      conds.push(`EXISTS (SELECT 1 FROM tbl_product_categories pcsub WHERE pcsub.product_id = pv.product_id AND pcsub.category_id = ANY($${p}::int[]))`);
      args.push(subCatIds); p++;
    }
    if (search) {
      conds.push(`(LOWER(pv.name) LIKE $${p} OR LOWER(pv.slug) LIKE $${p})`);
      args.push(search); p++;
    }
    args.push(limit);

    const rows = await db.any(
      `SELECT pv.id, pv.name, pv.slug, pv.hsn,
              (SELECT u.title FROM tbl_units u
                 WHERE LOWER(u.title) = LOWER(COALESCE(pv.unit, ''))
                 LIMIT 1) AS uom
         FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pc.category_id = $1
          AND ${conds.join(' AND ')}
        ORDER BY pv.name
        LIMIT $${p}`,
      args
    );
    return ok(res, { variants: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.searchProductVariants]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns vendors eligible for the (category, hotel) pair via the existing
// vendor_hotel_category_subscription table.
export async function listEligibleVendors(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    const hotelId    = Number(req.query.hotel_id);
    if (!categoryId || !hotelId) return bad(res, 400, 'category_id and hotel_id are required');
    const rows = await db.any(
      `SELECT DISTINCT u.id, u.name, u.email, u.mobile
         FROM tbl_users u
         JOIN tbl_vendor_hotel_category_subscription vhcs
           ON vhcs.vendor_id = u.id
        WHERE u.user_type = 3
          AND u.status = 1
          AND vhcs.status IN ('active', 'expired')
          AND (
            (vhcs.item_type = 'hotel'    AND vhcs.item_id = $2)
            OR
            (vhcs.item_type = 'category' AND vhcs.item_id = $1)
          )
        ORDER BY u.name`,
      [categoryId, hotelId]
    );
    return ok(res, { vendors: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listEligibleVendors]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
