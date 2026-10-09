// Vendor Networks constants (spec 2026-10-06-vendor-networks-design.md).
// Env-backed values are functions so they are read at call time (tests flip env).

export const VENDOR_MEMBER_USER_TYPE = 11;

/** Logins that may act for a network entity (spec §4.1): vendors (3) and network persons (11). */
export const NETWORK_LOGIN_USER_TYPES = Object.freeze([3, VENDOR_MEMBER_USER_TYPE]);
export const isNetworkLoginType = (userType) => NETWORK_LOGIN_USER_TYPES.includes(Number(userType));

/** Refusal for credential flows on a passwordless, network-managed entity login (§4.2). */
export const NETWORK_MANAGED_MESSAGE = "This account is managed by your network admin";

export const NETWORK_ROLE = Object.freeze({ ORG_ADMIN: "ORG_ADMIN", ENTITY_MEMBER: "ENTITY_MEMBER" });

export const ENTITY_RELATIONSHIP = Object.freeze({
  PRINCIPAL: "PRINCIPAL",
  BRANCH: "BRANCH",
  DISTRIBUTOR: "DISTRIBUTOR",
  DEALER: "DEALER",
});

export const ENTITY_STATUS = Object.freeze({
  INVITED: "INVITED",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  REMOVED: "REMOVED",
});

export const MEMBER_STATUS = Object.freeze({ INVITED: "INVITED", ACTIVE: "ACTIVE", DISABLED: "DISABLED" });

export const ROUTING_MODE = Object.freeze({
  ADMIN_ROUTES: "ADMIN_ROUTES",
  AUTO_SINGLE_MATCH: "AUTO_SINGLE_MATCH",
});

export const SUBJECT_TYPE = Object.freeze({ RFQ: "RFQ", ARC_HOTEL: "ARC_HOTEL" });

export const ASSIGNMENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  TIMED_OUT: "TIMED_OUT",
  REVOKED: "REVOKED",
  SUPERSEDED: "SUPERSEDED",
});

export const DECLINE_REASON = Object.freeze({
  NO_STOCK: "NO_STOCK",
  CANNOT_MEET_DEADLINE: "CANNOT_MEET_DEADLINE",
  OUT_OF_AREA: "OUT_OF_AREA",
  OTHER: "OTHER",
});

export const LINK_INVITE_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
});

export const COVERAGE_SCOPE = Object.freeze({ STATE: "STATE", CITY: "CITY", HOTEL: "HOTEL" });
export const COVERAGE_MODE = Object.freeze({ INCLUDE: "INCLUDE", EXCLUDE: "EXCLUDE" });

export const SEAT_STATUS = Object.freeze({
  pending: "pending",
  active: "active",
  expired: "expired",
  cancelled: "cancelled",
});

export const LINK_INVITE_TTL_DAYS = 7;
export const MEMBER_INVITE_TTL_HOURS = 72;
// RFQ assignment due_at is capped at bid_end_date - 6h and floored at now + 1h.
export const RFQ_DUE_CAP_HOURS_BEFORE_BID_END = 6;
export const RFQ_DUE_FLOOR_HOURS_FROM_NOW = 1;
export const SWEEP_CRON = "*/15 * * * *";

export const seatFeeInr = () => Number(process.env.NETWORK_SEAT_FEE_INR ?? 0);
export const maxNetworkPersons = () => Number(process.env.NETWORK_MAX_PERSONS ?? 25);
/** Cap on live (non-REMOVED) entities per org, principal included, for POST /entities. */
export const maxNetworkEntities = () => Number(process.env.NETWORK_MAX_ENTITIES ?? 200);

/**
 * Today's calendar date in India (YYYY-MM-DD) at instant `date`. The single date source
 * for seat liveness (start/end dates are Indian-FY dates), passed to SQL as a parameter
 * instead of the session-timezone-dependent CURRENT_DATE.
 */
export function istDate(date = new Date()) {
  return new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}
