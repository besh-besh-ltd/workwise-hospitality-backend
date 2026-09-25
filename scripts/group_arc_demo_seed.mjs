// Group ARC — demo data so the product team can try the feature unaided.
//
// Seeds, for one company:
//   1. the ARC_GROUP approval workflow, copying the steps of the company's
//      existing ARC workflow. WITHOUT THIS, PUBLISHING A GROUP ARC IS REFUSED
//      by design, so this is configuration rather than demo data.
//   2. "ZZ DEMO" group rate contracts to look at:
//        · FLOATED  — vendors invited per hotel, quotes in, ready to evaluate
//        · ACTIVE   — contracts signed, per-hotel ledger, nothing consumed yet
//      Consumption is left at zero on purpose: the tester raises a material
//      requisition themselves and watches that hotel's usage move.
//
// Every row it writes is findable by the ZZ_DEMO marker in the ARC title, and
// scripts/group_arc_demo_unseed.mjs removes exactly those.
//
// Vendors are chosen the way the app chooses them (PRD §10): a vendor needs an
// ACTIVE category subscription AND an ACTIVE subscription for that hotel. The
// script never grants a subscription — on production those are billing rows.
//
//   node scripts/group_arc_demo_seed.mjs --db=hospitality_stage --company=5 \
//     --hotels=6,13,11 --category=273 --creator=<userId> [--dry-run]
//
// --grant-hotel-subs is for a TEST database only: it gives the category's
// vendors an active subscription for the demo hotels so the invitation story
// has something to show. It refuses to run against production, where
// subscriptions are billing rows.

import pgPromise from 'pg-promise';
import dotenv from 'dotenv';

dotenv.config();

const MARKER = 'ZZ DEMO';
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const DRY = process.argv.includes('--dry-run');
const GRANT_SUBS = process.argv.includes('--grant-hotel-subs');
const DB = arg('db');
const COMPANY = Number(arg('company'));
const HOTELS = (arg('hotels') || '').split(',').map(Number).filter(Boolean);
const CATEGORY = Number(arg('category'));
const CREATOR = Number(arg('creator'));
const DEPARTMENT = Number(arg('department'));

if (!DB || !COMPANY || HOTELS.length < 2 || !CATEGORY || !CREATOR || !DEPARTMENT) {
  console.error('usage: --db= --company= --hotels=a,b,c (>=2) --category= --creator= --department= [--dry-run]');
  process.exit(1);
}

const db = pgPromise()({
  host: process.env.HOST,
  port: Number(process.env.DATABASE_PORT || 5432),
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: DB,
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});

const log = (...a) => console.log(...a);

async function main() {
  const company = await db.one('SELECT id, name FROM tbl_hospitality_companies WHERE id = $1', [COMPANY]);
  const hotels = await db.any(
    `SELECT id, name, city FROM tbl_hospitality_company_hotels
      WHERE id = ANY($1::int[]) AND hospitality_company_id = $2 ORDER BY array_position($1::int[], id)`,
    [HOTELS, COMPANY]
  );
  if (hotels.length !== HOTELS.length) throw new Error('some hotels do not belong to that company');
  const category = await db.one('SELECT id, title FROM tbl_category WHERE id = $1', [CATEGORY]);
  const department = await db.one('SELECT id, title FROM tbl_department WHERE id = $1', [DEPARTMENT]);
  const lead = hotels[0];
  log(`\n${company.name} · ${category.title}`);
  log(`lead: ${lead.name}, plus ${hotels.slice(1).map((h) => h.name).join(', ')}`);
  log(`department: ${department.title}`);

  // ── test databases only: make sure the hotels have vendor coverage ────
  if (GRANT_SUBS && !DRY) {
    if (/main|prod/i.test(DB)) throw new Error(`--grant-hotel-subs refuses to touch ${DB}`);
    const granted = await db.one(
      `WITH covered AS (
         SELECT DISTINCT sc.vendor_id
           FROM tbl_vendor_hotel_category_subscription sc
           JOIN tbl_users u ON u.id = sc.vendor_id AND u.user_type = 3 AND u.status = 1
          WHERE sc.item_type = 'category' AND sc.item_id = $1 AND sc.status = 'active'
          LIMIT 6)
       INSERT INTO tbl_vendor_hotel_category_subscription
         (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       SELECT c.vendor_id, 'hotel', h, 0, CURRENT_DATE - 30, CURRENT_DATE + 335, 'active'
         FROM covered c CROSS JOIN unnest($2::int[]) h
        ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
       RETURNING 1`,
      [CATEGORY, HOTELS]
    ).catch(() => ({ count: 0 }));
    log(`  (test db) granted hotel subscriptions where missing`);
  }

  // ── who can actually be invited (the app's own rule) ───────────────────
  const vendorsByHotel = {};
  for (const h of hotels) {
    vendorsByHotel[h.id] = (await db.any(
      `SELECT DISTINCT u.id, u.name
         FROM tbl_vendor_hotel_category_subscription sc
         JOIN tbl_vendor_hotel_category_subscription sh
           ON sh.vendor_id = sc.vendor_id AND sh.item_type = 'hotel'
          AND sh.item_id = $2 AND sh.status = 'active'
         JOIN tbl_users u ON u.id = sc.vendor_id AND u.user_type = 3 AND u.status = 1
        WHERE sc.item_type = 'category' AND sc.item_id = $1 AND sc.status = 'active'
        ORDER BY u.id LIMIT 3`,
      [CATEGORY, h.id]
    )).map((v) => ({ ...v, hotel_id: h.id }));
    log(`  ${h.name}: ${vendorsByHotel[h.id].length} eligible vendor(s)`);
  }
  const anyVendor = Object.values(vendorsByHotel).flat();
  if (anyVendor.length === 0) {
    throw new Error('no vendor holds both the category and any of these hotels — pick another category or hotels');
  }

  // ── 1. the group approval workflow ────────────────────────────────────
  const existingGroup = await db.oneOrNone(
    `SELECT id FROM tbl_approval_policies
      WHERE hospitality_company_id = $1 AND entity_type = 'ARC_GROUP' AND is_active = true`, [COMPANY]);
  if (existingGroup) {
    log(`\nGroup ARC workflow: already configured (policy ${existingGroup.id})`);
  } else {
    const source = await db.oneOrNone(
      `SELECT id FROM tbl_approval_policies
        WHERE hospitality_company_id = $1 AND entity_type = 'ARC' AND is_active = true
        ORDER BY hotel_id NULLS FIRST, id LIMIT 1`, [COMPANY]);
    if (!source) throw new Error('no ARC workflow to copy — configure one in Admin first');
    const steps = await db.any(
      `SELECT step_order, decision_rule, approver_source_type, approver_source_id
         FROM tbl_approval_policy_steps WHERE approval_policy_id = $1 ORDER BY step_order`, [source.id]);
    log(`\nGroup ARC workflow: copying ${steps.length} level(s) from the company's ARC workflow (policy ${source.id})`);
    if (!DRY) {
      // The two environments disagree about this table: staging carries extra
      // legacy columns (company_id, is_department_scoped) and a CHECK that
      // requires company_id; production has none of them. Insert exactly the
      // columns createApprovalPolicy() uses — those exist everywhere — and add
      // company_id only where the column is really present.
      const hasCompanyId = await db.oneOrNone(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tbl_approval_policies' AND column_name = 'company_id'`);
      const policy = hasCompanyId
        ? await db.one(
            `INSERT INTO tbl_approval_policies
               (entity_type, hospitality_company_id, company_id, hotel_id, department_id, process_id,
                created_by, is_active, is_master)
             VALUES ('ARC_GROUP', $1, (SELECT buyer_company_id FROM tbl_hospitality_companies WHERE id = $1),
                     NULL, NULL, NULL, $2, true, true) RETURNING id`,
            [COMPANY, CREATOR])
        : await db.one(
            `INSERT INTO tbl_approval_policies
               (entity_type, hospitality_company_id, hotel_id, department_id, process_id,
                created_by, is_active, is_master)
             VALUES ('ARC_GROUP', $1, NULL, NULL, NULL, $2, true, true) RETURNING id`,
            [COMPANY, CREATOR]);
      for (const s of steps) {
        await db.none(
          `INSERT INTO tbl_approval_policy_steps
             (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [policy.id, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id]);
      }
      log(`  created policy ${policy.id}`);
    }
  }

  if (DRY) { log('\n--dry-run: no demo contracts written\n'); return; }

  // ── 2. the demo contracts ─────────────────────────────────────────────
  const already = await db.any(
    `SELECT id, title, status FROM tbl_arc WHERE hospitality_company_id = $1 AND title LIKE $2`,
    [COMPANY, `${MARKER}%`]);
  if (already.length > 0) {
    log(`\nDemo contracts already present (${already.map((a) => `#${a.id} ${a.status}`).join(', ')}) — nothing to add.`);
    log('Run scripts/group_arc_demo_unseed.mjs first if you want them rebuilt.\n');
    return;
  }

  // Same category filter the catalogue endpoint uses: EXISTS over
  // tbl_product_categories, which is non-multiplying (a product can be mapped
  // to one category more than once).
  const variants = await db.any(
    `SELECT pv.id, pv.name FROM tbl_product_variant pv
      WHERE EXISTS (SELECT 1 FROM tbl_product_categories pc
                     WHERE pc.product_id = pv.product_id AND pc.category_id = $1)
      ORDER BY pv.name LIMIT 2`, [CATEGORY]);
  if (variants.length < 2) throw new Error(`category ${CATEGORY} has fewer than 2 products`);

  const nextArcNumber = async (t) => {
    const row = await t.one(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(arc_number, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n FROM tbl_arc`);
    return `ZZDEMO-${row.n}`;
  };

  const split = (total) => {
    const per = Math.floor(total / hotels.length / 10) * 10;
    const out = hotels.map(() => per);
    out[0] = total - per * (hotels.length - 1);
    return out;
  };

  async function makeDemo(t, { titleSuffix, status, withContract }) {
    const qtys = [split(1000), split(600)];
    const arc = await t.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
          status, eligibility_type, is_group, submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, payment_terms_expected, delivery_expected, created_by)
       VALUES ($1, $2, $3, $4, $5, $8,
               $6, 'open', true,
               NOW() - INTERVAL '5 days', NOW() + INTERVAL '20 days',
               NOW() - INTERVAL '1 day', NOW() + INTERVAL '300 days',
               'Net 30 from invoice', 'Within 7 days of release', $7)
       RETURNING id, arc_number`,
      [await nextArcNumber(t), `${MARKER} — ${titleSuffix}`, CATEGORY, COMPANY, lead.id, status, CREATOR, DEPARTMENT]);

    await t.none(
      `INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by)
       SELECT $1, h, $2 FROM unnest($3::int[]) h`, [arc.id, CREATOR, HOTELS]);

    const items = [];
    for (const [i, v] of variants.entries()) {
      const item = await t.one(
        `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, spec_text)
         VALUES ($1, $2, $3, 'pcs', $4) RETURNING id`,
        [arc.id, v.id, qtys[i].reduce((a, b) => a + b, 0), 'Demo line — as per standard specification']);
      for (const [hi, h] of hotels.entries()) {
        await t.none(
          `INSERT INTO tbl_arc_item_hotel_qty (arc_item_id, hotel_id, indicative_qty) VALUES ($1, $2, $3)`,
          [item.id, h.id, qtys[i][hi]]);
      }
      items.push({ id: item.id, qtys: qtys[i] });
    }

    // Invitations: each vendor for the hotels it actually covers.
    const byVendor = new Map();
    for (const h of hotels) {
      for (const v of vendorsByHotel[h.id]) {
        if (!byVendor.has(v.id)) byVendor.set(v.id, { name: v.name, hotels: [] });
        byVendor.get(v.id).hotels.push(h.id);
      }
    }
    const invited = [...byVendor.entries()].slice(0, 4);
    const lines = {};
    for (const [vendorId, meta] of invited) {
      const inv = await t.one(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'submitted') RETURNING id`,
        [arc.id, vendorId]);
      await t.none(
        `INSERT INTO tbl_arc_invitation_hotel (arc_invitation_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`,
        [inv.id, meta.hotels]);
      const quote = await t.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`,
        [arc.id, vendorId]);
      for (const [i, it] of items.entries()) {
        const rate = 100 + i * 25 + (invited.findIndex(([id]) => id === vendorId) * 5);
        const line = await t.one(
          `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1, $2, $3, 5) RETURNING id`,
          [quote.id, it.id, rate]);
        lines[`${vendorId}:${it.id}`] = { id: line.id, rate };
      }
    }

    if (!withContract) return { arc, invited: invited.length };

    // Award every hotel to the vendor that covers it (cheapest first), then
    // sign: exactly the shape the committee would produce.
    const comm = await t.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status, finalized_at) VALUES ($1, 'finalized', NOW()) RETURNING id`,
      [arc.id]);
    const contracts = new Map();
    for (const [i, it] of items.entries()) {
      const perVendor = new Map();
      for (const [hi, h] of hotels.entries()) {
        const winner = vendorsByHotel[h.id][0];
        if (!winner) continue;
        if (!perVendor.has(winner.id)) perVendor.set(winner.id, []);
        perVendor.get(winner.id).push({ hotel_id: h.id, qty: it.qtys[hi] });
      }
      for (const [vendorId, rows] of perVendor) {
        const line = lines[`${vendorId}:${it.id}`];
        const total = rows.reduce((s, r) => s + r.qty, 0);
        const award = await t.one(
          `INSERT INTO tbl_arc_comm_evaluation_award (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
              awarded_quote_line_id, allocated_qty, l_rank, is_l1_default, awarded_quote_snapshot)
           VALUES ($1,$2,$3,$4,$5,'L1',true,$6) RETURNING id`,
          [comm.id, it.id, vendorId, line.id, total, JSON.stringify({ rate: line.rate, gst_pct: 5 })]);
        for (const r of rows) {
          await t.none(
            `INSERT INTO tbl_arc_comm_evaluation_award_hotel (arc_comm_evaluation_award_id, hotel_id, allocated_qty)
             VALUES ($1,$2,$3)`, [award.id, r.hotel_id, r.qty]);
        }
        if (!contracts.has(vendorId)) {
          const c = await t.one(
            `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, signed_by_vendor_at)
             VALUES ($1,$2,'active',NOW()) RETURNING id`, [arc.id, vendorId]);
          contracts.set(vendorId, c.id);
        }
        const cl = await t.one(
          `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
           VALUES ($1,$2,$3,5,$4) RETURNING id`, [contracts.get(vendorId), it.id, line.rate, total]);
        for (const r of rows) {
          // consumed_qty stays 0 — the tester raises the first requisition.
          await t.none(
            `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, consumed_qty)
             VALUES ($1,$2,$3,0)`, [cl.id, r.hotel_id, r.qty]);
        }
      }
    }
    return { arc, invited: invited.length, contracts: contracts.size };
  }

  const made = await db.tx(async (t) => [
    await makeDemo(t, { titleSuffix: 'group contract to evaluate and award', status: 'floated', withContract: false }),
    await makeDemo(t, { titleSuffix: 'live group contract to order against', status: 'contract_active', withContract: true }),
  ]);

  log('\nDemo contracts created:');
  for (const m of made) {
    log(`  #${m.arc.id} ${m.arc.arc_number} — ${m.invited} vendor(s) invited${m.contracts ? `, ${m.contracts} contract(s) signed` : ''}`);
  }
  log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('\nFAILED:', err.message, '\n'); process.exit(1); });
