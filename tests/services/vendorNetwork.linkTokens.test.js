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
import { createFailedAttemptLimiter, clientKey } from "../../app/middleware/failedAttemptLimiter.js";
import { trustProxySetting } from "../../app/util/trustProxy.js";
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

describe("fix round 1: limiter client key and memory bound", () => {
  let agent;
  beforeAll(async () => {
    agent = await boundRequest(await buildTestApp());
  });

  it("the key is req.ip under 'trust proxy' (1 hop): a client-forged X-Forwarded-For prefix does not buy a new bucket", async () => {
    // Behind one proxy the right-most hop is the address the proxy saw; the attacker
    // controls only what is to its left.
    for (let i = 0; i < 20; i++) {
      const res = await agent
        .post("/api/v1/users/verify-vendor-token")
        .set({ "User-Agent": UA, "X-Forwarded-For": `198.51.100.${i}, 203.0.113.60` })
        .send({ token: String(100000000000000000n + BigInt(i)) });
      expect(res.status).toBe(400);
    }
    const blocked = await agent
      .post("/api/v1/users/verify-vendor-token")
      .set({ "User-Agent": UA, "X-Forwarded-For": "198.51.100.250, 203.0.113.60" })
      .send({ token: "100000000000000077" });
    expect(blocked.status).toBe(429);
  });

  it("TRUST_PROXY_HOPS: default 1 hop, 0 disables, N trusts N; junk falls back to 1", () => {
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting("")).toBe(1);
    expect(trustProxySetting("0")).toBe(false);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("-3")).toBe(1);
    expect(trustProxySetting("abc")).toBe(1);
    expect(clientKey({ ip: "203.0.113.9", socket: { remoteAddress: "10.0.0.1" } })).toBe("203.0.113.9");
  });

  it("never tracks more than maxKeys clients: the oldest is evicted first", () => {
    let t = 0;
    const limiter = createFailedAttemptLimiter({ max: 2, windowMs: 1000, maxKeys: 3, now: () => t });
    const req = (ip) => ({ ip });
    for (const ip of ["a", "b", "c"]) {
      limiter.recordFailure(req(ip));
      limiter.recordFailure(req(ip));
    }
    expect(["a", "b", "c"].map((ip) => limiter.isBlocked(req(ip)))).toEqual([true, true, true]);
    limiter.recordFailure(req("d")); // a 4th client: "a", the oldest, makes room
    expect(limiter.size()).toBe(3);
    expect(limiter.isBlocked(req("a"))).toBe(false);
    expect(limiter.isBlocked(req("b"))).toBe(true);
    expect(limiter.isBlocked(req("c"))).toBe(true);
  });

  it("prunes expired entries from the head on every failure, so memory follows live clients only", () => {
    let t = 0;
    const limiter = createFailedAttemptLimiter({ max: 5, windowMs: 1000, maxKeys: 100, now: () => t });
    for (let i = 0; i < 50; i++) limiter.recordFailure({ ip: `old-${i}` });
    expect(limiter.size()).toBe(50);
    t = 1500; // every old window has ended
    limiter.recordFailure({ ip: "fresh" });
    expect(limiter.size()).toBe(1);
  });

  it("the default cap is 10,000 clients", () => {
    const limiter = createFailedAttemptLimiter();
    for (let i = 0; i < 10_050; i++) limiter.recordFailure({ ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` });
    expect(limiter.size()).toBe(10_000);
  });
});
