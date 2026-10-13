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

/**
 * The table an event's own entity lives in, so its row change can be sorted to
 * the top of the expansion. Only the entity types the registry actually emits
 * need an entry; anything unmapped simply keeps insertion order.
 */
const ENTITY_TABLES = {
  RFQ: 'tbl_rfq',
  PO: 'tbl_rfq_purchase_order',
  QUOTE: 'tbl_quotes',
  USER: 'tbl_users',
  ROLE: 'tbl_roles',
  COMPANY: 'tbl_hospitality_companies',
  BUSINESS_UNIT: 'tbl_hospitality_company_hotels',
  HOTEL: 'tbl_hospitality_company_hotels',
  APPROVAL_POLICY: 'tbl_approval_policies',
  APPROVAL_PROCESS: 'tbl_approval_processes',
  APPROVAL_DELEGATION: 'tbl_approval_delegations',
  APPROVAL: 'tbl_approval_instances',
  APPROVAL_INSTANCE: 'tbl_approval_instances',
  DEPARTMENT: 'tbl_department',
};

/** One expansion is a reading aid, not a data export. */
const CHANGE_LIMIT = 200;
const SOURCES = new Set(['HTTP', 'CRON', 'WEBHOOK', 'BACKFILL']);

/**
 * Whether tbl_activity_events can hold a company-wide event yet.
 *
 * Deploys here land ahead of their migrations, so for a window the code runs
 * against a table with no buyer_company_id and a NOT NULL hospitality company.
 * Every read and write asks this first and, while the answer is no, behaves
 * exactly as it did before the migration existed: company-wide events are
 * dropped (as they always were) and the feed is scoped by hospitality company
 * alone. A yes is cached for the life of the process; a no is re-checked after
 * a minute, so applying the migration takes effect without a restart.
 */
const NEGATIVE_SCHEMA_TTL_MS = 60 * 1000;
let buyerColumnCache = { value: null, checkedAt: 0 };

export async function hasBuyerCompanyColumn() {
  const { value, checkedAt } = buyerColumnCache;
  if (value === true) return true;
  if (value === false && Date.now() - checkedAt < NEGATIVE_SCHEMA_TTL_MS) return false;
  try {
    const row = await db.oneOrNone(
      `SELECT 1 AS present
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tbl_activity_events'
          AND column_name = 'buyer_company_id'`
    );
    buyerColumnCache = { value: Boolean(row), checkedAt: Date.now() };
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not inspect tbl_activity_events; assuming pre-migration schema');
    buyerColumnCache = { value: false, checkedAt: Date.now() };
  }
  return buyerColumnCache.value;
}

/** For tests that rename the column to rehearse the pre-migration window. */
export const resetActivitySchemaCache = () => {
  buyerColumnCache = { value: null, checkedAt: 0 };
};

/**
 * Runs a read or write once more, in the old shape, if the column vanished.
 *
 * A yes is cached for the life of the process, so a schema rollback while
 * this code keeps running (the down migration applied without reverting the
 * deploy) would otherwise leave every list, facet and detail call failing with
 * "column does not exist", and every captured event lost, until a restart.
 * Postgres says exactly that with 42703; on it, and only after a positive
 * detection, the cache is forgotten and the call is made again — this time the
 * check re-reads the catalogue, answers no, and the old queries run.
 */
const UNDEFINED_COLUMN = '42703';

async function withSchemaRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code !== UNDEFINED_COLUMN || buyerColumnCache.value !== true) throw err;
    logger.warn(
      { err: err.message },
      'tbl_activity_events.buyer_company_id disappeared; reverting to pre-migration queries'
    );
    resetActivitySchemaCache();
    return fn();
  }
}

const INSERT_COLUMNS = `
         occurred_at, request_id, source, event_key, category, severity,
         actor_type, actor_user_id, actor_label,
         hospitality_company_id, hotel_id, department_id,
         entity_type, entity_id, entity_label,
         summary, metadata, http_method, route_pattern, status_code,
         is_reconstructed`;

const INSERT_VALUES = `
         COALESCE($1, now()), $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17::jsonb, $18, $19, $20,
         $21`;

export async function recordActivityEvent(event, txContext = null) {
  try {
    return await withSchemaRetry(() => insertActivityEvent(event, txContext));
  } catch (err) {
    logger.error(
      { err: err.message, eventKey: event?.eventKey },
      'Failed to record activity event'
    );
    return null;
  }
}

async function insertActivityEvent(event, txContext) {
  const t = txContext || db;
  const withBuyer = await hasBuyerCompanyColumn();
  const companyWide = !event?.hospitalityCompanyId && Boolean(event?.buyerCompanyId);

  if (!event?.hospitalityCompanyId && !(withBuyer && companyWide)) {
    // Company is the scoping key; a row without one could never be shown to
    // anybody, so writing it would only grow the table. Before the
    // company-wide migration lands, a buyer-only event lands here too.
    logger.warn({ eventKey: event?.eventKey }, 'Activity event dropped: no company scope');
    return null;
  }

  const severity = SEVERITIES.has(event.severity) ? event.severity : 'routine';
  const source = SOURCES.has(event.source) ? event.source : 'HTTP';

  const params = [
    event.occurredAt || null,
    event.requestId || null,
    source,
    event.eventKey || null,
    event.category || 'Other',
    severity,
    event.actorType || 'UNKNOWN',
    event.actorUserId ?? null,
    event.actorLabel || 'Someone',
    event.hospitalityCompanyId ?? null,
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
  ];

  // The buyer company is derived from the hospitality company whenever there
  // is one — that row is the authority — and only taken from the caller for
  // a company-wide event, where the caller resolved it from the entity or
  // the actor's own account, never from the request.
  const row = withBuyer
    ? await t.one(
        `INSERT INTO tbl_activity_events (${INSERT_COLUMNS}, buyer_company_id)
         VALUES (${INSERT_VALUES},
           COALESCE(
             (SELECT buyer_company_id FROM tbl_hospitality_companies WHERE id = $10::integer),
             $22::integer))
         RETURNING id`,
        [...params, event.buyerCompanyId ?? null]
      )
    : await t.one(
        `INSERT INTO tbl_activity_events (${INSERT_COLUMNS})
         VALUES (${INSERT_VALUES})
         RETURNING id`,
        params
      );
  return row.id;
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
/**
 * A buyer company id, but only if it is one some administrator can read.
 *
 * Company-wide events are shown to the admins of a buyer company, which is to
 * say a tbl_company that has hospitality companies under it. A vendor's
 * company, or a staff account's, has none — an event filed there would be a
 * row nobody could ever be shown, so it resolves to nothing instead.
 */
const READABLE_BUYER = (col) => `
  CASE WHEN EXISTS (SELECT 1 FROM tbl_hospitality_companies hcb
                     WHERE hcb.buyer_company_id = ${col} AND hcb.is_deleted = 0)
       THEN ${col} END`;

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
  // The label has to name the thing being approved, not its type. Reading
  // `entity_type` gave every approval line in the feed the shape "Priya
  // approved RFQ" — grammatically broken and, worse, useless: *which* RFQ is
  // the only fact the reader wanted. Resolved through to the underlying row.
  APPROVAL_INSTANCE: `
    SELECT ai.hospitality_company_id, ai.hotel_id,
           COALESCE(
             CASE ai.entity_type
               WHEN 'RFQ'    THEN (SELECT 'RFQ ' || r.rfq_no FROM tbl_rfq r WHERE r.id = ai.entity_id)
               WHEN 'TENDER' THEN (SELECT 'tender ' || r.rfq_no FROM tbl_rfq r WHERE r.id = ai.entity_id)
               WHEN 'PO'     THEN (SELECT 'PO ' || po.po_number FROM tbl_rfq_purchase_order po WHERE po.id = ai.entity_id)
               WHEN 'ARC'    THEN (SELECT 'rate contract ' || COALESCE(a.arc_number::text, a.title)
                                     FROM tbl_arc a WHERE a.id = ai.entity_id)
             END,
             -- Anything else (TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE) has no
             -- number a person would recognise, so it stays a readable noun
             -- rather than a bare enum shouted in capitals.
             lower(replace(ai.entity_type, '_', ' '))
           ) AS label
      FROM tbl_approval_instances ai
     WHERE ai.id = $1`,
  APPROVAL_POLICY:
    'SELECT hospitality_company_id, hotel_id, entity_type AS label FROM tbl_approval_policies WHERE id = $1',
  // A person, as the subject of an event rather than its actor — which is what
  // an internal-console route acts on, and what user administration acts on.
  // The person's first mapping places the event in a unit; a person with no
  // mapping yet (a brand-new account, or a company administrator) still
  // belongs to their buyer company, so the event lands company-wide there
  // instead of being dropped. The label is resolved either way.
  USER: `SELECT m.hospitality_company_id, m.hospitality_hotel_id AS hotel_id,
                ${READABLE_BUYER('u.company_id')} AS buyer_company_id,
                COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS label
           FROM tbl_users u
           LEFT JOIN LATERAL (
             SELECT hospitality_company_id, hospitality_hotel_id
               FROM tbl_hospitality_user_mappings
              WHERE user_id = u.id
              ORDER BY mapping_type ASC, id ASC
              LIMIT 1
           ) m ON true
          WHERE u.id = $1`,
  // Custom roles belong to the buyer company of the administrator who made
  // them — tbl_roles carries nothing else. System roles (created_by NULL)
  // cannot be created or edited through the API, so they never get here.
  ROLE: `SELECT NULL::integer AS hospitality_company_id, NULL::integer AS hotel_id,
                ${READABLE_BUYER('u.company_id')} AS buyer_company_id,
                r.title AS label
           FROM tbl_roles r
           LEFT JOIN tbl_users u ON u.id = r.created_by
          WHERE r.id = $1`,
  // Approval workflows are a buyer-company concept: company_id is the
  // tbl_company id, not a hospitality company. Deletion is soft, so a deleted
  // workflow is still named.
  APPROVAL_PROCESS: `SELECT NULL::integer AS hospitality_company_id, NULL::integer AS hotel_id,
                            ${READABLE_BUYER('p.company_id')} AS buyer_company_id,
                            p.name AS label
                       FROM tbl_approval_processes p
                      WHERE p.id = $1`,
  // A project names itself but places nothing: projects are mapped to many
  // units, so the unit always comes from the route (see project_mapping_removed).
  PROJECT: `SELECT NULL::integer AS hospitality_company_id, NULL::integer AS hotel_id,
                   NULL::integer AS buyer_company_id, name AS label
              FROM tbl_projects WHERE id = $1`,
  // Cover belongs where the person being covered for belongs. The label names
  // both people, because "arranged cover" without who-for-whom answers nothing.
  APPROVAL_DELEGATION: `SELECT m.hospitality_company_id, m.hospitality_hotel_id AS hotel_id,
                               ${READABLE_BUYER('du.company_id')} AS buyer_company_id,
                               COALESCE(NULLIF(TRIM(dg.name), ''), dg.email, 'someone')
                                 || ' to cover for '
                                 || COALESCE(NULLIF(TRIM(du.name), ''), du.email, 'someone') AS label
                          FROM tbl_approval_delegations d
                          JOIN tbl_users du ON du.id = d.delegator_user_id
                          LEFT JOIN tbl_users dg ON dg.id = d.delegate_user_id
                          LEFT JOIN LATERAL (
                            SELECT hospitality_company_id, hospitality_hotel_id
                              FROM tbl_hospitality_user_mappings
                             WHERE user_id = du.id
                             ORDER BY mapping_type ASC, id ASC
                             LIMIT 1
                          ) m ON true
                         WHERE d.id = $1`,
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

/**
 * The acting user's own buyer company, as a company-wide scope.
 *
 * The last resort, and the one that matters for company administration: an
 * administrator usually has no hospitality mapping of their own, so without
 * this every event the registry scopes by the actor — role changes, approval
 * workflows, the company profile — resolved to no company and was dropped.
 * Read from the user's own row (the session's identity), never from a header
 * or a body, and only accepted when some administrator can read the company.
 */
export async function resolveBuyerScope(userId) {
  if (!userId) return null;
  try {
    return await db.oneOrNone(
      `SELECT c.id AS buyer_company_id, c.company_name AS label
         FROM tbl_users u
         JOIN tbl_company c ON c.id = u.company_id
        WHERE u.id = $1
          AND EXISTS (SELECT 1 FROM tbl_hospitality_companies h
                       WHERE h.buyer_company_id = c.id AND h.is_deleted = 0)`,
      [userId]
    );
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Could not resolve buyer company for activity');
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
 * The WHERE fragment that decides whose events a reader may see.
 *
 * The hospitality companies under the caller's buyer company, plus — once the
 * schema can hold them — the company-wide events of that same buyer company.
 * Both values come from the session; neither can be supplied by a filter.
 * Returns the clause and the params it binds, starting at $1.
 */
async function scopeWhere(companyIds, buyerCompanyId, alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  if (buyerCompanyId && (await hasBuyerCompanyColumn())) {
    return {
      clause: `(${col('hospitality_company_id')} = ANY($1)
                OR (${col('hospitality_company_id')} IS NULL AND ${col('buyer_company_id')} = $2))`,
      params: [companyIds, buyerCompanyId],
    };
  }
  return { clause: `${col('hospitality_company_id')} = ANY($1)`, params: [companyIds] };
}

/**
 * One page of the feed.
 *
 * Every filter narrows; none can widen. `companyIds` is resolved from the
 * session before this is called and is the only thing standing between one
 * client's admin and another client's activity.
 */
async function listActivityOnce({
  companyIds,
  buyerCompanyId = null,
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

  const scope = await scopeWhere(companyIds, buyerCompanyId);
  const where = [scope.clause];
  const params = [...scope.params];
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
async function activityFacetsOnce(companyIds, buyerCompanyId = null) {
  if (!companyIds?.length) {
    return { categories: [], actors: [], entityTypes: [], units: [], severities: [] };
  }

  // Company-wide events count towards every facet but the business-unit one,
  // which by definition only lists events that happened at a unit.
  const scope = await scopeWhere(companyIds, buyerCompanyId);
  const scoped = await scopeWhere(companyIds, buyerCompanyId, 'e');

  const [categories, actors, entityTypes, severities, units] = await Promise.all([
    db.any(
      `SELECT category, count(*)::int AS count FROM tbl_activity_events
        WHERE ${scope.clause}
        GROUP BY category ORDER BY count DESC`,
      scope.params
    ),
    db.any(
      `SELECT actor_user_id, actor_label, actor_type, count(*)::int AS count
         FROM tbl_activity_events
        WHERE ${scope.clause} AND actor_user_id IS NOT NULL
        GROUP BY actor_user_id, actor_label, actor_type
        ORDER BY count DESC LIMIT 100`,
      scope.params
    ),
    db.any(
      `SELECT entity_type, count(*)::int AS count FROM tbl_activity_events
        WHERE ${scope.clause} AND entity_type IS NOT NULL
        GROUP BY entity_type ORDER BY count DESC`,
      scope.params
    ),
    // Counted here rather than derived from the page, because the whole point
    // of showing them is answering "is anything wrong?" for the WHOLE company
    // — a number computed from the fifty rows currently on screen would be a
    // count of the page, which is not a question anybody asks.
    //
    // Windowed to the last 30 days: "3 critical" means nothing without a
    // period, and an all-time count only ever grows, so it stops being a
    // signal within a month of go-live.
    db.any(
      `SELECT severity, count(*)::int AS count
         FROM tbl_activity_events
        WHERE ${scope.clause}
          AND occurred_at >= now() - interval '30 days'
        GROUP BY severity`,
      scope.params
    ),
    db.any(
      `SELECT e.hotel_id, h.name AS hotel_name, count(*)::int AS count
         FROM tbl_activity_events e
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = e.hotel_id
        WHERE ${scoped.clause} AND e.hotel_id IS NOT NULL
        GROUP BY e.hotel_id, h.name ORDER BY count DESC`,
      scoped.params
    ),
  ]);

  return { categories, actors, entityTypes, units, severities };
}

/**
 * The column-level changes one event produced.
 *
 * This is what turns "Priya renamed Company A" into something an admin can
 * check. The event is re-read under the caller's company scope first, so an
 * id from another company returns nothing rather than leaking its diff.
 */
async function activityChangesOnce(eventId, companyIds, buyerCompanyId = null) {
  if (!companyIds?.length) return null;

  const scope = await scopeWhere(companyIds, buyerCompanyId);
  const event = await db.oneOrNone(
    `SELECT ${LIST_COLUMNS} FROM tbl_activity_events
      WHERE ${scope.clause} AND id = $${scope.params.length + 1}`,
    [...scope.params, eventId]
  );
  if (!event) return null;

  // Every row change the request produced, but ordered so the one the
  // sentence is about comes first, and capped.
  //
  // Joining on request_id alone is right — that is what ties a business event
  // to the rows it moved — but a purchase-order approval writes to
  // tbl_approval_instances, tbl_approval_instance_steps,
  // tbl_approval_step_approvers and tbl_rfq in one request. Expanding "Priya
  // approved purchase order 138800" gave four blocks with nothing marking
  // which was the purchase order. Sorting the event's own entity to the top
  // answers that without hiding the rest, which a reader auditing a change
  // still needs.
  //
  // The cap is for bulk operations: a vendor-mapping refresh writes hundreds
  // of rows under one request id, and the expansion would have rendered all of
  // them. `truncated` tells the UI to say so rather than quietly stopping.
  const changes = event.request_id
    ? await db.any(
        `SELECT table_name, operation, record_id, old_data, new_data, changed_at
           FROM tbl_audit_row_changes
          WHERE request_id = $1
          ORDER BY ($2::text IS NOT NULL AND table_name = $2::text) DESC, id
          LIMIT $3`,
        [event.request_id, ENTITY_TABLES[event.entity_type] || null, CHANGE_LIMIT + 1]
      )
    : [];

  const truncated = changes.length > CHANGE_LIMIT;

  return { event, changes: changes.slice(0, CHANGE_LIMIT), truncated };
}

// Each read is retried once in the pre-migration shape if the company-wide
// column disappears under a running process (see withSchemaRetry).
export const listActivity = (args) => withSchemaRetry(() => listActivityOnce(args));
export const activityFacets = (companyIds, buyerCompanyId = null) =>
  withSchemaRetry(() => activityFacetsOnce(companyIds, buyerCompanyId));
export const activityChanges = (eventId, companyIds, buyerCompanyId = null) =>
  withSchemaRetry(() => activityChangesOnce(eventId, companyIds, buyerCompanyId));
