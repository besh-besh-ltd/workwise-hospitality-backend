import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from '../util/requestContext.js';

/**
 * Who is acting. Seven kinds, not two — collapsing them to "User" is the
 * fastest way to make an activity feed untrustworthy.
 */
export const ACTOR_TYPES = {
  USER: 'USER',
  VENDOR: 'VENDOR',
  WORKWISE_STAFF: 'WORKWISE_STAFF',
  GUEST_TOKEN: 'GUEST_TOKEN',
  SYSTEM: 'SYSTEM',
  PUBLIC: 'PUBLIC',
};

const VENDOR_USER_TYPE = 3;

const labelFor = (user) =>
  user?.name || user?.email || (user?.id > 0 ? `User #${user.id}` : 'Unknown');

/**
 * Derives the actor from a request, at the moment it is asked.
 *
 * Deliberately tolerant: an unrecognised request is PUBLIC, never an error.
 * A trail that drops events because it could not classify the caller is worse
 * than one that records "someone" and says so.
 */
export const resolveActor = (req = {}) => {
  if (req.isSchedulerRequest || req.isWebhookRequest) {
    return { actorType: ACTOR_TYPES.SYSTEM, actorUserId: null, actorLabel: 'System' };
  }

  const user = req.user;
  if (!user) {
    return { actorType: ACTOR_TYPES.PUBLIC, actorUserId: null, actorLabel: 'Someone' };
  }

  // A site representative recording a GRN from an emailed one-time link. A
  // real person with no account, whose name lives on the token row. Calling
  // this "System" would misattribute a human decision about received goods.
  if (user.is_token_user) {
    return {
      actorType: ACTOR_TYPES.GUEST_TOKEN,
      actorUserId: null,
      actorLabel: labelFor(user),
      actorDetail: user.tokenType || null,
    };
  }

  // Workwise's own staff, working in the internal console against a
  // customer's data. The question a client's IT review asks first is who at
  // the vendor can see their data, and rendering a support engineer as an
  // ordinary "User" answers it wrongly — it makes them look like the client's
  // own employee.
  if (user.is_internal_admin) {
    return {
      actorType: ACTOR_TYPES.WORKWISE_STAFF,
      actorUserId: user.id > 0 ? user.id : null,
      actorLabel: labelFor(user),
    };
  }

  // Vendors reach the app both through a normal login and through an emailed
  // link (vendorTokenOrJwt, which sets req.is_verified = false). Both are the
  // same vendor doing the same thing; the trail should not invent two actors.
  const isVendor = Number(user.user_type) === VENDOR_USER_TYPE;
  return {
    actorType: isVendor ? ACTOR_TYPES.VENDOR : ACTOR_TYPES.USER,
    actorUserId: user.id > 0 ? user.id : null,
    actorLabel: labelFor(user),
  };
};

/**
 * Opens a context for the request and keeps it open for its whole lifetime,
 * including anything asynchronous the handlers start.
 *
 * Mounted globally, before the router. `req` is kept on the context so the
 * actor can be read after per-route authentication has run.
 */
const requestContext = (req, res, next) => {
  runWithRequestContext(
    {
      requestId: randomUUID(),
      startedAt: Date.now(),
      req,
      ip: req.ip || req.headers?.['x-forwarded-for'] || null,
      userAgent: req.headers?.['user-agent'] || null,
    },
    () => next()
  );
};

export default requestContext;
