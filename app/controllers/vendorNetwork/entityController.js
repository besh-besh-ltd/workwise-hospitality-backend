// Vendor Networks: entities of an org (spec §5, §10.5, §10.6).
// Linking an existing account (consent via link invites), creating a new
// branch/distributor login, PAN suggestions, suspend/reactivate, remove and leave.
//
// Scope always comes from req.user.network. A :vendorId / :id / body id is only a
// target, verified against the caller's org (or, for invites, the caller itself).

import crypto from "crypto";
import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { disconnectPersonSockets } from "../../util/socket.js";
import { dispatch as dispatchNotification } from "../../services/notificationService.js";
import {
  requireNetwork,
  requireOrgAdmin,
  actingPersonId,
  isActingForAnotherLogin,
  NetworkHttpError,
  sendIfNetworkError,
} from "../../services/vendorNetwork/guards.js";
import { ensureSeatForEntity } from "../../services/vendorNetwork/seats.js";
import { revokeLiveAssignmentsForEntity } from "../../services/vendorNetwork/routingEngine.js";
import {
  ENTITY_RELATIONSHIP,
  ENTITY_STATUS,
  LINK_INVITE_STATUS,
  LINK_INVITE_TTL_DAYS,
} from "../../constants/vendorNetwork.js";
import {
  getOrgByEntity,
  getOrgById,
  getEntity,
  getVendorPan,
  listVendorsByPan,
  findActiveVendor,
  isPrincipalOfAnyOrg,
  createLinkInvite as insertLinkInvite,
  getLinkInvite,
  setLinkInviteStatus,
  listIncomingLinkInvites,
  insertActiveEntity,
  findActiveVendorByGstin,
  emailExists,
  checkStateCity,
  insertVendorAccount,
  updateEntity as updateEntityRow,
  listPersonsOnlyViaEntity,
  removeEntity,
} from "../../models/vendorNetworkModel.js";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKABLE_RELATIONSHIPS = [
  ENTITY_RELATIONSHIP.BRANCH,
  ENTITY_RELATIONSHIP.DISTRIBUTOR,
  ENTITY_RELATIONSHIP.DEALER,
];
const INVITES_URL = "/dashboard/vendor/network/invites";
const NETWORK_URL = "/dashboard/vendor/network";
const UNIQUE_VIOLATION = "23505";

/** A positive int4 from a number or a digit string, else null. */
function parseId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const trimmed = (v) => (typeof v === "string" ? v.trim() : "");

function fail(res, http, message, reason) {
  const body = { status: 0, message };
  if (reason) body.reason = reason;
  return res.status(http).json(body);
}

function handleError(res, error, label) {
  if (sendIfNetworkError(res, error)) return res;
  logger.error({ err: error.message }, `vendor-network ${label} failed`);
  return res.status(400).json({ status: 3, message: Config.errorText.value });
}

/** In-app notification after commit; a failure never fails the request. */
async function notify({ userIds, type, title, body, senderUserId = null, actionUrl = NETWORK_URL, data = {} }) {
  try {
    await dispatchNotification({ userIds, senderUserId, category: "NETWORK", type, title, body, actionUrl, data });
  } catch (err) {
    logger.warn({ err: err.message, type }, "vendor-network notification failed");
  }
}

/**
 * After an entity is suspended or removed (committed): revoke its live routing
 * assignments and close the sockets of persons who had no other access.
 */
async function afterEntityLosesAccess(vendorId, personIds, { actorUserId, reason }) {
  try {
    await revokeLiveAssignmentsForEntity(vendorId, { actorUserId, reason });
  } catch (err) {
    logger.error({ err: err.message, vendorId, reason }, "vendor-network revoke assignments failed");
  }
  for (const personId of personIds) {
    try {
      disconnectPersonSockets(personId);
    } catch (err) {
      logger.warn({ err: err.message, personId }, "vendor-network socket disconnect failed");
    }
  }
}

/** The live, non-principal entity :vendorId of the caller's org, or a 404/400 refusal. */
async function targetEntity(req) {
  const vendorId = parseId(req.params.vendorId);
  const entity = vendorId ? await getEntity(req.user.network.org_id, vendorId) : null;
  if (!entity) throw new NetworkHttpError(404, "Entity not found in your network");
  if (entity.relationship === ENTITY_RELATIONSHIP.PRINCIPAL) {
    throw new NetworkHttpError(400, "The principal cannot be suspended, removed or leave");
  }
  return entity;
}

/** GET /entities/suggestions: active no-org vendors sharing the principal's PAN. */
export async function suggestions(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const org = await getOrgById(req.user.network.org_id);
    const pan = await getVendorPan(org.principal_vendor_id);
    const rows = pan ? await listVendorsByPan(pan, org.principal_vendor_id) : [];
    return res.status(200).json({ status: 1, message: "Suggestions", data: { pan, suggestions: rows } });
  } catch (error) {
    return handleError(res, error, "suggestions");
  }
}

/** POST /entities/link-invites { target_vendor_id | target_email, relationship } */
export async function createLinkInvite(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const { relationship } = req.body ?? {};
    if (!LINKABLE_RELATIONSHIPS.includes(relationship)) {
      return fail(res, 400, `relationship must be one of ${LINKABLE_RELATIONSHIPS.join(", ")}`);
    }
    const targetId = req.body?.target_vendor_id != null ? parseId(req.body.target_vendor_id) : null;
    const targetEmail = trimmed(req.body?.target_email);
    if (req.body?.target_vendor_id != null && targetId === null) return fail(res, 400, "Invalid target_vendor_id");
    if (targetId === null && !targetEmail) return fail(res, 400, "target_vendor_id or target_email is required");

    const target = await findActiveVendor(targetId !== null ? { vendorId: targetId } : { email: targetEmail });
    if (!target) return fail(res, 409, "No active vendor account matches", "NOT_FOUND");
    if (await isPrincipalOfAnyOrg(target.id)) {
      return fail(res, 409, "That vendor runs its own network and cannot be linked", "IS_PRINCIPAL");
    }
    if (await getOrgByEntity(target.id)) {
      return fail(res, 409, "That vendor already belongs to a network", "ALREADY_IN_NETWORK");
    }

    const { org_id: orgId, org_name: orgName } = req.user.network;
    const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
    const invite = await insertLinkInvite({
      orgId,
      targetVendorId: target.id,
      relationship,
      tokenHash,
      ttlDays: LINK_INVITE_TTL_DAYS,
      createdBy: actingPersonId(req),
    });

    await notify({
      userIds: [target.id],
      senderUserId: req.user.id,
      type: "NETWORK_LINK_INVITE",
      title: "Network invitation",
      body: `${orgName} invited you to join its vendor network as a ${relationship.toLowerCase()}.`,
      actionUrl: INVITES_URL,
      data: { invite_id: invite.id, org_id: orgId },
    });
    return res.status(201).json({ status: 1, message: "Invitation sent", data: invite });
  } catch (error) {
    return handleError(res, error, "createLinkInvite");
  }
}

/** GET /link-invites/incoming: PENDING invites addressed to the acting entity. */
export async function incomingLinkInvites(req, res) {
  try {
    const rows = await listIncomingLinkInvites(req.user.id);
    return res.status(200).json({ status: 1, message: "Invitations", data: rows });
  } catch (error) {
    return handleError(res, error, "incomingLinkInvites");
  }
}

/**
 * The invite :id addressed to the caller acting as itself, still PENDING and unexpired.
 * Anyone else gets 404. An expired one is flipped to EXPIRED and answered 410.
 */
async function respondableInvite(req, t) {
  const id = parseId(req.params.id);
  const invite = id ? await getLinkInvite(id, t, { forUpdate: true }) : null;
  if (!invite || Number(invite.target_vendor_id) !== Number(req.user.id) || isActingForAnotherLogin(req)) {
    throw new NetworkHttpError(404, "Invitation not found");
  }
  if (invite.status !== LINK_INVITE_STATUS.PENDING) {
    throw new NetworkHttpError(409, `This invitation is already ${invite.status.toLowerCase()}`);
  }
  if (invite.expired) {
    await setLinkInviteStatus(invite.id, LINK_INVITE_STATUS.EXPIRED, t);
    return { invite, expired: true };
  }
  return { invite, expired: false };
}

/** POST /link-invites/:id/accept (target entity, acting as itself) */
export async function acceptLinkInvite(req, res) {
  try {
    const result = await db.tx(async (t) => {
      const { invite, expired } = await respondableInvite(req, t);
      if (expired) return { expired: true };

      // Re-checked under the invite lock; the live-vendor unique index is the backstop.
      if (await isPrincipalOfAnyOrg(req.user.id, t)) {
        throw new NetworkHttpError(409, "You run your own network and cannot join another", "IS_PRINCIPAL");
      }
      if (await getOrgByEntity(req.user.id, t)) {
        throw new NetworkHttpError(409, "You already belong to a network", "ALREADY_IN_NETWORK");
      }
      await insertActiveEntity(
        { orgId: invite.org_id, vendorId: req.user.id, relationship: invite.relationship, invitedBy: invite.created_by },
        t
      );
      await setLinkInviteStatus(invite.id, LINK_INVITE_STATUS.ACCEPTED, t);
      const seat = await ensureSeatForEntity(
        { orgId: invite.org_id, entityVendorId: req.user.id, actorUserId: actingPersonId(req) },
        t
      );
      return { invite, seat };
    });
    if (result.expired) return fail(res, 410, "This invitation has expired");

    const { invite, seat } = result;
    await notify({
      userIds: [invite.principal_vendor_id],
      senderUserId: req.user.id,
      type: "NETWORK_LINK_ACCEPTED",
      title: "Network invitation accepted",
      body: `${req.user.name} joined ${invite.org_name} as a ${invite.relationship.toLowerCase()}.`,
      data: { invite_id: invite.id, vendor_id: req.user.id },
    });
    return res.status(200).json({
      status: 1,
      message: "You have joined the network",
      data: {
        org_id: invite.org_id,
        relationship: invite.relationship,
        seat: { id: seat.seat.id, status: seat.seat.status, payable: seat.payable, amount: seat.amount ?? 0 },
      },
    });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return fail(res, 409, "You already belong to a network", "ALREADY_IN_NETWORK");
    }
    return handleError(res, error, "acceptLinkInvite");
  }
}

/** POST /link-invites/:id/decline (target entity, acting as itself) */
export async function declineLinkInvite(req, res) {
  try {
    const result = await db.tx(async (t) => {
      const { invite, expired } = await respondableInvite(req, t);
      if (expired) return { expired: true };
      await setLinkInviteStatus(invite.id, LINK_INVITE_STATUS.DECLINED, t);
      return { invite };
    });
    if (result.expired) return fail(res, 410, "This invitation has expired");

    const { invite } = result;
    await notify({
      userIds: [invite.principal_vendor_id],
      senderUserId: req.user.id,
      type: "NETWORK_LINK_DECLINED",
      title: "Network invitation declined",
      body: `${req.user.name} declined to join ${invite.org_name}.`,
      data: { invite_id: invite.id, vendor_id: req.user.id },
    });
    return res.status(200).json({ status: 1, message: "Invitation declined", data: { id: invite.id } });
  } catch (error) {
    return handleError(res, error, "declineLinkInvite");
  }
}

/** DELETE /entities/link-invites/:id (admin cancels its org's PENDING invite) */
export async function cancelLinkInvite(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const id = parseId(req.params.id);
    const invite = id ? await getLinkInvite(id) : null;
    if (!invite || invite.org_id !== req.user.network.org_id) return fail(res, 404, "Invitation not found");
    if (invite.status !== LINK_INVITE_STATUS.PENDING) {
      return fail(res, 409, `This invitation is already ${invite.status.toLowerCase()}`);
    }
    await setLinkInviteStatus(invite.id, LINK_INVITE_STATUS.CANCELLED);
    return res.status(200).json({ status: 1, message: "Invitation cancelled", data: { id: invite.id } });
  } catch (error) {
    return handleError(res, error, "cancelLinkInvite");
  }
}

/** Validated POST /entities input, or a 400 refusal. */
function parseNewEntity(body = {}) {
  const companyName = trimmed(body.company_name);
  const gstin = trimmed(body.gstin).toUpperCase();
  const email = trimmed(body.email).toLowerCase();
  const stateId = parseId(body.state_id);
  const cityId = body.city_id == null || body.city_id === "" ? null : parseId(body.city_id);
  const address = trimmed(body.address) || null;
  const { relationship } = body;

  if (!companyName || companyName.length > 255) throw new NetworkHttpError(400, "company_name is required (max 255)");
  if (!GSTIN_RE.test(gstin)) throw new NetworkHttpError(400, "gstin is not a valid GSTIN");
  if (!EMAIL_RE.test(email) || email.length > 255) throw new NetworkHttpError(400, "A valid email is required");
  if (!stateId) throw new NetworkHttpError(400, "state_id is required");
  if (body.city_id != null && body.city_id !== "" && !cityId) throw new NetworkHttpError(400, "Invalid city_id");
  if (!LINKABLE_RELATIONSHIPS.includes(relationship)) {
    throw new NetworkHttpError(400, `relationship must be one of ${LINKABLE_RELATIONSHIPS.join(", ")}`);
  }
  return { companyName, gstin, email, stateId, cityId, address, relationship };
}

/** POST /entities { company_name, gstin, email, state_id, city_id?, address?, relationship } */
export async function createEntity(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const input = parseNewEntity(req.body);
    const place = await checkStateCity(input.stateId, input.cityId);
    if (!place.state_ok) return fail(res, 400, "Unknown state_id");
    if (!place.city_ok) return fail(res, 400, "city_id does not belong to state_id");
    if (await findActiveVendorByGstin(input.gstin)) {
      return fail(
        res,
        409,
        "A vendor account with this GSTIN already exists. Send it a link invite instead.",
        "GSTIN_EXISTS"
      );
    }
    if (await emailExists(input.email)) return fail(res, 409, "This email is already registered", "EMAIL_EXISTS");

    const orgId = req.user.network.org_id;
    const personId = actingPersonId(req);
    const created = await db.tx(async (t) => {
      const account = await insertVendorAccount({ ...input, createdBy: personId }, t);
      await insertActiveEntity(
        { orgId, vendorId: account.vendorId, relationship: input.relationship, invitedBy: personId },
        t
      );
      const seat = await ensureSeatForEntity({ orgId, entityVendorId: account.vendorId, actorUserId: personId }, t);
      return { ...account, seat };
    });

    return res.status(201).json({
      status: 1,
      message: "Entity created",
      data: {
        vendor_id: created.vendorId,
        company_id: created.companyId,
        relationship: input.relationship,
        seat: {
          id: created.seat.seat.id,
          status: created.seat.seat.status,
          payable: created.seat.payable,
          amount: created.seat.amount ?? 0,
        },
      },
    });
  } catch (error) {
    return handleError(res, error, "createEntity");
  }
}

/** PATCH /entities/:vendorId { status?: 'SUSPENDED'|'ACTIVE', preference_rank? } */
export async function updateEntity(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const entity = await targetEntity(req);
    const { status } = req.body ?? {};
    const rank = req.body?.preference_rank;
    if (status === undefined && rank === undefined) return fail(res, 400, "Nothing to update");
    if (status !== undefined && ![ENTITY_STATUS.ACTIVE, ENTITY_STATUS.SUSPENDED].includes(status)) {
      return fail(res, 400, "status must be ACTIVE or SUSPENDED");
    }
    if (rank !== undefined && !(Number.isInteger(rank) && rank >= 0 && rank <= 10000)) {
      return fail(res, 400, "preference_rank must be an integer 0..10000");
    }

    const orgId = req.user.network.org_id;
    const suspending = status === ENTITY_STATUS.SUSPENDED && entity.status !== ENTITY_STATUS.SUSPENDED;
    const { row, personIds } = await db.tx(async (t) => ({
      personIds: suspending ? await listPersonsOnlyViaEntity(orgId, entity.vendor_id, t) : [],
      row: await updateEntityRow(orgId, entity.vendor_id, { status, preferenceRank: rank }, t),
    }));
    if (suspending) {
      await afterEntityLosesAccess(entity.vendor_id, personIds, {
        actorUserId: actingPersonId(req),
        reason: "ENTITY_SUSPENDED",
      });
    }
    return res.status(200).json({
      status: 1,
      message: "Entity updated",
      data: { vendor_id: row.vendor_id, status: row.status, preference_rank: row.preference_rank },
    });
  } catch (error) {
    return handleError(res, error, "updateEntity");
  }
}

async function removeAndRevoke(req, orgId, vendorId) {
  const personIds = await db.tx(async (t) => {
    const ids = await listPersonsOnlyViaEntity(orgId, vendorId, t);
    await removeEntity(orgId, vendorId, t);
    return ids;
  });
  await afterEntityLosesAccess(vendorId, personIds, { actorUserId: actingPersonId(req), reason: "ENTITY_REMOVED" });
}

/** DELETE /entities/:vendorId (admin) */
export async function deleteEntity(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const entity = await targetEntity(req);
    await removeAndRevoke(req, req.user.network.org_id, entity.vendor_id);
    return res.status(200).json({ status: 1, message: "Entity removed", data: { vendor_id: entity.vendor_id } });
  } catch (error) {
    return handleError(res, error, "deleteEntity");
  }
}

/** POST /entities/self/leave: a member entity, on its own login, leaves the network. */
export async function leaveNetwork(req, res) {
  try {
    const denied = requireNetwork(req);
    if (denied) return res.status(denied.http).json(denied.body);
    if (isActingForAnotherLogin(req)) return fail(res, 403, "Only the entity's own login can leave the network");
    if (req.user.network.is_principal) return fail(res, 400, "The principal cannot leave its own network");

    await removeAndRevoke(req, req.user.network.org_id, req.user.id);
    return res.status(200).json({ status: 1, message: "You have left the network", data: { vendor_id: req.user.id } });
  } catch (error) {
    return handleError(res, error, "leaveNetwork");
  }
}

export default {
  suggestions,
  createLinkInvite,
  incomingLinkInvites,
  acceptLinkInvite,
  declineLinkInvite,
  cancelLinkInvite,
  createEntity,
  updateEntity,
  deleteEntity,
  leaveNetwork,
};
