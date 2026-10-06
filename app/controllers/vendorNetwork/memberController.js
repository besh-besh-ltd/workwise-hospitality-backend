// Vendor Networks: people of an org (spec §5 "People", §4.2, §10.3, §10.5).
// Inviting type-11 persons, the public accept page, role/entity changes,
// disable/enable, resend, and the NETWORK_MAX_PERSONS cap.
//
// Scope always comes from req.user.network. A :id (membership id) or
// entity_vendor_id in the body is only a target, verified against the caller's org.
//
// Invite tokens: 32 random bytes, emailed raw; only their sha256 is stored. The
// public accept endpoints have no rate limiter (the app has none for auth routes);
// a 256-bit token cannot be guessed, and an unknown one says nothing but 410.
//
// A person's tbl_users.company_id is NULL: a person is not a company, and buyer-side
// queries treat company_id as a tenant key, so NULL keeps persons out of them.

import crypto from "crypto";
import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { disconnectPersonSockets } from "../../util/socket.js";
import { sendMail, generatePassword } from "../../helper/common.js";
import { generateEmailTemplate } from "../../helper/notificationEmailLayout.js";
import {
  requireOrgAdmin,
  actingPersonId,
  NetworkHttpError,
  sendIfNetworkError,
} from "../../services/vendorNetwork/guards.js";
import {
  NETWORK_ROLE,
  MEMBER_STATUS,
  MEMBER_INVITE_TTL_HOURS,
  VENDOR_MEMBER_USER_TYPE,
  maxNetworkPersons,
} from "../../constants/vendorNetwork.js";
import {
  getOrgById,
  getEntity,
  listMembers,
  findUserByEmail,
  listPersonOrgIds,
  countLivePersons,
  hasLiveMembership,
  hasOpenMemberInvite,
  countActiveOrgAdmins,
  insertPerson,
  insertMembership,
  getMembership,
  updateMembership,
  rotateMemberInvite,
  getMemberInviteByTokenHash,
  activatePerson,
} from "../../models/vendorNetworkModel.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ROLES = [NETWORK_ROLE.ORG_ADMIN, NETWORK_ROLE.ENTITY_MEMBER];
const UNIQUE_VIOLATION = "23505";
const DEFAULT_FRONT_BASE_URL = "https://hospitality.letsworkwise.com"; // as the password-reset email

/** A positive int4 from a number or a digit string, else null. */
function parseId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const trimmed = (v) => (typeof v === "string" ? v.trim() : "");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

/** A fresh invite token: the raw value for the email, its sha256 for the database. */
function newInviteToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  return { raw, hash: sha256(raw) };
}

/** Emails the accept link (best effort, after commit: a mail failure never fails the request). */
async function sendInviteEmail({ email, name, orgName, entityName, rawToken }) {
  try {
    const base = (process.env.FRONT_BASE_URL || DEFAULT_FRONT_BASE_URL).replace(/\/+$/, "");
    const link = `${base}/vendor/network/accept-invite?token=${rawToken}`;
    const where = entityName ? `${escapeHtml(entityName)} in ${escapeHtml(orgName)}` : escapeHtml(orgName);
    const html = generateEmailTemplate(
      `<h5>Hello ${escapeHtml(name)}</h5>`,
      `<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
         <p>You have been invited to join the vendor network of ${where} on Workwise.</p>
         <p><a href="${link}">Accept the invitation and set your password</a></p>
         <p>This link expires in ${MEMBER_INVITE_TTL_HOURS} hours.</p>
       </div>`
    );
    await sendMail({ to: email, from: Config.webmasterMail, subject: "Work wise | Vendor network invitation", html });
  } catch (err) {
    logger.warn({ err: err.message }, "vendor-network member invite email failed");
  }
}

function closeSockets(personId) {
  try {
    disconnectPersonSockets(personId);
  } catch (err) {
    logger.warn({ err: err.message, personId }, "vendor-network socket disconnect failed");
  }
}

/** Serialises cap and last-admin checks of one org (call inside a tx). */
const lockOrgPeople = (t, orgId) => t.one(`SELECT pg_advisory_xact_lock(hashtext('vn_members_org:' || $1))`, [orgId]);

async function assertUnderCap(orgId, personId, t) {
  if ((await countLivePersons(orgId, personId, t)) >= maxNetworkPersons()) {
    throw new NetworkHttpError(409, "Your network has reached its limit of people", "PERSON_LIMIT");
  }
}

/** The live entity `vendorId` of the org, or 404. */
async function liveEntity(orgId, vendorId, t) {
  const entity = vendorId ? await getEntity(orgId, vendorId, t) : null;
  if (!entity) throw new NetworkHttpError(404, "Entity not found in your network");
  return entity;
}

const membershipView = (m, extra = {}) => ({
  id: m.id,
  person_user_id: m.person_user_id,
  entity_vendor_id: m.entity_vendor_id,
  role: m.role,
  status: m.status,
  invite_expires_at: m.invite_expires_at,
  ...extra,
});

/** GET /members: every membership of the caller's org, disabled included. */
export async function listOrgMembers(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const rows = await listMembers(req.user.network.org_id, db, { includeDisabled: true });
    return res.status(200).json({ status: 1, message: "People", data: rows });
  } catch (error) {
    return handleError(res, error, "listOrgMembers");
  }
}

/** Validated POST /members input, or a 400 refusal. */
function parseNewMember(body = {}) {
  const email = trimmed(body.email).toLowerCase();
  const name = trimmed(body.name);
  const { role } = body;
  if (!EMAIL_RE.test(email) || email.length > 255) throw new NetworkHttpError(400, "A valid email is required");
  if (!name || name.length > 255) throw new NetworkHttpError(400, "name is required (max 255)");
  if (!ROLES.includes(role)) throw new NetworkHttpError(400, `role must be one of ${ROLES.join(", ")}`);
  const given = body.entity_vendor_id != null && body.entity_vendor_id !== "";
  if (role === NETWORK_ROLE.ORG_ADMIN && given) {
    throw new NetworkHttpError(400, "An ORG_ADMIN covers the whole network and takes no entity_vendor_id");
  }
  if (role === NETWORK_ROLE.ENTITY_MEMBER && !given) {
    throw new NetworkHttpError(400, "entity_vendor_id is required for an ENTITY_MEMBER");
  }
  // A malformed id is answered like a foreign one: not found in your network.
  const entityVendorId = given ? parseId(body.entity_vendor_id) ?? -1 : null;
  return { email, name, role, entityVendorId };
}

/** POST /members { email, name, role, entity_vendor_id? } */
export async function inviteMember(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const input = parseNewMember(req.body);
    const { org_id: orgId, org_name: orgName } = req.user.network;
    const invitedBy = actingPersonId(req);

    const result = await db.tx(async (t) => {
      // tbl_users.email has no unique index: the same lock key as POST /entities.
      await t.one(`SELECT pg_advisory_xact_lock(hashtext('vn_email:' || lower($1)))`, [input.email]);
      await lockOrgPeople(t, orgId);
      const entity = input.entityVendorId ? await liveEntity(orgId, input.entityVendorId, t) : null;

      let person = await findUserByEmail(input.email, t);
      let status = MEMBER_STATUS.INVITED;
      let needsInvite = true;
      if (!person) {
        await assertUnderCap(orgId, null, t);
        const created = await insertPerson({ email: input.email, name: input.name, createdBy: invitedBy }, t);
        person = { id: created.id, email: input.email, name: input.name, status: 0 };
      } else {
        if (Number(person.user_type) !== VENDOR_MEMBER_USER_TYPE || Number(person.is_deleted) !== 0) {
          throw new NetworkHttpError(409, "This email is already registered", "EMAIL_EXISTS");
        }
        const orgIds = await listPersonOrgIds(person.id, t);
        if (orgIds.some((id) => Number(id) !== Number(orgId))) {
          throw new NetworkHttpError(409, "This person belongs to another network", "PERSON_IN_OTHER_ORG");
        }
        if (orgIds.length === 0) throw new NetworkHttpError(409, "This email is already registered", "EMAIL_EXISTS");
        if (!(await hasLiveMembership(orgId, person.id, null, t))) await assertUnderCap(orgId, person.id, t);
        // An accepted person gains the new access at once; a pending one waits for its open invite.
        if (Number(person.status) === 1) {
          status = MEMBER_STATUS.ACTIVE;
          needsInvite = false;
        } else {
          needsInvite = !(await hasOpenMemberInvite(orgId, person.id, t));
        }
      }

      const token = needsInvite ? newInviteToken() : null;
      let membership;
      try {
        membership = await insertMembership(
          {
            orgId,
            personId: person.id,
            entityVendorId: entity ? entity.vendor_id : null,
            role: input.role,
            status,
            tokenHash: token?.hash ?? null,
            ttlHours: MEMBER_INVITE_TTL_HOURS,
            invitedBy,
          },
          t
        );
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
          throw new NetworkHttpError(409, "This person already has this access", "ALREADY_MEMBER");
        }
        throw err;
      }
      return { membership, person, token, entityName: entity ? await entityName(entity.vendor_id, t) : null };
    });

    if (result.token) {
      await sendInviteEmail({
        email: result.person.email,
        name: result.person.name,
        orgName,
        entityName: result.entityName,
        rawToken: result.token.raw,
      });
    }
    return res.status(201).json({
      status: 1,
      message: result.token ? "Invitation sent" : "Access added",
      data: membershipView(result.membership, { email: result.person.email, name: result.person.name }),
    });
  } catch (error) {
    return handleError(res, error, "inviteMember");
  }
}

async function entityName(vendorId, t) {
  const row = await t.oneOrNone(`SELECT name FROM tbl_users WHERE id = $1`, [vendorId]);
  return row?.name ?? null;
}

/** Validated PATCH /members/:id input, or a 400 refusal. */
function parseMemberChange(body = {}) {
  const { status, role } = body;
  const entityGiven = Object.prototype.hasOwnProperty.call(body, "entity_vendor_id");
  if (status === undefined && role === undefined && !entityGiven) throw new NetworkHttpError(400, "Nothing to update");
  if (status !== undefined && ![MEMBER_STATUS.ACTIVE, MEMBER_STATUS.DISABLED].includes(status)) {
    throw new NetworkHttpError(400, "status must be ACTIVE or DISABLED");
  }
  if (role !== undefined && !ROLES.includes(role)) throw new NetworkHttpError(400, `role must be one of ${ROLES.join(", ")}`);
  const rawEntity = body.entity_vendor_id;
  const entityVendorId = !entityGiven || rawEntity == null || rawEntity === "" ? null : parseId(rawEntity) ?? -1;
  return { status, role, entityGiven, entityVendorId };
}

/**
 * The membership's next { status, role, entityVendorId } after `change`, validated.
 * `reinvite` marks a never-accepted person re-enabled back to INVITED.
 */
function nextMembershipState(m, change) {
  const role = change.role ?? m.role;
  let entityVendorId = null;
  if (role === NETWORK_ROLE.ORG_ADMIN) {
    if (change.entityVendorId) {
      throw new NetworkHttpError(400, "An ORG_ADMIN covers the whole network and takes no entity_vendor_id");
    }
  } else {
    entityVendorId = change.entityGiven ? change.entityVendorId : m.entity_vendor_id;
    if (!entityVendorId) throw new NetworkHttpError(400, "entity_vendor_id is required for an ENTITY_MEMBER");
  }

  if (change.status === MEMBER_STATUS.ACTIVE && m.status === MEMBER_STATUS.INVITED) {
    throw new NetworkHttpError(
      409,
      "This person has not accepted the invitation yet. Resend it instead.",
      "INVITE_NOT_ACCEPTED"
    );
  }
  let status = m.status;
  let reinvite = false;
  if (change.status === MEMBER_STATUS.DISABLED) status = MEMBER_STATUS.DISABLED;
  else if (change.status === MEMBER_STATUS.ACTIVE && m.status === MEMBER_STATUS.DISABLED) {
    // Enabling a person who never accepted re-opens the invite; nobody becomes ACTIVE without a password.
    reinvite = Number(m.user_status) !== 1;
    status = reinvite ? MEMBER_STATUS.INVITED : MEMBER_STATUS.ACTIVE;
  }
  return { status, role, entityVendorId, reinvite };
}

/** PATCH /members/:id { status?: 'ACTIVE'|'DISABLED', role?, entity_vendor_id? } */
export async function updateMember(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const membershipId = parseId(req.params.id);
    if (!membershipId) return fail(res, 404, "Person not found in your network");
    const change = parseMemberChange(req.body);
    const { org_id: orgId, org_name: orgName } = req.user.network;

    const result = await db.tx(async (t) => {
      await lockOrgPeople(t, orgId);
      const m = await getMembership(orgId, membershipId, t, { forUpdate: true });
      if (!m) throw new NetworkHttpError(404, "Person not found in your network");
      const next = nextMembershipState(m, change);

      const org = await getOrgById(orgId, t);
      const isPrincipalAdmin =
        m.role === NETWORK_ROLE.ORG_ADMIN && Number(m.person_user_id) === Number(org.principal_vendor_id);
      if (isPrincipalAdmin && (next.status === MEMBER_STATUS.DISABLED || next.role !== NETWORK_ROLE.ORG_ADMIN)) {
        throw new NetworkHttpError(400, "The principal's own admin access cannot be disabled or changed");
      }
      const losesAdmin =
        m.role === NETWORK_ROLE.ORG_ADMIN &&
        m.status === MEMBER_STATUS.ACTIVE &&
        (next.status !== MEMBER_STATUS.ACTIVE || next.role !== NETWORK_ROLE.ORG_ADMIN);
      if (losesAdmin && (await countActiveOrgAdmins(orgId, m.id, t)) === 0) {
        throw new NetworkHttpError(400, "The network must keep at least one active admin", "LAST_ADMIN");
      }

      const entityChanged = Number(next.entityVendorId ?? 0) !== Number(m.entity_vendor_id ?? 0);
      const enabling = m.status === MEMBER_STATUS.DISABLED && next.status !== MEMBER_STATUS.DISABLED;
      if (next.entityVendorId && (entityChanged || enabling)) await liveEntity(orgId, next.entityVendorId, t);
      if (enabling && !(await hasLiveMembership(orgId, m.person_user_id, m.id, t))) {
        await assertUnderCap(orgId, m.person_user_id, t);
      }

      let row;
      try {
        row = await updateMembership(m.id, next, t);
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
          throw new NetworkHttpError(409, "This person already has this access", "ALREADY_MEMBER");
        }
        throw err;
      }
      const token = next.reinvite ? newInviteToken() : null;
      if (token) row = await rotateMemberInvite(m.id, token.hash, MEMBER_INVITE_TTL_HOURS, t);

      const accessChanged =
        (next.status === MEMBER_STATUS.DISABLED && m.status !== MEMBER_STATUS.DISABLED) ||
        next.role !== m.role ||
        entityChanged;
      return {
        row,
        m,
        token,
        accessChanged,
        entityName: token && next.entityVendorId ? await entityName(next.entityVendorId, t) : null,
      };
    });

    // Sockets sit in the room of the entity they were opened for: any lost or moved access
    // closes them, and a reconnect re-resolves what the person may still act for.
    if (result.accessChanged) closeSockets(result.m.person_user_id);
    if (result.token) {
      await sendInviteEmail({
        email: result.m.email,
        name: result.m.name,
        orgName,
        entityName: result.entityName,
        rawToken: result.token.raw,
      });
    }
    return res.status(200).json({ status: 1, message: "Person updated", data: membershipView(result.row) });
  } catch (error) {
    return handleError(res, error, "updateMember");
  }
}

/** POST /members/:id/resend: a fresh token for an INVITED membership; the old one stops working. */
export async function resendMemberInvite(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const membershipId = parseId(req.params.id);
    if (!membershipId) return fail(res, 404, "Person not found in your network");
    const { org_id: orgId, org_name: orgName } = req.user.network;

    const result = await db.tx(async (t) => {
      const m = await getMembership(orgId, membershipId, t, { forUpdate: true });
      if (!m) throw new NetworkHttpError(404, "Person not found in your network");
      if (m.status !== MEMBER_STATUS.INVITED) {
        throw new NetworkHttpError(409, "Only a pending invitation can be resent", "NOT_INVITED");
      }
      const token = newInviteToken();
      const row = await rotateMemberInvite(m.id, token.hash, MEMBER_INVITE_TTL_HOURS, t);
      return { m, row, token, entityName: m.entity_vendor_id ? await entityName(m.entity_vendor_id, t) : null };
    });

    await sendInviteEmail({
      email: result.m.email,
      name: result.m.name,
      orgName,
      entityName: result.entityName,
      rawToken: result.token.raw,
    });
    return res.status(200).json({ status: 1, message: "Invitation resent", data: membershipView(result.row) });
  } catch (error) {
    return handleError(res, error, "resendMemberInvite");
  }
}

const GONE = "This invitation is invalid or has already been used";
/** An invite row still answerable: INVITED, held by a live type-11 person. Expiry is checked separately. */
const isOpenInvite = (invite) =>
  !!invite &&
  invite.status === MEMBER_STATUS.INVITED &&
  Number(invite.user_type) === VENDOR_MEMBER_USER_TYPE &&
  Number(invite.is_deleted) === 0;
const EXPIRED = "This invitation has expired. Ask your network admin to resend it.";

/** GET /member-invites/:token (public): only what the accept page shows. */
export async function previewMemberInvite(req, res) {
  try {
    const raw = trimmed(req.params.token);
    const invite = TOKEN_RE.test(raw) ? await getMemberInviteByTokenHash(sha256(raw)) : null;
    if (!isOpenInvite(invite)) return fail(res, 410, GONE);
    return res.status(200).json({
      status: 1,
      message: "Invitation",
      data: {
        email: invite.email,
        org_name: invite.org_name,
        entity_name: invite.entity_name ?? null,
        expired: !!invite.expired,
      },
    });
  } catch (error) {
    return handleError(res, error, "previewMemberInvite");
  }
}

/** At least 8 characters with a letter and a digit. */
const strongEnough = (p) => typeof p === "string" && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);

/** POST /member-invites/accept { token, password } (public) */
export async function acceptMemberInvite(req, res) {
  try {
    const raw = trimmed(req.body?.token);
    const { password } = req.body ?? {};
    if (!raw) return fail(res, 400, "token is required");
    if (!strongEnough(password)) {
      return fail(res, 400, "Password must be at least 8 characters and contain a letter and a digit");
    }
    if (!TOKEN_RE.test(raw)) return fail(res, 410, GONE);

    const outcome = await db.tx(async (t) => {
      const invite = await getMemberInviteByTokenHash(sha256(raw), t, { forUpdate: true });
      if (!isOpenInvite(invite)) return { gone: GONE };
      if (invite.expired) return { gone: EXPIRED };
      // Hashed only for a live invite, so unknown tokens cost the server nothing.
      const activated = await activatePerson(
        { orgId: invite.org_id, personId: invite.person_user_id, passwordHash: generatePassword(password) },
        t
      );
      // Only a never-activated (status 0) person sets a password here; anything else is not an open invite.
      if (!activated) throw new NetworkHttpError(410, GONE);
      return { invite };
    });
    if (outcome.gone) return fail(res, 410, outcome.gone);

    return res.status(200).json({
      status: 1,
      message: "Your account is ready. Sign in with your email and new password.",
      data: { email: outcome.invite.email, org_name: outcome.invite.org_name },
    });
  } catch (error) {
    return handleError(res, error, "acceptMemberInvite");
  }
}

export default {
  listOrgMembers,
  inviteMember,
  updateMember,
  resendMemberInvite,
  previewMemberInvite,
  acceptMemberInvite,
};
