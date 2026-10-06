// Vendor Networks delivery (spec §4.4): socket room of the acting entity, and web-push
// fan-out to the people who act for an entity. Only the web-push sender is mocked.
// Pattern B: committed fixtures (ids 95001..95999), removed in afterEach.

import { jest, describe, it, expect, afterEach, afterAll } from "@jest/globals";
import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import Config from "../../app/config/app.config.js";

const sendNotification = jest.fn(() => Promise.resolve());
jest.unstable_mockModule("web-push", () => ({
  default: { setVapidDetails: () => {}, sendNotification },
}));

const { db, closeDb } = await import("../setup/db.js");
const { dispatch } = await import("../../app/services/notificationService.js");
const { resolveSocketUserRoom } = await import("../../app/util/socket.js");
const seed = await import("../helpers/vendorNetworkSeed.js");

const cryptr = new Cryptr(Config.cryptR.secret);

const LONE = 95601;
const HQ = 95602;
const BRANCH = 95603;
const FOREIGN_HQ = 95604;
const ADMIN_PERSON = 95701;
const MEMBER_PERSON = 95702;
const DISABLED_PERSON = 95703;
const ORG = 95601;
const FOREIGN_ORG = 95602;
const ALL = [LONE, HQ, BRANCH, FOREIGN_HQ, ADMIN_PERSON, MEMBER_PERSON, DISABLED_PERSON];

async function world() {
  for (const id of [LONE, HQ, BRANCH, FOREIGN_HQ]) {
    await seed.seedVendorEntity({ id, companyId: id, name: `VN ${id}`, email: `vn-${id}@example.com` });
  }
  await seed.seedOrg({ id: ORG, principalVendorId: HQ, name: "VN Push Org" });
  await seed.addEntity({ orgId: ORG, vendorId: BRANCH });
  await seed.seedOrg({ id: FOREIGN_ORG, principalVendorId: FOREIGN_HQ, name: "Foreign" });
  await seed.seedPerson({ id: ADMIN_PERSON, email: "vn-push-admin@example.com", name: "Admin" });
  await seed.seedPerson({ id: MEMBER_PERSON, email: "vn-push-member@example.com", name: "Member" });
  await seed.seedPerson({ id: DISABLED_PERSON, email: "vn-push-off@example.com", name: "Off" });
  await seed.addMember({ orgId: ORG, personId: ADMIN_PERSON, role: "ORG_ADMIN" });
  await seed.addMember({ orgId: ORG, personId: MEMBER_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER" });
  await seed.addMember({
    orgId: ORG, personId: DISABLED_PERSON, entityVendorId: BRANCH, role: "ENTITY_MEMBER", status: "DISABLED",
  });
  for (const id of ALL) {
    await db.none(
      `INSERT INTO tbl_push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, 'k', 'a')`,
      [id, `https://push.test/vn-${id}`]
    );
  }
}

const endpointsPushed = () => sendNotification.mock.calls.map(([sub]) => sub.endpoint).sort();
const ep = (id) => `https://push.test/vn-${id}`;

const token = (userId, ent) => {
  const now = Math.round(Date.now() / 1000);
  return JWT.sign(
    {
      sub: cryptr.encrypt(String(userId)),
      user: true,
      ag: cryptr.encrypt("jest-test-agent"),
      ...(ent ? { ent: cryptr.encrypt(String(ent)) } : {}),
      iat: now,
      exp: now + 600,
    },
    Config.jwt.secret
  );
};

afterEach(async () => {
  sendNotification.mockClear();
  await db.none(`DELETE FROM tbl_push_subscriptions WHERE user_id = ANY($1::int[])`, [ALL]);
  await db.none(`DELETE FROM tbl_notifications WHERE recipient_user_id = ANY($1::int[])`, [ALL]);
  await seed.cleanupVendorNetworkFixtures();
});

afterAll(closeDb);

describe("web-push fan-out to the people acting for an entity", () => {
  it("a branch's push reaches its ACTIVE member, not disabled members or the org admin", async () => {
    await world();
    const [row] = await dispatch({ userIds: [BRANCH], title: "New RFQ", body: "b" });
    expect(endpointsPushed()).toEqual([ep(BRANCH), ep(MEMBER_PERSON)].sort());

    const memberCall = sendNotification.mock.calls.find(([sub]) => sub.endpoint === ep(MEMBER_PERSON));
    expect(JSON.parse(memberCall[1]).id).toBe(row.id); // the entity's row, so a click marks it read

    // Persisted rows stay addressed to the entity only.
    const rows = await db.any(`SELECT recipient_user_id FROM tbl_notifications WHERE id = $1`, [row.id]);
    expect(rows).toEqual([{ recipient_user_id: BRANCH }]);
  });

  it("the principal's push also reaches ORG_ADMIN persons", async () => {
    await world();
    await dispatch({ userIds: [HQ], title: "PO", body: "b" });
    expect(endpointsPushed()).toEqual([ep(HQ), ep(ADMIN_PERSON)].sort());
  });

  it("each subscription is pushed once when entity and person are both recipients", async () => {
    await world();
    await dispatch({ userIds: [BRANCH, MEMBER_PERSON, HQ], title: "x", body: "b" });
    expect(endpointsPushed()).toEqual([ep(BRANCH), ep(MEMBER_PERSON), ep(HQ), ep(ADMIN_PERSON)].sort());
  });

  it("a vendor in no network is pushed exactly as before", async () => {
    await world();
    await dispatch({ userIds: [LONE], title: "x", body: "b" });
    expect(endpointsPushed()).toEqual([ep(LONE)]);
  });

  it("a SUSPENDED entity's people get nothing", async () => {
    await world();
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [BRANCH]);
    await dispatch({ userIds: [BRANCH], title: "x", body: "b" });
    expect(endpointsPushed()).toEqual([ep(BRANCH)]);
  });
});

describe("resolveSocketUserRoom", () => {
  it("a no-org vendor joins its own room", async () => {
    await world();
    expect(await resolveSocketUserRoom(token(LONE))).toBe(`user:${LONE}`);
  });

  it("a type-11 member joins the acting entity's room", async () => {
    await world();
    expect(await resolveSocketUserRoom(token(MEMBER_PERSON))).toBe(`user:${BRANCH}`);
    expect(await resolveSocketUserRoom(token(ADMIN_PERSON))).toBe(`user:${HQ}`);
    expect(await resolveSocketUserRoom(token(ADMIN_PERSON, BRANCH))).toBe(`user:${BRANCH}`);
  });

  it("a foreign, tampered or revoked context joins nothing", async () => {
    await world();
    expect(await resolveSocketUserRoom(token(ADMIN_PERSON, FOREIGN_HQ))).toBeNull();
    expect(await resolveSocketUserRoom(token(LONE, BRANCH))).toBeNull();
    expect(await resolveSocketUserRoom(token(DISABLED_PERSON))).toBeNull();
    expect(await resolveSocketUserRoom(JWT.sign({ sub: cryptr.encrypt(String(LONE)) }, "wrong-secret"))).toBeNull();
  });

  it("a buyer keeps the plain sub room, with or without ent", async () => {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, user_type, status) VALUES (95801, 'B', 'vn-b@example.com', 2, 1)`
    );
    expect(await resolveSocketUserRoom(token(95801, LONE))).toBe("user:95801");
  });
});
