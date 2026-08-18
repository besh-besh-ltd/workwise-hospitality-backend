import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A throwaway repo with one committed migration on 'base', then a feature branch.
 *
 * `extraBaseFiles` seeds additional files onto 'base' only — used by the adoption
 * test, which needs a legacy bare NAME.sql on the base branch to rename. It is
 * opt-in because such a file left un-renamed on HEAD would fail gate 1 for every
 * other test in this file.
 */
function withRepo(fn, extraBaseFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "checkmig-"));
  try {
    git(dir, "init", "-q", "-b", "base");
    git(dir, "config", "user.email", "t@t.test");
    git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, "migrations"));
    mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
    cpSync(join(SCRIPTS, "check-migrations.mjs"), join(dir, "scripts", "check-migrations.mjs"));
    cpSync(join(SCRIPTS, "lib"), join(dir, "scripts", "lib"), { recursive: true });
    writeFileSync(join(dir, "migrations", "20260101000000_old.up.sql"), "SELECT 1;\n");
    writeFileSync(join(dir, "migrations", "20260101000000_old.down.sql"), "SELECT 1;\n");
    for (const [name, body] of Object.entries(extraBaseFiles)) {
      writeFileSync(join(dir, "migrations", name), body);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-q", "-b", "feature");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(dir, args = ["--base", "base"]) {
  try {
    const stdout = execFileSync("node", ["scripts/check-migrations.mjs", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("passes when the branch adds a well-formed migration pair", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260202000000_new.up.sql"), "ALTER TABLE t ADD COLUMN c int;\n");
    writeFileSync(join(dir, "migrations", "20260202000000_new.down.sql"), "ALTER TABLE t DROP COLUMN c;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "add migration");
    const { code, out } = check(dir);
    assert.equal(code, 0, out);
    assert.match(out, /OK/);
  });
});

test("fails when a merged migration is modified", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260101000000_old.up.sql"), "SELECT 2;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "edit history");
    const { code, out } = check(dir);
    assert.equal(code, 1);
    assert.match(out, /immutability/);
  });
});

// A 100%-similarity `git mv` of a merged migration used to pass end-to-end. It is
// the worst kind of green: the ledger keeps the old name, migrations/ yields the
// new one, and checkOrder freezes every later migrate:up on staging and
// production. See the gate-4 rename comment in lib/migrationGates.mjs.
test("fails a pure rename of a merged migration already in the .up.sql convention", () => {
  withRepo((dir) => {
    git(dir, "mv", "migrations/20260101000000_old.up.sql", "migrations/20260101000000_renamed.up.sql");
    git(dir, "mv", "migrations/20260101000000_old.down.sql", "migrations/20260101000000_renamed.down.sql");
    git(dir, "commit", "-qm", "rename");
    const { code, out } = check(dir);
    assert.equal(code, 1, out);
    assert.match(out, /immutability/);
    assert.match(out, /Not run migration .* is preceding already run migration/);
  });
});

// The half that must NOT regress: this is the adoption commit's shape — 55 legacy
// bare NAME.sql files renamed to NAME.up.sql, sources that no ledger has ever
// recorded. Exercised through real git rename detection, not a hand-built change
// record, because the discriminator reads change.from.
test("passes the adoption rename: a legacy bare NAME.sql becomes NAME.up.sql", () => {
  withRepo(
    (dir) => {
      git(dir, "mv", "migrations/20260103000000_legacy.sql", "migrations/20260103000000_legacy.up.sql");
      git(dir, "commit", "-qm", "adopt the up/down convention");
      const { code, out } = check(dir);
      assert.equal(code, 0, out);
      assert.match(out, /OK/);
    },
    { "20260103000000_legacy.sql": "SELECT 1;\n" }
  );
});

// C2: `.sql` matching is case-insensitive so a stray Foo.SQL surfaces as a naming
// failure here instead of being silently ignored by both this gate and the
// runner — a file in migrations/ that never runs and nothing reports.
test("fails on a .SQL file whose extension is not lowercase", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260202000000_new.UP.SQL"), "SELECT 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "shouty extension");
    const { code, out } = check(dir);
    assert.equal(code, 1, out);
    assert.match(out, /naming/);
    assert.match(out, /20260202000000_new\.UP\.SQL/);
  });
});

// C3: an orphan .down.sql is well-formed by gate 1 and invisible to gate 3's
// up-side check, but node-pg-migrate throws on it the moment it scans the
// directory.
test("fails on a .down.sql added with no matching .up.sql", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260202000000_orphan.down.sql"), "DROP TABLE t;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "orphan down");
    const { code, out } = check(dir);
    assert.equal(code, 1, out);
    assert.match(out, /reversibility/);
    assert.match(out, /without matching \.up\.sql/);
  });
});

test("fails when a new up migration has no down migration", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260202000000_new.up.sql"), "ALTER TABLE t ADD COLUMN c int;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "no down");
    const { code, out } = check(dir);
    assert.equal(code, 1);
    assert.match(out, /reversibility/);
  });
});

test("fails when a new migration contains a statement-level COMMIT", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "migrations", "20260202000000_new.up.sql"), "BEGIN;\nSELECT 1;\nCOMMIT;\n");
    writeFileSync(join(dir, "migrations", "20260202000000_new.down.sql"), "SELECT 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "own transaction");
    const { code, out } = check(dir);
    assert.equal(code, 1);
    assert.match(out, /transaction/);
  });
});

// Regression: finding 1. A rename whose destination the runner cannot see (it
// only reads migrations/ one level deep) used to vanish from the diff entirely
// — filesAtHead() dropped the new nested path, and changesSince() dropped the
// whole R record because its destination failed isTopLevelSql. A merged
// migration could be relocated out of the runner's view and the gate would
// print "OK" — see the FIX ROUND 1 report for the reproduction that found this.
test("fails when a merged migration is renamed into a subdirectory the runner cannot see", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, "migrations", "baseline"));
    git(dir, "mv", "migrations/20260101000000_old.up.sql", "migrations/baseline/20260101000000_old.up.sql");
    git(dir, "commit", "-qm", "move out of the runner's view");
    const { code, out } = check(dir);
    assert.equal(code, 1, out);
    assert.match(out, /immutability/);
  });
});

// Regression: finding 2. evaluate() only branches on A/M/D/R. Git also emits T
// (typechange) — e.g. a merged .up.sql swapped for a symlink of the same name,
// same path, no content diff to compare. The old CLI counted it as "changed"
// but never routed it to a status the gate understood, so it fell through
// silently and the gate printed "OK" for an unreviewed change to a merged file.
test("fails when a merged migration changes type (e.g. becomes a symlink)", () => {
  withRepo((dir) => {
    const target = join(dir, "migrations", "20260101000000_old.up.sql");
    rmSync(target);
    symlinkSync("20260101000000_old.down.sql", target);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "typechange");
    const { code, out } = check(dir);
    assert.equal(code, 1, out);
    assert.match(out, /unrecognised/);
  });
});

// Regression: finding 3. `--base` with no following value used to silently
// fall through to the default base resolution instead of erroring, which
// would run the gate against the wrong ref with no indication anything was
// off.
test("fails with a clear error when --base is passed with no value", () => {
  withRepo((dir) => {
    const { code, out } = check(dir, ["--base"]);
    assert.equal(code, 1, out);
    assert.match(out, /--base/);
  });
});
