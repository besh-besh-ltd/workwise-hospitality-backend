// ARC v2 — per-ARC permission middleware for the evaluation endpoints.
//
// requireArcPermission(keys) → Express middleware enforcing that the caller
// holds AT LEAST ONE of the given `resource.action` keys (OR logic) in the
// scope of the ARC the request targets. The ARC's OWN hotel/department is the
// authority (loaded from tbl_arc by id) — x-headers are never trusted, per
// the platform's security-first rule: scope derives from the entity row, not
// from anything the client sends.
//
// ArcId resolution (first match wins):
//   · req.params.arcId / req.params.id          (e.g. /:arcId/comm-eval)
//   · req.params.itemId   → tbl_arc_item        (e.g. /items/:itemId/tech-eval)
//   · req.body.clause_id  → clause → eval → item (POST /tech-eval/response)
//   · req.body.response_id → response join chain (POST /tech-eval/score)
//
// Super admins (user_type 8) bypass. The approval decide endpoints do NOT use
// this middleware — the approval engine itself validates the caller is the
// current pending approver, and policy approvers may hold no module roles.

import db from '../config/dbConn.js';
import arcLifecycleModel from '../models/arc_v2/arcLifecycleModel.js';
import rbacModel from '../models/rbacModel.js';
import { logger } from '../util/logger.js';

async function resolveArcId(req) {
  const direct = Number(req.params?.arcId || req.params?.id);
  if (direct) return direct;
  const itemId = Number(req.params?.itemId);
  if (itemId) return arcLifecycleModel.getArcIdForItem(itemId);
  const clauseId = Number(req.body?.clause_id);
  if (clauseId) return arcLifecycleModel.getArcIdForClause(clauseId);
  const responseId = Number(req.body?.response_id);
  if (responseId) return arcLifecycleModel.getArcIdForResponse(responseId);
  return null;
}

export function requireArcPermission(keys = []) {
  return async function arcPermissionGate(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ status: 0, message: 'Authentication required' });

      // Super admin: full access everywhere.
      if (Number(req.user?.user_type) === 8) return next();

      const arcId = await resolveArcId(req);
      if (!arcId) {
        // Nothing to scope against — the controller's own validation will
        // produce the precise 400/404; don't mask it with a permission error.
        return next();
      }

      const arc = await db.oneOrNone(
        `SELECT id, hotel_id, department_id FROM tbl_arc WHERE id = $1`, [arcId]
      );
      if (!arc) return res.status(404).json({ status: 2, message: 'ARC not found' });

      let held = new Set();
      if (arc.hotel_id != null) {
        const rows = await rbacModel.getUserPermissionsForHotels(
          userId, [arc.hotel_id], null, arc.department_id || null
        );
        held = new Set(rows.map((r) => `${r.resource}.${r.action}`));
      }

      if (keys.some((k) => held.has(k))) return next();

      return res.status(403).json({
        status: 0,
        message: "You don't have permission for this action on this rate contract — ask your administrator to grant access.",
      });
    } catch (err) {
      logger.error({ err }, '[arcPermission.requireArcPermission]');
      return res.status(500).json({ status: 3, message: 'Internal error' });
    }
  };
}

export default requireArcPermission;
