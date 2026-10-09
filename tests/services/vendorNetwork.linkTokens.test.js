// Emailed-link vendor tokens (security audit C1, Task 23 S2).
//   - Every minting path (insertVendorRfqToken, insertVendorRfqTokens, ensureVendorTokens)
//     produces an unguessable 18-digit token: not derived from the clock, distinct, in
//     range for the BIGINT column.
//   - POST /users/verify-vendor-token answers 429 after 20 invalid tokens from one client.
// Pattern B: committed rows (vendor ids 95571..95579), removed in afterEach.

import { db, closeDb } from "../setup/db.js";
import { buildTestApp } from "../setup/app.js";
import { boundRequest } from "../helpers/http.js";
import rfqModel from "../../app/models/rfqModel.js";
import { generateEmailLinkToken } from "../../app/helper/emailLinkToken.js";
import { seedVendorEntity, cleanupVendorNetworkFixtures } from "../helpers/vendorNetworkSeed.js";

const V1 = 95571;
const V2 = 95572;
const V3 = 95573;
const RFQ_NO = 990571; // tbl_vendor_rfq_tokens_non_login.rfq_no has no FK
const UA = "jest-test-agent";
const MIN = 10n ** 17n;
const MAX = 10n ** 18n; // exclusive
const BIGINT_MAX = 9223372036854775807n;

beforeEach(async () => {
  for (const id of [V1, V2, V3]) {
    await seedVendorEntity({ id, companyId: id, name: `VN Token ${id}`, email: `vn-token-${id}@example.com` });
  }
});

afterEach(async () => {
  await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id BETWEEN 95571 AND 95579`);
  await cleanupVendorNetworkFixtures();
});

afterAll(closeDb);

/** An 18-digit token in [1e17, 1e18), nowhere near the clock it used to be built from. */
function expectUnguessable(token) {
  expect(typeof token === "string" || typeof token === "number").toBe(true);
  const text = String(token);
  expect(text).toMatch(/^[1-9]\d{17}$/);
  const v = BigInt(text);
  expect(v >= MIN && v < MAX && v <= BIGINT_MAX).toBe(true);
  // The old shape was Date.now() (13 digits) +/- 1e6, or its 16-digit concatenation.
  const now = BigInt(Date.now());
  expect(v - now > 10n ** 15n).toBe(true);
  expect(text.startsWith(String(Date.now()).slice(0, 6))).toBe(false);
}

describe("emailed-link token generation", () => {
  it("generateEmailLinkToken: 1000 draws are distinct, 18 digits, in range", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const t = generateEmailLinkToken();
      expectUnguessable(t);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });

  it("insertVendorRfqToken stores and returns an unguessable token", async () => {
    const token = await rfqModel.insertVendorRfqToken(V1, RFQ_NO);
    expectUnguessable(token);
    const row = await db.one(`SELECT token FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1`, [V1]);
    expect(String(row.token)).toBe(String(token)); // stored exactly, no float rounding
  });

  it("insertVendorRfqTokens mints distinct unguessable tokens per vendor", async () => {
    const map = await rfqModel.insertVendorRfqTokens([V1, V2, V3], RFQ_NO);
    const tokens = [...map.values()].map(String);
    expect(tokens).toHaveLength(3);
    tokens.forEach(expectUnguessable);
    expect(new Set(tokens).size).toBe(3);
    const stored = await db.any(
      `SELECT token::text AS token FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id BETWEEN 95571 AND 95573 ORDER BY token`
    );
    expect(stored.map((r) => r.token)).toEqual([...tokens].sort());
  });

  it("ensureVendorTokens mints unguessable tokens for vendors that have none, and reuses existing ones", async () => {
    const existing = await rfqModel.insertVendorRfqToken(V1, RFQ_NO);
    const rows = await rfqModel.ensureVendorTokens(RFQ_NO, [V1, V2, V3]);
    const byVendor = Object.fromEntries(rows.map((r) => [r.vendor_id, String(r.token)]));
    expect(byVendor[V1]).toBe(String(existing));
    expectUnguessable(byVendor[V2]);
    expectUnguessable(byVendor[V3]);
    expect(new Set(Object.values(byVendor)).size).toBe(3);
  });
});

describe("POST /users/verify-vendor-token rate limit", () => {
  let agent;
  beforeAll(async () => {
    agent = await boundRequest(await buildTestApp());
  });
  // Each test is its own client (X-Forwarded-For), so limiter state never leaks between them.
  const verify = (client, token) =>
    agent.post("/api/v1/users/verify-vendor-token").set({ "User-Agent": UA, "X-Forwarded-For": client }).send({ token });

  it("answers 429 after 20 invalid tokens from one client, even for a valid token; other clients are unaffected", async () => {
    const valid = String(await rfqModel.insertVendorRfqToken(V1, RFQ_NO));
    const attacker = "203.0.113.10";
    for (let i = 0; i < 20; i++) {
      const res = await verify(attacker, String(100000000000000000n + BigInt(i)));
      expect(res.status).toBe(400);
    }
    const blocked = await verify(attacker, "100000000000000099");
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(0);
    expect((await verify(attacker, valid)).status).toBe(429);

    const vendor = await verify("203.0.113.11", valid);
    expect(vendor.status).toBe(200);
    expect(vendor.body.data.user.id).toBe(V1);
  });

  it("valid tokens never count: a vendor opening links repeatedly is never limited", async () => {
    const valid = String(await rfqModel.insertVendorRfqToken(V2, RFQ_NO));
    for (let i = 0; i < 25; i++) {
      expect((await verify("203.0.113.20", valid)).status).toBe(200);
    }
  });

  it("a malformed token is a 400 failure (never a 500) and counts toward the limit", async () => {
    const client = "203.0.113.30";
    for (const bad of ["abc", "12.5", "-5", "99999999999999999999", " "]) {
      expect((await verify(client, bad)).status).toBe(400);
    }
    for (let i = 0; i < 15; i++) expect((await verify(client, "x")).status).toBe(400);
    expect((await verify(client, "x")).status).toBe(429);
  });
});
