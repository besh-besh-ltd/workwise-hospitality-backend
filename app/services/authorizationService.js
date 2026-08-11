/**
 * Authorization Service
 *
 * Centralized scope-aware permission checks for hospitality entities. Layered
 * on top of acl() role gates at the route level — call assertUserHasScope()
 * inside controllers after the role gate passes to enforce 4-axis scope
 * (company / hotel / department / process).
 *
 * Why not can() middleware? Per memory, can() relies on x-headers which are
 * unreliable. This service derives scope from the entity row (or admin-supplied
 * payload validated against tbl_hospitality_companies) instead of trusting
 * client-supplied headers.
 *
 * NULL semantics on tbl_user_role_scopes:
 *   - hotel_id IS NULL       → "all hotels in company"
 *   - department_id IS NULL  → "all departments in hotel"
 *   - process_id IS NULL     → "all processes (including entities without a process)"
 *
 * Entities with non-NULL fields require the user's scope row to either match
 * exactly or be NULL (wildcard). Entities with NULL fields can only be
 * accessed by users with NULL (wildcard) on that axis — preventing
 * narrow-scoped users from leaking onto unscoped entities.
 *
 * Process-type strictness: when the user's scope row binds a specific
 * process_id, the bound process's process_type must match the entity's
 * expected type (e.g., a TENDER-type scope cannot operate on an RFQ entity).
 * When process_id is NULL on either side, type is unconstrained.
 */

import db from '../config/dbConn.js';

export class AuthorizationError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = 'PROCESS_NOT_IN_USER_SCOPE';
    this.status = 403;
    this.data = data;
  }
}

export class NoApprovalPolicyError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.name = 'NoApprovalPolicyError';
    this.code = 'NO_APPROVAL_POLICY_FOR_PROCESS';
    this.status = 400;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// THE scope predicate — written ONCE, read in both directions.
// ---------------------------------------------------------------------------
// Two questions share this predicate and must never be able to disagree:
//
//   forward — assertUserHasScope(userId, perm, tuple)  "may THIS user act?"
//   inverse — listUsersWithAnyScope(perms, tuple)      "WHO may act?"
//
// The inverse is what powers "who can initiate this PO?" (purchaseOrderModel
// .listPoInitiators). A name shown there that then 403s when its owner tries is
// worse than showing no name at all, so the two are not allowed to be two
// hand-written copies of the same WHERE clause. They are one string, below.
//
// The only difference between the two call sites is what binds `urs.user_id`:
// the forward direction binds it to a parameter, the inverse leaves it free and
// groups by it.
//
// Parameters, in order, starting at $base:
//   $base+0  hospitality_company_id   $base+3  process_id
//   $base+1  hotel_id                 $base+4  permissions  (text[])
//   $base+2  department_id            $base+5  process_type (text|null)
//
// `permissions` is an ARRAY even in the forward direction, where it always
// carries exactly one element. `x = ANY(ARRAY[p])` and `x = p` are the same
// predicate, and the array is what lets the inverse ask about awarding.create
// OR awarding.update in a single pass instead of once per permission.
const SCOPE_MATCH_FROM = `
    FROM tbl_user_role_scopes urs
    JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
    JOIN tbl_permissions p ON p.id = rp.permission_id
    LEFT JOIN tbl_approval_processes proc ON proc.id = urs.process_id`;

// Predicate semantics (matches rbacModel.getUserPermissions + the EXISTS
// clauses in rfqModel for backwards compatibility):
//   - hotel_id: strict. Specific-hotel user cannot act on no-hotel entity;
//     entity-hotel must match user's hotel OR user must be wildcard (NULL).
//   - department_id: permissive when entity has NULL dept (no-dept entity
//     pre-dates dept scoping); otherwise specific-dept match OR wildcard.
//   - process_id: strict. Specific-process user cannot act on no-process
//     entity; entity-process must match OR user must be wildcard (NULL).
//     This is the new axis — gating is intentional (see plan §5).
//   - process_type strictness: only enforced when both the user's scope row
//     binds a specific process AND the caller supplies an expected type.
const scopeMatchWhere = (base) => `
      urs.company_id = $${base}
      AND (urs.hotel_id IS NULL OR urs.hotel_id = $${base + 1})
      AND ($${base + 2}::int IS NULL OR urs.department_id IS NULL OR urs.department_id = $${base + 2})
      AND (urs.process_id IS NULL OR urs.process_id = $${base + 3})
      AND (p.resource || '.' || p.action) = ANY($${base + 4}::text[])
      AND ($${base + 5}::text IS NULL OR urs.process_id IS NULL OR proc.process_type = $${base + 5})`;

const scopeMatchParams = (scope, permissions) => [
  scope.hospitality_company_id,
  scope.hotel_id ?? null,
  scope.department_id ?? null,
  scope.process_id ?? null,
  permissions,
  scope.process_type ?? null,
];

/**
 * Throws AuthorizationError if the user lacks the (permission × scope) grant.
 *
 * @param {number} userId
 * @param {string} requiredPermission - e.g. 'rfq.create', 'awarding.approve'
 * @param {Object} scope
 * @param {number} scope.hospitality_company_id - required
 * @param {number|null} [scope.hotel_id]
 * @param {number|null} [scope.department_id]
 * @param {number|null} [scope.process_id]
 * @param {string|null} [scope.process_type] - 'RFQ' | 'TENDER' | etc. — when
 *   provided, enforces that user's scoped process matches this type.
 * @param {Object} [dbContext] - db or transaction
 * @throws {AuthorizationError}
 */
export async function assertUserHasScope(userId, requiredPermission, scope, dbContext = db) {
  const {
    hospitality_company_id,
    hotel_id = null,
    department_id = null,
    process_id = null,
    process_type = null,
  } = scope;

  if (!userId) {
    throw new AuthorizationError('Missing userId for scope check', { requiredPermission });
  }
  if (!hospitality_company_id) {
    throw new AuthorizationError('Missing hospitality_company_id for scope check', { requiredPermission });
  }
  if (!requiredPermission || typeof requiredPermission !== 'string' || !requiredPermission.includes('.')) {
    throw new Error(`assertUserHasScope: requiredPermission must be 'resource.action', got: ${requiredPermission}`);
  }

  // The WHERE body is scopeMatchWhere() — see the block comment above it for
  // the NULL/wildcard semantics of each axis. It is shared verbatim with
  // listUsersWithAnyScope so the "may this user act?" and "who may act?"
  // answers are computed by the same predicate.
  const row = await dbContext.oneOrNone(
    `
    SELECT 1
    ${SCOPE_MATCH_FROM}
    WHERE urs.user_id = $1
      AND ${scopeMatchWhere(2)}
    LIMIT 1
    `,
    [
      userId,
      ...scopeMatchParams(
        { hospitality_company_id, hotel_id, department_id, process_id, process_type },
        [requiredPermission]
      ),
    ]
  );

  if (!row) {
    throw new AuthorizationError(
      `User lacks ${requiredPermission} scope for this entity`,
      {
        requiredPermission,
        hospitality_company_id,
        hotel_id,
        department_id,
        process_id,
        process_type,
      }
    );
  }
}

/**
 * THE INVERSE of assertUserHasScope: every user whose grant on ANY of
 * `permissions` covers `scope`. Same predicate, same NULL/wildcard semantics —
 * scopeMatchWhere() is shared verbatim, so a user appears here if and only if
 * assertUserHasScope would admit them for at least one of `permissions`.
 *
 * Returns one row per user (not per grant): the role is the LOWEST role_id
 * among the roles through which they qualify, which is deterministic and
 * stable across requests.
 *
 * Emits ids and role titles only — NO personal data. Every caller is expected
 * to join tbl_users itself and apply its own visibility rules (active-only,
 * exclude the caller, …); this function is not an authorization boundary.
 *
 * @param {string[]} permissions - e.g. ['awarding.create', 'awarding.update']
 * @param {Object} scope - same shape as assertUserHasScope's
 * @param {Object} [dbContext]
 * @returns {Promise<Array<{user_id:number, role_id:number, role_title:string}>>}
 */
export async function listUsersWithAnyScope(permissions, scope, dbContext = db) {
  const perms = (Array.isArray(permissions) ? permissions : [permissions])
    .filter((p) => typeof p === 'string' && p.includes('.'));
  if (!perms.length) return [];
  // Mirrors assertUserHasScope's own guard: no company, no grant. Returning []
  // rather than throwing keeps this usable as "who can act?" on an entity whose
  // tenancy could not be resolved — the honest answer there is "nobody known".
  if (!scope?.hospitality_company_id) return [];

  return dbContext.any(
    `
    SELECT DISTINCT ON (urs.user_id)
           urs.user_id,
           urs.role_id,
           rl.title AS role_title
    ${SCOPE_MATCH_FROM}
    JOIN tbl_roles rl ON rl.id = urs.role_id
    WHERE ${scopeMatchWhere(1)}
    ORDER BY urs.user_id, urs.role_id ASC
    `,
    scopeMatchParams(scope, perms)
  );
}

/**
 * Build an EXISTS clause for filtering a LIST query by user's scope rows.
 * The caller composes it into their WHERE: `... AND ${clause}`.
 *
 * The entity table must be aliased and must expose hospitality_company_id,
 * hotel_id, department_id, and process_id columns at that alias.
 *
 * @param {number} userId
 * @param {string} requiredPermission - e.g. 'rfq.read'
 * @param {string} entityAlias - SQL alias of the entity table (e.g. 'r')
 * @param {number} paramOffset - next $N index available in parent query
 * @param {Object} [opts]
 * @param {string|null} [opts.entityProcessTypeColumn] - if set, enforces
 *   process_type strictness using this column (e.g. 'r.expected_process_type').
 *   Typically left null — RFQ derives type from is_tender at the application
 *   layer.
 * @returns {{ clause: string, params: any[], paramsConsumed: number }}
 */
export function buildScopeExistsClause(userId, requiredPermission, entityAlias, paramOffset = 1, opts = {}) {
  if (!entityAlias || /[^a-zA-Z0-9_]/.test(entityAlias)) {
    throw new Error(`buildScopeExistsClause: invalid entityAlias '${entityAlias}'`);
  }

  const p = paramOffset;
  const typeColumn = opts.entityProcessTypeColumn || null;

  const typePredicate = typeColumn
    ? `AND (${typeColumn} IS NULL OR urs.process_id IS NULL OR proc.process_type = ${typeColumn})`
    : '';

  const procJoin = typeColumn
    ? `LEFT JOIN tbl_approval_processes proc ON proc.id = urs.process_id`
    : '';

  // Matches the permissive-on-NULL-dept semantics in rbacModel + rfqModel:
  // entities without a department are visible to any scope row that matches
  // the other axes. process_id stays strict (specific-process users cannot
  // see no-process entities).
  const clause = `EXISTS (
    SELECT 1
    FROM tbl_user_role_scopes urs
    JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
    JOIN tbl_permissions p ON p.id = rp.permission_id
    ${procJoin}
    WHERE urs.user_id = $${p}
      AND urs.company_id = ${entityAlias}.hospitality_company_id
      AND (urs.hotel_id IS NULL OR urs.hotel_id = ${entityAlias}.hotel_id)
      AND (
        ${entityAlias}.department_id IS NULL
        OR urs.department_id IS NULL
        OR urs.department_id = ${entityAlias}.department_id
      )
      AND (urs.process_id IS NULL OR urs.process_id = ${entityAlias}.process_id)
      AND (p.resource || '.' || p.action) = $${p + 1}
      ${typePredicate}
  )`;

  return { clause, params: [userId, requiredPermission], paramsConsumed: 2 };
}

/**
 * "I am being asked to approve this, therefore I may read it."
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
 * Approver resolution and entity visibility are two independent answers to
 * "may this user act on this entity", and they disagree:
 *
 *   resolveApprovers (USER-source)  — does the user hold ANY tbl_user_role_scopes
 *                                     row covering company/hotel/dept/process?
 *   the read predicate              — does the user hold such a row that ALSO
 *                                     carries <resource>.read?
 *
 * Nothing requires those to be the same row, so a user can be resolved as a
 * mandatory approver through a role that grants no read at all. Production
 * incident 2026-08-10, RFQ 791: EMP003 was resolved through 'Commercial
 * Approver' (department-unrestricted, no rfq.read) while their only rfq.read
 * came from 'CEO', which is granted per-department and not for that RFQ's
 * department. They were step 1 of 2 and could not see the RFQ anywhere.
 *
 * It is worse than invisible: getPendingApprovalRfqs ANDs approver-hood with
 * the read predicate, so the "pending my approval" list — the one surface
 * built to show exactly this — returns empty for the person blocking the
 * workflow. Measured across production: 6 such approver slots, EVERY one of
 * them step 1, i.e. deadlocked at the first gate.
 *
 * ── WHY WIDENING READ IS THE RIGHT DIRECTION ─────────────────────────────
 * The alternative is to make resolution stricter so these users are never
 * resolved. That converts an invisible-work bug into a nobody-resolved bug,
 * and a step that resolves to nobody stalls the workflow forever (or, before
 * the createApprovalInstance change shipped alongside this, auto-approved it).
 * Strictness at resolution time is the more dangerous failure.
 *
 * It is also already the system's own position elsewhere:
 *   · THE SNAPSHOT IS THE AUTHORIZATION — submitApprovalAction validates only
 *     that the caller has a PENDING row on the current step. It re-checks no
 *     role, no permission, no scope. Being a resolved approver already confers
 *     the power to APPROVE; this only lets you SEE what you are approving.
 *   · purchaseOrderModel.isAssignedPoApprover does exactly this for the PO
 *     approve endpoint, with the same reasoning, and is explicitly scoped
 *     "never for reads" — which is precisely the gap that left approvers able
 *     to approve a PO they cannot open.
 *   · arcScope.js drops the permission join wholesale because "approval-policy
 *     approvers legitimately hold no ARC module role at all, yet they must see
 *     the ARC they are approving".
 *
 * ── HOW NARROW THIS IS ───────────────────────────────────────────────────
 * It grants read on ONE entity — the specific row you have a live, non-removed,
 * PENDING approver assignment against. It is not scope, not a permission, not
 * inheritable, and it evaporates when the instance completes or the approver
 * row is removed/retired. An admin naming you as approver IS the authorization
 * decision; this makes the read side honour the decision the engine already
 * acted on.
 *
 * @param {string} entityIdExpr  SQL expression for the entity's id, e.g. 'RFQ.id'
 * @param {string[]} entityTypes approval entity_type values that point at it,
 *                               e.g. ['RFQ','TENDER']
 * @param {number|string} userParam bound user id or a $n placeholder
 * @returns {string} an EXISTS(...) fragment safe to OR into a WHERE clause
 */
export function buildApproverReadExemption(entityIdExpr, entityTypes, userParam) {
  if (!entityIdExpr || /[^a-zA-Z0-9_.]/.test(entityIdExpr)) {
    throw new Error(`buildApproverReadExemption: invalid entityIdExpr '${entityIdExpr}'`);
  }
  if (!Array.isArray(entityTypes) || entityTypes.length === 0) {
    throw new Error('buildApproverReadExemption: entityTypes must be a non-empty array');
  }
  // entity_type values are developer-supplied constants, never user input, but
  // they are interpolated into SQL so they are whitelisted by shape anyway.
  for (const t of entityTypes) {
    if (!/^[A-Z_]+$/.test(t)) {
      throw new Error(`buildApproverReadExemption: invalid entity_type '${t}'`);
    }
  }
  const typeList = entityTypes.map(t => `'${t}'`).join(', ');

  // Deliberately NOT restricted to `ais.step_order = ai.current_step`: a
  // later-step approver must be able to read the entity before their turn
  // arrives, which is exactly what Ash II could do (by luck of scope) and
  // Ash I could not. Restricted to instances still PENDING and approver rows
  // still PENDING and not removed, so completed and retired assignments grant
  // nothing.
  return `EXISTS (
    SELECT 1
      FROM tbl_approval_instances ai
      JOIN tbl_approval_instance_steps ais ON ais.approval_instance_id = ai.id
      JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = ais.id
     WHERE ai.status = 'PENDING'
       AND ai.entity_type IN (${typeList})
       AND ai.entity_id = ${entityIdExpr}
       AND asa.approver_user_id = ${userParam}
       AND asa.status = 'PENDING'
       AND asa.removed_at IS NULL
  )`;
}

/**
 * Defense-in-depth gate for per-entity GET endpoints (TE detail, quote
 * compare, PO detail, RFQ details). Reads the RFQ row at `rfqId` and asserts
 * the user has `rfq.read` (or `boq.read` for tenders) scope including
 * process_id.
 *
 * Why `rfq.read`/`boq.read` rather than the entity-specific permission (e.g.
 * `te.read`, `awarding.read`)? The seeded buyer roles all carry rfq.read /
 * boq.read but not every entity-specific read permission — using the parent
 * RFQ's read gate keeps the existing role/permission contract intact while
 * still enforcing the (hotel × dept × process) scope tuple.
 *
 * No-op for non-hospitality RFQs (legacy buyer flow has no scope to enforce).
 * Throws AuthorizationError(403, PROCESS_NOT_IN_USER_SCOPE) on miss.
 *
 * @param {number} userId
 * @param {number} rfqId — the parent RFQ to source scope from (PO/TE/QC
 *   entities all roll up to one RFQ)
 * @param {Object} [dbContext]
 */
export async function assertCanReadParentRfq(userId, rfqId, dbContext = db) {
  if (!rfqId) {
    throw new AuthorizationError('Missing rfq id for scope check', {});
  }
  const rfq = await dbContext.oneOrNone(
    `SELECT id, hospitality_company_id, hotel_id, department_id, process_id, is_tender
     FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );
  // Non-existent RFQ: leave the existing handler's own not-found behavior intact.
  if (!rfq) return;

  // A NULL hospitality_company_id used to short-circuit to ALLOW. That turned
  // every caller of this helper into an open door, because the saveRfqDraft
  // defect (fixed in 92604b60) wiped the column on 84 production RFQs — so the
  // bypass was reachable in practice, not theoretical.
  //
  // Re-derive the tenant from the RFQ's own hotel (column first, then its hotel
  // mapping), exactly as the repair script does, and enforce against that. Only
  // when no tenant can be established at all do we refuse: an RFQ with no hotel,
  // no mapping and no company has no tenant to authorise against, and failing
  // closed is the only safe reading. In production that is 4 abandoned,
  // unpublished drafts with no hotel_id, no department and no hotel mapping.
  let companyId = rfq.hospitality_company_id;
  let hotelId = rfq.hotel_id;
  if (!companyId) {
    const derived = await dbContext.oneOrNone(
      `SELECT h.id AS hotel_id, h.hospitality_company_id
         FROM tbl_hospitality_company_hotels h
        WHERE h.is_deleted = 0
          AND h.id = COALESCE(
                $2::int,
                (SELECT m.hotel_id FROM tbl_rfq_hotel_mappings m
                  WHERE m.rfq_id = $1 ORDER BY m.id LIMIT 1))`,
      [rfq.id, rfq.hotel_id]
    );
    if (!derived) {
      throw new AuthorizationError('RFQ has no resolvable tenant', { rfq_id: rfq.id });
    }
    companyId = derived.hospitality_company_id;
    hotelId = hotelId ?? derived.hotel_id;
  }

  const resource = Number(rfq.is_tender) === 1 ? 'boq' : 'rfq';
  await assertUserHasScope(userId, `${resource}.read`, {
    hospitality_company_id: companyId,
    hotel_id: hotelId,
    department_id: rfq.department_id,
    process_id: rfq.process_id,
  }, dbContext);
}

/**
 * Boolean convenience: does this user have read scope for this entity row?
 * Returns true/false, never throws (other than DB errors).
 */
export async function userCanReadEntity(userId, resource, entity, dbContext = db) {
  try {
    await assertUserHasScope(userId, `${resource}.read`, {
      hospitality_company_id: entity.hospitality_company_id,
      hotel_id: entity.hotel_id,
      department_id: entity.department_id,
      process_id: entity.process_id,
    }, dbContext);
    return true;
  } catch (err) {
    if (err instanceof AuthorizationError) return false;
    throw err;
  }
}

/**
 * Send a typed error as a JSON response. Recognized errors expose their
 * code/status/data; anything else becomes a generic 500.
 *
 * Callers in controllers:
 *   } catch (err) {
 *     return sendScopeError(res, err);
 *   }
 */
export function sendScopeError(res, err) {
  if (err instanceof AuthorizationError || err instanceof NoApprovalPolicyError) {
    return res.status(err.status).json({
      status: 3,
      code: err.code,
      message: err.message,
      data: err.data,
    });
  }
  return res.status(500).json({
    status: 3,
    message: err?.message || 'Internal server error',
  });
}

/**
 * Check whether an error is one of the typed authorization/policy errors.
 * Useful inside generic try/catch where the caller wants to re-render the
 * structured response without importing the classes.
 */
export function isAuthorizationError(err) {
  return err instanceof AuthorizationError;
}

export function isNoApprovalPolicyError(err) {
  return err instanceof NoApprovalPolicyError;
}
