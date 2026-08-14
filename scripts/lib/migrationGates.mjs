/**
 * Static gates on the migrations directory — no database, no network.
 *
 * Gate 4 is the one that does not look like the others. node-pg-migrate's ledger
 * stores only (id, name, run_on), so unlike Flyway it cannot notice that an
 * already-applied migration file was edited afterwards — the file would differ
 * from what actually ran, in every environment, silently and forever. Comparing
 * against the base branch is that missing checksum, moved earlier: a modified
 * migration fails review instead of failing a deploy.
 */
import { parseMigrationFilename } from "./migrationFiles.mjs";

/**
 * A statement-level transaction control keyword: start of line, then the
 * keyword, then a semicolon. PL/pgSQL's block BEGIN has no semicolon after it,
 * so a DO $$ ... BEGIN ... END $$ block does not match.
 *
 * Known limitations (both acceptable):
 * - A statement-level keyword not alone on its line is NOT caught (e.g.,
 *   "SELECT 1; BEGIN;"). Acceptable because this repo's migrations always put
 *   BEGIN/COMMIT on their own lines.
 * - A BEGIN inside a multi-line string literal WOULD false-positive. Acceptable
 *   because the worst case is a blocked PR and a reworded migration, not an
 *   unsafe one — the gate has no string/dollar-quote awareness.
 */
const TX_KEYWORD_RE = /^[ \t]*(BEGIN|COMMIT|ROLLBACK)[ \t]*;/gim;
const IRREVERSIBLE_RE = /^\s*--\s*irreversible:/im;

export function evaluate({ headFiles, baseFiles, changes, contents }) {
  const failures = [];
  const fail = (gate, file, message) => failures.push({ gate, file, message });

  // Gate 1 — naming. Everything in migrations/ that ends in .sql must be a
  // migration the runner can see. A file the runner skips is a file that never
  // runs, which is how run_pending_migrations.sh drifted.
  for (const file of headFiles) {
    if (!parseMigrationFilename(file)) {
      fail(
        "naming",
        file,
        `'${file}' is not a valid migration filename. ` +
          "Expected YYYYMMDDHHMMSS_lower_snake_slug.up.sql or .down.sql."
      );
    }
  }

  const baseSet = new Set(baseFiles);
  const headSet = new Set(headFiles);
  const added = changes.filter((c) => c.status === "A").map((c) => c.file);

  // Gate 4 — immutability of merged migrations.
  for (const change of changes) {
    if (change.status === "M" || change.status === "D") {
      if (baseSet.has(change.file)) {
        fail(
          "immutability",
          change.file,
          `'${change.file}' is already merged and must not be ${
            change.status === "D" ? "deleted" : "modified"
          }. ` +
            "It has already run against staging and production; editing it makes the file " +
            "disagree with what those databases actually executed. Write a new migration instead."
        );
      }
    }
    if (change.status === "R" && Number(change.similarity) !== 100) {
      // Coerce similarity to a number: it comes from git-status parsing in Task 9's CLI
      // and must not depend on type discipline across the boundary. If this ever regresses
      // to string comparison, a genuine "100" rename fails review as a content-changing
      // rename — the opposite of what happened — affecting all 55 renames in the adoption.
      const similarityPct = Number(change.similarity);
      const similarityStr = Number.isNaN(similarityPct) ? "unknown" : `${similarityPct}%`;
      fail(
        "immutability",
        change.file,
        `'${change.from}' -> '${change.file}' is a rename that also changed the content ` +
          `(${similarityStr} similar). Rename or edit, not both.`
      );
    }
  }

  // Gate 2 — ordering. checkOrder:true would reject a backdated migration at
  // apply time, on staging, after merge. Reject it at review time instead.
  const baseTimestamps = baseFiles
    .map((f) => parseMigrationFilename(f)?.timestamp)
    .filter(Boolean)
    .sort();
  const newestBase = baseTimestamps[baseTimestamps.length - 1];
  if (newestBase) {
    // Only check .up files (migrations are added in pairs, so checking both
    // would flag the same violation twice).
    const addedUpFiles = added.filter((f) => f.endsWith(".up.sql"));
    for (const file of addedUpFiles) {
      const parsed = parseMigrationFilename(file);
      if (parsed && parsed.timestamp <= newestBase) {
        fail(
          "ordering",
          file,
          `'${file}' has timestamp ${parsed.timestamp}, which is not newer than ${newestBase}, ` +
            "the newest migration already on the base branch. Two PRs merging out of order " +
            "produce a history that replays differently than it applied. Re-stamp the filename."
        );
      }
    }
  }

  // Gates 3 and 5 apply only to migrations this branch introduces. Historical
  // files are frozen: 14 of them carry their own BEGIN/COMMIT and stay that way.
  for (const file of added) {
    const parsed = parseMigrationFilename(file);
    if (!parsed) continue;
    const body = contents[file] ?? "";

    if (parsed.direction === "up") {
      const downFile = `${parsed.timestamp}_${parsed.slug}.down.sql`;
      if (!headSet.has(downFile) && !IRREVERSIBLE_RE.test(body)) {
        fail(
          "reversibility",
          file,
          `'${file}' has no '${downFile}'. Add one, or declare the migration irreversible with ` +
            "a '-- irreversible: <reason>' comment in the up file."
        );
      }
    }

    for (const match of body.matchAll(TX_KEYWORD_RE)) {
      fail(
        "transaction",
        file,
        `'${file}' contains a statement-level '${match[1].toUpperCase()};'. The runner wraps each ` +
          "migration in its own transaction — an inner BEGIN warns, and the matching COMMIT closes " +
          "the outer transaction early, so the rest of the migration runs with no rollback behind it."
      );
    }
  }

  return { failures };
}
