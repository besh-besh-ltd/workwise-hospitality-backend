// SECURITY — the backend must not serve its own source tree.
// ----------------------------------------------------------------------------
// server.js used to mount `express.static(__dirname)`, which made every file in
// the backend directory publicly downloadable: /server.js, /package.json,
// /Dockerfile and /app/config/app.config.js (which carries credential
// fallbacks). Prod traces showed no legitimate static traffic, only scanners.
//
// This drives the real production app factory (app/app.js, the one server.js
// listens with) over HTTP and asserts none of those files come back, while the
// health checks still answer.

import { describe, it, expect, afterAll } from "@jest/globals";
import { boundRequest } from "../helpers/http.js";
import { closeDb } from "../setup/db.js";
import { createApp } from "../../app/app.js";

const app = createApp();

afterAll(async () => {
  await closeDb();
});

describe("no source files over HTTP", () => {
  it.each([
    ["/server.js", /express|import/],
    ["/package.json", /"dependencies"/],
    ["/app/config/app.config.js", /cryptR|smtp/i],
    ["/Dockerfile", /FROM\s/],
    ["/otel-instrument.mjs", /opentelemetry/],
    ["/.env.test", /DATABASE/],
  ])("GET %s does not return the file", async (path, signature) => {
    const res = await (await boundRequest(app)).get(path);
    expect([404, 405]).toContain(res.status);
    expect(res.text || "").not.toMatch(signature);
  });

  it("GET /api/health still answers from the database", async () => {
    const res = await (await boundRequest(app)).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /health still answers", async () => {
    const res = await (await boundRequest(app)).get("/health");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
  });
});
