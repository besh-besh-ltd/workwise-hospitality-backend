// Guest sessions: the 30-minute JWT POST /users/verify-vendor-token mints from an
// emailed RFQ link (`guest: true` claim). Whoever holds the link gets it, so it may
// view, quote and regret on the RFQ, and nothing else: no network administration,
// no entity switching, no password change.
//
// jwtUsr marks req.user with a non-enumerable symbol, so the user object a route
// sees (and anything that serialises it) is unchanged; only these helpers read it.

const GUEST_SESSION = Symbol.for("workwise.guestSession");

/** Marks a jwtUsr user object as coming from a guest token. Returns the object. */
export function markGuestSession(user) {
  if (user && typeof user === "object") {
    Object.defineProperty(user, GUEST_SESSION, { value: true, enumerable: false });
  }
  return user;
}

/** True when the request is authenticated by an emailed-link guest token. */
export function isGuestSession(req) {
  return req?.user?.[GUEST_SESSION] === true;
}

export const GUEST_SESSION_REASON = "GUEST_SESSION";

/** The 403 body every guarded route answers a guest session with. */
export const guestSessionRefusal = () => ({
  status: 0,
  message: "Sign in to your account to do this. Emailed links only open the RFQ.",
  reason: GUEST_SESSION_REASON,
});

/** Sends the 403 refusal and returns true for a guest session; false otherwise. */
export function refuseGuestSession(req, res) {
  if (!isGuestSession(req)) return false;
  res.status(403).json(guestSessionRefusal());
  return true;
}

/** Route middleware form of refuseGuestSession (mount after passportSignIn). */
export function refuseGuestSessionMiddleware(req, res, next) {
  if (refuseGuestSession(req, res)) return;
  next();
}

export default {
  markGuestSession,
  isGuestSession,
  guestSessionRefusal,
  refuseGuestSession,
  refuseGuestSessionMiddleware,
  GUEST_SESSION_REASON,
};
