// Shared mockExpress helper for controller-level integration tests.
//
// Replaces the per-file inline copies that historically lived in:
//   tests/services/rfq.clarification.test.js
//   tests/services/rfq.withdrawTerminate.test.js
//   tests/services/rfq.editUnlock.test.js
//   tests/services/vendor.quote.charges.test.js
//   tests/services/negotiation.fields.test.js
//   ...and many more.
//
// USAGE:
//   import { mockExpress } from "../helpers/mockExpress.js";
//   const m = mockExpress({ user: someUser, body: { ... }, params: { id: 5 } });
//   await someController.someHandler(m.req, m.res, m.next);
//   expect(m.calls.status).toBe(200);
//   expect(m.calls.body.message).toMatch(/.../);
//
// Returns:
//   { req, res, next, calls }
//   - req: { user, params, body, query, files }
//   - res: minimal Express-like { status(code), json(body), end() }
//   - next: jest.fn()
//   - calls: live mirror of the most recent res.status / res.json call —
//     populated by `res.status(code)` (sets `calls.status`) and
//     `res.json(body)` (sets `calls.body`).

import { jest } from "@jest/globals";

export function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      calls.status = code;
      return this;
    },
    json(body) {
      calls.body = body;
      return this;
    },
    end() {
      return this;
    },
    // Some controllers call .send() instead of .json() — mirror it onto json
    // so tests don't need two assertions paths.
    send(body) {
      calls.body = body;
      return this;
    },
  };
  return {
    req: {
      user: opts.user,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
      files: opts.files || [],
      headers: opts.headers || {},
    },
    res,
    next: jest.fn(),
    calls,
  };
}

export default mockExpress;
