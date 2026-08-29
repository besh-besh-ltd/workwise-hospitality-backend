import db from '../config/dbConn.js';

/**
 * What is stuck, and what an administrator can actually do about it.
 *
 * Production holds 332 PENDING approval instances, 198 of them older than a
 * month and the oldest 180 days. Presented as a list that is the least useful
 * screen in the product: an admin cannot tell which of them is a real problem,
 * so the honest answer to "is anything stuck?" has been "332 things, probably".
 *
 * Measured against production, almost none of them are waiting on a person:
 *
 *   overtaken  215   the work moved past the point where approving changes
 *                    anything — 214 RFQs whose bid window has already closed,
 *                    and one purchase order that reached the vendor anyway
 *   waiting    114   a live person could act right now
 *   blocked      3   nobody can act at all
 *
 * That is the whole value of this query. Three rows need an administrator
 * today; 215 need cancelling, not chasing; and the remaining 114 need a nudge
 * to a named person. A screen that says so is worth building. A screen that
 * lists 332 rows is not.
 */

// Every pending instance's current_step equals the lowest step_order among its
// PENDING steps — verified across all 332 in production, no exceptions — so
// this join is what "the step it is waiting on" means. 63 instances carry more
// than one PENDING step; only the one at current_step can be acted on.
const CURRENT_STEP_JOIN = `
    JOIN tbl_approval_instance_steps s
      ON s.approval_instance_id = ai.id AND s.step_order = ai.current_step`;

// A person who could act: the approver row is not a tombstone, and the account
// behind it still works. Both halves matter — the engine keeps REMOVED rows
// deliberately so an audit view can show who was taken off and why, and a
// deactivated user's row is left in place for the same reason.
const HAS_LIVE_APPROVER = `
    EXISTS (SELECT 1
              FROM tbl_approval_step_approvers sa
              JOIN tbl_users u ON u.id = sa.approver_user_id
             WHERE sa.approval_instance_step_id = s.id
               AND COALESCE(sa.status, 'PENDING') <> 'REMOVED'
               AND u.status = 1
               AND COALESCE(u.is_deleted, 0) = 0)`;

/**
 * Whether approving would still mean anything.
 *
 * Computed only where it can be computed truthfully. An RFQ whose bid window
 * has closed can take no more quotes, so publishing approval for it is moot;
 * a purchase order that has left the approval states has already gone to the
 * vendor. For the other entity types there is no equivalent fact on the row,
 * and inventing one would be worse than saying nothing — those simply come
 * back as `waiting`, which is what they are.
 *
 * bid_end_date is text holding a naive IST wall clock, so it is compared in
 * Asia/Kolkata explicitly. Comparing it against now() would be right on a
 * developer's machine and five and a half hours wrong in production.
 */
const OVERTAKEN = `
    CASE
      WHEN ai.entity_type = 'RFQ' THEN EXISTS (
        SELECT 1 FROM tbl_rfq r
         WHERE r.id = ai.entity_id
           AND NULLIF(r.bid_end_date, '') IS NOT NULL
           AND r.bid_end_date::timestamp < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))
      WHEN ai.entity_type = 'PO' THEN EXISTS (
        SELECT 1 FROM tbl_rfq_purchase_order p
         WHERE p.id = ai.entity_id
           AND p.status NOT IN ('draft', 'pending_approval'))
      ELSE false
    END`;

const CLASSIFICATION = `
    CASE WHEN NOT ${HAS_LIVE_APPROVER} THEN 'blocked'
         WHEN ${OVERTAKEN} THEN 'overtaken'
         ELSE 'waiting' END`;

export const STUCK_CLASSES = ['blocked', 'overtaken', 'waiting'];

/**
 * The counts, for the screen's summary and for the Overview tile.
 *
 * Separate from the list because it must not move when the list is filtered or
 * paged: "3 blocked" has to mean three in the company, not three on this page.
 */
export async function countStuckApprovals(companyIds, { olderThanDays = 0 } = {}) {
  if (!companyIds?.length) return { blocked: 0, overtaken: 0, waiting: 0, total: 0 };

  const rows = await db.any(
    `SELECT ${CLASSIFICATION} AS class, count(*)::int AS count
       FROM tbl_approval_instances ai
       ${CURRENT_STEP_JOIN}
      WHERE ai.status = 'PENDING'
        AND ai.hospitality_company_id IN ($1:csv)
        AND ai.created_at < now() - ($2 || ' days')::interval
      GROUP BY 1`,
    [companyIds, Number(olderThanDays) || 0]
  );

  const counts = { blocked: 0, overtaken: 0, waiting: 0, total: 0 };
  for (const row of rows) {
    counts[row.class] = row.count;
    counts.total += row.count;
  }
  return counts;
}

/**
 * The list itself.
 *
 * Approvers are returned in full, tombstones and deactivated accounts
 * included, each carrying why it cannot act. Dropping them would answer
 * "who is this waiting on?" with silence in exactly the cases where the
 * question is being asked.
 */
export async function listStuckApprovals(
  companyIds,
  { olderThanDays = 0, classes = null, entityType = null, hotelId = null, limit = 50, offset = 0 } = {}
) {
  if (!companyIds?.length) return { rows: [], total: 0 };

  const where = [
    'ai.status = $/status/',
    'ai.hospitality_company_id IN ($/companyIds:csv/)',
    "ai.created_at < now() - ($/olderThanDays/ || ' days')::interval",
  ];
  const params = {
    status: 'PENDING',
    companyIds,
    olderThanDays: Number(olderThanDays) || 0,
    entityType,
    hotelId,
    classes,
    limit: Math.min(Number(limit) || 50, 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
  if (entityType) where.push('ai.entity_type = $/entityType/');
  if (hotelId) where.push('ai.hotel_id = $/hotelId/');

  // The class is a computed expression, so it cannot be filtered in WHERE
  // without repeating it. Wrapping keeps one definition of what each word
  // means — two copies would drift, and the count and the list would disagree.
  const having = classes?.length ? 'WHERE q.class IN ($/classes:csv/)' : '';

  const base = `
    SELECT ai.id, ai.entity_type, ai.entity_id, ai.hospitality_company_id,
           ai.hotel_id, ai.created_at, ai.current_step, ai.initiated_by,
           s.id AS step_id, s.decision_rule, s.step_order,
           ${CLASSIFICATION} AS class,
           (now()::date - ai.created_at::date)::int AS age_days
      FROM tbl_approval_instances ai
      ${CURRENT_STEP_JOIN}
     WHERE ${where.join(' AND ')}`;

  const [{ count }] = await db.any(
    `SELECT count(*)::int FROM (${base}) q ${having}`,
    params
  );

  const rows = await db.any(
    `SELECT q.*,
            h.name AS hotel_name,
            c.name AS company_name,
            initiator.name AS initiated_by_name,
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'user_id',      sa.approver_user_id,
                        'name',         u.name,
                        'email',        u.email,
                        'row_status',   COALESCE(sa.status, 'PENDING'),
                        'removed_at',   sa.removed_at,
                        'removal_reason', sa.removal_reason,
                        'can_act',      COALESCE(sa.status, 'PENDING') <> 'REMOVED'
                                          AND u.status = 1
                                          AND COALESCE(u.is_deleted, 0) = 0,
                        'account_active', u.status = 1 AND COALESCE(u.is_deleted, 0) = 0)
                      ORDER BY sa.id)
                 FROM tbl_approval_step_approvers sa
                 LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
                WHERE sa.approval_instance_step_id = q.step_id),
              '[]'::json) AS approvers
       FROM (${base}) q
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = q.hotel_id
       LEFT JOIN tbl_hospitality_companies c ON c.id = q.hospitality_company_id
       LEFT JOIN tbl_users initiator ON initiator.id = q.initiated_by
       ${having}
      ORDER BY q.created_at ASC
      LIMIT $/limit/ OFFSET $/offset/`,
    params
  );

  return { rows, total: count };
}

/** The instance a reassignment targets, with everything the guard needs. */
export async function getStuckInstance(instanceId) {
  return db.oneOrNone(
    `SELECT ai.id, ai.status, ai.entity_type, ai.entity_id,
            ai.hospitality_company_id, ai.hotel_id, ai.department_id,
            s.id AS step_id, s.step_order, s.status AS step_status
       FROM tbl_approval_instances ai
       ${CURRENT_STEP_JOIN}
      WHERE ai.id = $1`,
    [instanceId]
  );
}

export async function getStepApprover(stepId, userId) {
  return db.oneOrNone(
    `SELECT id, status, approver_user_id
       FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id = $1 AND approver_user_id = $2`,
    [stepId, userId]
  );
}

/**
 * Move a pending step from one approver to another.
 *
 * The outgoing approver is tombstoned rather than deleted, which is the
 * invariant the whole approval engine already holds: `status = 'REMOVED'` with
 * `removed_at` and `removal_reason`, so a later reader can see who was taken
 * off and why. Deleting the row would make the reassignment itself invisible,
 * which is the opposite of what an administrator reaching for this needs.
 *
 * One transaction, because a half-applied reassignment leaves a step with
 * either two live approvers or none.
 *
 * The acting user is not passed in: the pg-promise connect hook stamps
 * `app.actor_id` from the request context, and the row-level audit trigger on
 * tbl_approval_step_approvers reads it. Threading it by hand would be a second
 * source of truth for the same fact.
 */
export async function reassignApprover({ stepId, fromUserId, toUserId, reason }) {
  return db.tx(async (t) => {
    await t.none(
      `UPDATE tbl_approval_step_approvers
          SET status = 'REMOVED', removed_at = now(), removal_reason = $3
        WHERE approval_instance_step_id = $1
          AND approver_user_id = $2
          AND COALESCE(status, 'PENDING') <> 'REMOVED'`,
      [stepId, fromUserId, reason]
    );

    // A previous tombstone for the incoming person is revived rather than
    // duplicated: the same person can be taken off a step and put back on it,
    // and two rows for one approver would double them in every ANY/ALL count.
    const revived = await t.oneOrNone(
      `UPDATE tbl_approval_step_approvers
          SET status = 'PENDING', removed_at = NULL, removal_reason = NULL,
              added_mid_flight = true
        WHERE approval_instance_step_id = $1 AND approver_user_id = $2
        RETURNING id`,
      [stepId, toUserId]
    );
    if (revived) return revived.id;

    const inserted = await t.one(
      `INSERT INTO tbl_approval_step_approvers
              (approval_instance_step_id, approver_user_id, status, added_mid_flight, created_at)
       VALUES ($1, $2, 'PENDING', true, now())
       RETURNING id`,
      [stepId, toUserId]
    );
    return inserted.id;
  });
}

/**
 * Who may be handed a step.
 *
 * Restricted to people who already hold a role scope in the same company, so
 * reassignment cannot reach outside the tenant or hand authority to somebody
 * with no standing in the business at all. Deactivated accounts are excluded:
 * moving a step to one would produce exactly the blockage being cleared.
 */
export async function listReassignmentCandidates(companyId, { hotelId = null, search = null } = {}) {
  return db.any(
    `SELECT DISTINCT u.id, u.name, u.email
       FROM tbl_users u
       JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
      WHERE urs.company_id = $/companyId/
        AND ($/hotelId/::int IS NULL OR urs.hotel_id IS NULL OR urs.hotel_id = $/hotelId/)
        AND u.status = 1
        AND COALESCE(u.is_deleted, 0) = 0
        AND ($/search/::text IS NULL OR u.name ILIKE '%' || $/search/ || '%'
                                     OR u.email ILIKE '%' || $/search/ || '%')
      ORDER BY u.name
      LIMIT 100`,
    { companyId, hotelId, search }
  );
}
