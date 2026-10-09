// Vendor Networks: org-level endpoints (spec §4.1, §5).

import JWT from "jsonwebtoken";
import { ExtractJwt } from "passport-jwt";
import Config from "../../config/app.config.js";
import userModel from "../../models/userModel.js";
import jwtHelper from "../../helper/jwtHelper.js";
import { encryptStable } from "../../helper/claimCrypto.js";
import db from "../../config/dbConn.js";
import { resolveActingContext } from "../../services/vendorNetwork/actingContext.js";
import {
  refuseGuest,
  requireNetwork,
  requireOrgAdmin,
  actingPersonId,
  sendIfNetworkError,
} from "../../services/vendorNetwork/guards.js";
import { createSeatPaymentOrder, verifySeatPayment } from "../../services/vendorNetwork/seats.js";
import { ROUTING_MODE, seatFeeInr } from "../../constants/vendorNetwork.js";
import {
  createOrgWithPrincipal,
  getOrgById,
  updateOrgSettings,
  listEntitiesWithSeats,
  listMembers,
  listOutgoingLinkInvites,
} from "../../models/vendorNetworkModel.js";
import { logger } from "../../util/logger.js";

const bearerToken = ExtractJwt.fromAuthHeaderAsBearerToken();

/** A positive int4 from a number or a digit string, else null. */
function parseVendorId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/**
 * POST /vendor-network/switch-entity { entity_vendor_id }
 *
 * The body id is only a target. Whether the caller may act for it is decided by
 * the same resolver jwtUsr runs, recomputed from the PERSON (never the entity
 * the current token happens to act as), so a switch can never widen access.
 * The new token keeps the current token's `exp`: switching never extends a session.
 */
export async function switchEntity(req, res) {
  try {
    // A guest (emailed-link) token is refused outright, so a switch can never mint a
    // normal token from it and drop its `guest` claim.
    const denied = refuseGuest(req) ?? requireNetwork(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const target = parseVendorId(req.body?.entity_vendor_id);
    if (target === null) {
      return res.status(400).json({ status: 0, message: "entity_vendor_id is required" });
    }

    const personId = req.user.network.actor_user_id;
    const [person] = await userModel.user_detail_check(personId);
    const ctx = person ? await resolveActingContext(person, target) : null;
    if (!ctx || Number(ctx.entityRow.id) !== target) {
      return res.status(403).json({ status: 0, message: "You cannot act for this entity" });
    }

    // jwtUsr has already verified this token; decode only to read its exp.
    const currentExp = JWT.decode(bearerToken(req))?.exp;

    // Same `sub`/`ag` as a fresh login of this person, so jwtUsr's ag check holds.
    const token = jwtHelper.signAccessTokenUser({
      user_id: encryptStable(String(person.id)),
      name: person.name,
      user_agent: encryptStable(String(person.user_agent)),
      sessions: "",
      ent: encryptStable(String(target)),
      exp: currentExp,
    });
    return res.status(200).json({
      status: 1,
      message: "Switched entity",
      data: { token, acting_entity_id: target },
    });
  } catch (error) {
    logger.error({ err: error.message }, "vendor-network switchEntity failed");
    return res.status(400).json({ status: 3, message: Config.errorText.value });
  }
}

const ORG_NAME_MAX = 120;
const UNIQUE_VIOLATION = "23505";

function fail(res, http, message) {
  return res.status(http).json({ status: 0, message });
}

function handleError(res, error, label) {
  if (sendIfNetworkError(res, error)) return res;
  logger.error({ err: error.message }, `vendor-network ${label} failed`);
  return res.status(400).json({ status: 3, message: Config.errorText.value });
}

/** A trimmed org name of 1..120 chars, else null. */
function parseOrgName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= ORG_NAME_MAX ? name : null;
}

/**
 * POST /vendor-network/org { name }
 * The caller, a vendor in no live org acting as itself, becomes the PRINCIPAL and
 * its own login the ORG_ADMIN of a new network.
 */
export async function createOrg(req, res) {
  try {
    const guest = refuseGuest(req);
    if (guest) return res.status(guest.http).json(guest.body);
    if (req.user.network) return fail(res, 409, "You already belong to a network");
    if (Number(req.user.status) !== 1) return fail(res, 403, "Your account is not active");
    const name = parseOrgName(req.body?.name);
    if (!name) return fail(res, 400, `name is required (1-${ORG_NAME_MAX} characters)`);

    const org = await db.tx((t) =>
      createOrgWithPrincipal({ name, principalVendorId: req.user.id, personId: req.user.id }, t)
    );
    return res.status(201).json({
      status: 1,
      message: "Network created",
      data: { org_id: org.id, name: org.name, routing_mode: org.routing_mode, routing_timeout_hours: org.routing_timeout_hours },
    });
  } catch (error) {
    // Both live-entity and one-principal unique indexes back the "in no org" check.
    if (error.code === UNIQUE_VIOLATION) return fail(res, 409, "You already belong to a network");
    return handleError(res, error, "createOrg");
  }
}

/** GET /vendor-network/org: org settings, entities with seat status, people, pending invites. */
export async function getOrg(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const orgId = req.user.network.org_id;
    const [org, entities, members, invites] = await Promise.all([
      getOrgById(orgId),
      listEntitiesWithSeats(orgId),
      listMembers(orgId),
      listOutgoingLinkInvites(orgId),
    ]);
    return res.status(200).json({
      status: 1,
      message: "Network",
      data: {
        org: {
          id: org.id,
          name: org.name,
          principal_vendor_id: org.principal_vendor_id,
          routing_mode: org.routing_mode,
          routing_timeout_hours: org.routing_timeout_hours,
          created_at: org.created_at,
        },
        entities,
        members,
        link_invites: invites,
        // The per-seat fee (NETWORK_SEAT_FEE_INR). At 0 an expired seat blocks nothing,
        // so the FE shows "Included" rather than "Seat expired".
        seat_fee_inr: seatFeeInr(),
      },
    });
  } catch (error) {
    return handleError(res, error, "getOrg");
  }
}

/** PATCH /vendor-network/org { name?, routing_mode?, routing_timeout_hours? } */
export async function updateOrg(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const body = req.body ?? {};
    const patch = {};
    if (body.name !== undefined) {
      patch.name = parseOrgName(body.name);
      if (!patch.name) return fail(res, 400, `name must be 1-${ORG_NAME_MAX} characters`);
    }
    if (body.routing_mode !== undefined) {
      if (!Object.values(ROUTING_MODE).includes(body.routing_mode)) {
        return fail(res, 400, `routing_mode must be one of ${Object.values(ROUTING_MODE).join(", ")}`);
      }
      patch.routing_mode = body.routing_mode;
    }
    if (body.routing_timeout_hours !== undefined) {
      const hours = body.routing_timeout_hours;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
        return fail(res, 400, "routing_timeout_hours must be an integer from 1 to 168");
      }
      patch.routing_timeout_hours = hours;
    }
    if (!Object.keys(patch).length) return fail(res, 400, "Nothing to update");

    const org = await updateOrgSettings(req.user.network.org_id, patch);
    return res.status(200).json({
      status: 1,
      message: "Network settings saved",
      data: { id: org.id, name: org.name, routing_mode: org.routing_mode, routing_timeout_hours: org.routing_timeout_hours },
    });
  } catch (error) {
    return handleError(res, error, "updateOrg");
  }
}

/** POST /vendor-network/seats/pay { seat_ids } -> a Razorpay order for the org's pending seats. */
export async function paySeats(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const raw = req.body?.seat_ids;
    const seatIds = Array.isArray(raw) ? raw.map(parseVendorId) : [];
    if (!seatIds.length || seatIds.length > 100 || seatIds.includes(null)) {
      return fail(res, 400, "seat_ids must be a non-empty list of seat ids");
    }
    const data = await createSeatPaymentOrder({
      orgId: req.user.network.org_id,
      seatIds,
      actorUserId: actingPersonId(req),
    });
    return res.status(200).json({ status: 1, message: "Payment order created", data });
  } catch (error) {
    return handleError(res, error, "paySeats");
  }
}

/** POST /vendor-network/seats/verify-payment { razorpay_order_id, razorpay_payment_id, razorpay_signature } */
export async function verifySeatsPayment(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every((v) => typeof v === "string" && v)) {
      return fail(res, 400, "Missing payment verification parameters");
    }
    const result = await verifySeatPayment({
      orgId: req.user.network.org_id,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
    });
    return res.status(200).json({
      status: 1,
      message: result.already_paid ? "Payment already verified" : "Seats activated",
      data: {
        payment_id: result.payment_id,
        activated: result.activated,
        seats: result.seats.map((s) => ({ id: s.id, entity_vendor_id: s.entity_vendor_id, status: s.status, end_date: s.end_date })),
      },
    });
  } catch (error) {
    return handleError(res, error, "verifySeatsPayment");
  }
}

export default { switchEntity, createOrg, getOrg, updateOrg, paySeats, verifySeatsPayment };
