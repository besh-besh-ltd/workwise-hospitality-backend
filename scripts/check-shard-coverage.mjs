#!/usr/bin/env node
/**
 * Proves that the CI shard patterns in tests/shards.json form an exact partition
 * of the test suite — every *.test.js file matched by EXACTLY ONE shard.
 *
 * This is the safety net that makes domain-based sharding viable. The failure
 * mode it exists to catch is silent and expensive: a newly added test file that
 * matches no shard pattern simply never runs, and CI stays green while the
 * coverage quietly rots. A duplicate match is milder (the suite runs twice,
 * wasting a slot) but still means the partition has drifted from intent.
 *
 *   node scripts/check-shard-coverage.mjs            # verify, human-readable
 *   node scripts/check-shard-coverage.mjs --matrix   # emit the GH Actions matrix
 *
 * Exit code is 0 only when the partition is exact, so it can gate the whole
 * workflow: if this fails, no shard jobs run at all.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "tests");
const CONFIG = join(ROOT, "tests", "shards.json");

const EMIT_MATRIX = process.argv.includes("--matrix");

/** Every Jest suite, as a repo-relative POSIX path (how the patterns are written). */
function findTestFiles() {
  return readdirSync(TEST_DIR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.js"))
    .map((e) => relative(ROOT, join(e.parentPath ?? e.path, e.name)).split(sep).join("/"))
    // Mirrors jest.config.js testPathIgnorePatterns.
    .filter((p) => !p.includes("/node_modules/"))
    .sort();
}

const { shards } = JSON.parse(readFileSync(CONFIG, "utf8"));
const files = findTestFiles();

if (files.length === 0) {
  console.error(`FAIL: no *.test.js files found under ${TEST_DIR}.`);
  console.error("      Either the tests moved or this script's glob is wrong — both are bugs.");
  process.exit(1);
}

// Unanchored match against the relative path — identical semantics to Jest's
// --testPathPatterns, which regex-matches anywhere in the (absolute) path.
const compiled = shards.map((s) => {
  let re;
  try {
    re = new RegExp(s.pattern);
  } catch (err) {
    console.error(`FAIL: shard "${s.name}" has an invalid regex: ${s.pattern}`);
    console.error(`      ${err.message}`);
    process.exit(1);
  }
  if (s.pattern.startsWith("^")) {
    console.error(`FAIL: shard "${s.name}" pattern starts with "^": ${s.pattern}`);
    console.error("      Jest matches --testPathPatterns against the ABSOLUTE path, so an");
    console.error("      anchored pattern selects zero suites and the job passes vacuously.");
    process.exit(1);
  }
  return { ...s, re, matches: [] };
});

const unmatched = [];
const duplicated = [];

for (const file of files) {
  const hits = compiled.filter((s) => s.re.test(file));
  for (const s of hits) s.matches.push(file);
  if (hits.length === 0) unmatched.push(file);
  else if (hits.length > 1) duplicated.push({ file, shards: hits.map((s) => s.name) });
}

if (EMIT_MATRIX && unmatched.length === 0 && duplicated.length === 0) {
  // One matrix entry per job. A shard with `split: n` becomes n jobs that carve
  // the same pattern up with Jest's own --shard, which is exhaustive by
  // construction, so the guard above only has to reason about the pattern layer.
  // `needsChromium` is carried through so the workflow can install a browser
  // only where one is actually used (see tests/shards.json). GitHub drops
  // matrix keys that are absent, so it is emitted as a string on every entry
  // rather than conditionally — `if: matrix.needsChromium == 'true'` then reads
  // the same on all shards instead of being undefined on most of them.
  const entry = (s, extra) => ({
    name: s.name,
    pattern: s.pattern,
    needsChromium: s.needsChromium ? "true" : "false",
    ...extra,
  });

  const include = compiled.flatMap((s) =>
    s.split
      ? Array.from({ length: s.split }, (_, i) =>
          entry(s, {
            name: `${s.name}-${i + 1}`,
            jestShard: `${i + 1}/${s.split}`,
            suites: `~${Math.ceil(s.matches.length / s.split)}`,
          })
        )
      : [entry(s, { jestShard: "", suites: String(s.matches.length) })]
  );
  process.stdout.write(JSON.stringify({ include }));
  process.exit(0);
}

// ---- human-readable report -------------------------------------------------
const width = Math.max(...compiled.map((s) => s.name.length));
console.log(`Shard coverage — ${files.length} suites across ${compiled.length} patterns\n`);
for (const s of compiled) {
  const jobs = s.split ? ` (÷${s.split} jobs, ~${Math.ceil(s.matches.length / s.split)} each)` : "";
  const bar = "█".repeat(Math.max(1, Math.round(s.matches.length / 2)));
  console.log(`  ${s.name.padEnd(width)}  ${String(s.matches.length).padStart(3)}  ${bar}${jobs}`);
  if (s.matches.length === 0) {
    console.log(`  ${" ".repeat(width)}  ^^ matches nothing — dead pattern`);
  }
}

const empty = compiled.filter((s) => s.matches.length === 0);
let failed = false;

if (unmatched.length > 0) {
  failed = true;
  console.error(`\nFAIL: ${unmatched.length} suite(s) match no shard and would NEVER RUN in CI:`);
  for (const f of unmatched) console.error(`  - ${f}`);
  console.error("\n  Add them to an existing pattern in tests/shards.json, or add a new shard.");
}

if (duplicated.length > 0) {
  failed = true;
  console.error(`\nFAIL: ${duplicated.length} suite(s) match more than one shard (they'd run twice):`);
  for (const d of duplicated) console.error(`  - ${d.file}  ->  ${d.shards.join(", ")}`);
  console.error("\n  Tighten the overlapping patterns in tests/shards.json.");
}

if (empty.length > 0) {
  failed = true;
  console.error(`\nFAIL: ${empty.length} shard(s) match no suites at all: ${empty.map((s) => s.name).join(", ")}`);
  console.error("  A shard that selects nothing passes vacuously and hides the drift that caused it.");
}

if (failed) {
  if (EMIT_MATRIX) console.error("\n(Refusing to emit a job matrix from a broken partition.)");
  process.exit(1);
}

console.log(`\nOK: all ${files.length} suites covered exactly once.`);
