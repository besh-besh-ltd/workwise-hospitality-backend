// Vendor Networks people API (spec §5 "People", §4.2, §10.3, §10.5): inviting
// type-11 persons, the public accept page, role/entity changes, disable/enable,
// resend and the NETWORK_MAX_PERSONS cap. One `describe` per rule of task 5.
// Pattern B: committed fixtures (ids 95801..95899), removed in afterEach.
//
// Two boundaries are observed, not replaced in behaviour:
//   - SMTP: nodemailer.createTransport is swapped for a recorder (the raw invite
//     token exists only in the email, so the test reads it from there)
//   - app/util/socket.js: disconnectPersonSockets is recorded (no live socket server)

import { jest } from "@jest/globals";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import request from "supertest";
import { db, closeDb } from "../setup/db.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
  moveApiSequencesPastFixtures,
} from "../helpers/vendorNetworkSeed.js";

const disconnected = [];
jest.unstable_mockModule("../../app/util/socket.js", () => ({
  resolveSocketIdentity: async () => null,
  resolveSocketUserId: async () => null,
  resolveSocketUserRoom: async () => null,
  disconnectPersonSockets: (personId) => {
    disconnected.push(Number(personId));
    return 0;
  },
  getIo: () => null,
  emitToCompany: () => {},
  emitToUser: () => {},
  SocketConfig: () => null,
}));

const { httpClient } = await import("../helpers/http.js");
const { loginAsInternalStaff } = await import("../helpers/auth.js");
const { buildTestApp } = await import("../setup/app.js");

const HQ = 95801; // principal of ORG
const BRANCH = 95802; // ACTIVE BRANCH of ORG
const BRANCH2 = 95803; // ACTIVE BRANCH of ORG
const FOREIGN_HQ = 95804; // principal of FOREIGN_ORG
const FOREIGN_BRANCH = 95805; // BRANCH of FOREIGN_ORG
const LONE = 95806; // vendor in no org
const ADMIN_PERSON = 95807; // type 11, ORG_ADMIN of ORG
const MEMBER_PERSON = 95808; // type 11, ENTITY_MEMBER of BRANCH
const FOREIGN_PERSON = 95809; // type 11, ENTITY_MEMBER of FOREIGN_BRANCH
const BUYER = 95810; // a non-vendor user holding an email
const ORG = 95801;
const FOREIGN_ORG = 95802;

const BASE = "/api/v1/vendor-network";
const UA = "jest-test-agent";
const PASSWORD = "Secret123";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function entity(id) {
  await seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com` });
}

async function world() {
  for (const id of [HQ, BRANCH, BRANCH2, FOREIGN_HQ, FOREIGN_BRANCH, LONE]) await entity(id);
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN People Org" });
  await addEntity({ orgId: ORG, vendorId: BRANCH });
  await addEntity({ orgId: ORG, vendorId: BRANCH2 });
  await seedOrg({ id: FOREIGN_ORG, principalVendorId: FOREIGN_HQ, name: "Foreign Org" });
  await addEntity({ orgId: FOREIGN_ORG, vendorId: FOREIGN_BRANCH });
  await seedPerson({ id: ADMIN_PERSON, email: "vn-admin-p@example.com", name: "Ada Admin" });
  await addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });
  await seedPerson({ id: MEMBER_PERSON, email: "vn-member-p@example.com", name: "Mo Member" });
  await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
  await seedPerson({ id: FOREIGN_PERSON, email: "vn-foreign-p@example.com", name: "Fay Foreign" });
  await addMember({ orgId: FOREIGN_ORG, personId: FOREIGN_PERSON, entityVendorId: FOREIGN_BRANCH, role: "ENTITY_MEMBER" });
  await db.none(
    `INSERT INTO tbl_users (id, name, email, user_type, status) VALUES ($1, 'Buyer B', 'VN-Buyer@Example.com', 2, 1)`,
    [BUYER]
  );
}

// --- SMTP recorder -----------------------------------------------------------
const sent = [];
let stubTransport;
beforeAll(async () => {
  await moveApiSequencesPastFixtures();
  stubTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(mail, cb) {
      sent.push(mail);
      const info = { messageId: "<vn-members>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
});

const savedMax = process.env.NETWORK_MAX_PERSONS;
beforeEach(() => {
  sent.length = 0;
  disconnected.length = 0;
  delete process.env.NETWORK_MAX_PERSONS;
});

afterEach(async () => {
  if (savedMax === undefined) delete process.env.NETWORK_MAX_PERSONS;
  else process.env.NETWORK_MAX_PERSONS = savedMax;
  await cleanupVendorNetworkFixtures();
});

afterAll(async () => {
  nodemailer.createTransport = stubTransport;
  await closeDb();
});

/** sendMail is fire-and-forget after the response; wait for the mail to `to`. */
async function mailTo(to) {
  for (let i = 0; i < 50; i += 1) {
    const mail = sent.find((m) => String(m.to).toLowerCase() === to.toLowerCase());
    if (mail) return mail;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const tokenIn = (mail) => {
  const m = /accept-invite\?token=([0-9a-f]+)/.exec(mail?.html ?? "");
  return m ? m[1] : null;
};

const membersOf = (personId) =>
  db.any(`SELECT * FROM tbl_vendor_org_members WHERE person_user_id = $1 ORDER BY id`, [personId]);

async function invite(body, as = HQ) {
  const admin = await httpClient(as);
  return admin.post(`${BASE}/members`).send(body);
}

async function publicApp() {
  return request(await buildTestApp());
}

async function accept(token, password = PASSWORD) {
  return (await publicApp()).post(`${BASE}/member-invites/accept`).send({ token, password });
}

async function login(email, password = PASSWORD) {
  return (await publicApp())
    .post("/api/v1/users/login?conform=true")
    .set("User-Agent", UA)
    .send({ email, password });
}

/** Invites a new person and returns { res, token, user }. */
async function inviteNew(email, extra = { role: "ENTITY_MEMBER", entity_vendor_id: BRANCH }) {
  const res = await invite({ email, name: "New Person", ...extra });
  const token = tokenIn(await mailTo(email));
  const user = await db.oneOrNone(`SELECT * FROM tbl_users WHERE lower(email) = lower($1)`, [email]);
  return { res, token, user };
}

describe("rule 1: admin only; the entity is a target verified against the caller's org", () => {
  it("non-admins and no-org vendors are refused on every management route", async () => {
    await world();
    for (const [who, opts] of [[MEMBER_PERSON, {}], [BRANCH, {}], [LONE, {}]]) {
      const c = await httpClient(who, opts);
      expect((await c.get(`${BASE}/members`)).status).toBe(403);
      expect((await c.post(`${BASE}/members`).send({ email: "x@example.com", name: "X", role: "ORG_ADMIN" })).status).toBe(403);
      expect((await c.patch(`${BASE}/members/1`).send({ status: "DISABLED" })).status).toBe(403);
      expect((await c.post(`${BASE}/members/1/resend`)).status).toBe(403);
    }
    expect(await db.oneOrNone(`SELECT id FROM tbl_users WHERE email = 'x@example.com'`)).toBeNull();
  });

  it("ENTITY_MEMBER needs a live entity of the caller's org; ORG_ADMIN takes none", async () => {
    await world();
    const missing = await invite({ email: "e1@example.com", name: "E1", role: "ENTITY_MEMBER" });
    expect(missing.status).toBe(400);
    const foreign = await invite({ email: "e1@example.com", name: "E1", role: "ENTITY_MEMBER", entity_vendor_id: FOREIGN_BRANCH });
    expect(foreign.status).toBe(404);
    const noOrg = await invite({ email: "e1@example.com", name: "E1", role: "ENTITY_MEMBER", entity_vendor_id: LONE });
    expect(noOrg.status).toBe(404);
    const adminWithEntity = await invite({ email: "e1@example.com", name: "E1", role: "ORG_ADMIN", entity_vendor_id: BRANCH });
    expect(adminWithEntity.status).toBe(400);
    const badRole = await invite({ email: "e1@example.com", name: "E1", role: "OWNER" });
    expect(badRole.status).toBe(400);
    expect(await db.oneOrNone(`SELECT id FROM tbl_users WHERE email = 'e1@example.com'`)).toBeNull();

    // A type-11 ORG_ADMIN person (acting for a branch) may manage people.
    const byPerson = await (await httpClient(ADMIN_PERSON, { ent: BRANCH }))
      .post(`${BASE}/members`)
      .send({ email: "e2@example.com", name: "E2", role: "ORG_ADMIN" });
    expect(byPerson.status).toBe(201);
    const row = await db.one(`SELECT m.* FROM tbl_vendor_org_members m JOIN tbl_users u ON u.id = m.person_user_id WHERE u.email = 'e2@example.com'`);
    expect(row).toMatchObject({ org_id: ORG, role: "ORG_ADMIN", entity_vendor_id: null, invited_by: ADMIN_PERSON });
  });

  it("GET /members lists the org's people, disabled included, never another org's", async () => {
    await world();
    await seedPerson({ id: 95811, email: "vn-off@example.com", name: "Off" });
    await addMember({ orgId: ORG, personId: 95811, entityVendorId: BRANCH2, role: "ENTITY_MEMBER", status: "DISABLED" });
    const res = await (await httpClient(HQ)).get(`${BASE}/members`);
    expect(res.status).toBe(200);
    const people = res.body.data.map((m) => m.person_user_id).sort();
    expect(people).toEqual([HQ, ADMIN_PERSON, MEMBER_PERSON, 95811].sort());
    const member = res.body.data.find((m) => m.person_user_id === MEMBER_PERSON);
    expect(member).toMatchObject({ role: "ENTITY_MEMBER", entity_vendor_id: BRANCH, entity_name: `VN ${BRANCH}`, status: "ACTIVE", email: "vn-member-p@example.com" });
    expect(JSON.stringify(res.body)).not.toMatch(/invite_token_hash|password/);
  });
});

describe("rule 2: a new email creates an INVITED type-11 person and emails a hashed token", () => {
  it("creates user + INVITED membership with a sha256 hash, 72h expiry, and emails the raw token only", async () => {
    await world();
    const { res, token, user } = await inviteNew("New.Person@Example.com");
    expect(res.status).toBe(201);
    expect(user).toMatchObject({ user_type: 11, status: 0, company_id: null, name: "New Person", password: null });
    expect(user.email).toBe("new.person@example.com");

    const [m] = await membersOf(user.id);
    expect(m).toMatchObject({ org_id: ORG, entity_vendor_id: BRANCH, role: "ENTITY_MEMBER", status: "INVITED", invited_by: HQ });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(m.invite_token_hash).toBe(sha256(token));
    const hours = (new Date(m.invite_expires_at) - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);

    const mail = await mailTo("new.person@example.com");
    expect(mail.html).toContain(`/vendor/network/accept-invite?token=${token}`);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(res.body.data).toMatchObject({ id: m.id, person_user_id: user.id, status: "INVITED" });
  });

  it("an email already in tbl_users (any type, any case) is 409 EMAIL_EXISTS and creates nothing", async () => {
    await world();
    for (const email of ["vn-buyer@example.com", `VN-${BRANCH}@example.com`]) {
      const res = await invite({ email, name: "Dup", role: "ORG_ADMIN" });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("EMAIL_EXISTS");
    }
    expect(await membersOf(BUYER)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("rule 3: an existing person of the same org gains a membership; another org's is refused", () => {
  it("adds a second entity to an ACTIVE same-org person with no invite, and refuses a duplicate", async () => {
    await world();
    const res = await invite({ email: "VN-MEMBER-P@example.com", name: "ignored", role: "ENTITY_MEMBER", entity_vendor_id: BRANCH2 });
    expect(res.status).toBe(201);
    const rows = await membersOf(MEMBER_PERSON);
    expect(rows.map((r) => [r.entity_vendor_id, r.status])).toEqual([[BRANCH, "ACTIVE"], [BRANCH2, "ACTIVE"]]);
    expect(rows[1].invite_token_hash).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([]);

    const dup = await invite({ email: "vn-member-p@example.com", name: "x", role: "ENTITY_MEMBER", entity_vendor_id: BRANCH2 });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe("ALREADY_MEMBER");
  });

  it("a still-INVITED person's extra membership waits for the same invite, and accept activates both", async () => {
    await world();
    const { token, user } = await inviteNew("pending@example.com");
    sent.length = 0;
    const second = await invite({ email: "pending@example.com", name: "x", role: "ENTITY_MEMBER", entity_vendor_id: BRANCH2 });
    expect(second.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([]);
    expect((await membersOf(user.id)).map((r) => r.status)).toEqual(["INVITED", "INVITED"]);

    expect((await accept(token)).status).toBe(200);
    expect((await membersOf(user.id)).map((r) => r.status)).toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("a person of another org is 409 PERSON_IN_OTHER_ORG", async () => {
    await world();
    const res = await invite({ email: "vn-foreign-p@example.com", name: "x", role: "ENTITY_MEMBER", entity_vendor_id: BRANCH });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("PERSON_IN_OTHER_ORG");
    expect(await membersOf(FOREIGN_PERSON)).toHaveLength(1);
  });
});

describe("rule 4: NETWORK_MAX_PERSONS caps non-DISABLED distinct persons (read at call time)", () => {
  it("refuses a new person at the cap, ignores disabled ones, and still allows another entity for a counted person", async () => {
    await world(); // persons in ORG: HQ, ADMIN_PERSON, MEMBER_PERSON
    process.env.NETWORK_MAX_PERSONS = "3";
    const over = await invite({ email: "cap@example.com", name: "Cap", role: "ORG_ADMIN" });
    expect(over.status).toBe(409);
    expect(over.body.reason).toBe("PERSON_LIMIT");
    expect(await db.oneOrNone(`SELECT id FROM tbl_users WHERE email = 'cap@example.com'`)).toBeNull();

    const extra = await invite({ email: "vn-member-p@example.com", name: "x", role: "ENTITY_MEMBER", entity_vendor_id: BRANCH2 });
    expect(extra.status).toBe(201);

    await db.none(`UPDATE tbl_vendor_org_members SET status = 'DISABLED' WHERE person_user_id = $1`, [ADMIN_PERSON]);
    const room = await invite({ email: "cap@example.com", name: "Cap", role: "ORG_ADMIN" });
    expect(room.status).toBe(201);

    process.env.NETWORK_MAX_PERSONS = "10";
    expect((await invite({ email: "cap2@example.com", name: "Cap2", role: "ORG_ADMIN" })).status).toBe(201);
  });

  it("re-enabling a disabled person is held to the cap too", async () => {
    await world();
    const m = (await membersOf(MEMBER_PERSON))[0];
    await db.none(`UPDATE tbl_vendor_org_members SET status = 'DISABLED' WHERE id = $1`, [m.id]);
    process.env.NETWORK_MAX_PERSONS = "2"; // HQ + ADMIN_PERSON
    const res = await (await httpClient(HQ)).patch(`${BASE}/members/${m.id}`).send({ status: "ACTIVE" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("PERSON_LIMIT");
  });
});

describe("rule 5: accept (public)", () => {
  it("previews the invite with only email, org, entity and expired", async () => {
    await world();
    const { token } = await inviteNew("preview@example.com");
    const res = await (await publicApp()).get(`${BASE}/member-invites/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ email: "preview@example.com", org_name: "VN People Org", entity_name: `VN ${BRANCH}`, expired: false });

    expect((await (await publicApp()).get(`${BASE}/member-invites/${"0".repeat(64)}`)).status).toBe(410);
    await db.none(`UPDATE tbl_vendor_org_members SET invite_expires_at = now() - interval '1 minute' WHERE invite_token_hash = $1`, [sha256(token)]);
    const expired = await (await publicApp()).get(`${BASE}/member-invites/${token}`);
    expect(expired.status).toBe(200);
    expect(expired.body.data.expired).toBe(true);
  });

  it("sets a bcrypt password, activates the person and every INVITED membership; the person can log in", async () => {
    await world();
    const { token, user } = await inviteNew("joiner@example.com");
    for (const weak of ["short1", "allletters", "1234567890"]) {
      const res = await accept(token, weak);
      expect(res.status).toBe(400);
    }
    expect((await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [user.id])).status).toBe(0);

    const res = await accept(token);
    expect(res.status).toBe(200);
    const after = await db.one(`SELECT status, password FROM tbl_users WHERE id = $1`, [user.id]);
    expect(after.status).toBe(1);
    expect(after.password).toMatch(/^\$2[aby]\$10\$/);
    expect(bcrypt.compareSync(PASSWORD, after.password)).toBe(true);
    const [m] = await membersOf(user.id);
    expect(m).toMatchObject({ status: "ACTIVE", invite_token_hash: null });

    const signedIn = await login("joiner@example.com");
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.status).toBe(1);
  });

  it("reused, unknown and expired tokens are 410", async () => {
    await world();
    const { token } = await inviteNew("once@example.com");
    expect((await accept(token)).status).toBe(200);
    expect((await accept(token)).status).toBe(410);
    expect((await accept("f".repeat(64))).status).toBe(410);

    const second = await inviteNew("late@example.com");
    await db.none(`UPDATE tbl_vendor_org_members SET invite_expires_at = now() - interval '1 minute' WHERE person_user_id = $1`, [second.user.id]);
    expect((await accept(second.token)).status).toBe(410);
    expect((await db.one(`SELECT status, password FROM tbl_users WHERE id = $1`, [second.user.id]))).toEqual({ status: 0, password: null });
  });
});

describe("rule 5: accept edge cases", () => {
  it("a double accept of one token at once: exactly one 200, one 410", async () => {
    await world();
    const { token, user } = await inviteNew("race@example.com");
    const results = await Promise.all([accept(token), accept(token, "Other4567")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const row = await db.one(`SELECT status, password FROM tbl_users WHERE id = $1`, [user.id]);
    const winner = results[0].status === 200 ? PASSWORD : "Other4567";
    expect(row.status).toBe(1);
    expect(bcrypt.compareSync(winner, row.password)).toBe(true);
  });

  it("a deleted or non-INVITED (status 0) person's token is 410 on preview and accept, writing nothing", async () => {
    await world();
    const { token, user } = await inviteNew("gone@example.com");
    await db.none(`UPDATE tbl_users SET is_deleted = 1 WHERE id = $1`, [user.id]);
    expect((await (await publicApp()).get(`${BASE}/member-invites/${token}`)).status).toBe(410);
    expect((await accept(token)).status).toBe(410);

    await db.none(`UPDATE tbl_users SET is_deleted = 0, status = 2 WHERE id = $1`, [user.id]);
    expect((await accept(token)).status).toBe(410);
    expect(await db.one(`SELECT status, password FROM tbl_users WHERE id = $1`, [user.id])).toEqual({ status: 2, password: null });
    expect((await membersOf(user.id))[0].status).toBe("INVITED");
  });

  it("removing the entity disables its INVITED memberships and kills their tokens", async () => {
    await world();
    const { token, user } = await inviteNew("orphan@example.com", { role: "ENTITY_MEMBER", entity_vendor_id: BRANCH2 });
    expect((await (await httpClient(HQ)).delete(`${BASE}/entities/${BRANCH2}`)).status).toBe(200);
    expect((await membersOf(user.id))[0]).toMatchObject({ status: "DISABLED", invite_token_hash: null, invite_expires_at: null });
    expect((await accept(token)).status).toBe(410);
  });
});

describe("an accepted person is never Workwise staff (admin console)", () => {
  async function acceptedPerson() {
    await world();
    const { token, user } = await inviteNew("staffish@example.com");
    expect((await accept(token)).status).toBe(200);
    return user;
  }

  it("cannot log in to the admin console", async () => {
    await acceptedPerson();
    const res = await (await publicApp())
      .post("/api/v1/admin/auth/login")
      .set("User-Agent", UA)
      .send({ username: "staffish@example.com", password: PASSWORD });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.token).toBeUndefined();
  });

  it("admin forgot-password writes no reset token for the person", async () => {
    const user = await acceptedPerson();
    const res = await (await publicApp()).post("/api/v1/admin/auth/forgot-password").send({ email: "staffish@example.com" });
    expect(res.status).toBe(200);
    expect(await db.one(`SELECT pwd_reset_token_hash FROM tbl_users WHERE id = $1`, [user.id])).toEqual({ pwd_reset_token_hash: null });
  });

  it("a forged admin JWT for the person (or a vendor) is 401 on admin routes", async () => {
    const user = await acceptedPerson();
    for (const id of [user.id, BRANCH]) {
      const { headers } = await loginAsInternalStaff(id);
      let req = (await publicApp()).get("/api/v1/admin/buyer/buyer-list");
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      expect((await req).status).toBe(401);
    }
  });
});

describe("rule 6: disable / enable / role and entity changes", () => {
  it("a disabled person's next request is 401 and their sockets are closed; enabling restores access", async () => {
    await world();
    const person = await httpClient(MEMBER_PERSON);
    expect((await person.get("/api/v1/users/get-profile")).status).toBe(200);
    const [m] = await membersOf(MEMBER_PERSON);

    const off = await (await httpClient(HQ)).patch(`${BASE}/members/${m.id}`).send({ status: "DISABLED" });
    expect(off.status).toBe(200);
    expect((await membersOf(MEMBER_PERSON))[0].status).toBe("DISABLED");
    expect((await person.get("/api/v1/users/get-profile")).status).toBe(401);
    expect(disconnected).toEqual([MEMBER_PERSON]);

    const on = await (await httpClient(HQ)).patch(`${BASE}/members/${m.id}`).send({ status: "ACTIVE" });
    expect(on.status).toBe(200);
    expect((await person.get("/api/v1/users/get-profile")).status).toBe(200);
  });

  it("disabling an INVITED person kills its token; enabling re-opens the invite with a new one, never ACTIVE without a password", async () => {
    await world();
    const { token: first, user } = await inviteNew("never@example.com");
    const [m] = await membersOf(user.id);
    const hq = await httpClient(HQ);
    expect((await hq.patch(`${BASE}/members/${m.id}`).send({ status: "DISABLED" })).status).toBe(200);
    expect((await membersOf(user.id))[0]).toMatchObject({ status: "DISABLED", invite_token_hash: null });
    expect((await accept(first)).status).toBe(410);

    sent.length = 0;
    const on = await hq.patch(`${BASE}/members/${m.id}`).send({ status: "ACTIVE" });
    expect(on.status).toBe(200);
    expect(on.body.data.status).toBe("INVITED");
    const second = tokenIn(await mailTo("never@example.com"));
    expect((await membersOf(user.id))[0].invite_token_hash).toBe(sha256(second));
    expect((await accept(second)).status).toBe(200);
  });

  it("ACTIVE on a still-INVITED membership is 409 INVITE_NOT_ACCEPTED (resend instead)", async () => {
    await world();
    const { user } = await inviteNew("notyet@example.com");
    const [m] = await membersOf(user.id);
    const res = await (await httpClient(HQ)).patch(`${BASE}/members/${m.id}`).send({ status: "ACTIVE" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("INVITE_NOT_ACCEPTED");
    expect((await membersOf(user.id))[0].status).toBe("INVITED");
  });

  it("two admins disabling each other at once: exactly one wins, the other is 400 LAST_ADMIN", async () => {
    await world();
    await db.none(`UPDATE tbl_vendor_org_members SET status = 'DISABLED' WHERE person_user_id = $1`, [HQ]);
    await seedPerson({ id: 95812, email: "vn-admin2@example.com", name: "Abe Admin" });
    await addMember({ orgId: ORG, personId: 95812, role: "ORG_ADMIN" });
    const [a] = await membersOf(ADMIN_PERSON);
    const [b] = await membersOf(95812);
    const clientA = await httpClient(ADMIN_PERSON);
    const clientB = await httpClient(95812);

    // Hold the org's people lock so both requests are past authentication and queued
    // on it before either decides; then release and let them race.
    const holder = await db.connect();
    let results;
    try {
      await holder.one(`SELECT pg_advisory_lock(hashtext('vn_members_org:' || $1))`, [ORG]);
      const pending = Promise.all([
        clientA.patch(`${BASE}/members/${b.id}`).send({ status: "DISABLED" }).then((r) => r),
        clientB.patch(`${BASE}/members/${a.id}`).send({ status: "DISABLED" }).then((r) => r),
      ]);
      let queued = 0;
      for (let i = 0; i < 200 && queued < 2; i += 1) {
        ({ n: queued } = await db.one(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
        ));
        if (queued < 2) await new Promise((r) => setTimeout(r, 20));
      }
      expect(queued).toBe(2);
      await holder.one(`SELECT pg_advisory_unlock(hashtext('vn_members_org:' || $1))`, [ORG]);
      results = await pending;
    } finally {
      holder.done();
    }
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400).body.reason).toBe("LAST_ADMIN");
    const active = await db.one(
      `SELECT count(*)::int AS n FROM tbl_vendor_org_members WHERE org_id = $1 AND role = 'ORG_ADMIN' AND status = 'ACTIVE'`,
      [ORG]
    );
    expect(active.n).toBe(1);
  });

  it("never disables or demotes the principal's own ORG_ADMIN membership", async () => {
    await world();
    const hqRow = (await membersOf(HQ))[0];
    const admin = await httpClient(ADMIN_PERSON);
    expect((await admin.patch(`${BASE}/members/${hqRow.id}`).send({ status: "DISABLED" })).status).toBe(400);
    expect((await admin.patch(`${BASE}/members/${hqRow.id}`).send({ role: "ENTITY_MEMBER", entity_vendor_id: BRANCH })).status).toBe(400);
    expect((await membersOf(HQ))[0]).toMatchObject({ status: "ACTIVE", role: "ORG_ADMIN" });
  });

  it("refuses to disable or demote the last ACTIVE ORG_ADMIN (400 LAST_ADMIN)", async () => {
    await world();
    // Legacy state: the principal's own admin membership is gone, ADMIN_PERSON is the only admin.
    await db.none(`UPDATE tbl_vendor_org_members SET status = 'DISABLED' WHERE person_user_id = $1`, [HQ]);
    const [m] = await membersOf(ADMIN_PERSON);
    const admin = await httpClient(ADMIN_PERSON);
    const off = await admin.patch(`${BASE}/members/${m.id}`).send({ status: "DISABLED" });
    expect(off.status).toBe(400);
    expect(off.body.reason).toBe("LAST_ADMIN");
    const demote = await admin.patch(`${BASE}/members/${m.id}`).send({ role: "ENTITY_MEMBER", entity_vendor_id: BRANCH });
    expect(demote.status).toBe(400);
    expect(demote.body.reason).toBe("LAST_ADMIN");
    expect((await membersOf(ADMIN_PERSON))[0]).toMatchObject({ status: "ACTIVE", role: "ORG_ADMIN" });
  });

  it("moves a member to another entity of the org, promotes to ORG_ADMIN, and refuses foreign targets", async () => {
    await world();
    const [m] = await membersOf(MEMBER_PERSON);
    const hq = await httpClient(HQ);
    const moved = await hq.patch(`${BASE}/members/${m.id}`).send({ entity_vendor_id: BRANCH2 });
    expect(moved.status).toBe(200);
    expect((await membersOf(MEMBER_PERSON))[0]).toMatchObject({ entity_vendor_id: BRANCH2, role: "ENTITY_MEMBER" });
    expect(disconnected).toEqual([MEMBER_PERSON]);

    expect((await hq.patch(`${BASE}/members/${m.id}`).send({ entity_vendor_id: FOREIGN_BRANCH })).status).toBe(404);
    const promoted = await hq.patch(`${BASE}/members/${m.id}`).send({ role: "ORG_ADMIN" });
    expect(promoted.status).toBe(200);
    expect((await membersOf(MEMBER_PERSON))[0]).toMatchObject({ entity_vendor_id: null, role: "ORG_ADMIN" });

    // Another org's membership id is not found.
    const [foreign] = await membersOf(FOREIGN_PERSON);
    expect((await hq.patch(`${BASE}/members/${foreign.id}`).send({ status: "DISABLED" })).status).toBe(404);
    expect((await membersOf(FOREIGN_PERSON))[0].status).toBe("ACTIVE");
  });
});

describe("rule 7: resend", () => {
  it("rotates an INVITED membership's token (old one 410) and refuses non-INVITED", async () => {
    await world();
    const { token: oldToken, user } = await inviteNew("again@example.com");
    const [m] = await membersOf(user.id);
    sent.length = 0;
    const hq = await httpClient(HQ);
    const res = await hq.post(`${BASE}/members/${m.id}/resend`);
    expect(res.status).toBe(200);
    const newToken = tokenIn(await mailTo("again@example.com"));
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
    expect((await membersOf(user.id))[0].invite_token_hash).toBe(sha256(newToken));

    expect((await accept(oldToken)).status).toBe(410);
    expect((await accept(newToken)).status).toBe(200);

    const active = (await membersOf(MEMBER_PERSON))[0];
    expect((await hq.post(`${BASE}/members/${active.id}/resend`)).status).toBe(409);
    const [foreign] = await membersOf(FOREIGN_PERSON);
    expect((await hq.post(`${BASE}/members/${foreign.id}/resend`)).status).toBe(404);
  });
});
