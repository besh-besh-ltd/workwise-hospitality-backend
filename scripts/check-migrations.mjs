#!/usr/bin/env node
/**
 * Static gates on the migrations directory. No database, no npm install — this
 * belongs in the ~10s fail-fast CI job beside check-shard-coverage.mjs and
 * check-response-in-tx.mjs, not in the replay job.
 *
 *   node scripts/check-migrations.mjs                  # base = origin/<PR target>, else origin/main
 *   node scripts/check-migrations.mjs --base origin/qa
 *
 * Exit code is 0 only when every gate passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./lib/migrationGates.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "migrations";

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function resolveBase() {
  const flagIndex = process.argv.indexOf("--base");
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (!value) {
      console.error("FAIL: --base requires a value, e.g. --base origin/qa.");
      process.exit(1);
    }
    return value;
  }
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "origin/main";
}

/**
 * True for a directory-relative path that names a .sql file directly inside
 * migrations/, not nested in a subdirectory. migrationFiles.mjs#listMigrations
 * reads the runner's view of that same directory with a non-recursive
 * readdirSync(dir), so anything git finds one level deeper — e.g. the
 * migrations/baseline/ snapshot dump — is invisible to the runner. The CLI's
 * file-listing must agree byte-for-byte with that view (see the docstring atop
 * migrationFiles.mjs), or gates fire on files node-pg-migrate never touches.
 */
function isTopLevelSql(strippedPath) {
  return strippedPath.endsWith(".sql") && !strippedPath.includes("/");
}

/** Migration-directory-relative .sql filenames at a git ref. */
function filesAt(ref) {
  return git("ls-tree", "-r", "--name-only", ref, "--", `${DIR}/`)
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(`${DIR}/`.length))
    .filter(isTopLevelSql);
}

function filesAtHead() {
  return git("ls-files", "--", `${DIR}/`)
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(`${DIR}/`.length))
    .filter(isTopLevelSql);
}

// migrationGates.mjs#evaluate only understands these four statuses. Anything
// else — typechange 'T' (e.g. a merged .up.sql swapped for a symlink of the
// same name), copy 'C', unmerged 'U', or a status a future git version adds —
// must not be quietly dropped or quietly passed through: an unrecognised
// change to what might be a merged migration is by definition unreviewed.
const HANDLED_STATUSES = new Set(["A", "M", "D", "R"]);

function changesSince(base) {
  const raw = git("diff", "--name-status", "--find-renames", `${base}...HEAD`, "--", `${DIR}/`);
  const strip = (p) => p.slice(`${DIR}/`.length);

  const changes = [];
  const unrecognized = [];

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const [code, ...paths] = line.split("\t");
    const status = code[0];

    if (!HANDLED_STATUSES.has(status)) {
      unrecognized.push({ code, file: strip(paths[paths.length - 1]) });
      continue;
    }

    if (status === "R") {
      const similarity = Number(code.slice(1));
      const from = strip(paths[0]);
      const file = strip(paths[1]);
      if (isTopLevelSql(file)) {
        changes.push({ status, similarity, from, file });
        continue;
      }
      // The rename's destination is not a top-level migrations/*.sql file (e.g.
      // it moved into migrations/baseline/), so filesAtHead() no longer lists
      // it and it would otherwise vanish from this diff entirely — a merged
      // migration relocated out of the runner's non-recursive readdirSync,
      // with the gate printing "OK". If the source WAS a top-level file (i.e.
      // a file the runner, and gate 4, could see), report the move as the
      // deletion it effectively is; gate 4 already rejects deleting a merged
      // migration, so this reuses that check instead of adding a new one.
      if (isTopLevelSql(from)) {
        changes.push({ status: "D", file: from });
      }
      continue;
    }

    const file = strip(paths[0]);
    if (isTopLevelSql(file)) changes.push({ status, file });
  }

  if (unrecognized.length > 0) {
    console.error(
      "FAIL: unrecognised git status code(s) under migrations/ — evaluate() only handles A, M, D and R:"
    );
    for (const { code, file } of unrecognized) console.error(`  - '${file}': status '${code}'`);
    console.error(
      "      An unrecognised change to a possibly-merged migration cannot be evaluated safely. " +
        "Resolve it manually (e.g. undo a type change) rather than merging it unreviewed."
    );
    process.exit(1);
  }

  return changes;
}

const base = resolveBase();
try {
  git("rev-parse", "--verify", `${base}^{commit}`);
} catch {
  console.error(`FAIL: base ref '${base}' is not reachable.`);
  console.error("      In CI, checkout must use fetch-depth: 0 so the base branch is present.");
  process.exit(1);
}

const headFiles = filesAtHead();
const baseFiles = filesAt(base);
const changes = changesSince(base);

const contents = {};
for (const change of changes) {
  if (change.status !== "A") continue;
  const path = join(ROOT, DIR, change.file);
  // If an added file is in the diff but missing from disk, contents[file] stays
  // unset and evaluate() reads it as "" — that fails safe for gate 3 (missing
  // down-file still gets flagged) but would silently hide a gate 5 (transaction)
  // violation in content the CLI never actually read. Deliberately unhandled:
  // unreachable in normal CI, since the working tree matches HEAD right after
  // checkout.
  if (existsSync(path)) contents[change.file] = readFileSync(path, "utf8");
}

const { failures } = evaluate({ headFiles, baseFiles, changes, contents });

const added = changes.filter((c) => c.status === "A").length;
console.log(
  `Migration gates — base ${base}: ${headFiles.length} file(s) on HEAD, ${added} added, ${changes.length} changed`
);

if (failures.length === 0) {
  console.log("\nOK: naming, ordering, reversibility, immutability and transaction gates all pass.");
  process.exit(0);
}

const byGate = new Map();
for (const f of failures) byGate.set(f.gate, [...(byGate.get(f.gate) ?? []), f]);
for (const [gate, items] of byGate) {
  console.error(`\nFAIL [${gate}] — ${items.length} problem(s):`);
  for (const item of items) console.error(`  - ${item.message}`);
}
console.error(`\nSee migrations/README.md for the conventions these gates enforce.`);
process.exit(1);
