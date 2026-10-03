// Counts the SQL statements — and the serial "waves" they arrive in — that the
// APPLICATION pool issues while a block of code runs. Used to pin query-count
// and round-trip budgets on hot endpoints so an N+1 that creeps back in fails a
// test instead of a p95 dashboard.
//
//   import { countQueries } from "../helpers/queryCounter.js";
//   const { result: res, count, waves, statements } =
//     await countQueries(() => client.get(`/api/v1/rfq/${id}/lifecycle`));
//   expect(count).toBeLessThanOrEqual(20);
//   expect(waves).toBeLessThanOrEqual(8);
//
// HOW IT COUNTS
// pg-promise funnels every `one` / `any` / `none` / `tx` statement through
// exactly ONE `pg.Client#query(text, params, cb)` call (lib/query.js), so
// patching the driver's prototype counts each statement once — `db.one` does
// not double-count through `db.query`. BEGIN / COMMIT are real round trips and
// are counted.
//
// Only clients that belong to the app's pool (app/config/dbConn.js) are
// counted; the test harness's own pg-promise pool (tests/setup/db.js) shares
// the same driver prototype and is filtered out. The audit-context stamp the
// pool's `connect` hook issues (`set_config('app.actor_id', …)`) is excluded:
// it is per-connection bookkeeping, not request work, and whether it fires
// depends on which pooled connection happens to be reused.
//
// DEPTH = length of the longest chain of statements where each was issued only
// after the previous one had completed (a statement's depth is 1 + the deepest
// statement already finished when it was sent). It is the serial round-trip
// count on the critical path, and is less sensitive to scheduling jitter than
// WAVES, which is reported too.
//
// WAVES = the number of times the app pool goes from zero statements in flight
// to at least one. Statements issued together by a Promise.all overlap and form
// ONE wave; statements awaited one after another form one wave each. That is
// the latency-relevant number: total time ≈ waves × round-trip.

import appDb, { pgp } from "../../app/config/dbConn.js";

const AUDIT_STAMP = /set_config\('app\.actor_id'/;

export async function countQueries(fn) {
  const proto = pgp.pg.Client.prototype;
  const original = proto.query;
  const statements = [];
  let inflight = 0;
  let waves = 0;
  let maxCompletedDepth = 0;
  let depth = 0;

  const isAppClient = (client) => {
    const pool = appDb.$pool;
    const clients = pool && (pool._clients || pool.clients);
    return Array.isArray(clients) && clients.includes(client);
  };

  proto.query = function patchedQuery(...args) {
    const config = args[0];
    const text = typeof config === "string" ? config : config && config.text;
    if (!isAppClient(this) || (text && AUDIT_STAMP.test(text))) {
      return original.apply(this, args);
    }
    statements.push(String(text || "").replace(/\s+/g, " ").trim());
    if (inflight === 0) waves += 1;
    inflight += 1;
    const myDepth = maxCompletedDepth + 1;
    if (myDepth > depth) depth = myDepth;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        inflight -= 1;
        if (myDepth > maxCompletedDepth) maxCompletedDepth = myDepth;
      }
    };
    const cbIndex = args.findIndex((a) => typeof a === "function");
    if (cbIndex >= 0) {
      const cb = args[cbIndex];
      args[cbIndex] = function wrappedCb(...cbArgs) {
        done();
        return cb.apply(this, cbArgs);
      };
      return original.apply(this, args);
    }
    const ret = original.apply(this, args);
    if (ret && typeof ret.then === "function") {
      return ret.then(
        (v) => {
          done();
          return v;
        },
        (e) => {
          done();
          throw e;
        }
      );
    }
    done();
    return ret;
  };

  try {
    const result = await fn();
    return { result, count: statements.length, waves, depth, statements };
  } finally {
    proto.query = original;
  }
}
