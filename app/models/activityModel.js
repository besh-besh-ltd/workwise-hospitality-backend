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
