// Controller-level gates for Vendor Networks (spec §5, §10.5).
//
// Routes are role-gated with acl([3]); these decide on req.user.network, which
// jwtUsr resolved from the database on this very request. Each returns null when
// the caller may proceed, otherwise an { http, body } for the controller to send:
//
//   const denied = requireOrgAdmin(req);
//   if (denied) return res.status(denied.http).json(denied.body);

import { NETWORK_ROLE } from "../../constants/vendorNetwork.js";
import { isGuestSession, guestSessionRefusal } from "../../helper/guestSession.js";

const deny = (message) => ({ http: 403, body: { status: 0, message } });

/**
 * An emailed-link guest session (helper/guestSession.js) never gets network or account
 * power: 403 { reason: 'GUEST_SESSION' }. It keeps RFQ view / quote / regret only.
 */
export function refuseGuest(req) {
  return isGuestSession(req) ? { http: 403, body: guestSessionRefusal() } : null;
}

/** The caller acts inside a vendor network. */
export function requireNetwork(req) {
  return req.user?.network ? null : deny("Vendor network access required");
}

/** The caller is an ORG_ADMIN of the network it is acting in. */
export function requireOrgAdmin(req) {
  const guest = refuseGuest(req);
  if (guest) return guest;
  return req.user?.network?.role === NETWORK_ROLE.ORG_ADMIN ? null : deny("Network admin access required");
}

/**
 * The PERSON behind the request: for someone acting for a network entity that is
 * `network.actor_user_id`; otherwise (no-org vendor, buyer, self-acting) req.user.id.
 * "My account" writes (password, push subscriptions) key on this, never the entity.
 */
export function actingPersonId(req) {
  return req.user?.network?.actor_user_id ?? req.user?.id;
}

/** True when a person is acting for an entity other than their own login. */
export function isActingForAnotherLogin(req) {
  const actor = req.user?.network?.actor_user_id;
  return actor != null && Number(actor) !== Number(req.user.id);
}

/**
 * A business refusal raised from inside a service or transaction: the controller
 * catches it and answers `{ status: 0, message, reason? }` with `http`.
 */
export class NetworkHttpError extends Error {
  constructor(http, message, reason = undefined) {
    super(message);
    this.http = http;
    this.reason = reason;
  }
}

/** Sends a NetworkHttpError as its HTTP answer; returns false for any other error. */
export function sendIfNetworkError(res, err) {
  if (!(err instanceof NetworkHttpError)) return false;
  const body = { status: 0, message: err.message };
  if (err.reason) body.reason = err.reason;
  res.status(err.http).json(body);
  return true;
}

export default {
  refuseGuest,
  requireNetwork,
  requireOrgAdmin,
  actingPersonId,
  isActingForAnotherLogin,
  NetworkHttpError,
  sendIfNetworkError,
};
