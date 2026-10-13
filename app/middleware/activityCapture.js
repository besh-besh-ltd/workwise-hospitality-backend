import { logger } from '../util/logger.js';
import { getRequestContext } from '../util/requestContext.js';
import { resolveActor, ACTOR_TYPES } from './requestContext.js';
import { lookupEvent, isNotAnEvent, CATEGORIES } from '../services/activity/eventRegistry.js';
import {
  recordActivityEvent,
  resolveEntityScope,
  resolveUserScope,
  resolveBuyerScope,
  companiesVisibleTo,
} from '../models/activityModel.js';
import { emitToCompany, emitToCompanies } from '../util/socket.js';

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

const extractEntityId = (spec, { req, responseBody, actorUserId }) => {
  if (!spec) return null;
  const source =
    spec.from === 'params' ? req.params
      : spec.from === 'body' ? req.body
      : spec.from === 'response' ? responseBody
      : null;
  const raw = source ? dig(source, spec.path) : null;
  // `orActor`: the route acts on the caller when the field is absent — a
  // self-edit — so the subject is the caller, not "nobody".
  if (raw == null || raw === '') return spec.orActor && actorUserId ? Number(actorUserId) : null;
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
const resolveScope = async (definition, { req, res, entityId, actorUserId, isStaff = false }) => {
  const detailScope = res?.locals?.activityDetail?.scope || null;
  const declared = [].concat(definition?.scope || []);
  // An entry that names the controller's detail explicitly gets it first; a
  // generic entry gets it after its own strategies. Either way it is the
  // controller's validated view of what was touched, never a header.
  const strategies = []
    .concat(declared)
    .concat(definition?.bodyScope ? [{ via: 'body', ...definition.bodyScope }] : [])
    .concat(declared.some((s) => s.via === 'detail') ? [] : [{ via: 'detail' }])
    // An event about an account rather than about work still has to land
    // somewhere: first the acting user's own unit, then — for a company
    // administrator, who usually has no unit — their buyer company, as a
    // company-wide event. Before that last step existed, every such event was
    // dropped.
    //
    // Never for Workwise's own staff. Their accounts belong to a buyer company
    // of their own (production's 150 and 402 do), so an unnamed console read
    // that names no customer — a list of every buyer — would be filed in that
    // one client's trail as "Workwise looked at your data". A staff event is
    // placed only by what it touched; one that touched no single customer
    // belongs in nobody's feed, as the registry has always said.
    .concat([{ via: 'actor' }, { via: 'actorBuyer' }]);

  // A label found by a strategy that could not place the event (a user with
  // no mapping yet, say) is still the right name for the sentence.
  let label = null;
  let entityBuyer = null;

  for (const scope of strategies) {
    if (scope.via === 'entity' && entityId) {
      const row = await resolveEntityScope(scope.type, entityId);
      if (row?.label && !label) label = row.label;
      if (row?.hospitality_company_id) {
        return {
          hospitalityCompanyId: row.hospitality_company_id,
          hotelId: row.hotel_id ?? null,
          buyerCompanyId: row.buyer_company_id ?? null,
          // Only the entity lookup knows what the thing is called, which is
          // what makes a feed line read as "Company A" rather than "#10001".
          entityLabel: row.label ?? null,
        };
      }
      // The entity belongs to a buyer company as a whole (a role, a
      // workflow), or to a person not yet placed in a unit. Remembered rather
      // than returned: a later, more specific strategy (the controller's
      // detail) may still place it in a unit.
      if (row?.buyer_company_id && !entityBuyer) entityBuyer = row.buyer_company_id;
    }

    if (scope.via === 'params' || scope.via === 'body') {
      const source = scope.via === 'params' ? req.params : req.body;
      const companyId = Number(source?.[scope.companyKey] ?? NaN);
      const hotelId = Number(source?.[scope.hotelKey] ?? NaN);
      if (Number.isFinite(companyId)) {
        return {
          hospitalityCompanyId: companyId,
          hotelId: Number.isFinite(hotelId) ? hotelId : null,
          buyerCompanyId: null,
          entityLabel: label,
        };
      }
    }

    if (scope.via === 'detail' && detailScope?.hospitalityCompanyId) {
      return {
        hospitalityCompanyId: Number(detailScope.hospitalityCompanyId),
        hotelId: detailScope.hotelId != null ? Number(detailScope.hotelId) : null,
        buyerCompanyId: null,
        entityLabel: detailScope.entityLabel ?? label,
      };
    }

    if (scope.via === 'actor') {
      if (entityBuyer) {
        // The entity already said which company it belongs to. Filing it
        // under wherever the actor happens to be mapped would be wrong.
        return { hospitalityCompanyId: null, hotelId: null, buyerCompanyId: entityBuyer, entityLabel: label };
      }
      if (isStaff) continue;
      const row = await resolveUserScope(actorUserId);
      if (row?.hospitality_company_id) {
        return {
          hospitalityCompanyId: row.hospitality_company_id,
          hotelId: row.hotel_id ?? null,
          buyerCompanyId: null,
          entityLabel: label,
        };
      }
    }

    if (scope.via === 'actorBuyer') {
      if (isStaff) continue;
      const row = await resolveBuyerScope(actorUserId);
      if (row?.buyer_company_id) {
        return {
          hospitalityCompanyId: null,
          hotelId: null,
          buyerCompanyId: row.buyer_company_id,
          // For an event about the company itself (its profile), the
          // company's name is the right label; otherwise keep what the entity
          // lookup found.
          entityLabel: label ?? (definition?.labelFromBuyer ? row.label : null),
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
 * Each gap is logged once per process, not once per request. The counter
 * still counts every occurrence; the log line is what makes a gap visible in
 * the log pipeline (and so in alerting) rather than only to someone who
 * thinks to call the coverage endpoint before the process restarts.
 */
const warnedGaps = new Set();

const warnGapOnce = (key, method, route, reason) => {
  if (warnedGaps.has(key)) return;
  warnedGaps.add(key);
  logger.warn({ route, method, reason }, 'Activity trail gap: event not recorded');
};

/** For tests: forget which gaps have already been logged. */
export const resetGapWarnings = () => warnedGaps.clear();

/**
 * Notes a mutating route the registry does not name.
 *
 * Counted for every attempt, successful or not: whether the catalogue covers a
 * route has nothing to do with whether a particular call happened to succeed.
 * Counting only successes would hide any route that usually fails validation,
 * which is exactly the sort of route a newcomer adds and forgets to name.
 *
 * Routes on the NOT_AN_EVENT list (notification read-receipts, uploads, auth
 * flows) are known not to be events and are neither counted nor logged — a
 * gap report full of them would hide the real ones.
 */
const noteUncatalogued = (req, suffix = '') => {
  const pattern = routePattern(req);
  if (!pattern) return;
  if (!suffix && isNotAnEvent(req.method, pattern)) return;
  const key = `${req.method} ${pattern}${suffix}`;
  uncatalogued.set(key, (uncatalogued.get(key) || 0) + 1);
  warnGapOnce(key, req.method, pattern, suffix ? 'unscoped' : 'uncatalogued');
};

const captureEvent = async (req, res, responseBody) => {
  const pattern = routePattern(req);
  if (!pattern) return;

  const definition = lookupEvent(req.method, pattern);
  const actor = resolveActor(req);

  // An unnamed route does not get a row in the feed.
  //
  // The original design wrote one anyway, on the principle that capture should
  // be complete and a gap in the registry should not become a gap in the
  // trail. Running it showed why that is wrong: the verb does not tell you
  // whether something happened. 57 of this codebase's POST routes are
  // *queries* — `/rfq/list-view`, `/users/get-dashboard-data`,
  // `/rbac/me/permissions/bulk` — and several fire on every page load for
  // every user. The feed filled with "performed POST /rbac/me/permissions/bulk"
  // and would have buried ~1,200 real events a day under an order of magnitude
  // more noise, in the one screen whose entire value is being readable.
  //
  // Completeness is not lost, because it never rested here: the row-level
  // audit trigger records every actual data change with before/after and an
  // actor, whether or not the route is catalogued. This layer's job is the
  // legible sentence, and a line reading "performed POST /x" is not one. The
  // uncatalogued counter still reports the gap, which is how a genuinely
  // missing event gets found and named.
  //
  // Workwise's own staff are the exception: for them the record that a request
  // happened at all is the point, so an unnamed internal route is still
  // considered — but only placed where it touched a customer (see
  // resolveScope); one that names no customer lands nowhere.
  if (!definition && actor.actorType !== ACTOR_TYPES.WORKWISE_STAFF) return;
  const ctx = getRequestContext();
  const entityId = extractEntityId(definition?.entity?.id, {
    req,
    responseBody,
    actorUserId: actor.actorUserId,
  });

  // Some routes answer 200 without doing anything — a pre-flight warning, a
  // confirmation prompt. Those entries are recorded only when the controller
  // says the thing actually happened, by handing over its detail.
  if (definition?.requireDetail && !res.locals?.activityDetail) return;

  const scope = await resolveScope(definition, {
    req,
    res,
    entityId,
    actorUserId: actor.actorUserId,
    isStaff: actor.actorType === ACTOR_TYPES.WORKWISE_STAFF,
  });

  // Without a company the row could never be shown to anybody, so writing it
  // would only grow the table. Counted as a gap instead — but only for the
  // mutating routes the catalogue is about. Several internal-console reads are
  // cross-company by nature (a list of every buyer), and those genuinely do
  // not belong to one client's trail; counting them would report a permanent
  // gap that no registry entry could ever close.
  if (!scope?.hospitalityCompanyId && !scope?.buyerCompanyId) {
    if (MUTATING.has(req.method)) noteUncatalogued(req, ' (unscoped)');
    return;
  }

  const summaryContext = {
    actor: actor.actorLabel,
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    entityId,
    entityLabel: scope.entityLabel,
    body: req.body || {},
    params: req.params || {},
    query: req.query || {},
    response: responseBody,
    // What the handler knows that the route cannot say. A route names the
    // endpoint; only the controller knows that a save moved somebody's approval
    // role. Handlers put it on `res.locals.activityDetail` and the registry's
    // summary reads it here — the sentence still lives in one place.
    detail: res.locals?.activityDetail || null,
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

  // An unnamed route reached by Workwise's own staff is still a customer's
  // data being looked at, so it is filed where they will look for it rather
  // than under System, and it is never routine.
  const isStaff = actor.actorType === ACTOR_TYPES.WORKWISE_STAFF;
  const fallbackCategory = isStaff ? CATEGORIES.WORKWISE_ACCESS : CATEGORIES.SYSTEM;
  const fallbackSeverity = isStaff ? 'notable' : 'routine';

  const eventId = await recordActivityEvent({
    requestId: ctx?.requestId || null,
    source: definition?.source || (actor.actorType === ACTOR_TYPES.SYSTEM ? 'CRON' : 'HTTP'),
    eventKey: definition?.key || null,
    category: definition?.category || fallbackCategory,
    severity: definition?.severity || fallbackSeverity,
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    actorLabel: actor.actorLabel,
    hospitalityCompanyId: scope.hospitalityCompanyId,
    hotelId: scope.hotelId,
    buyerCompanyId: scope.buyerCompanyId,
    entityType: definition?.entity?.type || null,
    entityId,
    entityLabel: scope.entityLabel,
    summary,
    metadata: {
      duration_ms: ctx?.startedAt ? Date.now() - ctx.startedAt : null,
      ...(definition ? {} : { uncatalogued: true }),
      ...(res.locals?.activityDetail?.metadata || {}),
    },
    httpMethod: req.method,
    routePattern: pattern,
    statusCode: res.statusCode,
  });

  // A signal, not a payload: watchers refetch rather than trusting the frame,
  // so a duplicated or out-of-order delivery cannot corrupt the feed. Same
  // contract as notification:new, which is what the client already knows.
  if (eventId) {
    const payload = { id: eventId, severity: definition?.severity || 'routine' };
    if (scope.hospitalityCompanyId) {
      emitToCompany(scope.hospitalityCompanyId, 'activity:new', payload);
    } else {
      // A company-wide event is shown to every administrator of the buyer
      // company, and the socket rooms are per hospitality company — so every
      // room under that buyer company is told, in ONE emit: an admin's socket
      // is in all of them, and room-by-room emits reached it once per room.
      emitToCompanies(await companiesVisibleTo(scope.buyerCompanyId), 'activity:new', payload);
    }
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
  const mutating = MUTATING.has(req.method);

  // The ~40 creations whose row does not exist until the insert returns can
  // only be identified from the response. The uniform { status, data: { id } }
  // envelope makes one generic extractor enough. Wrapping res.json is the
  // pattern bodyCapture already established here. Only mutations need it: a
  // read is recorded for having happened, not for what it returned.
  let responseBody = null;
  if (mutating) {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      responseBody = body;
      return originalJson(body);
    };
  }

  res.on('finish', () => {
    // Whether this is Workwise's own staff cannot be known here at mount time
    // — this middleware runs before per-route authentication — but it is known
    // by the time the response finishes, which is where the decision is made.
    const isStaff = resolveActor(req).actorType === ACTOR_TYPES.WORKWISE_STAFF;

    // For a client's own people, what happened is what changed. For Workwise
    // staff working in a customer's account, reading the data *is* the event:
    // "who at the vendor can see our data" is the first question a client's
    // security review asks, and a trail of only their writes cannot answer it.
    //
    // The third case is a GET with a real side effect. `GET /rfq/send-reminder/
    // :id` emails every vendor on an RFQ; gating on the verb would have missed
    // it silently, which is the whole reason capture is registry-driven. A
    // named GET is named precisely because somebody decided it matters.
    if (!mutating && !isStaff && !lookupEvent(req.method, routePattern(req) || '')) return;

    // Registry coverage is tracked for every attempt; the event is recorded
    // only for the ones that actually happened.
    if (mutating && !lookupEvent(req.method, routePattern(req) || '')) noteUncatalogued(req);
    if (res.statusCode >= 400) return;
    captureEvent(req, res, responseBody).catch((err) =>
      logger.error({ err: err.message }, 'Activity capture failed')
    );
  });

  next();
};

export default activityCapture;
