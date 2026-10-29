// Purchase Requisitions — company admin: category → reviewing-department map (spec §6.1).
//
// Routes are gated by requireCompanyAdmin (the company.admin capability, or a
// legacy user_type 7 admin). That middleware answers "is this an admin?" but
// not "of what": the administered companies are derived here from the admin's
// own account — the hospitality companies of their buyer company
// (tbl_users.company_id, loaded from the DB by jwtUsr) — the same tenancy edge
// the approval admin screens use (generalController.computeApprovalCompanyScope).
//
// A body `hospitality_company_id` can only SELECT among those companies (an
// admin of a buyer company with several hospitality entities must say which);
// it can never widen: anything else is a 404, exactly like a mapping id of
// another company.

import db from '../../config/dbConn.js';
import { logger } from '../../util/logger.js';
import * as prModel from '../../models/pr/prModel.js';
import { PR_ERR, prError, sendPrError } from '../../services/pr/prErrors.js';

const ok = (res, data, message = 'success') => res.status(200).json({ status: 1, message, data });
const INT4_MAX = 2147483647;
const posInt = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= INT4_MAX ? n : null;
};
const routeNotFound = () => prError(PR_ERR.NOT_FOUND, 'Review routing not found');

/** The hospitality companies this admin administers ([] = none). */
const administered = (req, t = db) => prModel.administeredCompanyIds(Number(req.user?.company_id) || null, t);

/**
 * The one company a mutation is written to: the admin's only company, or the
 * one the body names when it is among theirs. 404 otherwise.
 */
async function mutationCompany(req, t) {
  const companies = await administered(req, t);
  const raw = req.body?.hospitality_company_id;
  if (raw !== undefined && raw !== null && raw !== '') {
    const requested = posInt(raw);
    if (!requested || !companies.includes(requested)) throw routeNotFound();
    return requested;
  }
  if (companies.length === 1) return companies[0];
  if (!companies.length) throw prError(PR_ERR.FORBIDDEN, 'Your account does not administer a company');
  throw prError(PR_ERR.VALIDATION, 'Choose the company this routing is for', [
    { field: 'hospitality_company_id', message: 'Choose a company' },
  ]);
}

const shape = (r) => ({
  id: Number(r.id),
  hospitality_company_id: Number(r.hospitality_company_id),
  category_id: Number(r.category_id),
  category_title: r.category_title,
  parent_title: r.parent_title ?? null,
  department_id: Number(r.department_id),
  department_title: r.department_title,
  created_by: r.created_by == null ? null : Number(r.created_by),
  created_by_name: r.created_by_name ?? null,
  created_at: r.created_at,
});

/** GET /v1/pr/admin/review-routing — the map of every company the admin administers. */
export async function listReviewRouting(req, res) {
  try {
    const companies = await administered(req);
    const rows = companies.length ? await prModel.listReviewRouting(companies) : [];
    return ok(res, rows.map(shape));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * POST /v1/pr/admin/review-routing {category_id, department_id[, hospitality_company_id]}
 * Upsert on (company, category): an existing mapping keeps its id and changes department.
 */
export async function saveReviewRouting(req, res) {
  try {
    const out = await db.tx(async (t) => {
      const companyId = await mutationCompany(req, t);
      const categoryId = posInt(req.body?.category_id);
      const departmentId = posInt(req.body?.department_id);
      const errors = [];
      if (!categoryId || !(await prModel.activeCategoryIds([categoryId], t)).has(categoryId)) {
        errors.push({ field: 'category_id', message: 'Choose an active category' });
      }
      if (!departmentId || !(await prModel.departmentExists(departmentId, t))) {
        errors.push({ field: 'department_id', message: 'Choose a department' });
      }
      if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);
      return prModel.upsertReviewRouting(t, { companyId, categoryId, departmentId, userId: req.user.id });
    });
    return ok(res, { ...shape(out), created: out.created }, out.created ? 'Review routing added' : 'Review routing updated');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** DELETE /v1/pr/admin/review-routing/:mapId — only a mapping of the admin's own companies; else 404. */
export async function deleteReviewRouting(req, res) {
  try {
    const mapId = posInt(req.params.mapId);
    if (!mapId) throw routeNotFound();
    const deleted = await db.tx(async (t) =>
      prModel.deleteReviewRouting(t, { mapId, companyIds: await administered(req, t) }));
    if (!deleted) throw routeNotFound();
    return ok(res, { id: deleted }, 'Review routing removed');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

export default { listReviewRouting, saveReviewRouting, deleteReviewRouting };
