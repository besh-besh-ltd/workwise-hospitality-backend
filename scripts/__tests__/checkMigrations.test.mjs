import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway repo with one committed migration on 'base', then a feature branch. */
function withRepo(fn) {
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
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-q", "-b", "feature");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(dir) {
  try {
    const stdout = execFileSync("node", ["scripts/check-migrations.mjs", "--base", "base"], {
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

test("passes a pure rename of a merged migration", () => {
  withRepo((dir) => {
    git(dir, "mv", "migrations/20260101000000_old.up.sql", "migrations/20260101000000_renamed.up.sql");
    git(dir, "mv", "migrations/20260101000000_old.down.sql", "migrations/20260101000000_renamed.down.sql");
    git(dir, "commit", "-qm", "rename");
    const { code, out } = check(dir);
    assert.equal(code, 0, out);
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
