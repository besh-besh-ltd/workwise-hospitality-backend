#!/usr/bin/env node
/**
 * Report — and optionally rebuild — PO documents.
 *
 * Background. `po_pdf_url` points at a file in S3; downloading serves that file
 * rather than rendering on demand, so the approver table printed inside it only
 * changes when something rewrites it. Until 2026-08-25 a failed rewrite was
 * swallowed at three separate levels, so the approval committed, the PO moved
 * to acceptance_pending, and the vendor was emailed a link to the document from
 * *before* the approval. Sixteen POs in hospitality_main are in that state.
 *
 * Two things make this safe to run:
 *
 *   1. Rebuilds are NON-DESTRUCTIVE in S3. Every write uses a fresh key
 *      (`po-<number>-<epoch_ms>.pdf`), so the previous PDF object is never
 *      overwritten — only the `po_pdf_url` pointer moves.
 *   2. Every pointer this script moves is journalled to a revert file before
 *      the change, so `--revert` puts them all back exactly.
 *
 * Modes:
 *   --stale         (default) only POs whose document predates their latest approval
 *   --all           every live PO with an approval instance
 *   --include-dead  also consider rejected / cancelled POs (normally skipped:
 *                   a reject never rewrites its document, so they read as
 *                   permanently stale and rebuilding them is churn)
 *
 * Usage:
 *   node scripts/repair_stale_po_documents.mjs                      # report, stale only
 *   node scripts/repair_stale_po_documents.mjs --verify             # render each locally, write nothing
 *   node scripts/repair_stale_po_documents.mjs --all                # report, everything
 *   node scripts/repair_stale_po_documents.mjs --repair             # rebuild the stale ones
 *   node scripts/repair_stale_po_documents.mjs --repair --po 507,510
 *   node scripts/repair_stale_po_documents.mjs --revert po-doc-revert-<ts>.json
 *
 * Read-only unless --repair or --revert is passed, and both confirm first.
 *
 * On --all: read the warning it prints. Regenerating a PO that settled months
 * ago hands the client a PDF built by today's template and today's pricing code
 * for a purchase order they consider closed — and in some cases one a vendor has
 * already accepted against. That is a business decision, not a cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import db from '../app/config/dbConn.js';
import { writePoDocument } from '../app/services/poDocumentService.js';
import seoController from '../app/controllers/seo/seoController.js';

// Which database is this actually pointed at?
//
// dbConn.js takes DATABASE_NAME from the environment, and backend/.env says
// `hospitality_stage`. dotenv does not override an already-set variable, so
// `DATABASE_NAME=hospitality_main node scripts/...` reaches production — a
// difference of one word between reporting on staging and rewriting live
// purchase orders. Every run prints where it is connected before it does
// anything, and a production repair has to be confirmed by name.
const PRODUCTION_DB = 'hospitality_main';

// Purchase orders nothing will act on again.
//
// Staleness is measured against the last APPROVED action, so a PO that
// collected two approvals and was then REJECTED reads as permanently stale — a
// reject never rewrites the document, by design. Four of the sixteen damaged
// production POs are that shape. They were genuinely hit by the bug at the
// time, but they are dead orders now and rebuilding their documents would be
// churn on something nobody will ever open.
//
// --include-dead brings them back if you specifically want them.
const DEAD_PO_STATUSES = ['draft', 'rejected', 'rejected_by_vendor', 'cancelled'];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1];
};

const REPAIR = has('--repair');
const ALL = has('--all');
const REVERT_FILE = valueOf('--revert');
const ONLY = (valueOf('--po') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const MAX_AGE_DAYS = valueOf('--max-age-days') ? Number(valueOf('--max-age-days')) : null;
const INCLUDE_DEAD = has('--include-dead');
const VERIFY = has('--verify');

// Non-interactive confirmation.
//
// The prompts below are for a human at a terminal. They cannot be answered by
// piping: Node's readline promise API never settles a SECOND question once
// stdin has hit EOF, so `printf 'name\nyes\n' | ...` hangs at the second gate
// and the run winds down having written nothing. (Safely — but silently.)
//
// So a non-interactive run states its intent on the command line instead, where
// it is explicit, lands in shell history, and can be read back afterwards:
//
//   --confirm-db hospitality_main --yes
//
// Both are required together, and --confirm-db still has to match the database
// actually connected — the whole point of the gate is that the target is named
// deliberately rather than inherited from an environment variable.
const CONFIRM_DB = valueOf('--confirm-db');
const ASSUME_YES = has('--yes');
const NON_INTERACTIVE = Boolean(CONFIRM_DB) || ASSUME_YES;

// When the document was last written.
//
// `po_document_generated_at` is authoritative but only exists after migration
// 20260825120000. Every row written before that — which is all of them, today —
// is dated from the millisecond timestamp in its own S3 key:
//
//     .../purchase-order/po-138757-1756000000000.pdf
//
// Built at runtime rather than as a constant because this script has to run on
// both sides of that migration: it is the tool for repairing damage that exists
// BEFORE the schema change ships.
const KEY_TIMESTAMP_SQL = `
    CASE WHEN po.po_pdf_url ~ '-[0-9]{13}\\.pdf$'
         THEN to_timestamp((regexp_match(po.po_pdf_url, '-([0-9]{13})\\.pdf$'))[1]::bigint / 1000.0) AT TIME ZONE 'UTC'
    END`;

async function pdfWrittenAtSql() {
  const hasColumn = await db.oneOrNone(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tbl_rfq_purchase_order'
        AND column_name = 'po_document_generated_at'`
  );
  return hasColumn
    ? `COALESCE(po.po_document_generated_at, ${KEY_TIMESTAMP_SQL})`
    : `(${KEY_TIMESTAMP_SQL})`;
}

const ageInDays = (ts) =>
  ts ? Math.round((Date.now() - new Date(`${ts}Z`).getTime()) / 86_400_000) : null;

async function findCandidates() {
  const PDF_WRITTEN_AT = await pdfWrittenAtSql();

  // The staleness predicate is the same one the watchdog uses; --all simply
  // drops it and takes every non-draft PO that has an approval behind it.
  const staleClause = ALL
    ? 'TRUE'
    : `(po.po_pdf_url IS NULL OR po.po_pdf_url = ''
        OR ${PDF_WRITTEN_AT} IS NULL
        OR ${PDF_WRITTEN_AT} < la.acted_at)`;

  return db.any(
    `
    WITH last_approval AS (
      SELECT ais.approval_instance_id, MAX(sa.acted_at) AS acted_at
        FROM tbl_approval_instance_steps ais
        JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = ais.id
       WHERE sa.status = 'APPROVED'
       GROUP BY ais.approval_instance_id
    )
    SELECT po.id, po.po_number, po.status, po.rfq_id, po.po_pdf_url,
           ${PDF_WRITTEN_AT} AS pdf_written_at,
           la.acted_at       AS last_approval_at,
           u.name            AS last_approver
      FROM tbl_rfq_purchase_order po
      JOIN tbl_approval_instances ai ON ai.id = po.approval_instance_id
      JOIN last_approval la ON la.approval_instance_id = po.approval_instance_id
      LEFT JOIN LATERAL (
        SELECT sa2.approver_user_id
          FROM tbl_approval_instance_steps ais2
          JOIN tbl_approval_step_approvers sa2 ON sa2.approval_instance_step_id = ais2.id
         WHERE ais2.approval_instance_id = po.approval_instance_id AND sa2.status = 'APPROVED'
         ORDER BY sa2.acted_at DESC LIMIT 1
      ) last_actor ON true
      LEFT JOIN tbl_users u ON u.id = last_actor.approver_user_id
     WHERE po.approval_instance_id IS NOT NULL
       AND (po.status::text <> ALL ($3::text[]))
       AND ($4::bool OR ai.status <> ALL (ARRAY['REJECTED', 'CANCELLED']))
       AND ${staleClause}
       AND ($1::int IS NULL OR la.acted_at > NOW() - ($1::text || ' days')::interval)
       AND ($2::int[] IS NULL OR po.id = ANY($2::int[]))
     ORDER BY la.acted_at DESC
    `,
    [
      MAX_AGE_DAYS,
      ONLY.length ? ONLY : null,
      INCLUDE_DEAD ? ['draft'] : DEAD_PO_STATUSES,
      INCLUDE_DEAD,
    ]
  );
}

function report(rows) {
  console.log(
    `\n${ALL ? 'All non-draft POs with an approval' : 'POs whose document predates their latest approval'}: ${rows.length}\n`
  );
  console.log(['PO', 'Number', 'Status', 'Doc written', 'Last approval', 'Age', 'Approver'].join('  |  '));
  console.log('-'.repeat(104));
  for (const po of rows) {
    console.log(
      [
        String(po.id).padStart(4),
        String(po.po_number).padEnd(8),
        String(po.status).padEnd(18),
        String(po.pdf_written_at || 'none').slice(0, 19).padEnd(19),
        String(po.last_approval_at).slice(0, 19).padEnd(19),
        `${ageInDays(po.last_approval_at)}d`.padStart(5),
        po.last_approver || '?',
      ].join('  |  ')
    );
  }
}

function warnAbout(rows) {
  const old = rows.filter((p) => ageInDays(p.last_approval_at) > 30);
  // A vendor who has accepted has already read and acted on the document they
  // were sent. Replacing it under them is the one case worth naming separately.
  const accepted = rows.filter((p) =>
    ['accepted', 'dispatched', 'delivered', 'completed', 'grn_raised'].includes(String(p.status))
  );

  if (old.length) {
    console.log(
      `\n  WARNING  ${old.length} of these were approved more than 30 days ago.\n` +
        `           Both the PO template and the pricing code have changed since.\n` +
        `           A rebuild may produce a materially different PDF for a purchase\n` +
        `           order the client considers closed.`
    );
  }
  if (accepted.length) {
    console.log(
      `\n  WARNING  ${accepted.length} have already been accepted or fulfilled by the vendor.\n` +
        `           They have read and acted on the document they were sent.`
    );
  }
  if (ALL) {
    console.log(
      `\n  NOTE     --all rebuilds documents that are not actually wrong. Only the\n` +
        `           stale set needs repair; the rest is churn with the risks above.\n` +
        `           Run without --all to see the set that genuinely needs fixing.`
    );
  }
  console.log(
    `\n  Rebuilds are non-destructive in S3: each write lands on a new timestamped\n` +
      `  key, so every current PDF stays exactly where it is. Only the po_pdf_url\n` +
      `  pointer moves, and every move is journalled for --revert.`
  );
}

async function showConnection() {
  const row = await db.one(
    `SELECT current_database() AS db, current_user AS usr,
            inet_server_addr()::text AS host, version() AS ver`
  );
  const isProd = row.db === PRODUCTION_DB;
  console.log(
    `\n  Connected to: ${row.db}${isProd ? '   *** PRODUCTION ***' : ''}` +
    `\n  Host:         ${row.host || '(local socket)'}` +
    `\n  User:         ${row.usr}`
  );
  return { ...row, isProd };
}

// ONE readline interface for the whole run, closed at the end.
//
// This used to open and close a fresh interface per question. Interactively
// that works; on piped stdin it does not — closing the first interface ends the
// stream, so the second question reads EOF, returns '', and the run aborts.
// Safely, as it happens: the abort lands before any write and before the revert
// journal. But a two-gate confirmation that cannot be answered non-interactively
// is a gate that just fails shut, and this script has to be runnable from a
// deploy shell as well as by hand.
let sharedRl = null;
const rl = () => (sharedRl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
const closeRl = () => { sharedRl?.close(); sharedRl = null; };

async function ask(question) {
  return (await rl().question(question)).trim();
}

const confirm = async (question) => (await ask(question)).toLowerCase() === 'yes';

// Production asks for the database name rather than "yes", so the answer cannot
// come from muscle memory.
const confirmExact = async (question, expected) => (await ask(question)) === expected;

/**
 * Render every candidate locally and report whether it works.
 *
 * Writes nothing: no S3 upload, no database update, just a PDF in the local
 * scratch directory. The point is to find out BEFORE committing to a repair
 * whether these documents can still be produced at all — a PO from March is
 * being rendered by a template and a pricing path that have both moved since,
 * and the honest way to find out what that does is to do it and look.
 */
async function doVerify(rows) {
  console.log(`\nRendering ${rows.length} PO document(s) locally. Nothing is uploaded or written.\n`);

  const failures = [];
  for (const po of rows) {
    const row = await db.one(
      `SELECT PO.id, PO.company_id, RFQ.hospitality_company_id, RFQ.hotel_id
         FROM tbl_rfq_purchase_order PO JOIN tbl_rfq RFQ ON RFQ.id = PO.rfq_id
        WHERE PO.id = $1`,
      [po.id]
    );
    try {
      const out = await seoController.poPDF({
        po_id: row.id,
        company_id: row.company_id,
        hospitality_company_id: row.hospitality_company_id,
        hotel_id: row.hotel_id,
      });
      const size = fs.statSync(out.absolutePath).size;
      console.log(`  ${String(po.po_number).padEnd(8)} ${String(ageInDays(po.last_approval_at) + 'd').padStart(5)}  renders OK   ${(size / 1024).toFixed(0)} KB   ${out.absolutePath}`);
    } catch (err) {
      failures.push({ po, error: err.message });
      console.error(`  ${String(po.po_number).padEnd(8)} ${String(ageInDays(po.last_approval_at) + 'd').padStart(5)}  FAILS        ${err.message}`);
    }
  }

  console.log(`\n${rows.length - failures.length}/${rows.length} render cleanly.`);
  if (failures.length) {
    console.log('A --repair run would fail on these, leaving their documents as they are:');
    for (const f of failures) console.log(`  ${f.po.po_number}: ${f.error}`);
  }
  console.log('\nNothing was uploaded and nothing was written.\n');
}

async function doRepair(rows, conn) {
  report(rows);
  warnAbout(rows);

  // Non-interactive: both flags, and the named database must be the one we are
  // actually connected to.
  if (NON_INTERACTIVE) {
    if (!CONFIRM_DB || !ASSUME_YES) {
      console.log('\nNon-interactive runs need BOTH --confirm-db <name> and --yes. Nothing was written.');
      return;
    }
    if (CONFIRM_DB !== conn.db) {
      console.log(`\n--confirm-db said "${CONFIRM_DB}" but this connection is to "${conn.db}". Nothing was written.`);
      return;
    }
    console.log(`\nNon-interactive: --confirm-db ${CONFIRM_DB} --yes. Proceeding on ${rows.length} PO(s).`);
    return runRebuild(rows);
  }

  // Two gates on production, one everywhere else. Typing the database name is
  // the difference between "yes" muscle-memory and actually reading which
  // system you are about to rewrite.
  if (conn.isProd) {
    console.log(
      `\n  This will rewrite po_pdf_url on ${rows.length} PURCHASE ORDER(S) IN PRODUCTION.` +
      `\n  Existing PDF objects in S3 are untouched; only the pointers move, and` +
      `\n  every move is journalled so --revert can put them back.`
    );
    if (!(await confirmExact(`\n  Type the database name to continue (${PRODUCTION_DB}): `, PRODUCTION_DB))) {
      console.log('Name did not match. Aborted. Nothing was written.');
      return;
    }
  }

  if (!(await confirm(`\nRebuild ${rows.length} PO document(s)? Type "yes" to proceed: `))) {
    console.log('Aborted. Nothing was written.');
    return;
  }

  return runRebuild(rows);
}

async function runRebuild(rows) {
  // Journal BEFORE the first write, so an interrupted run is still revertible.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const journalPath = path.resolve(process.cwd(), `po-doc-revert-${stamp}.json`);
  fs.writeFileSync(
    journalPath,
    JSON.stringify(
      { created_at: stamp, mode: ALL ? 'all' : 'stale', entries: rows.map((p) => ({ id: p.id, po_number: p.po_number, previous_url: p.po_pdf_url })) },
      null,
      2
    )
  );
  console.log(`\nRevert journal written: ${journalPath}\n`);

  let ok = 0;
  const failures = [];
  for (const po of rows) {
    try {
      const url = await writePoDocument(po.id, db);
      ok += 1;
      console.log(`  ${po.po_number} (${po.id})  rebuilt`);
      console.log(`      was: ${po.po_pdf_url || 'none'}`);
      console.log(`      now: ${url}`);
    } catch (err) {
      failures.push({ po, error: err.message });
      console.error(`  ${po.po_number} (${po.id})  FAILED: ${err.message}`);
    }
  }

  console.log(`\nRebuilt ${ok}/${rows.length}.`);
  if (failures.length) {
    console.log(`Still failing (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.po.po_number}: ${f.error}`);
    process.exitCode = 1;
  }
  console.log(`\nTo undo: node scripts/repair_stale_po_documents.mjs --revert ${journalPath}`);
}

async function doRevert(conn) {
  const journal = JSON.parse(fs.readFileSync(REVERT_FILE, 'utf8'));
  const entries = journal.entries.filter((e) => e.previous_url);
  console.log(`\nRevert journal from ${journal.created_at} (mode: ${journal.mode})`);
  console.log(`Restores ${entries.length} of ${journal.entries.length} pointers ` +
              `(${journal.entries.length - entries.length} had no previous URL and are skipped).\n`);

  if (conn.isProd && !(await confirmExact(`  Type the database name to continue (${PRODUCTION_DB}): `, PRODUCTION_DB))) {
    console.log('Name did not match. Aborted. Nothing was written.');
    return;
  }

  if (!(await confirm(`Restore ${entries.length} po_pdf_url value(s)? Type "yes" to proceed: `))) {
    console.log('Aborted. Nothing was written.');
    return;
  }

  // Same pre-migration tolerance as everywhere else: clearing the stamp is
  // bookkeeping, restoring the pointer is the job.
  const hasStamp = await db.oneOrNone(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tbl_rfq_purchase_order'
        AND column_name = 'po_document_generated_at'`
  );

  for (const e of entries) {
    await db.none(
      hasStamp
        ? `UPDATE tbl_rfq_purchase_order
              SET po_pdf_url = $1, po_document_generated_at = NULL, updated_at = NOW()
            WHERE id = $2`
        : `UPDATE tbl_rfq_purchase_order
              SET po_pdf_url = $1, updated_at = NOW()
            WHERE id = $2`,
      [e.previous_url, e.id]
    );
    console.log(`  ${e.po_number} (${e.id})  restored`);
  }
  console.log(`\nRestored ${entries.length}.`);
}

async function main() {
  const conn = await showConnection();

  if (REVERT_FILE) return doRevert(conn);

  const rows = await findCandidates();
  if (!rows.length) {
    console.log(ALL ? 'No POs matched.' : 'No POs found with a document older than their own approval.');
    return;
  }

  if (VERIFY) {
    report(rows);
    return doVerify(rows);
  }

  if (!REPAIR) {
    report(rows);
    warnAbout(rows);
    console.log('\nReport only. Re-run with --repair to rebuild.');
    console.log('POs approved in the last 30 days are picked up automatically by the PO');
    console.log('document watchdog once deployed — this script is for the older ones.\n');
    return;
  }

  await doRepair(rows, conn);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Release the readline handle and the pg pool, then let Node exit on its
    // own. This used to call process.exit(), which does not flush pending
    // stdout writes to a pipe — so the tail of the run (the per-PO results and
    // the revert-journal path, i.e. exactly the record you need afterwards)
    // was silently truncated whenever the output was piped.
    closeRl();
    await db.$pool.end().catch(() => {});
  });
