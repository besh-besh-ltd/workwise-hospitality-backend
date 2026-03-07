#!/usr/bin/env node

/**
 * Bulk Vendor Registration Script
 * ================================
 * Registers N unique hospitality vendors with:
 *   - User account (tbl_users, user_type=3)
 *   - Company record (tbl_company, is_hospitality=1)
 *   - Hotel subscriptions (tbl_vendor_hotel_category_subscription)
 *   - Category subscriptions (tbl_vendor_hotel_category_subscription)
 *   - Subcategory subscriptions (tbl_vendor_hotel_category_subscription)
 *   - Product variant vendor mappings (tbl_product_variant_vendor_mapping)
 *   - Auto-approved variant mappings
 *
 * Usage:
 *   node scripts/register-vendors.mjs
 *
 * Configuration:
 *   Edit the VENDORS array below before running.
 *   Each vendor needs: name, email, mobile, organization_name
 *   Then specify which hotels/categories/subcategories to map.
 *
 * Output:
 *   - Prints created vendor IDs and mappings
 *   - Writes a rollback manifest to scripts/rollback-manifest-<timestamp>.json
 */

import pg from 'pg-promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from backend root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ═══════════════════════════════════════════════════════════════
// ██  CONFIGURATION — EDIT THIS SECTION BEFORE RUNNING        ██
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Admin user ID that created these vendors (used for created_by field)
  created_by: 111,

  // Subscription date range
  subscription_start_date: '2025-04-01',
  subscription_end_date: '2026-03-31',

  // Default fee amounts
  hotel_fee: 0,
  category_fee: 500,
  subcategory_fee: 500,

  // Whether to auto-approve variant mappings
  auto_approve_variants: true,

  // Set to true to do a dry run (no DB changes, just validation)
  dry_run: false,
};

/**
 * VENDORS TO REGISTER
 * ===================
 * Each vendor object has:
 *   - name:              Contact person name
 *   - email:             Unique email (will be lowercased)
 *   - mobile:            Unique mobile (max 15 chars, e.g. "+91-9876543210")
 *   - organization_name: Company/organization name (REQUIRED)
 *   - source:            Registration source (default: "script")
 *   - is_private:        0 = public, 1 = private (default: 0)
 *
 *   - hotel_names:       Array of hotel names to subscribe to (matched case-insensitive)
 *   - category_names:    Array of root category titles to subscribe to
 *   - subcategory_names: Array of subcategory titles to subscribe to
 *
 * Example:
 *   {
 *     name: 'Rajesh Kumar',
 *     email: 'rajesh@freshproduce.in',
 *     mobile: '+91-9876543210',
 *     organization_name: 'Fresh Produce India Pvt Ltd',
 *     hotel_names: ['The Orchid Hotel Pune', 'Fort Jadhavgadh'],
 *     category_names: ['FRUIT & VEGETABLE', 'DAIRY PRODUCTS'],
 *     subcategory_names: ['AERATED WATERS'],
 *   }
 */
const VENDORS = [
  {
    name: 'Arjun Mehta',
    email: 'vineet+arjun@letsworkwise.com',
    mobile: '+91-9800100001',
    organization_name: 'CleanSpace Solutions Pvt Ltd',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Priya Sharma',
    email: 'vineet+priya@letsworkwise.com',
    mobile: '+91-9800100002',
    organization_name: 'BrightNest Facility Services',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Karan Desai',
    email: 'vineet+karan@letsworkwise.com',
    mobile: '+91-9800100003',
    organization_name: 'TechClean Industries',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Neha Patel',
    email: 'vineet+neha@letsworkwise.com',
    mobile: '+91-9800100004',
    organization_name: 'PureShine Enterprises',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Rohan Kapoor',
    email: 'vineet+rohan@letsworkwise.com',
    mobile: '+91-9800100005',
    organization_name: 'HospitalityEdge Supplies',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Ananya Reddy',
    email: 'vineet+ananya@letsworkwise.com',
    mobile: '+91-9800100006',
    organization_name: 'NovaTech Hospitality Solutions',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
  {
    name: 'Vikram Joshi',
    email: 'vineet+vikram@letsworkwise.com',
    mobile: '+91-9800100007',
    organization_name: 'SparkLine Maintenance Corp',
    source: 'script',
    is_private: 0,
    hotel_names: ['Burj Al Arab'],
    category_names: ['HOUSEKEEPING SUPPLY', 'IT'],
    subcategory_names: [],
  },
];

// ═══════════════════════════════════════════════════════════════
// ██  END CONFIGURATION — DO NOT EDIT BELOW                   ██
// ═══════════════════════════════════════════════════════════════

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

// ── Helpers ──────────────────────────────────────────────────
function generatePassword(plaintext) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(plaintext, salt);
}

function derivePassword(orgName, mobile) {
  const orgChars = (orgName.match(/[a-zA-Z]/g) || []).join('').toLowerCase();
  const capitalized = orgChars.charAt(0).toUpperCase() + orgChars.substring(1, 4);
  const mobileSuffix = (mobile || '').replace(/[^0-9]/g, '').slice(-4);
  return `${capitalized}@${mobileSuffix}`;
}

function cleanMobile(mobile) {
  if (!mobile) return null;
  let cleaned = mobile.toString().replace(/^\+\d+-\+\d+/, '+91');
  return cleaned.substring(0, 15);
}

function log(msg) {
  console.log(`[register-vendors] ${msg}`);
}

function logError(msg) {
  console.error(`[register-vendors] ERROR: ${msg}`);
}

// ── Lookup Caches ────────────────────────────────────────────
let hotelCache = null;       // name (lower) → { id, name, city, company_name }
let categoryCache = null;    // title (lower) → { id, title }
let subcategoryCache = null; // title (lower) → { id, title, parent_id }

async function loadHotelCache() {
  if (hotelCache) return hotelCache;
  const hotels = await db.any(`
    SELECT h.id, h.name, h.city, hc.name AS company_name
    FROM tbl_hospitality_company_hotels h
    JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
    WHERE h.is_deleted = 0
    ORDER BY h.name
  `);
  hotelCache = new Map();
  for (const h of hotels) {
    hotelCache.set(h.name.toLowerCase().trim(), h);
  }
  log(`Loaded ${hotelCache.size} hotels into cache`);
  return hotelCache;
}

async function loadCategoryCache() {
  if (categoryCache && subcategoryCache) return;

  const cats = await db.any(`
    SELECT id, title, parent_id
    FROM tbl_category
    WHERE is_deleted = 0
    ORDER BY title
  `);

  categoryCache = new Map();
  subcategoryCache = new Map();

  for (const c of cats) {
    if (c.parent_id === 0 || c.parent_id === null) {
      categoryCache.set(c.title.toLowerCase().trim(), c);
    } else {
      subcategoryCache.set(c.title.toLowerCase().trim(), c);
    }
  }
  log(`Loaded ${categoryCache.size} categories and ${subcategoryCache.size} subcategories into cache`);
}

// ── Name Resolution ──────────────────────────────────────────
function resolveHotelIds(hotelNames) {
  const results = [];
  const missing = [];
  for (const name of hotelNames) {
    const key = name.toLowerCase().trim();
    const found = hotelCache.get(key);
    if (found) {
      results.push({ id: found.id, name: found.name, city: found.city });
    } else {
      missing.push(name);
    }
  }
  return { results, missing };
}

function resolveCategoryIds(categoryNames) {
  const results = [];
  const missing = [];
  for (const name of categoryNames) {
    const key = name.toLowerCase().trim();
    const found = categoryCache.get(key);
    if (found) {
      results.push({ id: found.id, title: found.title });
    } else {
      missing.push(name);
    }
  }
  return { results, missing };
}

function resolveSubcategoryIds(subcategoryNames) {
  const results = [];
  const missing = [];
  for (const name of subcategoryNames) {
    const key = name.toLowerCase().trim();
    const found = subcategoryCache.get(key);
    if (found) {
      results.push({ id: found.id, title: found.title, parent_id: found.parent_id });
    } else {
      missing.push(name);
    }
  }
  return { results, missing };
}

// ── Validation ───────────────────────────────────────────────
async function validateVendors(vendors) {
  const errors = [];
  const seenEmails = new Set();
  const seenMobiles = new Set();

  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const prefix = `Vendor[${i}] (${v.organization_name || 'unnamed'})`;

    // Required fields
    if (!v.organization_name || !v.organization_name.trim()) {
      errors.push(`${prefix}: organization_name is required`);
    }
    if (!v.email || !v.email.trim()) {
      errors.push(`${prefix}: email is required`);
    }
    if (!v.mobile || !v.mobile.trim()) {
      errors.push(`${prefix}: mobile is required`);
    }

    // Uniqueness within batch
    const email = (v.email || '').toLowerCase().trim();
    const mobile = cleanMobile(v.mobile);

    if (email && seenEmails.has(email)) {
      errors.push(`${prefix}: duplicate email "${email}" in batch`);
    }
    seenEmails.add(email);

    if (mobile && seenMobiles.has(mobile)) {
      errors.push(`${prefix}: duplicate mobile "${mobile}" in batch`);
    }
    seenMobiles.add(mobile);

    // Check DB uniqueness
    if (email) {
      const existing = await db.any(
        'SELECT id FROM tbl_users WHERE email = $1 AND is_deleted = 0',
        [email]
      );
      if (existing.length > 0) {
        errors.push(`${prefix}: email "${email}" already exists in DB (user_id: ${existing[0].id})`);
      }
    }

    if (mobile) {
      const existing = await db.any(
        `SELECT id FROM tbl_users WHERE regexp_replace(mobile, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g') AND is_deleted = 0`,
        [mobile]
      );
      if (existing.length > 0) {
        errors.push(`${prefix}: mobile "${mobile}" already exists in DB (user_id: ${existing[0].id})`);
      }
    }

    // Validate hotel names
    if (v.hotel_names && v.hotel_names.length > 0) {
      const { missing } = resolveHotelIds(v.hotel_names);
      for (const m of missing) {
        errors.push(`${prefix}: hotel "${m}" not found. Available hotels: ${[...hotelCache.keys()].join(', ')}`);
      }
    }

    // Validate category names
    if (v.category_names && v.category_names.length > 0) {
      const { missing } = resolveCategoryIds(v.category_names);
      for (const m of missing) {
        errors.push(`${prefix}: category "${m}" not found. Available: ${[...categoryCache.keys()].join(', ')}`);
      }
    }

    // Validate subcategory names
    if (v.subcategory_names && v.subcategory_names.length > 0) {
      const { missing } = resolveSubcategoryIds(v.subcategory_names);
      for (const m of missing) {
        errors.push(`${prefix}: subcategory "${m}" not found. Available: ${[...subcategoryCache.keys()].join(', ')}`);
      }
    }
  }

  return errors;
}

// ── Core Registration ────────────────────────────────────────
async function registerVendor(t, vendor, manifest) {
  const email = (vendor.email || '').toLowerCase().trim();
  const mobile = cleanMobile(vendor.mobile);
  const orgName = vendor.organization_name.trim();
  const plainPassword = derivePassword(orgName, mobile);

  // Step 1: Insert company
  const company = await t.one(`
    INSERT INTO tbl_company (company_name, source, is_private, is_hospitality)
    VALUES ($1, $2, $3, 1)
    RETURNING id
  `, [orgName, vendor.source || 'script', vendor.is_private || 0]);

  const companyId = company.id;

  // Step 2: Insert user
  const user = await t.one(`
    INSERT INTO tbl_users (name, email, mobile, organization_name, user_type, password, status, created_by, company_id)
    VALUES ($1, $2, $3, $4, 3, $5, 0, $6, $7)
    RETURNING id
  `, [
    vendor.name || null,
    email || null,
    mobile || null,
    orgName,
    generatePassword(plainPassword),
    CONFIG.created_by,
    companyId,
  ]);

  const vendorId = user.id;
  log(`  Created vendor user_id=${vendorId}, company_id=${companyId}, org="${orgName}"`);

  // Track in manifest for rollback
  const vendorManifest = {
    vendor_id: vendorId,
    company_id: companyId,
    email,
    mobile,
    organization_name: orgName,
    plain_password: plainPassword,
    subscriptions: [],
    variant_mappings: [],
  };

  // Step 3: Build subscription rows
  const subscriptionRows = [];

  // Hotels
  if (vendor.hotel_names && vendor.hotel_names.length > 0) {
    const { results: hotels } = resolveHotelIds(vendor.hotel_names);
    for (const hotel of hotels) {
      subscriptionRows.push({
        vendor_id: vendorId,
        item_type: 'hotel',
        item_id: hotel.id,
        fee_amount: CONFIG.hotel_fee,
        start_date: CONFIG.subscription_start_date,
        end_date: CONFIG.subscription_end_date,
        status: 'active',
        payment_id: null,
      });
    }
  }

  // Categories
  if (vendor.category_names && vendor.category_names.length > 0) {
    const { results: categories } = resolveCategoryIds(vendor.category_names);
    for (const cat of categories) {
      subscriptionRows.push({
        vendor_id: vendorId,
        item_type: 'category',
        item_id: cat.id,
        fee_amount: CONFIG.category_fee,
        start_date: CONFIG.subscription_start_date,
        end_date: CONFIG.subscription_end_date,
        status: 'active',
        payment_id: null,
      });
    }
  }

  // Subcategories
  if (vendor.subcategory_names && vendor.subcategory_names.length > 0) {
    const { results: subcategories } = resolveSubcategoryIds(vendor.subcategory_names);
    for (const subcat of subcategories) {
      subscriptionRows.push({
        vendor_id: vendorId,
        item_type: 'subcategory',
        item_id: subcat.id,
        fee_amount: CONFIG.subcategory_fee,
        start_date: CONFIG.subscription_start_date,
        end_date: CONFIG.subscription_end_date,
        status: 'active',
        payment_id: null,
      });
    }
  }

  // Step 4: Insert subscriptions
  if (subscriptionRows.length > 0) {
    const columnSet = new pgp.helpers.ColumnSet(
      ['vendor_id', 'item_type', 'item_id', 'fee_amount', 'start_date', 'end_date', 'status', 'payment_id'],
      { table: 'tbl_vendor_hotel_category_subscription' }
    );
    const insertQuery = pgp.helpers.insert(subscriptionRows, columnSet) +
      ` ON CONFLICT (vendor_id, item_type, item_id, end_date)
        DO UPDATE SET fee_amount = EXCLUDED.fee_amount
        RETURNING *`;
    const inserted = await t.any(insertQuery);
    vendorManifest.subscriptions = inserted.map(s => ({
      id: s.id,
      item_type: s.item_type,
      item_id: s.item_id,
    }));
    log(`  Inserted ${inserted.length} subscriptions`);
  }

  // Step 5: Auto-map product variants for category/subcategory subscriptions
  const allCategoryIds = subscriptionRows
    .filter(r => r.item_type === 'category' || r.item_type === 'subcategory')
    .map(r => r.item_id);

  if (allCategoryIds.length > 0) {
    // Get all product variants in those categories
    const variants = await t.any(`
      SELECT DISTINCT pv.id AS variant_id
      FROM tbl_product_variant pv
      JOIN tbl_product p ON p.id = pv.product_id
      INNER JOIN tbl_product_categories pc ON p.id = pc.product_id
      WHERE pc.category_id IN ($1:csv)
        AND p.status = 1
        AND pv.status = 1
    `, [allCategoryIds]);

    if (variants.length > 0) {
      const variantIds = variants.map(v => v.variant_id);

      // Filter out variants that already have a mapping for this vendor
      const existingMappings = await t.any(`
        SELECT product_variant_id FROM tbl_product_variant_vendor_mapping
        WHERE vendor_id = $1 AND product_variant_id IN ($2:csv)
      `, [vendorId, variantIds]);
      const existingSet = new Set(existingMappings.map(m => m.product_variant_id));

      const newVariantIds = variantIds.filter(id => !existingSet.has(id));

      if (newVariantIds.length > 0) {
        const variantRows = newVariantIds.map(vid => ({
          product_variant_id: vid,
          vendor_id: vendorId,
          status: true,
          is_approved: CONFIG.auto_approve_variants,
          created_by: CONFIG.created_by,
          created_at: new Date(),
          updated_at: new Date(),
        }));

        const variantCS = new pgp.helpers.ColumnSet(
          ['product_variant_id', 'vendor_id', 'status', 'is_approved', 'created_by', 'created_at', 'updated_at'],
          { table: 'tbl_product_variant_vendor_mapping' }
        );

        const variantInsertQuery = pgp.helpers.insert(variantRows, variantCS) + ' RETURNING id, product_variant_id';
        const mappedVariants = await t.any(variantInsertQuery);
        vendorManifest.variant_mappings = mappedVariants.map(m => ({
          id: m.id,
          product_variant_id: m.product_variant_id,
        }));
        log(`  Mapped ${mappedVariants.length} product variants (${existingSet.size} already existed)`);
      } else {
        log(`  All ${variantIds.length} product variants already mapped for this vendor`);
      }
    } else {
      log(`  No product variants found for categories [${allCategoryIds.join(', ')}]`);
    }
  }

  manifest.vendors.push(vendorManifest);
  return vendorManifest;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Bulk Vendor Registration Script');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  if (VENDORS.length === 0) {
    logError('No vendors configured. Edit the VENDORS array in the script.');
    process.exit(1);
  }

  log(`Database: ${process.env.DATABASE_NAME}@${process.env.HOST}`);
  log(`Vendors to register: ${VENDORS.length}`);
  log(`Dry run: ${CONFIG.dry_run}`);
  console.log('');

  // Test DB connection
  try {
    await db.one('SELECT 1 AS ok');
    log('Database connection OK');
  } catch (err) {
    logError(`Database connection failed: ${err.message}`);
    process.exit(1);
  }

  // Load lookup caches
  await loadHotelCache();
  await loadCategoryCache();

  // Print available items for reference
  console.log('');
  log('Available Hotels:');
  for (const [name, h] of hotelCache) {
    console.log(`    - "${h.name}" (id=${h.id}, city=${h.city}, company=${h.company_name})`);
  }
  console.log('');
  log('Available Categories (root):');
  for (const [name, c] of categoryCache) {
    console.log(`    - "${c.title}" (id=${c.id})`);
  }
  console.log('');
  log('Available Subcategories:');
  for (const [name, sc] of subcategoryCache) {
    console.log(`    - "${sc.title}" (id=${sc.id}, parent_id=${sc.parent_id})`);
  }
  console.log('');

  // Validate
  log('Validating vendors...');
  const errors = await validateVendors(VENDORS);
  if (errors.length > 0) {
    logError('Validation failed:');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }
  log('Validation passed!');
  console.log('');

  if (CONFIG.dry_run) {
    log('DRY RUN — no changes will be made. Set CONFIG.dry_run = false to execute.');
    process.exit(0);
  }

  // Register vendors in a single transaction
  const manifest = {
    created_at: new Date().toISOString(),
    database: process.env.DATABASE_NAME,
    host: process.env.HOST,
    config: { ...CONFIG },
    vendors: [],
  };

  try {
    await db.tx(async (t) => {
      for (let i = 0; i < VENDORS.length; i++) {
        log(`Registering vendor ${i + 1}/${VENDORS.length}: ${VENDORS[i].organization_name}`);
        await registerVendor(t, VENDORS[i], manifest);
        console.log('');
      }
    });
  } catch (err) {
    logError(`Transaction failed — all changes rolled back: ${err.message}`);
    console.error(err);
    process.exit(1);
  }

  // Write rollback manifest
  const timestamp = Date.now();
  const manifestPath = path.resolve(__dirname, `rollback-manifest-${timestamp}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  REGISTRATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  log(`Successfully registered ${manifest.vendors.length} vendors`);
  console.log('');

  // Summary table
  for (const v of manifest.vendors) {
    console.log(`  Vendor: ${v.organization_name}`);
    console.log(`    user_id:     ${v.vendor_id}`);
    console.log(`    company_id:  ${v.company_id}`);
    console.log(`    email:       ${v.email}`);
    console.log(`    password:    ${v.plain_password}`);
    console.log(`    subscriptions: ${v.subscriptions.length}`);
    console.log(`    variant_mappings: ${v.variant_mappings.length}`);
    console.log('');
  }

  log(`Rollback manifest saved to: ${manifestPath}`);
  log(`To rollback: node scripts/rollback-vendors.mjs ${manifestPath}`);
  console.log('');

  pgp.end();
}

main().catch((err) => {
  logError(`Unhandled error: ${err.message}`);
  console.error(err);
  pgp.end();
  process.exit(1);
});
