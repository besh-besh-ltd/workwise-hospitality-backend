#!/usr/bin/env node
/**
 * The single entry point for database migrations.
 *
 * Wraps node-pg-migrate's programmatic API rather than shelling out to its CLI,
 * for two reasons. First, this repo's env vars are HOST / DATABASE_USERNAME /
 * DATABASE_NAME, not DATABASE_URL, so a connection has to be assembled either
 * way. Second, node-pg-migrate ships no `status` command, and the production
 * approval gate is worth little if the reviewer cannot see what they are
 * approving before they approve it.
 *
 *   npm run migrate:status
 *   npm run migrate:up
 *   npm run migrate:down -- --count 1            (remote: also --yes --confirm <db>)
 *   npm run migrate:verify
 *   npm run migrate:baseline -- --confirm hospitality_main
 *   npm run migrate:manifest
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import dotenv from "dotenv";
import { runner } from "node-pg-migrate";
import { buildConnection, describeTarget } from "./lib/migrationConfig.mjs";
import { listMigrations, ledgerName } from "./lib/migrationFiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const MIGRATIONS_TABLE = "pgmigrations";

// On a deploy host the environment arrives via `docker run --env-file`, so there
// is no .env to read and dotenv must not clobber it. Locally there is.
if (!process.env.HOST && existsSync(join(ROOT, ".env"))) {
  dotenv.config({ path: join(ROOT, ".env") });
}

// Any positional argument that survives to here is almost certainly a value the
// caller meant to attach to a flag (`down 2` meaning `down --count 2`) rather
// than something this CLI accepts bare. Silently ignoring it is how `down 2`
// used to revert 1 migration and exit 0.
function positionalHint(command, token) {
  if (command === "down") return ` (did you mean --count ${token}?)`;
  if (command === "baseline") return ` (did you mean --confirm ${token}?)`;
  return "";
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(
        `unexpected argument '${token}' — flags must be passed as --name value or ` +
          `--name=value${positionalHint(command, token)}`
      );
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      // --flag=value: whatever follows '=' is the value, verbatim (including "").
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // Nothing follows, or the next token is itself a flag: this is a bare
      // boolean-style flag (e.g. --yes). Recorded as `true`, NOT as `undefined` —
      // a command that requires a value (e.g. --count) must be able to tell
      // "flag given with no value" (true) apart from "flag never given"
      // (absent from `flags` entirely), and reject the former explicitly rather
      // than silently defaulting, which is exactly how a dangling `--count` at
      // the end of argv used to revert 1 migration and exit 0.
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// backend/.env resolves to hospitality_stage on a shared RDS host by default, so
// an `up`/`down` run from a bare terminal — no flags, no thought given to which
// database is active — writes to that shared environment unless something stops
// it first. `baseline` already has --confirm; `up`/`down` had nothing. This
// mirrors the gate migrations/run_pending_migrations.sh already uses (its
// ASSUME_YES / `-t 0` check) rather than inventing a new shape.
async function guardRemoteTarget(conn, flags, command) {
  if (LOCAL_HOSTS.has(conn.host)) return; // dev/CI scratch db: no shared blast radius

  // `down` needs MORE than --yes, because the guards were the wrong way round.
  // `baseline` — which writes ledger rows and no DDL at all — already demands
  // --confirm <database>. `down` runs .down.sql files, several of which genuinely
  // DROP TABLE, and asked only for a bare --yes; and that exact flag is sitting in
  // .github/workflows/deploy-prod.yml ready to be copy-pasted. Nothing bounds
  // --count either, so `npm run migrate:down -- --count 20 --yes` from any
  // non-interactive shell holding production credentials reverts twenty
  // migrations. Requiring the database name to be typed out makes "wrong
  // terminal" a typo rather than an incident, exactly as it does for baseline.
  //
  // This is IN ADDITION to the --yes/prompt gate below, not instead of it, and it
  // applies only to remote targets: CI's replay job runs migrate:down against
  // localhost and must keep working ungated.
  if (command === "down" && flags.confirm !== conn.database) {
    throw new Error(
      `refusing to revert migrations on a REMOTE database: ${describeTarget(conn)}. ` +
        `Pass --confirm ${conn.database} as well as --yes. ` +
        "down executes .down.sql files, some of which drop tables — unlike baseline, which " +
        "only writes ledger rows and has required --confirm from the start. " +
        `(got ${flags.confirm === undefined ? "nothing" : `'${flags.confirm}'`})`
    );
  }

  // --yes must be a bare flag (see parseArgs above) — CD passes it explicitly to
  // state its intent, which is the point: `--yes false` would be parsed as
  // giving --yes the *value* "false", a truthy string, not a way to say no.
  if (flags.yes === true) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      `refusing to run against a REMOTE database non-interactively: ${describeTarget(conn)}. ` +
        "Pass --yes to confirm this is intentional."
    );
  }
  console.log(`\nTarget is REMOTE: ${describeTarget(conn)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let typed;
  try {
    typed = await rl.question(`Type the database name (${conn.database}) to continue: `);
  } finally {
    rl.close();
  }
  if (typed !== conn.database) {
    throw new Error(`refusing: confirmation did not match '${conn.database}'`);
  }
}

function runnerOptions(client, overrides) {
  return {
    dbClient: client,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    // Each migration commits independently. With the default `true`, all pending
    // migrations share one transaction — which would make "add an enum label in
    // one migration, use it in the next" impossible, and would turn a
    // three-migration deploy into an all-or-nothing three-way rollback.
    singleTransaction: false,
    // Refuses a migration whose timestamp predates one already applied — the
    // two-PRs-merged-out-of-order case.
    checkOrder: true,
    // staging and production are two databases on one RDS instance. Queue rather
    // than fail if the lock turns out to be instance-scoped.
    advisoryLockMode: "wait",
    // Pairs NAME.up.sql with NAME.down.sql; ledger id normalises to NAME.sql.
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
    // Consider ONLY .sql files. Without this, node-pg-migrate scans every entry in
    // the directory and throws `Cannot determine numeric prefix for "<name>"` on the
    // first one that is not a migration — a stray shell script is enough to break
    // every deploy. Its default ignore is `^\..*` (dotfiles only), which covers
    // .DS_Store but not `run_notification_catchup.sh`.
    //
    // The deeper reason is agreement: `status` counts pending work through our own
    // listMigrations(), which already looks at .sql alone. If the runner's scan saw a
    // different set, `status` would report "0 pending" while `up` threw — the two
    // halves of one CLI disagreeing about what exists.
    //
    // The library anchors this itself as `^<pattern>$` (dist/legacy/migration.js), so
    // it reads: any name that does not end in .sql.
    ignorePattern: "(?!.*\\.sql$).*",
    verbose: true,
    ...overrides,
  };
}

async function ledgerNames(client) {
  const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
    `public.${MIGRATIONS_TABLE}`,
  ]);
  if (!rows[0].present) return null;
  const applied = await client.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  return applied.rows.map((r) => r.name);
}

async function computeStatus(client) {
  const { migrations, invalid } = listMigrations(MIGRATIONS_DIR);
  if (invalid.length > 0) {
    throw new Error(
      `migrations/ contains ${invalid.length} file(s) that are not valid migrations: ${invalid.join(", ")}`
    );
  }
  const applied = await ledgerNames(client);
  const appliedSet = new Set(applied ?? []);
  const pending = migrations.filter((m) => !appliedSet.has(ledgerName(m.id)));
  return { migrations, applied, pending };
}

const commands = {
  async status(client, conn) {
    const { migrations, applied, pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Ledger : ${MIGRATIONS_TABLE}${applied === null ? " (does not exist yet)" : ""}`);
    console.log(`Files  : ${migrations.length}   Applied: ${applied?.length ?? 0}   Pending: ${pending.length}`);
    if (pending.length > 0) {
      console.log("\nPending:");
      for (const m of pending) console.log(`  ${m.id}${m.down ? "" : "   (no down migration)"}`);
    }
    // Machine-readable for the CD plan job. Keep this line's format stable.
    console.log(`\nPENDING_COUNT=${pending.length}`);
  },

  async up(client, conn) {
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    if (pending.length === 0) {
      console.log("Nothing to apply.");
      return;
    }
    console.log(`Applying ${pending.length} migration(s)...`);
    await runner(runnerOptions(client, { direction: "up", count: Infinity }));
    console.log(`\nApplied ${pending.length} migration(s).`);
  },

  async down(client, conn, flags) {
    // flags.count === undefined means --count was never passed at all: default
    // to 1. flags.count === true means it WAS passed but with no usable value
    // (dangling `--count` at the end of argv, or immediately followed by another
    // --flag) — that must error, not silently coerce to 1: Number(true) === 1,
    // which would make this exact bug invisible again.
    if (flags.count === true) {
      throw new Error("--count requires a value, e.g. --count 1 (got a bare flag with nothing after it)");
    }
    const count = flags.count === undefined ? 1 : Number(flags.count);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`--count must be a positive integer (got ${JSON.stringify(flags.count)})`);
    }
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Reverting ${count} migration(s)...`);
    await runner(runnerOptions(client, { direction: "down", count }));
  },

  async verify(client, conn) {
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}   Pending: ${pending.length}`);
    if (pending.length > 0) {
      for (const m of pending) console.error(`  unapplied: ${m.id}`);
      throw new Error(`${pending.length} migration(s) are not applied`);
    }
    console.log("OK: database is up to date.");
  },

  async baseline(client, conn, flags) {
    // The only command that writes ledger rows for migrations it did not run.
    // Requiring the database name to be typed back makes "wrong terminal" a
    // typo rather than an incident.
    if (flags.confirm !== conn.database) {
      throw new Error(
        `refusing to baseline: pass --confirm ${conn.database} to confirm the target ` +
          `(got ${flags.confirm === undefined ? "nothing" : `'${flags.confirm}'`})`
      );
    }
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Marking ${pending.length} migration(s) as applied WITHOUT running them.`);
    await runner(runnerOptions(client, { direction: "up", count: Infinity, fake: true }));
    const after = await ledgerNames(client);
    console.log(`\nLedger now holds ${after.length} row(s).`);
  },

  async manifest() {
    const { migrations, invalid } = listMigrations(MIGRATIONS_DIR);
    if (invalid.length > 0) throw new Error(`invalid migration file(s): ${invalid.join(", ")}`);
    for (const m of migrations) console.log(m.id);
  },
};

// up/down are the only commands with no confirmation gate of their own
// (baseline has --confirm; status/verify/manifest never write). Gated here.
const REMOTE_GUARDED = new Set(["up", "down"]);

// Set once buildConnection() resolves, purely so a later fatal error (including
// a failed client.connect()) can still say which database it was reaching for —
// see describeError below.
let lastConn = null;

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const run = commands[command];
  if (!run) {
    console.error(`Unknown command '${command}'. Expected one of: ${Object.keys(commands).join(", ")}`);
    process.exit(2);
  }

  if (command === "manifest") {
    await run();
    return;
  }

  const conn = buildConnection();
  lastConn = conn;

  // Checked before client.connect(), not inside the command: buildConnection()
  // is pure env-var parsing with no I/O, so the remote/local decision — and, for
  // a remote target, the whole prompt-or-refuse flow — can complete before a
  // single packet reaches the network. An operator (or CI) pointed at a remote
  // host by an untouched .env is stopped before a connection even opens, not
  // after node-pg-migrate has already started applying DDL against it.
  if (REMOTE_GUARDED.has(command)) {
    await guardRemoteTarget(conn, flags, command);
  }

  const client = new pg.Client(conn);
  await client.connect();
  try {
    await run(client, conn, flags);
  } finally {
    await client.end();
  }
}

// Node's connection stack can throw an AggregateError whose top-level .message
// is "" (e.g. every address a hostname resolved to refused the connection) —
// `ABORT: ` with nothing after it leaves no diagnostic for an on-call engineer
// to grep out of a CD log. Falls back through sub-errors, then error code, then
// the constructor name, so the line is never empty; always names the target
// (via describeTarget, which never includes the password) so the log says WHICH
// database could not be reached.
function describeError(err) {
  const parts = [];
  if (err.message) parts.push(err.message);
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    parts.push(err.errors.map((e) => e?.message || String(e)).join("; "));
  }
  if (err.code) parts.push(`code=${err.code}`);
  if (parts.length === 0) parts.push(err.constructor?.name ?? String(err));
  return parts.join(" | ");
}

main().catch((err) => {
  const target = lastConn ? ` (target: ${describeTarget(lastConn)})` : "";
  console.error(`\nABORT: ${describeError(err)}${target}`);
  process.exit(1);
});
