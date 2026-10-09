// How a network member entity is covered for hospitality subscription purposes
// (spec §5.1 seats, §5.2 "the parent's subscription covers the network").
//
// The subscription GATES are already holder-aware (hasValidPaidSubscription pools the
// org's ACTIVE entities; requireActiveSubscription adds the seat check through
// entityCanOperate). This module only DESCRIBES that standing for the vendor-facing
// status surfaces, so a member is not told to "Subscribe" to something its network
// already holds.

import db from "../../config/dbConn.js";
import { ENTITY_RELATIONSHIP, ENTITY_STATUS, seatFeeInr, istDate } from "../../constants/vendorNetwork.js";
import { getNetworkSubscriptionStanding, getOrgByEntity } from "../../models/vendorNetworkModel.js";

/**
 * The `covered_by_network` block for the entity `req.user` acts as, or null when the
 * request runs in no network or as the org's principal (those keep today's answers).
 *
 * {
 *   org_id, org_name, principal_vendor_id, principal_name,
 *   entity_status,                 // ACTIVE | SUSPENDED | INVITED
 *   subscription_active,           // a holder of the org has a valid subscription
 *   subscription_valid_until,      // latest end date among those, 'YYYY-MM-DD' | null
 *   seat_active,                   // active unexpired seat, or the seat fee is 0
 *   seat_valid_until,              // 'YYYY-MM-DD' | null
 *   seat_expired_on,               // last seat end date when the seat is not active, else null
 *   covered,                       // ACTIVE entity AND subscription_active AND seat_active
 *   seat_fee_inr,                  // the per-seat fee; at 0 an expired seat blocks nothing
 * }
 */
export async function networkSubscriptionCoverage(user, runner = db) {
  const network = user?.network;
  if (!network || network.is_principal) return null;
  const standing = await getNetworkSubscriptionStanding(Number(user.id), runner, istDate());
  if (!standing) return null;
  if (
    standing.relationship === ENTITY_RELATIONSHIP.PRINCIPAL ||
    Number(standing.principal_vendor_id) === Number(user.id)
  ) {
    return null;
  }

  const seatValidUntil = standing.seat_valid_until ?? null;
  const seatActive = seatValidUntil !== null || seatFeeInr() === 0;
  const subscriptionActive = standing.subscription_valid_until !== null;
  return {
    org_id: standing.org_id,
    org_name: standing.org_name,
    principal_vendor_id: standing.principal_vendor_id,
    principal_name: standing.principal_name,
    entity_status: standing.entity_status,
    subscription_active: subscriptionActive,
    subscription_valid_until: standing.subscription_valid_until ?? null,
    seat_active: seatActive,
    seat_valid_until: seatValidUntil,
    seat_expired_on: seatActive ? null : standing.last_seat_end ?? null,
    covered: standing.entity_status === ENTITY_STATUS.ACTIVE && subscriptionActive && seatActive,
    seat_fee_inr: seatFeeInr(),
  };
}

/**
 * The org of `vendorId` when it is a NON-principal entity of one (any status but
 * REMOVED), else null. Purchase paths that are not JWT-authenticated (the user_key
 * subscription payment) use it: such an entity's subscription is the network's, bought
 * by the principal (spec §5.2), so it may not buy or renew one of its own.
 */
export async function memberEntityOrg(vendorId, runner = db) {
  const org = await getOrgByEntity(Number(vendorId), runner);
  if (!org) return null;
  if (org.relationship === ENTITY_RELATIONSHIP.PRINCIPAL || Number(org.principal_vendor_id) === Number(vendorId)) {
    return null;
  }
  return org;
}

export default { networkSubscriptionCoverage, memberEntityOrg };
