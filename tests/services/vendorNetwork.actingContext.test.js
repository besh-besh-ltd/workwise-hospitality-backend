// Acting-context resolution (spec §4.1) and subscription-holder helpers (§5.1, §5.2).
// Pattern B: committed fixtures (ids 95001..95999), removed in afterEach.

import { db } from "../setup/db.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import {
  resolveActingContext,
  subscriptionHolderIdsFor,
  collapseToPrincipals,
  entityCanOperate,
  listActableEntities,
} from "../../app/services/vendorNetwork/actingContext.js";
import * as vnModel from "../../app/models/vendorNetworkModel.js";

const HQ = 95101;
const BRANCH = 95102;
const SUSPENDED_BRANCH = 95103;
const OTHER_HQ = 95104;
const LONE = 95105;
const SIBLING = 95106;
const ADMIN_PERSON = 95201;
const MEMBER_PERSON = 95202;
const ORG = 95101;
const OTHER_ORG = 95102;

const userRow = (id) => db.one(`SELECT * FROM tbl_users WHERE id = $1`, [id]);

async function entity(id, extra = {}) {
  await seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@test.local`, ...extra });
}

/** HQ (principal) + ACTIVE BRANCH + ACTIVE SIBLING + SUSPENDED_BRANCH; separate org OTHER_HQ; LONE in no org. */
async function world() {
  for (const id of [HQ, BRANCH, SUSPENDED_BRANCH, OTHER_HQ, LONE, SIBLING]) await entity(id);
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN Org" });
  await addEntity({ orgId: ORG, vendorId: BRANCH });
  await addEntity({ orgId: ORG, vendorId: SIBLING, relationship: "DISTRIBUTOR" });
  await addEntity({ orgId: ORG, vendorId: SUSPENDED_BRANCH, status: "SUSPENDED" });
  await seedOrg({ id: OTHER_ORG, principalVendorId: OTHER_HQ, name: "Other Org" });
}

const savedFee = process.env.NETWORK_SEAT_FEE_INR;

afterEach(async () => {
  if (savedFee === undefined) delete process.env.NETWORK_SEAT_FEE_INR;
  else process.env.NETWORK_SEAT_FEE_INR = savedFee;
  await cleanupVendorNetworkFixtures();
});

describe("resolveActingContext", () => {
  it("no-org vendor without ent acts as itself with no network (back-compat)", async () => {
    await world();
    const person = await userRow(LONE);
    const ctx = await resolveActingContext(person, null);
    expect(ctx.entityRow).toBe(person);
    expect(ctx.network).toBeUndefined();
    // ent equal to self is the same thing
    const again = await resolveActingContext(person, LONE);
    expect(again.entityRow.id).toBe(LONE);
    expect(again.network).toBeUndefined();
  });

  it("no-org vendor with a foreign ent is refused", async () => {
    await world();
    expect(await resolveActingContext(await userRow(LONE), BRANCH)).toBeNull();
  });

  it("principal without ent acts as itself with ORG_ADMIN", async () => {
    await world();
    const ctx = await resolveActingContext(await userRow(HQ), null);
    expect(ctx.entityRow.id).toBe(HQ);
    expect(ctx.network).toMatchObject({
      org_id: ORG,
      org_name: "VN Org",
      role: "ORG_ADMIN",
      actor_user_id: HQ,
      actor_name: `VN ${HQ}`,
      acting_entity_id: HQ,
      is_principal: true,
      entity_relationship: "PRINCIPAL",
    });
  });

  it("principal with ent = ACTIVE branch acts as the branch, actor stays the principal", async () => {
    await world();
    const ctx = await resolveActingContext(await userRow(HQ), BRANCH);
    expect(ctx.entityRow.id).toBe(BRANCH);
    expect(ctx.entityRow.user_type).toBe(3);
    expect(ctx.entityRow).not.toHaveProperty("vn_org_id");
    expect(ctx.network).toMatchObject({
      org_id: ORG,
      role: "ORG_ADMIN",
      actor_user_id: HQ,
      acting_entity_id: BRANCH,
      is_principal: false,
      entity_relationship: "BRANCH",
    });
  });

  it("principal with ent = SUSPENDED branch is refused", async () => {
    await world();
    expect(await resolveActingContext(await userRow(HQ), SUSPENDED_BRANCH)).toBeNull();
  });

  it("principal with ent = entity of another org is refused", async () => {
    await world();
    expect(await resolveActingContext(await userRow(HQ), OTHER_HQ)).toBeNull();
    expect(await resolveActingContext(await userRow(HQ), LONE)).toBeNull();
  });

  it("type-11 ORG_ADMIN without ent acts as the principal; may switch to an ACTIVE entity", async () => {
    await world();
    await seedPerson({ id: ADMIN_PERSON, email: "vn-admin@test.local", name: "Asha Admin" });
    await addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });
    const person = await userRow(ADMIN_PERSON);

    const ctx = await resolveActingContext(person, null);
    expect(ctx.entityRow.id).toBe(HQ);
    expect(ctx.network).toMatchObject({
      org_id: ORG,
      role: "ORG_ADMIN",
      actor_user_id: ADMIN_PERSON,
      actor_name: "Asha Admin",
      acting_entity_id: HQ,
      is_principal: true,
    });

    const sw = await resolveActingContext(person, SIBLING);
    expect(sw.entityRow.id).toBe(SIBLING);
    expect(sw.network.role).toBe("ORG_ADMIN");
    // a type-11 person never runs as itself
    expect(await resolveActingContext(person, ADMIN_PERSON)).toBeNull();
  });

  it("type-11 ENTITY_MEMBER of branch B without ent acts as B", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member@test.local", name: "Mo Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    const ctx = await resolveActingContext(await userRow(MEMBER_PERSON), null);
    expect(ctx.entityRow.id).toBe(BRANCH);
    expect(ctx.network).toMatchObject({
      org_id: ORG,
      role: "ENTITY_MEMBER",
      actor_user_id: MEMBER_PERSON,
      acting_entity_id: BRANCH,
      is_principal: false,
    });
  });

  it("type-11 member of B with ent = sibling C is refused", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member@test.local", name: "Mo Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    const person = await userRow(MEMBER_PERSON);
    expect(await resolveActingContext(person, SIBLING)).toBeNull();
    expect(await resolveActingContext(person, HQ)).toBeNull();
  });

  it("a DISABLED membership is refused", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member@test.local", name: "Mo Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER", status: "DISABLED" });
    const person = await userRow(MEMBER_PERSON);
    expect(await resolveActingContext(person, null)).toBeNull();
    expect(await resolveActingContext(person, BRANCH)).toBeNull();
  });

  it("a REMOVED entity is refused (stale ent claim loses access next request)", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member@test.local", name: "Mo Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    const member = await userRow(MEMBER_PERSON);
    expect((await resolveActingContext(member, BRANCH)).entityRow.id).toBe(BRANCH);

    await db.none(
      `UPDATE tbl_vendor_org_entities SET status = 'REMOVED', removed_at = now() WHERE vendor_id = $1`,
      [BRANCH]
    );
    expect(await resolveActingContext(member, BRANCH)).toBeNull();
    expect(await resolveActingContext(member, null)).toBeNull();
    expect(await resolveActingContext(await userRow(HQ), BRANCH)).toBeNull();
  });

  it("member-entity login without ent acts as itself with ENTITY_MEMBER", async () => {
    await world();
    const ctx = await resolveActingContext(await userRow(BRANCH), null);
    expect(ctx.entityRow.id).toBe(BRANCH);
    expect(ctx.network).toMatchObject({
      org_id: ORG,
      role: "ENTITY_MEMBER",
      actor_user_id: BRANCH,
      acting_entity_id: BRANCH,
      is_principal: false,
      entity_relationship: "BRANCH",
      entity_status: "ACTIVE",
    });
  });

  it("member-entity login with ent = principal is refused", async () => {
    await world();
    expect(await resolveActingContext(await userRow(BRANCH), HQ)).toBeNull();
  });

  it("member-entity login with ent = sibling is refused", async () => {
    await world();
    expect(await resolveActingContext(await userRow(BRANCH), SIBLING)).toBeNull();
  });

  it("SUSPENDED member-entity login still acts as itself, carrying entity_status, but cannot operate", async () => {
    await world();
    const ctx = await resolveActingContext(await userRow(SUSPENDED_BRANCH), null);
    expect(ctx.entityRow.id).toBe(SUSPENDED_BRANCH);
    expect(ctx.network).toMatchObject({
      role: "ENTITY_MEMBER",
      acting_entity_id: SUSPENDED_BRANCH,
      is_principal: false,
      entity_status: "SUSPENDED",
    });
    expect(await entityCanOperate(SUSPENDED_BRANCH)).toEqual({ ok: false, reason: "NOT_ACTIVE" });
  });

  it.each(["abc", "1e5", "0x17", -1, 1.5, "", " 95102", 0])("a malformed ent claim (%p) is refused", async (bad) => {
    await world();
    expect(await resolveActingContext(await userRow(HQ), bad)).toBeNull();
    expect(await resolveActingContext(await userRow(LONE), bad)).toBeNull();
  });

  it("a digit-string ent claim is accepted", async () => {
    await world();
    expect((await resolveActingContext(await userRow(HQ), String(BRANCH))).entityRow.id).toBe(BRANCH);
  });

  it("a person or acting entity with status 0 is refused", async () => {
    await world();
    await seedPerson({ id: ADMIN_PERSON, email: "vn-admin@test.local", name: "Asha Admin", status: 0 });
    await addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });
    expect(await resolveActingContext(await userRow(ADMIN_PERSON), null)).toBeNull();

    // principal login deactivated
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [HQ]);
    expect(await resolveActingContext(await userRow(HQ), null)).toBeNull();
    await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [HQ]);

    // acting entity deactivated
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [BRANCH]);
    expect(await resolveActingContext(await userRow(HQ), BRANCH)).toBeNull();
  });
});

describe("listActableEntities", () => {
  it("lists ACTIVE live entities for an org admin, self for a lone vendor", async () => {
    await world();
    await seedPerson({ id: ADMIN_PERSON, email: "vn-admin@test.local", name: "Asha Admin" });
    await addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });

    const forAdmin = await listActableEntities(await userRow(ADMIN_PERSON));
    expect(forAdmin.map((e) => e.vendor_id)).toEqual([HQ, BRANCH, SIBLING]);
    expect(forAdmin[0]).toEqual({ vendor_id: HQ, name: `VN ${HQ}`, relationship: "PRINCIPAL", org_id: ORG });

    expect((await listActableEntities(await userRow(HQ))).map((e) => e.vendor_id)).toEqual([HQ, BRANCH, SIBLING]);
    expect((await listActableEntities(await userRow(BRANCH))).map((e) => e.vendor_id)).toEqual([BRANCH]);
    expect(await listActableEntities(await userRow(LONE))).toEqual([
      { vendor_id: LONE, name: `VN ${LONE}`, relationship: null, org_id: null },
    ]);
  });
});

describe("subscription holder helpers", () => {
  it("subscriptionHolderIdsFor returns the ACTIVE entities of the org, or [self]", async () => {
    await world();
    expect(await subscriptionHolderIdsFor(BRANCH)).toEqual([HQ, BRANCH, SIBLING]);
    expect(await subscriptionHolderIdsFor(HQ)).toEqual([HQ, BRANCH, SIBLING]);
    expect(await subscriptionHolderIdsFor(LONE)).toEqual([LONE]);
  });

  it("subscriptionHolderIdsFor skips siblings whose login is deleted or inactive", async () => {
    await world();
    await db.none(`UPDATE tbl_users SET is_deleted = 1 WHERE id = $1`, [SIBLING]);
    expect(await subscriptionHolderIdsFor(BRANCH)).toEqual([HQ, BRANCH]);
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [BRANCH]);
    expect(await subscriptionHolderIdsFor(HQ)).toEqual([HQ]);
  });

  it("collapseToPrincipals collapses only ACTIVE/SUSPENDED entities and drops invalid ids", async () => {
    await world();
    const INVITED = 95108;
    const REMOVED = 95109;
    await entity(INVITED);
    await entity(REMOVED);
    await addEntity({ orgId: ORG, vendorId: INVITED, status: "INVITED", withSeat: false });
    await addEntity({ orgId: ORG, vendorId: REMOVED, status: "REMOVED", withSeat: false });
    expect(await collapseToPrincipals([INVITED, REMOVED, SUSPENDED_BRANCH])).toEqual([HQ, INVITED, REMOVED]);
    expect(await collapseToPrincipals(["abc", "1e5", 1.5, -1, null, String(BRANCH)])).toEqual([HQ]);
    expect(await collapseToPrincipals(["abc"])).toEqual([]);
  });

  it("collapseToPrincipals maps live org entities to their principal, distinct and sorted", async () => {
    await world();
    expect(await collapseToPrincipals([BRANCH, LONE, HQ])).toEqual([HQ, LONE]);
    expect(await collapseToPrincipals([SUSPENDED_BRANCH, OTHER_HQ])).toEqual([HQ, OTHER_HQ]);
    expect(await collapseToPrincipals([])).toEqual([]);
  });

  it("entityCanOperate: principal and lone vendors always; members need ACTIVE + seat unless fee is 0", async () => {
    await world();
    const UNSEATED = 95107;
    await entity(UNSEATED);
    await addEntity({ orgId: ORG, vendorId: UNSEATED, withSeat: false });

    process.env.NETWORK_SEAT_FEE_INR = "0";
    expect(await entityCanOperate(UNSEATED)).toEqual({ ok: true });

    process.env.NETWORK_SEAT_FEE_INR = "500";
    expect(await entityCanOperate(UNSEATED)).toEqual({ ok: false, reason: "NO_SEAT" });
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: true }); // seeded active seat
    expect(await entityCanOperate(HQ)).toEqual({ ok: true });
    expect(await entityCanOperate(LONE)).toEqual({ ok: true });
    expect(await entityCanOperate(SUSPENDED_BRANCH)).toEqual({ ok: false, reason: "NOT_ACTIVE" });

    // an expired seat does not count
    await db.none(
      `UPDATE tbl_vendor_network_seats SET end_date = CURRENT_DATE - 1 WHERE entity_vendor_id = $1`,
      [BRANCH]
    );
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: false, reason: "NO_SEAT" });
  });
});

describe("vendorNetworkModel", () => {
  it("reads orgs, entities, memberships and seats", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member@test.local", name: "Mo Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });

    expect(await vnModel.getOrgByEntity(BRANCH)).toMatchObject({
      org_id: ORG, org_name: "VN Org", principal_vendor_id: HQ, relationship: "BRANCH", entity_status: "ACTIVE",
    });
    expect(await vnModel.getOrgByEntity(LONE)).toBeNull();
    expect(await vnModel.getOrgById(ORG)).toMatchObject({ id: ORG, principal_vendor_id: HQ });
    expect(await vnModel.getEntity(ORG, SIBLING)).toMatchObject({ vendor_id: SIBLING, relationship: "DISTRIBUTOR" });
    expect(await vnModel.getEntity(OTHER_ORG, SIBLING)).toBeNull();
    expect((await vnModel.listEntities(ORG)).map((e) => e.vendor_id)).toEqual([HQ, BRANCH, SUSPENDED_BRANCH, SIBLING]);
    expect(await vnModel.getActiveMemberships(MEMBER_PERSON)).toEqual([
      expect.objectContaining({ org_id: ORG, entity_vendor_id: BRANCH, role: "ENTITY_MEMBER" }),
    ]);
    expect(await vnModel.getActiveSeat(BRANCH)).toMatchObject({ org_id: ORG, status: "active" });
    expect(await vnModel.getActiveSeat(HQ)).toBeNull();
  });
});
