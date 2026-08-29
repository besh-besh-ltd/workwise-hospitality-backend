import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';

/**
 * Writes and reads the company activity trail.
 *
 * Two rules run through this file.
 *
 * Recording must never break the thing being recorded. Every write here
 * swallows its own errors and logs them. An admin losing a line in the feed is
 * a gap in a report; an admin unable to publish an RFQ because the feed write
 * failed is an outage.
 *
 * Labels are snapshotted, never joined at read time. See the migration for
 * why: joins make a mixed feed slow, and re-resolving names later would
 * silently rewrite what the trail says happened last March.
 */

const SEVERITIES = new Set(['routine', 'notable', 'critical']);
const SOURCES = new Set(['HTTP', 'CRON', 'WEBHOOK', 'BACKFILL']);

export async function recordActivityEvent(event, txContext = null) {
  const t = txContext || db;
  try {
    if (!event?.hospitalityCompanyId) {
      // Company is the scoping key; a row without one could never be shown to
      // anybody, so writing it would only grow the table.
      logger.warn({ eventKey: event?.eventKey }, 'Activity event dropped: no company scope');
      return null;
    }

    const severity = SEVERITIES.has(event.severity) ? event.severity : 'routine';
    const source = SOURCES.has(event.source) ? event.source : 'HTTP';

    const row = await t.one(
      `INSERT INTO tbl_activity_events (
         occurred_at, request_id, source, event_key, category, severity,
         actor_type, actor_user_id, actor_label,
         hospitality_company_id, hotel_id, department_id,
         entity_type, entity_id, entity_label,
         summary, metadata, http_method, route_pattern, status_code,
         is_reconstructed
       ) VALUES (
         COALESCE($1, now()), $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17::jsonb, $18, $19, $20,
         $21
       ) RETURNING id`,
      [
        event.occurredAt || null,
        event.requestId || null,
        source,
        event.eventKey || null,
        event.category || 'Other',
        severity,
        event.actorType || 'UNKNOWN',
        event.actorUserId ?? null,
        event.actorLabel || 'Someone',
        event.hospitalityCompanyId,
        event.hotelId ?? null,
        event.departmentId ?? null,
        event.entityType || null,
        event.entityId ?? null,
        event.entityLabel || null,
        event.summary || 'Something happened',
        JSON.stringify(event.metadata || {}),
        event.httpMethod || null,
        event.routePattern || null,
        event.statusCode ?? null,
        event.isReconstructed === true,
      ]
    );
    return row.id;
  } catch (err) {
    logger.error(
      { err: err.message, eventKey: event?.eventKey },
      'Failed to record activity event'
    );
    return null;
  }
}

/**
 * Resolves which company and business unit an entity belongs to.
 *
 * Deliberately derived from the entity's own row, never from the
 * x-company-id / x-hotel-id headers. Those exist, but the codebase's own
 * security work concluded they are not trustworthy for scoping, and a trail
 * that can be pointed at another company's events by editing a header is not
 * an audit trail.
 */
const ENTITY_SCOPE_SQL = {
  RFQ: 'SELECT hospitality_company_id, hotel_id, rfq_no::text AS label FROM tbl_rfq WHERE id = $1',
  TENDER: 'SELECT hospitality_company_id, hotel_id, rfq_no::text AS label FROM tbl_rfq WHERE id = $1',
  PO: `SELECT r.hospitality_company_id, r.hotel_id, po.po_number::text AS label
         FROM tbl_rfq_purchase_order po
         JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.id = $1`,
  ARC: 'SELECT hospitality_company_id, hotel_id, COALESCE(arc_number::text, title) AS label FROM tbl_arc WHERE id = $1',
  MR: 'SELECT hospitality_company_id, hotel_id, COALESCE(mr_number::text, title) AS label FROM tbl_material_requisition WHERE id = $1',
  COMPANY: 'SELECT id AS hospitality_company_id, NULL::integer AS hotel_id, name AS label FROM tbl_hospitality_companies WHERE id = $1',
  HOTEL: 'SELECT hospitality_company_id, id AS hotel_id, name AS label FROM tbl_hospitality_company_hotels WHERE id = $1',
  APPROVAL_INSTANCE:
    'SELECT hospitality_company_id, hotel_id, entity_type AS label FROM tbl_approval_instances WHERE id = $1',
  APPROVAL_POLICY:
    'SELECT hospitality_company_id, hotel_id, entity_type AS label FROM tbl_approval_policies WHERE id = $1',
  // A person, as the subject of an event rather than its actor — which is what
  // an internal-console route acts on. The join is what scopes it: a user with
  // no hospitality mapping belongs to no company's trail, and an event nobody
  // could ever be shown is not worth a row.
  USER: `SELECT m.hospitality_company_id, m.hospitality_hotel_id AS hotel_id,
                COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS label
           FROM tbl_users u
           JOIN tbl_hospitality_user_mappings m ON m.user_id = u.id
          WHERE u.id = $1
          ORDER BY m.mapping_type ASC, m.id ASC
          LIMIT 1`,
};

export async function resolveEntityScope(entityType, entityId) {
  const sql = ENTITY_SCOPE_SQL[entityType];
  if (!sql || !entityId) return null;
  try {
    return await db.oneOrNone(sql, [entityId]);
  } catch (err) {
    logger.warn(
      { err: err.message, entityType, entityId },
      'Could not resolve activity scope from entity'
    );
    return null;
  }
}

/**
 * The company a user belongs to, for events about accounts rather than about
 * work. Note this is the *hospitality* company, which is a different id space
 * from tbl_users.company_id.
 */
export async function resolveUserScope(userId) {
  if (!userId) return null;
  try {
    return await db.oneOrNone(
      `SELECT hospitality_company_id, hospitality_hotel_id AS hotel_id
         FROM tbl_hospitality_user_mappings
        WHERE user_id = $1
        ORDER BY mapping_type ASC, id ASC
        LIMIT 1`,
      [userId]
    );
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Could not resolve activity scope from user');
    return null;
  }
}

export const ACTIVITY_ENTITY_TYPES = Object.keys(ENTITY_SCOPE_SQL);

// ── Reading the trail ────────────────────────────────────────────────────

/**
 * The companies an admin may see activity for.
 *
 * Scoped exactly as the Organisation screen scopes itself — the hospitality
 * companies under the caller's buyer company — so the trail shows the estate
 * they actually administer and nothing else. Derived from the authenticated
 * user, never from a query parameter, because a filter that widens scope is
 * not a filter.
 */
export async function companiesVisibleTo(buyerCompanyId) {
  if (!buyerCompanyId) return [];
  return db.map(
    `SELECT id FROM tbl_hospitality_companies
      WHERE buyer_company_id = $1 AND is_deleted = 0`,
    [buyerCompanyId],
    (r) => r.id
  );
}

const LIST_COLUMNS = `
  id, occurred_at, request_id, source, event_key, category, severity,
  actor_type, actor_user_id, actor_label,
  hospitality_company_id, hotel_id, department_id,
  entity_type, entity_id, entity_label,
  summary, metadata, http_method, route_pattern, status_code, is_reconstructed`;

/**
 * One page of the feed.
 *
 * Every filter narrows; none can widen. `companyIds` is resolved from the
 * session before this is called and is the only thing standing between one
 * client's admin and another client's activity.
 */
export async function listActivity({
  companyIds,
  from = null,
  to = null,
  categories = null,
  severities = null,
  actorUserId = null,
  actorType = null,
  entityType = null,
  entityId = null,
  hotelId = null,
  search = null,
  limit = 50,
  offset = 0,
}) {
  if (!companyIds?.length) return { rows: [], total: 0 };

  const where = ['hospitality_company_id = ANY($1)'];
  const params = [companyIds];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (from) add('occurred_at >= $?', from);
  if (to) add('occurred_at <= $?', to);
  if (categories?.length) add('category = ANY($?)', categories);
  if (severities?.length) add('severity = ANY($?)', severities);
  if (actorUserId) add('actor_user_id = $?', actorUserId);
  if (actorType) add('actor_type = $?', actorType);
  if (entityType) add('entity_type = $?', entityType);
  if (entityId) add('entity_id = $?', entityId);
  if (hotelId) add('hotel_id = $?', hotelId);
  // Trigram index on summary makes this usable without a tsvector column.
  if (search) add('summary ILIKE $?', `%${search}%`);

  const whereSql = where.join(' AND ');
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const [rows, count] = await Promise.all([
    db.any(
      `SELECT ${LIST_COLUMNS} FROM tbl_activity_events
        WHERE ${whereSql}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    ),
    db.one(
      `SELECT count(*)::int AS total FROM tbl_activity_events WHERE ${whereSql}`,
      params
    ),
  ]);

  return { rows, total: count.total };
}

/**
 * What the filter dropdowns should offer.
 *
 * Built from what this company actually has rather than from the full
 * catalogue, so an admin is never offered a filter that returns nothing.
 */
export async function activityFacets(companyIds) {
  if (!companyIds?.length) return { categories: [], actors: [], entityTypes: [], units: [] };

  const [categories, actors, entityTypes, units] = await Promise.all([
    db.any(
      `SELECT category, count(*)::int AS count FROM tbl_activity_events
        WHERE hospitality_company_id = ANY($1)
        GROUP BY category ORDER BY count DESC`,
      [companyIds]
    ),
    db.any(
      `SELECT actor_user_id, actor_label, actor_type, count(*)::int AS count
         FROM tbl_activity_events
        WHERE hospitality_company_id = ANY($1) AND actor_user_id IS NOT NULL
        GROUP BY actor_user_id, actor_label, actor_type
        ORDER BY count DESC LIMIT 100`,
      [companyIds]
    ),
    db.any(
      `SELECT entity_type, count(*)::int AS count FROM tbl_activity_events
        WHERE hospitality_company_id = ANY($1) AND entity_type IS NOT NULL
        GROUP BY entity_type ORDER BY count DESC`,
      [companyIds]
    ),
    db.any(
      `SELECT e.hotel_id, h.name AS hotel_name, count(*)::int AS count
         FROM tbl_activity_events e
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = e.hotel_id
        WHERE e.hospitality_company_id = ANY($1) AND e.hotel_id IS NOT NULL
        GROUP BY e.hotel_id, h.name ORDER BY count DESC`,
      [companyIds]
    ),
  ]);

  return { categories, actors, entityTypes, units };
}

/**
 * The column-level changes one event produced.
 *
 * This is what turns "Priya renamed Company A" into something an admin can
 * check. The event is re-read under the caller's company scope first, so an
 * id from another company returns nothing rather than leaking its diff.
 */
export async function activityChanges(eventId, companyIds) {
  if (!companyIds?.length) return null;

  const event = await db.oneOrNone(
    `SELECT ${LIST_COLUMNS} FROM tbl_activity_events
      WHERE id = $1 AND hospitality_company_id = ANY($2)`,
    [eventId, companyIds]
  );
  if (!event) return null;

  const changes = event.request_id
    ? await db.any(
        `SELECT table_name, operation, record_id, old_data, new_data, changed_at
           FROM tbl_audit_row_changes
          WHERE request_id = $1
          ORDER BY id`,
        [event.request_id]
      )
    : [];

  return { event, changes };
}
