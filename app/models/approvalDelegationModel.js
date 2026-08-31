import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';

/**
 * "While I am away, X covers my approvals."
 *
 * Applied where approvers are RESOLVED, which is what makes it forward-only:
 * an approval instance that already exists keeps the approvers it was created
 * with. Moving one of those is reassignment, a different action with different
 * guards, deliberately.
 */

/**
 * Who is covering for a set of people, right now.
 *
 * Batched because the resolver has a list of approvers, not one, and a query
 * per approver would put a round trip on every approval instance created.
 */
export async function activeDelegationsFor(userIds, at = null) {
  if (!userIds?.length) return new Map();
  const rows = await db.any(
    `SELECT delegator_user_id, delegate_user_id, id, reason
       FROM tbl_approval_delegations
      WHERE delegator_user_id IN ($1:csv)
        AND revoked_at IS NULL
        AND starts_at <= COALESCE($2::timestamptz, now())
        AND ends_at   >  COALESCE($2::timestamptz, now())
      ORDER BY starts_at DESC, id DESC`,
    [userIds, at]
  );

  // Overlapping windows are refused on create, so there should be at most one
  // per delegator. `first wins` is the tiebreak if one ever slips through — an
  // ambiguous answer is still better than an arbitrary one changing per call.
  const byDelegator = new Map();
  for (const row of rows) {
    if (!byDelegator.has(row.delegator_user_id)) byDelegator.set(row.delegator_user_id, row);
  }
  return byDelegator;
}

/**
 * Swap in whoever is covering.
 *
 * Substitution, not addition. "I am away" means the approval should go to the
 * other person, and adding them instead would mean an ALL step waits for
 * somebody who is on a beach.
 *
 * Three things it refuses to do, each of which would be a way to move
 * authority somewhere the role model would not have put it:
 *
 *   - Follow a chain. If the delegate is themselves delegating, the delegation
 *     stops at one hop. A chain is how an approval lands on somebody who has
 *     no idea it is theirs.
 *   - Leave the company. The delegate must hold a role scope in the same
 *     hospitality company, so cover can never cross a tenant boundary.
 *   - Empty a step. If the delegate is inactive or ineligible the original
 *     approver stays. A step that resolves to nobody makes the whole instance
 *     throw APPROVAL_POLICY_RESOLVES_TO_NOBODY, so a bad delegation would stop
 *     a purchase order being raised at all.
 */
export async function applyDelegations(userIds, hospitalityCompanyId, t = db) {
  if (!userIds?.length) return userIds;

  let delegations;
  try {
    delegations = await activeDelegationsFor(userIds);
  } catch (err) {
    // Never let cover break resolution. Without a delegation an approval goes
    // to the person who was always going to get it, which is a worse outcome
    // than the feature working and a far better one than no approval at all.
    logger.warn({ err: err.message }, 'Could not read approval delegations');
    return userIds;
  }
  if (delegations.size === 0) return userIds;

  const out = [];
  for (const userId of userIds) {
    const delegation = delegations.get(userId);
    if (!delegation) {
      out.push(userId);
      continue;
    }

    const delegate = await t.oneOrNone(
      `SELECT u.id
         FROM tbl_users u
        WHERE u.id = $1
          AND u.status = 1
          AND COALESCE(u.is_deleted, 0) = 0
          AND EXISTS (SELECT 1 FROM tbl_user_role_scopes urs
                       WHERE urs.user_id = u.id AND urs.company_id = $2)`,
      [delegation.delegate_user_id, hospitalityCompanyId]
    );

    out.push(delegate ? Number(delegate.id) : userId);
  }
  return [...new Set(out)];
}

/** Every delegation touching a person, either end of it. */
export async function listDelegations(companyIds, { includeExpired = false } = {}) {
  if (!companyIds?.length) return [];
  return db.any(
    `SELECT d.id, d.delegator_user_id, d.delegate_user_id, d.starts_at, d.ends_at,
            d.reason, d.created_at, d.revoked_at,
            dr.name AS delegator_name, dr.email AS delegator_email,
            de.name AS delegate_name, de.email AS delegate_email,
            (d.revoked_at IS NULL AND d.starts_at <= now() AND d.ends_at > now()) AS is_active
       FROM tbl_approval_delegations d
       JOIN tbl_users dr ON dr.id = d.delegator_user_id
       JOIN tbl_users de ON de.id = d.delegate_user_id
      WHERE EXISTS (SELECT 1 FROM tbl_user_role_scopes urs
                     WHERE urs.user_id = d.delegator_user_id
                       AND urs.company_id IN ($1:csv))
        AND ($2 OR d.ends_at > now())
      ORDER BY d.starts_at DESC`,
    [companyIds, includeExpired]
  );
}

/** An overlapping, still-live delegation for the same person, if any. */
export async function findOverlappingDelegation({ delegatorUserId, startsAt, endsAt, excludeId = null }) {
  return db.oneOrNone(
    `SELECT id, starts_at, ends_at
       FROM tbl_approval_delegations
      WHERE delegator_user_id = $1
        AND revoked_at IS NULL
        AND starts_at < $3
        AND ends_at   > $2
        AND ($4::int IS NULL OR id <> $4)
      LIMIT 1`,
    [delegatorUserId, startsAt, endsAt, excludeId]
  );
}

export async function createDelegation({ delegatorUserId, delegateUserId, startsAt, endsAt, reason, createdBy }) {
  return db.one(
    `INSERT INTO tbl_approval_delegations
            (delegator_user_id, delegate_user_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [delegatorUserId, delegateUserId, startsAt, endsAt, reason || null, createdBy]
  );
}

export async function getDelegation(id) {
  return db.oneOrNone(`SELECT * FROM tbl_approval_delegations WHERE id = $1`, [id]);
}

/** Ended early. Never deleted: "who was covering on the 14th" stays answerable. */
export async function revokeDelegation(id, revokedBy) {
  return db.result(
    `UPDATE tbl_approval_delegations
        SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, revokedBy]
  );
}
