// PLATFORM — app DB pool configuration (app/config/dbConn.js).
// ----------------------------------------------------------------------------
// Prod opened ~4.7k new physical connections/day (p50 282 ms each, TLS+SCRAM)
// because idle connections were dropped after 30 s, and nothing bounded a
// runaway statement or an abandoned transaction.
//
// Pinned here against the real local Postgres:
//   - the production pool idles for 10 min and its sessions carry
//     statement_timeout = 2 min and idle_in_transaction_session_timeout = 5 min
//   - a statement over the configured timeout is cancelled by the server
//     (deterministic: a 150 ms timeout against pg_sleep(2))
//   - env overrides, including 0 = not sent
//   - the audit context stamping still lands on these sessions

import { describe, it, expect, afterAll } from "@jest/globals";
import { closeDb } from "../setup/db.js";
import db, {
  pgp,
  buildConnectionConfig,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
} from "../../app/config/dbConn.js";
import { runWithRequestContext } from "../../app/util/requestContext.js";

const extraPools = [];
const poolWith = (overrides) => {
  const instance = pgp({ ...buildConnectionConfig({ ...process.env, ...overrides }) });
  extraPools.push(instance);
  return instance;
};

afterAll(async () => {
  for (const p of extraPools) await p.$pool.end();
  await closeDb();
});

describe("buildConnectionConfig", () => {
  it("defaults: 10 min idle, 2 min statement timeout, 5 min idle-in-transaction", () => {
    const cfg = buildConnectionConfig({});
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(600_000);
    expect(cfg.idleTimeoutMillis).toBe(600_000);
    expect(cfg.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(DEFAULT_IDLE_IN_TX_TIMEOUT_MS);
    // Vendor regret submission awaits SMTP inside a db.tx: never below 5 min.
    expect(DEFAULT_IDLE_IN_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("honours env overrides, and 0 disables the server-side timeouts", () => {
    const cfg = buildConnectionConfig({
      DATABASE_IDLE_TIMEOUT_MS: "45000",
      DATABASE_STATEMENT_TIMEOUT_MS: "0",
      DATABASE_IDLE_IN_TX_TIMEOUT_MS: "900000",
    });
    expect(cfg.idleTimeoutMillis).toBe(45_000);
    expect(cfg.statement_timeout).toBe(0);
    expect(cfg.idle_in_transaction_session_timeout).toBe(900_000);
    expect(buildConnectionConfig({ DATABASE_STATEMENT_TIMEOUT_MS: "nope" }).statement_timeout).toBe(
      120_000
    );
  });
});

describe("production pool sessions", () => {
  it("the app pool is built from buildConnectionConfig (idle timeout from env, 10 min by default)", () => {
    // jestEnv.js pins DATABASE_IDLE_TIMEOUT_MS=1000 so per-suite pools do not
    // pile up; production leaves it unset and gets the 10-minute default.
    expect(db.$cn.idleTimeoutMillis).toBe(buildConnectionConfig(process.env).idleTimeoutMillis);
    expect(db.$cn.statement_timeout).toBe(120_000);
    const { DATABASE_IDLE_TIMEOUT_MS: _unset, ...prodLikeEnv } = process.env;
    expect(buildConnectionConfig(prodLikeEnv).idleTimeoutMillis).toBe(600_000);
  });

  it("app sessions carry the statement and idle-in-transaction timeouts", async () => {
    const row = await db.one(
      `SELECT current_setting('statement_timeout') AS st,
              current_setting('idle_in_transaction_session_timeout') AS iit`
    );
    expect(row).toEqual({ st: "2min", iit: "5min" });
  });

  it("a statement exceeding statement_timeout is cancelled by the server", async () => {
    const fast = poolWith({ DATABASE_STATEMENT_TIMEOUT_MS: "150" });
    const started = Date.now();
    await expect(fast.one("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    expect(Date.now() - started).toBeLessThan(1500);
    // The connection is still usable afterwards.
    expect(await fast.one("SELECT 1 AS ok")).toEqual({ ok: 1 });
  });

  it("DATABASE_STATEMENT_TIMEOUT_MS=0 leaves the server default (no timeout)", async () => {
    const unbounded = poolWith({ DATABASE_STATEMENT_TIMEOUT_MS: "0" });
    const row = await unbounded.one(`SELECT current_setting('statement_timeout') AS st`);
    expect(row.st).toBe("0");
  });

  it("audit actor stamping still lands on a timeout-configured session", async () => {
    const row = await runWithRequestContext({ actorUserId: 4242, requestId: "req-dbconn-test" }, () =>
      db.one(
        `SELECT current_setting('app.actor_id', true) AS actor,
                current_setting('app.request_id', true) AS rid`
      )
    );
    expect(row).toEqual({ actor: "4242", rid: "req-dbconn-test" });
  });
});
