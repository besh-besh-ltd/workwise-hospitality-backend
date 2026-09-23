// Builds an Express app for tests using the same `util()` route-mounter as
// production server.js, but without:
//   - app.listen() (supertest binds to a random port)
//   - cron startup (would interfere with time-dependent tests)
//   - socket.io setup (not needed for HTTP integration tests)
//
// Use this in tests via:
//   import { buildTestApp } from "../setup/app.js";
//   const app = await buildTestApp();
//   await request(app).post("/api/v1/rfq/create").send({...});

import express from "express";
import { once } from "node:events";
import util from "../../app/util/index.js";

let cachedApp = null;
let cachedServer = null;

export async function buildTestApp() {
  if (cachedApp) return cachedApp;
  const app = express();
  // Minimal health check (matches server.js).
  app.get("/health", (req, res) => res.status(200).send("OK"));
  // Mount the v1 router with the same middleware stack as production.
  util(app);
  cachedApp = app;
  return app;
}

/**
 * ONE listening server per Jest process, shared by every supertest client.
 *
 * `request(app)` boots a fresh ephemeral listener for EVERY request and closes
 * it again. A shard makes thousands of requests, so that churned thousands of
 * ports through TIME_WAIT — and once in a long run a connection was reset
 * before its response, surfacing as a bare "socket hang up" with no server-side
 * error (listView.fyFilter, arc.manual.hardening). Binding once removes the
 * churn; `unref()` keeps the open socket from holding the process open at exit.
 */
export async function testServer() {
  if (cachedServer) return cachedServer;
  const app = await buildTestApp();
  const server = app.listen(0);
  server.unref();
  await once(server, "listening");
  cachedServer = server;
  return cachedServer;
}

export function resetTestApp() {
  cachedApp = null;
  if (cachedServer) {
    cachedServer.close();
    cachedServer = null;
  }
}
