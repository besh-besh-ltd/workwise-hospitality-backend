/**
 * Backfill PO PDFs left stale by approvals taken outside the dedicated endpoint.
 *
 * WHY. A PO PDF is a stored artefact: `po_pdf_url` points at a file in S3 and
 * the download endpoint hands that URL back verbatim (poVendorController.js:
 * `if (po.po_pdf_url) return ok(res, { url: po.po_pdf_url })`). Nothing
 * re-renders on download, so the approver table printed inside a PO only
 * changes when something rewrites the file.
 *
 * Until e6213263, regeneration lived solely in the dedicated PO approval
 * endpoint. POs approved from the RFQ Lifecycle Journey or the generic action
 * endpoint transitioned correctly in the database but kept whatever PDF was
 * last written — printing approvers who had in fact approved as "Invited".
 * Observed on PO 483 / RFQ 536375: step 1 approved via the dedicated endpoint
 * (PDF rewritten 2.8s later), step 2 approved elsewhere 18h later (PDF frozen).
 *
 * That fix is preventive only. These POs are already fully APPROVED, so no
 * further approval will ever fire for them — an explicit regenerate is the only
 * thing that repairs the stored document.
 *
 * HOW TARGETS ARE FOUND. Both write sites name the S3 key
 * `po-<po_number>-<Date.now()>.pdf`, so the filename carries the moment the PDF
 * was written. A PO is stale when its newest APPROVED decision is later than
 * that. (`po.updated_at` cannot be used: the post-approval status transition
 * bumps it after every decision, so it is always newer than the approval.)
 *
 * USAGE — from the repo root on a host with the app's .env, S3 creds and
 * puppeteer available:
 *
 *   node scripts/backfill_stale_po_pdfs.mjs              # dry run, changes nothing
 *   node scripts/backfill_stale_po_pdfs.mjs --confirm    # rewrite the PDFs
 *   node scripts/backfill_stale_po_pdfs.mjs --confirm --ids 483,485
 *
 * Idempotent: regeneratePODocument is the same call the approval flow makes.
 * Re-running is safe, and re-running the dry run afterwards should report none.
 */
import db from '../app/config/dbConn.js';
import { regeneratePODocument } from '../app/models/purchaseOrderModel.js';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const idsArg = args.includes('--ids') ? args[args.indexOf('--ids') + 1] : null;
const onlyIds = idsArg ? idsArg.split(',').map((n) => parseInt(n.trim(), 10)).filter(Number.isFinite) : null;

const STALE_SQL = `
  SELECT po.id, po.po_number, po.po_pdf_url,
         MAX(a.acted_at) AS last_approval,
         to_timestamp((regexp_match(po.po_pdf_url, '-([0-9]{13})\\.pdf'))[1]::bigint / 1000.0)
           AT TIME ZONE 'UTC' AS pdf_written_at
    FROM tbl_rfq_purchase_order po
    JOIN tbl_approval_instances ai     ON ai.id = po.approval_instance_id
    JOIN tbl_approval_instance_steps s ON s.approval_instance_id = ai.id
    JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id
   WHERE ai.status = 'APPROVED' AND a.status = 'APPROVED'
     AND po.po_pdf_url ~ '-[0-9]{13}\\.pdf'
   GROUP BY po.id, po.po_number, po.po_pdf_url
  HAVING MAX(a.acted_at) > to_timestamp((regexp_match(po.po_pdf_url, '-([0-9]{13})\\.pdf'))[1]::bigint / 1000.0) AT TIME ZONE 'UTC'
   ORDER BY MAX(a.acted_at) DESC`;

// PDFs written before the timestamped-key convention, or via the local-path
// fallback. They cannot be dated from the filename, so the check above is blind
// to them — reported, never auto-regenerated.
const UNDATED_SQL = `
  SELECT id, po_number, po_pdf_url FROM tbl_rfq_purchase_order
   WHERE po_pdf_url IS NOT NULL AND po_pdf_url <> '' AND po_pdf_url !~ '-[0-9]{13}\\.pdf'
   ORDER BY id`;

const iso = (d) => (d instanceof Date ? d.toISOString().replace('T', ' ').slice(0, 19) : String(d));

const main = async () => {
  let rows = await db.any(STALE_SQL);
  if (onlyIds) rows = rows.filter((r) => onlyIds.includes(Number(r.id)));

  const undated = await db.any(UNDATED_SQL);

  console.log(`\nStale PO PDFs: ${rows.length}${onlyIds ? ` (filtered to ${onlyIds.join(',')})` : ''}`);
  for (const r of rows) {
    console.log(
      `  PO ${String(r.id).padEnd(5)} ${String(r.po_number).padEnd(9)} ` +
      `pdf ${iso(r.pdf_written_at)}  <  approval ${iso(r.last_approval)}`
    );
  }
  if (undated.length) {
    console.log(`\nUndated PDFs (cannot be checked automatically): ${undated.length}`);
    for (const u of undated) console.log(`  PO ${String(u.id).padEnd(5)} ${u.po_number}`);
  }

  if (!rows.length) { console.log('\nNothing to do.\n'); return 0; }

  if (!confirm) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --confirm to rewrite these PDFs.\n');
    return 0;
  }

  console.log('\nRegenerating…');
  let ok = 0, failed = 0;
  // Sequential on purpose: each regeneration launches a headless browser.
  for (const r of rows) {
    process.stdout.write(`  PO ${r.id} … `);
    try {
      const url = await regeneratePODocument(r.id);
      if (url) { console.log(`OK  ${url}`); ok++; }
      else { console.log('FAILED (regeneratePODocument returned null)'); failed++; }
    } catch (err) {
      console.log(`FAILED ${err?.message || err}`);
      failed++;
    }
  }
  console.log(`\nregenerated: ${ok}   failed: ${failed}\n`);
  return failed ? 1 : 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('backfill failed:', err); process.exit(1); });
