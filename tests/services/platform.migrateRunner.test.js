/**
 * scripts/migrate.mjs runs unattended after every staging deploy (Coolify's
 * post-deployment command), so what it must get right is what it refuses to do:
 * touch the baseline, carry on past a failure, or apply a file twice.
 *
 * These run the production functions against the test database, with real SQL
 * files in a temp folder. The ledger table doesn't exist in the test schema, so
 * the runner creates it and afterAll removes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "../setup/db.js";
import {
  listMigrations,
  loadBaseline,
  runMigrations,
  selectPending,
} from "../../scripts/migrate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK_KEY = 7265765766; // the runner's advisory lock
const TABLES = ["tbl_runner_test_a", "tbl_runner_test_b", "tbl_runner_test_c"];
const NO_BASELINE = new Set();

let dir;
let ledgerExisted;

const write = (name, sql) => fs.writeFileSync(path.join(dir, `${name}.sql`), sql);
const tableExists = async (table) =>
  (await db.one(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`])).present;
const hasLedger = () => tableExists("pgmigrations");
const ledger = async () =>
  (await hasLedger())
    ? (await db.any(`SELECT name FROM pgmigrations WHERE name LIKE '2999%' ORDER BY id`)).map((r) => r.name)
    : [];
const run = (options = {}) => runMigrations(db, { dir, baseline: NO_BASELINE, log: () => {}, ...options });

beforeAll(async () => {
  ledgerExisted = await hasLedger();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-runner-"));
});

afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const table of TABLES) await db.none(`DROP TABLE IF EXISTS ${table}`);
  if (await hasLedger()) await db.none(`DELETE FROM pgmigrations WHERE name LIKE '2999%'`);
});

afterAll(async () => {
  try {
    if (!ledgerExisted) await db.none(`DROP TABLE IF EXISTS pgmigrations`);
  } finally {
    await closeDb();
  }
});

describe("applying", () => {
  it("runs pending files in name order, records each, and a second run does nothing", async () => {
    // The second file needs the first, so a wrong order fails the run.
    write("29990101000002_b", `INSERT INTO tbl_runner_test_a (n) VALUES (1);`);
    write("29990101000001_a", `BEGIN; CREATE TABLE tbl_runner_test_a (n int); COMMIT;`);

    const first = await run();
    expect(first.failed).toBeNull();
    expect(first.applied).toEqual(["29990101000001_a", "29990101000002_b"]);
    expect(await ledger()).toEqual(["29990101000001_a", "29990101000002_b"]);

    const second = await run();
    expect(second.applied).toEqual([]);
    expect(second.failed).toBeNull();
    expect((await db.one(`SELECT count(*)::int AS n FROM tbl_runner_test_a`)).n).toBe(1);
  });

  it("runs a file exactly as written: dollar quoting and $1-like text aren't treated as parameters", async () => {
    write(
      "29990101000001_a",
      `CREATE TABLE tbl_runner_test_a (note text);
       DO $$ BEGIN INSERT INTO tbl_runner_test_a (note) VALUES ('costs $1 or \${name}'); END $$;`
    );

    expect((await run()).failed).toBeNull();
    expect((await db.one(`SELECT note FROM tbl_runner_test_a`)).note).toBe("costs $1 or ${name}");
  });

  it("never runs a baseline file or a down file", async () => {
    write("29990101000001_in_baseline", `SELECT 1/0;`);
    write("29990101000002_new", `CREATE TABLE tbl_runner_test_a (n int);`);
    write("29990101000002_new.down", `SELECT 1/0;`);

    const result = await run({ baseline: new Set(["29990101000001_in_baseline"]) });

    expect(result.failed).toBeNull();
    expect(result.applied).toEqual(["29990101000002_new"]);
    expect(await ledger()).toEqual(["29990101000002_new"]);
  });

  it("skips a file already in the ledger, which is how a hand-applied migration is honoured", async () => {
    await run(); // creates the ledger
    await db.none(`INSERT INTO pgmigrations (name, run_on) VALUES ('29990101000001_by_hand', now())`);
    write("29990101000001_by_hand", `SELECT 1/0;`);

    const result = await run();

    expect(result.failed).toBeNull();
    expect(result.applied).toEqual([]);
  });
});

describe("failing", () => {
  it("stops at the failing file, records nothing for it, runs nothing after it, and retries from there", async () => {
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int);`);
    // Its own transaction, left open by the error: the runner has to clear it.
    write("29990101000002_b", `BEGIN; CREATE TABLE tbl_runner_test_b (n int); SELECT 1/0; COMMIT;`);
    write("29990101000003_c", `CREATE TABLE tbl_runner_test_c (n int);`);

    const lines = [];
    const failed = await run({ log: (line) => lines.push(line) });

    expect(failed.failed).toMatchObject({ name: "29990101000002_b" });
    expect(failed.failed.message).toMatch(/division by zero/);
    expect(failed.applied).toEqual(["29990101000001_a"]);
    expect(await ledger()).toEqual(["29990101000001_a"]);
    expect(lines.join("\n")).toContain("FAILED: 29990101000002_b: division by zero");
    expect(await tableExists("tbl_runner_test_b")).toBe(false); // rolled back
    expect(await tableExists("tbl_runner_test_c")).toBe(false); // never reached

    write("29990101000002_b", `CREATE TABLE tbl_runner_test_b (n int);`);
    const retried = await run();

    expect(retried.failed).toBeNull();
    expect(retried.applied).toEqual(["29990101000002_b", "29990101000003_c"]);
  });

  it("rolls back a failing file that has no BEGIN of its own", async () => {
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int); SELECT 1/0;`);

    expect((await run()).failed).toMatchObject({ name: "29990101000001_a" });
    expect(await tableExists("tbl_runner_test_a")).toBe(false);
    expect(await ledger()).toEqual([]);
  });

  it("reports CREATE INDEX CONCURRENTLY as a failure instead of half-applying it", async () => {
    write(
      "29990101000001_a",
      `CREATE TABLE tbl_runner_test_a (n int);
       CREATE INDEX CONCURRENTLY tbl_runner_test_a_n ON tbl_runner_test_a (n);`
    );

    const result = await run();

    expect(result.failed.message).toMatch(/cannot run inside a transaction block/);
    expect(await tableExists("tbl_runner_test_a")).toBe(false);
  });
});

describe("concurrency", () => {
  it("applies each file once when two runs start together", async () => {
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int); SELECT pg_sleep(0.3);`);

    const results = await Promise.all([run(), run()]);

    expect(results.map((r) => r.failed)).toEqual([null, null]);
    expect(results.flatMap((r) => r.applied)).toEqual(["29990101000001_a"]);
    expect(await ledger()).toEqual(["29990101000001_a"]);
  });

  it("gives up, changing nothing, when another run keeps the lock", async () => {
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int);`);
    const holder = await db.connect();
    try {
      await holder.one(`SELECT pg_advisory_lock($1)`, [LOCK_KEY]);

      const result = await run({ lockWaitMs: 50, lockRetryMs: 10 });

      expect(result.failed.message).toMatch(/held the lock/);
      expect(await tableExists("tbl_runner_test_a")).toBe(false);
    } finally {
      await holder.one(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
      holder.done();
    }
  });

  it("releases its lock, so the next run isn't blocked", async () => {
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int);`);
    await run();

    const holder = await db.connect();
    try {
      const { locked } = await holder.one(`SELECT pg_try_advisory_lock($1) AS locked`, [LOCK_KEY]);
      expect(locked).toBe(true);
      await holder.one(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    } finally {
      holder.done();
    }
  });
});

describe("dry run", () => {
  it("lists what is pending and changes nothing, not even creating the ledger", async () => {
    if (await hasLedger()) await db.none(`DROP TABLE pgmigrations`);
    write("29990101000001_a", `CREATE TABLE tbl_runner_test_a (n int);`);

    const lines = [];
    const result = await run({ dryRun: true, log: (line) => lines.push(line) });

    expect(result.pending).toEqual(["29990101000001_a"]);
    expect(result.applied).toEqual([]);
    expect(lines.join("\n")).toContain("29990101000001_a");
    expect(await tableExists("tbl_runner_test_a")).toBe(false);
    expect(await hasLedger()).toBe(false);
  });
});

describe("the real repo", () => {
  const baseline = loadBaseline();

  it("every baseline entry is a real migration, so a typo can't hide a file", () => {
    const files = new Set(listMigrations());
    expect([...baseline].filter((name) => !files.has(name))).toEqual([]);
  });

  it("freezes the files that are unsafe to run on staging", () => {
    // Its pre-check refuses to run, which would fail every deploy.
    expect(baseline.has("20261016100000_unique_employee_code")).toBe(true);
    // Rewrites audit triggers; out of order now that later migrations exist.
    expect(baseline.has("20260829090000_audit_row_changes")).toBe(true);
  });

  it("treats a migration that isn't in the baseline as pending, whatever its timestamp", () => {
    // PRs merge out of timestamp order, so an old timestamp must not hide a file.
    const names = ["20200101000000_old_timestamp", ...baseline];
    expect(selectPending(names, baseline, new Set())).toEqual(["20200101000000_old_timestamp"]);
  });

  it("the image Coolify runs contains the runner and the migrations", () => {
    const ignored = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignored).not.toEqual(expect.arrayContaining(["scripts"]));
    expect(ignored).not.toEqual(expect.arrayContaining(["migrations"]));

    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(scripts.migrate).toBe("node scripts/migrate.mjs");
  });
});
