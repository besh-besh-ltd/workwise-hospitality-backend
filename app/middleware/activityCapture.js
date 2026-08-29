import { logger } from '../util/logger.js';
import { getRequestContext } from '../util/requestContext.js';
import { resolveActor, ACTOR_TYPES } from './requestContext.js';
import { lookupEvent, CATEGORIES } from '../services/activity/eventRegistry.js';
import {
  recordActivityEvent,
  resolveEntityScope,
  resolveUserScope,
} from '../models/activityModel.js';
import { emitToCompany } from '../util/socket.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mutating routes seen with no registry entry, and how often.
 *
 * This is the anti-rot mechanism. Capture is registry-driven so the feed can
 * read in English, but a registry is a list somebody has to remember to
 * update. Route 344 will be added by someone who has never read this file, and
 * without this counter its events would be recorded namelessly and nobody
 * would ever find out. With it, the gap has a name and a number.
 */
const uncatalogued = new Map();

export const getUncataloguedRoutes = () =>
  [...uncatalogued.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count);

export const resetUncataloguedRoutes = () => uncatalogued.clear();

/** `data.id` / `params.rfq_id` etc., without pulling in a dependency. */
const dig = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const extractEntityId = (spec, { req, responseBody }) => {
  if (!spec) return null;
  const source =
    spec.from === 'params' ? req.params
      : spec.from === 'body' ? req.body
      : spec.from === 'response' ? responseBody
      : null;
  const raw = source ? dig(source, spec.path) : null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Which company and unit the event belongs to.
 *
 * Derived from the entity's own row, the URL, or the acting user — never from
 * the x-company-id / x-hotel-id headers. Those exist, but the codebase's own
 * security work concluded they are not trustworthy for scoping, and a trail
 * you can point at another company by editing a header is not an audit trail.
 */
const resolveScope = async (definition, { req, entityId, actorUserId }) => {
  const strategies = []
    .concat(definition?.scope || [])
    .concat(definition?.bodyScope ? [{ via: 'body', ...definition.bodyScope }] : [])
    // Always last: an event about an account rather than about work still has
    // to land somewhere, and the acting user's company is the honest answer.
    .concat([{ via: 'actor' }]);

  for (const scope of strategies) {
    if (scope.via === 'entity' && entityId) {
      const row = await resolveEntityScope(scope.type, entityId);
      if (row?.hospitality_company_id) {
        return {
          hospitalityCompanyId: row.hospitality_company_id,
          hotelId: row.hotel_id ?? null,
          // Only the entity lookup knows what the thing is called, which is
          // what makes a feed line read as "Company A" rather than "#10001".
          entityLabel: row.label ?? null,
        };
      }
    }

    if (scope.via === 'params' || scope.via === 'body') {
      const source = scope.via === 'params' ? req.params : req.body;
      const companyId = Number(source?.[scope.companyKey] ?? NaN);
      const hotelId = Number(source?.[scope.hotelKey] ?? NaN);
      if (Number.isFinite(companyId)) {
        return {
          hospitalityCompanyId: companyId,
          hotelId: Number.isFinite(hotelId) ? hotelId : null,
          entityLabel: null,
        };
      }
    }

    if (scope.via === 'actor') {
      const row = await resolveUserScope(actorUserId);
      if (row?.hospitality_company_id) {
        return {
          hospitalityCompanyId: row.hospitality_company_id,
          hotelId: row.hotel_id ?? null,
          entityLabel: null,
        };
      }
    }
  }
  return null;
};

/** `/api/v1/rfq` + `/finalize` -> `/rfq/finalize`, matching the registry. */
const routePattern = (req) => {
  if (!req.route?.path) return null;
  const base = (req.baseUrl || '').replace(/^\/api\/v1/, '');
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${base}${path}` || '/';
};

/**
 * Notes a mutating route the registry does not name.
 *
 * Counted for every attempt, successful or not: whether the catalogue covers a
 * route has nothing to do with whether a particular call happened to succeed.
 * Counting only successes would hide any route that usually fails validation,
 * which is exactly the sort of route a newcomer adds and forgets to name.
 */
const noteUncatalogued = (req, suffix = '') => {
  const pattern = routePattern(req);
  if (!pattern) return;
  const key = `${req.method} ${pattern}${suffix}`;
  uncatalogued.set(key, (uncatalogued.get(key) || 0) + 1);
};

const captureEvent = async (req, res, responseBody) => {
  const pattern = routePattern(req);
  if (!pattern) return;

  const definition = lookupEvent(req.method, pattern);
  const actor = resolveActor(req);
  const ctx = getRequestContext();
  const entityId = extractEntityId(definition?.entity?.id, { req, responseBody });

  const scope = await resolveScope(definition, {
    req,
    entityId,
    actorUserId: actor.actorUserId,
  });

  // Without a company the row could never be shown to anybody, so writing it
  // would only grow the table. Counted as a gap instead.
  if (!scope?.hospitalityCompanyId) {
    noteUncatalogued(req, ' (unscoped)');
    return;
  }

  const summaryContext = {
    actor: actor.actorLabel,
    actorType: actor.actorType,
    entityId,
    entityLabel: scope.entityLabel,
    body: req.body || {},
    params: req.params || {},
    response: responseBody,
  };

  let summary;
  try {
    summary = definition?.summary
      ? definition.summary(summaryContext)
      : `${actor.actorLabel} performed ${req.method} ${pattern}`;
  } catch (err) {
    // A template that throws must not cost the event. An unnamed line in the
    // feed still tells an admin that something happened.
    logger.warn({ err: err.message, key: definition?.key }, 'Activity summary template failed');
    summary = `${actor.actorLabel} performed ${req.method} ${pattern}`;
  }

  const eventId = await recordActivityEvent({
    requestId: ctx?.requestId || null,
    source: definition?.source || (actor.actorType === ACTOR_TYPES.SYSTEM ? 'CRON' : 'HTTP'),
    eventKey: definition?.key || null,
    category: definition?.category || CATEGORIES.SYSTEM,
    severity: definition?.severity || 'routine',
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    actorLabel: actor.actorLabel,
    hospitalityCompanyId: scope.hospitalityCompanyId,
    hotelId: scope.hotelId,
    entityType: definition?.entity?.type || null,
    entityId,
    entityLabel: scope.entityLabel,
    summary,
    metadata: {
      duration_ms: ctx?.startedAt ? Date.now() - ctx.startedAt : null,
      ...(definition ? {} : { uncatalogued: true }),
    },
    httpMethod: req.method,
    routePattern: pattern,
    statusCode: res.statusCode,
  });

  // A signal, not a payload: watchers refetch rather than trusting the frame,
  // so a duplicated or out-of-order delivery cannot corrupt the feed. Same
  // contract as notification:new, which is what the client already knows.
  if (eventId) {
    emitToCompany(scope.hospitalityCompanyId, 'activity:new', {
      id: eventId,
      severity: definition?.severity || 'routine',
    });
  }
};

/**
 * Records what happened, after the response has gone out.
 *
 * Runs on `finish`, so nothing here is on the request's critical path: the
 * client already has its answer before any of this starts. Failures are
 * swallowed for the same reason — a missing line in a report must never be
 * able to fail an RFQ.
 *
 * Only successful requests are recorded. A rejected attempt is not something
 * that happened to the company; it is something that did not.
 */
const activityCapture = (req, res, next) => {
  if (!MUTATING.has(req.method)) return next();

  // The ~40 creations whose row does not exist until the insert returns can
  // only be identified from the response. The uniform { status, data: { id } }
  // envelope makes one generic extractor enough. Wrapping res.json is the
  // pattern bodyCapture already established here.
  let responseBody = null;
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    // Registry coverage is tracked for every attempt; the event is recorded
    // only for the ones that actually happened.
    if (!lookupEvent(req.method, routePattern(req) || '')) noteUncatalogued(req);
    if (res.statusCode >= 400) return;
    captureEvent(req, res, responseBody).catch((err) =>
      logger.error({ err: err.message }, 'Activity capture failed')
    );
  });

  next();
};

export default activityCapture;
