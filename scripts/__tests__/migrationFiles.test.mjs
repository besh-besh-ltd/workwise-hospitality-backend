import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMigrationFilename, listMigrations, ledgerName } from "../lib/migrationFiles.mjs";

test("parses an up filename and normalises the ledger id", () => {
  const r = parseMigrationFilename("20260803110000_arc_stage_approver_permissions.up.sql");
  assert.deepEqual(r, {
    filename: "20260803110000_arc_stage_approver_permissions.up.sql",
    timestamp: "20260803110000",
    slug: "arc_stage_approver_permissions",
    direction: "up",
    id: "20260803110000_arc_stage_approver_permissions.sql",
  });
});

test("a down file resolves to the same ledger id as its up file", () => {
  const up = parseMigrationFilename("20260803110000_arc_stage.up.sql");
  const down = parseMigrationFilename("20260803110000_arc_stage.down.sql");
  assert.equal(up.id, down.id);
  assert.equal(down.direction, "down");
});

test("rejects the legacy 2026_05_26 name format", () => {
  assert.equal(parseMigrationFilename("2026_05_26_push_notifications.sql"), null);
});

test("rejects a bare NAME.sql with no direction suffix", () => {
  assert.equal(parseMigrationFilename("20260803110000_arc_stage.sql"), null);
});

test("rejects uppercase and hyphens in the slug", () => {
  assert.equal(parseMigrationFilename("20260803110000_ArcStage.up.sql"), null);
  assert.equal(parseMigrationFilename("20260803110000_arc-stage.up.sql"), null);
});

test("rejects a timestamp that is not exactly 14 digits", () => {
  assert.equal(parseMigrationFilename("2026080311000_arc.up.sql"), null);
  assert.equal(parseMigrationFilename("202608031100000_arc.up.sql"), null);
});

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "migfiles-"));
  try {
    for (const f of files) writeFileSync(join(dir, f), "-- noop\n");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pairs up and down into one migration, sorted by timestamp", () => {
  const { migrations, invalid } = withDir(
    [
      "20260102000000_second.up.sql",
      "20260102000000_second.down.sql",
      "20260101000000_first.up.sql",
      "20260101000000_first.down.sql",
    ],
    listMigrations
  );
  assert.deepEqual(invalid, []);
  assert.deepEqual(
    migrations.map((m) => m.id),
    ["20260101000000_first.sql", "20260102000000_second.sql"]
  );
  assert.equal(migrations[0].up, "20260101000000_first.up.sql");
  assert.equal(migrations[0].down, "20260101000000_first.down.sql");
});

test("records an up migration with no down as down:null", () => {
  const { migrations } = withDir(["20260101000000_only.up.sql"], listMigrations);
  assert.equal(migrations[0].up, "20260101000000_only.up.sql");
  assert.equal(migrations[0].down, null);
});

test("reports unparseable .sql files as invalid and ignores non-sql files", () => {
  const { migrations, invalid } = withDir(
    ["20260101000000_ok.up.sql", "2026_05_26_legacy.sql", "run_pending.sh", "README.md"],
    listMigrations
  );
  assert.deepEqual(migrations.map((m) => m.id), ["20260101000000_ok.sql"]);
  assert.deepEqual(invalid, ["2026_05_26_legacy.sql"]);
});

test("ledgerName strips .sql, matching what Task 1's spike observed in pgmigrations", () => {
  // OBSERVED, not assumed. Task 1 ran the real runner against a real database and
  // read the ledger back: `SELECT name, length(name) FROM pgmigrations` returned
  // '20260101000000_first' with length 20 — the bare id, no extension. The
  // documentation's "normalised to NAME.sql" describes the loader's internal id,
  // not the string that reaches the name column.
  assert.equal(ledgerName("20260101000000_first.sql"), "20260101000000_first");
  assert.equal(ledgerName("20260102000000_second.sql"), "20260102000000_second");
});
