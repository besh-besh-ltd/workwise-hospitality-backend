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
import { parseMigrationFilename, ledgerName } from "./migrationFiles.mjs";

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

const KNOWN_CHANGE_STATUSES = new Set(["A", "M", "D", "R"]);

/**
 * A filename already written in the runner's own convention. The discriminator
 * for gate 4's rename rule — see the comment at its use site.
 */
const NEW_CONVENTION_RE = /\.(up|down)\.sql$/i;

/** The bare id node-pg-migrate stores in pgmigrations.name, for error messages. */
function ledgerIdOf(file) {
  const parsed = parseMigrationFilename(file);
  return parsed ? ledgerName(parsed.id) : file;
}

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

  // Gate 3a — an orphan .down.sql. node-pg-migrate's 'sql' loader groups
  // NAME.up.sql with NAME.down.sql by id and throws
  //   Found .down.sql without matching .up.sql for <id>
  // (dist/legacy/migrationLoader.js:236) the moment it scans the directory —
  // i.e. on every `migrate:up` and `migrate:down`, in every environment. Nothing
  // else here catches it: gate 1 accepts the filename (it IS well-formed), and
  // gate 3b only looks at *added up* files, so a down file added alone, or an up
  // file dropped from an unmerged pair, sails through all five gates and lands
  // as a deploy failure instead of a review failure.
  //
  // Checked across the whole HEAD tree rather than only the diff: the directory
  // either pairs up or it does not, and the runner does not care which commit
  // broke it.
  const upIds = new Set();
  const downOnHead = [];
  for (const file of headFiles) {
    const parsed = parseMigrationFilename(file);
    if (!parsed) continue;
    if (parsed.direction === "up") upIds.add(parsed.id);
    else downOnHead.push(parsed);
  }
  for (const parsed of downOnHead) {
    if (upIds.has(parsed.id)) continue;
    const upFile = `${parsed.timestamp}_${parsed.slug}.up.sql`;
    fail(
      "reversibility",
      parsed.filename,
      `'${parsed.filename}' has no matching '${upFile}'. node-pg-migrate pairs the two by id and ` +
        `throws "Found .down.sql without matching .up.sql for ${parsed.id}" as soon as it scans ` +
        "migrations/, so every migrate:up and migrate:down fails — on staging and production, not " +
        "just here. Add the up file, or delete the orphan down file."
    );
  }

  const baseSet = new Set(baseFiles);
  const headSet = new Set(headFiles);
  const added = changes.filter((c) => c.status === "A").map((c) => c.file);

  // Gate 4 — immutability of merged migrations.
  for (const change of changes) {
    // Defensive: check-migrations.mjs is expected to reject anything other than
    // A/M/D/R before it ever reaches evaluate(), but this function is the actual
    // authority the CLI is a thin shell around, and it may not be the only
    // caller. A status this loop does not recognise (git typechange 'T', copy
    // 'C', unmerged 'U', or something a future git adds) touching a file that is
    // already on the base branch is, by definition, an unreviewed change to a
    // merged migration — fail it instead of silently matching none of the
    // branches below and passing through as if nothing happened.
    if (!KNOWN_CHANGE_STATUSES.has(change.status)) {
      if (baseSet.has(change.file)) {
        fail(
          "immutability",
          change.file,
          `'${change.file}' is already merged and has an unrecognised git status ` +
            `('${change.status}'). This gate only understands add/modify/delete/rename; ` +
            "refusing to silently allow an unreviewed change to a merged migration."
        );
      }
      continue;
    }
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
    // A rename of an already-merged migration that is ALREADY in the runner's
    // convention. The similarity check below does not catch this: a pure `git mv`
    // is 100% similar and used to pass every gate.
    //
    // What it costs. pgmigrations still holds the OLD id while migrations/ now
    // yields the NEW one, and node-pg-migrate's checkOrder compares the two
    // positionally — so the very next `migrate:up` throws
    //   Not run migration <new> is preceding already run migration <old>
    // on staging AND production, and keeps throwing until somebody renames the
    // file back or hand-edits the ledger. A deploy freeze, reachable through
    // green CI: the replay job only notices when the migration is BASELINED
    // (MANIFEST still carries the old id). Rename one merged after the baseline
    // and the replay simply applies it fresh under its new name, no conflict
    // arises, CI is green, and the first symptom is the staging deploy.
    //
    // Why `from` and not `file`. This branch's adoption commit renamed 55 files,
    // and every one of those rename SOURCES is a legacy bare NAME.sql — zero were
    // already .up.sql/.down.sql. That is the discriminator, and it is exact:
    // "was the source already in the new convention?" separates the one-time
    // adoption (legal, and must stay legal) from renaming a migration the runner
    // has already recorded (never legal). It also closes the reverse case — a
    // file moved from a subdirectory back to top level — since that source is
    // top-level-invisible and reported as a delete before it reaches here.
    if (change.status === "R" && baseSet.has(change.from) && NEW_CONVENTION_RE.test(change.from)) {
      fail(
        "immutability",
        change.file,
        `'${change.from}' -> '${change.file}' renames a migration that is already merged. ` +
          `The ledger keeps recording it as '${ledgerIdOf(change.from)}' while migrations/ now offers ` +
          `'${ledgerIdOf(change.file)}', and node-pg-migrate compares them positionally — so every ` +
          `subsequent 'migrate:up' fails with "Not run migration ${ledgerIdOf(change.file)} is ` +
          `preceding already run migration ${ledgerIdOf(change.from)}", on staging AND production, ` +
          "until the file is renamed back or pgmigrations is hand-edited. Rename it back; if the " +
          "name is wrong, write a NEW migration instead."
      );
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
