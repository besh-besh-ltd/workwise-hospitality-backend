// ============================================================================
// poDashboardModel.js
// ----------------------------------------------------------------------------
// Read-only query layer powering the four new Purchase Order UI pages:
//   - Dashboard  (GET /po/list, GET /po/dashboard/kpis, GET /po/awaiting)
//   - Detail     (GET /po/:po_id detail-full augmentation)
//   - Tracking   (GET /po/tracking)
//   - Analytics  (GET /po/analytics)
//
// SECURITY: every query is scoped by the caller-supplied `scope` object which
// is derived ONLY from req.user + request headers (see deriveScope() in the
// controller). Tenant ids are NEVER taken from the request body/query. POs are
// scoped through their parent RFQ's hospitality_company_id (the canonical
// tenant key for the hospitality flow); a tbl_company fallback covers legacy
// non-hospitality POs. All queries use parameterized pg-promise placeholders.
// ============================================================================

import db from "../config/dbConn.js";
import { logError } from "../helper/common.js";
import pricingEngine from "../services/pricingEngine.js";
import { buildScopeExistsClause } from "../services/authorizationService.js";

// ---------------------------------------------------------------------------
// Status bucket mapping (UI bucket -> raw po_status enum value[])
// ---------------------------------------------------------------------------
// The UI exposes coarse buckets; the DB stores the fine-grained po_status enum.
//   pending   -> pending_approval + acceptance_pending (both are "awaiting an
//                action before the order is live"; acceptance_pending is the
//                vendor-acceptance gate that follows internal approval)
//   approved  -> approved
//   dispatched-> dispatched
//   delivered -> GRN (goods received == delivered) + completed
//   rejected  -> rejected + rejected_by_vendor
//   draft     -> draft
//   completed -> completed
// 'all' applies no status filter.
// The dashboard list now exposes 4 coarse tabs: All / Action Required /
// Approved / Rejected. "approved" = everything that has passed internal
// approval (and any downstream logistics state); "rejected" = rejected by an
// internal approver OR by the vendor. The finer buckets remain for status_counts
// back-compat. "action-required" is user-specific and handled separately (see
// actionRequiredClause) — it is NOT a status set.
const STATUS_BUCKETS = {
  pending: ["pending_approval", "acceptance_pending"],
  approved: ["approved", "sent", "invoice_raised", "dispatched", "GRN", "completed"],
  dispatched: ["dispatched"],
  delivered: ["GRN"],
  rejected: ["rejected", "rejected_by_vendor"],
  draft: ["draft"],
  completed: ["completed"],
};

// Terminal states excluded from "active" counts.
const TERMINAL_STATUSES = ["completed", "cancelled", "rejected", "rejected_by_vendor"];

// ---------------------------------------------------------------------------
// Scope WHERE fragment builder.
// Returns { clause, values, nextIndex } where `clause` references the PO alias
// `po` and the RFQ alias `rfq` (the caller MUST join tbl_rfq rfq ON rfq.id =
// po.rfq_id).
//
// SECURITY (rewritten — cross-hotel leak, ₹2.8 crore exposure in production):
//   This builder used to take hotel and department ONLY from the optional
//   `x-hotel-ids` / `x-department-id` request headers, and emitted the hotel
//   predicate just `if (scope.hotelIds.length > 0)`. Omitting the header made
//   the hotel filter disappear entirely, degrading the query to "every PO in
//   every company the user is mapped to". There was no process axis at all,
//   and company came from tbl_hospitality_user_mappings, which is
//   company-granular and discards the user's hotel binding.
//
//   Measured on production for user 168 (RBAC scope = company 5 / hotel 6):
//   GET /po/list returned 163 POs across 15 business units / ₹4,86,12,564;
//   the correctly scoped answer is 45 POs / 1 unit / ₹2,06,56,844.
//
//   The authoritative predicate is now buildScopeExistsClause() from
//   authorizationService — the same company × hotel × department × process
//   EXISTS shape the RFQ listing uses (rfqModel.js:3916-3931). Because
//   tbl_rfq_purchase_order has no hotel_id / department_id / process_id
//   columns, the predicate correlates against the JOINED `rfq` alias (and the
//   `aa` ARC alias for call-off POs, which carries all four axes too).
//
//   Headers remain supported but only as a NARROWING facet, intersected with
//   the scoped set — never as the scope source.
//
// Permission choice: the clause matches on `awarding.read` OR `rfq.read` OR
// `boq.read`. `awarding.read` alone would strand the 1 production user who
// holds rfq.read without it; rfq/boq.read alone would strand the 3 who hold
// awarding.read without those. This also matches the documented convention in
// authorizationService.assertCanReadParentRfq(), which deliberately gates PO
// detail on the parent RFQ's read permission because the seeded buyer roles do
// not all carry every entity-specific read permission. All three variants
// enforce the identical 4-axis scope, so the choice widens *who* can see the
// PO list, never *which* rows any one of them sees.
// ---------------------------------------------------------------------------
const PO_SCOPE_PERMISSIONS = ["awarding.read", "rfq.read", "boq.read"];

// OR-composition of the canonical EXISTS clause across the accepted
// permissions for one entity alias. Returns { clause, nextIndex }.
function scopedExistsFor(userId, alias, values, startIndex) {
  let i = startIndex;
  const clauses = [];
  for (const perm of PO_SCOPE_PERMISSIONS) {
    const built = buildScopeExistsClause(userId, perm, alias, i);
    clauses.push(built.clause);
    values.push(...built.params);
    i += built.paramsConsumed;
  }
  return { clause: `(${clauses.join(" OR ")})`, nextIndex: i };
}

function buildScopeClause(scope, values, startIndex) {
  let i = startIndex;
  const parts = [];
  const hcIds = scope.hospitalityCompanyIds;

  // Header-derived hotel / department facets. These NARROW an already-scoped
  // set; they are applied in both branches below and can never widen it.
  const narrowFor = (alias, conds) => {
    if (scope.hotelIds && scope.hotelIds.length > 0) {
      const hIdx = i++;
      values.push(scope.hotelIds);
      conds.push(`${alias}.hotel_id = ANY($${hIdx}::int[])`);
    }
    if (scope.departmentId) {
      const dIdx = i++;
      values.push(scope.departmentId);
      conds.push(`${alias}.department_id = $${dIdx}`);
    }
  };

  // Legacy fallback: the user has no hospitality mappings at all, so there is
  // no RBAC scope row to correlate against — scope on the buyer company id
  // stored directly on the PO header. Previously this branch returned early
  // and DROPPED the hotel/department facets entirely; they are now applied.
  if (Array.isArray(hcIds) && hcIds.length === 0) {
    parts.push(`po.company_id = $${i++}`);
    values.push(scope.companyId);
    const legacyConds = [];
    narrowFor("rfq", legacyConds);
    if (legacyConds.length) parts.push(legacyConds.join(" AND "));
    return { clause: parts.join(" AND "), values, nextIndex: i };
  }

  // Super admin (hcIds === null) keeps the "all companies" behaviour: no
  // per-row scope predicate, only the optional narrowing facets.
  if (hcIds === null) {
    const adminConds = [];
    narrowFor("rfq", adminConds);
    parts.push(adminConds.length ? adminConds.join(" AND ") : "TRUE");
    return { clause: parts.join(" AND "), values, nextIndex: i };
  }

  // Scoped path. RFQ-backed POs correlate through the joined `rfq` alias;
  // call-off POs (no rfq_id) correlate through their ARC via a self-contained
  // EXISTS, so this works regardless of the caller's join block (CO8).
  const rfqScoped = scopedExistsFor(scope.userId, "rfq", values, i);
  i = rfqScoped.nextIndex;
  const rfqConds = [rfqScoped.clause];
  narrowFor("rfq", rfqConds);

  const arcScoped = scopedExistsFor(scope.userId, "aa", values, i);
  i = arcScoped.nextIndex;
  const arcConds = [arcScoped.clause];
  narrowFor("aa", arcConds);

  parts.push(`(
    (${rfqConds.join(" AND ")})
    OR (po.is_call_off = TRUE AND EXISTS (
      SELECT 1 FROM tbl_arc_contract cc
        JOIN tbl_arc aa ON aa.id = cc.arc_id
       WHERE cc.id = po.arc_contract_id AND ${arcConds.join(" AND ")}
    ))
  )`);

  return { clause: parts.join(" AND "), values, nextIndex: i };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function initialsOf(name) {
  if (!name || typeof name !== "string") return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function daysBetween(from, to = new Date()) {
  if (!from) return null;
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((to.getTime() - start) / 86400000));
}

// Current pending-step approver info for a set of approval instances.
// Returns Map<instance_id, { step_order, step_label, approvers:[{user_id,name,initials}] }>
// containing ONLY instances that are currently PENDING with a pending current
// step. Used to show "on L2 — <names>" on the list and to gate the detail
// action card on whether THIS user is actually the current approver.
async function fetchCurrentApproverInfo(instanceIds) {
  const ids = (instanceIds || []).filter((x) => Number.isInteger(x));
  if (ids.length === 0) return new Map();
  const rows = await db.any(
    `SELECT tai.id AS instance_id, tai.current_step,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT('user_id', sa.approver_user_id, 'name', u.name)
                ORDER BY sa.id
              ) FILTER (WHERE sa.approver_user_id IS NOT NULL),
              '[]'
            ) AS approvers
     FROM tbl_approval_instances tai
     JOIN tbl_approval_instance_steps st
       ON st.approval_instance_id = tai.id
      AND st.step_order = tai.current_step
      AND st.status = 'PENDING'
     LEFT JOIN tbl_approval_step_approvers sa
       ON sa.approval_instance_step_id = st.id
      AND sa.status = 'PENDING'
     LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
     WHERE tai.id = ANY($1::int[]) AND tai.status = 'PENDING'
     GROUP BY tai.id, tai.current_step`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) {
    const approvers = (Array.isArray(r.approvers) ? r.approvers : []).map((a) => ({
      user_id: a.user_id,
      name: a.name,
      initials: initialsOf(a.name),
    }));
    map.set(r.instance_id, {
      step_order: r.current_step,
      step_label: `L${r.current_step}`,
      approvers,
    });
  }
  return map;
}

// Whether the user holds awarding.create within scope — decides if "Initiate
// PO" items belong in their Action Required bucket. Company is matched when a
// hospitality scope is present; otherwise any awarding.create grant qualifies.
// Best-effort + read-only: if the permission catalogue differs this returns
// false and Action Required simply falls back to approval-only items.
async function userHasAwardingCreate(scope) {
  try {
    const row = await db.oneOrNone(
      `SELECT EXISTS(
         SELECT 1
         FROM tbl_user_role_scopes urs
         JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
         JOIN tbl_permissions p ON p.id = rp.permission_id
         WHERE urs.user_id = $1
           AND p.resource = 'awarding' AND p.action = 'create'
           AND ($2::int[] IS NULL OR urs.company_id = ANY($2::int[]))
       ) AS has`,
      [scope.userId, Array.isArray(scope.hospitalityCompanyIds) ? scope.hospitalityCompanyIds : null]
    );
    return !!(row && row.has);
  } catch (e) {
    return false;
  }
}

// SQL fragment (references po + tai + $1=userId) matching POs that need THIS
// user's action: they are the current pending approver, or — when they can
// create POs — the PO is in an initiatable state (draft / approved-not-sent).
function actionRequiredClause(hasCreate) {
  const approverExists = `(
    po.approval_instance_id IS NOT NULL AND tai.status = 'PENDING' AND EXISTS (
      SELECT 1
      FROM tbl_approval_step_approvers sa
      JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
      WHERE st.approval_instance_id = po.approval_instance_id
        AND st.step_order = tai.current_step
        AND st.status = 'PENDING'
        AND sa.status = 'PENDING'
        AND sa.approver_user_id = $1
    )
  )`;
  const initiatable = hasCreate ? ` OR po.status IN ('draft', 'approved')` : "";
  return `(${approverExists}${initiatable})`;
}

// Shared SELECT columns + joins used by list / awaiting / tracking. The query
// computes, per PO:
//   - aggregated quantity + item count + first product name (for items_label)
//   - finalized vendor display name
//   - initiator name
//   - awaiting_me: is the logged-in user a PENDING approver of the current step
//   - waiting_days: days since the current pending step's creation
// All approval logic uses the NEW workflow (tbl_approval_instances + steps);
// legacy-hierarchy POs simply report awaiting_me=false / waiting_days=null
// because the new pages target the hospitality (new-workflow) flow.
function poCoreSelect(userParamIdx) {
  return `
    po.id,
    po.po_number,
    po.rfq_id,
    po.status,
    po.total_value,
    po.created_at,
    po.finalized_vendor_id,
    po.approval_instance_id,
    rfq.rfq_no,
    rfq.title AS rfq_title,
    COALESCE(VC.company_name, VENDOR.organization_name, VENDOR.name) AS vendor_name,
    INITIATOR.id   AS initiator_id,
    INITIATOR.name AS initiator_name,
    (
      SELECT COALESCE(SUM(pop.quantity), 0)::double precision
      FROM tbl_purchase_order_product pop
      WHERE pop.purchase_order_id = po.id
    ) AS quantity,
    (
      SELECT COUNT(*)::int
      FROM tbl_purchase_order_product pop
      WHERE pop.purchase_order_id = po.id
    ) AS items_count,
    (
      SELECT pv.name
      FROM tbl_purchase_order_product pop
      JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
      JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      WHERE pop.purchase_order_id = po.id
      ORDER BY pop.id ASC
      LIMIT 1
    ) AS first_item_name,
    CASE
      WHEN po.approval_instance_id IS NOT NULL AND tai.status = 'PENDING' THEN (
        SELECT EXISTS(
          SELECT 1
          FROM tbl_approval_step_approvers sa
          JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
          WHERE st.approval_instance_id = po.approval_instance_id
            AND st.step_order = tai.current_step
            AND st.status = 'PENDING'
            AND sa.status = 'PENDING'
            AND sa.approver_user_id = $${userParamIdx}
        )
      )
      ELSE FALSE
    END AS awaiting_me,
    CASE
      WHEN po.approval_instance_id IS NOT NULL AND tai.status = 'PENDING' THEN (
        SELECT MIN(st.created_at)
        FROM tbl_approval_instance_steps st
        WHERE st.approval_instance_id = po.approval_instance_id
          AND st.step_order = tai.current_step
          AND st.status = 'PENDING'
      )
      ELSE NULL
    END AS current_step_since`;
}

function poCoreJoins() {
  return `
    FROM tbl_rfq_purchase_order po
    LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
    JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
    LEFT JOIN tbl_company VC ON VC.id = VENDOR.company_id
    LEFT JOIN tbl_users INITIATOR ON INITIATOR.id = po.initiated_by
    LEFT JOIN tbl_approval_instances tai ON tai.id = po.approval_instance_id`;
}

function mapPoCoreRow(r) {
  const vendorName = r.vendor_name || "Unknown Vendor";
  const itemsCount = Number(r.items_count) || 0;
  let itemsLabel = r.first_item_name || "—";
  if (itemsCount > 1) itemsLabel = `${r.first_item_name || "Item"} · +${itemsCount - 1} more`;
  const isPending = r.status === "pending_approval" || r.status === "acceptance_pending";

  return {
    id: r.id,
    po_number: r.po_number,
    rfq_id: r.rfq_id,
    rfq_no: r.rfq_no != null ? String(r.rfq_no) : null,
    rfq_title: r.rfq_title || null,
    status: r.status,
    vendor: { id: r.finalized_vendor_id, name: vendorName, short: initialsOf(vendorName) },
    items_label: itemsLabel,
    items_count: itemsCount,
    quantity: Number(r.quantity) || 0,
    total_value: r.total_value != null ? Number(r.total_value) : 0,
    initiator: r.initiator_id
      ? { id: r.initiator_id, name: r.initiator_name, initials: initialsOf(r.initiator_name) }
      : null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    awaiting_me: !!r.awaiting_me,
    waiting_days: isPending ? daysBetween(r.current_step_since || r.created_at) : null,
    flags: [],
  };
}

// ===========================================================================
// 1) GET /po/list
// ===========================================================================
export async function getPOList(scope, { status = "all", search = "", page = 1, limit = 20, sort = "newest" } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pg - 1) * lim;

  const conditions = [];
  const values = [];
  // $1 reserved for the logged-in user id (used inside poCoreSelect + the
  // action-required clause).
  values.push(scope.userId);
  let idx = 2;

  const scoped = buildScopeClause(scope, values, idx);
  conditions.push(scoped.clause);
  idx = scoped.nextIndex;

  // awarding.create gate is needed both for the action-required tab and the
  // action_required count in status_counts.
  const hasCreate = await userHasAwardingCreate(scope);

  // Status filter. "action-required" is the user-specific actionable view
  // (current approver OR initiatable when they can create POs); the rest map to
  // raw po_status buckets.
  if (status === "action-required") {
    conditions.push(actionRequiredClause(hasCreate));
  } else if (status && status !== "all" && STATUS_BUCKETS[status]) {
    conditions.push(`po.status = ANY($${idx++}::po_status[])`);
    values.push(STATUS_BUCKETS[status]);
  }

  // Free-text search across po_number, rfq_no, vendor name, product names
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(`(
      po.po_number ILIKE $${idx}
      OR rfq.rfq_no::text ILIKE $${idx}
      OR rfq.title ILIKE $${idx}
      OR COALESCE(VC.company_name, VENDOR.organization_name, VENDOR.name) ILIKE $${idx}
      OR EXISTS (
        SELECT 1 FROM tbl_purchase_order_product pop
        JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
        JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
        WHERE pop.purchase_order_id = po.id AND pv.name ILIKE $${idx}
      )
    )`);
    values.push(term);
    idx++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const orderClause = sort === "oldest" ? "po.created_at ASC" : "po.created_at DESC";

  const dataQuery = `
    SELECT ${poCoreSelect(1)}
    ${poCoreJoins()}
    ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${idx} OFFSET $${idx + 1}`;

  const rows = await db.any(dataQuery, [...values, lim, offset]);

  const countRow = await db.one(
    `SELECT COUNT(*)::int AS total
     ${poCoreJoins()}
     ${whereClause}`,
    values
  );

  const statusCounts = await getStatusCounts(scope, hasCreate);

  // Attach current pending-step approver info (step label + approver names) so
  // the list can show "on L2 — <names>" under pending rows.
  const data = rows.map(mapPoCoreRow);
  const pendingInstanceIds = rows
    .filter((r) => r.approval_instance_id)
    .map((r) => r.approval_instance_id);
  const approverInfo = await fetchCurrentApproverInfo(pendingInstanceIds);
  for (let i = 0; i < data.length; i++) {
    const info = approverInfo.get(rows[i].approval_instance_id);
    data[i].current_step_label = info ? info.step_label : null;
    data[i].current_approvers = info ? info.approvers : [];
  }

  return {
    data,
    total_items: countRow.total,
    page: pg,
    limit: lim,
    status_counts: statusCounts,
  };
}

// Per-bucket counts for the list page tabs (scope only, ignores status/search).
async function getStatusCounts(scope, hasCreate = false) {
  const values = [];
  const scoped = buildScopeClause(scope, values, 1);
  const rows = await db.any(
    `SELECT po.status, COUNT(*)::int AS cnt
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${scoped.clause}
     GROUP BY po.status`,
    values
  );

  const byStatus = {};
  let all = 0;
  for (const r of rows) {
    byStatus[r.status] = r.cnt;
    all += r.cnt;
  }
  const sumBucket = (bucket) => STATUS_BUCKETS[bucket].reduce((s, st) => s + (byStatus[st] || 0), 0);

  // Action-required count: user-specific, so it needs $1=userId + the same
  // scope clause shifted by one param.
  const arValues = [scope.userId];
  const arScoped = buildScopeClause(scope, arValues, 2);
  const arRow = await db.one(
    `SELECT COUNT(*)::int AS cnt
     ${poCoreJoins()}
     WHERE ${arScoped.clause} AND ${actionRequiredClause(hasCreate)}`,
    arValues
  );

  return {
    all,
    action_required: arRow.cnt,
    pending: sumBucket("pending"),
    approved: sumBucket("approved"),
    dispatched: sumBucket("dispatched"),
    delivered: sumBucket("delivered"),
    rejected: sumBucket("rejected"),
    draft: sumBucket("draft"),
    completed: sumBucket("completed"),
  };
}

// ===========================================================================
// 2) GET /po/dashboard/kpis
// ===========================================================================
export async function getDashboardKpis(scope) {
  const values = [scope.userId];
  const scoped = buildScopeClause(scope, values, 2);
  const clause = scoped.clause;

  // One aggregate pass over the scoped POs.
  const agg = await db.one(
    `SELECT
        COUNT(*) FILTER (WHERE po.status <> ALL($${scoped.nextIndex}::po_status[]))::int AS active_count,
        COUNT(*) FILTER (WHERE po.status = 'dispatched')::int AS in_transit,
        -- Vendor acceptance (Sr 221): pending = awaiting vendor response;
        -- accepted = vendor explicitly accepted (status approved + action stamped).
        COUNT(*) FILTER (WHERE po.status = 'acceptance_pending')::int AS vendor_acceptance_pending,
        COUNT(*) FILTER (WHERE po.status = 'approved' AND po.vendor_action_at IS NOT NULL)::int AS vendor_accepted,
        COUNT(*) FILTER (
          WHERE po.status = 'approved'
            AND date_trunc('month', po.updated_at) = date_trunc('month', NOW())
        )::int AS approved_this_month,
        COUNT(*) FILTER (
          WHERE po.status = 'approved'
            AND date_trunc('month', po.updated_at) = date_trunc('month', NOW() - INTERVAL '1 month')
        )::int AS approved_last_month,
        COALESCE(SUM(po.total_value) FILTER (
          WHERE date_trunc('month', po.created_at) = date_trunc('month', NOW())
        ), 0) AS total_value_mtd,
        COALESCE(SUM(po.total_value) FILTER (
          WHERE date_trunc('month', po.created_at) = date_trunc('month', NOW() - INTERVAL '1 month')
        ), 0) AS total_value_last_month
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}`,
    [...values, TERMINAL_STATUSES]
  );

  // awaitingYou + oldest waiting days: POs where the logged-in user is a
  // PENDING approver of the current step.
  const awaiting = await db.one(
    `SELECT
        COUNT(*)::int AS awaiting_you,
        COALESCE(MAX(
          EXTRACT(EPOCH FROM (NOW() - step_since)) / 86400
        ), 0)::int AS oldest_days
     FROM (
        SELECT po.id,
          (
            SELECT MIN(st.created_at)
            FROM tbl_approval_instance_steps st
            WHERE st.approval_instance_id = po.approval_instance_id
              AND st.step_order = tai.current_step
              AND st.status = 'PENDING'
          ) AS step_since
        FROM tbl_rfq_purchase_order po
        JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
        JOIN tbl_approval_instances tai ON tai.id = po.approval_instance_id
        WHERE ${clause}
          AND tai.status = 'PENDING'
          AND EXISTS (
            SELECT 1
            FROM tbl_approval_step_approvers sa
            JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
            WHERE st.approval_instance_id = po.approval_instance_id
              AND st.step_order = tai.current_step
              AND st.status = 'PENDING'
              AND sa.status = 'PENDING'
              AND sa.approver_user_id = $1
          )
     ) q`,
    values
  );

  // avgDeliveryDays: APPROXIMATED. Avg days between PO creation and the GRN
  // document upload (delivery proxy) for delivered/completed POs in scope.
  const delivery = await db.oneOrNone(
    `SELECT COALESCE(AVG(
        EXTRACT(EPOCH FROM (grn.created_at - po.created_at)) / 86400
      ), 0)::numeric(10,1) AS avg_delivery_days
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     JOIN LATERAL (
       SELECT MIN(d.created_at) AS created_at
       FROM tbl_purchase_order_document d
       WHERE d.purchase_order_id = po.id AND d.document_type = 'grn'
     ) grn ON TRUE
     WHERE ${clause}
       AND grn.created_at IS NOT NULL`,
    values
  );

  const pctDelta = (curr, prev) => {
    if (!prev || prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  };

  return {
    activeCount: agg.active_count,
    awaitingYou: awaiting.awaiting_you,
    awaitingOldestDays: awaiting.oldest_days,
    inTransit: agg.in_transit,
    vendorAccepted: agg.vendor_accepted,
    vendorAcceptancePending: agg.vendor_acceptance_pending,
    avgDeliveryDays: delivery ? Number(delivery.avg_delivery_days) : 0,
    approvedThisMonth: agg.approved_this_month,
    approvedDeltaPct: pctDelta(agg.approved_this_month, agg.approved_last_month),
    totalValueMTD: Number(agg.total_value_mtd) || 0,
    totalValueDeltaPct: pctDelta(Number(agg.total_value_mtd), Number(agg.total_value_last_month)),
  };
}

// ===========================================================================
// 3) GET /po/awaiting
// ===========================================================================
export async function getAwaitingPOs(scope) {
  const values = [scope.userId];
  const scoped = buildScopeClause(scope, values, 2);

  const rows = await db.any(
    `SELECT ${poCoreSelect(1)}
     ${poCoreJoins()}
     WHERE ${scoped.clause}
       AND po.approval_instance_id IS NOT NULL
       AND tai.status = 'PENDING'
       AND EXISTS (
         SELECT 1
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
         WHERE st.approval_instance_id = po.approval_instance_id
           AND st.step_order = tai.current_step
           AND st.status = 'PENDING'
           AND sa.status = 'PENDING'
           AND sa.approver_user_id = $1
       )
     ORDER BY po.created_at ASC`,
    values
  );

  return {
    data: rows.map((r) => {
      const m = mapPoCoreRow(r);
      return {
        id: m.id,
        po_number: m.po_number,
        rfq_no: m.rfq_no,
        rfq_title: m.rfq_title,
        vendor: m.vendor,
        items_count: m.items_count,
        items_label: m.items_label,
        total_value: m.total_value,
        waiting_days: m.waiting_days,
        flags: m.flags,
      };
    }),
  };
}

// ===========================================================================
// 4) Detail-full augmentation (merged into GET /po/:po_id response)
// ===========================================================================
// Loads the structured contract-shaped detail object for the PO Detail page.
// Returns null if the PO is out of scope (caller maps to 404 to avoid leaking
// existence). Reuses tbl_approval_instances for the workflow timeline.
export async function getPODetailFull(po_id, scope) {
  const poId = parseInt(po_id, 10);
  if (!poId) return null;

  // Load + scope-verify the PO. Call-off POs have rfq_id NULL — their scope,
  // company, BU and department come from the ARC contract instead, so we
  // LEFT JOIN the RFQ and COALESCE every RFQ-vs-ARC field.
  const values = [poId];
  let scopeClause;
  let i = 2;
  if (scope.vendorId) {
    // Vendor-scoped read (GET /po/vendor/detail/:po_id): the buyer company gate
    // does NOT apply — the vendor authenticates against their OWN PO. We skip the
    // company/hospitality filter here (TRUE keeps the SQL valid + param indexing
    // intact) and instead require po.finalized_vendor_id === scope.vendorId after
    // the row loads (see the guard below), returning null on mismatch so the
    // controller 404s without leaking the existence of another vendor's PO.
    scopeClause = "TRUE";
  } else if (Array.isArray(scope.hospitalityCompanyIds) && scope.hospitalityCompanyIds.length === 0) {
    // No hospitality mappings → legacy buyer-company gate.
    scopeClause = `po.company_id = $${i++}`;
    values.push(scope.companyId);
  } else {
    // SECURITY: this endpoint hand-rolls its own scope clause rather than
    // calling buildScopeClause(), so fixing the shared builder does NOT reach
    // it — it needs the same 4-axis treatment applied here. Both the `rfq` and
    // `arc` aliases are in the FROM below (a PO is backed by one or the other),
    // so the canonical EXISTS is evaluated against each and OR'd.
    // null hospitalityCompanyIds = super admin → no per-row scope predicate.
    const conds = [];
    if (Array.isArray(scope.hospitalityCompanyIds)) {
      const dRfq = scopedExistsFor(scope.userId, "rfq", values, i);
      i = dRfq.nextIndex;
      const dArc = scopedExistsFor(scope.userId, "arc", values, i);
      i = dArc.nextIndex;
      conds.push(`(${dRfq.clause} OR ${dArc.clause})`);
    }
    if (scope.hotelIds && scope.hotelIds.length > 0) {
      conds.push(`COALESCE(rfq.hotel_id, arc.hotel_id) = ANY($${i++}::int[])`);
      values.push(scope.hotelIds);
    }
    if (scope.departmentId) {
      conds.push(`COALESCE(rfq.department_id, arc.department_id) = $${i++}`);
      values.push(scope.departmentId);
    }
    scopeClause = conds.length ? conds.join(' AND ') : 'TRUE';
  }
  const po = await db.oneOrNone(
    `SELECT po.*,
            rfq.rfq_no, rfq.title AS rfq_title, rfq.created_by AS rfq_created_by,
            COALESCE(rfq.hospitality_company_id, arc.hospitality_company_id) AS hospitality_company_id,
            COALESCE(rfq.hotel_id, arc.hotel_id) AS hotel_id,
            COALESCE(rfq.department_id, arc.department_id) AS department_id,
            COALESCE(THC.name, ATHC.name, TC.company_name) AS company_name,
            COALESCE(THCH.name, ATHCH.name) AS business_unit,
            COALESCE(DEPT.title, ADEPT.title) AS department_name,
            COALESCE(THC.gst, ATHC.gst) AS hosp_gst, COALESCE(THC.pan, ATHC.pan) AS hosp_pan,
            COALESCE(THC.bank_name, ATHC.bank_name) AS hosp_bank,
            COALESCE(THC.bank_account_number, ATHC.bank_account_number) AS hosp_bank_acct,
            COALESCE(VC.company_name, VENDOR.organization_name, VENDOR.name) AS vendor_name,
            VENDOR.email AS vendor_email, VENDOR.mobile AS vendor_phone,
            VC.gstin AS vendor_gstin,
            INI.name AS initiator_name,
            tai.status AS instance_status, tai.completed_at AS instance_completed_at,
            tai.created_at AS instance_created_at,
            po.auto_initiated,
            arc.arc_number, arc.title AS arc_title, arc.id AS arc_id,
            mr.mr_number AS source_mr_number
     FROM tbl_rfq_purchase_order po
     LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     JOIN tbl_users VENDOR ON VENDOR.id = po.finalized_vendor_id
     LEFT JOIN tbl_company VC ON VC.id = VENDOR.company_id
     LEFT JOIN tbl_hospitality_companies THC ON THC.id = rfq.hospitality_company_id
     LEFT JOIN tbl_hospitality_company_hotels THCH ON THCH.id = rfq.hotel_id
     LEFT JOIN tbl_company TC ON TC.id = po.company_id
     LEFT JOIN tbl_department DEPT ON DEPT.id = rfq.department_id
     LEFT JOIN tbl_arc_contract acon ON acon.id = po.arc_contract_id
     LEFT JOIN tbl_arc arc ON arc.id = acon.arc_id
     LEFT JOIN tbl_hospitality_companies ATHC ON ATHC.id = arc.hospitality_company_id
     LEFT JOIN tbl_hospitality_company_hotels ATHCH ON ATHCH.id = arc.hotel_id
     LEFT JOIN tbl_department ADEPT ON ADEPT.id = arc.department_id
     LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
     LEFT JOIN tbl_users INI ON INI.id = po.initiated_by
     LEFT JOIN tbl_approval_instances tai ON tai.id = po.approval_instance_id
     WHERE po.id = $1 AND ${scopeClause}`,
    values
  );

  if (!po) return null;

  // Vendor-scope authorization guard: a vendor may only read POs whose
  // finalized_vendor_id is themselves. Mismatch → null (controller 404s).
  if (scope.vendorId && Number(po.finalized_vendor_id) !== Number(scope.vendorId)) return null;

  // Items. Call-off POs hold their lines in tbl_arc_callof_po (no
  // tbl_purchase_order_product rows); regular POs use the RFQ product join.
  const items = po.is_call_off
    ? await db.any(
        `SELECT pv.name AS name, ai.spec_text AS spec,
                cp.quantity, ai.uom AS unit, cp.price_applied AS unit_price,
                (cp.quantity * cp.price_applied) AS total_price,
                cl.gst_pct AS gst_pct, NULL AS hsn, NULL AS charges_meta
           FROM tbl_arc_callof_po cp
           JOIN tbl_arc_contract_line cl ON cl.id = cp.arc_contract_line_id
           JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
           JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
          WHERE cp.po_id = $1
          ORDER BY cp.id ASC`,
        [poId]
      )
    : await db.any(
        `SELECT pv.name AS name,
                rp.comment AS buyer_comment,
                (
                  SELECT s.value FROM tbl_rfq_products_specs s
                  WHERE s.product_variant_id = rp.product_variant_id
                    AND s.rfq_id = rp.rfq_id
                    AND s.variant = rp.variant
                    AND LOWER(s.title) = 'size'
                  LIMIT 1
                ) AS product_size,
                (
                  SELECT s.value FROM tbl_rfq_products_specs s
                  WHERE s.product_variant_id = rp.product_variant_id
                    AND s.rfq_id = rp.rfq_id
                    AND s.variant = rp.variant
                    AND LOWER(s.title) = 'spec'
                  LIMIT 1
                ) AS product_spec,
                pop.quantity, pop.unit, pop.unit_price, pop.total_price,
                pop.charges_meta, NULL AS gst_pct,
                (
                  SELECT h.hsn_code FROM tbl_purchase_order_hsn_mapping h
                  WHERE h.po_id = po.id AND h.rfq_item_id = pop.rfq_product_id
                  ORDER BY h.id DESC LIMIT 1
                ) AS hsn
         FROM tbl_purchase_order_product pop
         JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
         JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE pop.purchase_order_id = $1
         ORDER BY pop.id ASC`,
        [poId]
      );

  const mappedItems = items.map((it) => {
    const cm = it.charges_meta || {};
    const gst = it.gst_pct != null ? Number(it.gst_pct) : (cm.tax != null ? Number(cm.tax) : null);
    return {
      name: it.name,
      size: it.product_size || null,
      spec: it.product_spec || null,
      comment: it.buyer_comment || null,
      hsn: it.hsn || null,
      quantity: Number(it.quantity) || 0,
      unit: it.unit || null,
      unit_price: Number(it.unit_price) || 0,
      gst,
      amount: Number(it.total_price) || 0,
      charges_meta: Object.keys(cm).length ? cm : null,
    };
  });

  // Pricing roll-up. subtotal = sum of line basic (qty*unit_price); tax derived
  // from charges_meta; freight/insurance NOT modelled separately -> 0 each;
  // total = authoritative po.total_value.
  let subtotal = 0;
  let tax = 0;
  for (const it of items) {
    const basic = (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
    subtotal += basic;
    const cm = it.charges_meta || {};
    if (cm.tax != null) {
      tax += cm.tax_mode === "absolute" ? Number(cm.tax) || 0 : (basic * (Number(cm.tax) || 0)) / 100;
    } else if (it.gst_pct != null) {
      tax += (basic * (Number(it.gst_pct) || 0)) / 100;
    }
  }
  const pricing = {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    freight: 0, // not modelled as a separate header field
    insurance: 0, // not modelled
    total: po.total_value != null ? Number(po.total_value) : 0,
  };

  // Documents: tbl_purchase_order_document + the PO PDF itself.
  const docRows = await db.any(
    `SELECT id, document_type, document_url, created_at
     FROM tbl_purchase_order_document
     WHERE purchase_order_id = $1
     ORDER BY created_at DESC`,
    [poId]
  );
  const docs = docRows.map((d) => ({
    name: `${d.document_type === "grn" ? "GRN" : "Invoice"} document`,
    type: d.document_type,
    size: null, // file size not stored
    kind: d.document_type,
    url: d.document_url,
  }));
  if (po.po_pdf_url) {
    docs.unshift({ name: `PO ${po.po_number}.pdf`, type: "po", size: null, kind: "po", url: po.po_pdf_url });
  }

  // Payment terms from milestones.
  const milestones = await db.any(
    `SELECT id, milestone_name, amount, amount_mode, due_date
     FROM tbl_payment_milestone
     WHERE po_id = $1 AND status <> 'deleted'
     ORDER BY due_date ASC, id ASC`,
    [poId]
  );
  const totalForPct = po.total_value != null ? Number(po.total_value) : 0;
  const payment_terms = milestones.map((m, i) => {
    let pct = null;
    let amount = null;
    if (m.amount_mode === "percentage") {
      pct = m.amount != null ? Number(m.amount) : null;
      amount = pct != null && totalForPct ? Math.round((totalForPct * pct) / 100) : null;
    } else {
      amount = m.amount != null ? Number(m.amount) : null;
      pct = amount != null && totalForPct ? Math.round((amount / totalForPct) * 100) : null;
    }
    return {
      num: i + 1,
      name: m.milestone_name,
      pct,
      amount,
      due: m.due_date ? new Date(m.due_date).toISOString().slice(0, 10) : null,
    };
  });

  // Full lifecycle audit trail (internal approval → vendor → invoice →
  // dispatch → GRN → completion) + an enriched activity feed.
  const { workflow, activity } = await buildAuditTrail(po, docRows, { isVendorView: !!scope.vendorId });

  // Whose turn is it right now? Strictly: is the LOGGED-IN user a pending
  // approver of the CURRENT pending step. The detail page gates its action card
  // on this — NOT merely on "status is pending" — so we never tell a user their
  // approval is required when it is someone else's step (or already done).
  let awaiting_me = false;
  let current_step_label = null;
  let current_approvers = [];
  if (po.approval_instance_id) {
    const info = (await fetchCurrentApproverInfo([po.approval_instance_id])).get(po.approval_instance_id);
    if (info) {
      current_step_label = info.step_label;
      current_approvers = info.approvers;
      // scope.userId is intentionally absent on the vendor path, so awaiting_me is
      // always false for vendors (correct — vendors aren't approval participants).
      awaiting_me = info.approvers.some((a) => a.user_id === scope.userId);
    }
  }

  // Commercial comparison + technical evaluation are RFQ-sourced. Call-off POs
  // have no RFQ (their award came from the ARC); skip these cleanly.
  // Confidentiality: buildComparison returns EVERY competing vendor's quote
  // amounts, so on the vendor path (scope.vendorId set) we must NOT expose it —
  // gate to [] to avoid leaking competitors' prices to the vendor.
  const comparison = po.is_call_off || scope.vendorId ? [] : await buildComparison(po);

  // Technical evaluation: per PO product, the finalized vendor's clause-wise
  // marks, the percentage they scored, and who approved the evaluation.
  const tech_eval = po.is_call_off ? null : await buildTechEval(po);

  // RFQ summary numbers (vendors participated = distinct quote authors;
  // vendors_invited + rounds are not cleanly derivable in scope -> null).
  const rfqStats = po.rfq_id
    ? await db.oneOrNone(
        `SELECT COUNT(DISTINCT q.created_by)::int AS participated
         FROM tbl_quotes q WHERE q.rfq_id = $1 AND q.is_regret = 0`,
        [po.rfq_id]
      )
    : null;
  const rfqCreator = po.rfq_created_by
    ? await db.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [po.rfq_created_by])
    : null;

  // --- Every document on this PO, grouped by where it came from -------------
  //
  // An approver deciding approve-vs-reject needs all the paperwork in ONE
  // place. The detail page used to scatter it: the PO pdf / GRN / invoice sat
  // in a prominent card mid-page, while the RFQ, quote and tech-eval files sat
  // in a pair of cards at the very bottom of the right-hand aside — below the
  // fold on most screens. Reviewers were missing that aside entirely and
  // rejecting POs for paperwork that was on the page all along.
  //
  // These are four genuinely DIFFERENT document classes, not one class shown
  // twice, so consolidating means grouping rather than dropping either surface.
  // The group is recorded here, at the point each row is read, because only
  // this layer knows the provenance — every group below comes from a different
  // table, and a filename on the client cannot tell you which.
  //
  // RFQ/quote/tech groups are only available for RFQ-sourced POs; a call-off PO
  // is awarded from an ARC and has no rfq_id, so it carries PO documents alone.
  let rfqGroupFiles = [];
  let vendorQuoteGroupFiles = [];
  let technicalGroupFiles = [];

  if (po.rfq_id) {
    const FILE_LABEL = {
      TDS: "TDS",
      QAP: "QAP",
      SPEC: "Spec",
      term_and_condition: "T&C",
      DOC: "Document",
    };
    const toLabel = (type) => FILE_LABEL[type] || type || "File";

    const [rfqLevelRows, rfqProductRows, buyerClauseFileRows, vendorProductDocRows, vendorEvalRows] = await Promise.all([
      // Buyer: RFQ-level T&C files
      db.any(
        `SELECT file_url AS url, file_type
         FROM tbl_rfq_files
         WHERE rfq_id = $1
         ORDER BY id ASC`,
        [po.rfq_id]
      ),
      // Buyer: per-product TDS / QAP / SPEC files
      db.any(
        `SELECT rpf.file_url AS url, rpf.file_type, pv.name AS product_name
         FROM tbl_rfq_product_files rpf
         JOIN tbl_rfq_products rp ON rp.id = rpf.rfq_product_id
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE rp.rfq_id = $1
         ORDER BY rp.id, rpf.id`,
        [po.rfq_id]
      ),
      // Buyer: per-product tech-eval clause files
      db.any(
        `SELECT f.file_url AS url, pv.name AS product_name
         FROM tbl_rfq_product_tech_evaluation_clauses_files f
         JOIN tbl_rfq_product_tech_evaluation_clauses c
              ON c.id = f.tbl_rfq_product_tech_evaluation_clauses_id
         JOIN tbl_rfq_product_tech_evaluation te
              ON te.id = c.tbl_rfq_product_tech_evaluation_id
         JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE rp.rfq_id = $1
         ORDER BY rp.id, f.id`,
        [po.rfq_id]
      ),
      // Vendor: per-product quote item files
      db.any(
        `SELECT qif.file_url AS url, qif.file_type, pv.name AS product_name
         FROM tbl_quote_item_files qif
         JOIN tbl_quote_items qi ON qi.id = qif.quote_item_id
         JOIN tbl_purchase_order_product pop
              ON pop.quote_id = qi.id AND pop.purchase_order_id = $1
         JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         ORDER BY rp.id, qif.id`,
        [poId]
      ),
      // Vendor: tech-eval clause response files
      db.any(
        `SELECT f.file_url AS url, pv.name AS product_name
         FROM tbl_rfq_product_tech_evaluation_vendors_response_files f
         JOIN tbl_rfq_product_tech_evaluation_vendors_response r
              ON r.id = f.tbl_rfq_product_tech_evaluation_vendors_response_id
         JOIN tbl_rfq_product_tech_evaluation_clauses c
              ON c.id = r.tbl_rfq_product_tech_evaluation_clauses_id
         JOIN tbl_rfq_product_tech_evaluation te
              ON te.id = c.tbl_rfq_product_tech_evaluation_id
         JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
         JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE r.vendor_id = $2 AND rp.rfq_id = $1
         ORDER BY rp.id, f.id`,
        [po.rfq_id, po.finalized_vendor_id]
      ),
    ]);

    // Vendor: quote-level T&C files (po.quote_id is an integer array)
    const quoteIds = Array.isArray(po.quote_id) ? po.quote_id.filter(Boolean) : [];
    const vendorQuoteLevelRows = quoteIds.length > 0
      ? await db.any(
          `SELECT file_url AS url, file_type
           FROM tbl_quotes_files
           WHERE quote_id = ANY($1::int[])
           ORDER BY id ASC`,
          [quoteIds]
        )
      : [];

    // A file entry is flat on purpose: `product` is a plain attribute rather
    // than a nesting level, so the client renders one uniform row everywhere
    // and RFQ-level and per-product files can sit in a single scannable list.
    const toFile = (row, label) => ({
      url: row.url,
      name: fileNameFromUrl(row.url),
      label,
      product: row.product_name || null,
    });

    // What the buyer issued with the RFQ: header T&Cs, then per-product
    // TDS / QAP / spec sheets.
    rfqGroupFiles = [
      ...rfqLevelRows.map((r) => toFile(r, toLabel(r.file_type))),
      ...rfqProductRows.map((r) => toFile(r, toLabel(r.file_type))),
    ];

    // What THIS PO's vendor attached to the quote it was awarded on.
    vendorQuoteGroupFiles = [
      ...vendorQuoteLevelRows.map((r) => toFile(r, toLabel(r.file_type))),
      ...vendorProductDocRows.map((r) => toFile(r, toLabel(r.file_type))),
    ];

    // The only mixed-provenance group, so the labels — not the group title —
    // carry who supplied each file.
    technicalGroupFiles = [
      ...buyerClauseFileRows.map((r) => toFile(r, "Buyer clause")),
      ...vendorEvalRows.map((r) => toFile(r, "Vendor response")),
    ];
  }

  // Ordered for a decision, not for a filesystem: the artefact being approved
  // first, then what was asked for, then what was offered, then the evidence
  // it was judged on. Empty groups are omitted so the card never shows a
  // heading with nothing under it.
  const PO_DOC_LABEL = { po: "PO", grn: "GRN", invoice: "Invoice" };
  const document_groups = [
    {
      key: "po",
      title: "PO documents",
      files: docs.map((d) => ({
        url: d.url,
        name: d.name,
        label: PO_DOC_LABEL[d.type] || "Document",
        product: null,
      })),
    },
    { key: "rfq", title: "RFQ documents (buyer-issued)", files: rfqGroupFiles },
    { key: "vendor_quote", title: "Vendor quote documents", files: vendorQuoteGroupFiles },
    { key: "technical", title: "Technical evaluation documents", files: technicalGroupFiles },
  ].filter((g) => g.files.length > 0);

  // ── Does this PO cover every product on its RFQ? ────────────────────────
  //
  // A purchase order is per-vendor and is built from the quote finalizations
  // made so far, so a draft can be initiated while products on the same RFQ
  // are still unfinalized. Initiating then FREEZES this PO: anything finalized
  // afterwards is clubbed into a SEPARATE purchase order. The buyer has to be
  // told that before they commit, which is what the "Force Initiate" warning
  // on the detail page exists to say.
  //
  // Derived here, on the server, rather than inferred by the client from the
  // items array: the client sees only the rows it was sent, so it cannot know
  // what is missing. Call-off POs are sourced from an ARC/MR, not from RFQ
  // finalization, so the question does not apply and coverage is reported as
  // complete.
  let productCoverage = { rfq_product_count: 0, po_product_count: 0, covers_all_products: true };
  if (!po.is_call_off && po.rfq_id) {
    const cov = await db.one(
      `SELECT
         (SELECT count(*)::int FROM tbl_rfq_products rp WHERE rp.rfq_id = $2) AS rfq_product_count,
         (SELECT count(DISTINCT pop.rfq_product_id)::int
            FROM tbl_purchase_order_product pop
           WHERE pop.purchase_order_id = $1) AS po_product_count`,
      [poId, po.rfq_id]
    );
    productCoverage = {
      rfq_product_count: cov.rfq_product_count,
      po_product_count: cov.po_product_count,
      // Only a PO carrying every product of its RFQ is "complete". Equality is
      // deliberate over >=: a PO can never hold more RFQ products than the RFQ
      // has, and if that ever became true it is a data fault we should not
      // paper over by calling the PO complete.
      covers_all_products:
        cov.rfq_product_count > 0 && cov.po_product_count === cov.rfq_product_count,
    };
  }

  return {
    id: po.id,
    po_number: po.po_number,
    status: po.status,
    status_label: humanizeStatus(po.status),
    total_value: po.total_value != null ? Number(po.total_value) : 0,
    is_call_off: !!po.is_call_off,
    // The PO's OWN scope keys, sourced from its parent RFQ or (call-off) its
    // ARC — the same COALESCE the scope predicate above evaluates. A client
    // deciding whether to offer a write action on THIS purchase order has to
    // resolve the user's grants against THIS entity's hotel/department, not
    // against whatever hotels the viewer happens to be mapped to; without
    // these two ids the only scope the frontend could reach for was the
    // viewer's own mapping list, which is a different question with a
    // different answer (see PODetail's Force Initiate gate).
    hotel_id: po.hotel_id != null ? Number(po.hotel_id) : null,
    department_id: po.department_id != null ? Number(po.department_id) : null,
    // Product coverage — drives Initiate (covers everything) vs Force
    // Initiate (does not, so later finalizations land in another PO).
    ...productCoverage,
    // Call-off provenance (null for regular RFQ-sourced POs) — lets the detail
    // page link back to the originating ARC and material requisition.
    call_off: po.is_call_off
      ? {
          arc_id: po.arc_id || null,
          arc_contract_id: po.arc_contract_id || null,
          arc_number: po.arc_number || null,
          arc_title: po.arc_title || null,
          mr_id: po.source_mr_id || null,
          mr_number: po.source_mr_number || null,
        }
      : null,
    rfq: {
      id: po.rfq_id,
      number: po.rfq_no != null ? String(po.rfq_no) : null,
      title: po.rfq_title || null,
      company: po.company_name || null,
      business_unit: po.business_unit || null,
      department: po.department_name || null,
      finalized_by: rfqCreator ? rfqCreator.name : null,
      finalized_date: po.instance_completed_at ? new Date(po.instance_completed_at).toISOString() : null,
      vendors_invited: null, // not derivable from PO scope
      vendors_participated: rfqStats ? rfqStats.participated : 0,
      rounds: null, // negotiation round count not derivable cleanly here
    },
    vendor: {
      id: po.finalized_vendor_id,
      name: po.vendor_name || "Unknown Vendor",
      short: initialsOf(po.vendor_name),
      gstin: po.vendor_gstin || po.gstin || null,
      pan: null, // vendor PAN not stored on tbl_company
      contact: null,
      email: po.vendor_email || null,
      phone: po.vendor_phone || null,
      bank: null,
      rating: null, // not modelled
      past_orders: null, // not modelled here
      on_time_delivery: null, // not modelled
      avg_delay: null, // not modelled
      past_value: null, // not modelled
      flags: [],
    },
    items: mappedItems,
    pricing,
    global_charges: po.global_charges ?? null,
    tech_eval, // per-product clause marks + % + approver (see buildTechEval)
    comparison,
    docs,
    payment_terms,
    workflow,
    key_dates: buildKeyDates(po, milestones),
    activity,
    decision_checks: [], // tech/commercial/budget checks not cleanly derivable; left []
    // Whose turn it is right now (drives the detail action card; the FE must
    // gate "your action required" on awaiting_me, not on status alone).
    awaiting_me,
    current_step_label,
    current_approvers,
    // `docs` stays the raw PO-document list (the hero's "Download PO" control
    // still reads the po-typed entry out of it); document_groups is the
    // grouped, decision-ordered view the detail page renders.
    document_groups,
  };
}

// Display name for an attachment. Storage rows carry only a URL — sometimes an
// absolute S3 url, sometimes a bare key — so the name is the last path segment,
// percent-decoded, with query/fragment stripped.
function fileNameFromUrl(url) {
  if (!url) return "File";
  const path = String(url).split("?")[0].split("#")[0];
  const seg = path.split("/").filter(Boolean).pop();
  if (!seg) return "File";
  try {
    return decodeURIComponent(seg);
  } catch {
    // A stray "%" in the key makes decodeURIComponent throw; the raw segment is
    // still a better name than a generic placeholder.
    return seg;
  }
}

function humanizeStatus(status) {
  const map = {
    draft: "Draft",
    pending_approval: "Pending Approval",
    acceptance_pending: "Awaiting Vendor Acceptance",
    approved: "Approved",
    rejected: "Rejected",
    rejected_by_vendor: "Rejected by Vendor",
    sent: "Sent",
    GRN: "Goods Received",
    completed: "Completed",
    cancelled: "Cancelled",
    invoice_raised: "Invoice Raised",
    dispatched: "Dispatched",
  };
  return map[status] || status;
}

function buildKeyDates(po, milestones) {
  const dates = [];
  if (po.created_at) dates.push({ k: "Created", v: new Date(po.created_at).toISOString(), soon: false });
  if (po.instance_completed_at)
    dates.push({ k: "Approved", v: new Date(po.instance_completed_at).toISOString(), soon: false });
  if (po.vendor_action_at)
    dates.push({ k: "Vendor Action", v: new Date(po.vendor_action_at).toISOString(), soon: false });
  const nextMilestone = milestones.find((m) => m.due_date && new Date(m.due_date) >= new Date());
  if (nextMilestone) {
    const soon = daysBetween(new Date(), new Date(nextMilestone.due_date)) <= 7;
    dates.push({ k: nextMilestone.milestone_name, v: new Date(nextMilestone.due_date).toISOString(), soon });
  }
  return dates;
}

// An approver row left at PENDING on a step that has ALREADY CLOSED will never
// be acted on — but the row keeps saying "PENDING" forever, which is what made
// the panel claim a finished level was still waiting on six people. Measured on
// stage: 736 PENDING rows sit under APPROVED/ANY steps (the "ANY ONE rule
// satisfied by someone else" case the client asked about) and 139 under
// CANCELLED steps. This resolves that into the real outcomes; the raw `status`
// is still emitted untouched beside it so nothing that reads the stored value
// changes meaning.
//
// Exported because the RFQ lifecycle page's PO tiles count the same people from
// the same rows (buildPODetail in rfqModel.js). One copy of the rule server-side
// means the two pages cannot disagree about whether a given person is waiting.
//
// The return value is CLOSED over exactly six tokens:
//   APPROVED · REJECTED · REMOVED · PENDING · NOT_REQUIRED · NOT_REACHED
// Nothing else can come out of here, whatever is in the column. That matters
// because the renderers switch on this value and label anything they do not
// recognise "Awaiting" — the one claim that is wrong for every row this
// function exists to reclassify. tbl_approval_step_approvers' CHECK currently
// permits only PENDING/APPROVED/REJECTED/REMOVED, but the STEP table's CHECK
// already permits SKIPPED and the engine writes it there, so SKIPPED is the
// value most likely to arrive here next; it means "did not need to act".
export function effectiveApproverStatus(rowStatus, stepStatus, rule) {
  if (rowStatus === "APPROVED" || rowStatus === "REJECTED" || rowStatus === "REMOVED") return rowStatus;
  if (rowStatus === "SKIPPED") return "NOT_REQUIRED";
  // Everything else — PENDING, NULL, or a value added to the enum after this
  // was written — is resolved from the step it sits on rather than passed
  // through. An unrecognised token reaching a renderer is the failure mode.
  if (stepStatus === "REJECTED" || stepStatus === "CANCELLED") return "NOT_REACHED";
  // ALL + APPROVED + a PENDING row does not occur (an ALL step cannot close
  // with someone outstanding), so it deliberately keeps the raw value rather
  // than being asserted into a bucket we cannot justify.
  if (stepStatus === "APPROVED") return rule === "ALL" ? "PENDING" : "NOT_REQUIRED";
  if (stepStatus === "SKIPPED" || stepStatus === "REMOVED") return "NOT_REQUIRED";
  return "PENDING";
}

// Full lifecycle audit trail for a PO: internal approval steps, then the
// downstream vendor/logistics chain (sent → accepted/rejected → dispatched →
// goods received → invoice → completed). Each node carries done/current/pending
// + a real timestamp where one exists (we have no per-status transition log, so
// some downstream nodes have null `when`). Returns BOTH the timeline (workflow)
// and a chronological, human-readable activity feed. All timestamps are ISO;
// the frontend formats them.
// `isVendorView` redacts the per-level approver roster. A vendor is an external
// counterparty: the buyer's internal approval chain — who sits at each level,
// their designation and department, when each acted, why one was removed, and
// above all the free-text comment each approver wrote to the next — is none of
// their business. The vendor still gets the trail's shape (level, status, when)
// so "where is my PO" keeps working; they simply do not get the people.
//
// This mirrors the `comparison` gate in getPODetailFull, which suppresses
// competitors' quote amounts on the same path for the same reason.
async function buildAuditTrail(po, docRows = [], { isVendorView = false } = {}) {
  const workflow = [];
  const activity = [];
  let stepCounter = 0;
  const status = po.status;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const isRejectedVendor = status === "rejected_by_vendor";

  // ---- 1) PO created ----
  workflow.push({
    step: ++stepCounter,
    status: "done",
    title: "PO created",
    by: po.initiator_name || null,
    when: iso(po.created_at),
    policy: null,
  });
  activity.push({
    type: "created",
    who: po.initiator_name || "System",
    msg: `created purchase order ${po.po_number}`,
    when: iso(po.created_at),
  });

  // ---- 2) PO initiated ----
  // Marks the moment the buyer pushed the draft into the approval/vendor
  // pipeline (via the Force Initiate button or the legacy initiate flow).
  // Reliable signal: an approval_instance was created OR the PO status has
  // moved past `draft` (covers the non-hospitality legacy path where no
  // approval instance is created). `cancelled` is excluded because a PO
  // cancelled before initiation never went through this step.
  const initiated = !!po.approval_instance_id ||
    !["draft", "cancelled"].includes(status);
  // `by` switches to "System" when the auto-initiate batch ran this PO,
  // so the audit trail distinguishes system-driven initiation from a
  // Force Initiate click. `auto_initiated` is the column flipped to TRUE
  // inside autoInitiateRFQPOs after initiatePurchaseOrder succeeds.
  const initiatedBy = po.auto_initiated ? "System" : (po.initiator_name || null);
  workflow.push({
    step: ++stepCounter,
    status: initiated ? "done" : "pending",
    title: "PO initiated",
    by: initiatedBy,
    when: iso(po.instance_created_at),
    policy: null,
  });
  if (initiated && po.instance_created_at) {
    activity.push({
      type: "initiated",
      who: initiatedBy || "System",
      msg: `initiated purchase order ${po.po_number}`,
      when: iso(po.instance_created_at),
    });
  }

  // ---- 3) Internal approval steps ----
  let approvalComplete = false;
  let approvalRejected = false;
  if (po.approval_instance_id) {
    const instance = await db.oneOrNone(
      `SELECT id, status, current_step FROM tbl_approval_instances WHERE id = $1`,
      [po.approval_instance_id]
    );
    // Approvers with status='REMOVED' are tombstones left by the mid-flight
    // reconciler (role revoked / policy changed etc.) — they no longer
    // represent a live approver, so they are excluded from the aggregate
    // here in SQL (rather than filtered per-use below) so every downstream
    // read of `approvers` (names, count, rejecter/acted/pending lookups,
    // the `by` fallback) is automatically correct with no risk of one
    // call site being fixed while another is missed. This query result is
    // only consumed locally in the loop right below, so there is no other
    // consumer whose shape we'd be breaking.
    // SECOND aggregate (`roster`): the SAME approver rows with NO status
    // predicate, so REMOVED tombstones survive. It exists because the trail
    // used to collapse a whole level to one `by` name plus "N approvers" —
    // a level with 7 approvers rendered a single name, and a removed approver
    // vanished with no trace of when/why. `roster` is the only thing that
    // feeds the new `approvers[]` node field; NOTHING derived (the `by` actor,
    // the `policy` count, the rejecter/acted/pending lookups, the summary
    // counts) reads it. That split is deliberate — see the paragraph above.
    const steps = await db.any(
      `SELECT st.id, st.step_order, st.status, st.completed_at,
              st.decision_rule,
              COALESCE(st.added_mid_flight, false)   AS added_mid_flight,
              COALESCE(st.removed_mid_flight, false) AS removed_mid_flight,
              COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT('user_id', sa.approver_user_id, 'name', u.name,
                                    'status', sa.status, 'acted_at', sa.acted_at)
                  ORDER BY sa.id
                ) FILTER (WHERE sa.id IS NOT NULL AND sa.status <> 'REMOVED'),
                '[]'
              ) AS approvers,
              COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'user_id', sa.approver_user_id, 'name', u.name,
                    'designation', u.designation, 'department', dept.title,
                    'status', sa.status, 'acted_at', sa.acted_at,
                    'removed_at', sa.removed_at, 'removal_reason', sa.removal_reason,
                    'added_mid_flight', COALESCE(sa.added_mid_flight, false)
                  )
                  ORDER BY sa.id
                ) FILTER (WHERE sa.id IS NOT NULL),
                '[]'
              ) AS roster
       FROM tbl_approval_instance_steps st
       LEFT JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = st.id
       LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
       LEFT JOIN LATERAL (
         SELECT d.title
           FROM tbl_user_department ud
           JOIN tbl_department d ON d.id = ud.department_id
          WHERE ud.user_id = u.id
          ORDER BY ud.id DESC
          LIMIT 1
       ) dept ON TRUE
       WHERE st.approval_instance_id = $1
       GROUP BY st.id
       ORDER BY st.step_order ASC`,
      [po.approval_instance_id]
    );
    // Fetch the approve/reject actions up-front so we can attach a rejecting
    // approver's reason (the action comment) to the rejected step node, and
    // (below) each approver's own comment to their roster entry.
    const actionRows = await db.any(
      `SELECT a.action, a.comment, a.created_at, a.approver_user_id,
              a.approval_instance_step_id, u.name AS actor_name
       FROM tbl_approval_actions a
       JOIN tbl_users u ON u.id = a.approver_user_id
       WHERE a.approval_instance_id = $1 AND a.action IN ('APPROVE', 'REJECT')
       ORDER BY a.created_at ASC`,
      [po.approval_instance_id]
    );
    const rejectCommentByUser = new Map();
    let firstRejectComment = null;
    for (const a of actionRows) {
      if (a.action === "REJECT") {
        if (a.comment && firstRejectComment == null) firstRejectComment = a.comment;
        if (a.approver_user_id != null && a.comment) rejectCommentByUser.set(a.approver_user_id, a.comment);
      }
    }
    // Per-approver comments for the roster, built off the rows already fetched
    // above (no extra query). Keyed by step FIRST: the same person legitimately
    // sits on more than one level (PO 29's instance 253 has Vineet I on both L1
    // and L3), so an instance-wide user match would smear one level's comment
    // across the other. `approval_instance_step_id` is nullable, so users whose
    // actions carry no step id at all fall back to their latest instance-wide
    // comment rather than silently losing it. Rows arrive created_at ASC, so
    // the last write per key is the latest action.
    const commentByStepUser = new Map();
    const commentByUser = new Map();
    const usersWithStepScopedActions = new Set();
    for (const a of actionRows) {
      if (a.approver_user_id == null) continue;
      commentByUser.set(a.approver_user_id, a.comment || null);
      if (a.approval_instance_step_id != null) {
        usersWithStepScopedActions.add(a.approver_user_id);
        commentByStepUser.set(`${a.approval_instance_step_id}:${a.approver_user_id}`, a.comment || null);
      }
    }
    // The PENDING-row-on-a-closed-step rule lives at module scope
    // (effectiveApproverStatus) because the RFQ lifecycle page counts the same
    // rows through it.

    for (const st of steps) {
      const approvers = Array.isArray(st.approvers) ? st.approvers : [];
      const acted = approvers.find((a) => a.acted_at);
      const pendingApprover = approvers.find((a) => a.status === "PENDING");
      const rejecter = approvers.find((a) => a.status === "REJECTED");
      const names = approvers.map((a) => a.name).filter(Boolean);

      let nodeStatus;
      if (st.status === "REJECTED") nodeStatus = "rejected";
      else if (st.status === "APPROVED") nodeStatus = "done";
      else if (st.status === "SKIPPED") nodeStatus = "skipped";
      else if (st.status === "REMOVED") nodeStatus = "removed";
      // CANCELLED had no branch and fell through to "pending", so a cancelled
      // level rendered as though it were still queued behind an approver. 84
      // such steps exist on stage. Same defect class as the REMOVED-tombstone
      // bug above; the frontend needs a matching `cancelled` case.
      else if (st.status === "CANCELLED") nodeStatus = "cancelled";
      else if (st.status === "PENDING" && instance && st.step_order === instance.current_step && instance.status === "PENDING")
        nodeStatus = "current";
      else nodeStatus = "pending";

      // The acting person: rejecter for a rejected step, else whoever acted.
      const by = rejecter ? rejecter.name : acted ? acted.name : pendingApprover ? pendingApprover.name : approvers[0]?.name || null;

      let reason = null;
      let policy = names.length > 1 ? `${names.length} approvers` : null;
      if (nodeStatus === "rejected") {
        reason =
          (rejecter && rejectCommentByUser.get(rejecter.user_id)) ||
          (acted && rejectCommentByUser.get(acted.user_id)) ||
          firstRejectComment ||
          null;
        policy = reason; // surface the rejection reason as the node's sub-note
      }

      // ---- the full per-level roster (additive; everything above is unchanged)
      // Ordered acted-first (by acted_at asc), then still-live PENDING rows in
      // sa.id order, then tombstones last. The frontend re-sorts for display,
      // but the PDF and any other consumer inherits this order.
      const roster = Array.isArray(st.roster) ? st.roster : [];
      const rank = (a) => (a.status === "REMOVED" ? 2 : a.acted_at ? 0 : 1);
      const approverRoster = roster
        .map((a, i) => ({ a, i }))
        .sort((x, y) => {
          const rx = rank(x.a);
          const ry = rank(y.a);
          if (rx !== ry) return rx - ry;
          if (rx === 0) {
            const dx = new Date(x.a.acted_at).getTime();
            const dy = new Date(y.a.acted_at).getTime();
            if (dx !== dy) return dx - dy;
          }
          return x.i - y.i; // the aggregate is ORDER BY sa.id, so this is id order
        })
        .map(({ a }) => {
          const key = `${st.id}:${a.user_id}`;
          const comment = commentByStepUser.has(key)
            ? commentByStepUser.get(key)
            : usersWithStepScopedActions.has(a.user_id)
              ? null
              : commentByUser.get(a.user_id) ?? null;
          return {
            user_id: a.user_id ?? null,
            name: a.name || null,
            designation: a.designation || null,
            department: a.department || null,
            status: a.status || null,
            effective_status: effectiveApproverStatus(a.status, st.status, st.decision_rule),
            acted_at: iso(a.acted_at),
            comment,
            removed_at: iso(a.removed_at),
            // RAW snake_case token ('policy_change' | 'role_removed'). The
            // frontend owns the human label (removalReasonLabel) — labelling it
            // here would create a second mapping that drifts from that one.
            removal_reason: a.removal_reason || null,
            added_mid_flight: !!a.added_mid_flight,
          };
        });
      // Counts stay on the ACTIVE-only aggregate, exactly like `by` and
      // `policy`: a tombstone appears in `approvers[]` so the panel can explain
      // it, but it must never move a number. `removed` is the one count that
      // reads the full roster, and it is reported separately for that reason.
      //
      // The buckets count EFFECTIVE statuses, not raw ones. Counting raw made
      // the summary contradict the roster it summarises: PO 8's L1 (ANY,
      // APPROVED, five approvers, one acted) reported `pending: 4` while every
      // row beside it said NOT_REQUIRED, so an export built off the summary
      // would claim four people were holding up an order that closed in April.
      // `approved`/`rejected` are unaffected (those statuses pass straight
      // through); the old `pending` bucket is what splits three ways, and the
      // five active buckets sum to total_active by construction.
      const effectiveActive = approvers.map((a) =>
        effectiveApproverStatus(a.status, st.status, st.decision_rule)
      );
      const countEffective = (v) => effectiveActive.filter((s) => s === v).length;
      const approverSummary = {
        total_active: approvers.length,
        approved: countEffective("APPROVED"),
        rejected: countEffective("REJECTED"),
        pending: countEffective("PENDING"),
        not_required: countEffective("NOT_REQUIRED"),
        not_reached: countEffective("NOT_REACHED"),
        removed: roster.filter((a) => a.status === "REMOVED").length,
      };

      workflow.push({
        step: ++stepCounter,
        status: nodeStatus,
        title: `L${st.step_order} approval`,
        by,
        when: iso(st.completed_at),
        policy,
        reason,
        level: st.step_order,
        decision_rule: st.decision_rule || "ANY",
        // Redacted wholesale on the vendor path — see the note on this
        // function. Omitted, not emptied: an empty array would read to a client
        // as "this level has no approvers", which is a different claim.
        ...(isVendorView ? {} : { approvers: approverRoster, approver_summary: approverSummary }),
        step_added_mid_flight: !!st.added_mid_flight,
        step_removed_mid_flight: !!st.removed_mid_flight,
      });
    }
    approvalComplete = !!instance && instance.status === "APPROVED";
    approvalRejected = !!instance && instance.status === "REJECTED";
    // PRE-EXISTING LEAK, closed here: these entries name a buyer-side approver
    // and quote their free-text note verbatim ("approved this purchase order ·
    // “Rate looks high, approving under protest”"), and the vendor PO detail
    // page renders `activity`. Internal approval chatter is not the vendor's to
    // read. They keep the rest of the feed — created, initiated, sent,
    // accepted, dispatched, GRN, invoice, completed — which is the part that
    // actually answers "where has my order got to".
    if (!isVendorView) {
      for (const a of actionRows) {
        const verb = a.action === "APPROVE" ? "approved" : "rejected";
        const note = a.comment ? ` · “${a.comment}”` : "";
        activity.push({
          type: a.action === "APPROVE" ? "approval" : "rejection",
          who: a.actor_name,
          msg: `${verb} this purchase order${note}`,
          when: iso(a.created_at),
        });
      }
    }
  } else {
    approvalComplete = ["approved", "acceptance_pending", "sent", "invoice_raised", "dispatched", "GRN", "completed"].includes(status);
  }

  // ---- 3) Vendor + logistics lifecycle ----
  const invoiceDoc = docRows.find((d) => d.document_type === "invoice");
  const grnDoc = docRows.find((d) => d.document_type === "grn");
  // 'approved' = the vendor has accepted (acceptPO flips acceptance_pending→approved,
  // and call-offs reach 'approved' only via acceptance) — so an accepted PO must
  // mark both "Sent" and "Vendor accepted" as done even when vendor_action_at is
  // absent on legacy/seeded rows.
  const sentDone = ["sent", "acceptance_pending", "approved", "invoice_raised", "dispatched", "GRN", "completed"].includes(status) || !!po.vendor_action_at;
  const vendorActed = !!po.vendor_action_at || ["approved", "invoice_raised", "dispatched", "GRN", "completed"].includes(status) || isRejectedVendor;
  const dispatchedDone = ["dispatched", "GRN", "completed"].includes(status);
  const grnDone = !!grnDoc || ["GRN", "completed"].includes(status);
  const invoiceDone = !!invoiceDoc || status === "invoice_raised";
  const completedDone = status === "completed";

  const lifecycle = [];
  if (!approvalRejected && status !== "rejected" && status !== "cancelled") {
    lifecycle.push({ title: "Sent to vendor", by: po.vendor_name || null, when: iso(po.instance_completed_at), done: sentDone });
    if (isRejectedVendor) {
      lifecycle.push({
        title: "Vendor rejected the PO",
        by: po.vendor_name || null,
        when: iso(po.vendor_action_at),
        rejected: true,
        reason: po.vendor_rejection_reason || null,
        policy: po.vendor_rejection_reason || null,
      });
    } else {
      lifecycle.push({ title: "Vendor accepted the PO", by: po.vendor_name || null, when: iso(po.vendor_action_at), done: vendorActed });
      lifecycle.push({ title: "Dispatched", by: po.vendor_name || null, when: null, done: dispatchedDone });
      lifecycle.push({ title: "Goods received (GRN)", by: null, when: iso(grnDoc && grnDoc.created_at), done: grnDone });
      lifecycle.push({ title: "Invoice raised", by: po.vendor_name || null, when: iso(invoiceDoc && invoiceDoc.created_at), done: invoiceDone });
      lifecycle.push({ title: "PO completed", by: null, when: null, done: completedDone });
    }
  }

  let currentAssigned = false;
  for (const n of lifecycle) {
    let nodeStatus;
    if (n.rejected) nodeStatus = "rejected";
    else if (n.done) nodeStatus = "done";
    else if (approvalComplete && !currentAssigned && !completedDone) {
      nodeStatus = "current";
      currentAssigned = true;
    } else nodeStatus = "pending";
    workflow.push({
      step: ++stepCounter,
      status: nodeStatus,
      title: n.title,
      by: n.by || null,
      when: n.when || null,
      policy: n.policy || null,
      reason: n.reason || null,
    });
  }

  // ---- lifecycle activity (chronological by construction) ----
  if (sentDone && !approvalRejected) {
    activity.push({ type: "sent", who: "System", msg: `forwarded the PO to vendor ${po.vendor_name || ""}`.trim(), when: iso(po.instance_completed_at) });
  }
  if (isRejectedVendor) {
    const note = po.vendor_rejection_reason ? ` · “${po.vendor_rejection_reason}”` : "";
    activity.push({ type: "rejection", who: po.vendor_name || "Vendor", msg: `rejected (did not accept) the purchase order${note}`, when: iso(po.vendor_action_at) });
  } else if (vendorActed) {
    activity.push({ type: "approval", who: po.vendor_name || "Vendor", msg: "accepted the purchase order", when: iso(po.vendor_action_at) });
  }
  if (dispatchedDone) {
    activity.push({ type: "dispatched", who: po.vendor_name || "Vendor", msg: "marked the order dispatched", when: null });
  }
  if (grnDoc) {
    activity.push({ type: "grn", who: "Site", msg: "recorded goods receipt (GRN)", when: iso(grnDoc.created_at) });
  }
  if (invoiceDoc) {
    activity.push({ type: "invoice", who: po.vendor_name || "Vendor", msg: "raised an invoice", when: iso(invoiceDoc.created_at) });
  }
  if (completedDone) {
    activity.push({ type: "completed", who: "System", msg: "purchase order completed", when: null });
  }

  return { workflow, activity };
}

// Commercial comparison across all participating vendors on this RFQ.
async function buildComparison(po) {
  // One row per quote (not per vendor) so we can apply each quote's own
  // document-level global charges (TCS/TDS, incl. their additional_tax) on that
  // quote's line subtotal — the "Quoted" figure must equal the vendor's grand
  // total (and the PO total_value), not just the sum of line totals.
  const rows = await db.any(
    `SELECT q.id AS quote_id, q.created_by AS vendor_id,
            COALESCE(VC.company_name, U.organization_name, U.name) AS vendor_name,
            U.organization_name, VC.gstin, q.global_charges,
            SUM(qi.total_price)::numeric AS subtotal,
            MAX(qi.delivery_period) AS delivery_period
     FROM tbl_quotes q
     JOIN tbl_quote_items qi ON qi.quote_id = q.id
     JOIN tbl_users U ON U.id = q.created_by
     LEFT JOIN tbl_company VC ON VC.id = U.company_id
     WHERE q.rfq_id = $1 AND q.is_regret = 0
     GROUP BY q.id, q.created_by, vendor_name, U.organization_name, VC.gstin, q.global_charges`,
    [po.rfq_id]
  );

  if (rows.length === 0) return [];

  // Roll quotes up per vendor, adding the global-charge total per quote.
  const byVendor = new Map();
  for (const r of rows) {
    const subtotal = Number(r.subtotal) || 0;
    let globals = [];
    const raw = r.global_charges;
    if (Array.isArray(raw)) globals = raw;
    else if (typeof raw === "string" && raw.trim()) {
      try { globals = JSON.parse(raw); } catch (_e) { globals = []; }
    }
    const grand = subtotal + pricingEngine.sumGlobalCharges(globals, subtotal);
    const deliveryDays = parseInt(r.delivery_period, 10);
    const existing = byVendor.get(r.vendor_id);
    if (existing) {
      existing.amount += grand;
      if (!Number.isNaN(deliveryDays)) {
        existing.delivery_days = Math.max(existing.delivery_days ?? 0, deliveryDays);
      }
    } else {
      byVendor.set(r.vendor_id, {
        vendor_id: r.vendor_id,
        vendor_name: r.vendor_name,
        gstin: r.gstin,
        amount: grand,
        delivery_days: Number.isNaN(deliveryDays) ? null : deliveryDays,
      });
    }
  }

  const vendors = Array.from(byVendor.values());
  const winnerAmount = (() => {
    const winner = vendors.find((v) => v.vendor_id === po.finalized_vendor_id);
    return winner ? Number(winner.amount) : null;
  })();

  return vendors.map((v) => {
    const amount = Math.round((Number(v.amount) || 0) * 100) / 100;
    const isWinner = v.vendor_id === po.finalized_vendor_id;
    let deltaPct = null;
    if (winnerAmount != null && winnerAmount > 0 && !isWinner) {
      deltaPct = Math.round(((amount - winnerAmount) / winnerAmount) * 100);
    } else if (isWinner) {
      deltaPct = 0;
    }
    return {
      vendor: v.vendor_name || "Unknown",
      short: initialsOf(v.vendor_name),
      amount,
      delivery_days: v.delivery_days,
      gstin: v.gstin || null,
      is_winner: isWinner,
      delta_pct: deltaPct,
    };
  });
}

// Per-product technical evaluation for the PO's finalized vendor: the clause-by
// -clause marks, the vendor's percentage for that product, and who approved the
// evaluation. Sourced from the tech-eval tables:
//   tbl_rfq_product_tech_evaluation (per rfq + product, minimum_passing_score)
//   ..._clauses (clause_text, weightage = max marks)
//   ..._vendors_response (buyer_marks = obtained; counted only once scored,
//      i.e. score_timestamp differs from the response timestamp)
//   ..._cleared_vendors (calculated_score = final %, approval_instance_id)
// Approver = the APPROVE action on that tech-eval approval instance.
// Best-effort + read-only: any failure degrades to [] so the detail never breaks.
async function buildTechEval(po) {
  try {
    const vendorId = po.finalized_vendor_id;
    if (!vendorId) return [];

    const prods = await db.any(
      `SELECT DISTINCT pop.rfq_product_id, pv.name
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
       WHERE pop.purchase_order_id = $1`,
      [po.id]
    );
    if (prods.length === 0) return [];
    // rfq_product_id comes back as a string (bigint column) — normalize to int
    // so the JS Map keys match tbl_rfq_product_tech_evaluation.tbl_rfq_product_id
    // (an integer column returned as a number).
    const productIds = prods.map((p) => Number(p.rfq_product_id));

    const teRows = await db.any(
      `SELECT id, tbl_rfq_product_id, minimum_passing_score, current_round
       FROM tbl_rfq_product_tech_evaluation
       WHERE rfq_id = $1 AND tbl_rfq_product_id = ANY($2::int[])`,
      [po.rfq_id, productIds]
    );
    if (teRows.length === 0) return [];
    const teByProduct = new Map(teRows.map((r) => [Number(r.tbl_rfq_product_id), r]));
    const teIds = teRows.map((r) => r.id);

    const clauseRows = await db.any(
      `SELECT c.tbl_rfq_product_tech_evaluation_id AS te_id, c.id AS clause_id,
              c.clause_text, c.weightage AS max_marks, c.clause_type,
              vr.buyer_marks, vr.score_timestamp, vr."timestamp" AS resp_ts
       FROM tbl_rfq_product_tech_evaluation_clauses c
       LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
         ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id AND vr.vendor_id = $1
       WHERE c.tbl_rfq_product_tech_evaluation_id = ANY($2::int[])
       ORDER BY c.id ASC`,
      [vendorId, teIds]
    );

    const cvRows = await db.any(
      `SELECT DISTINCT ON (cv.tbl_rfq_product_tech_evaluation_id)
              cv.tbl_rfq_product_tech_evaluation_id AS te_id,
              cv.calculated_score, cv.status, cv.is_verified, cv.reject_message,
              cv.approval_instance_id, cv.evaluation_round,
              appr.name AS approver_name, appr_act.acted_at
       FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
       LEFT JOIN LATERAL (
         SELECT a.approver_user_id, a.created_at AS acted_at
         FROM tbl_approval_actions a
         WHERE a.approval_instance_id = cv.approval_instance_id AND a.action = 'APPROVE'
         ORDER BY a.created_at DESC LIMIT 1
       ) appr_act ON true
       LEFT JOIN tbl_users appr ON appr.id = appr_act.approver_user_id
       WHERE cv.tbl_rfq_product_tech_evaluation_id = ANY($1::int[]) AND cv.vendor_id = $2
       ORDER BY cv.tbl_rfq_product_tech_evaluation_id, cv.evaluation_round DESC NULLS LAST, cv.id DESC`,
      [teIds, vendorId]
    );
    const cvByTe = new Map(cvRows.map((r) => [r.te_id, r]));

    const clausesByTe = new Map();
    for (const cr of clauseRows) {
      if (!clausesByTe.has(cr.te_id)) clausesByTe.set(cr.te_id, []);
      const scored =
        cr.score_timestamp != null &&
        (cr.resp_ts == null || new Date(cr.score_timestamp).getTime() !== new Date(cr.resp_ts).getTime());
      clausesByTe.get(cr.te_id).push({
        clause_text: cr.clause_text,
        clause_type: cr.clause_type || null,
        max_marks: cr.max_marks != null ? Number(cr.max_marks) : null,
        obtained_marks: scored ? (cr.buyer_marks != null ? Number(cr.buyer_marks) : 0) : null,
      });
    }

    const result = [];
    for (const p of prods) {
      const pid = Number(p.rfq_product_id);
      const te = teByProduct.get(pid);
      if (!te) continue; // this product has no technical evaluation
      const clauses = clausesByTe.get(te.id) || [];
      const cv = cvByTe.get(te.id) || null;

      let percentage = null;
      if (cv && cv.calculated_score != null) {
        percentage = Number(cv.calculated_score);
      } else {
        const totalMax = clauses.reduce((s, c) => s + (c.max_marks || 0), 0);
        const anyScored = clauses.some((c) => c.obtained_marks != null);
        const totalObt = clauses.reduce((s, c) => s + (c.obtained_marks || 0), 0);
        percentage = totalMax > 0 && anyScored ? Math.round((totalObt / totalMax) * 10000) / 100 : null;
      }

      const minPass = te.minimum_passing_score != null ? Number(te.minimum_passing_score) : null;
      let status = "pending";
      if (cv && cv.reject_message) status = "failed";
      else if (percentage != null && minPass != null) status = percentage >= minPass ? "passed" : "failed";
      else if (percentage != null) status = "evaluated";

      result.push({
        product: p.name || "Product",
        product_id: pid,
        percentage,
        minimum_passing_score: minPass,
        status,
        approver: cv ? cv.approver_name || null : null,
        approved_at: cv && cv.acted_at ? new Date(cv.acted_at).toISOString() : null,
        round: te.current_round != null ? Number(te.current_round) : null,
        clauses,
      });
    }
    return result;
  } catch (e) {
    logError("buildTechEval failed", e);
    return [];
  }
}

// ===========================================================================
// 5) GET /po/tracking
// ===========================================================================
// Canonical 8-stage delivery pipeline.
const TRACKING_STAGES = [
  { key: "approved", label: "Approved" },
  { key: "sent", label: "PO Sent" },
  { key: "ack", label: "Vendor Acknowledged" },
  { key: "dispatched", label: "Dispatched" },
  { key: "delivered", label: "Delivered" },
  { key: "grn", label: "GRN" },
  { key: "invoiced", label: "Invoiced" },
  { key: "paid", label: "Paid" },
];

// Maps a PO into a current pipeline stage index given its status + docs +
// milestone payment state.
function deriveStageIndex(po, hasGrnDoc, hasInvoiceDoc, paymentDone) {
  // Highest reached stage wins.
  let idx = 0; // approved baseline (only approved+ POs are listed)
  if (["sent", "acceptance_pending"].includes(po.status)) idx = Math.max(idx, 1);
  // 'approved' here means vendor accepted in this app (acceptPO sets approved).
  if (po.status === "approved") idx = Math.max(idx, 2); // acknowledged
  if (po.status === "dispatched") idx = Math.max(idx, 3);
  if (po.status === "GRN" || hasGrnDoc) idx = Math.max(idx, 5);
  else if (hasGrnDoc) idx = Math.max(idx, 4);
  if (po.status === "invoice_raised" || hasInvoiceDoc) idx = Math.max(idx, 6);
  if (paymentDone || po.status === "completed") idx = Math.max(idx, 7);
  return idx;
}

export async function getTracking(scope, { tab = "active", search = "", page = 1, limit = 20 } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pg - 1) * lim;

  const values = [scope.userId];
  const scoped = buildScopeClause(scope, values, 2);
  let idx = scoped.nextIndex;
  const conditions = [scoped.clause];

  // Only approved-or-beyond POs are trackable.
  conditions.push(
    `po.status = ANY($${idx++}::po_status[])`
  );
  values.push(["approved", "sent", "dispatched", "GRN", "invoice_raised", "completed", "acceptance_pending"]);

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(`(
      po.po_number ILIKE $${idx}
      OR rfq.rfq_no::text ILIKE $${idx}
      OR rfq.title ILIKE $${idx}
      OR COALESCE(VC.company_name, VENDOR.organization_name, VENDOR.name) ILIKE $${idx}
    )`);
    values.push(term);
    idx++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const rows = await db.any(
    `SELECT ${poCoreSelect(1)},
        EXISTS (SELECT 1 FROM tbl_purchase_order_document d
                WHERE d.purchase_order_id = po.id AND d.document_type = 'grn') AS has_grn_doc,
        EXISTS (SELECT 1 FROM tbl_purchase_order_document d
                WHERE d.purchase_order_id = po.id AND d.document_type = 'invoice') AS has_invoice_doc,
        (SELECT COUNT(*) FROM tbl_payment_milestone m
           WHERE m.po_id = po.id AND m.status <> 'deleted')::int AS milestone_total,
        (SELECT COUNT(*) FROM tbl_payment_milestone m
           WHERE m.po_id = po.id AND m.status = 'achieved')::int AS milestone_done,
        (SELECT MIN(m.due_date) FROM tbl_payment_milestone m
           WHERE m.po_id = po.id AND m.status NOT IN ('deleted','achieved')) AS next_due
     ${poCoreJoins()}
     ${whereClause}
     ORDER BY po.created_at DESC`,
    values
  );

  // Build full mapped list, then apply tab filter in JS (stage is derived).
  const mapped = rows.map((r) => buildTrackingRow(r));

  const tabFilter = (row) => {
    switch (tab) {
      case "active":
        return !row.completed;
      case "awaiting-grn":
        return row.grn_status !== "done" && row.current_stage !== "paid";
      case "payment":
        return row.invoice_status === "done" && row.payment_status !== "done";
      case "completed":
        return row.completed;
      case "all":
      default:
        return true;
    }
  };

  const filtered = mapped.filter(tabFilter);
  const paged = filtered.slice(offset, offset + lim);

  const tabCounts = {
    active: mapped.filter((r) => !r.completed).length,
    "awaiting-grn": mapped.filter((r) => r.grn_status !== "done" && r.current_stage !== "paid").length,
    payment: mapped.filter((r) => r.invoice_status === "done" && r.payment_status !== "done").length,
    completed: mapped.filter((r) => r.completed).length,
    all: mapped.length,
  };

  return {
    data: paged,
    total_items: filtered.length,
    tab_counts: tabCounts,
  };
}

function buildTrackingRow(r) {
  const m = mapPoCoreRow(r);
  const hasGrn = !!r.has_grn_doc || r.status === "GRN" || r.status === "completed";
  const hasInvoice = !!r.has_invoice_doc || r.status === "invoice_raised";
  const milestoneTotal = Number(r.milestone_total) || 0;
  const milestoneDone = Number(r.milestone_done) || 0;
  const paymentDone = milestoneTotal > 0 && milestoneDone >= milestoneTotal;

  const stageIdx = deriveStageIndex(r, hasGrn, hasInvoice, paymentDone);
  const stages = TRACKING_STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    when: null, // per-stage timestamps not individually tracked
    status: i < stageIdx ? "done" : i === stageIdx ? "current" : "pending",
  }));

  const grnStatus = hasGrn ? "done" : "pending";
  const invoiceStatus = hasInvoice ? "done" : "pending";
  let paymentStatus = "pending";
  if (paymentDone) paymentStatus = "done";
  else if (r.next_due && new Date(r.next_due) < new Date()) paymentStatus = "overdue";

  const completed = r.status === "completed";
  const overdue = !!(r.next_due && new Date(r.next_due) < new Date() && !completed);

  return {
    id: m.id,
    po_number: m.po_number,
    rfq_no: m.rfq_no,
    rfq_title: m.rfq_title,
    vendor: m.vendor,
    items_label: m.items_label,
    items_count: m.items_count,
    total_value: m.total_value,
    current_stage: TRACKING_STAGES[stageIdx].key,
    progress: Math.round((stageIdx / (TRACKING_STAGES.length - 1)) * 100),
    stages,
    grn_status: grnStatus,
    invoice_status: invoiceStatus,
    payment_status: paymentStatus,
    eta_delivery: r.next_due ? new Date(r.next_due).toISOString() : null,
    eta_label: r.next_due ? new Date(r.next_due).toISOString().slice(0, 10) : null,
    overdue,
    completed,
  };
}

// ===========================================================================
// 6) GET /po/analytics
// ===========================================================================
const PERIOD_INTERVALS = {
  "this-week": "date_trunc('week', NOW())",
  "this-month": "date_trunc('month', NOW())",
  "this-quarter": "date_trunc('quarter', NOW())",
  ytd: "date_trunc('year', NOW())",
};

export async function getAnalytics(scope, { period = "this-month" } = {}) {
  const startExpr = PERIOD_INTERVALS[period] || PERIOD_INTERVALS["this-month"];

  const values = [];
  const scoped = buildScopeClause(scope, values, 1);
  const clause = scoped.clause;

  // ---- KPIs ----
  const spendAgg = await db.one(
    `SELECT
        COALESCE(SUM(po.total_value) FILTER (WHERE po.created_at >= ${startExpr}), 0) AS total_spend,
        COALESCE(SUM(po.total_value) FILTER (
          WHERE po.created_at >= ${startExpr} - (NOW() - ${startExpr})
            AND po.created_at < ${startExpr}
        ), 0) AS prev_spend
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}`,
    values
  );

  // Avg approval cycle (days from instance creation -> completion) for
  // APPROVED instances in scope. APPROXIMATED via approval instance timestamps.
  const cycleAgg = await db.oneOrNone(
    `SELECT COALESCE(AVG(
        EXTRACT(EPOCH FROM (tai.completed_at - tai.created_at)) / 86400
      ), 0)::numeric(10,1) AS avg_cycle
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     JOIN tbl_approval_instances tai ON tai.id = po.approval_instance_id
     WHERE ${clause}
       AND tai.status = 'APPROVED'
       AND tai.completed_at IS NOT NULL`,
    values
  );

  const activeVendors = await db.one(
    `SELECT COUNT(DISTINCT po.finalized_vendor_id)::int AS cnt
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}`,
    values
  );

  const pctDelta = (curr, prev) => {
    if (!prev || Number(prev) === 0) return Number(curr) > 0 ? 100 : 0;
    return Math.round(((Number(curr) - Number(prev)) / Number(prev)) * 100);
  };

  const kpis = {
    total_spend: Number(spendAgg.total_spend) || 0,
    spend_delta_pct: pctDelta(spendAgg.total_spend, spendAgg.prev_spend),
    avg_approval_cycle_days: cycleAgg ? Number(cycleAgg.avg_cycle) : 0,
    approval_cycle_delta: 0, // prior-period cycle delta not computed -> 0
    on_time_delivery_pct: 0, // OTD not modelled (no committed-vs-actual dates) -> 0
    otd_delta: 0,
    cost_savings: 0, // savings vs baseline not modelled -> 0
    savings_pct: 0,
    active_vendors: activeVendors.cnt,
    vendor_categories: 0, // vendor-category mapping not joined here -> 0
  };

  // ---- spend_trend: last 6 months ----
  const trendRows = await db.any(
    `SELECT to_char(date_trunc('month', gs.m), 'Mon') AS month,
            date_trunc('month', gs.m) AS month_start,
            COALESCE(SUM(po.total_value), 0) AS value
     FROM generate_series(
            date_trunc('month', NOW()) - INTERVAL '5 months',
            date_trunc('month', NOW()),
            INTERVAL '1 month'
          ) gs(m)
     LEFT JOIN tbl_rfq_purchase_order po
       ON date_trunc('month', po.created_at) = date_trunc('month', gs.m)
       AND po.id IN (
         SELECT po2.id FROM tbl_rfq_purchase_order po2
         JOIN tbl_rfq rfq ON rfq.id = po2.rfq_id
         WHERE ${clause}
       )
     GROUP BY gs.m
     ORDER BY gs.m ASC`,
    values
  );
  const currentMonthStart = new Date();
  const spend_trend = trendRows.map((r) => ({
    month: r.month,
    value: Number(r.value) || 0,
    current:
      new Date(r.month_start).getMonth() === currentMonthStart.getMonth() &&
      new Date(r.month_start).getFullYear() === currentMonthStart.getFullYear(),
  }));

  // ---- status_dist ----
  const statusRows = await db.any(
    `SELECT po.status, COUNT(*)::int AS count, COALESCE(SUM(po.total_value), 0) AS value
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}
     GROUP BY po.status`,
    values
  );
  const statusTotal = statusRows.reduce((s, r) => s + r.count, 0);
  const status_dist = statusRows.map((r) => ({
    key: r.status,
    label: humanizeStatus(r.status),
    count: r.count,
    value: Number(r.value) || 0,
    pct: statusTotal ? Math.round((r.count / statusTotal) * 100) : 0,
  }));

  // ---- bottlenecks: avg time spent at each approval step order ----
  const bottleneckRows = await db.any(
    `SELECT st.step_order,
            COALESCE(AVG(
              EXTRACT(EPOCH FROM (COALESCE(st.completed_at, NOW()) - st.created_at)) / 3600
            ), 0)::numeric(10,1) AS avg_hours
     FROM tbl_approval_instance_steps st
     JOIN tbl_approval_instances tai ON tai.id = st.approval_instance_id
     JOIN tbl_rfq_purchase_order po ON po.approval_instance_id = tai.id
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}
     GROUP BY st.step_order
     ORDER BY st.step_order ASC`,
    values
  );
  const bottlenecks = bottleneckRows.map((r) => {
    const hrs = Number(r.avg_hours) || 0;
    let status = "ok";
    if (hrs > 72) status = "slow";
    else if (hrs > 24) status = "warn";
    const time = hrs >= 24 ? `${(hrs / 24).toFixed(1)}d` : `${hrs.toFixed(1)}h`;
    return { stage: `Approval Step ${r.step_order}`, time, sub: "avg time at step", status };
  });

  // ---- top_vendors ----
  const topVendorRows = await db.any(
    `SELECT po.finalized_vendor_id AS vendor_id,
            COALESCE(VC.company_name, U.organization_name, U.name) AS vendor_name,
            COUNT(*)::int AS orders,
            COALESCE(SUM(po.total_value), 0) AS value
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     JOIN tbl_users U ON U.id = po.finalized_vendor_id
     LEFT JOIN tbl_company VC ON VC.id = U.company_id
     WHERE ${clause}
     GROUP BY po.finalized_vendor_id, vendor_name
     ORDER BY value DESC
     LIMIT 5`,
    values
  );
  const top_vendors = topVendorRows.map((r) => ({
    name: r.vendor_name || "Unknown",
    short: initialsOf(r.vendor_name),
    orders: r.orders,
    value: Number(r.value) || 0,
    otd: null, // OTD per vendor not modelled
    on_time: null,
  }));

  // ---- savings (not modelled) ----
  const savings = { total: 0, delta_pct: 0, rounds: { negotiation: 0, comparison: 0, alt: 0 } };

  // ---- compliance: only metrics derivable from schema ----
  const complianceAgg = await db.one(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE po.gstin IS NOT NULL AND po.gstin <> '')::int AS with_gst,
        COUNT(*) FILTER (WHERE po.po_pdf_url IS NOT NULL AND po.po_pdf_url <> '')::int AS with_doc
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     WHERE ${clause}`,
    values
  );
  const compliance = [];
  if (complianceAgg.total > 0) {
    const gstPct = Math.round((complianceAgg.with_gst / complianceAgg.total) * 100);
    const docPct = Math.round((complianceAgg.with_doc / complianceAgg.total) * 100);
    compliance.push({ name: "GSTIN captured", pct: gstPct, tone: gstPct >= 90 ? "ok" : gstPct >= 60 ? "warn" : "danger" });
    compliance.push({ name: "PO document generated", pct: docPct, tone: docPct >= 90 ? "ok" : docPct >= 60 ? "warn" : "danger" });
  }

  // ---- spend_by_dept ----
  const deptRows = await db.any(
    `SELECT COALESCE(d.title, 'Unassigned') AS name, COALESCE(SUM(po.total_value), 0) AS value
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
     LEFT JOIN tbl_department d ON d.id = rfq.department_id
     WHERE ${clause}
     GROUP BY d.title
     ORDER BY value DESC`,
    values
  );
  const deptTotal = deptRows.reduce((s, r) => s + Number(r.value), 0);
  const spend_by_dept = deptRows.map((r) => ({
    name: r.name,
    value: Number(r.value) || 0,
    pct: deptTotal ? Math.round((Number(r.value) / deptTotal) * 100) : 0,
  }));

  // ---- queue_health: waiting buckets for PENDING approval instances ----
  const queueRows = await db.any(
    `SELECT
        EXTRACT(EPOCH FROM (NOW() - step_since)) / 86400 AS days
     FROM (
        SELECT (
          SELECT MIN(st.created_at)
          FROM tbl_approval_instance_steps st
          WHERE st.approval_instance_id = po.approval_instance_id
            AND st.step_order = tai.current_step
            AND st.status = 'PENDING'
        ) AS step_since
        FROM tbl_rfq_purchase_order po
        JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
        JOIN tbl_approval_instances tai ON tai.id = po.approval_instance_id
        WHERE ${clause} AND tai.status = 'PENDING'
     ) q
     WHERE step_since IS NOT NULL`,
    values
  );
  let under24 = 0;
  let d1to3 = 0;
  let over3 = 0;
  let oldest = 0;
  for (const row of queueRows) {
    const d = Number(row.days) || 0;
    if (d > oldest) oldest = d;
    if (d < 1) under24++;
    else if (d <= 3) d1to3++;
    else over3++;
  }
  const queue_health = {
    under_24h: under24,
    d1_to_3: d1to3,
    over_3d: over3,
    oldest_days: Math.round(oldest),
    avg_approval_days: cycleAgg ? Number(cycleAgg.avg_cycle) : 0,
  };

  return {
    kpis,
    spend_trend,
    status_dist,
    bottlenecks,
    top_vendors,
    savings,
    compliance,
    spend_by_dept,
    queue_health,
  };
}

export default {
  getPOList,
  getDashboardKpis,
  getAwaitingPOs,
  getPODetailFull,
  getTracking,
  getAnalytics,
};
