// Vendor Networks org and entity management API (spec §5, §5.1, §10.5, §10.6).
// One `it` per rule of task 4, each with its positive and negative halves:
// create network, suggestions, link invites (consent), create branch, suspend,
// remove/leave, settings, isolation and seats (incl. Razorpay order + HMAC verify).
// Pattern B: committed fixtures (ids 95601..95699), removed in afterEach.
//
// One module boundary is replaced before the app graph loads: the Razorpay SDK
// (orders.create is a network call to Razorpay). Suspend / remove / leave run the real
// routing engine: their effect is asserted on tbl_vendor_routing_assignments.

import { jest } from "@jest/globals";
import crypto from "crypto";
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

const razorpayOrders = [];
jest.unstable_mockModule("razorpay", () => ({
  default: class RazorpayStub {
    constructor(opts) {
      this.opts = opts;
      this.orders = {
        create: async (params) => {
          const order = { id: `order_vnseat_${razorpayOrders.length + 1}_${Date.now()}`, ...params, currency: "INR" };
          razorpayOrders.push(order);
          return order;
        },
      };
    }
  },
}));

const { httpClient } = await import("../helpers/http.js");
const { entityCanOperate } = await import("../../app/services/vendorNetwork/actingContext.js");
const { financialYearEnd } = await import("../../app/services/vendorNetwork/seats.js");
const { default: Config } = await import("../../app/config/app.config.js");

const LONE = 95601; // no-org vendor
const HQ = 95602; // principal of ORG
const BRANCH = 95603; // ACTIVE BRANCH of ORG
const TARGET = 95604; // no-org vendor, link target
const FOREIGN_HQ = 95605; // principal of FOREIGN_ORG
const FOREIGN_BRANCH = 95606; // BRANCH of FOREIGN_ORG
const INACTIVE = 95607; // status 0 vendor
const SAME_PAN = 95608; // shares HQ's PAN via GSTIN
const SAME_PAN_DOC = 95609; // shares HQ's PAN via a PAN document only
const OTHER_PAN = 95610;
const MEMBER_PERSON = 95611; // type 11, ENTITY_MEMBER of BRANCH
const ORG = 95601;
const FOREIGN_ORG = 95602;

// Every fixture vendor shares HQ's PAN (ABCDE1234F) unless a test says otherwise, so it is
// in HQ's suggestion set and may be invited by id while it is in no org.
const samePanGstin = (id) => `${String(id % 100).padStart(2, "0")}ABCDE1234F1Z5`;
const HQ_GSTIN = samePanGstin(95602);
const BASE = "/api/v1/vendor-network";

async function entity(id, extra = {}) {
  await seedVendorEntity({
    id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com`, gstin: samePanGstin(id), ...extra,
  });
}

async function world() {
  await entity(LONE);
  await entity(HQ);
  await entity(BRANCH);
  await entity(TARGET);
  await entity(FOREIGN_HQ);
  await entity(FOREIGN_BRANCH);
  await entity(INACTIVE, { status: 0 });
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN Org" });
  await addEntity({ orgId: ORG, vendorId: BRANCH });
  await seedOrg({ id: FOREIGN_ORG, principalVendorId: FOREIGN_HQ, name: "Foreign Org" });
  await addEntity({ orgId: FOREIGN_ORG, vendorId: FOREIGN_BRANCH });
}

async function aStateWithCity() {
  return db.one(
    `SELECT c.id AS city_id, c.state_id FROM tbl_location_cities c
       JOIN tbl_location_states s ON s.id = c.state_id AND s.country_id = 1
      ORDER BY c.id LIMIT 1`
  );
}

const notificationsFor = (userId, type) =>
  db.any(`SELECT * FROM tbl_notifications WHERE recipient_user_id = $1 AND type = $2`, [userId, type]);

/** A live routing assignment for `vendorId` (no subject handler is involved in this suite). */
const liveAssignment = (orgId, vendorId, subjectId, status = "PENDING") =>
  db.one(
    `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, assigned_vendor_id, status)
     VALUES ($1, 'ARC_HOTEL', $2, $3, $4) RETURNING id`,
    [orgId, subjectId, vendorId, status]
  );
const assignmentStatuses = (vendorId) =>
  db
    .any(`SELECT status FROM tbl_vendor_routing_assignments WHERE assigned_vendor_id = $1 ORDER BY id`, [vendorId])
    .then((rows) => rows.map((r) => r.status));
const assignmentActors = (vendorId) =>
  db
    .any(`SELECT acted_by_user_id FROM tbl_vendor_routing_assignments WHERE assigned_vendor_id = $1 ORDER BY id`, [vendorId])
    .then((rows) => rows.map((r) => r.acted_by_user_id));

const gstinOf = async (id) => (await db.one(`SELECT gstin FROM tbl_company WHERE id = $1`, [id])).gstin;

const seatsOf = (vendorId) =>
  db.any(`SELECT * FROM tbl_vendor_network_seats WHERE entity_vendor_id = $1 ORDER BY id`, [vendorId]);

async function invite(body) {
  const admin = await httpClient(HQ);
  return admin.post(`${BASE}/entities/link-invites`).send(body);
}

const savedFee = process.env.NETWORK_SEAT_FEE_INR;

beforeAll(() => moveApiSequencesPastFixtures());

beforeEach(() => {
  delete process.env.NETWORK_SEAT_FEE_INR;
});

afterEach(async () => {
  if (savedFee === undefined) delete process.env.NETWORK_SEAT_FEE_INR;
  else process.env.NETWORK_SEAT_FEE_INR = savedFee;
  await cleanupVendorNetworkFixtures();
});

afterAll(closeDb);

describe("financialYearEnd (Indian FY ends 31 March)", () => {
  it("maps a date to the 31 March closing its financial year", () => {
    expect(financialYearEnd(new Date("2026-03-31"))).toBe("2026-03-31");
    expect(financialYearEnd(new Date("2026-04-01"))).toBe("2027-03-31");
    expect(financialYearEnd(new Date("2027-01-15"))).toBe("2027-03-31");
  });
});

describe("vendor network org and entity API", () => {
  it("1. POST /org creates org + PRINCIPAL + ORG_ADMIN for a no-org vendor; a second call is 409", async () => {
    await world();
    const client = await httpClient(LONE);

    expect((await client.post(`${BASE}/org`).send({ name: "  " })).status).toBe(400);
    expect((await client.post(`${BASE}/org`).send({ name: "x".repeat(121) })).status).toBe(400);
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_vendor_orgs WHERE principal_vendor_id = $1`, [LONE])).toBeNull();

    const res = await client.post(`${BASE}/org`).send({ name: "Lone Group" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(1);
    const org = await db.one(`SELECT * FROM tbl_vendor_orgs WHERE principal_vendor_id = $1`, [LONE]);
    expect(org).toMatchObject({ name: "Lone Group", created_by: LONE, routing_mode: "ADMIN_ROUTES" });
    expect(res.body.data.org_id).toBe(org.id);
    const ent = await db.one(`SELECT * FROM tbl_vendor_org_entities WHERE org_id = $1`, [org.id]);
    expect(ent).toMatchObject({ vendor_id: LONE, relationship: "PRINCIPAL", status: "ACTIVE" });
    const member = await db.one(`SELECT * FROM tbl_vendor_org_members WHERE org_id = $1`, [org.id]);
    expect(member).toMatchObject({ person_user_id: LONE, role: "ORG_ADMIN", status: "ACTIVE", entity_vendor_id: null });

    // The same login now acts as the principal: a second create is refused.
    const again = await (await httpClient(LONE)).post(`${BASE}/org`).send({ name: "Twice" });
    expect(again.status).toBe(409);
    // A member entity of some other org cannot create one either.
    expect((await (await httpClient(BRANCH)).post(`${BASE}/org`).send({ name: "Breakaway" })).status).toBe(409);
    expect(await db.one(`SELECT count(*)::int AS n FROM tbl_vendor_orgs WHERE principal_vendor_id IN ($1, $2)`, [LONE, BRANCH])).toEqual({ n: 1 });
  });

  it("2. suggestions match active no-org vendors sharing the principal's PAN (GSTIN, else PAN document)", async () => {
    await world();
    await entity(SAME_PAN, { gstin: "29ABCDE1234F1Z3" });
    await entity(SAME_PAN_DOC, { gstin: null });
    await db.none(
      `INSERT INTO tbl_vendor_documents (vendor_id, document_type, document_number) VALUES ($1, 'pan', 'abcde1234f')`,
      [SAME_PAN_DOC]
    );
    await entity(OTHER_PAN, { gstin: "27ZZZZZ9999Z1Z5" });
    await db.none(`UPDATE tbl_company SET gstin = '07ABCDE1234F1Z9' WHERE id = $1`, [FOREIGN_BRANCH]); // same PAN, in an org
    await db.none(`UPDATE tbl_company SET gstin = '09ABCDE1234F1Z1' WHERE id = $1`, [INACTIVE]); // same PAN, inactive

    const res = await (await httpClient(HQ)).get(`${BASE}/entities/suggestions`);
    expect(res.status).toBe(200);
    expect(res.body.data.pan).toBe("ABCDE1234F");
    expect(res.body.data.suggestions.map((s) => s.vendor_id).sort()).toEqual([LONE, TARGET, SAME_PAN, SAME_PAN_DOC]);
    // Audit M3: the PAN is self-declared, so another vendor's contact details are masked.
    const samePan = res.body.data.suggestions.find((s) => s.vendor_id === SAME_PAN);
    expect(samePan).toEqual({
      vendor_id: SAME_PAN,
      name: `VN ${SAME_PAN}`,
      company_name: `VN ${SAME_PAN}`,
      email: "v***@e***.com",
      gstin: "29ABC*****1Z3",
    });
    expect(res.body.data.suggestions.find((s) => s.vendor_id === SAME_PAN_DOC).gstin).toBeNull();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(`vn-${SAME_PAN}@example.com`);
    expect(raw).not.toContain("29ABCDE1234F1Z3");

    // Fallback: a principal with no GSTIN takes its PAN from the PAN document.
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [HQ]);
    await db.none(
      `INSERT INTO tbl_vendor_documents (vendor_id, document_type, document_number) VALUES ($1, 'pan', 'ABCDE1234F')`,
      [HQ]
    );
    const viaDoc = await (await httpClient(HQ)).get(`${BASE}/entities/suggestions`);
    expect(viaDoc.body.data.suggestions.map((s) => s.vendor_id).sort()).toEqual([LONE, TARGET, SAME_PAN, SAME_PAN_DOC]);

    // Not an admin: refused.
    expect((await (await httpClient(BRANCH)).get(`${BASE}/entities/suggestions`)).status).toBe(403);
    // No network: refused.
    expect((await (await httpClient(LONE)).get(`${BASE}/entities/suggestions`)).status).toBe(403);
  });

  it("3. link invite: a PENDING 7-day invite (hashed token, no entity row) notifies the target; bad targets are 409 with a reason", async () => {
    await world();
    const res = await invite({ target_vendor_id: TARGET, relationship: "DISTRIBUTOR" });
    expect(res.status).toBe(201);
    const row = await db.one(`SELECT *, expires_at - created_at AS ttl FROM tbl_vendor_org_link_invites WHERE id = $1`, [res.body.data.id]);
    expect(row).toMatchObject({ org_id: ORG, target_vendor_id: TARGET, relationship: "DISTRIBUTOR", status: "PENDING", created_by: HQ });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ttl).toMatchObject({ days: 7 });
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toBeNull();
    const [note] = await notificationsFor(TARGET, "NETWORK_LINK_INVITE");
    expect(note).toMatchObject({ category: "network", action_url: "/dashboard/vendor/network/invites" });

    // By email, case-insensitive.
    const byEmail = await invite({ target_email: `VN-${LONE}@Example.com`, relationship: "BRANCH" });
    expect(byEmail.status).toBe(201);
    expect(byEmail.body.data.target_vendor_id).toBe(LONE);

    const reasons = async (body) => {
      const r = await invite({ relationship: "BRANCH", ...body });
      return [r.status, r.body.reason];
    };
    // By id, only the org's own same-PAN suggestions; every other id is indistinguishable
    // from a missing one, so ids cannot be probed.
    await entity(OTHER_PAN, { gstin: "27ZZZZZ9999Z1Z5" });
    for (const id of [OTHER_PAN, FOREIGN_BRANCH, FOREIGN_HQ, INACTIVE, 95699]) {
      expect(await reasons({ target_vendor_id: id })).toEqual([404, "NOT_FOUND"]);
    }
    // By email (an address the admin already knows): exact match, reasons are given.
    expect(await reasons({ target_email: `vn-${OTHER_PAN}@example.com` })).toEqual([201, undefined]);
    expect(await reasons({ target_email: `vn-${FOREIGN_BRANCH}@example.com` })).toEqual([409, "ALREADY_IN_NETWORK"]);
    expect(await reasons({ target_email: `vn-${FOREIGN_HQ}@example.com` })).toEqual([409, "IS_PRINCIPAL"]);
    expect(await reasons({ target_email: `vn-${INACTIVE}@example.com` })).toEqual([404, "NOT_FOUND"]);
    expect(await reasons({ target_email: "nobody-vn@example.com" })).toEqual([404, "NOT_FOUND"]);
    expect(await reasons({ target_email: `vn-${LONE}@example` })).toEqual([404, "NOT_FOUND"]);

    // One PENDING invite per (org, target).
    expect(await reasons({ target_vendor_id: TARGET })).toEqual([409, "INVITE_PENDING"]);
    expect(await reasons({ target_email: `vn-${TARGET}@example.com` })).toEqual([409, "INVITE_PENDING"]);
    await db.none(`UPDATE tbl_vendor_org_link_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [res.body.data.id]);
    const reinvite = await invite({ target_vendor_id: TARGET, relationship: "BRANCH" });
    expect(reinvite.status).toBe(201);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [res.body.data.id])).toEqual({ status: "EXPIRED" });

    // GET /org shows the target's email only on invites the admin addressed by email.
    const outgoing = (await (await httpClient(HQ)).get(`${BASE}/org`)).body.data.link_invites;
    const byTarget = Object.fromEntries(outgoing.map((i) => [i.target_vendor_id, i]));
    expect(byTarget[TARGET]).toMatchObject({ addressed_by: "ID", target_name: `VN ${TARGET}`, target_email: null });
    expect(byTarget[LONE]).toMatchObject({ addressed_by: "EMAIL", target_email: `vn-${LONE}@example.com` });
    expect((await invite({ target_vendor_id: TARGET, relationship: "PRINCIPAL" })).status).toBe(400);
    // A member entity is not an admin.
    const asMember = await (await httpClient(BRANCH)).post(`${BASE}/entities/link-invites`).send({ target_vendor_id: TARGET, relationship: "BRANCH" });
    expect(asMember.status).toBe(403);
  });

  it("4. accept: only the target, only PENDING and unexpired; joins ACTIVE with a seat and notifies the principal", async () => {
    await world();
    const { body } = await invite({ target_vendor_id: TARGET, relationship: "DEALER" });
    const id = body.data.id;

    // Listed for the target only.
    const incoming = await (await httpClient(TARGET)).get(`${BASE}/link-invites/incoming`);
    expect(incoming.body.data.map((i) => i.id)).toEqual([id]);
    expect(incoming.body.data[0]).toMatchObject({ org_name: "VN Org", relationship: "DEALER" });
    // Consent needs the inviter's identity: its principal's company name and GSTIN, and
    // nothing else of the principal (Task 24 dialog).
    expect(incoming.body.data[0]).toMatchObject({ principal_company_name: `VN ${HQ}`, principal_gstin: HQ_GSTIN });
    expect(Object.keys(incoming.body.data[0]).sort()).toEqual(
      ["created_at", "expires_at", "id", "org_id", "org_name", "principal_company_name", "principal_gstin", "relationship", "status"]
    );
    expect((await (await httpClient(LONE)).get(`${BASE}/link-invites/incoming`)).body.data).toEqual([]);

    // Someone else cannot accept it.
    expect((await (await httpClient(LONE)).post(`${BASE}/link-invites/${id}/accept`)).status).toBe(404);
    expect((await (await httpClient(HQ)).post(`${BASE}/link-invites/${id}/accept`)).status).toBe(404);

    const ok = await (await httpClient(TARGET)).post(`${BASE}/link-invites/${id}/accept`);
    expect(ok.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [id])).toEqual({ status: "ACCEPTED" });
    const ent = await db.one(`SELECT * FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET]);
    expect(ent).toMatchObject({ org_id: ORG, relationship: "DEALER", status: "ACTIVE", invited_by: HQ });
    const [seat] = await seatsOf(TARGET);
    expect(seat).toMatchObject({ org_id: ORG, status: "active", fee_amount: "0.00" });
    expect(await entityCanOperate(TARGET)).toEqual({ ok: true });
    expect(await notificationsFor(HQ, "NETWORK_LINK_ACCEPTED")).toHaveLength(1);

    // Accepting twice: no longer PENDING.
    expect((await (await httpClient(TARGET)).post(`${BASE}/link-invites/${id}/accept`)).status).toBe(409);

    // Expired: flipped to EXPIRED, 410.
    const exp = await invite({ target_vendor_id: LONE, relationship: "BRANCH" });
    await db.none(`UPDATE tbl_vendor_org_link_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exp.body.data.id]);
    expect((await (await httpClient(LONE)).post(`${BASE}/link-invites/${exp.body.data.id}/accept`)).status).toBe(410);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [exp.body.data.id])).toEqual({ status: "EXPIRED" });
    // Already EXPIRED: still 410, for accept and decline alike.
    expect((await (await httpClient(LONE)).post(`${BASE}/link-invites/${exp.body.data.id}/accept`)).status).toBe(410);
    expect((await (await httpClient(LONE)).post(`${BASE}/link-invites/${exp.body.data.id}/decline`)).status).toBe(410);

    // Race: the target joined another network after the invite was sent.
    const race = await invite({ target_vendor_id: LONE, relationship: "BRANCH" });
    await addEntity({ orgId: FOREIGN_ORG, vendorId: LONE });
    const raced = await (await httpClient(LONE)).post(`${BASE}/link-invites/${race.body.data.id}/accept`);
    expect(raced.status).toBe(409);
    expect(raced.body.reason).toBe("ALREADY_IN_NETWORK");
    expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [race.body.data.id])).toEqual({ status: "PENDING" });
    expect(await db.one(`SELECT org_id FROM tbl_vendor_org_entities WHERE vendor_id = $1 AND status <> 'REMOVED'`, [LONE])).toEqual({ org_id: FOREIGN_ORG });
  });

  it("5. decline -> DECLINED (principal notified); cancel by the admin -> CANCELLED; another org cannot cancel", async () => {
    await world();
    const a = (await invite({ target_vendor_id: TARGET, relationship: "BRANCH" })).body.data.id;
    expect((await (await httpClient(LONE)).post(`${BASE}/link-invites/${a}/decline`)).status).toBe(404);
    const declined = await (await httpClient(TARGET)).post(`${BASE}/link-invites/${a}/decline`);
    expect(declined.status).toBe(200);
    expect(await db.one(`SELECT status, acted_at IS NOT NULL AS acted FROM tbl_vendor_org_link_invites WHERE id = $1`, [a])).toEqual({ status: "DECLINED", acted: true });
    expect(await notificationsFor(HQ, "NETWORK_LINK_DECLINED")).toHaveLength(1);
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toBeNull();

    const b = (await invite({ target_vendor_id: TARGET, relationship: "BRANCH" })).body.data.id;
    expect((await (await httpClient(FOREIGN_HQ)).delete(`${BASE}/entities/link-invites/${b}`)).status).toBe(404);
    expect((await (await httpClient(BRANCH)).delete(`${BASE}/entities/link-invites/${b}`)).status).toBe(403);
    const cancelled = await (await httpClient(HQ)).delete(`${BASE}/entities/link-invites/${b}`);
    expect(cancelled.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [b])).toEqual({ status: "CANCELLED" });
    expect((await (await httpClient(HQ)).delete(`${BASE}/entities/link-invites/${b}`)).status).toBe(409);
    // A declined invite cannot be cancelled either.
    expect((await (await httpClient(HQ)).delete(`${BASE}/entities/link-invites/${a}`)).status).toBe(409);
    // A cancelled invite can no longer be accepted.
    expect((await (await httpClient(TARGET)).post(`${BASE}/link-invites/${b}/accept`)).status).toBe(409);
  });

  it("6. POST /entities creates company + passwordless vendor + location + ACTIVE entity + seat; validates GSTIN, email, state/city", async () => {
    await world();
    const { state_id, city_id } = await aStateWithCity();
    const otherStateCity = await db.one(`SELECT id FROM tbl_location_cities WHERE state_id <> $1 ORDER BY id LIMIT 1`, [state_id]);
    const admin = await httpClient(HQ);
    const valid = {
      company_name: "VN Pune Branch",
      gstin: "27abcde1234f2z4",
      email: "VN-Pune-Branch@Example.com",
      state_id,
      city_id,
      address: "1 MG Road",
      relationship: "BRANCH",
    };
    const post = (body) => admin.post(`${BASE}/entities`).send({ ...valid, ...body });

    expect((await post({ gstin: "27ABCDE1234F2X4" })).status).toBe(400);
    expect((await post({ state_id: 99999999 })).status).toBe(400);
    expect((await post({ city_id: otherStateCity.id })).status).toBe(400);
    expect((await post({ relationship: "PRINCIPAL" })).status).toBe(400);
    const dupGstin = await post({ gstin: HQ_GSTIN });
    expect([dupGstin.status, dupGstin.body.reason]).toEqual([409, "GSTIN_EXISTS"]);
    expect(dupGstin.body.message).toMatch(/link/i);
    const dupEmail = await post({ email: `VN-${LONE}@example.com` });
    expect([dupEmail.status, dupEmail.body.reason]).toEqual([409, "EMAIL_EXISTS"]);
    expect((await (await httpClient(BRANCH)).post(`${BASE}/entities`).send(valid)).status).toBe(403);
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_users WHERE lower(email) = 'vn-pune-branch@example.com'`)).toBeNull();

    const res = await post({});
    expect(res.status).toBe(201);
    const vendorId = res.body.data.vendor_id;
    const user = await db.one(`SELECT * FROM tbl_users WHERE id = $1`, [vendorId]);
    expect(user).toMatchObject({ user_type: 3, status: 1, password: null, name: "VN Pune Branch", email: "vn-pune-branch@example.com" });
    expect(await db.one(`SELECT company_name, gstin FROM tbl_company WHERE id = $1`, [user.company_id])).toEqual({ company_name: "VN Pune Branch", gstin: "27ABCDE1234F2Z4" });
    expect(await db.one(`SELECT country_id, state_id, city_id, address FROM tbl_company_location WHERE company_id = $1`, [user.company_id])).toEqual({ country_id: 1, state_id, city_id, address: "1 MG Road" });
    expect(await db.one(`SELECT org_id, relationship, status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [vendorId])).toEqual({ org_id: ORG, relationship: "BRANCH", status: "ACTIVE" });
    expect((await seatsOf(vendorId)).map((s) => s.status)).toEqual(["active"]);

    // The new GSTIN is now taken among active vendors.
    expect((await post({ email: "vn-second@example.com" })).body.reason).toBe("GSTIN_EXISTS");
  });

  it("6b. a BRANCH GSTIN must carry the principal's PAN; distributors and dealers need not", async () => {
    await world();
    const { state_id } = await aStateWithCity();
    const admin = await httpClient(HQ);
    const post = (body) =>
      admin.post(`${BASE}/entities`).send({ company_name: "VN New", state_id, relationship: "BRANCH", ...body });

    const foreign = await post({ gstin: "27ZZZZZ9999Z1Z5", email: "vn-foreign-pan@example.com" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ status: 0, reason: "BRANCH_PAN_MISMATCH" });
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_users WHERE email = 'vn-foreign-pan@example.com'`)).toBeNull();

    // A principal with no PAN at all cannot vouch for any branch.
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [HQ]);
    expect((await post({ gstin: "27ABCDE1234F3Z1", email: "vn-nopan@example.com" })).body.reason).toBe("BRANCH_PAN_MISMATCH");
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [HQ, HQ_GSTIN]);

    expect((await post({ gstin: "27ABCDE1234F3Z1", email: "vn-same-pan@example.com" })).status).toBe(201);
    for (const [relationship, gstin] of [["DISTRIBUTOR", "29ZZZZZ9999Z1Z5"], ["DEALER", "30YYYYY8888Y1Z4"]]) {
      const res = await post({ relationship, gstin, email: `vn-${relationship.toLowerCase()}@example.com` });
      expect(res.status).toBe(201);
    }
  });

  it("6c. POST /entities stops at NETWORK_MAX_ENTITIES live entities (principal included)", async () => {
    await world(); // ORG = HQ + BRANCH
    const { state_id } = await aStateWithCity();
    const admin = await httpClient(HQ);
    const saved = process.env.NETWORK_MAX_ENTITIES;
    process.env.NETWORK_MAX_ENTITIES = "3";
    try {
      const post = (n) =>
        admin.post(`${BASE}/entities`).send({
          company_name: `VN Cap ${n}`, gstin: `27ABCDE1234F${n}Z1`, email: `vn-cap-${n}@example.com`, state_id, relationship: "BRANCH",
        });
      expect((await post(4)).status).toBe(201);
      const over = await post(5);
      expect(over.status).toBe(409);
      expect(over.body.reason).toBe("ENTITY_LIMIT");
      expect(await db.oneOrNone(`SELECT 1 FROM tbl_users WHERE email = 'vn-cap-5@example.com'`)).toBeNull();

      // A removed entity frees its place.
      await db.none(`UPDATE tbl_vendor_org_entities SET status = 'REMOVED', removed_at = now() WHERE vendor_id = $1`, [BRANCH]);
      expect((await post(6)).status).toBe(201);
    } finally {
      if (saved === undefined) delete process.env.NETWORK_MAX_ENTITIES;
      else process.env.NETWORK_MAX_ENTITIES = saved;
    }
  });

  it("7. suspend / reactivate: admin only, never the principal; suspending revokes live assignments", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member-95611@example.com", name: "Mira Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    await liveAssignment(ORG, BRANCH, 1, "PENDING");
    await liveAssignment(ORG, BRANCH, 2, "ACCEPTED");
    await liveAssignment(ORG, BRANCH, 3, "DECLINED");
    const admin = await httpClient(HQ);

    expect((await admin.patch(`${BASE}/entities/${HQ}`).send({ status: "SUSPENDED" })).status).toBe(400);
    expect((await (await httpClient(BRANCH)).patch(`${BASE}/entities/${BRANCH}`).send({ status: "SUSPENDED" })).status).toBe(403);
    expect((await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "REMOVED" })).status).toBe(400);
    expect(await assignmentStatuses(BRANCH)).toEqual(["PENDING", "ACCEPTED", "DECLINED"]);

    const res = await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "SUSPENDED" });
    expect(res.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH])).toEqual({ status: "SUSPENDED" });
    // Its live routing assignments are revoked, attributed to the admin; terminal ones untouched.
    expect(await assignmentStatuses(BRANCH)).toEqual(["REVOKED", "REVOKED", "DECLINED"]);
    expect((await assignmentActors(BRANCH)).slice(0, 2)).toEqual([HQ, HQ]);
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: false, reason: "NOT_ACTIVE" });
    // The person whose only access was this entity loses it on the next request.
    expect((await (await httpClient(MEMBER_PERSON)).get("/api/v1/users/get-profile")).status).toBe(401);

    const back = await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "ACTIVE", preference_rank: 5 });
    expect(back.status).toBe(200);
    expect(await db.one(`SELECT status, preference_rank FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH])).toEqual({ status: "ACTIVE", preference_rank: 5 });
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: true });
    // Reactivating does not resurrect them.
    expect(await assignmentStatuses(BRANCH)).toEqual(["REVOKED", "REVOKED", "DECLINED"]);
  });

  it("8. remove (admin) and leave (self): REMOVED, memberships disabled, pending seats cancelled, active seats kept; never the principal", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member-95611@example.com", name: "Mira Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    await db.none(
      `INSERT INTO tbl_vendor_network_seats (org_id, entity_vendor_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, 500, CURRENT_DATE, CURRENT_DATE + 400, 'pending')`,
      [ORG, BRANCH]
    );
    await liveAssignment(ORG, BRANCH, 1, "ACCEPTED");
    const rulesOf = (vendorId) =>
      db.any(`SELECT scope_type FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [vendorId]);
    const addRule = (vendorId) =>
      db.none(
        `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode) VALUES ($1, 'STATE', 1, 'INCLUDE')`,
        [vendorId]
      );
    await addRule(BRANCH);
    const admin = await httpClient(HQ);

    expect((await admin.delete(`${BASE}/entities/${HQ}`)).status).toBe(400);
    expect((await (await httpClient(HQ)).post(`${BASE}/entities/self/leave`)).status).toBe(400);
    expect((await (await httpClient(BRANCH)).delete(`${BASE}/entities/${BRANCH}`)).status).toBe(403);

    const res = await admin.delete(`${BASE}/entities/${BRANCH}`);
    expect(res.status).toBe(200);
    const ent = await db.one(`SELECT status, removed_at FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH]);
    expect(ent.status).toBe("REMOVED");
    expect(ent.removed_at).not.toBeNull();
    expect(await db.one(`SELECT status FROM tbl_vendor_org_members WHERE person_user_id = $1`, [MEMBER_PERSON])).toEqual({ status: "DISABLED" });
    expect((await seatsOf(BRANCH)).map((s) => s.status)).toEqual(["active", "cancelled"]);
    expect(await assignmentStatuses(BRANCH)).toEqual(["REVOKED"]);
    expect(await assignmentActors(BRANCH)).toEqual([HQ]);
    // Its coverage rules are gone: they never route for a future org.
    expect(await rulesOf(BRANCH)).toEqual([]);
    // Removed: no longer a target of this org.
    expect((await admin.delete(`${BASE}/entities/${BRANCH}`)).status).toBe(404);

    // Leave: a linked entity leaves on its own login.
    await addEntity({ orgId: ORG, vendorId: TARGET });
    await liveAssignment(ORG, TARGET, 2, "PENDING");
    await addRule(TARGET);
    const left = await (await httpClient(TARGET)).post(`${BASE}/entities/self/leave`);
    expect(left.status).toBe(200);
    expect(await rulesOf(TARGET)).toEqual([]);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toEqual({ status: "REMOVED" });
    expect(await assignmentStatuses(TARGET)).toEqual(["REVOKED"]);
    expect(await assignmentActors(TARGET)).toEqual([TARGET]);
    // Out of the network now: leaving again is refused.
    expect((await (await httpClient(TARGET)).post(`${BASE}/entities/self/leave`)).status).toBe(403);
  });

  it("9. PATCH /org validates routing_mode and routing_timeout_hours (1..168); admin only", async () => {
    await world();
    const admin = await httpClient(HQ);
    expect((await admin.patch(`${BASE}/org`).send({ routing_mode: "ROUND_ROBIN" })).status).toBe(400);
    expect((await admin.patch(`${BASE}/org`).send({ routing_timeout_hours: 0 })).status).toBe(400);
    expect((await admin.patch(`${BASE}/org`).send({ routing_timeout_hours: 169 })).status).toBe(400);
    expect((await admin.patch(`${BASE}/org`).send({ routing_timeout_hours: 2.5 })).status).toBe(400);
    expect((await admin.patch(`${BASE}/org`).send({})).status).toBe(400);
    expect((await (await httpClient(BRANCH)).patch(`${BASE}/org`).send({ routing_timeout_hours: 4 })).status).toBe(403);

    const res = await admin.patch(`${BASE}/org`).send({ name: "VN Org Renamed", routing_mode: "AUTO_SINGLE_MATCH", routing_timeout_hours: 168 });
    expect(res.status).toBe(200);
    expect(await db.one(`SELECT name, routing_mode, routing_timeout_hours FROM tbl_vendor_orgs WHERE id = $1`, [ORG])).toEqual({
      name: "VN Org Renamed",
      routing_mode: "AUTO_SINGLE_MATCH",
      routing_timeout_hours: 168,
    });

    const got = await admin.get(`${BASE}/org`);
    expect(got.status).toBe(200);
    expect(got.body.data.org).toMatchObject({ id: ORG, name: "VN Org Renamed", routing_timeout_hours: 168 });
    expect(got.body.data.entities.map((e) => [e.vendor_id, e.seat_status])).toEqual([
      [HQ, null],
      [BRANCH, "active"],
    ]);
  });

  it("9b. seat renewal at fee 0: a seat whose FY ended blocks nothing, and is shown as expired with seat_fee_inr", async () => {
    await world();
    // BRANCH's only seat ended last FY (31 March), still marked 'active'.
    await db.none(
      `UPDATE tbl_vendor_network_seats SET start_date = DATE '2024-04-01', end_date = DATE '2025-03-31' WHERE entity_vendor_id = $1`,
      [BRANCH]
    );
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: true });
    const admin = await httpClient(HQ);

    const got = await admin.get(`${BASE}/org`);
    expect(got.status).toBe(200);
    expect(got.body.data.seat_fee_inr).toBe(0);
    const branch = got.body.data.entities.find((e) => e.vendor_id === BRANCH);
    expect(branch).toMatchObject({ seat_status: "expired", seat_valid_until: "2025-03-31" });
    expect(got.body.data.entities.find((e) => e.vendor_id === HQ)).toMatchObject({ seat_status: null, seat_valid_until: null });

    const summary = await admin.get(`${BASE}/dashboard/summary`);
    expect(summary.body.data.seat_fee_inr).toBe(0);
    expect(summary.body.data.entities.find((e) => e.vendor_id === BRANCH).seat).toMatchObject({
      status: "expired",
      valid_until: "2025-03-31",
    });

    // Assignable at fee 0 (the gate is entityCanOperate, never this list).
    const a = await liveAssignment(ORG, BRANCH, 77);
    expect(a.id).toBeTruthy();

    // With a fee the same seat blocks (NO_SEAT); a current seat wins over the expired one.
    process.env.NETWORK_SEAT_FEE_INR = "500";
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: false, reason: "NO_SEAT" });
    expect((await admin.get(`${BASE}/org`)).body.data.seat_fee_inr).toBe(500);
    await db.none(
      `INSERT INTO tbl_vendor_network_seats (org_id, entity_vendor_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, 500, CURRENT_DATE, CURRENT_DATE + 30, 'active')`,
      [ORG, BRANCH]
    );
    const renewed = (await admin.get(`${BASE}/org`)).body.data.entities.find((e) => e.vendor_id === BRANCH);
    expect(renewed.seat_status).toBe("active");
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: true });
  });

  it("4b. incoming invites: principal_company_name is the company's own name or null, never a fallback", async () => {
    await world();
    await db.none(`UPDATE tbl_company SET company_name = NULL WHERE id = $1`, [HQ]);
    const { body } = await invite({ target_vendor_id: TARGET, relationship: "DEALER" });
    const [row] = (await (await httpClient(TARGET)).get(`${BASE}/link-invites/incoming`)).body.data;
    expect(row.id).toBe(body.data.id);
    expect(row.principal_company_name).toBeNull();
    expect(row.principal_gstin).toBe(HQ_GSTIN);
    await db.none(`UPDATE tbl_company SET company_name = '   ', gstin = NULL WHERE id = $1`, [HQ]);
    const [blank] = (await (await httpClient(TARGET)).get(`${BASE}/link-invites/incoming`)).body.data;
    expect([blank.principal_company_name, blank.principal_gstin]).toEqual([null, null]);
  });

  it("4c. accepting a link invite respects NETWORK_MAX_ENTITIES; the invite stays PENDING", async () => {
    await world(); // ORG = HQ + BRANCH
    const id = (await invite({ target_vendor_id: TARGET, relationship: "DEALER" })).body.data.id;
    const saved = process.env.NETWORK_MAX_ENTITIES;
    process.env.NETWORK_MAX_ENTITIES = "2";
    try {
      const res = await (await httpClient(TARGET)).post(`${BASE}/link-invites/${id}/accept`);
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("ENTITY_LIMIT");
      expect(await db.oneOrNone(`SELECT 1 FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toBeNull();
      expect((await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [id])).status).toBe("PENDING");
      process.env.NETWORK_MAX_ENTITIES = "3";
      expect((await (await httpClient(TARGET)).post(`${BASE}/link-invites/${id}/accept`)).status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.NETWORK_MAX_ENTITIES;
      else process.env.NETWORK_MAX_ENTITIES = saved;
    }
  });

  it("6d. a network entity's GSTIN is locked (NETWORK_GSTIN_LOCKED), so the BRANCH PAN check cannot be re-pointed", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-gst-admin@example.com", name: "Gst Admin" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, role: "ORG_ADMIN" });
    const VICTIM = "27VICTM1234V1Z5";

    for (const client of [await httpClient(HQ), await httpClient(MEMBER_PERSON, { ent: HQ }), await httpClient(BRANCH)]) {
      const res = await client.put("/api/v1/users/update-company-detail").send({ company_name: "Renamed", gstin: VICTIM });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("NETWORK_GSTIN_LOCKED");
    }
    expect(await gstinOf(HQ)).toBe(HQ_GSTIN);
    expect(await gstinOf(BRANCH)).toBe(samePanGstin(BRANCH));

    // The same GSTIN (any case / spacing) is not a change; it is written normalised.
    const same = await (await httpClient(HQ)).put("/api/v1/users/update-company-detail").send({ company_name: "HQ Ltd", gstin: ` ${HQ_GSTIN.toLowerCase()} ` });
    expect(same.status).toBe(200);
    expect(await db.one(`SELECT company_name, gstin FROM tbl_company WHERE id = $1`, [HQ])).toEqual({ company_name: "HQ Ltd", gstin: HQ_GSTIN });

    // HQ still carries ITS OWN PAN, so a branch of the victim's PAN is refused by the PAN
    // check (HQ's PAN ABCDE1234F != VICTM1234V), not by anything else.
    const { state_id } = await aStateWithCity();
    const branch = await (await httpClient(HQ)).post(`${BASE}/entities`).send({
      company_name: "Victim Branch", gstin: "27VICTM1234V2Z4", email: "vn-victim-branch@example.com", state_id, relationship: "BRANCH",
    });
    expect([branch.status, branch.body.reason]).toEqual([400, "BRANCH_PAN_MISMATCH"]);
    const own = await (await httpClient(HQ)).post(`${BASE}/entities`).send({
      company_name: "Own Branch", gstin: "27ABCDE1234F9Z1", email: "vn-own-branch@example.com", state_id, relationship: "BRANCH",
    });
    expect(own.status).toBe(201);
  });

  it("6e. null and '' are no-ops for a network entity: never a wipe, and the lock still holds afterwards", async () => {
    await world();
    for (const gstin of [null, "", "   "]) {
      const res = await (await httpClient(HQ)).put("/api/v1/users/update-company-detail").send({ company_name: "HQ Ltd", gstin });
      expect(res.status).toBe(200);
      expect(await gstinOf(HQ)).toBe(HQ_GSTIN);
    }
    const omitted = await (await httpClient(BRANCH)).put("/api/v1/users/update-company-detail").send({ company_name: "Branch Ltd" });
    expect(omitted.status).toBe(200);
    expect(await gstinOf(BRANCH)).toBe(samePanGstin(BRANCH));
    expect(await db.one(`SELECT company_name FROM tbl_company WHERE id = $1`, [BRANCH])).toEqual({ company_name: "Branch Ltd" });
    // Still locked against a real change.
    const changed = await (await httpClient(HQ)).put("/api/v1/users/update-company-detail").send({ gstin: "27ZZZZZ9999Z1Z5" });
    expect([changed.status, changed.body.reason]).toEqual([409, "NETWORK_GSTIN_LOCKED"]);
  });

  it("6f. set-from-empty: a network entity with no GSTIN may set one; it must carry its PAN document's PAN when one exists", async () => {
    await world();
    // HQ (principal) has no GSTIN and no PAN document: it can set one, written normalised.
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [HQ]);
    const set = await (await httpClient(HQ)).put("/api/v1/users/update-company-detail").send({ gstin: " 27abcde1234f1z5 " });
    expect(set.status).toBe(200);
    expect(await gstinOf(HQ)).toBe("27ABCDE1234F1Z5");
    // ...and once set it is locked.
    expect((await (await httpClient(HQ)).put("/api/v1/users/update-company-detail").send({ gstin: "27ABCDE1234F2Z4" })).body.reason).toBe("NETWORK_GSTIN_LOCKED");

    // BRANCH has no GSTIN but a PAN document: only a GSTIN of that PAN is accepted.
    await db.none(`UPDATE tbl_company SET gstin = '' WHERE id = $1`, [BRANCH]);
    await db.none(`INSERT INTO tbl_vendor_documents (vendor_id, document_type, document_number) VALUES ($1, 'pan', 'abcde1234f')`, [BRANCH]);
    const other = await (await httpClient(BRANCH)).put("/api/v1/users/update-company-detail").send({ gstin: "27ZZZZZ9999Z1Z5" });
    expect([other.status, other.body.reason]).toEqual([409, "NETWORK_GSTIN_LOCKED"]);
    expect(await gstinOf(BRANCH)).toBe("");
    const malformed = await (await httpClient(BRANCH)).put("/api/v1/users/update-company-detail").send({ gstin: "NOT-A-GSTIN" });
    expect([malformed.status, malformed.body.reason]).toEqual([400, "INVALID_GSTIN"]);
    const match = await (await httpClient(BRANCH)).put("/api/v1/users/update-company-detail").send({ gstin: "09abcde1234f1z2" });
    expect(match.status).toBe(200);
    expect(await gstinOf(BRANCH)).toBe("09ABCDE1234F1Z2");
  });

  it("6g. a vendor in no network edits its GSTIN exactly as before: change, clear, anything", async () => {
    await world();
    const lone = await httpClient(LONE);
    expect((await lone.put("/api/v1/users/update-company-detail").send({ company_name: "Lone Ltd", gstin: "29LONEV1234L1Z1" })).status).toBe(200);
    expect(await gstinOf(LONE)).toBe("29LONEV1234L1Z1");
    expect((await lone.put("/api/v1/users/update-company-detail").send({ gstin: " free text " })).status).toBe(200);
    expect(await gstinOf(LONE)).toBe("free text"); // trimmed only, unvalidated: as before
    expect((await lone.put("/api/v1/users/update-company-detail").send({ gstin: "" })).status).toBe(200);
    expect(await gstinOf(LONE)).toBe("");
    expect((await lone.put("/api/v1/users/update-company-detail").send({ gstin: null })).status).toBe(200);
    expect(await gstinOf(LONE)).toBeNull();
  });

  it("10. every :vendorId target must be an entity of the caller's org, else 404", async () => {
    await world();
    await liveAssignment(FOREIGN_ORG, FOREIGN_BRANCH, 1, "PENDING");
    const admin = await httpClient(HQ);
    for (const target of [FOREIGN_BRANCH, LONE, 2147483647]) {
      expect((await admin.patch(`${BASE}/entities/${target}`).send({ status: "SUSPENDED" })).status).toBe(404);
      expect((await admin.delete(`${BASE}/entities/${target}`)).status).toBe(404);
    }
    expect((await admin.delete(`${BASE}/entities/abc`)).status).toBe(404);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [FOREIGN_BRANCH])).toEqual({ status: "ACTIVE" });
    expect(await assignmentStatuses(FOREIGN_BRANCH)).toEqual(["PENDING"]);
  });

  it("11. seats: free seats activate at once; a fee leaves the seat pending (NO_SEAT) until paid and HMAC-verified", async () => {
    await world();
    process.env.NETWORK_SEAT_FEE_INR = "1500";
    const { state_id } = await aStateWithCity();
    const admin = await httpClient(HQ);
    const created = await admin.post(`${BASE}/entities`).send({
      company_name: "VN Paid Branch",
      gstin: "27ABCDE1234F6Z2",
      email: "vn-paid-branch@example.com",
      state_id,
      relationship: "BRANCH",
    });
    expect(created.status).toBe(201);
    expect(created.body.data.seat).toMatchObject({ payable: true, amount: 1500 });
    const vendorId = created.body.data.vendor_id;
    const [seat] = await seatsOf(vendorId);
    expect(seat).toMatchObject({ status: "pending", fee_amount: "1500.00" });
    expect(await entityCanOperate(vendorId)).toEqual({ ok: false, reason: "NO_SEAT" });

    // A foreign org's admin cannot pay (or learn about) this seat.
    expect((await (await httpClient(FOREIGN_HQ)).post(`${BASE}/seats/pay`).send({ seat_ids: [seat.id] })).status).toBe(404);
    expect((await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [] })).status).toBe(400);
    expect((await (await httpClient(BRANCH)).post(`${BASE}/seats/pay`).send({ seat_ids: [seat.id] })).status).toBe(403);

    const pay = await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [seat.id] });
    expect(pay.status).toBe(200);
    const orderId = pay.body.data.order.id;
    expect(razorpayOrders.at(-1)).toMatchObject({ id: orderId, amount: 150000 });
    const payment = await db.one(`SELECT * FROM tbl_vendor_payments WHERE razorpay_order_id = $1`, [orderId]);
    expect(payment).toMatchObject({ vendor_id: HQ, amount: 150000, payment_type: "network_seat", payment_status: "created" });
    expect(payment.metadata).toMatchObject({ org_id: ORG, seat_ids: [seat.id] });

    const paymentId = "pay_vnseat_1";
    const sign = (secret) => crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    const verify = (client, signature) =>
      client.post(`${BASE}/seats/verify-payment`).send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });

    expect((await verify(admin, sign("not-the-secret"))).status).toBe(400);
    expect((await seatsOf(vendorId))[0].status).toBe("pending");
    // A valid signature still cannot activate another org's payment.
    expect((await verify(await httpClient(FOREIGN_HQ), sign(Config.razorpay.razorpay_secret))).status).toBe(404);

    const ok = await verify(admin, sign(Config.razorpay.razorpay_secret));
    expect(ok.status).toBe(200);
    expect(await db.one(`SELECT payment_status, razorpay_payment_id FROM tbl_vendor_payments WHERE id = $1`, [payment.id])).toEqual({
      payment_status: "paid",
      razorpay_payment_id: paymentId,
    });
    expect(await db.one(`SELECT status, payment_id FROM tbl_vendor_network_seats WHERE id = $1`, [seat.id])).toEqual({ status: "active", payment_id: payment.id });
    expect(await entityCanOperate(vendorId)).toEqual({ ok: true });
    // Replaying the verification changes nothing.
    expect((await verify(admin, sign(Config.razorpay.razorpay_secret))).status).toBe(200);
    expect((await seatsOf(vendorId)).map((s) => s.status)).toEqual(["active"]);
  });

  it("11a. the public /hospitality/verify-payment refuses a network_seat order; the seat flow still completes it", async () => {
    await world();
    process.env.NETWORK_SEAT_FEE_INR = "1500";
    const { state_id } = await aStateWithCity();
    const admin = await httpClient(HQ);
    const created = await admin.post(`${BASE}/entities`).send({
      company_name: "VN Wrong Verify Branch", gstin: "27ABCDE1234F7Z2", email: "vn-wrong-verify@example.com", state_id, relationship: "BRANCH",
    });
    expect(created.status).toBe(201);
    const seatId = created.body.data.seat.id;
    const pay = await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [seatId] });
    expect(pay.status).toBe(200);
    const orderId = pay.body.data.order.id;
    const paymentId = "pay_vnseat_wrong_verify";
    const body = {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: crypto.createHmac("sha256", Config.razorpay.razorpay_secret).update(`${orderId}|${paymentId}`).digest("hex"),
    };
    const hqBefore = await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [HQ]);

    const wrong = await admin.post(`/api/v1/hospitality/verify-payment`).send(body);
    expect(wrong.status).toBe(400);
    expect(wrong.body.status).toBe(2);
    expect(await db.one(`SELECT payment_status, razorpay_payment_id FROM tbl_vendor_payments WHERE razorpay_order_id = $1`, [orderId])).toEqual({
      payment_status: "created",
      razorpay_payment_id: null,
    });
    expect(await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [HQ])).toEqual(hqBefore);
    // the open checkout still blocks a second order for the same seat
    const again = await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [seatId] });
    expect([again.status, again.body.reason]).toEqual([409, "PAYMENT_IN_PROGRESS"]);

    const ok = await admin.post(`${BASE}/seats/verify-payment`).send(body);
    expect(ok.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_network_seats WHERE id = $1`, [seatId])).toEqual({ status: "active" });
  });

  describe("11b. seats on re-link", () => {
    async function linkAndAccept(admin, vendorId) {
      const inv = await (await httpClient(admin)).post(`${BASE}/entities/link-invites`).send({ target_vendor_id: vendorId, relationship: "BRANCH" });
      expect(inv.status).toBe(201);
      return (await httpClient(vendorId)).post(`${BASE}/link-invites/${inv.body.data.id}/accept`);
    }

    it("(a) removed then re-added to the SAME org reuses its active seat; with a fee, no new pending seat", async () => {
      await world();
      process.env.NETWORK_SEAT_FEE_INR = "1500";
      const [before] = await seatsOf(BRANCH);
      expect((await (await httpClient(HQ)).delete(`${BASE}/entities/${BRANCH}`)).status).toBe(200);

      const accepted = await linkAndAccept(HQ, BRANCH);
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.seat).toMatchObject({ id: before.id, status: "active", payable: false });
      expect((await seatsOf(BRANCH)).map((s) => [s.id, s.status])).toEqual([[before.id, "active"]]);
      expect(await entityCanOperate(BRANCH)).toEqual({ ok: true });
    });

    it("(b) removed from org A, linked into org B at fee 0: A's seat cancelled, B's active, no 409", async () => {
      await world();
      const [aSeat] = await seatsOf(FOREIGN_BRANCH);
      expect((await (await httpClient(FOREIGN_HQ)).delete(`${BASE}/entities/${FOREIGN_BRANCH}`)).status).toBe(200);

      const accepted = await linkAndAccept(HQ, FOREIGN_BRANCH);
      expect(accepted.status).toBe(200);
      const seats = await seatsOf(FOREIGN_BRANCH);
      expect(seats.map((s) => [s.id === aSeat.id ? "A" : "B", s.org_id, s.status])).toEqual([
        ["A", FOREIGN_ORG, "cancelled"],
        ["B", ORG, "active"],
      ]);
    });

    it("(c) removed from org A, linked into org B with a fee: A's seat cancelled, B's pending", async () => {
      await world();
      process.env.NETWORK_SEAT_FEE_INR = "1500";
      const [aSeat] = await seatsOf(FOREIGN_BRANCH);
      expect((await (await httpClient(FOREIGN_HQ)).delete(`${BASE}/entities/${FOREIGN_BRANCH}`)).status).toBe(200);

      const accepted = await linkAndAccept(HQ, FOREIGN_BRANCH);
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.seat).toMatchObject({ status: "pending", payable: true, amount: 1500 });
      const seats = await seatsOf(FOREIGN_BRANCH);
      expect(seats.map((s) => [s.id === aSeat.id ? "A" : "B", s.org_id, s.status])).toEqual([
        ["A", FOREIGN_ORG, "cancelled"],
        ["B", ORG, "pending"],
      ]);
      expect(await entityCanOperate(FOREIGN_BRANCH)).toEqual({ ok: false, reason: "NO_SEAT" });
    });
  });

  describe("fix round 1", () => {
    it("POST /entities: two concurrent creates with the same email produce exactly one account", async () => {
      await world();
      const { state_id } = await aStateWithCity();
      const admin = await httpClient(HQ);
      // DISTRIBUTOR: these GSTINs carry other PANs (a BRANCH must share the principal's).
      const body = (gstin) => ({
        company_name: "VN Twin", gstin, email: "vn-twin@example.com", state_id, relationship: "DISTRIBUTOR",
      });
      const results = await Promise.all([
        admin.post(`${BASE}/entities`).send(body("27TWINA1111A1Z1")),
        admin.post(`${BASE}/entities`).send(body("27TWINB2222B1Z2")),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409).body.reason).toBe("EMAIL_EXISTS");
      expect(await db.one(`SELECT count(*)::int AS n FROM tbl_users WHERE lower(email) = 'vn-twin@example.com'`)).toEqual({ n: 1 });

      // Same GSTIN, different emails: also exactly one.
      const gstinRace = await Promise.all([
        admin.post(`${BASE}/entities`).send({ ...body("27TWINC3333C1Z3"), email: "vn-twin-c1@example.com" }),
        admin.post(`${BASE}/entities`).send({ ...body("27TWINC3333C1Z3"), email: "vn-twin-c2@example.com" }),
      ]);
      expect(gstinRace.map((r) => [r.status, r.body.reason]).sort()).toEqual([[201, undefined], [409, "GSTIN_EXISTS"]]);
    });

    it("accept: a live-entity insert that races the pre-check maps the unique violation to 409", async () => {
      await world();
      const id = (await invite({ target_vendor_id: TARGET, relationship: "BRANCH" })).body.data.id;

      // Another transaction makes TARGET live in FOREIGN_ORG but has not committed, so the
      // accept's "in no live org" pre-check passes and its insert waits on the unique index.
      let inserted;
      const ready = new Promise((r) => (inserted = r));
      let release;
      const gate = new Promise((r) => (release = r));
      const holder = db.tx(async (t) => {
        await t.none(
          `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, linked_at)
           VALUES ($1, $2, 'BRANCH', 'ACTIVE', now())`,
          [FOREIGN_ORG, TARGET]
        );
        inserted();
        await gate;
      });
      await ready;
      const accepting = (await httpClient(TARGET)).post(`${BASE}/link-invites/${id}/accept`).then((r) => r);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { n } = await db.one(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'INSERT INTO tbl_vendor_org_entities%'`
        );
        if (n > 0) break;
        if (Date.now() > deadline) throw new Error("accept never blocked on the entity insert");
        await new Promise((r) => setTimeout(r, 50));
      }
      release();
      await holder;
      const res = await accepting;
      expect([res.status, res.body.reason]).toEqual([409, "ALREADY_IN_NETWORK"]);
      expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [id])).toEqual({ status: "PENDING" });
      expect(await db.any(`SELECT org_id FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toEqual([{ org_id: FOREIGN_ORG }]);
    });

    it("accept: a person acting for the invited entity (not its own login) is refused 403", async () => {
      await world();
      const id = (await invite({ target_vendor_id: TARGET, relationship: "BRANCH" })).body.data.id;
      // TARGET later joined FOREIGN_ORG, whose principal can now act for it.
      await addEntity({ orgId: FOREIGN_ORG, vendorId: TARGET });
      const res = await (await httpClient(FOREIGN_HQ, { ent: TARGET })).post(`${BASE}/link-invites/${id}/accept`);
      expect(res.status).toBe(403);
      expect((await (await httpClient(FOREIGN_HQ, { ent: TARGET })).post(`${BASE}/link-invites/${id}/decline`)).status).toBe(403);
      expect(await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [id])).toEqual({ status: "PENDING" });
    });

    it("seats: a seat in an open checkout is refused 409 PAYMENT_IN_PROGRESS; a seat cancelled before verify leaves the payment paid with activated 0", async () => {
      await world();
      process.env.NETWORK_SEAT_FEE_INR = "1500";
      const { state_id } = await aStateWithCity();
      const admin = await httpClient(HQ);
      const created = await admin.post(`${BASE}/entities`).send({
        company_name: "VN Checkout Branch", gstin: "27ABCDE1234F8Z2", email: "vn-checkout@example.com", state_id, relationship: "BRANCH",
      });
      const vendorId = created.body.data.vendor_id;
      const seatId = created.body.data.seat.id;

      const pay = await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [seatId] });
      expect(pay.status).toBe(200);
      const again = await admin.post(`${BASE}/seats/pay`).send({ seat_ids: [seatId] });
      expect([again.status, again.body.reason]).toEqual([409, "PAYMENT_IN_PROGRESS"]);
      expect(await db.one(`SELECT count(*)::int AS n FROM tbl_vendor_payments WHERE payment_type = 'network_seat' AND vendor_id = $1`, [HQ])).toEqual({ n: 1 });

      // The entity is removed after checkout: its pending seat is cancelled.
      expect((await admin.delete(`${BASE}/entities/${vendorId}`)).status).toBe(200);
      const orderId = pay.body.data.order.id;
      const paymentId = "pay_vnseat_removed";
      const signature = crypto.createHmac("sha256", Config.razorpay.razorpay_secret).update(`${orderId}|${paymentId}`).digest("hex");
      const verified = await admin.post(`${BASE}/seats/verify-payment`).send({
        razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature,
      });
      expect(verified.status).toBe(200);
      expect(verified.body.data.activated).toBe(0);
      expect(await db.one(`SELECT payment_status FROM tbl_vendor_payments WHERE razorpay_order_id = $1`, [orderId])).toEqual({ payment_status: "paid" });
      expect(await db.one(`SELECT status FROM tbl_vendor_network_seats WHERE id = $1`, [seatId])).toEqual({ status: "cancelled" });
    });
  });
});
