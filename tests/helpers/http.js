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

import request from "supertest";
import { buildTestApp } from "../setup/app.js";
import { loginAs } from "./auth.js";

/**
 * Returns a per-test supertest client bound to a fixture user.
 * Set userId=null for unauthenticated requests.
 */
export async function httpClient(userId = null) {
  const app = await buildTestApp();
  const headers = userId == null ? {} : (await loginAs(userId)).headers;

  const wrap = (method) => (path) => {
    let req = request(app)[method](path);
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
