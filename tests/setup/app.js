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
import util from "../../app/util/index.js";

let cachedApp = null;

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

export function resetTestApp() {
  cachedApp = null;
}
