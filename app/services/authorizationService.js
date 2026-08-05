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
  const row = await dbContext.oneOrNone(
    `
    SELECT 1
    FROM tbl_user_role_scopes urs
    JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
    JOIN tbl_permissions p ON p.id = rp.permission_id
    LEFT JOIN tbl_approval_processes proc ON proc.id = urs.process_id
    WHERE urs.user_id = $1
      AND urs.company_id = $2
      AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)
      AND ($4::int IS NULL OR urs.department_id IS NULL OR urs.department_id = $4)
      AND (urs.process_id IS NULL OR urs.process_id = $5)
      AND (p.resource || '.' || p.action) = $6
      AND ($7::text IS NULL OR urs.process_id IS NULL OR proc.process_type = $7)
    LIMIT 1
    `,
    [userId, hospitality_company_id, hotel_id, department_id, process_id, requiredPermission, process_type]
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
