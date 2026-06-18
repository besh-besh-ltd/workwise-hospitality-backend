import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import rbacModel from '../../models/rbacModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import { resolveHospitalityCompanyId, resolveHospitalityCompanyScope } from '../../helper/arc_v2/resolveHospitalityCompany.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';
import { sendMail } from '../../helper/common.js';

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
  // Wide, time-seeded suffix to avoid collisions on the UNIQUE arc_number
  // (audit L1) — the old 4-digit random had only ~9000 values/year.
  const stamp = now.getTime().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `ARC-${yyyy}-${stamp}${rand}`;
}

// Authorization: may this caller act on the given hotel? Super admin
// (user_type 8) bypasses; everyone else must have the hotel in their
// accessible set. Scope is derived from the entity's hotel_id — never trusted
// from the client (security-first; see audit C4).
async function userCanAccessHotel(req, hotelId) {
  if (Number(req.user?.user_type) === 8) return true;
  if (!req.user?.id || !hotelId) return false;
  const accessible = await rbacModel.getAllAccessibleHotelIds(req.user.id);
  return accessible.map(Number).includes(Number(hotelId));
}

// Notify every invited vendor that an ARC was floated (audit C2). Best-effort
// and post-commit: a notification/email failure must NEVER roll back or block
// the float. In-app/push/socket goes via notificationService.dispatch; email
// is fire-and-forget on top.
async function notifyVendorsOfFloat(arc, invitations, actorId) {
  const vendorIds = invitations.map((i) => Number(i.vendor_id)).filter(Boolean);
  if (vendorIds.length === 0) return;
  const deadline = arc.submission_end_at ? new Date(arc.submission_end_at).toDateString() : null;
  try {
    await dispatchNotification({
      userIds: vendorIds,
      senderUserId: actorId,
      category: 'ARC',
      type: 'ARC_FLOATED',
      title: 'New rate contract opportunity',
      body: deadline
        ? `${arc.title} is open for quotes until ${deadline}.`
        : `${arc.title} is open for quotes.`,
      data: { arc_id: arc.id, arc_number: arc.arc_number },
      actionUrl: '/dashboard/vendor/rate-contracts/requests',
    });
  } catch (err) {
    logger.error({ err, arcId: arc.id }, '[arcController.publish] in-app vendor notify failed');
  }
  for (const inv of invitations) {
    if (!inv.vendor_email) continue;
    sendMail({
      to: inv.vendor_email,
      subject: `New rate contract opportunity: ${arc.title}`,
      html: `<p>Hello ${inv.vendor_name || 'Vendor'},</p>
             <p>A new rate contract <strong>${arc.title}</strong> (${arc.arc_number}) is open for quotes${deadline ? ` until <strong>${deadline}</strong>` : ''}.</p>
             <p>Please log in to your vendor portal to review and submit your quote.</p>`,
    }).catch((err) =>
      logger.error({ err, arcId: arc.id, vendor: inv.vendor_id }, '[arcController.publish] vendor email failed')
    );
  }
}

export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || !body.category_id ||
        !body.hotel_id || !body.department_id) {
      return bad(res, 400, 'title, category_id, hotel_id, department_id are required');
    }
    const hotelId = Number(body.hotel_id);
    // Derive the hotel's TRUE hospitality company server-side — never trust a
    // client-supplied hospitality_company_id (audit C4). Any body value is
    // ignored. This also unblocks the wizard, which never sends it (audit C1).
    const [hotelMapping] = await rbacModel.getHotelCompanyMappings([hotelId]);
    if (!hotelMapping) return bad(res, 400, 'invalid hotel_id');
    // Authorize against the hotel's own scope: the caller must be able to act
    // on this hotel, else they could mint a contract in another tenant (C4).
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }
    const data = {
      // Always server-generated — never trust a client-supplied arc_number (L1).
      arc_number: generateArcNumber(),
      title,
      description: body.description,
      category_id: body.category_id,
      sub_category_ids: Array.isArray(body.sub_category_ids) ? body.sub_category_ids : [],
      hospitality_company_id: Number(hotelMapping.hospitality_company_id),
      hotel_id: hotelId,
      department_id: body.department_id,
      // ARC approval routes via the committee/hierarchy model, not an approval
      // process — process_id is optional and defaults to NULL (audit H5).
      process_id: body.process_id ?? null,
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
    // Re-verify tenant ownership on publish — never flip a foreign ARC (C4).
    if (!(await userCanAccessHotel(req, arc.hotel_id))) {
      return bad(res, 403, 'You do not have access to this rate contract');
    }
    if (arc.status !== 'draft') return bad(res, 409, `Cannot publish ARC in status ${arc.status}`);
    // Server-side completeness + window validation (audit M1). The wizard
    // surfaces these earlier — this is the fail-safe.
    const missing = [];
    if (!arc.submission_start_at) missing.push('submission_start_at');
    if (!arc.submission_end_at)   missing.push('submission_end_at');
    if (!arc.contract_start_at)   missing.push('contract_start_at');
    if (!arc.contract_end_at)     missing.push('contract_end_at');
    if (arc.submission_start_at && arc.submission_end_at &&
        new Date(arc.submission_start_at) >= new Date(arc.submission_end_at)) {
      missing.push('submission_start_at < submission_end_at');
    }
    if (arc.submission_end_at && arc.contract_start_at &&
        new Date(arc.submission_end_at) >= new Date(arc.contract_start_at)) {
      missing.push('submission_end_at < contract_start_at');
    }
    if (arc.contract_start_at && arc.contract_end_at &&
        new Date(arc.contract_start_at) >= new Date(arc.contract_end_at)) {
      missing.push('contract_start_at < contract_end_at');
    }
    if (arc.submission_end_at && new Date(arc.submission_end_at) <= new Date()) {
      missing.push('submission_end_at must be in the future');
    }
    const items = await arcModel.listItems(id);
    if (items.length === 0) missing.push('at_least_one_item');
    if (missing.length > 0) return bad(res, 400, `Missing or invalid: ${missing.join(', ')}`);

    // Resolve the vendor panel BEFORE flipping so we can refuse to float to
    // nobody (audit M2). "open" resolves eligible vendors for (category, hotel);
    // "invitation" uses the rows set at createDraft.
    let vendorIds;
    if (arc.eligibility_type === 'open') {
      const eligible = await arcModel.getEligibleVendorsForCategory(
        { category_id: arc.category_id, hotel_id: arc.hotel_id }
      );
      vendorIds = eligible.map((v) => Number(v.id));
    } else {
      const inv = await arcModel.listInvitations(id);
      vendorIds = inv.map((i) => Number(i.vendor_id));
    }
    if (vendorIds.length === 0) {
      return bad(res, 400, 'No eligible vendors to invite — cannot float this rate contract to nobody');
    }

    const result = await db.tx(async (t) => {
      const updated = await arcModel.setStatus(id, 'floated', {}, t);
      // Persist the vendor snapshot (audit C3). For "open" this writes the
      // resolved set; "invitation" already has its rows. Either way the ARC
      // becomes visible in those vendors' portals (which key off invitations).
      if (arc.eligibility_type === 'open') {
        await arcModel.setInvitations(id, vendorIds, t);
      }
      const invitations = await arcModel.listInvitations(id, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.PUBLISHED,
        actorId: userId, payload: { item_count: items.length, vendor_count: invitations.length },
        txContext: t,
      });
      return { updated, invitations };
    });

    // Notify tagged vendors AFTER commit (audit C2) — best-effort, never blocks.
    await notifyVendorsOfFloat(arc, result.invitations, userId);

    return ok(res, { arc: result.updated, vendor_count: result.invitations.length }, 'ARC floated');
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
    const { hotel_ids, department_ids, statusGroup, page, limit } = req.query;
    // Scope to ALL the user's companies (super admin → null = all) so multi-
    // company users see their ARCs; the in-page Business Unit facet narrows.
    const companyIds = await resolveHospitalityCompanyScope(req);
    const result = await arcModel.list({
      hospitality_company_ids: companyIds,
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

// ============================================================
// GET /v1/arc-v2/:id/lifecycle — the single authoritative page's spine.
// Returns the computed stage states + the caller's ARC permissions, both
// derived from the ARC row's own scope (hotel/department) — never from
// client headers. Lazily flips floated→submission_closed once the window
// has passed (idempotent, event-logged).
// ============================================================
const ARC_PERMISSION_RESOURCES = ['arc', 'arc-tech', 'arc-comm', 'arc-committee'];
const ARC_ALL_ACTIONS = {
  'arc':           ['read', 'create', 'admin'],
  'arc-tech':      ['read', 'evaluate'],
  'arc-comm':      ['read', 'evaluate'],
  'arc-committee': ['read', 'approve'],
};

export async function getLifecycle(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const lifecycle = await arcLifecycleModel.computeLifecycle(id, { userId, lazyFlip: true });
    if (!lifecycle) return bad(res, 404, 'ARC not found', 2);

    // Caller's ARC permissions in THIS ARC's scope. Super admin sees all.
    let permissions;
    if (Number(req.user?.user_type) === 8) {
      permissions = { ...ARC_ALL_ACTIONS };
    } else {
      permissions = Object.fromEntries(ARC_PERMISSION_RESOURCES.map((r) => [r, []]));
      if (lifecycle.arc.hotel_id != null) {
        const rows = await rbacModel.getUserPermissionsForHotels(
          userId, [lifecycle.arc.hotel_id], null, lifecycle.arc.department_id || null
        );
        for (const row of rows) {
          const resource = String(row.resource);
          if (permissions[resource]) permissions[resource].push(String(row.action));
        }
      }
    }

    return ok(res, { ...lifecycle, permissions });
  } catch (err) {
    logger.error({ err }, '[arcController.getLifecycle]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function dashboardCounts(req, res) {
  try {
    const { hotel_ids, department_ids } = req.query;
    const companyIds = await resolveHospitalityCompanyScope(req);
    const counts = await arcModel.dashboardCounts({
      hospitality_company_ids: companyIds,
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
