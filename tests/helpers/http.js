// Lightweight supertest wrapper. Use this in tests that exercise routes via
// HTTP (preferred for Wave-1 controller-level integration tests because it
// runs the full middleware stack — auth, validation, RBAC).
//
//   import { httpClient } from "../helpers/http.js";
//   const client = await httpClient(userId);
//   const res = await client.post("/api/v1/rfq/create").send({...});
//   expect(res.status).toBe(200);
//
// `client` is a thin wrapper around supertest's request(app) that auto-attaches
// Authorization + User-Agent headers from `loginAs()`.

import http from "http";
import request from "supertest";
import { buildTestApp } from "../setup/app.js";
import { loginAs } from "./auth.js";

// Supertest given a bare Express app listens on an ephemeral port on ALL
// addresses but sends requests to 127.0.0.1. On macOS another local process
// (Chrome, puppeteer, another jest) may already hold that port on 127.0.0.1 and
// answer instead -> intermittent 404 / "socket hang up". Bind our own server
// to 127.0.0.1 explicitly so the port is guaranteed to be ours on that address.
// One server per app instance, closed after the suite.
const servers = new Map(); // app -> Promise<http.Server>

// Registered at import time (hooks cannot be declared inside a running test).
// Each jest test file gets its own module registry, so this runs once per file.
// Runs BEFORE the suite's own afterAll hooks (registered first; jest-circus runs afterAll in declaration order).
if (typeof afterAll === "function") {
  afterAll(async () => {
    const pending = [...servers.values()];
    servers.clear();
    await Promise.allSettled(
      pending.map(async (p) => {
        const server = await p;
        server.closeAllConnections?.();
        await new Promise((r) => server.close(() => r()));
      })
    );
  });
}

function serverFor(app) {
  if (!servers.has(app)) {
    servers.set(
      app,
      new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }).catch((err) => {
        // A failed listen must not poison the cache: the next call retries.
        servers.delete(app);
        throw err;
      })
    );
  }
  return servers.get(app);
}

/**
 * Returns a per-test supertest client bound to a fixture user.
 * Set userId=null for unauthenticated requests.
 * `{ ent }` adds the Vendor Networks acting-entity claim (see loginAs).
 */
export async function httpClient(userId = null, { ent } = {}) {
  const app = await buildTestApp();
  const server = await serverFor(app);
  const headers = userId == null ? {} : (await loginAs(userId, { ent })).headers;

  const wrap = (method) => (path) => {
    let req = request(server)[method](path);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };

  return {
    app,
    headers,
    get: wrap("get"),
    post: wrap("post"),
    put: wrap("put"),
    patch: wrap("patch"),
    delete: wrap("delete"),
  };
}
