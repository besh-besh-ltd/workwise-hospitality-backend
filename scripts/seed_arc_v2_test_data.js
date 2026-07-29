/**
 * ARC v2 — Test data seeder for hospitality_stage.
 *
 * Creates 3 ARCs that mirror exactly what the real Create-Contract flow
 * writes when a user walks through publish → vendor quotes → tech eval →
 * commercial eval → committee approval → contract generation → vendor
 * signature. Every table the live flow touches is populated here so the
 * detail/active/comm-eval/committee pages and the MR call-off flow render
 * against realistic data.
 *
 * ARCs created:
 *   1. ACTIVE  — fully signed, 3 items, split-award on item 2
 *      Contract window 2026-06-01 → 2027-03-31, some consumed_qty so the
 *      active-dashboard "% used" tiles have signal. Three vendor
 *      contracts (one per awarded vendor), each marked `active` and
 *      `signed_by_vendor_at` set. Ready for MR / call-off testing.
 *
 *   2. FLOATED — just published, vendors invited, no quotes yet.
 *      Sits in the Ongoing tab for list-page filter testing.
 *
 *   3. COMMITTEE_REVIEW — comm-eval finalised, committee tab populated
 *      with a draft split-award proposal. Lets you exercise the
 *      committee / comm-eval inner pages without running the full flow.
 *
 * Reference data is sourced live from hospitality_stage — first matching
 * company / hotel / department / process / category that has ≥3 product
 * variants and ≥3 vendors subscribed to the (hotel × category) pair.
 *
 * Re-runnable: arc_number suffixes a timestamp so re-running creates new
 * ARCs (existing rows are not touched). To delete a seeded ARC:
 *     DELETE FROM tbl_arc WHERE id = <id>;
 * The FK chain cascades through items, invitations, snapshots, tech
 * eval, quotes, comm-eval awards, contracts and contract lines.
 *
 * Usage (run from /backend):
 *     node scripts/seed_arc_v2_test_data.js
 *
 * The buyer / company / hotel / department / process are derived from the
 * employee_code below — change BUYER_EMPLOYEE_CODE or pass via env to seed
 * for a different account:
 *     BUYER_EMPLOYEE_CODE=KUS404 node scripts/seed_arc_v2_test_data.js
 *
 * Required env (loaded via dotenv): DATABASE_USERNAME, DATABASE_PASSWORD,
 * DATABASE_NAME, HOST, DATABASE_PORT. Point these at hospitality_stage.
 */

// Buyer's employee_code — every ARC seeded by this run shows up under this
// user's accessible scope (company × hotel × department × process pulled
// from their tbl_user_role_scopes rows).
const BUYER_EMPLOYEE_CODE = process.env.BUYER_EMPLOYEE_CODE || 'KUS404';

import dotenv from 'dotenv';
import pg from 'pg-promise';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────
//  DB connection
// ─────────────────────────────────────────────────────────────────────────
const pgp = pg({});
const db = pgp({
  user:     process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host:     process.env.HOST,
  port:     process.env.DATABASE_PORT,
  ssl:      process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});
// Return raw timestamp strings (no JS Date conversion) for type 1114.
pgp.pg.types.setTypeParser(1114, (s) => s);

// ─────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────
const ts = Date.now().toString().slice(-7);   // suffix used in arc_numbers
const log  = (...a) => console.log(' ', ...a);
const head = (s)    => console.log('\n━━━', s, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const ok   = (s)    => console.log('  ✓', s);

const date = (s) => s; // pass-through; pg accepts YYYY-MM-DD strings for DATE/TIMESTAMP

function avgPrice(targets, deltaPct) {
  return targets.map((t) => Math.round(Number(t) * (1 + deltaPct / 100) * 100) / 100);
}

// ─────────────────────────────────────────────────────────────────────────
//  Reference-data lookup
// ─────────────────────────────────────────────────────────────────────────
async function lookupContext() {
  head(`Resolving reference data for buyer employee_code='${BUYER_EMPLOYEE_CODE}'`);

  // Buyer — the seeded ARCs go under this user's scope. The real ARC create
  // flow writes tbl_arc.created_by from req.user; we mirror that here.
  const buyer = await db.oneOrNone(
    `SELECT id, name, email, employee_code
       FROM public.tbl_users
      WHERE employee_code = $1
      LIMIT 1`,
    [BUYER_EMPLOYEE_CODE]
  );
  if (!buyer) throw new Error(`User with employee_code='${BUYER_EMPLOYEE_CODE}' not found.`);
  log('buyer    =', buyer);

  // Pull every role scope the buyer holds. The wizard derives company/hotel/
  // department/process from this same table (see resolveHospitalityCompanyId
  // and getDepartmentsForCategoryAndUser); using it here guarantees the
  // seeded ARCs sit inside the same scope the buyer actually sees on login.
  const scopes = await db.any(
    `SELECT urs.company_id, urs.hotel_id, urs.department_id, urs.process_id
       FROM public.tbl_user_role_scopes urs
      WHERE urs.user_id = $1`,
    [buyer.id]
  );
  if (scopes.length === 0) {
    throw new Error(`Buyer ${buyer.id} (${BUYER_EMPLOYEE_CODE}) has no tbl_user_role_scopes rows.`);
  }
  log(`scopes   = ${scopes.length} row(s)`);

  const companyId = scopes.map((s) => s.company_id).find((v) => v != null);
  if (!companyId) throw new Error('No company_id found in any of the buyer\'s role scopes.');
  const company = await db.one(
    `SELECT id, name FROM public.tbl_hospitality_companies WHERE id = $1`,
    [companyId]
  );
  log('company  =', company);

  // Hotel: prefer a hotel the buyer is explicitly scoped to; fall back to the
  // first hotel under the company (mirrors the wizard's "default to first
  // accessible hotel" behaviour).
  const scopedHotelId = scopes.map((s) => s.hotel_id).find((v) => v != null);
  const hotel = scopedHotelId
    ? await db.one(
        `SELECT id, name, city FROM public.tbl_hospitality_company_hotels WHERE id = $1`,
        [scopedHotelId]
      )
    : await db.one(
        `SELECT id, name, city
           FROM public.tbl_hospitality_company_hotels
          WHERE hospitality_company_id = $1
          ORDER BY id LIMIT 1`,
        [company.id]
      );
  log('hotel    =', hotel, scopedHotelId ? '(scoped)' : '(first under company)');

  // Process: tbl_arc.process_id is NOT NULL, so the script needs a valid
  // FK target — but the process-picker feature isn't live yet, so any
  // process belonging to the company will do. Prefer one the buyer is
  // explicitly scoped to; otherwise the first one under the company.
  const scopedProcessId = scopes.map((s) => s.process_id).find((v) => v != null);
  const approvalProcess = scopedProcessId
    ? await db.one(
        `SELECT id, name, process_type FROM public.tbl_approval_processes WHERE id = $1`,
        [scopedProcessId]
      )
    : await db.one(
        `SELECT id, name, process_type
           FROM public.tbl_approval_processes
          WHERE company_id = $1
          ORDER BY id LIMIT 1`,
        [company.id]
      );
  log('process  =', approvalProcess, scopedProcessId ? '(scoped)' : '(first under company)');

  // Scoped department set — NULL urs.department_id = "all departments"
  // (mirrors the wizard's behaviour).
  const scopedDeptIds = scopes.map((s) => s.department_id).filter((v) => v != null);
  const hasAllDeptAccess = scopes.some((s) => s.department_id == null);

  // ── Diagnostic: rank candidate categories by what's actually available.
  // Surfaces the top 6 candidates by (eligibleVendors, variantCount) so the
  // user can see why a category was picked (or why none qualifies).
  const candidates = await db.any(
    `SELECT c.id,
            c.title,
            (SELECT COUNT(*) FROM public.tbl_product_categories pc
              JOIN public.tbl_product_variant pv ON pv.product_id = pc.product_id
             WHERE pc.category_id = c.id) AS variant_count,
            (SELECT COUNT(DISTINCT u.id)
               FROM public.tbl_users u
               JOIN public.tbl_vendor_hotel_category_subscription vhcs
                 ON vhcs.vendor_id = u.id
              WHERE u.user_type = 3 AND u.status = 1
                AND vhcs.status IN ('active','expired')
                AND ((vhcs.item_type = 'hotel'    AND vhcs.item_id = $1)
                  OR (vhcs.item_type = 'category' AND vhcs.item_id = c.id))) AS vendor_count
       FROM public.tbl_category c
      WHERE (c.parent_id IS NULL OR c.parent_id = 0)
        AND COALESCE(c.is_deleted, 0) = 0
      ORDER BY vendor_count DESC, variant_count DESC
      LIMIT 8`,
    [hotel.id]
  );
  log('candidate categories (top 8 by vendor_count, variant_count):');
  for (const c of candidates) {
    log(`  #${c.id} "${c.title}" — variants=${c.variant_count} eligibleVendors=${c.vendor_count}`);
  }

  // Honour a CATEGORY_ID override if the user wants to seed a specific
  // category that the auto-picker wouldn't choose.
  const overrideCatId = Number(process.env.CATEGORY_ID) || null;

  // Tiered selection. The seed needs at least 2 variants and at least 1
  // eligible vendor to produce meaningful contract lines. Prefer (≥3 / ≥3)
  // for the full split-award scenario; relax progressively when stage data
  // is sparse so the script never bails when usable data exists.
  let category = null;
  let pickedVariantCount = 0;
  let pickedVendorCount  = 0;

  if (overrideCatId) {
    category = candidates.find((c) => Number(c.id) === overrideCatId) ||
               await db.oneOrNone(`SELECT id, title FROM public.tbl_category WHERE id = $1`, [overrideCatId]);
    if (!category) throw new Error(`CATEGORY_ID=${overrideCatId} not found in tbl_category.`);
    pickedVariantCount = Number(category.variant_count || 0);
    pickedVendorCount  = Number(category.vendor_count  || 0);
    log(`category = #${category.id} "${category.title}" (overridden via CATEGORY_ID)`);
  } else {
    for (const tier of [{ v: 3, n: 3 }, { v: 3, n: 2 }, { v: 2, n: 2 }, { v: 2, n: 1 }]) {
      const hit = candidates.find((c) =>
        Number(c.variant_count) >= tier.v && Number(c.vendor_count) >= tier.n
      );
      if (hit) {
        category = hit;
        pickedVariantCount = Number(hit.variant_count);
        pickedVendorCount  = Number(hit.vendor_count);
        log(`category = #${hit.id} "${hit.title}" (tier variants≥${tier.v}, vendors≥${tier.n})`);
        break;
      }
    }
  }
  if (!category) {
    throw new Error(
      `No category found with at least 2 variants and 1 eligible vendor for hotel ${hotel.id}. ` +
      `Top candidates above show what is available. Override with CATEGORY_ID=<id> if needed.`
    );
  }

  // Department resolution — preferred path mirrors the wizard
  // (tbl_category_department ∩ buyer scope); when the mapping table is
  // empty for this category, fall back to the buyer's first scoped
  // department (still a valid FK target for tbl_arc.department_id).
  let department = await db.oneOrNone(
    `SELECT d.id, d.title
       FROM public.tbl_category_department cd
       JOIN public.tbl_department d ON d.id = cd.department_id
      WHERE cd.category_id = $1
        AND ($2::boolean OR cd.department_id = ANY($3::int[]))
      ORDER BY d.id LIMIT 1`,
    [category.id, hasAllDeptAccess, scopedDeptIds.length ? scopedDeptIds : [0]]
  );
  if (!department) {
    // No category↔department row in the mapping table (or migration 3 not
    // applied). Use the buyer's first scoped department instead.
    if (scopedDeptIds.length > 0) {
      department = await db.one(
        `SELECT id, title FROM public.tbl_department WHERE id = $1`,
        [scopedDeptIds[0]]
      );
      log(`dept     = ${JSON.stringify(department)} (fallback: buyer's first scoped dept; tbl_category_department had no row for this category)`);
    } else {
      // Last resort: buyer has 'all departments' access. Pick any dept.
      department = await db.one(
        `SELECT id, title FROM public.tbl_department ORDER BY id LIMIT 1`
      );
      log(`dept     = ${JSON.stringify(department)} (fallback: first dept; buyer has all-dept access)`);
    }
  } else {
    log('dept     =', department);
  }

  log(`(picked category has variants=${pickedVariantCount}, eligibleVendors=${pickedVendorCount})`);

  const variants = await db.any(
    `SELECT pv.id, pv.name, pv.slug, p.name AS product_name, pv.product_id
       FROM public.tbl_product_variant pv
       JOIN public.tbl_product p ON p.id = pv.product_id
       JOIN public.tbl_product_categories pc ON pc.product_id = p.id
      WHERE pc.category_id = $1
      ORDER BY pv.id LIMIT 3`,
    [category.id]
  );
  log('variants =', variants.map((v) => `${v.id} :: ${v.name}`).join(' | ') || '(none)');

  // Same rule as arcModel.getEligibleVendorsForCategory — the wizard's
  // vendor picker only shows vendors that meet this exact predicate.
  const vendors = await db.any(
    `SELECT DISTINCT u.id, u.name, u.email
       FROM public.tbl_users u
       JOIN public.tbl_vendor_hotel_category_subscription vhcs
         ON vhcs.vendor_id = u.id
      WHERE u.user_type = 3 AND u.status = 1
        AND vhcs.status IN ('active','expired')
        AND ((vhcs.item_type = 'hotel'    AND vhcs.item_id = $1)
          OR (vhcs.item_type = 'category' AND vhcs.item_id = $2))
      ORDER BY u.name LIMIT 3`,
    [hotel.id, category.id]
  );
  log('vendors  =', vendors.map((v) => `${v.id} :: ${v.name}`).join(' | ') || '(none)');

  if (variants.length < 2) {
    throw new Error(
      `Category "${category.title}" has only ${variants.length} variant(s); need ≥2 to seed a multi-item ARC.`
    );
  }
  if (vendors.length < 2) {
    throw new Error(
      `Category "${category.title}" × hotel ${hotel.id} has only ${vendors.length} eligible vendor(s); need ≥2 for the split-award scenario. ` +
      `Subscribe more vendors or pick a different category via CATEGORY_ID=<id>.`
    );
  }

  return { company, hotel, category, department, approvalProcess, buyer, variants, vendors };
}

// ─────────────────────────────────────────────────────────────────────────
//  ARC 1 — fully ACTIVE with split award on item 2
// ─────────────────────────────────────────────────────────────────────────
async function seedArc1Active(ctx) {
  const { company, hotel, category, department, approvalProcess, buyer, variants, vendors } = ctx;
  const usedVendors  = vendors.slice(0, 3);
  const usedVariants = variants.slice(0, 3);
  const vA = usedVendors[0];
  const vB = usedVendors[1];                          // always present (≥2 enforced)
  const vC = usedVendors[2] || null;                  // optional 3rd vendor

  head(`Seeding ARC 1 · CONTRACT_ACTIVE (${usedVariants.length} items, ${usedVendors.length} vendors, split award on item 2)`);

  // Indicative quantities + target prices (per variant). Real-world-ish:
  // item 1 is the highest-volume staple, item N is the lowest.
  const itemSpecs = [
    { qty: 1000, target: 60.00, uom: 'kg', spec: 'Premium grade · vacuum sealed · 50kg sacks' },
    { qty: 800,  target: 52.00, uom: 'kg', spec: 'Food-grade ISO 22000 · 50kg sacks · ≤2% moisture' },
    { qty: 500,  target: 40.00, uom: 'kg', spec: 'Whole grain · IS 1155 compliant · 25kg sacks' },
  ];
  const items = usedVariants.map((v, i) => ({ variant: v, ...itemSpecs[i] }));

  // Quoted rates per vendor per item — taken slightly above target, varied
  // per vendor. Padded out to 3 elements so the per-item indexing is safe
  // even when only 2 items are in scope.
  const targets = [
    itemSpecs[0].target, itemSpecs[1].target, itemSpecs[2].target,
  ];
  const quotes = {
    [vA.id]: avgPrice(targets, +3.5),                              // A: cheapest
    [vB.id]: avgPrice(targets, +5.5),                              // B: middle
    ...(vC ? { [vC.id]: avgPrice(targets, +5.0) } : {}),           // C optional
  };

  return db.tx(async (t) => {
    const arcNumber = `ARC-STG-${ts}-A`;

    // 1) Insert tbl_arc — status jumps straight to contract_active because
    //    we're seeding the end-state of the full flow.
    const arc = await t.one(
      `INSERT INTO public.tbl_arc (
          arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected,
          delivery_expected, penalty_clause, created_by
       ) VALUES (
          $1, $2, $3, $4, '[]'::jsonb,
          $5, $6, $7, $8,
          'contract_active',
          $9, $10, $11, $12,
          TRUE, FALSE, 'invitation',
          $13::jsonb, $14,
          $15, $16, $17
       ) RETURNING *`,
      [
        arcNumber,
        `${category.title} · ${hotel.name} · FY 2026-27`,
        'Annual rate contract — F&B procurement. Split-award test fixture seeded by scripts/seed_arc_v2_test_data.js.',
        category.id,
        company.id, hotel.id, department.id, approvalProcess.id,
        date('2026-04-15 09:00:00'), date('2026-05-10 18:00:00'),
        date('2026-06-01 00:00:00'), date('2027-03-31 23:59:59'),
        JSON.stringify({ type: 'annual_pct', cap_pct: 5 }),
        'Net 30',
        'Within 21 days of each call-off PO',
        '1.5% LD per week of delay, capped at 7.5% of PO value',
        buyer.id,
      ]
    );
    ok(`tbl_arc id=${arc.id} number=${arc.arc_number}`);

    // 2) tbl_arc_item × 3
    const arcItems = [];
    for (const it of items) {
      const row = await t.one(
        `INSERT INTO public.tbl_arc_item
           (arc_id, product_variant_id, spec_text, target_price, indicative_qty, uom)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [arc.id, it.variant.id, it.spec, it.target, it.qty, it.uom]
      );
      arcItems.push({ ...row, _meta: it });
    }
    ok(`tbl_arc_item × ${arcItems.length}`);

    // 3) tbl_arc_item_history_snapshot — past-3y consumption per item
    for (const ai of arcItems) {
      const base = Number(ai.indicative_qty);
      const snaps = [
        { year_offset: 1, consumed_qty: Math.round(base * 0.92), last_rate: ai._meta.target - 2, last_vendor_id: vA.id },
        { year_offset: 2, consumed_qty: Math.round(base * 0.88), last_rate: ai._meta.target - 4, last_vendor_id: vB.id },
        { year_offset: 3, consumed_qty: Math.round(base * 0.84), last_rate: ai._meta.target - 6, last_vendor_id: (vC || vA).id },
      ];
      for (const s of snaps) {
        await t.none(
          `INSERT INTO public.tbl_arc_item_history_snapshot
             (arc_item_id, year_offset, consumed_qty, last_rate, last_vendor_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [ai.id, s.year_offset, s.consumed_qty, s.last_rate, s.last_vendor_id]
        );
      }
    }
    ok(`tbl_arc_item_history_snapshot × ${arcItems.length * 3}`);

    // 4) tbl_arc_invitation × 3 (all submitted)
    for (const v of usedVendors) {
      await t.none(
        `INSERT INTO public.tbl_arc_invitation (arc_id, vendor_id, status, invited_at, responded_at)
         VALUES ($1, $2, 'submitted', $3, $4)`,
        [arc.id, v.id, '2026-04-15 09:30:00', '2026-05-08 14:00:00']
      );
    }
    ok(`tbl_arc_invitation × ${vendors.length} (all submitted)`);

    // 5) tbl_arc_tech_evaluation_rounds (round 1, closed)
    await t.none(
      `INSERT INTO public.tbl_arc_tech_evaluation_rounds
         (arc_id, round_number, status, opened_at, closed_at, opened_by)
       VALUES ($1, 1, 'closed', $2, $3, $4)`,
      [arc.id, '2026-05-11 10:00:00', '2026-05-18 18:00:00', buyer.id]
    );
    ok(`tbl_arc_tech_evaluation_rounds × 1`);

    // 6) Per-item tech eval — for each item, 2 clauses (50% weight each), all
    //    vendors respond, scored, and added to cleared_vendors as qualified.
    for (const ai of arcItems) {
      const te = await t.one(
        `INSERT INTO public.tbl_arc_item_tech_evaluation
           (arc_item_id, minimum_passing_score, is_complete, current_round)
         VALUES ($1, 65, TRUE, 1)
         RETURNING *`,
        [ai.id]
      );
      const clauseTexts = [
        { text: 'BIS / IEC certification provided',                 type: 'doc',  weight: 50 },
        { text: 'Sample lot meets the specification on appearance', type: 'spec', weight: 50 },
      ];
      for (const c of clauseTexts) {
        const clause = await t.one(
          `INSERT INTO public.tbl_arc_item_tech_evaluation_clauses
             (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [te.id, c.text, c.weight, c.type]
        );
        // Each vendor gets a response + a buyer score (~ 40-48 of 50 → ~80-96%)
        for (const v of usedVendors) {
          await t.none(
            `INSERT INTO public.tbl_arc_item_tech_evaluation_vendors_response
               (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response,
                buyer_id, buyer_marks, buyer_remark, score_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              clause.id, v.id,
              'Compliant — documents attached.',
              buyer.id,
              v.id === vA.id ? 47 : v.id === vB.id ? 44 : 42, // A>B>C
              'Verified against attached evidence.',
              '2026-05-17 15:30:00',
            ]
          );
        }
      }
      // Cleared vendors — all three qualify on every item (split award means
      // all qualified; awarding ranks decide allocation downstream).
      for (const v of usedVendors) {
        const score = v.id === vA.id ? 94 : v.id === vB.id ? 88 : 84;
        await t.none(
          `INSERT INTO public.tbl_arc_item_tech_evaluation_cleared_vendors
             (arc_item_tech_evaluation_id, vendor_id, calculated_score, is_verified,
              status, evaluation_round, created_by)
           VALUES ($1, $2, $3, TRUE, 'qualified', 1, $4)`,
          [te.id, v.id, score, buyer.id]
        );
      }
    }
    ok(`tbl_arc_item_tech_evaluation × ${arcItems.length} (+ clauses + responses + cleared_vendors)`);

    // 7) tbl_arc_quote + tbl_arc_quote_line — every vendor quoted every item.
    const quoteByVendor = {};
    for (const v of usedVendors) {
      const q = await t.one(
        `INSERT INTO public.tbl_arc_quote
           (arc_id, vendor_id, submitted_at, payment_terms, gstin_used)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [arc.id, v.id, '2026-05-08 14:00:00', 'Net 30', '27AAAAA0000A1Z5']
      );
      quoteByVendor[v.id] = q;
      for (let i = 0; i < arcItems.length; i++) {
        const rate = quotes[v.id][i];
        await t.none(
          `INSERT INTO public.tbl_arc_quote_line
             (arc_quote_id, arc_item_id, rate, gst_pct, charges,
              lead_time_days, moq, validity_notes)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [
            q.id, arcItems[i].id, rate, 5.00,
            JSON.stringify([{ label: 'Freight', type: 'pct', value: 1.5 }]),
            14, 50, 'Valid through contract term',
          ]
        );
      }
    }
    ok(`tbl_arc_quote × ${vendors.length}, tbl_arc_quote_line × ${vendors.length * arcItems.length}`);

    // 8) Commercial evaluation — finalized
    const commEval = await t.one(
      `INSERT INTO public.tbl_arc_comm_evaluation
         (arc_id, status, finalized_by, finalized_at)
       VALUES ($1, 'finalized', $2, $3)
       RETURNING *`,
      [arc.id, buyer.id, '2026-05-25 16:00:00']
    );
    ok(`tbl_arc_comm_evaluation id=${commEval.id} (finalized)`);

    // 9) Awards — the split scenario the user asked for.
    //    Item 1: 100% Vendor A (L1).
    //    Item 2: 60% Vendor A (L1), 40% Vendor B (L2).
    //    Item 3: 100% Vendor C (L1 on this item because A/B priced higher here).
    // Award plan adapts to however many items/vendors are in scope:
    //   Item 1 → 100% vendor A
    //   Item 2 → split 60/40 between A and B (the requested split scenario)
    //   Item 3 → 100% vendor C if available, else vendor B
    const awardPlan = [];
    if (arcItems[0]) {
      awardPlan.push({ item: arcItems[0], allocs: [
        { vendor: vA, qty: items[0].qty, share: 100, rank: 'L1', l1default: true },
      ]});
    }
    if (arcItems[1]) {
      const sixty = Math.round(items[1].qty * 0.60);
      awardPlan.push({ item: arcItems[1], allocs: [
        { vendor: vA, qty: sixty,                 share: 60, rank: 'L1', l1default: true  },
        { vendor: vB, qty: items[1].qty - sixty,  share: 40, rank: 'L2', l1default: false },
      ]});
    }
    if (arcItems[2]) {
      const winner = vC || vB;
      awardPlan.push({ item: arcItems[2], allocs: [
        { vendor: winner, qty: items[2].qty, share: 100, rank: 'L1', l1default: true },
      ]});
    }

    for (const plan of awardPlan) {
      for (const a of plan.allocs) {
        const ql = await t.one(
          `SELECT id, rate FROM public.tbl_arc_quote_line
            WHERE arc_quote_id = $1 AND arc_item_id = $2`,
          [quoteByVendor[a.vendor.id].id, plan.item.id]
        );
        await t.none(
          `INSERT INTO public.tbl_arc_comm_evaluation_award
             (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
              awarded_quote_line_id, allocated_qty, allocated_share_pct,
              l_rank, is_l1_default, awarded_quote_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            commEval.id, plan.item.id, a.vendor.id,
            ql.id, a.qty, a.share,
            a.rank, a.l1default,
            JSON.stringify({
              rate: Number(ql.rate),
              gst_pct: 5,
              charges: [{ label: 'Freight', type: 'pct', value: 1.5 }],
              lead_time_days: 14,
            }),
          ]
        );
      }
    }
    ok(`tbl_arc_comm_evaluation_award rows seeded (split on item 2)`);

    // Comm-eval history — show some allocation edits in the audit trail.
    await t.none(
      `INSERT INTO public.tbl_arc_comm_evaluation_history
         (arc_comm_evaluation_id, action, payload, changed_by, changed_at)
       VALUES
         ($1, 'auto_l1_seed',     $2::jsonb, $3, $4),
         ($1, 'reallocate',       $5::jsonb, $3, $6),
         ($1, 'finalize',         '{}'::jsonb, $3, $7)`,
      [
        commEval.id,
        JSON.stringify({ note: 'L1 vendor seeded at 100% per item.' }),
        buyer.id,
        '2026-05-22 11:00:00',
        JSON.stringify({ arc_item_id: arcItems[1].id, from: { [vA.id]: 100 }, to: { [vA.id]: 60, [vB.id]: 40 } }),
        '2026-05-23 14:30:00',
        '2026-05-25 16:00:00',
      ]
    );
    ok(`tbl_arc_comm_evaluation_history × 3`);

    // 10) Contracts — one per awarded vendor.
    //     Vendor A gets items 1 + 2-partial; Vendor B gets item 2-partial;
    //     Vendor C gets item 3. Status = active, signed_by_vendor_at set,
    //     consumed_qty seeded so the dashboard shows realistic % used.
    const vendorAwards = {};
    for (const plan of awardPlan) {
      for (const a of plan.allocs) {
        if (!vendorAwards[a.vendor.id]) vendorAwards[a.vendor.id] = [];
        vendorAwards[a.vendor.id].push({ item: plan.item, qty: a.qty });
      }
    }

    // Realistic call-off consumption — vendor A items more consumed because
    // they're the high-volume staples being called off most often.
    const consumedPct = { [vA.id]: 0.12, [vB.id]: 0.05 };
    if (vC) consumedPct[vC.id] = 0.20;

    const createdContracts = [];
    for (const v of usedVendors) {
      const lines = vendorAwards[v.id];
      if (!lines || lines.length === 0) continue;

      const contract = await t.one(
        `INSERT INTO public.tbl_arc_contract
           (arc_id, vendor_id, document_s3_url, document_hash,
            status, awaiting_until, signed_by_vendor_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6)
         RETURNING *`,
        [
          arc.id, v.id,
          `s3://workwise-stage/arc-contracts/${arcNumber}-${v.id}.pdf`,
          // Deterministic-ish fake hash so the field is non-null and unique
          ('a'.repeat(48) + arcNumber + v.id).slice(0, 64),
          '2026-05-31 23:59:59',
          '2026-05-30 11:25:00',
        ]
      );

      for (const ln of lines) {
        const ql = await t.one(
          `SELECT rate FROM public.tbl_arc_quote_line
            WHERE arc_quote_id = $1 AND arc_item_id = $2`,
          [quoteByVendor[v.id].id, ln.item.id]
        );
        const consumed = Math.round(ln.qty * consumedPct[v.id]);
        const cl = await t.one(
          `INSERT INTO public.tbl_arc_contract_line
             (arc_contract_id, arc_item_id, unit_rate, gst_pct, charges,
              payment_terms, delivery_terms, committed_qty, consumed_qty,
              awarded_quote_snapshot)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
           RETURNING id`,
          [
            contract.id, ln.item.id, Number(ql.rate), 5.00,
            JSON.stringify([{ label: 'Freight', type: 'pct', value: 1.5 }]),
            'Net 30', 'Within 21 days of each call-off PO',
            ln.qty, consumed,
            JSON.stringify({
              rate: Number(ql.rate),
              gst_pct: 5,
              awarded_at: '2026-05-25 16:00:00',
              awarded_share_pct: ln.qty === Number(ln.item.indicative_qty) ? 100 : null,
            }),
          ]
        );

        // Back every consumed unit with a real call-off (MR → PO → callof_po).
        // Split into 1–2 calls so the audit trail feels organic. Sum of
        // call-off quantities equals the contract line's consumed_qty.
        if (consumed > 0) {
          const splits = consumed > 100 ? [
            Math.round(consumed * 0.6),
            consumed - Math.round(consumed * 0.6),
          ] : [consumed];
          let callIdx = 0;
          for (const callQty of splits) {
            if (callQty <= 0) continue;
            callIdx++;
            const callDate = `2026-06-${String(callIdx + 1).padStart(2, '0')} 10:30:00`;
            const mrNumber = `MR-STG-${ts}-${v.id}-${ln.item.id}-${callIdx}`;
            const poNumber = `PO-STG-${ts}-${v.id}-${ln.item.id}-${callIdx}`;
            const unitRate = Number(ql.rate);
            const totalValue = +(unitRate * callQty * 1.05).toFixed(2); // incl. 5% GST

            // 1) Material requisition — already at po_released status because
            //    this fixture represents the end-state of an approved MR.
            const mr = await t.one(
              `INSERT INTO public.tbl_material_requisition
                 (mr_number, title, hospitality_company_id, hotel_id,
                  department_id, urgency, required_by_date, justification,
                  delivery_location, status, raised_by, submitted_at)
               VALUES ($1, $2, $3, $4, $5, 'normal', $6, $7, $8,
                       'po_released', $9, $10)
               RETURNING id`,
              [
                mrNumber,
                `Auto MR · ${arc.arc_number} · call ${callIdx}`,
                company.id, hotel.id, department.id,
                '2026-06-15',
                'Routine consumption against active rate contract.',
                hotel.name || 'Main store',
                buyer.id, callDate,
              ]
            );

            // 2) MR item — required by the MR-to-call-off contract.
            await t.none(
              `INSERT INTO public.tbl_material_requisition_item
                 (mr_id, product_variant_id, quantity, uom,
                  arc_contract_id, arc_contract_line_id, matched_unit_rate)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                mr.id, ln.item.product_variant_id, callQty, ln.item.uom,
                contract.id, cl.id, unitRate,
              ]
            );

            // 3) Purchase order — is_call_off=TRUE bypasses the RFQ chain.
            //    status='sent' = issued + dispatched to vendor.
            const po = await t.one(
              `INSERT INTO public.tbl_rfq_purchase_order
                 (rfq_id, company_id, po_number, status, rfq_product_id,
                  quantity, unit_price, finalized_vendor_id, total_value,
                  arc_contract_id, source_mr_id, is_call_off, created_at)
               VALUES (NULL, $1, $2, 'sent', '{}'::int[],
                       $3, $4, $5, $6, $7, $8, TRUE, $9)
               RETURNING id`,
              [
                company.id, poNumber,
                callQty, unitRate, v.id, totalValue,
                contract.id, mr.id, callDate,
              ]
            );

            // 4) Call-off link row — what arcModel.list joins on for the
            //    "call_off_count" column on the dashboard tile.
            await t.none(
              `INSERT INTO public.tbl_arc_callof_po
                 (po_id, mr_id, arc_contract_id, arc_contract_line_id,
                  quantity, price_applied, released_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [po.id, mr.id, contract.id, cl.id, callQty, unitRate, callDate]
            );
          }
        }
      }
      createdContracts.push(contract);
    }
    ok(`tbl_arc_contract × ${createdContracts.length} (status=active, signed)`);
    ok(`tbl_arc_contract_line + tbl_arc_callof_po rows for every (vendor × item) — call-offs back every consumed unit`);

    // 11) Event log — the narrative the detail page's Lifecycle Timeline
    //     reads from.
    const events = [
      { type: 'created',                at: '2026-04-14 10:00:00', payload: {} },
      { type: 'floated',                at: '2026-04-15 09:00:00', payload: { invited: usedVendors.length } },
      ...usedVendors.map((v, i) => ({
        type: 'vendor_submitted',
        at: `2026-05-08 14:0${i}:00`,
        payload: { vendor_id: v.id },
      })),
      { type: 'submission_closed',      at: '2026-05-10 18:00:00', payload: {} },
      { type: 'tech_eval_submitted',    at: '2026-05-18 18:00:00', payload: {} },
      { type: 'tech_eval_approved',     at: '2026-05-19 10:00:00', payload: {} },
      { type: 'comm_eval_finalized',    at: '2026-05-25 16:00:00', payload: {} },
      { type: 'committee_decision',     at: '2026-05-28 17:00:00', payload: { decision: 'approved' } },
      { type: 'contract_generated',     at: '2026-05-28 17:05:00', payload: { contracts: createdContracts.length } },
      { type: 'vendor_signed',          at: '2026-05-30 11:25:00', payload: { vendor_ids: createdContracts.map((c) => c.vendor_id) } },
      { type: 'contract_active',        at: '2026-06-01 00:00:00', payload: {} },
    ];
    for (const ev of events) {
      await t.none(
        `INSERT INTO public.tbl_arc_event_log (arc_id, event_type, actor_id, payload, at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [arc.id, ev.type, buyer.id, JSON.stringify(ev.payload), ev.at]
      );
    }
    ok(`tbl_arc_event_log × ${events.length}`);

    return { arc, contracts: createdContracts };
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  ARC 2 — just FLOATED, no quotes yet
// ─────────────────────────────────────────────────────────────────────────
async function seedArc2Floated(ctx) {
  head('Seeding ARC 2 · FLOATED (open tender, no responses yet)');
  const { company, hotel, category, department, approvalProcess, buyer, variants, vendors } = ctx;
  const usedVendors = vendors.slice(0, 3);
  const [v1, v2] = variants;

  return db.tx(async (t) => {
    const arcNumber = `ARC-STG-${ts}-B`;
    const arc = await t.one(
      `INSERT INTO public.tbl_arc (
          arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected,
          delivery_expected, penalty_clause, created_by)
       VALUES ($1, $2, $3, $4, '[]'::jsonb,
               $5, $6, $7, $8,
               'floated', $9, $10, $11, $12,
               TRUE, FALSE, 'invitation',
               '{"type":"none","cap_pct":null}'::jsonb, 'Net 45',
               $13, $14, $15)
       RETURNING *`,
      [
        arcNumber,
        `${category.title} · ${hotel.name} · FY 2026-27 (Tranche B)`,
        'Floated tender awaiting vendor quotes. Seeded for list-page tab testing.',
        category.id,
        company.id, hotel.id, department.id, approvalProcess.id,
        '2026-06-05 09:00:00', '2026-06-30 18:00:00',
        '2026-08-01 00:00:00', '2027-07-31 23:59:59',
        'Within 30 days of each call-off PO',
        '1% LD per week of delay, capped at 5% of PO value',
        buyer.id,
      ]
    );
    ok(`tbl_arc id=${arc.id} number=${arc.arc_number}`);

    // 2 items only
    const items = [
      { variant: v1, qty: 600, target: 65.00, uom: 'kg', spec: 'Same spec as primary ARC — separate purchase tranche' },
      { variant: v2, qty: 400, target: 55.00, uom: 'kg', spec: 'Backup supplier sourcing — secondary spec acceptable' },
    ];
    for (const it of items) {
      await t.none(
        `INSERT INTO public.tbl_arc_item
           (arc_id, product_variant_id, spec_text, target_price, indicative_qty, uom)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [arc.id, it.variant.id, it.spec, it.target, it.qty, it.uom]
      );
    }
    ok(`tbl_arc_item × ${items.length}`);

    for (const v of usedVendors) {
      await t.none(
        `INSERT INTO public.tbl_arc_invitation (arc_id, vendor_id, status, invited_at)
         VALUES ($1, $2, 'invited', $3)`,
        [arc.id, v.id, '2026-06-05 09:30:00']
      );
    }
    ok(`tbl_arc_invitation × ${vendors.length} (all 'invited' — no responses yet)`);

    await t.none(
      `INSERT INTO public.tbl_arc_event_log (arc_id, event_type, actor_id, payload, at)
       VALUES ($1, 'created', $2, '{}'::jsonb, $3),
              ($1, 'floated', $2, $4::jsonb, $5)`,
      [
        arc.id, buyer.id,
        '2026-06-04 14:00:00',
        JSON.stringify({ invited: vendors.length }),
        '2026-06-05 09:00:00',
      ]
    );

    return { arc };
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  ARC 3 — sitting at COMMITTEE_REVIEW with a draft award proposal
// ─────────────────────────────────────────────────────────────────────────
async function seedArc3CommitteeReview(ctx) {
  head('Seeding ARC 3 · COMMITTEE_REVIEW (awards proposed, awaiting committee)');
  const { company, hotel, category, department, approvalProcess, buyer, variants, vendors } = ctx;
  const usedVendors = vendors.slice(0, 3);
  const vA = usedVendors[0];
  const vB = usedVendors[1];
  const vC = usedVendors[2] || usedVendors[0];  // fallback to A when only 2 vendors exist
  const [v1, v2] = variants;

  return db.tx(async (t) => {
    const arcNumber = `ARC-STG-${ts}-C`;
    const arc = await t.one(
      `INSERT INTO public.tbl_arc (
          arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected,
          delivery_expected, penalty_clause, created_by)
       VALUES ($1, $2, $3, $4, '[]'::jsonb,
               $5, $6, $7, $8,
               'committee_review', $9, $10, $11, $12,
               TRUE, FALSE, 'invitation',
               '{"type":"annual_pct","cap_pct":4}'::jsonb, 'Net 30',
               $13, $14, $15)
       RETURNING *`,
      [
        arcNumber,
        `${category.title} · ${hotel.name} · Q4 2026 Supplemental`,
        'Supplemental contract sitting at committee review — comm-eval finalized, awaiting committee vote.',
        category.id,
        company.id, hotel.id, department.id, approvalProcess.id,
        '2026-05-01 09:00:00', '2026-05-25 18:00:00',
        '2026-07-01 00:00:00', '2027-06-30 23:59:59',
        'Within 21 days of each call-off PO',
        '1.5% LD per week of delay',
        buyer.id,
      ]
    );
    ok(`tbl_arc id=${arc.id} number=${arc.arc_number}`);

    const items = [
      { variant: v1, qty: 700, target: 58.00, uom: 'kg', spec: 'Q4 supplemental — same spec as primary ARC' },
      { variant: v2, qty: 350, target: 50.00, uom: 'kg', spec: 'Q4 supplemental — secondary line' },
    ];
    const arcItems = [];
    for (const it of items) {
      const row = await t.one(
        `INSERT INTO public.tbl_arc_item
           (arc_id, product_variant_id, spec_text, target_price, indicative_qty, uom)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [arc.id, it.variant.id, it.spec, it.target, it.qty, it.uom]
      );
      arcItems.push({ ...row, _meta: it });
    }
    ok(`tbl_arc_item × ${arcItems.length}`);

    for (const v of usedVendors) {
      await t.none(
        `INSERT INTO public.tbl_arc_invitation (arc_id, vendor_id, status, invited_at, responded_at)
         VALUES ($1, $2, 'submitted', $3, $4)`,
        [arc.id, v.id, '2026-05-01 09:30:00', '2026-05-23 16:00:00']
      );
    }
    ok(`tbl_arc_invitation × ${vendors.length} (all submitted)`);

    // Per-item tech eval — minimal but valid
    for (const ai of arcItems) {
      const te = await t.one(
        `INSERT INTO public.tbl_arc_item_tech_evaluation
           (arc_item_id, minimum_passing_score, is_complete, current_round)
         VALUES ($1, 60, TRUE, 1)
         RETURNING *`,
        [ai.id]
      );
      const c = await t.one(
        `INSERT INTO public.tbl_arc_item_tech_evaluation_clauses
           (arc_item_tech_evaluation_id, clause_text, weightage, clause_type)
         VALUES ($1, 'Spec compliance verified', 100, 'spec')
         RETURNING *`,
        [te.id]
      );
      for (const v of usedVendors) {
        await t.none(
          `INSERT INTO public.tbl_arc_item_tech_evaluation_vendors_response
             (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response,
              buyer_id, buyer_marks, score_timestamp)
           VALUES ($1, $2, 'Compliant', $3, $4, $5)`,
          [c.id, v.id, buyer.id, v.id === vA.id ? 92 : v.id === vB.id ? 85 : 78, '2026-05-26 12:00:00']
        );
        await t.none(
          `INSERT INTO public.tbl_arc_item_tech_evaluation_cleared_vendors
             (arc_item_tech_evaluation_id, vendor_id, calculated_score, status, evaluation_round, created_by)
           VALUES ($1, $2, $3, 'qualified', 1, $4)`,
          [te.id, v.id, v.id === vA.id ? 92 : v.id === vB.id ? 85 : 78, buyer.id]
        );
      }
    }
    ok(`tech eval seeded for ${arcItems.length} items`);

    // Quotes
    const quoteByVendor = {};
    const quoteRates = {
      [vA.id]: [items[0].target + 2.5, items[1].target + 2.0],
      [vB.id]: [items[0].target + 3.0, items[1].target + 2.8],
      [vC.id]: [items[0].target + 4.0, items[1].target + 1.5],   // C is L1 on item 2
    };
    for (const v of usedVendors) {
      const q = await t.one(
        `INSERT INTO public.tbl_arc_quote
           (arc_id, vendor_id, submitted_at, payment_terms, gstin_used)
         VALUES ($1, $2, $3, 'Net 30', '27AAAAA0000A1Z5')
         RETURNING *`,
        [arc.id, v.id, '2026-05-23 16:00:00']
      );
      quoteByVendor[v.id] = q;
      for (let i = 0; i < arcItems.length; i++) {
        await t.none(
          `INSERT INTO public.tbl_arc_quote_line
             (arc_quote_id, arc_item_id, rate, gst_pct, charges, lead_time_days, moq, validity_notes)
           VALUES ($1, $2, $3, 5.00, '[{"label":"Freight","type":"pct","value":1.5}]'::jsonb,
                   14, 50, 'Valid through contract term')`,
          [q.id, arcItems[i].id, quoteRates[v.id][i]]
        );
      }
    }
    ok(`tbl_arc_quote × ${vendors.length}, tbl_arc_quote_line × ${vendors.length * arcItems.length}`);

    // Comm eval — finalized (proposal locked), parent ARC at committee_review
    const commEval = await t.one(
      `INSERT INTO public.tbl_arc_comm_evaluation
         (arc_id, status, finalized_by, finalized_at)
       VALUES ($1, 'finalized', $2, $3)
       RETURNING *`,
      [arc.id, buyer.id, '2026-06-01 14:00:00']
    );

    // Proposal: item 1 → 100% to A; item 2 → split 50/50 between A and C
    const proposals = [
      { item: arcItems[0], allocs: [{ vendor: vA, qty: items[0].qty, share: 100, rank: 'L1', l1default: true }] },
      { item: arcItems[1], allocs: [
          { vendor: vA, qty: Math.round(items[1].qty * 0.5), share: 50, rank: 'L2', l1default: false },
          { vendor: vC, qty: Math.round(items[1].qty * 0.5), share: 50, rank: 'L1', l1default: true  },
        ]
      },
    ];
    for (const p of proposals) {
      for (const a of p.allocs) {
        const ql = await t.one(
          `SELECT id, rate FROM public.tbl_arc_quote_line
            WHERE arc_quote_id = $1 AND arc_item_id = $2`,
          [quoteByVendor[a.vendor.id].id, p.item.id]
        );
        await t.none(
          `INSERT INTO public.tbl_arc_comm_evaluation_award
             (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
              awarded_quote_line_id, allocated_qty, allocated_share_pct,
              l_rank, is_l1_default, awarded_quote_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            commEval.id, p.item.id, a.vendor.id, ql.id,
            a.qty, a.share, a.rank, a.l1default,
            JSON.stringify({ rate: Number(ql.rate), gst_pct: 5, lead_time_days: 14 }),
          ]
        );
      }
    }
    ok(`tbl_arc_comm_evaluation_award proposal seeded (item 2 split A/C)`);

    await t.none(
      `INSERT INTO public.tbl_arc_event_log (arc_id, event_type, actor_id, payload, at)
       VALUES ($1, 'created',             $2, '{}'::jsonb,    '2026-04-30 11:00:00'),
              ($1, 'floated',             $2, '{}'::jsonb,    '2026-05-01 09:00:00'),
              ($1, 'submission_closed',   $2, '{}'::jsonb,    '2026-05-25 18:00:00'),
              ($1, 'tech_eval_approved',  $2, '{}'::jsonb,    '2026-05-28 12:00:00'),
              ($1, 'comm_eval_finalized', $2, '{}'::jsonb,    '2026-06-01 14:00:00'),
              ($1, 'committee_opened',    $2, '{}'::jsonb,    '2026-06-01 14:05:00')`,
      [arc.id, buyer.id]
    );

    return { arc };
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const ctx = await lookupContext();
    const r1 = await seedArc1Active(ctx);
    const r2 = await seedArc2Floated(ctx);
    const r3 = await seedArc3CommitteeReview(ctx);

    head('Summary');
    log(`ARC 1 (ACTIVE)            id=${r1.arc.id}  number=${r1.arc.arc_number}  contracts=${r1.contracts.length}`);
    log(`ARC 2 (FLOATED)           id=${r2.arc.id}  number=${r2.arc.arc_number}`);
    log(`ARC 3 (COMMITTEE_REVIEW)  id=${r3.arc.id}  number=${r3.arc.arc_number}`);
    console.log('\nDone. To remove a seeded ARC and its dependents:\n  DELETE FROM tbl_arc WHERE id = <id>;\n');
    process.exit(0);
  } catch (err) {
    console.error('\nSeed failed:', err.message);
    if (err.detail)  console.error('  detail:',  err.detail);
    if (err.hint)    console.error('  hint:',    err.hint);
    if (err.query)   console.error('  query:',   err.query?.slice(0, 200));
    process.exit(1);
  }
})();
