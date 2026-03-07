#!/usr/bin/env node

/**
 * Vendor Rollback Script
 * =======================
 * Completely removes all data created by register-vendors.mjs.
 *
 * Deletes (in dependency order):
 *   1. tbl_product_variant_vendor_mapping (variant → vendor links)
 *   2. tbl_vendor_hotel_category_subscription (hotel/category/subcategory subs)
 *   3. tbl_vendor_payments (payment records)
 *   4. tbl_users_spoc (vendor SPOC contacts)
 *   5. tbl_users (vendor user record)
 *   6. tbl_company (vendor company record)
 *
 * Usage:
 *   node scripts/rollback-vendors.mjs <manifest-file>
 *   node scripts/rollback-vendors.mjs scripts/rollback-manifest-1234567890.json
 *
 *   Or rollback by vendor IDs directly:
 *   node scripts/rollback-vendors.mjs --ids 412,413,414
 *
 * Flags:
 *   --dry-run    Preview what would be deleted without making changes
 *   --force      Skip confirmation prompt
 */

import pg from 'pg-promise';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ── DB Connection ────────────────────────────────────────────
const pgp = pg();

pgp.pg.types.setTypeParser(1114, (s) => s);

const db = pgp({
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host: process.env.HOST,
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  ssl: { rejectUnauthorized: false },
});

function log(msg) {
  console.log(`[rollback-vendors] ${msg}`);
}

function logError(msg) {
  console.error(`[rollback-vendors] ERROR: ${msg}`);
}

// ── Prompt for confirmation ──────────────────────────────────
function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
    });
  });
}

// ── Rollback a single vendor ─────────────────────────────────
async function rollbackVendor(t, vendorId, companyId, dryRun) {
  const prefix = dryRun ? '[DRY RUN] ' : '';

  // 1. Delete product variant vendor mappings
  const variantCount = await t.one(
    'SELECT COUNT(*) AS cnt FROM tbl_product_variant_vendor_mapping WHERE vendor_id = $1',
    [vendorId]
  );
  log(`${prefix}  Deleting ${variantCount.cnt} product variant mappings for vendor_id=${vendorId}`);
  if (!dryRun) {
    await t.none('DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = $1', [vendorId]);
  }

  // 2. Delete vendor hotel/category subscriptions
  const subCount = await t.one(
    'SELECT COUNT(*) AS cnt FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1',
    [vendorId]
  );
  log(`${prefix}  Deleting ${subCount.cnt} subscriptions for vendor_id=${vendorId}`);
  if (!dryRun) {
    await t.none('DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1', [vendorId]);
  }

  // 3. Delete vendor payments
  const paymentCount = await t.one(
    'SELECT COUNT(*) AS cnt FROM tbl_vendor_payments WHERE vendor_id = $1',
    [vendorId]
  );
  log(`${prefix}  Deleting ${paymentCount.cnt} payment records for vendor_id=${vendorId}`);
  if (!dryRun) {
    await t.none('DELETE FROM tbl_vendor_payments WHERE vendor_id = $1', [vendorId]);
  }

  // 4. Delete SPOCs
  const spocCount = await t.one(
    'SELECT COUNT(*) AS cnt FROM tbl_users_spoc WHERE user_id = $1',
    [vendorId]
  );
  log(`${prefix}  Deleting ${spocCount.cnt} SPOC records for vendor_id=${vendorId}`);
  if (!dryRun) {
    await t.none('DELETE FROM tbl_users_spoc WHERE user_id = $1', [vendorId]);
  }

  // 5. Delete user notifications (if table exists)
  try {
    const notifCount = await t.one(
      'SELECT COUNT(*) AS cnt FROM tbl_user_notifications WHERE user_id = $1',
      [vendorId]
    );
    log(`${prefix}  Deleting ${notifCount.cnt} notification preferences for vendor_id=${vendorId}`);
    if (!dryRun) {
      await t.none('DELETE FROM tbl_user_notifications WHERE user_id = $1', [vendorId]);
    }
  } catch {
    // table might not exist, skip silently
  }

  // 6. Delete vendor-company mappings (if table exists)
  try {
    const vcmCount = await t.one(
      'SELECT COUNT(*) AS cnt FROM tbl_vendor_company_mapping WHERE vendor_id = $1',
      [vendorId]
    );
    log(`${prefix}  Deleting ${vcmCount.cnt} vendor-company mappings for vendor_id=${vendorId}`);
    if (!dryRun) {
      await t.none('DELETE FROM tbl_vendor_company_mapping WHERE vendor_id = $1', [vendorId]);
    }
  } catch {
    // table might not exist, skip silently
  }

  // 7. Delete company locations (if table exists and companyId provided)
  if (companyId) {
    try {
      const locCount = await t.one(
        'SELECT COUNT(*) AS cnt FROM tbl_company_location WHERE company_id = $1',
        [companyId]
      );
      log(`${prefix}  Deleting ${locCount.cnt} company locations for company_id=${companyId}`);
      if (!dryRun) {
        await t.none('DELETE FROM tbl_company_location WHERE company_id = $1', [companyId]);
      }
    } catch {
      // table might not exist, skip silently
    }
  }

  // 8. Delete user files (if table exists)
  try {
    const fileCount = await t.one(
      'SELECT COUNT(*) AS cnt FROM tbl_user_files WHERE user_id = $1',
      [vendorId]
    );
    log(`${prefix}  Deleting ${fileCount.cnt} user files for vendor_id=${vendorId}`);
    if (!dryRun) {
      await t.none('DELETE FROM tbl_user_files WHERE user_id = $1', [vendorId]);
    }
  } catch {
    // table might not exist, skip silently
  }

  // 9. Delete user record
  const userExists = await t.oneOrNone('SELECT id, name, email, company_id FROM tbl_users WHERE id = $1', [vendorId]);
  if (userExists) {
    log(`${prefix}  Deleting user record: id=${vendorId}, email=${userExists.email}, name=${userExists.name}`);
    if (!dryRun) {
      await t.none('DELETE FROM tbl_users WHERE id = $1', [vendorId]);
    }
  } else {
    log(`${prefix}  User id=${vendorId} not found (already deleted?)`);
  }

  // 10. Delete company record
  const effectiveCompanyId = companyId || userExists?.company_id;
  if (effectiveCompanyId) {
    // Check no other users reference this company
    const otherUsers = await t.any(
      'SELECT id FROM tbl_users WHERE company_id = $1 AND id != $2',
      [effectiveCompanyId, vendorId]
    );
    if (otherUsers.length > 0) {
      log(`${prefix}  Skipping company_id=${effectiveCompanyId} deletion — ${otherUsers.length} other users reference it`);
    } else {
      const companyExists = await t.oneOrNone('SELECT id, company_name FROM tbl_company WHERE id = $1', [effectiveCompanyId]);
      if (companyExists) {
        log(`${prefix}  Deleting company record: id=${effectiveCompanyId}, name=${companyExists.company_name}`);
        if (!dryRun) {
          await t.none('DELETE FROM tbl_company WHERE id = $1', [effectiveCompanyId]);
        }
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const idsFlag = args.includes('--ids');

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Vendor Rollback Script');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  log(`Database: ${process.env.DATABASE_NAME}@${process.env.HOST}`);
  if (dryRun) log('MODE: DRY RUN — no changes will be made');
  console.log('');

  // Test DB connection
  try {
    await db.one('SELECT 1 AS ok');
    log('Database connection OK');
  } catch (err) {
    logError(`Database connection failed: ${err.message}`);
    process.exit(1);
  }

  let vendorTargets = []; // [{ vendor_id, company_id }]

  if (idsFlag) {
    // --ids 412,413,414
    const idsIndex = args.indexOf('--ids');
    const idsStr = args[idsIndex + 1];
    if (!idsStr) {
      logError('--ids flag requires comma-separated vendor IDs, e.g.: --ids 412,413');
      process.exit(1);
    }
    const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

    // Look up company IDs
    for (const id of ids) {
      const user = await db.oneOrNone(
        'SELECT id, company_id, name, email, organization_name FROM tbl_users WHERE id = $1',
        [id]
      );
      if (!user) {
        logError(`Vendor user_id=${id} not found in database`);
        process.exit(1);
      }
      vendorTargets.push({
        vendor_id: user.id,
        company_id: user.company_id,
        email: user.email,
        organization_name: user.organization_name || user.name,
      });
    }
  } else {
    // Load from manifest file
    const manifestFile = args.find(a => !a.startsWith('--'));
    if (!manifestFile) {
      logError('Usage: node scripts/rollback-vendors.mjs <manifest-file>');
      logError('       node scripts/rollback-vendors.mjs --ids 412,413,414');
      logError('Flags: --dry-run, --force');
      process.exit(1);
    }

    const manifestPath = path.resolve(manifestFile);
    if (!fs.existsSync(manifestPath)) {
      logError(`Manifest file not found: ${manifestPath}`);
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!manifest.vendors || manifest.vendors.length === 0) {
      logError('No vendors found in manifest');
      process.exit(1);
    }

    log(`Manifest created at: ${manifest.created_at}`);
    log(`Original database: ${manifest.database}@${manifest.host}`);

    // Safety check: make sure we're targeting the same database
    if (manifest.database && manifest.database !== process.env.DATABASE_NAME) {
      logError(`Manifest was for database "${manifest.database}" but current env is "${process.env.DATABASE_NAME}"`);
      logError('Refusing to rollback on a different database. Override by editing the manifest.');
      process.exit(1);
    }

    vendorTargets = manifest.vendors.map(v => ({
      vendor_id: v.vendor_id,
      company_id: v.company_id,
      email: v.email,
      organization_name: v.organization_name,
    }));
  }

  console.log('');
  log(`Vendors to rollback: ${vendorTargets.length}`);
  console.log('');
  for (const v of vendorTargets) {
    console.log(`  - vendor_id=${v.vendor_id}, company_id=${v.company_id}, org="${v.organization_name}", email=${v.email}`);
  }
  console.log('');

  // Confirmation
  if (!force && !dryRun) {
    const confirmed = await confirm(
      `This will PERMANENTLY DELETE ${vendorTargets.length} vendor(s) and all related data. Continue? (y/N) `
    );
    if (!confirmed) {
      log('Aborted by user');
      process.exit(0);
    }
  }

  // Execute rollback in a single transaction
  try {
    await db.tx(async (t) => {
      for (let i = 0; i < vendorTargets.length; i++) {
        const v = vendorTargets[i];
        log(`Rolling back vendor ${i + 1}/${vendorTargets.length}: ${v.organization_name} (id=${v.vendor_id})`);
        await rollbackVendor(t, v.vendor_id, v.company_id, dryRun);
        console.log('');
      }
    });
  } catch (err) {
    logError(`Transaction failed — no changes were made: ${err.message}`);
    console.error(err);
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  if (dryRun) {
    console.log('  DRY RUN COMPLETE — no changes were made');
  } else {
    console.log('  ROLLBACK COMPLETE');
  }
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  if (!dryRun) {
    log(`Successfully rolled back ${vendorTargets.length} vendor(s)`);
  }

  pgp.end();
}

main().catch((err) => {
  logError(`Unhandled error: ${err.message}`);
  console.error(err);
  pgp.end();
  process.exit(1);
});
