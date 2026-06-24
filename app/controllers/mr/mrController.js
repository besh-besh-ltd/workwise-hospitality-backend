import db from '../../config/dbConn.js';
import mrModel from '../../models/mr/mrModel.js';
import { releaseForMr } from '../../services/callOffPoService.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import { resolveHospitalityCompanyId, resolveHospitalityCompanyScope } from '../../helper/arc_v2/resolveHospitalityCompany.js';
import {
  createApprovalInstance,
  findBestMatchingPolicy,
  findBestMatchingPolicyTx,
  getApprovalInstanceDetails,
} from '../../models/generalModel.js';
import { dispatchPostApprovalAction } from '../../services/approvalActionService.js';
import rbacModel from '../../models/rbacModel.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';
import { sendMail } from '../../helper/common.js';
import { generateCallOffPoPdf } from '../../helper/arc_v2/callOffPoRenderer.js';

// Notify the vendor + the MR raiser that a call-off PO was released and awaits
// the vendor's acceptance (audit CO10). Best-effort, post-commit — a
// notification failure must never undo the release.
async function notifyCallOffReleased(mr, released) {
  for (const { po, group } of released) {
    const recipients = [Number(group.vendor_id), Number(mr.raised_by)].filter(Boolean);
    try {
      await dispatchNotification({
        userIds: recipients,
        senderUserId: mr.raised_by || null,
        category: 'CALL_OFF',
        type: 'CALL_OFF_RELEASED',
        title: 'Released PO awaiting acceptance',
        body: `Released PO ${po.po_number} (₹${Number(po.total_value).toLocaleString('en-IN')}) was released from requisition ${mr.mr_number} and is awaiting vendor acceptance.`,
        data: { po_id: po.id, mr_id: mr.id, po_number: po.po_number },
        actionUrl: `/dashboard/buyer/purchase-orders/${po.id}`,
      });
    } catch (err) {
      logger.error({ err, poId: po.id }, '[mrController.notifyCallOffReleased] in-app notify failed');
    }
    const vendorEmail = await db.oneOrNone(`SELECT email, name FROM tbl_users WHERE id = $1`, [group.vendor_id]);
    if (vendorEmail?.email) {
      sendMail({
        to: vendorEmail.email,
        subject: `New released purchase order ${po.po_number} — acceptance required`,
        html: `<p>Hello ${vendorEmail.name || 'Vendor'},</p>
               <p>A new released purchase order <strong>${po.po_number}</strong> has been released against your active rate contract and is awaiting your acceptance.</p>
               <p>Please log in to your vendor portal to review and accept it.</p>`,
      }).catch((err) => logger.error({ err, poId: po.id }, '[mrController.notifyCallOffReleased] email failed'));
    }
  }
}

// Authorization: may this caller act on the given hotel? Super admin (8)
// bypasses; everyone else must have the hotel in their accessible set. Scope is
// derived from the hotel, never trusted from the client (audit CO1).
async function userCanAccessHotel(req, hotelId) {
  if (Number(req.user?.user_type) === 8) return true;
  if (!req.user?.id || !hotelId) return false;
  const accessible = await rbacModel.getAllAccessibleHotelIds(req.user.id);
  return accessible.map(Number).includes(Number(hotelId));
}

// Validate a single MR item against its referenced contract line (audit CO2).
// `line` is the row from mrModel.getContractLineDetail. Returns an error string
// or null. `mr` carries the derived hotel_id + chosen department_id.
function validateMrItemAgainstLine(item, line, mr) {
  if (!line) return 'references an unknown contract line';
  if (Number(line.arc_contract_id) !== Number(item.arc_contract_id)) {
    return 'contract line does not belong to the given contract';
  }
  if (!['active', 'expiring_soon'].includes(line.contract_status)) {
    return 'the contract is not active';
  }
  if (Number(line.hotel_id) !== Number(mr.hotel_id) ||
      Number(line.department_id) !== Number(mr.department_id)) {
    return "the contract is not in this requisition's hotel/department";
  }
  if (Number(line.product_variant_id) !== Number(item.product_variant_id)) {
    return 'the product does not match the contract line';
  }
  return null;
}

/**
 * MR (Material Requisition) — Buyer-side controller.
 *
 * Contracted-items-only per plan §2.1. Item picker (searchContractedItems)
 * never returns non-contracted items, and the submit endpoint re-validates
 * each item references an active contract for the user's hotel/department.
 *
 * The post-approval hook handleMrPostApproval is the trigger for
 * callOffPoService.releaseForMr, which generates one call-off PO per vendor
 * contract under the MR.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

// Super admin (user_type 8) reads everything — unrestricted by the scope matrix.
function isSuperAdmin(req) { return Number(req.user?.user_type) === 8; }

// Parse a CSV string or array of ids → distinct positive number[] | null.
// null = "client supplied no filter on this axis" (→ full scope, no narrowing).
// An empty/garbage value also yields null (treated as "no filter"), so a client
// can never accidentally scope to nothing by sending junk — only the matrix
// decides what's visible.
function parseIntArray(v) {
  if (v == null) return null;
  const raw = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const x of raw) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.length ? out : null;
}

// Accept an ISO calendar date "YYYY-MM-DD"; return it, else null (never throw).
function parseISODate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// FE sends an INCLUSIVE created_to (YYYY-MM-DD). The model uses a `<` upper
// bound, so convert the inclusive end-of-day to the exclusive next-day boundary.
function exclusiveDateUpper(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Single source of truth for the read scope + filters every MR read endpoint
 * uses. Derives the (company × hotel × department) scope from req.user — NEVER
 * trusting the client to widen — and folds in the optional client BU/dept/date
 * FILTERS (which can only narrow within the matrix). Returns the params the
 * model methods (list / dashboardCounts / analytics) accept.
 *
 *   companyIds      number[] | null   server-derived company scope (null = super admin)
 *   scope_user_id   number   | null   userId → role-scope matrix (null = super admin, unrestricted)
 *   hotel_ids       number[] | null   client BU filter (null = none)
 *   department_ids  number[] | null   client dept filter (null = none)
 *   created_from    ISO date | null   inclusive lower bound on created_at
 *   created_to      ISO date | null   EXCLUSIVE upper bound on created_at
 *
 * The matrix EXISTS predicate is the upper bound; the client hotel/dept arrays
 * are ANDed on top, so a requested out-of-scope hotel/dept matches nothing
 * (cannot widen). Source: { hotel_ids, department_ids, created_from, created_to }
 * read from query (GET) or body (list-view POST).
 */
async function deriveScopeParams(req, source) {
  const companyIds = await resolveHospitalityCompanyScope(req); // null = super admin
  const scope_user_id = isSuperAdmin(req) ? null : (req.user?.id ?? -1);
  const hotel_ids = parseIntArray(source.hotel_ids);
  const department_ids = parseIntArray(source.department_ids);
  const created_from = parseISODate(source.created_from);
  const created_to = exclusiveDateUpper(parseISODate(source.created_to));
  return { companyIds, scope_user_id, hotel_ids, department_ids, created_from, created_to };
}

function generateMrNumber(now = new Date()) {
  const yyyy = now.getFullYear();
  // Wide, time-seeded suffix to avoid collisions on the UNIQUE mr_number
  // (audit CO17) — the old 4-digit random had only ~9000 values/year.
  const stamp = now.getTime().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `MR-${yyyy}-${stamp}${rand}`;
}

/**
 * GET /v1/mr/search-contracted-items?hotel_id=&department_id=&q=
 *
 * Picker used by the MR-create wizard. Always scoped to the requesting user's
 * (hotel × department) — only the user's accessible context is allowed.
 */
export async function searchContractedItems(req, res) {
  try {
    const hotelId      = Number(req.query.hotel_id);
    const departmentId = Number(req.query.department_id);
    if (!hotelId || !departmentId) return bad(res, 400, 'hotel_id and department_id are required');
    // Authorize the hotel against the caller's own scope (audit CO1) — the
    // picker exposes commercial rates, so it must not be enumerable cross-tenant.
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }
    const rows = await mrModel.searchContractedItems({
      hotel_id:      hotelId,
      department_id: departmentId,
      query:         req.query.q || null,
      limit:         Math.min(Number(req.query.limit || 25), 100),
    });
    return ok(res, { items: rows });
  } catch (err) {
    logger.error({ err }, '[mrController.searchContractedItems]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * GET /v1/mr/form/hotels — hotels the requesting user can raise an MR for.
 * Derived from the user's own mappings (req.user) — no client company id.
 */
export async function formHotels(req, res) {
  try {
    const hotels = await mrModel.accessibleHotels(req.user.id);
    return ok(res, { hotels });
  } catch (err) {
    logger.error({ err }, '[mrController.formHotels]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * GET /v1/mr/form/departments?hotel_id= — departments the user is mapped to at
 * the given hotel. Hotel access is authorized first (no cross-tenant enumeration).
 */
export async function formDepartments(req, res) {
  try {
    const hotelId = Number(req.query.hotel_id);
    if (!hotelId) return bad(res, 400, 'hotel_id is required');
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }
    const departments = await mrModel.hotelDepartmentsForUser(req.user.id, hotelId);
    return ok(res, { departments });
  } catch (err) {
    logger.error({ err }, '[mrController.formDepartments]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || !body.hotel_id || !body.department_id) {
      return bad(res, 400, 'title, hotel_id, department_id are required');
    }
    const hotelId = Number(body.hotel_id);
    const departmentId = Number(body.department_id);
    // Derive the hotel's TRUE hospitality company server-side — never trust a
    // client-supplied hospitality_company_id (audit CO1).
    const [hotelMapping] = await rbacModel.getHotelCompanyMappings([hotelId]);
    if (!hotelMapping) return bad(res, 400, 'invalid hotel_id');
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }
    const mrScope = { hotel_id: hotelId, department_id: departmentId };

    // Validate every item against its contract line BEFORE writing anything
    // (audit CO2/CO16 — no silent skipping). The matched_unit_rate is taken
    // from the contract line, never the client.
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const validatedItems = [];
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i] || {};
      if (!it.arc_contract_id || !it.arc_contract_line_id || !it.product_variant_id || !it.quantity) {
        return bad(res, 400, `Item ${i + 1}: arc_contract_id, arc_contract_line_id, product_variant_id and quantity are required`);
      }
      if (Number(it.quantity) <= 0) {
        return bad(res, 400, `Item ${i + 1}: quantity must be greater than zero`);
      }
      const line = await mrModel.getContractLineDetail(it.arc_contract_line_id);
      const err = validateMrItemAgainstLine(it, line, mrScope);
      if (err) return bad(res, 400, `Item ${i + 1}: ${err}`);
      validatedItems.push({
        product_variant_id:   it.product_variant_id,
        quantity:             it.quantity,
        uom:                  it.uom,
        arc_contract_id:      it.arc_contract_id,
        arc_contract_line_id: it.arc_contract_line_id,
        matched_unit_rate:    line.unit_rate, // authoritative — from the contract line
      });
    }

    return db.tx(async (t) => {
      const mr = await mrModel.createDraft({
        mr_number: generateMrNumber(), // always server-generated (audit CO17)
        title,
        hospitality_company_id: Number(hotelMapping.hospitality_company_id),
        hotel_id: hotelId,
        department_id: departmentId,
        cost_center: body.cost_center,
        urgency: body.urgency,
        required_by_date: body.required_by_date,
        justification: body.justification,
        delivery_location: body.delivery_location,
        raised_by: userId,
      }, t);
      const inserted = [];
      for (const it of validatedItems) {
        inserted.push(await mrModel.addItem(mr.id, it, t));
      }
      return ok(res, { mr, items: inserted }, 'MR draft created');
    });
  } catch (err) {
    logger.error({ err }, '[mrController.createDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * POST /v1/mr/:id/submit — flip from draft → pending_approval. The actual
 * approval instance creation depends on the existing approval engine
 * (createApprovalInstance with entity_type='MR'). For the foundation we set
 * the status; the explicit approval-instance creation should be wired in
 * via generalModel.createApprovalInstance once the route layer integrates it.
 */
export async function submit(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    if (mr.raised_by !== userId) return bad(res, 403, 'Only the raiser can submit');
    if (mr.status !== 'draft') return bad(res, 409, `Cannot submit MR in status ${mr.status}`);
    const items = await mrModel.listItems(id);
    if (items.length === 0) return bad(res, 400, 'MR must have at least one item');
    // Defence-in-depth re-validation (audit CO2) + hard over-consumption guard
    // (audit CO4): every item must still reference an in-scope, active contract
    // line, and its quantity must fit the line's remaining quantity.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const line = await mrModel.getContractLineDetail(it.arc_contract_line_id);
      const err = validateMrItemAgainstLine(it, line, mr);
      if (err) return bad(res, 400, `Item ${i + 1}: ${err}`);
      if (Number(it.quantity) > Number(line.remaining_qty)) {
        return bad(res, 400, `Item ${i + 1}: requested quantity (${it.quantity}) exceeds the contract's remaining quantity (${line.remaining_qty})`);
      }
    }
    const result = await db.tx(async (t) => {
      // Spin up a REAL approval instance through the central engine. Every step
      // in the resolved MR policy is required — there is no threshold-based
      // skip. The post-approval hook (handleMrPostApproval, registered for
      // entity_type 'MR') fires on terminal APPROVED and releases the call-off.
      const policy = await findBestMatchingPolicyTx({
        entity_type: 'MR',
        hospitality_company_id: mr.hospitality_company_id,
        hotel_id: mr.hotel_id,
        process_id: null,
      }, t);
      if (!policy) {
        const e = new Error('No approval policy is configured for Material Requisitions in this business unit. Ask an administrator to set one up.');
        e.httpStatus = 400; throw e;
      }
      const engineResult = await createApprovalInstance({
        entity_type:            'MR',
        entity_id:              id,
        hospitality_company_id: mr.hospitality_company_id,
        hotel_id:               mr.hotel_id,
        department_id:          mr.department_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata:               { mr_number: mr.mr_number, item_count: items.length },
        txContext:              t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');
      const updated = await mrModel.setStatus(id, 'pending_approval', {
        submitted_at: new Date(),
        approval_instance_id: instanceRow.id,
      }, t);
      return {
        __data: { mr: updated, items, approval_instance_id: instanceRow.id },
        __autoApproved: engineResult.autoApproved === true,
      };
    });
    // Respond AFTER commit. If the chain auto-approved at creation (submitter is
    // the sole configured approver), fire the post-approval effects now.
    if (result && result.__data) {
      if (result.__autoApproved) {
        await dispatchPostApprovalAction(result.__data.approval_instance_id, userId, {
          status: 'APPROVED', comment: 'Auto-approved — submitter is the sole configured approver',
        });
      }
      return ok(res, result.__data, 'MR submitted for approval');
    }
    return result;
  } catch (err) {
    if (err.httpStatus) return bad(res, err.httpStatus, err.message);
    logger.error({ err }, '[mrController.submit]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getById(req, res) {
  try {
    const id = Number(req.params.id);
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    // Scope guard (audit CO1): only the raiser or a user with access to the
    // MR's hotel may read it — no cross-tenant MR reads by id.
    if (mr.raised_by !== req.user?.id && !(await userCanAccessHotel(req, mr.hotel_id))) {
      return bad(res, 403, 'You do not have access to this requisition');
    }
    const items = await mrModel.listItems(id);
    const callOffs = await mrModel.callOffPos(id).catch(() => []);
    // The live approval chain (steps + per-approver status + whether the caller
    // is the current approver) drives the detail page's chain + approve/reject.
    let approval = null;
    if (mr.approval_instance_id) {
      approval = await getApprovalInstanceDetails(mr.approval_instance_id, req.user?.id || null).catch((e) => {
        logger.warn({ e: e.message, mrId: id }, '[mrController.getById] approval detail load failed');
        return null;
      });
    }
    return ok(res, { mr, items, approval, callOffs });
  } catch (err) {
    logger.error({ err }, '[mrController.getById]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// GET /v1/mr/approval-preview?hotel_id= — the resolved MR approval chain for a
// scope, so the create page can show the REAL routing (not a hardcoded mock).
export async function approvalPreview(req, res) {
  try {
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const hotelId = req.query.hotel_id ? Number(req.query.hotel_id) : null;
    const policy = await findBestMatchingPolicy({
      entity_type: 'MR', hospitality_company_id: hcId, hotel_id: hotelId, process_id: null,
    });
    if (!policy) return ok(res, { found: false, steps: [] });
    const steps = await mrModel.policySteps(policy.id);
    return ok(res, { found: true, policy_id: policy.id, steps });
  } catch (err) {
    logger.error({ err }, '[mrController.approvalPreview]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Server-authoritative listing — search, facet, sort, paginate + a "Pending
// for me" tab, all computed server-side. Mirrors rfqController.getRfqListView.
export async function getMrListView(req, res) {
  try {
    const userId = req.user?.id;
    const body = req.body || {};
    const tab = ['all', 'for_me', 'drafts', 'pending', 'approved', 'po_released', 'cancelled'].includes(body.tab) ? body.tab : 'all';
    const search = (body.search || '').toString().trim().toLowerCase() || null;
    const sort = ['recent', 'oldest', 'value', 'required'].includes(body.sort) ? body.sort : 'recent';
    const page = Number(body.page) > 0 ? Number(body.page) : 1;
    const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : 20;
    const f = body.filters || {};
    const asStrArr = (v) => (Array.isArray(v) ? v.map(String) : []);
    // Accept an ISO calendar date "YYYY-MM-DD"; ignore anything else (never throw).
    const asISODate = (v) => {
      if (typeof v !== 'string') return null;
      const s = v.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };
    const filters = {
      status: asStrArr(f.status), buId: asStrArr(f.buId), departmentId: asStrArr(f.departmentId),
      categoryId: asStrArr(f.categoryId), productId: asStrArr(f.productId), vendorId: asStrArr(f.vendorId),
      urgency: asStrArr(f.urgency),
      dateFrom: asISODate(f.dateFrom),
      dateTo: asISODate(f.dateTo),
    };
    // Derive the read-scope matrix + intersected client BU/dept/date filters
    // (single source of truth shared with analytics/counts/list). The matrix is
    // applied IN SQL, so the fetched set already excludes out-of-scope cells —
    // the in-JS facet filters below can only narrow within it, never widen.
    const scope = await deriveScopeParams(req, {
      hotel_ids: body.hotel_ids,
      department_ids: body.department_ids,
      // Date window comes from the listing's own FY/custom facet (filters.dateFrom/To),
      // applied in JS below — do NOT also push it into the SQL fetch here.
    });

    // 1. fetch the full scoped set (big cap so faceting is complete).
    const { data: allRows } = await mrModel.list({
      hospitality_company_ids: scope.companyIds,
      scope_user_id: scope.scope_user_id,
      hotel_ids: scope.hotel_ids,
      department_ids: scope.department_ids,
      statusGroup: 'all', page: 1, limit: 1000,
    });
    const rows = Array.isArray(allRows) ? allRows : [];

    // 2. bucket + "pending for me" stamping.
    const STATUS_BUCKET = { draft: 'drafts', pending_approval: 'pending', approved: 'approved', po_released: 'po_released', rejected: 'cancelled', cancelled: 'cancelled' };
    const pendingIds = new Set(rows.length && userId ? await mrModel.getPendingMrIds(rows.map((r) => r.id), userId) : []);
    for (const r of rows) {
      r._bucket = STATUS_BUCKET[r.status] || 'drafts';
      r._isMyAction = pendingIds.has(Number(r.id));
      r.action_required = r._isMyAction;
      r.action_label = r._isMyAction ? 'Approval needed' : null;
    }

    // array helpers (json columns arrive as arrays or strings depending on driver path)
    const parseArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } })() : []));
    const pairs = (ids, names) => { const a = parseArr(ids); const b = parseArr(names); const out = []; for (let i = 0; i < a.length; i++) { if (a[i] != null) out.push({ id: String(a[i]), label: b[i] != null ? String(b[i]) : `#${a[i]}` }); } return out; };
    const catPairs = (r) => pairs(r.category_ids, r.category_titles);
    const prodPairs = (r) => pairs(r.product_variant_ids, r.item_names);
    const vendPairs = (r) => pairs(r.vendor_ids, r.vendor_names);

    // 3. tab counts.
    const tab_counts = { all: rows.length, for_me: 0, drafts: 0, pending: 0, approved: 0, po_released: 0, cancelled: 0 };
    for (const r of rows) {
      tab_counts[r._bucket] = (tab_counts[r._bucket] || 0) + 1;
      if (r._isMyAction) tab_counts.for_me++;
    }

    // 4. tab scope.
    const tabRows = tab === 'all' ? rows
      : tab === 'for_me' ? rows.filter((r) => r._isMyAction)
      : rows.filter((r) => r._bucket === tab);

    // 5. facets over the tab scope.
    const fm = { status: new Map(), buId: new Map(), departmentId: new Map(), categoryId: new Map(), productId: new Map(), vendorId: new Map(), urgency: new Map() };
    const bump = (m, key, label) => { if (key == null || key === '') return; const e = m.get(key) || { key, label: label || null, count: 0 }; e.count++; if (label && !e.label) e.label = label; m.set(key, e); };
    const BUCKET_LABEL = { drafts: 'Draft', pending: 'Awaiting approval', approved: 'Approved', po_released: 'Released PO', cancelled: 'Cancelled' };
    for (const r of tabRows) {
      bump(fm.status, r._bucket, BUCKET_LABEL[r._bucket] || r._bucket);
      if (r.hotel_id != null) bump(fm.buId, String(r.hotel_id), r.hotel_name || `Hotel ${r.hotel_id}`);
      if (r.department_id != null) bump(fm.departmentId, String(r.department_id), r.department_name || `Dept ${r.department_id}`);
      for (const c of catPairs(r)) bump(fm.categoryId, c.id, c.label);
      for (const p of prodPairs(r)) bump(fm.productId, p.id, p.label);
      for (const v of vendPairs(r)) bump(fm.vendorId, v.id, v.label);
      if (r.urgency) bump(fm.urgency, String(r.urgency), String(r.urgency).charAt(0).toUpperCase() + String(r.urgency).slice(1));
    }
    const toFacet = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count);
    const facets = {
      status: toFacet(fm.status), buId: toFacet(fm.buId), departmentId: toFacet(fm.departmentId),
      categoryId: toFacet(fm.categoryId), productId: toFacet(fm.productId), vendorId: toFacet(fm.vendorId), urgency: toFacet(fm.urgency),
    };

    // FY / custom-range window (epoch ms). Inclusive of both calendar days.
    const fromMs = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
    const toMs = filters.dateTo ? (new Date(`${filters.dateTo}T00:00:00`).getTime() + 86400000) : null; // exclusive upper

    // 6. apply facet + search filters.
    const filtered = tabRows.filter((r) => {
      if (filters.status.length && !filters.status.includes(r._bucket)) return false;
      if (filters.buId.length && !filters.buId.includes(String(r.hotel_id))) return false;
      if (filters.departmentId.length && !filters.departmentId.includes(String(r.department_id))) return false;
      if (filters.categoryId.length && !catPairs(r).some((c) => filters.categoryId.includes(c.id))) return false;
      if (filters.productId.length && !prodPairs(r).some((p) => filters.productId.includes(p.id))) return false;
      if (filters.vendorId.length && !vendPairs(r).some((v) => filters.vendorId.includes(v.id))) return false;
      if (filters.urgency.length && !filters.urgency.includes(String(r.urgency))) return false;
      if (search) {
        const hay = `${r.title || ''} ${r.mr_number || ''} ${r.hotel_name || ''} ${r.department_name || ''} ${r.raised_by_name || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      // FY / custom creation-date window (server-authoritative; AND with other facets).
      if (fromMs != null || toMs != null) {
        const c = new Date(r.created_at || 0).getTime();
        if (fromMs != null && c < fromMs) return false;
        if (toMs != null && c >= toMs) return false;
      }
      return true;
    });

    // 7. sort.
    const ts = (r) => new Date(r.created_at || 0).getTime();
    const req4 = (r) => new Date(r.required_by_date || '9999-12-31').getTime();
    if (sort === 'oldest') filtered.sort((a, b) => ts(a) - ts(b));
    else if (sort === 'value') filtered.sort((a, b) => Number(b.total_est_value || 0) - Number(a.total_est_value || 0));
    else if (sort === 'required') filtered.sort((a, b) => req4(a) - req4(b));
    else filtered.sort((a, b) => ts(b) - ts(a));

    // 8. paginate + trim.
    const total = filtered.length;
    const pageRows = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
    const data = pageRows.map((r) => ({
      id: r.id, mr_number: r.mr_number, title: r.title, status: r.status, bucket: r._bucket,
      hotel_id: r.hotel_id, hotel_name: r.hotel_name, department_id: r.department_id, department_name: r.department_name,
      urgency: r.urgency, required_by_date: r.required_by_date, submitted_at: r.submitted_at, created_at: r.created_at,
      raised_by: r.raised_by, raised_by_name: r.raised_by_name,
      item_count: r.item_count, total_est_value: r.total_est_value, call_off_count: r.call_off_count,
      item_names: prodPairs(r).map((p) => p.label).filter(Boolean),
      categories: catPairs(r).map((c) => ({ id: c.id, title: c.label })),
      products: prodPairs(r).map((p) => ({ id: p.id, name: p.label })),
      vendors: vendPairs(r).map((v) => ({ id: v.id, name: v.label })),
      action_required: r.action_required, action_label: r.action_label,
    }));

    return ok(res, { rows: data, facets, tab_counts, total, page, limit });
  } catch (err) {
    logger.error({ err }, '[mrController.getMrListView]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function list(req, res) {
  try {
    const { statusGroup, raised_by, page, limit } = req.query;
    // Scope to ALL the user's companies (super admin → null = all) + the
    // role-scope matrix (security core); client BU/dept/date params only narrow.
    const scope = await deriveScopeParams(req, req.query);
    const result = await mrModel.list({
      hospitality_company_ids: scope.companyIds,
      scope_user_id:  scope.scope_user_id,
      hotel_ids:      scope.hotel_ids,
      department_ids: scope.department_ids,
      created_from:   scope.created_from,
      created_to:     scope.created_to,
      raised_by:      raised_by ? Number(raised_by) : null,
      statusGroup: statusGroup || 'all',
      page:  Number(page || 1),
      limit: Number(limit || 20),
    });
    return ok(res, result);
  } catch (err) {
    logger.error({ err }, '[mrController.list]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function dashboardCounts(req, res) {
  try {
    const scope = await deriveScopeParams(req, req.query);
    const counts = await mrModel.dashboardCounts({
      hospitality_company_ids: scope.companyIds,
      scope_user_id:  scope.scope_user_id,
      hotel_ids:      scope.hotel_ids,
      department_ids: scope.department_ids,
      created_from:   scope.created_from,
      created_to:     scope.created_to,
      raised_by:      req.query.raised_by ? Number(req.query.raised_by) : null,
    });
    return ok(res, { counts });
  } catch (err) {
    logger.error({ err }, '[mrController.dashboardCounts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function analytics(req, res) {
  try {
    const scope = await deriveScopeParams(req, req.query);
    const data = await mrModel.analytics({
      hospitality_company_ids: scope.companyIds,
      scope_user_id:  scope.scope_user_id,
      hotel_ids:      scope.hotel_ids,
      department_ids: scope.department_ids,
      created_from:   scope.created_from,
      created_to:     scope.created_to,
      raised_by:      req.query.raised_by ? Number(req.query.raised_by) : null,
    });
    return ok(res, data);
  } catch (err) {
    logger.error({ err }, '[mrController.analytics]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * GET /v1/mr/dashboard/filter-options — the scoped Business-Unit (hotel) +
 * Department option lists that populate the dashboard filter bar. Derived from
 * the SAME role-scope matrix as the analytics scope (single source of truth),
 * so the dropdowns can only ever offer choices the user can actually read.
 * Super admin (user_type 8) gets all hotels + all departments.
 */
export async function dashboardFilterOptions(req, res) {
  try {
    const superAdmin = isSuperAdmin(req);
    const [hotels, departments] = await Promise.all([
      mrModel.scopedHotelOptions(req.user.id, { isSuperAdmin: superAdmin }),
      mrModel.scopedDepartmentOptions(req.user.id, { isSuperAdmin: superAdmin }),
    ]);
    return ok(res, { hotels, departments });
  } catch (err) {
    logger.error({ err }, '[mrController.dashboardFilterOptions]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function cancel(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    if (mr.raised_by !== userId) return bad(res, 403, 'Only the raiser can cancel');
    if (mr.status === 'po_released') return bad(res, 409, 'Cannot cancel MR already released as PO');
    const updated = await mrModel.setStatus(id, 'cancelled', {});
    return ok(res, { mr: updated }, 'MR cancelled');
  } catch (err) {
    logger.error({ err }, '[mrController.cancel]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Post-approval hooks (registered in approvalActionService)
// ============================================================

/**
 * On MR approval, fire the call-off PO release.
 * options.instance carries { entity_id: mr_id, ... }
 */
export async function handleMrPostApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const mrId = instance?.entity_id;
    if (!mrId) return;
    const mr = await mrModel.getById(mrId);
    if (!mr) {
      logger.warn({ approvalInstanceId, mrId }, '[mrController.handleMrPostApproval] MR not found');
      return;
    }
    const released = await db.tx(async (t) => {
      // Idempotency guard (audit CO3): lock the MR row and bail if it has
      // already been released. This makes a double-fire (normal completion +
      // propagation auto-complete, both registered for MR APPROVED) a no-op
      // instead of a duplicate PO + double consumption.
      const locked = await t.oneOrNone(
        `SELECT status FROM tbl_material_requisition WHERE id = $1 FOR UPDATE`, [mrId]
      );
      if (!locked) return [];
      if (locked.status === 'po_released') {
        logger.info({ mrId }, '[mrController.handleMrPostApproval] MR already released — skipping duplicate');
        return [];
      }
      await mrModel.setStatus(mrId, 'approved', {}, t);
      const rel = await releaseForMr(mrId, t);
      // releaseForMr already flips MR to po_released after writing the PO links.
      logger.info({ mrId, contracts: rel.length }, '[mrController.handleMrPostApproval] call-off POs released');
      return rel;
    });
    // Notify vendor + raiser and render the call-off PO PDF AFTER commit
    // (audit CO10) — both best-effort, never undo the release.
    if (released && released.length) {
      await notifyCallOffReleased(mr, released);
      for (const { po } of released) {
        await generateCallOffPoPdf(po.id).catch((err) =>
          logger.error({ err, poId: po.id }, '[mrController.handleMrPostApproval] call-off PDF failed'));
      }
    }
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[mrController.handleMrPostApproval]');
    // Surface the failure instead of swallowing it (audit CO11): the approval
    // already committed, so the buyer would otherwise see "approved" with no PO
    // and no signal. Notify the raiser that the call-off release failed.
    try {
      const mrId = options.instance?.entity_id;
      const failedMr = mrId ? await mrModel.getById(mrId) : null;
      if (failedMr?.raised_by) {
        const why = err.code === 'OVER_CONSUMPTION'
          ? 'the contract has insufficient remaining quantity'
          : err.code === 'INVALID_PRICE'
            ? 'a contracted rate is invalid'
            : 'an unexpected error';
        await dispatchNotification({
          userIds: [Number(failedMr.raised_by)],
          category: 'CALL_OFF',
          type: 'CALL_OFF_RELEASE_FAILED',
          title: 'Call-off PO could not be released',
          body: `Requisition ${failedMr.mr_number || ''} was approved but its call-off PO could not be released (${why}). Please review the requisition.`,
          data: { mr_id: mrId, reason: err.code || 'error' },
          actionUrl: '/dashboard/buyer/material-requisitions',
        });
      }
    } catch (notifyErr) {
      logger.error({ notifyErr, approvalInstanceId }, '[mrController.handleMrPostApproval] failure-notify failed');
    }
  }
}

export async function handleMrRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const mrId = instance?.entity_id;
    if (!mrId) return;
    await mrModel.setStatus(mrId, 'rejected', {});
    logger.info({ mrId }, '[mrController.handleMrRejection] MR marked rejected');
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[mrController.handleMrRejection]');
  }
}
