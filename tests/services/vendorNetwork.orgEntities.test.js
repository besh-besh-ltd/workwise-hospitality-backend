// Vendor Networks org and entity management API (spec §5, §5.1, §10.5, §10.6).
// One `it` per rule of task 4, each with its positive and negative halves:
// create network, suggestions, link invites (consent), create branch, suspend,
// remove/leave, settings, isolation and seats (incl. Razorpay order + HMAC verify).
// Pattern B: committed fixtures (ids 95601..95699), removed in afterEach.
//
// Two module boundaries are replaced, both before the app graph loads:
//   - the Razorpay SDK (orders.create is a network call to Razorpay)
//   - routingEngine.js, recording revokeLiveAssignmentsForEntity calls (Task 8
//     implements the revocation; this task only owns the call and its reason)

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

const revokeCalls = [];
jest.unstable_mockModule("../../app/services/vendorNetwork/routingEngine.js", () => ({
  revokeLiveAssignmentsForEntity: async (vendorId, opts = {}) => {
    revokeCalls.push({ vendorId: Number(vendorId), ...opts });
    return 0;
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

const HQ_GSTIN = "27ABCDE1234F1Z5";
const BASE = "/api/v1/vendor-network";

async function entity(id, extra = {}) {
  await seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com`, ...extra });
}

async function world() {
  await entity(LONE);
  await entity(HQ, { gstin: HQ_GSTIN });
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

const seatsOf = (vendorId) =>
  db.any(`SELECT * FROM tbl_vendor_network_seats WHERE entity_vendor_id = $1 ORDER BY id`, [vendorId]);

async function invite(body) {
  const admin = await httpClient(HQ);
  return admin.post(`${BASE}/entities/link-invites`).send(body);
}

const savedFee = process.env.NETWORK_SEAT_FEE_INR;

beforeEach(() => {
  revokeCalls.length = 0;
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
    await entity(SAME_PAN_DOC);
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
    expect(res.body.data.suggestions.map((s) => s.vendor_id).sort()).toEqual([SAME_PAN, SAME_PAN_DOC]);

    // Fallback: a principal with no GSTIN takes its PAN from the PAN document.
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [HQ]);
    await db.none(
      `INSERT INTO tbl_vendor_documents (vendor_id, document_type, document_number) VALUES ($1, 'pan', 'ABCDE1234F')`,
      [HQ]
    );
    const viaDoc = await (await httpClient(HQ)).get(`${BASE}/entities/suggestions`);
    expect(viaDoc.body.data.suggestions.map((s) => s.vendor_id).sort()).toEqual([SAME_PAN, SAME_PAN_DOC]);

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
    expect(await reasons({ target_vendor_id: FOREIGN_BRANCH })).toEqual([409, "ALREADY_IN_NETWORK"]);
    expect(await reasons({ target_vendor_id: FOREIGN_HQ })).toEqual([409, "IS_PRINCIPAL"]);
    expect(await reasons({ target_vendor_id: INACTIVE })).toEqual([409, "NOT_FOUND"]);
    expect(await reasons({ target_email: "nobody-vn@example.com" })).toEqual([409, "NOT_FOUND"]);
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

  it("7. suspend / reactivate: admin only, never the principal; suspending revokes live assignments", async () => {
    await world();
    await seedPerson({ id: MEMBER_PERSON, email: "vn-member-95611@example.com", name: "Mira Member" });
    await addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
    const admin = await httpClient(HQ);

    expect((await admin.patch(`${BASE}/entities/${HQ}`).send({ status: "SUSPENDED" })).status).toBe(400);
    expect((await (await httpClient(BRANCH)).patch(`${BASE}/entities/${BRANCH}`).send({ status: "SUSPENDED" })).status).toBe(403);
    expect((await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "REMOVED" })).status).toBe(400);
    expect(revokeCalls).toEqual([]);

    const res = await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "SUSPENDED" });
    expect(res.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH])).toEqual({ status: "SUSPENDED" });
    expect(revokeCalls).toEqual([{ vendorId: BRANCH, actorUserId: HQ, reason: "ENTITY_SUSPENDED" }]);
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: false, reason: "NOT_ACTIVE" });
    // The person whose only access was this entity loses it on the next request.
    expect((await (await httpClient(MEMBER_PERSON)).get("/api/v1/users/get-profile")).status).toBe(401);

    const back = await admin.patch(`${BASE}/entities/${BRANCH}`).send({ status: "ACTIVE", preference_rank: 5 });
    expect(back.status).toBe(200);
    expect(await db.one(`SELECT status, preference_rank FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH])).toEqual({ status: "ACTIVE", preference_rank: 5 });
    expect(await entityCanOperate(BRANCH)).toEqual({ ok: true });
    expect(revokeCalls).toHaveLength(1);
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
    expect(revokeCalls).toEqual([{ vendorId: BRANCH, actorUserId: HQ, reason: "ENTITY_REMOVED" }]);
    // Removed: no longer a target of this org.
    expect((await admin.delete(`${BASE}/entities/${BRANCH}`)).status).toBe(404);

    // Leave: a linked entity leaves on its own login.
    await addEntity({ orgId: ORG, vendorId: TARGET });
    const left = await (await httpClient(TARGET)).post(`${BASE}/entities/self/leave`);
    expect(left.status).toBe(200);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [TARGET])).toEqual({ status: "REMOVED" });
    expect(revokeCalls[1]).toEqual({ vendorId: TARGET, actorUserId: TARGET, reason: "ENTITY_REMOVED" });
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

  it("10. every :vendorId target must be an entity of the caller's org, else 404", async () => {
    await world();
    const admin = await httpClient(HQ);
    for (const target of [FOREIGN_BRANCH, LONE, 2147483647]) {
      expect((await admin.patch(`${BASE}/entities/${target}`).send({ status: "SUSPENDED" })).status).toBe(404);
      expect((await admin.delete(`${BASE}/entities/${target}`)).status).toBe(404);
    }
    expect((await admin.delete(`${BASE}/entities/abc`)).status).toBe(404);
    expect(await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [FOREIGN_BRANCH])).toEqual({ status: "ACTIVE" });
    expect(revokeCalls).toEqual([]);
  });

  it("11. seats: free seats activate at once; a fee leaves the seat pending (NO_SEAT) until paid and HMAC-verified", async () => {
    await world();
    process.env.NETWORK_SEAT_FEE_INR = "1500";
    const { state_id } = await aStateWithCity();
    const admin = await httpClient(HQ);
    const created = await admin.post(`${BASE}/entities`).send({
      company_name: "VN Paid Branch",
      gstin: "27PQRST6789K1Z2",
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
});
