// SECURITY / PERF — CORS policy (app/util/corsOptions.js via app/util/index.js).
// ----------------------------------------------------------------------------
// Before: cors() with no options sent `Access-Control-Allow-Origin: *` together
// with `Access-Control-Allow-Credentials: true` and no Access-Control-Max-Age,
// so the browser re-ran a preflight before every authenticated call (264k
// OPTIONS/week in prod).
//
// Pinned here, over HTTP against the real production app factory:
//   - every preflight carries Access-Control-Max-Age: 7200
//   - CORS_ORIGINS unset: permissive, exactly as before (deploy-safe)
//   - CORS_ORIGINS set: matching origins are reflected (+ Vary: Origin),
//     anything else gets no Access-Control-Allow-Origin at all

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import request from "supertest";
import { closeDb } from "../setup/db.js";
import { createApp } from "../../app/app.js";
import { buildCorsOptions, parseCorsOrigins } from "../../app/util/corsOptions.js";

const PATH = "/api/v1/users/me/departments";
const FRONTEND = "https://hospitality.letsworkwise.com";
const ADMIN = "https://admin.hospitality.letsworkwise.com";
const EVIL = "https://evil.example.com";

const savedEnv = process.env.CORS_ORIGINS;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = savedEnv;
});

afterAll(async () => {
  await closeDb();
});

// The policy is read when the app is built, as it is at process start.
const appWith = (corsOrigins) => {
  if (corsOrigins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = corsOrigins;
  return createApp();
};

const preflight = (app, origin) =>
  request(app)
    .options(PATH)
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "GET")
    .set("Access-Control-Request-Headers", "authorization,content-type");

describe("parseCorsOrigins", () => {
  it("splits, trims, drops empties and trailing slashes", () => {
    expect(parseCorsOrigins(` ${FRONTEND}/ ,, ${ADMIN} `)).toEqual([FRONTEND, ADMIN]);
    expect(parseCorsOrigins("")).toEqual([]);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });

  it("always sets maxAge, permissive when unset", () => {
    expect(buildCorsOptions({})).toMatchObject({ maxAge: 7200, origin: "*" });
    expect(buildCorsOptions({ CORS_ORIGINS: FRONTEND }).maxAge).toBe(7200);
  });
});

describe("CORS_ORIGINS unset (current permissive behaviour)", () => {
  it("preflight succeeds for any origin and is cacheable for 2h", async () => {
    const res = await preflight(appWith(undefined), EVIL);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-max-age"]).toBe("7200");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
  });

  it("simple request still gets Access-Control-Allow-Origin: *", async () => {
    const res = await request(appWith(undefined)).get(PATH).set("Origin", FRONTEND);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("CORS_ORIGINS set (allowlist)", () => {
  it("reflects an allowed origin on the preflight, with max-age and credentials", async () => {
    const res = await preflight(appWith(`${FRONTEND}, ${ADMIN}`), ADMIN);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ADMIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-max-age"]).toBe("7200");
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it("reflects an allowed origin on the actual request", async () => {
    const res = await request(appWith(FRONTEND)).get(PATH).set("Origin", FRONTEND);
    expect(res.headers["access-control-allow-origin"]).toBe(FRONTEND);
  });

  it("gives a non-listed origin no Access-Control-Allow-Origin", async () => {
    const app = appWith(FRONTEND);
    const pre = await preflight(app, EVIL);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const res = await request(app).get(PATH).set("Origin", EVIL);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("matches exactly: scheme and subdomain lookalikes are rejected", async () => {
    const app = appWith(FRONTEND);
    for (const o of [
      FRONTEND.replace("https", "http"),
      `${FRONTEND}.evil.com`,
      "https://evil-hospitality.letsworkwise.com",
    ]) {
      const res = await preflight(app, o);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });
});
