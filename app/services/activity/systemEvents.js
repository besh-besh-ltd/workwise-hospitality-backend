import { recordActivityEvent, resolveEntityScope } from '../../models/activityModel.js';
import { CATEGORIES } from './eventRegistry.js';
import { ACTOR_TYPES } from '../../middleware/requestContext.js';
import { logger } from '../../util/logger.js';

/**
 * Things the platform does on its own.
 *
 * The HTTP capture middleware covers every mutating request, which is most of
 * what happens — but a dozen consequential things happen with no request at
 * all: a negotiation round closing on its deadline, a rate contract lapsing, a
 * vendor's subscription expiring, a watchdog rescuing a stuck publish. Several
 * are critical and today they happen invisibly, so an admin asking "why did
 * this close?" has nowhere to look.
 *
 * Kept as one helper rather than threaded through each caller because the
 * scope lookup is the fiddly part: a cron job knows an entity id and nothing
 * about which company it belongs to.
 *
 * Never throws. A scheduled job must not fail because its own audit line
 * could not be written — a missing entry is a gap in a report, a thrown error
 * is a rate contract that never expired.
 *
 * The catch at the bottom is not covered by a test, and cannot honestly be:
 * both callees (resolveEntityScope, recordActivityEvent) already swallow their
 * own errors and return null, so nothing reaching this function from outside
 * can drive it. It stays as defence against a future callee that does throw.
 */
export async function recordSystemEvent({
  eventKey,
  category = CATEGORIES.SYSTEM,
  severity = 'notable',
  entityType,
  entityId,
  summary,
  metadata = {},
  hospitalityCompanyId = null,
  hotelId = null,
  txContext = null,
}) {
  try {
    let companyId = hospitalityCompanyId;
    let unitId = hotelId;
    let entityLabel = null;

    if (!companyId && entityType && entityId) {
      const row = await resolveEntityScope(entityType, entityId);
      if (row) {
        companyId = row.hospitality_company_id;
        unitId = unitId ?? row.hotel_id ?? null;
        entityLabel = row.label ?? null;
      }
    }
    if (!companyId) {
      // Same rule the HTTP path applies: a row with no company could never be
      // shown to anybody, so writing it would only grow the table.
      logger.warn({ eventKey, entityType, entityId }, 'System activity event dropped: no company scope');
      return null;
    }

    return await recordActivityEvent(
      {
        source: 'CRON',
        eventKey,
        category,
        severity,
        actorType: ACTOR_TYPES.SYSTEM,
        actorUserId: null,
        actorLabel: 'System',
        hospitalityCompanyId: companyId,
        hotelId: unitId,
        entityType,
        entityId,
        entityLabel,
        // The sentence names the platform, not a person. Rendering a scheduled
        // closure as though somebody did it is the fastest way to make an
        // admin distrust the whole feed.
        summary: typeof summary === 'function' ? summary(entityLabel) : summary,
        metadata,
      },
      txContext
    );
  } catch (err) {
    logger.error({ err: err.message, eventKey }, 'Could not record system activity event');
    return null;
  }
}

export default recordSystemEvent;
