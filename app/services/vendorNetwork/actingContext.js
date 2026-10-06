// Acting-entity resolution (spec §4.1) and subscription-holder helpers (§5.1, §5.2).
//
// resolveActingContext runs on every vendor request. It decides which vendor entity
// (a type-3 tbl_users row) a logged-in person acts as. A null result means 401.
// Query budget: 1 for a vendor acting as itself, 2 otherwise.

import db from "../../config/dbConn.js";
import {
  VENDOR_MEMBER_USER_TYPE,
  NETWORK_ROLE,
  ENTITY_STATUS,
  ENTITY_RELATIONSHIP,
  seatFeeInr,
} from "../../constants/vendorNetwork.js";
import {
  getOrgByEntity,
  listActableForPerson,
  getActingEntityRow,
  listEntities,
  listActiveSiblingIds,
  mapToPrincipalIds,
  getOperateState,
} from "../../models/vendorNetworkModel.js";

const VENDOR_USER_TYPE = 3;
const INVALID = Symbol("invalid-ent");

/** null/undefined -> null; a positive integer (or its string form) -> number; anything else -> INVALID. */
function parseEnt(entClaim) {
  if (entClaim === null || entClaim === undefined) return null;
  const n = typeof entClaim === "string" && entClaim.trim() !== "" ? Number(entClaim) : entClaim;
  return Number.isInteger(n) && n > 0 ? n : INVALID;
}

const isLiveLogin = (row) => Number(row.status) === 1 && Number(row.is_deleted ?? 0) === 0;

function buildNetwork({ org, role, person, actingId, relationship, entityStatus }) {
  return {
    org_id: org.org_id,
    org_name: org.org_name,
    role,
    actor_user_id: Number(person.id),
    actor_name: person.name,
    acting_entity_id: actingId,
    is_principal: actingId === org.principal_vendor_id,
    entity_relationship: relationship,
    entity_status: entityStatus,
  };
}

/** Splits the vn_* placement columns off a getActingEntityRow result. */
function splitActingRow(row) {
  const { vn_org_id, vn_entity_status, vn_relationship, ...entityRow } = row;
  return { entityRow, orgId: vn_org_id, entityStatus: vn_entity_status, relationship: vn_relationship };
}

async function resolveForVendorLogin(personRow, ent, runner) {
  const personId = Number(personRow.id);
  const self = await getOrgByEntity(personId, runner);

  if (!self) {
    // Back-compat: identical to today, the passport-loaded row as-is.
    return ent === null || ent === personId ? { entityRow: personRow, network: undefined } : null;
  }
  if (!isLiveLogin(personRow)) return null;

  const isPrincipal = self.principal_vendor_id === personId;
  const role = isPrincipal ? NETWORK_ROLE.ORG_ADMIN : NETWORK_ROLE.ENTITY_MEMBER;

  if (ent === null || ent === personId) {
    // A member entity acts as itself whatever its entity status; entityCanOperate gates actions.
    return {
      entityRow: personRow,
      network: buildNetwork({
        org: self, role, person: personRow, actingId: personId,
        relationship: self.relationship, entityStatus: self.entity_status,
      }),
    };
  }
  if (!isPrincipal) return null;

  const row = await getActingEntityRow(ent, runner);
  if (!row) return null;
  const acting = splitActingRow(row);
  if (acting.orgId !== self.org_id || acting.entityStatus !== ENTITY_STATUS.ACTIVE) return null;
  return {
    entityRow: acting.entityRow,
    network: buildNetwork({
      org: self, role, person: personRow, actingId: ent,
      relationship: acting.relationship, entityStatus: acting.entityStatus,
    }),
  };
}

function defaultActable(actable) {
  const principalOfAdminOrg = actable.find(
    (a) => a.role === NETWORK_ROLE.ORG_ADMIN && a.vendor_id === a.principal_vendor_id
  );
  return principalOfAdminOrg ?? actable[0]; // actable is ordered by vendor_id
}

async function resolveForMemberPerson(personRow, ent, runner) {
  if (!isLiveLogin(personRow)) return null;
  const actable = await listActableForPerson(Number(personRow.id), runner);
  if (!actable.length) return null;

  const chosen = ent === null ? defaultActable(actable) : actable.find((a) => a.vendor_id === ent);
  if (!chosen) return null;

  const row = await getActingEntityRow(chosen.vendor_id, runner);
  if (!row) return null;
  const acting = splitActingRow(row);
  if (acting.orgId !== chosen.org_id || acting.entityStatus !== ENTITY_STATUS.ACTIVE) return null;
  return {
    entityRow: acting.entityRow,
    network: buildNetwork({
      org: chosen, role: chosen.role, person: personRow, actingId: chosen.vendor_id,
      relationship: acting.relationship, entityStatus: acting.entityStatus,
    }),
  };
}

/**
 * Which entity `personRow` acts as on this request.
 * @param personRow full tbl_users row of the authenticated person
 * @param entClaim  decrypted `ent` JWT claim, or null
 * @returns {Promise<{entityRow: object, network: object|undefined} | null>} null => 401
 */
export async function resolveActingContext(personRow, entClaim, runner = db) {
  if (!personRow) return null;
  const ent = parseEnt(entClaim);
  if (ent === INVALID) return null;

  const userType = Number(personRow.user_type);
  if (userType === VENDOR_USER_TYPE) return resolveForVendorLogin(personRow, ent, runner);
  if (userType === VENDOR_MEMBER_USER_TYPE) return resolveForMemberPerson(personRow, ent, runner);
  return null;
}

/** Entities the person may switch to: [{ vendor_id, name, relationship, org_id }]. */
export async function listActableEntities(personRow, runner = db) {
  if (!personRow) return [];
  const personId = Number(personRow.id);
  const userType = Number(personRow.user_type);

  if (userType === VENDOR_MEMBER_USER_TYPE) {
    if (!isLiveLogin(personRow)) return [];
    const actable = await listActableForPerson(personId, runner);
    return actable.map(({ vendor_id, name, relationship, org_id }) => ({ vendor_id, name, relationship, org_id }));
  }
  if (userType !== VENDOR_USER_TYPE) return [];

  const self = await getOrgByEntity(personId, runner);
  const selfEntry = {
    vendor_id: personId,
    name: personRow.name,
    relationship: self?.relationship ?? null,
    org_id: self?.org_id ?? null,
  };
  if (!self) return [selfEntry];
  if (!isLiveLogin(personRow)) return [];
  if (self.principal_vendor_id !== personId) return [selfEntry];

  const entities = await listEntities(self.org_id, runner);
  return entities
    .filter(
      (e) =>
        e.status === ENTITY_STATUS.ACTIVE && Number(e.user_status) === 1 && Number(e.user_is_deleted) === 0
    )
    .map((e) => ({ vendor_id: e.vendor_id, name: e.name, relationship: e.relationship, org_id: e.org_id }));
}

/**
 * Vendor ids whose subscriptions cover `vendorId`: every ACTIVE entity of its org when the
 * vendor is itself ACTIVE in an org, otherwise just [vendorId].
 */
export async function subscriptionHolderIdsFor(vendorId, runner = db) {
  const ids = await listActiveSiblingIds(vendorId, runner);
  return ids.length ? ids : [Number(vendorId)];
}

/** Distinct, ascending ids with each live org entity replaced by its org's principal. */
export async function collapseToPrincipals(vendorIds, runner = db) {
  const ids = (vendorIds ?? []).filter((v) => v !== null && v !== undefined).map(Number);
  if (!ids.length) return [];
  return mapToPrincipalIds(ids, runner);
}

/**
 * Whether the entity may operate (be assigned work, quote as itself, accept assignments).
 * The principal and no-org vendors always may. A member entity must be ACTIVE and hold an
 * active, unexpired seat, unless the seat fee is 0.
 */
export async function entityCanOperate(vendorId, runner = db) {
  const state = await getOperateState(vendorId, runner);
  if (!state) return { ok: true };
  if (state.relationship === ENTITY_RELATIONSHIP.PRINCIPAL || state.principal_vendor_id === Number(vendorId)) {
    return { ok: true };
  }
  if (state.entity_status !== ENTITY_STATUS.ACTIVE) return { ok: false, reason: "NOT_ACTIVE" };
  if (state.has_seat || seatFeeInr() === 0) return { ok: true };
  return { ok: false, reason: "NO_SEAT" };
}

export default {
  resolveActingContext,
  listActableEntities,
  subscriptionHolderIdsFor,
  collapseToPrincipals,
  entityCanOperate,
};
