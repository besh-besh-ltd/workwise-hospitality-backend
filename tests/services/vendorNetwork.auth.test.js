// Vendor Networks auth integration (spec §4.1-§4.3, §10.1-§10.3, §10.10).
// The JWT `ent` claim, jwtUsr acting-entity resolution, member login,
// audit attribution, get-profile's network block and POST switch-entity.
// Pattern B: committed fixtures (ids 95001..95999), removed in afterEach.

import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";
import passport from "../../app/middleware/passport.js";
import requestContext, { resolveActor, ACTOR_TYPES } from "../../app/middleware/requestContext.js";
import { getActorUserId } from "../../app/util/requestContext.js";
import { resolveActingContext } from "../../app/services/vendorNetwork/actingContext.js";
import { requireOrgAdmin, requireNetwork } from "../../app/services/vendorNetwork/guards.js";
import { db, closeDb } from "../setup/db.js";
import { buildTestApp } from "../setup/app.js";
import { httpClient } from "../helpers/http.js";
import { loginAs } from "../helpers/auth.js";
import { countQueries } from "../helpers/queryCounter.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";

const LONE = 95301;
const HQ = 95302;
const BRANCH = 95303;
const FOREIGN_HQ = 95304;
const NOPW_BRANCH = 95305;
const ADMIN_PERSON = 95401;
const MEMBER_PERSON = 95402;
const INVITED_PERSON = 95403;
const BUYER = 95501;
const ORG = 95301;
const FOREIGN_ORG = 95302;

const PASSWORD = "Secret@123";
const UA = "jest-test-agent";
const cryptr = new Cryptr(Config.cryptR.secret);

const PROFILE = "/api/v1/users/get-profile";
const SWITCH = "/api/v1/vendor-network/switch-entity";

async function entity(id, extra = {}) {
  await seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com`, ...extra });
}

/** LONE (no org); ORG = HQ + ACTIVE BRANCH + NOPW_BRANCH; FOREIGN_ORG = FOREIGN_HQ; two type-11 people. */
async function world() {
  for (const id of [LONE, HQ, BRANCH, FOREIGN_HQ]) await entity(id);
  await entity(NOPW_BRANCH); // password NULL: created by an admin, never logged into directly
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN Auth Org" });
  await addEntity({ orgId: ORG, vendorId: BRANCH });
  await addEntity({ orgId: ORG, vendorId: NOPW_BRANCH });
  await seedOrg({ id: FOREIGN_ORG, principalVendorId: FOREIGN_HQ, name: "Foreign Org" });
  await seedPerson({ id: ADMIN_PERSON, email: "vn-admin-person@example.com", name: "Asha Admin" });
  await seedPerson({ id: MEMBER_PERSON, email: "vn-member-person@example.com", name: "Manoj Member" });
  await addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });
  await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
}

async function setPassword(userId, plain = PASSWORD) {
  await db.none(`UPDATE tbl_users SET password = $2 WHERE id = $1`, [userId, bcrypt.hashSync(plain, 4)]);
}

/** Minimal app echoing req.user after the real jwtUsr strategy. */
function whoamiApp() {
  const app = express();
  app.use(requestContext);
  app.get("/whoami", passport.authenticate("jwtUsr", { session: false }), (req, res) =>
    res.json({ keys: Object.keys(req.user), user: req.user, actorId: getActorUserId() })
  );
  return app;
}

async function whoami(userId, opts) {
  const { headers } = await loginAs(userId, opts);
  return request(whoamiApp()).get("/whoami").set(headers);
}

async function withToken(method, path, token) {
  const app = await buildTestApp();
  return request(app)[method](path).set({ Authorization: `Bearer ${token}`, "User-Agent": UA });
}

afterEach(async () => {
  await cleanupVendorNetworkFixtures();
});

// Release the harness pool so teardown's DROP DATABASE does not kill idle clients mid-log.
afterAll(closeDb);

describe("jwtUsr back-compat (§10.1)", () => {
  it("a no-org vendor's req.user is exactly its tbl_users row, with no network key", async () => {
    await world();
    const res = await whoami(LONE);
    expect(res.status).toBe(200);
    const row = await db.one(`SELECT * FROM tbl_users WHERE id = $1`, [LONE]);
    expect(res.body.keys).toEqual(Object.keys(row));
    expect(res.body.keys).not.toContain("network");
    expect(res.body.user.id).toBe(LONE);
  });

  it("a buyer takes today's path: identical row, one query, ent ignored", async () => {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, user_type, status) VALUES ($1, 'VN Buyer', 'vn-buyer@example.com', 2, 1)`,
      [BUYER]
    );
    const { headers } = await loginAs(BUYER, { ent: LONE });
    const app = whoamiApp();
    const { result: res, count } = await countQueries(() => request(app).get("/whoami").set(headers));
    expect(res.status).toBe(200);
    expect(count).toBe(1);
    const row = await db.one(`SELECT * FROM tbl_users WHERE id = $1`, [BUYER]);
    expect(res.body.keys).toEqual(Object.keys(row));
    expect(res.body.user.id).toBe(BUYER);
  });

  it("get-profile for a no-org vendor returns network: null; a vendor-scoped PO GET still works", async () => {
    await world();
    const client = await httpClient(LONE);
    const res = await client.get(PROFILE);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(LONE);
    expect(res.body.data.network).toBeNull();

    const po = await client.get("/api/v1/po/vendor/dashboard");
    expect(po.status).toBe(200);
  });

  it("a no-org vendor with its own id as ent acts as itself; any other ent is 401", async () => {
    await world();
    expect((await whoami(LONE, { ent: LONE })).status).toBe(200);
    expect((await whoami(LONE, { ent: BRANCH })).status).toBe(401);
  });
});

describe("type-11 person acting context (§4.1)", () => {
  it("an ORG_ADMIN person lands on the principal; network names the person", async () => {
    await world();
    const res = await (await httpClient(ADMIN_PERSON)).get(PROFILE);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(HQ);
    expect(res.body.data.network).toMatchObject({
      org_id: ORG,
      org_name: "VN Auth Org",
      role: "ORG_ADMIN",
      actor_user_id: ADMIN_PERSON,
      actor_name: "Asha Admin",
      acting_entity_id: HQ,
      is_principal: true,
    });
    const ids = res.body.data.network.actable_entities.map((e) => e.vendor_id).sort();
    expect(ids).toEqual([HQ, BRANCH, NOPW_BRANCH].sort());
  });

  it("an ent naming an entity the person holds no membership for is 401", async () => {
    await world();
    expect((await whoami(MEMBER_PERSON, { ent: HQ })).status).toBe(401);
    expect((await whoami(ADMIN_PERSON, { ent: FOREIGN_HQ })).status).toBe(401);
    expect((await whoami(MEMBER_PERSON, { ent: BRANCH })).status).toBe(200);
  });

  it("a type-11 person can never run as itself", async () => {
    await world();
    expect((await whoami(ADMIN_PERSON, { ent: ADMIN_PERSON })).status).toBe(401);
  });

  it("an ent beyond int4 is 401, not a 500", async () => {
    await world();
    expect((await whoami(HQ, { ent: "99999999999" })).status).toBe(401);
    expect((await whoami(ADMIN_PERSON, { ent: "2147483648" })).status).toBe(401);
  });

  it("an undecryptable ent is 401", async () => {
    await world();
    await loginAs(HQ); // stamp user_agent
    const now = Math.round(Date.now() / 1000);
    const token = JWT.sign(
      {
        iss: "Des Technico",
        sub: cryptr.encrypt(String(HQ)),
        user: true,
        ag: cryptr.encrypt(UA),
        ent: "not-a-ciphertext",
        iat: now,
        exp: now + 600,
      },
      Config.jwt.secret
    );
    const res = await request(whoamiApp()).get("/whoami").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("revocation takes effect on the next request", async () => {
    await world();
    const client = await httpClient(MEMBER_PERSON, { ent: BRANCH });
    expect((await client.get(PROFILE)).status).toBe(200);
    await db.none(
      `UPDATE tbl_vendor_org_members SET status = 'DISABLED' WHERE person_user_id = $1`,
      [MEMBER_PERSON]
    );
    expect((await client.get(PROFILE)).status).toBe(401);
  });

  it("a person carries the person's ag check, not the entity's", async () => {
    await world();
    const client = await httpClient(ADMIN_PERSON);
    await db.none(`UPDATE tbl_users SET user_agent = 'someone-else' WHERE id = $1`, [ADMIN_PERSON]);
    expect((await client.get(PROFILE)).status).toBe(401);
  });
});

describe("principal login (§4.1 table)", () => {
  it("principal without ent acts as self with ORG_ADMIN", async () => {
    await world();
    const res = await (await httpClient(HQ)).get(PROFILE);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(HQ);
    expect(res.body.data.network).toMatchObject({
      org_id: ORG,
      role: "ORG_ADMIN",
      actor_user_id: HQ,
      acting_entity_id: HQ,
      is_principal: true,
    });
  });
});

describe("POST /vendor-network/switch-entity", () => {
  it("switching to an ACTIVE branch returns a token that acts as the branch", async () => {
    await world();
    const res = await (await httpClient(HQ)).post(SWITCH).send({ entity_vendor_id: BRANCH });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.acting_entity_id).toBe(BRANCH);

    const profile = await withToken("get", PROFILE, res.body.data.token);
    expect(profile.status).toBe(200);
    expect(profile.body.data.id).toBe(BRANCH);
    expect(profile.body.data.network).toMatchObject({ actor_user_id: HQ, acting_entity_id: BRANCH, is_principal: false });
  });

  it("a type-11 admin switches from the branch back to the principal (recomputed from the person)", async () => {
    await world();
    const first = await (await httpClient(ADMIN_PERSON, { ent: BRANCH })).post(SWITCH).send({ entity_vendor_id: HQ });
    expect(first.status).toBe(200);
    const profile = await withToken("get", PROFILE, first.body.data.token);
    expect(profile.body.data.id).toBe(HQ);
    expect(profile.body.data.network.actor_user_id).toBe(ADMIN_PERSON);
  });

  it("a foreign entity is 403", async () => {
    await world();
    const res = await (await httpClient(HQ)).post(SWITCH).send({ entity_vendor_id: FOREIGN_HQ });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 0, message: "You cannot act for this entity" });

    const member = await (await httpClient(MEMBER_PERSON)).post(SWITCH).send({ entity_vendor_id: HQ });
    expect(member.status).toBe(403);
  });

  it("a no-org vendor cannot switch to another vendor", async () => {
    await world();
    const res = await (await httpClient(LONE)).post(SWITCH).send({ entity_vendor_id: BRANCH });
    expect(res.status).toBe(403);
  });

  it("a missing or malformed entity_vendor_id is 400", async () => {
    await world();
    const client = await httpClient(HQ);
    expect((await client.post(SWITCH).send({})).status).toBe(400);
    expect((await client.post(SWITCH).send({ entity_vendor_id: "1e5" })).status).toBe(400);
  });

  it("a buyer is refused by the role gate", async () => {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, user_type, status) VALUES ($1, 'VN Buyer', 'vn-buyer@example.com', 2, 1)`,
      [BUYER]
    );
    const res = await (await httpClient(BUYER)).post(SWITCH).send({ entity_vendor_id: HQ });
    expect(res.status).toBe(403);
  });
});

describe("audit attribution (§4.3, §10.10)", () => {
  it("resolveActor names the person acting for an entity", async () => {
    await world();
    const person = await db.one(`SELECT * FROM tbl_users WHERE id = $1`, [ADMIN_PERSON]);
    const ctx = await resolveActingContext(person, BRANCH);
    const actor = resolveActor({ user: { ...ctx.entityRow, network: ctx.network } });
    expect(actor).toEqual({
      actorType: ACTOR_TYPES.VENDOR,
      actorUserId: ADMIN_PERSON,
      actorLabel: `Asha Admin (VN ${BRANCH})`,
    });
  });

  it("a principal acting as itself is attributed exactly as today", async () => {
    await world();
    const row = await db.one(`SELECT * FROM tbl_users WHERE id = $1`, [HQ]);
    const ctx = await resolveActingContext(row, null);
    expect(resolveActor({ user: { ...ctx.entityRow, network: ctx.network } })).toEqual(resolveActor({ user: row }));
  });

  it("app.actor_id (getActorUserId) records the person, not the entity", async () => {
    await world();
    const res = await whoami(ADMIN_PERSON, { ent: BRANCH });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(BRANCH);
    expect(res.body.actorId).toBe(ADMIN_PERSON);
  });
});

describe("login (§4.2)", () => {
  const login = async (email, password = PASSWORD) => {
    const app = await buildTestApp();
    return request(app).post("/api/v1/users/login?conform=true").set("User-Agent", UA).send({ email, password });
  };

  it("a type-11 person logs in by email and the token resolves to the principal", async () => {
    await world();
    await setPassword(ADMIN_PERSON);
    const res = await login("vn-admin-person@example.com");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(Number(res.body.user_detail[0].user_type)).toBe(11);

    const profile = await withToken("get", PROFILE, res.body.token);
    expect(profile.status).toBe(200);
    expect(profile.body.data.id).toBe(HQ);
    expect(profile.body.data.network.actor_user_id).toBe(ADMIN_PERSON);
  });

  it("an INVITED (status 0) person gets the inactive-account message, never the subscription flow", async () => {
    await world();
    await seedPerson({ id: INVITED_PERSON, email: "vn-invited@example.com", name: "Ira Invited", status: 0 });
    await setPassword(INVITED_PERSON);
    const res = await login("vn-invited@example.com");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 2, message: "User not approved by admin" });
  });

  it("an entity row with no password fails as invalid credentials", async () => {
    await world();
    const res = await login(`vn-${NOPW_BRANCH}@example.com`);
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.token).toBeUndefined();
  });

  it("a malformed stored hash fails as invalid credentials, never crashes", async () => {
    await world();
    await db.none(`UPDATE tbl_users SET password = 'not-a-bcrypt-hash' WHERE id = $1`, [ADMIN_PERSON]);
    const res = await login("vn-admin-person@example.com");
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.token).toBeUndefined();
  });
});

describe("guards", () => {
  const denied = (message) => ({ http: 403, body: { status: 0, message } });

  it("requireOrgAdmin passes only an ORG_ADMIN network", () => {
    expect(requireOrgAdmin({ user: { id: HQ, network: { role: "ORG_ADMIN" } } })).toBeNull();
    expect(requireOrgAdmin({ user: { id: BRANCH, network: { role: "ENTITY_MEMBER" } } })).toEqual(
      denied("Network admin access required")
    );
    expect(requireOrgAdmin({ user: { id: LONE } })).toEqual(denied("Network admin access required"));
  });

  it("requireNetwork passes any network role and refuses a no-org vendor", () => {
    expect(requireNetwork({ user: { id: BRANCH, network: { role: "ENTITY_MEMBER" } } })).toBeNull();
    expect(requireNetwork({ user: { id: LONE } })).toEqual(denied("Vendor network access required"));
  });
});
