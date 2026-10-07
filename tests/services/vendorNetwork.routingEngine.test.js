// Vendor Networks routing engine, routing API and sweep (spec §6.2, §10.7, §10.10).
// Pattern B: committed fixtures (ids 95901..95949), removed in afterEach. HTTP through
// httpClient for every endpoint; the sweep through cronManager.runVendorRoutingSweepTick.
//
// The RFQ subject handler is Task 9's; here a FAKE handler is registered under 'RFQ'
// (registerSubject) and restored in afterAll. It records every hook call, and its
// validateSubject / onReleased / listUnrouted answers are set per test.
//
// SMTP: nodemailer.createTransport is swapped for a recorder (assignee emails).

import nodemailer from "nodemailer";
import { db, closeDb } from "../setup/db.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  seedHotel,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { httpClient } from "../helpers/http.js";
import {
  registerSubject,
  assign,
  revokeLiveAssignmentsForEntity,
} from "../../app/services/vendorNetwork/routingEngine.js";
import { runVendorRoutingSweepTick } from "../../app/helper/cronManager.js";
import {
  ROUTING_SWEEP_LOCK_NS,
  ROUTING_SWEEP_LOCK_KEY,
} from "../../app/models/vendorRoutingModel.js";

const HQ = 95901; // principal of ORG
const B1 = 95902; // ACTIVE BRANCH, seated
const B2 = 95903; // ACTIVE DISTRIBUTOR, seated
const SUSP = 95904; // SUSPENDED BRANCH
const FHQ = 95905; // principal of FOREIGN_ORG
const FB = 95906; // ACTIVE BRANCH of FOREIGN_ORG
const MEMBER_P = 95907; // type 11, ENTITY_MEMBER of B1
const ADMIN_P = 95908; // type 11, ORG_ADMIN of ORG
const H1 = 95911;
const H2 = 95912;
const ORG = 95901;
const FOREIGN_ORG = 95902;
const BASE = "/api/v1/vendor-network";
const HOUR = 3600 * 1000;

// --- fake subject handler ---------------------------------------------------------
const calls = [];
const cfg = {};
function resetCfg() {
  cfg.valid = () => ({ ok: true, hotelIds: [H1, H2], categoryId: null });
  cfg.releaseError = null;
  cfg.unrouted = [];
  cfg.gate = null; // a promise listUnrouted awaits (sweep overlap test)
  cfg.onListUnrouted = null;
}
const fake = {
  async validateSubject(args) {
    calls.push(["validate", args.subjectId]);
    return cfg.valid(args);
  },
  async onPending(a) {
    calls.push(["pending", a.id]);
  },
  async onAccepted(a, previous) {
    calls.push(["accepted", a.id, previous?.id ?? null]);
  },
  async onReleased(a, prior) {
    calls.push(["released", a.id, a.status, prior, a.release_reason]);
    if (cfg.releaseError) throw cfg.releaseError;
  },
  async describe(a) {
    return { title: `Fake RFQ ${a.subject_id}`, actionUrl: `/fake/rfq/${a.subject_id}` };
  },
  async listUnrouted(orgId, runner) {
    cfg.onListUnrouted?.();
    if (cfg.gate) await cfg.gate;
    const live = await runner.any(
      `SELECT subject_id FROM tbl_vendor_routing_assignments
        WHERE org_id = $1 AND subject_type = 'RFQ' AND status IN ('PENDING','ACCEPTED')`,
      [orgId]
    );
    const routed = new Set(live.map((r) => r.subject_id));
    return cfg.unrouted.filter((i) => i.orgId === orgId && !routed.has(i.subjectId));
  },
};
let previousRfqHandler;

// --- SMTP recorder ------------------------------------------------------------------
const sent = [];
let realTransport;
let failMail = false;

beforeAll(() => {
  previousRfqHandler = registerSubject("RFQ", fake);
  realTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(mail, cb) {
      if (failMail) {
        // Like nodemailer: with a callback the error goes to the callback only.
        const err = new Error("SMTP down");
        if (typeof cb === "function") return cb(err);
        return Promise.reject(err);
      }
      sent.push(mail);
      const info = { messageId: "<vn-routing>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
});

beforeEach(async () => {
  calls.length = 0;
  sent.length = 0;
  failMail = false;
  resetCfg();
  delete process.env.NETWORK_SEAT_FEE_INR;
  await world();
});

afterEach(async () => {
  delete process.env.NETWORK_SEAT_FEE_INR;
  await cleanupVendorNetworkFixtures();
});

afterAll(async () => {
  registerSubject("RFQ", previousRfqHandler);
  nodemailer.createTransport = realTransport;
  await closeDb();
});

async function world() {
  for (const id of [HQ, B1, B2, SUSP, FHQ, FB]) {
    await seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com` });
  }
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN Routing Org" });
  await addEntity({ orgId: ORG, vendorId: B1 });
  await addEntity({ orgId: ORG, vendorId: B2, relationship: "DISTRIBUTOR" });
  await addEntity({ orgId: ORG, vendorId: SUSP, status: "SUSPENDED" });
  await seedOrg({ id: FOREIGN_ORG, principalVendorId: FHQ, name: "VN Foreign Org" });
  await addEntity({ orgId: FOREIGN_ORG, vendorId: FB });
  await seedPerson({ id: MEMBER_P, email: "vn-routing-member@example.com", name: "Mo Member" });
  await addMember({ orgId: ORG, personId: MEMBER_P, entityVendorId: B1, role: "ENTITY_MEMBER" });
  await seedPerson({ id: ADMIN_P, email: "vn-routing-admin@example.com", name: "Ada Admin" });
  await addMember({ orgId: ORG, personId: ADMIN_P, role: "ORG_ADMIN" });
  await seedHotel({ id: H1, name: "VN Hotel One" });
  await seedHotel({ id: H2, name: "VN Hotel Two" });
}

// --- helpers --------------------------------------------------------------------------
const rowsFor = (subjectId) =>
  db.any(`SELECT * FROM tbl_vendor_routing_assignments WHERE subject_id = $1 AND org_id IN ($2, $3) ORDER BY id`, [
    subjectId,
    ORG,
    FOREIGN_ORG,
  ]);
const getRow = (id) => db.one(`SELECT * FROM tbl_vendor_routing_assignments WHERE id = $1`, [id]);
const notes = (userId, type) =>
  db.any(`SELECT * FROM tbl_notifications WHERE recipient_user_id = $1 AND type = $2 ORDER BY id`, [userId, type]);

async function postAssign(userId, body) {
  return (await httpClient(userId)).post(`${BASE}/routing/assign`).send({ subject_type: "RFQ", ...body });
}
async function postRespond(userId, id, body) {
  return (await httpClient(userId)).post(`${BASE}/routing/${id}/respond`).send(body);
}
async function postRevoke(userId, id) {
  return (await httpClient(userId)).post(`${BASE}/routing/${id}/revoke`).send({});
}
const nearly = (actual, expectedMs, slackMs = 2 * 60 * 1000) =>
  expect(Math.abs(new Date(actual).getTime() - expectedMs)).toBeLessThan(slackMs);

async function insertAssignment({ subjectId, vendorId = B1, status = "PENDING", dueAt = null, orgId = ORG }) {
  return db.one(
    `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, assigned_vendor_id, status, due_at)
     VALUES ($1, 'RFQ', $2, $3, $4, $5) RETURNING *`,
    [orgId, subjectId, vendorId, status, dueAt]
  );
}

// --- tests ------------------------------------------------------------------------------

describe("assign", () => {
  it("1. admin assigns → PENDING, onPending ran, assignee notified + emailed (entity and member persons)", async () => {
    const res = await postAssign(ADMIN_P, { subject_id: 7001, assignee_vendor_id: B1 });
    expect(res.status).toBe(201);
    const [row] = await rowsFor(7001);
    expect(row).toMatchObject({
      org_id: ORG,
      subject_type: "RFQ",
      subject_id: 7001,
      hotel_id: null,
      assigned_vendor_id: B1,
      status: "PENDING",
      auto_routed: false,
      assigned_by_user_id: ADMIN_P,
    });
    expect(res.body.data.id).toBe(row.id);
    expect(calls).toEqual([["validate", 7001], ["pending", row.id]]);

    const [n] = await notes(B1, "NETWORK_ROUTING_ASSIGNED");
    expect(n).toMatchObject({ category: "network", action_url: "/fake/rfq/7001" });
    expect(sent.map((m) => m.to).sort()).toEqual(["vn-95902@example.com", "vn-routing-member@example.com"]);
    expect(sent[0].subject).toContain("Fake RFQ 7001");
  });

  it("1b. a failing mailer never fails the assignment", async () => {
    failMail = true;
    const res = await postAssign(HQ, { subject_id: 7002, assignee_vendor_id: B1 });
    expect(res.status).toBe(201);
    expect((await rowsFor(7002)).map((r) => r.status)).toEqual(["PENDING"]);
  });

  it("2. re-assigning while PENDING revokes the old one (onReleased REASSIGNED) and tells its assignee", async () => {
    const first = (await postAssign(HQ, { subject_id: 7010, assignee_vendor_id: B1 })).body.data;
    const res = await postAssign(HQ, { subject_id: 7010, assignee_vendor_id: B2 });
    expect(res.status).toBe(201);
    const rows = await rowsFor(7010);
    expect(rows.map((r) => [r.assigned_vendor_id, r.status])).toEqual([
      [B1, "REVOKED"],
      [B2, "PENDING"],
    ]);
    expect(rows[0].acted_by_user_id).toBe(HQ);
    expect(calls).toContainEqual(["released", first.id, "REVOKED", "PENDING", "REASSIGNED"]);
    expect(await notes(B1, "NETWORK_ROUTING_REVOKED")).toHaveLength(1);
    expect(await notes(B2, "NETWORK_ROUTING_ASSIGNED")).toHaveLength(1);
  });

  it("6. a non-admin cannot assign, revoke or read the queue (403)", async () => {
    for (const user of [B1, MEMBER_P]) {
      expect((await postAssign(user, { subject_id: 7020, assignee_vendor_id: B2 })).status).toBe(403);
      expect((await (await httpClient(user)).get(`${BASE}/routing/queue`)).status).toBe(403);
    }
    const a = await insertAssignment({ subjectId: 7020, vendorId: B2 });
    expect((await postRevoke(B1, a.id)).status).toBe(403);
    expect(await rowsFor(7020)).toHaveLength(1);
  });

  it("7. the assignee must be an ACTIVE, seated, non-principal entity of the caller's org (else 409 ASSIGNEE_NOT_ELIGIBLE)", async () => {
    for (const target of [FB, SUSP, HQ, 2147483647]) {
      const res = await postAssign(HQ, { subject_id: 7030, assignee_vendor_id: target });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("ASSIGNEE_NOT_ELIGIBLE");
    }
    // A member entity whose seat is unpaid while seats cost money cannot be assigned either.
    process.env.NETWORK_SEAT_FEE_INR = "1500";
    await db.none(`UPDATE tbl_vendor_network_seats SET status = 'pending' WHERE entity_vendor_id = $1`, [B1]);
    expect((await postAssign(HQ, { subject_id: 7030, assignee_vendor_id: B1 })).body.reason).toBe("ASSIGNEE_NOT_ELIGIBLE");
    expect(await rowsFor(7030)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("input validation: subject_type, subject_id and assignee are required (400)", async () => {
    expect((await postAssign(HQ, { subject_type: "PO", subject_id: 1, assignee_vendor_id: B1 })).status).toBe(400);
    expect((await postAssign(HQ, { subject_id: "x", assignee_vendor_id: B1 })).status).toBe(400);
    expect((await postAssign(HQ, { subject_id: 7031 })).status).toBe(400);
    expect((await postAssign(HQ, { subject_id: 7031, hotel_id: -1, assignee_vendor_id: B1 })).status).toBe(400);
  });

  it("9. RFQ due_at capped by bid end: dueCap now+2h with a 24h org timeout → due_at ≈ now+2h", async () => {
    const cap = Date.now() + 2 * HOUR;
    cfg.valid = () => ({ ok: true, hotelIds: [H1], categoryId: null, dueCap: new Date(cap) });
    expect((await db.one(`SELECT routing_timeout_hours FROM tbl_vendor_orgs WHERE id = $1`, [ORG])).routing_timeout_hours).toBe(24);
    expect((await postAssign(HQ, { subject_id: 7040, assignee_vendor_id: B1 })).status).toBe(201);
    nearly((await rowsFor(7040))[0].due_at, cap);
  });

  it("10. due floor: a dueCap already in the past → due_at = now+1h; no cap → now + org timeout", async () => {
    cfg.valid = () => ({ ok: true, hotelIds: [H1], categoryId: null, dueCap: new Date(Date.now() - 5 * HOUR) });
    expect((await postAssign(HQ, { subject_id: 7050, assignee_vendor_id: B1 })).status).toBe(201);
    nearly((await rowsFor(7050))[0].due_at, Date.now() + HOUR);

    await db.none(`UPDATE tbl_vendor_orgs SET routing_timeout_hours = 5 WHERE id = $1`, [ORG]);
    cfg.valid = () => ({ ok: true, hotelIds: [H1], categoryId: null });
    expect((await postAssign(HQ, { subject_id: 7051, assignee_vendor_id: B1 })).status).toBe(201);
    nearly((await rowsFor(7051))[0].due_at, Date.now() + 5 * HOUR);
  });

  it("12. two concurrent assigns for one subject serialise on the subject lock: both 201, one REVOKED, one PENDING", async () => {
    const results = await Promise.all([
      postAssign(HQ, { subject_id: 7060, assignee_vendor_id: B1 }),
      postAssign(HQ, { subject_id: 7060, assignee_vendor_id: B2 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const rows = await rowsFor(7060);
    expect(rows.map((r) => r.status)).toEqual(["REVOKED", "PENDING"]);
    expect(new Set(rows.map((r) => r.assigned_vendor_id))).toEqual(new Set([B1, B2]));
  });

  it("attribution: assigned_by_user_id / acted_by_user_id are the PERSON ids, not the entity", async () => {
    // A type-11 ORG_ADMIN (acting as the principal) assigns; a type-11 member of B1 accepts.
    const a = (await postAssign(ADMIN_P, { subject_id: 7065, assignee_vendor_id: B1 })).body.data;
    expect((await postRespond(MEMBER_P, a.id, { decision: "ACCEPT" })).status).toBe(200);
    expect(await getRow(a.id)).toMatchObject({ assigned_by_user_id: ADMIN_P, acted_by_user_id: MEMBER_P });
    // ... and when it is revoked, the revoke is the admin person's.
    expect((await postRevoke(ADMIN_P, a.id)).status).toBe(200);
    expect(await getRow(a.id)).toMatchObject({ status: "REVOKED", acted_by_user_id: ADMIN_P });
    // A declining member is recorded as itself.
    const b = (await postAssign(ADMIN_P, { subject_id: 7066, assignee_vendor_id: B1 })).body.data;
    expect((await postRespond(MEMBER_P, b.id, { decision: "DECLINE", reason: "NO_STOCK" })).status).toBe(200);
    expect(await getRow(b.id)).toMatchObject({ status: "DECLINED", acted_by_user_id: MEMBER_P });
  });

  it("handler refusals propagate with their status: validateSubject {ok:false} → that status, nothing written", async () => {
    cfg.valid = () => ({ ok: false, http: 404, message: "RFQ not found" });
    const res = await postAssign(HQ, { subject_id: 7070, assignee_vendor_id: B1 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 0, message: "RFQ not found" });
    expect(await rowsFor(7070)).toEqual([]);
  });

  it("a hook that throws {http, message, code} rolls the whole transition back", async () => {
    const pending = await insertAssignment({ subjectId: 7071, vendorId: B1 });
    cfg.releaseError = { http: 409, message: "The member has submitted a quote", code: "QUOTE_SUBMITTED" };
    // Re-assigning must revoke the PENDING one; its onReleased refuses → nothing changes.
    const res = await postAssign(HQ, { subject_id: 7071, assignee_vendor_id: B2 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("QUOTE_SUBMITTED");
    expect((await rowsFor(7071)).map((r) => [r.id, r.status])).toEqual([[pending.id, "PENDING"]]);
  });
});

describe("respond", () => {
  it("3. accept → ACCEPTED (principal notified); a second assign+accept supersedes the first; same-vendor reassign → 409", async () => {
    const a1 = (await postAssign(HQ, { subject_id: 7100, assignee_vendor_id: B1 })).body.data;
    const ok = await postRespond(MEMBER_P, a1.id, { decision: "ACCEPT" });
    expect(ok.status).toBe(200);
    expect(await getRow(a1.id)).toMatchObject({ status: "ACCEPTED", acted_by_user_id: MEMBER_P });
    expect(calls).toContainEqual(["accepted", a1.id, null]);
    expect(await notes(HQ, "NETWORK_ROUTING_ACCEPTED")).toHaveLength(1);

    const again = await postAssign(HQ, { subject_id: 7100, assignee_vendor_id: B1 });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("ALREADY_ACCEPTED");

    const a2 = (await postAssign(HQ, { subject_id: 7100, assignee_vendor_id: B2 })).body.data;
    expect((await rowsFor(7100)).map((r) => r.status)).toEqual(["ACCEPTED", "PENDING"]);
    expect((await postRespond(B2, a2.id, { decision: "ACCEPT" })).status).toBe(200);
    expect((await rowsFor(7100)).map((r) => [r.assigned_vendor_id, r.status])).toEqual([
      [B1, "SUPERSEDED"],
      [B2, "ACCEPTED"],
    ]);
    expect(calls).toContainEqual(["released", a1.id, "SUPERSEDED", "ACCEPTED", "SUPERSEDED"]);
    expect(calls).toContainEqual(["accepted", a2.id, a1.id]);
  });

  it("4. decline needs a valid reason, and a note for OTHER (400); then DECLINED, principal notified", async () => {
    const a = (await postAssign(HQ, { subject_id: 7110, assignee_vendor_id: B1 })).body.data;
    expect((await postRespond(B1, a.id, { decision: "DECLINE" })).status).toBe(400);
    expect((await postRespond(B1, a.id, { decision: "DECLINE", reason: "TOO_BUSY" })).status).toBe(400);
    expect((await postRespond(B1, a.id, { decision: "DECLINE", reason: "OTHER" })).status).toBe(400);
    expect((await postRespond(B1, a.id, { decision: "DECLINE", reason: "OTHER", note: "   " })).status).toBe(400);
    expect((await postRespond(B1, a.id, { decision: "MAYBE" })).status).toBe(400);
    expect((await getRow(a.id)).status).toBe("PENDING");

    const res = await postRespond(B1, a.id, { decision: "DECLINE", reason: "OTHER", note: "Warehouse closed" });
    expect(res.status).toBe(200);
    expect(await getRow(a.id)).toMatchObject({
      status: "DECLINED",
      decline_reason: "OTHER",
      decline_note: "Warehouse closed",
      acted_by_user_id: B1,
    });
    expect(calls).toContainEqual(["released", a.id, "DECLINED", "PENDING", "DECLINED"]);
    const [n] = await notes(HQ, "NETWORK_ROUTING_DECLINED");
    expect(n.message).toContain("Warehouse closed");
    // Already answered.
    expect((await postRespond(B1, a.id, { decision: "ACCEPT" })).status).toBe(409);
  });

  it("5. anyone but the assignee gets 404: a sibling, the principal, another org", async () => {
    const a = (await postAssign(HQ, { subject_id: 7120, assignee_vendor_id: B1 })).body.data;
    for (const user of [B2, HQ, ADMIN_P, FB, FHQ]) {
      expect((await postRespond(user, a.id, { decision: "ACCEPT" })).status).toBe(404);
    }
    expect((await postRespond(B1, 2147483647, { decision: "ACCEPT" })).status).toBe(404);
    expect((await getRow(a.id)).status).toBe("PENDING");
  });

  it("an overdue PENDING answered before the sweep ran times out instead (409 EXPIRED)", async () => {
    const a = await insertAssignment({ subjectId: 7130, dueAt: new Date(Date.now() - 60 * 1000) });
    const res = await postRespond(B1, a.id, { decision: "ACCEPT" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("EXPIRED");
    expect((await getRow(a.id)).status).toBe("TIMED_OUT");
    expect(await notes(HQ, "NETWORK_ROUTING_TIMED_OUT")).toHaveLength(1);
  });

  it("GET /routing/assigned-to-me lists only the acting entity's live assignments", async () => {
    const a = (await postAssign(HQ, { subject_id: 7140, assignee_vendor_id: B1 })).body.data;
    await postAssign(HQ, { subject_id: 7141, assignee_vendor_id: B2 });
    const mine = await (await httpClient(MEMBER_P)).get(`${BASE}/routing/assigned-to-me`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((r) => [r.id, r.title, r.action_url])).toEqual([[a.id, "Fake RFQ 7140", "/fake/rfq/7140"]]);
    expect((await (await httpClient(B1)).get(`${BASE}/routing/assigned-to-me?status=DECLINED`)).body.data).toEqual([]);
    expect((await (await httpClient(B1)).get(`${BASE}/routing/assigned-to-me?status=NOPE`)).status).toBe(400);
  });
});

describe("revoke", () => {
  it("admin revokes PENDING or ACCEPTED; another org's assignment is 404; a terminal one 409", async () => {
    const a = (await postAssign(HQ, { subject_id: 7200, assignee_vendor_id: B1 })).body.data;
    expect((await postRevoke(FHQ, a.id)).status).toBe(404);
    const res = await postRevoke(ADMIN_P, a.id);
    expect(res.status).toBe(200);
    expect(await getRow(a.id)).toMatchObject({ status: "REVOKED", acted_by_user_id: ADMIN_P });
    expect(await notes(B1, "NETWORK_ROUTING_REVOKED")).toHaveLength(1);
    expect((await postRevoke(HQ, a.id)).status).toBe(409);

    const accepted = await insertAssignment({ subjectId: 7201, status: "ACCEPTED" });
    expect((await postRevoke(HQ, accepted.id)).status).toBe(200);
    expect(calls).toContainEqual(["released", accepted.id, "REVOKED", "ACCEPTED", "ADMIN_REVOKED"]);

    const foreign = await insertAssignment({ subjectId: 7202, vendorId: FB, orgId: FOREIGN_ORG });
    expect((await postRevoke(HQ, foreign.id)).status).toBe(404);
    expect((await getRow(foreign.id)).status).toBe("PENDING");
  });

  it("onReleased refusing (RFQ quote submitted) → 409 with its code, still ACCEPTED", async () => {
    const accepted = await insertAssignment({ subjectId: 7210, status: "ACCEPTED" });
    cfg.releaseError = { http: 409, message: "The member has submitted a quote", code: "QUOTE_SUBMITTED" };
    const res = await postRevoke(HQ, accepted.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 0, reason: "QUOTE_SUBMITTED" });
    expect((await getRow(accepted.id)).status).toBe("ACCEPTED");
  });

  it("revokeLiveAssignmentsForEntity revokes every live row of the entity in that org and counts them", async () => {
    const p = await insertAssignment({ subjectId: 7220, status: "PENDING" });
    const acc = await insertAssignment({ subjectId: 7221, status: "ACCEPTED" });
    const done = await insertAssignment({ subjectId: 7222, status: "DECLINED" });
    const other = await insertAssignment({ subjectId: 7223, vendorId: B2 });
    // B1's row from a former org (it left FOREIGN_ORG earlier): not this org's to revoke.
    const former = await insertAssignment({ subjectId: 7224, vendorId: B1, orgId: FOREIGN_ORG });
    expect(await revokeLiveAssignmentsForEntity(B1, { orgId: ORG, actorUserId: HQ, reason: "ENTITY_SUSPENDED" })).toBe(2);
    expect((await getRow(former.id)).status).toBe("PENDING");
    expect((await getRow(p.id)).status).toBe("REVOKED");
    expect((await getRow(acc.id)).status).toBe("REVOKED");
    expect((await getRow(done.id)).status).toBe("DECLINED");
    expect((await getRow(other.id)).status).toBe("PENDING");
    expect(calls).toContainEqual(["released", acc.id, "REVOKED", "ACCEPTED", "ENTITY_SUSPENDED"]);
  });
});

describe("routing queue", () => {
  it("lists unrouted subjects with candidates (decliners excluded) and live / declined assignments", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode)
       VALUES ($1, 'HOTEL', $3, 'INCLUDE'), ($1, 'HOTEL', $4, 'INCLUDE'), ($2, 'HOTEL', $3, 'INCLUDE')`,
      [B1, B2, H1, H2]
    );
    cfg.unrouted = [
      { orgId: ORG, subjectId: 7300, hotelId: null, hotelIds: [H1, H2], categoryId: null, title: "RFQ 7300" },
      { orgId: ORG, subjectId: 7301, hotelId: null, hotelIds: [H1], categoryId: null, title: "RFQ 7301" },
    ];
    const declined = await insertAssignment({ subjectId: 7301, vendorId: B1, status: "DECLINED" });
    await db.none(`UPDATE tbl_vendor_routing_assignments SET acted_at = now(), decline_reason = 'NO_STOCK' WHERE id = $1`, [declined.id]);
    const pending = await insertAssignment({ subjectId: 7302, vendorId: B2 });

    const res = await (await httpClient(HQ)).get(`${BASE}/routing/queue`);
    expect(res.status).toBe(200);
    const { unrouted, pending: live, accepted, declined: refused } = res.body.data;
    expect(unrouted.map((u) => [u.subject_id, u.candidates.map((c) => [c.vendor_id, c.covers_all_hotels])])).toEqual([
      [7300, [[B1, true], [B2, false]]],
      [7301, [[B2, true]]], // B1 declined 7301
    ]);
    expect(live.map((r) => [r.id, r.title])).toEqual([[pending.id, "Fake RFQ 7302"]]);
    expect(accepted).toEqual([]);
    expect(refused.map((r) => [r.id, r.candidates.map((c) => c.vendor_id)])).toEqual([[declined.id, [B2]]]);
  });

  // Task 20 / D3: the admin is told WHY a covering entity is not suggested, and a pending
  // row carries the same suggestions so "already pending with X" can be said.
  it("names covering entities left out (DECLINED / TIMED_OUT, latest refusal wins) and suggests for pending rows", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode)
       VALUES ($1, 'HOTEL', $3, 'INCLUDE'), ($2, 'HOTEL', $3, 'INCLUDE')`,
      [B1, B2, H1]
    );
    cfg.valid = () => ({ ok: true, hotelIds: [H1], categoryId: null });
    cfg.unrouted = [{ orgId: ORG, subjectId: 7310, hotelId: null, hotelIds: [H1], categoryId: null, title: "RFQ 7310" }];
    const refuse = async (vendorId, status, agoHours) => {
      const row = await insertAssignment({ subjectId: 7310, vendorId, status });
      await db.none(`UPDATE tbl_vendor_routing_assignments SET acted_at = now() - $2 * interval '1 hour' WHERE id = $1`, [
        row.id,
        agoHours,
      ]);
    };
    await refuse(B1, "TIMED_OUT", 3);
    await refuse(B1, "DECLINED", 1); // B1's latest refusal
    await refuse(B2, "TIMED_OUT", 2);
    const pending = await insertAssignment({ subjectId: 7311, vendorId: B2 });

    const { unrouted, pending: live, declined } = (await (await httpClient(HQ)).get(`${BASE}/routing/queue`)).body.data;
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0].candidates).toEqual([]);
    expect(unrouted[0].excluded).toEqual([
      { vendor_id: B1, name: `VN ${B1}`, reason: "DECLINED" },
      { vendor_id: B2, name: `VN ${B2}`, reason: "TIMED_OUT" },
    ]);
    // The refused rows of 7310 carry the same, from the queued entry.
    expect(declined.map((r) => r.excluded.map((e) => e.reason))).toEqual(declined.map(() => ["DECLINED", "TIMED_OUT"]));

    const [p] = live;
    expect(p.id).toBe(pending.id);
    expect(p.candidates.map((c) => c.vendor_id)).toEqual([B1, B2]); // the pending assignee included
    expect(p.excluded).toEqual([]);
  });

  // Fix round 1 / review minor 3: an entity that declined earlier and was then assigned
  // again by hand is the live assignee, not a refusal.
  it("never lists the live assignee among the excluded, even after an earlier refusal", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode)
       VALUES ($1, 'HOTEL', $3, 'INCLUDE'), ($2, 'HOTEL', $3, 'INCLUDE')`,
      [B1, B2, H1]
    );
    cfg.valid = () => ({ ok: true, hotelIds: [H1], categoryId: null });
    const declined = await insertAssignment({ subjectId: 7320, vendorId: B1, status: "DECLINED" });
    await db.none(`UPDATE tbl_vendor_routing_assignments SET acted_at = now() - interval '1 hour' WHERE id = $1`, [declined.id]);
    await insertAssignment({ subjectId: 7320, vendorId: B2, status: "TIMED_OUT" });
    const live = await insertAssignment({ subjectId: 7320, vendorId: B1 }); // re-assigned by hand

    const data = (await (await httpClient(HQ)).get(`${BASE}/routing/queue`)).body.data;
    const pendingRow = data.pending.find((r) => r.id === live.id);
    expect(pendingRow.excluded).toEqual([{ vendor_id: B2, name: `VN ${B2}`, reason: "TIMED_OUT" }]);
    expect(pendingRow.candidates.map((c) => c.vendor_id)).toEqual([B1]);
    const refusedRow = data.declined.find((r) => r.id === declined.id);
    expect(refusedRow.excluded.map((e) => e.vendor_id)).toEqual([B2]);
  });
});

describe("two orgs routing the same subject", () => {
  const orgRows = (orgId, subjectId) =>
    db.any(
      `SELECT id, assigned_vendor_id, status FROM tbl_vendor_routing_assignments
        WHERE org_id = $1 AND subject_id = $2 ORDER BY id`,
      [orgId, subjectId]
    );

  it("assign / accept / revoke in org B never touch org A's rows of the same RFQ", async () => {
    const a = (await postAssign(HQ, { subject_id: 7800, assignee_vendor_id: B1 })).body.data;
    const b1 = await postAssign(FHQ, { subject_id: 7800, assignee_vendor_id: FB });
    expect(b1.status).toBe(201);
    expect((await orgRows(ORG, 7800)).map((r) => [r.id, r.status])).toEqual([[a.id, "PENDING"]]);

    expect((await postRespond(FB, b1.body.data.id, { decision: "ACCEPT" })).status).toBe(200);
    expect((await postRespond(B1, a.id, { decision: "ACCEPT" })).status).toBe(200);
    expect((await orgRows(ORG, 7800)).map((r) => r.status)).toEqual(["ACCEPTED"]);
    expect((await orgRows(FOREIGN_ORG, 7800)).map((r) => r.status)).toEqual(["ACCEPTED"]);

    expect((await postRevoke(FHQ, b1.body.data.id)).status).toBe(200);
    const b2 = await postAssign(FHQ, { subject_id: 7800, assignee_vendor_id: FB });
    expect(b2.status).toBe(201);
    expect((await orgRows(FOREIGN_ORG, 7800)).map((r) => r.status)).toEqual(["REVOKED", "PENDING"]);
    expect((await orgRows(ORG, 7800)).map((r) => [r.id, r.status])).toEqual([[a.id, "ACCEPTED"]]);
    // No hook ever released org A's row.
    expect(calls.filter((c) => c[0] === "released" && c[1] === a.id)).toEqual([]);
    // Org A cannot revoke org B's row either.
    expect((await postRevoke(HQ, b2.body.data.id)).status).toBe(404);
  });

  it("auto-routing works in both orgs for the same RFQ", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode)
       VALUES ($1, 'HOTEL', $3, 'INCLUDE'), ($2, 'HOTEL', $3, 'INCLUDE')`,
      [B1, FB, H1]
    );
    await db.none(`UPDATE tbl_vendor_orgs SET routing_mode = 'AUTO_SINGLE_MATCH' WHERE id IN ($1, $2)`, [ORG, FOREIGN_ORG]);
    cfg.unrouted = [ORG, FOREIGN_ORG].map((orgId) => ({
      orgId, subjectId: 7801, hotelId: null, hotelIds: [H1], categoryId: null,
    }));
    expect(await runVendorRoutingSweepTick()).toMatchObject({ skipped: false, autoRouted: 2 });
    expect((await orgRows(ORG, 7801)).map((r) => [r.assigned_vendor_id, r.status])).toEqual([[B1, "PENDING"]]);
    expect((await orgRows(FOREIGN_ORG, 7801)).map((r) => [r.assigned_vendor_id, r.status])).toEqual([[FB, "PENDING"]]);
  });
});

describe("sweep", () => {
  it("8. times out overdue PENDING rows and notifies the principal (no acting person)", async () => {
    const overdue = await insertAssignment({ subjectId: 7400, dueAt: new Date(Date.now() - HOUR) });
    const future = await insertAssignment({ subjectId: 7401, dueAt: new Date(Date.now() + HOUR) });
    const result = await runVendorRoutingSweepTick();
    expect(result).toMatchObject({ skipped: false, timedOut: 1 });
    expect((await getRow(overdue.id)).status).toBe("TIMED_OUT");
    expect((await getRow(future.id)).status).toBe("PENDING");
    expect(calls).toContainEqual(["released", overdue.id, "TIMED_OUT", "PENDING", "TIMED_OUT"]);
    expect(await notes(HQ, "NETWORK_ROUTING_TIMED_OUT")).toHaveLength(1);
    expect((await getRow(overdue.id)).acted_by_user_id).toBeNull();
    // Idempotent: a second tick finds nothing.
    expect(await runVendorRoutingSweepTick()).toMatchObject({ skipped: false, timedOut: 0 });
  });

  it("self-heals: live rows whose assignee is no longer an ACTIVE entity of the org (suspended, removed, left) are REVOKED", async () => {
    const p = await insertAssignment({ subjectId: 7410, vendorId: B1 });
    const acc = await insertAssignment({ subjectId: 7411, vendorId: B1, status: "ACCEPTED" });
    const left = await insertAssignment({ subjectId: 7412, vendorId: B2, status: "ACCEPTED" });
    const keep = await insertAssignment({ subjectId: 7413, vendorId: FB, orgId: FOREIGN_ORG });
    // Suspended / left without the post-commit revoke having run: B1 suspended; B2 left
    // ORG and is now ACTIVE in FOREIGN_ORG (ACTIVE somewhere, but not in the row's org).
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [B1]);
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'REMOVED', removed_at = now() WHERE vendor_id = $1`, [B2]);
    await addEntity({ orgId: FOREIGN_ORG, vendorId: B2, withSeat: false });

    expect(await runVendorRoutingSweepTick()).toMatchObject({ skipped: false, revoked: 3 });
    expect((await getRow(p.id)).status).toBe("REVOKED");
    expect((await getRow(acc.id)).status).toBe("REVOKED");
    expect((await getRow(left.id)).status).toBe("REVOKED");
    expect(calls).toContainEqual(["released", acc.id, "REVOKED", "ACCEPTED", "ENTITY_NOT_ACTIVE"]);
    expect((await getRow(keep.id)).status).toBe("PENDING");
    expect(await runVendorRoutingSweepTick()).toMatchObject({ revoked: 0 });
  });

  it("11. auto-route: only on a single full-coverage candidate, never back to a decliner, never in ADMIN_ROUTES orgs", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode)
       VALUES ($1, 'HOTEL', $3, 'INCLUDE'), ($1, 'HOTEL', $4, 'INCLUDE'), ($2, 'HOTEL', $3, 'INCLUDE')`,
      [B1, B2, H1, H2]
    );
    cfg.unrouted = [
      { orgId: ORG, subjectId: 7500, hotelId: null, hotelIds: [H1, H2], categoryId: null }, // B1 only full → assign B1
      { orgId: ORG, subjectId: 7501, hotelId: null, hotelIds: [H1], categoryId: null }, // B1 and B2 full → skip
      { orgId: ORG, subjectId: 7502, hotelId: null, hotelIds: [H1, H2], categoryId: null }, // B1 declined → skip
      { orgId: ORG, subjectId: 7503, hotelId: null, hotelIds: [H2], categoryId: null }, // B1 timed out → skip
    ];
    await insertAssignment({ subjectId: 7502, vendorId: B1, status: "DECLINED" });
    await insertAssignment({ subjectId: 7503, vendorId: B1, status: "TIMED_OUT" });

    // ADMIN_ROUTES (default): nothing is auto-routed.
    expect(await runVendorRoutingSweepTick()).toMatchObject({ skipped: false, autoRouted: 0 });

    await db.none(`UPDATE tbl_vendor_orgs SET routing_mode = 'AUTO_SINGLE_MATCH' WHERE id = $1`, [ORG]);
    expect(await runVendorRoutingSweepTick()).toMatchObject({ autoRouted: 1 });
    expect((await rowsFor(7500)).map((r) => [r.assigned_vendor_id, r.status, r.auto_routed, r.assigned_by_user_id])).toEqual([
      [B1, "PENDING", true, null],
    ]);
    expect(await rowsFor(7501)).toEqual([]);
    expect((await rowsFor(7502)).map((r) => r.status)).toEqual(["DECLINED"]);
    expect((await rowsFor(7503)).map((r) => r.status)).toEqual(["TIMED_OUT"]);
    expect(await notes(B1, "NETWORK_ROUTING_ASSIGNED")).toHaveLength(1);

    // Idempotent; and once B1 declines 7500 it is not routed back to B1.
    expect(await runVendorRoutingSweepTick()).toMatchObject({ autoRouted: 0 });
    const [row] = await rowsFor(7500);
    expect((await postRespond(B1, row.id, { decision: "DECLINE", reason: "NO_STOCK" })).status).toBe(200);
    expect(await runVendorRoutingSweepTick()).toMatchObject({ autoRouted: 0 });
    expect((await rowsFor(7500)).map((r) => r.status)).toEqual(["DECLINED"]);
  });

  it("13. advisory lock: a tick that overlaps a running one returns { skipped: true }", async () => {
    await db.none(`UPDATE tbl_vendor_orgs SET routing_mode = 'AUTO_SINGLE_MATCH' WHERE id = $1`, [ORG]);
    let release;
    let entered;
    const inside = new Promise((r) => {
      entered = r;
    });
    cfg.gate = new Promise((r) => {
      release = r;
    });
    cfg.onListUnrouted = () => entered();
    const first = runVendorRoutingSweepTick();
    await inside; // the first tick holds the lock and is parked in listUnrouted
    expect(await runVendorRoutingSweepTick()).toEqual({ skipped: true });
    release();
    expect(await first).toMatchObject({ skipped: false });

    // Held by another session (another app instance) → skipped too; free again afterwards.
    cfg.gate = null;
    cfg.onListUnrouted = null;
    await db.task(async (c) => {
      await c.one(`SELECT pg_advisory_lock($1::int, hashtext($2))`, [ROUTING_SWEEP_LOCK_NS, ROUTING_SWEEP_LOCK_KEY]);
      try {
        expect(await runVendorRoutingSweepTick()).toEqual({ skipped: true });
      } finally {
        await c.one(`SELECT pg_advisory_unlock($1::int, hashtext($2))`, [ROUTING_SWEEP_LOCK_NS, ROUTING_SWEEP_LOCK_KEY]);
      }
    });
    expect(await runVendorRoutingSweepTick()).toMatchObject({ skipped: false });
  });

  it("auto-routing never overrides a PENDING assignment made in the meantime", async () => {
    const admin = await assign({
      orgId: ORG,
      subjectType: "RFQ",
      subjectId: 7600,
      assigneeVendorId: B2,
      actorUserId: HQ,
    });
    const auto = await assign({
      orgId: ORG,
      subjectType: "RFQ",
      subjectId: 7600,
      assigneeVendorId: B1,
      actorUserId: null,
      autoRouted: true,
      ifUnrouted: true,
    });
    expect(auto).toBeNull();
    expect((await rowsFor(7600)).map((r) => [r.id, r.status])).toEqual([[admin.id, "PENDING"]]);
  });
});
