// A deliberately varied, COMMITTED procurement world for the perf-parity suites
// (portal perf plan 2026-10).
//
// Those suites prove a rewritten query is a pure optimisation by running the
// old implementation (a frozen oracle, or code that was left untouched) and the
// new one against the same data and requiring identical output. That proof is
// only as strong as the data is varied, so this world is built to put every
// branch of the rewritten SQL on BOTH sides:
//
//   - 6 buyer users with different RBAC shapes: company-wide over two
//     companies, hotel+department, process-scoped, department-only, single
//     hotel in company B, and an approver who holds no rfq.read at all (reaches
//     RFQs only through the approver-read exemption).
//   - ~70 RFQs over 5 hotels x 4 departments x 3 processes, every status
//     (draft / pending-approval / ready / published / closed / withdrawn),
//     tenders and RFQs, multi-hotel mappings, past/future/blank bid dates.
//   - per product: invited vendors (incl. one with a NULL name), regret and
//     real quotes, zero-price lines with/without comments, finalisations,
//     POs in every status incl. multi-line, partial, rejected-with and
//     -without replacement, cancelled.
//   - tech evals that are stuck, complete, and unstartable; vendor queries
//     read and unread; open clarifications; expired negotiation rounds;
//     PENDING approval instances for RFQ / TECHNICAL / NEGOTIATION_QUOTE / PO.
//   - vendor<->variant mappings with duplicates, unapproved rows, and hotel
//     subscriptions that fan out over several hotels (the searchProduct join
//     explosion), for the search / recommendation suites.
//
// Everything is generated from a fixed-seed PRNG, so a failure reproduces.
// Every inserted id is tracked and removed by cleanup(); nothing is deleted by
// range (tests/CONVENTIONS.md §6).

import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

export const WORLD_USERS = Object.freeze({
  wide: 80901, // company-level in A and B, CEO in both
  hotel: 80902, // A1/proc creator, A2 tech evaluator, A2/eng observer
  process: 80903, // company A, RFQ Creator for process A_P1 only + Comm Approver A1/A_P2
  dept: 80904, // A1 / Engineering negotiator + observer
  hotelB: 80905, // B1 only, CEO
  approver: 80906, // A3, Final Awarding P1 only — no rfq.read
});

const WORLD_VENDORS = Object.freeze({
  v1: 80911,
  v2: 80912,
  noName: 80913, // name IS NULL — exercises the `Vendor <id>` label fallback
});

const VENDOR_POOL = [
  IDS.users.vendor_alpha,
  IDS.users.vendor_beta,
  IDS.users.vendor_gamma,
  IDS.users.vendor_delta,
  IDS.users.vendor_epsilon,
  WORLD_VENDORS.v1,
  WORLD_VENDORS.v2,
  WORLD_VENDORS.noName,
];

const ROLE = { CEO: 1, CREATOR: 2, TECH_EVAL: 6, NEGO_N1: 8, COMM_APPROVER: 12, AWARD_P1: 13, OBSERVER: 17 };

const HOTEL_COMPANY = {
  [IDS.hotels.A1]: IDS.hospitality.A,
  [IDS.hotels.A2]: IDS.hospitality.A,
  [IDS.hotels.A3]: IDS.hospitality.A,
  [IDS.hotels.B1]: IDS.hospitality.B,
  [IDS.hotels.B2]: IDS.hospitality.B,
};

// mulberry32 — tiny deterministic PRNG.
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    sample: (arr, n) => {
      const copy = [...arr];
      const out = [];
      while (out.length < n && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

const pad = (n) => String(n).padStart(2, "0");
// Naive wall-clock string, the shape bid_end_date and tbl_rfq.timestamp hold.
function naive(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const TITLES = [
  "Beverage restock", "Monsoon linen order", "Kitchen equipment", "Guest amenities",
  "Banquet crockery", "Housekeeping chemicals", "Minibar refill", "Spa consumables",
  "Engineering spares", "Breakfast juices",
];

const PO_STATUSES = ["approved", "pending_approval", "rejected", "rejected_by_vendor", "cancelled", "completed", "sent", "acceptance_pending"];

export async function seedPerfWorld(db, { seed = 20261003, rfqCount = 72 } = {}) {
  const r = prng(seed);
  const track = {
    users: [], hum: [], scopes: [], rfqs: [], quotes: [], pos: [], instances: [],
    clarifications: [], subs: [], pvvm: [], vendorApprove: [],
  };

  await db.tx(async (t) => {
    // ── users ────────────────────────────────────────────────────────────
    const buyers = [
      [WORLD_USERS.wide, "World Wide Buyer", IDS.companies.A],
      [WORLD_USERS.hotel, "World Hotel Buyer", IDS.companies.A],
      [WORLD_USERS.process, "World Process Buyer", IDS.companies.A],
      [WORLD_USERS.dept, "World Dept Negotiator", IDS.companies.A],
      [WORLD_USERS.hotelB, "World B1 CEO", IDS.companies.B],
      [WORLD_USERS.approver, "World A3 Award Approver", IDS.companies.A],
    ];
    for (const [id, name, company] of buyers) {
      await t.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id) VALUES ($1, $2, $3, 1, 2, $4)`,
        [id, name, `world.${id}@test.local`, company]
      );
      track.users.push(id);
    }
    const vendors = [
      [WORLD_VENDORS.v1, "World Vendor One", IDS.companies.vendorAlpha],
      [WORLD_VENDORS.v2, "World Vendor Two", IDS.companies.vendorBeta],
      [WORLD_VENDORS.noName, null, IDS.companies.vendorGamma],
    ];
    for (const [id, name, company] of vendors) {
      await t.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id) VALUES ($1, $2, $3, 1, 3, $4)`,
        [id, name, `world.vendor.${id}@test.local`, company]
      );
      track.users.push(id);
    }

    const hum = [
      [WORLD_USERS.wide, IDS.hospitality.A, null, 0],
      [WORLD_USERS.wide, IDS.hospitality.B, null, 0],
      [WORLD_USERS.hotel, IDS.hospitality.A, IDS.hotels.A1, 1],
      [WORLD_USERS.hotel, IDS.hospitality.A, IDS.hotels.A2, 1],
      [WORLD_USERS.process, IDS.hospitality.A, null, 0],
      [WORLD_USERS.dept, IDS.hospitality.A, IDS.hotels.A1, 1],
      [WORLD_USERS.hotelB, IDS.hospitality.B, IDS.hotels.B1, 1],
      [WORLD_USERS.approver, IDS.hospitality.A, IDS.hotels.A3, 1],
    ];
    for (const [user, company, hotel, type] of hum) {
      const row = await t.one(
        `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user, company, hotel, type, IDS.users.superAdmin]
      );
      track.hum.push(row.id);
    }

    const scopes = [
      [WORLD_USERS.wide, ROLE.CEO, IDS.hospitality.A, null, null, null],
      [WORLD_USERS.wide, ROLE.CEO, IDS.hospitality.B, null, null, null],
      [WORLD_USERS.hotel, ROLE.CREATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, null],
      [WORLD_USERS.hotel, ROLE.TECH_EVAL, IDS.hospitality.A, IDS.hotels.A2, null, null],
      [WORLD_USERS.hotel, ROLE.OBSERVER, IDS.hospitality.A, IDS.hotels.A2, IDS.departments.eng, null],
      [WORLD_USERS.process, ROLE.CREATOR, IDS.hospitality.A, null, null, IDS.processes.A_P1],
      [WORLD_USERS.process, ROLE.COMM_APPROVER, IDS.hospitality.A, IDS.hotels.A1, null, IDS.processes.A_P2],
      [WORLD_USERS.dept, ROLE.NEGO_N1, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.eng, null],
      [WORLD_USERS.dept, ROLE.OBSERVER, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.eng, null],
      [WORLD_USERS.hotelB, ROLE.CEO, IDS.hospitality.B, IDS.hotels.B1, null, null],
      [WORLD_USERS.approver, ROLE.AWARD_P1, IDS.hospitality.A, IDS.hotels.A3, null, null],
    ];
    for (const [user, role, company, hotel, dept, proc] of scopes) {
      const row = await t.one(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user, role, company, hotel, dept, proc]
      );
      track.scopes.push(row.id);
    }

    // ── catalogue slice: real reference variants that carry categories ────
    const variants = await t.any(
      `SELECT pv.id, pv.product_id, MIN(pc.category_id) AS category_id
         FROM tbl_product_variant pv
         JOIN tbl_product p ON p.id = pv.product_id
         JOIN tbl_product_categories pc ON pc.product_id = p.id
        WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1
        GROUP BY pv.id, pv.product_id
        ORDER BY pv.id
        LIMIT 60`
    );
    const variantIds = variants.map((v) => v.id);
    const categoryIds = [...new Set(variants.map((v) => Number(v.category_id)))];

    // Vendor subscriptions + mappings (search / recommendations / eligibility).
    const today = new Date();
    const dateOnly = (days) => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
    const hotelsAll = Object.keys(HOTEL_COMPANY).map(Number);
    for (const vendor of VENDOR_POOL) {
      // fan-out: each vendor subscribes to several hotels
      for (const hotel of r.sample(hotelsAll, r.int(2, 5))) {
        const row = await t.oneOrNone(
          `INSERT INTO tbl_vendor_hotel_category_subscription (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
           VALUES ($1, 'hotel', $2, 100, $3, $4, $5)
           ON CONFLICT DO NOTHING RETURNING id`,
          [vendor, hotel, dateOnly(-60), dateOnly(r.chance(0.8) ? 300 : -5), r.pick(["active", "active", "expired", "cancelled"])]
        );
        if (row) track.subs.push(row.id);
      }
      for (const cat of r.sample(categoryIds, Math.max(1, Math.ceil(categoryIds.length * 0.7)))) {
        const row = await t.oneOrNone(
          `INSERT INTO tbl_vendor_hotel_category_subscription (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
           VALUES ($1, 'category', $2, 100, $3, $4, $5)
           ON CONFLICT DO NOTHING RETURNING id`,
          [vendor, cat, dateOnly(-61), dateOnly(301), r.pick(["active", "active", "expired", "pending"])]
        );
        if (row) track.subs.push(row.id);
      }
      for (const vid of r.sample(variantIds, r.int(15, 40))) {
        const approved = r.chance(0.85);
        const active = r.chance(0.9);
        const row = await t.one(
          `INSERT INTO tbl_product_variant_vendor_mapping (product_variant_id, vendor_id, status, is_approved, created_at)
           VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [vid, vendor, active, approved]
        );
        track.pvvm.push(row.id);
        if (r.chance(0.1)) {
          // duplicate mapping row — nothing makes (variant, vendor) unique
          const dup = await t.one(
            `INSERT INTO tbl_product_variant_vendor_mapping (product_variant_id, vendor_id, status, is_approved, created_at)
             VALUES ($1, $2, TRUE, TRUE, now()) RETURNING id`,
            [vid, vendor]
          );
          track.pvvm.push(dup.id);
        }
      }
    }
    // a vendor-approve row so searchProduct's approved_by branch has a hit
    for (const v of variants.slice(0, 8)) {
      const row = await t.one(
        `INSERT INTO tbl_vendorapprove_product_mapping (product_id, vendor_approve_id) VALUES ($1, $2) RETURNING id`,
        [v.product_id, 1]
      );
      track.vendorApprove.push(row.id);
    }

    // ── RFQs ─────────────────────────────────────────────────────────────
    const hotelWeights = [IDS.hotels.A1, IDS.hotels.A1, IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2];
    const depts = [null, IDS.departments.proc, IDS.departments.proc, IDS.departments.eng, IDS.departments.fb];
    const kinds = ["draft", "draft0", "pending", "ready", "published", "published", "published", "published", "published", "closed", "withdrawn"];
    const creatorsA = [WORLD_USERS.wide, WORLD_USERS.hotel, WORLD_USERS.process, WORLD_USERS.dept, IDS.users.a1_proc_buyer];
    const creatorsB = [WORLD_USERS.wide, WORLD_USERS.hotelB, IDS.users.crossCompany];
    const approvers = [WORLD_USERS.approver, WORLD_USERS.wide, WORLD_USERS.process, WORLD_USERS.hotel, WORLD_USERS.dept, WORLD_USERS.hotelB];

    const base = Date.now();
    for (let i = 0; i < rfqCount; i++) {
      const hotel = r.pick(hotelWeights);
      const company = HOTEL_COMPANY[hotel];
      const isA = company === IDS.hospitality.A;
      const dept = r.pick(depts);
      const proc = isA ? r.pick([IDS.processes.A_P1, IDS.processes.A_P1, IDS.processes.A_P2, null]) : r.pick([IDS.processes.B_P1, null]);
      const createdBy = r.pick(isA ? creatorsA : creatorsB);
      const kind = r.pick(kinds);
      const status = { draft: 1, draft0: 0, pending: 3, ready: 4, published: 1, closed: 2, withdrawn: 5 }[kind];
      const isPublished = kind === "published" || kind === "closed" ? 1 : 0;
      // Distinct creation instants (list-view sorts on them), spread over ~20 months.
      const created = new Date(base - (i * 8.5 + r.next()) * 86400000 - i * 3600000);
      const bidPast = r.chance(0.6);
      const bid = i % 23 === 7 ? "" : naive(new Date(created.getTime() + (bidPast ? 5 : 400 + r.int(0, 60)) * 86400000 * (bidPast ? 1 : 1)));
      const isTender = r.chance(0.1) ? 1 : 0;
      const { rfq_id, rfq_no } = await makeRFQ(t, {
        createdBy, hospitality: company, hotel, department: dept, process: proc, status,
        is_published: isPublished, is_tender: isTender, bid_end_date: bid,
        title: `${r.pick(TITLES)} ${i}`, timestamp: created.toISOString(),
      });
      track.rfqs.push(rfq_id);

      const mapped = [hotel];
      if (r.chance(0.25)) {
        const sibling = r.pick(Object.keys(HOTEL_COMPANY).map(Number).filter((h) => HOTEL_COMPANY[h] === company && h !== hotel));
        if (sibling) mapped.push(sibling);
      }
      for (const h of mapped) {
        await t.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, createdBy]);
      }

      // products (variant 1/2 of the same product_variant exercises the
      // (variant_id, variant) join keys)
      const products = [];
      for (const vid of r.sample(variantIds, r.int(1, 4))) {
        const variantNo = r.chance(0.15) ? 2 : 1;
        const row = await t.one(
          `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
           VALUES ($1, '', '0', '', '', $2, $3) RETURNING id`,
          [rfq_id, vid, variantNo]
        );
        products.push({ id: row.id, vid, variant: variantNo });
        if (r.chance(0.5)) {
          await t.none(
            `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, variant, title, value) VALUES ($1, $2, $3, 'Size', $4)`,
            [rfq_id, vid, variantNo, `${r.int(1, 9)} L`]
          );
        }
      }

      // invitations
      const invited = new Map(); // product.id -> [vendor]
      if (kind !== "draft0" || r.chance(0.5)) {
        for (const p of products) {
          const vs = r.sample(VENDOR_POOL, r.int(1, 5));
          invited.set(p.id, vs);
          for (const v of vs) {
            await t.none(
              `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, user_id, is_rfq_viewed) VALUES ($1, $2, $3, $4, 0)`,
              [rfq_id, p.vid, p.variant, v]
            );
          }
        }
      }

      if (!isPublished) {
        if (kind === "pending" || kind === "ready") {
          const appr = r.sample(approvers, r.int(1, 2));
          const inst = await makeInstance(t, {
            entity_type: "RFQ", entity_id: rfq_id, policy: IDS.policies.A1_P1_RFQ, company, hotel, dept, proc,
            initiated_by: createdBy, approvers: appr, metadata: {},
          });
          track.instances.push(inst);
        }
        continue;
      }

      // quotes
      const vendorsOnRfq = [...new Set([...invited.values()].flat())];
      const quoteByVendor = new Map();
      for (const v of vendorsOnRfq) {
        const roll = r.next();
        if (roll < 0.25) continue; // never responded
        const regret = roll > 0.85 ? 1 : 0;
        const q = await t.one(
          `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, is_regret, "timestamp")
           VALUES ($1, $2, $3, $3, 1, $4, $5) RETURNING id`,
          [rfq_id, rfq_no, v, regret, naive(new Date(created.getTime() + 86400000 + r.int(0, 20) * 3600000))]
        );
        track.quotes.push(q.id);
        quoteByVendor.set(v, { id: q.id, regret });
        if (regret) continue;
        for (const p of products) {
          if (!(invited.get(p.id) || []).includes(v)) continue;
          const shape = r.next();
          const price = shape < 0.1 ? 0 : r.int(50, 900) + r.int(0, 99) / 100;
          const comment = shape < 0.05 ? "rate on request" : "";
          await t.none(
            `INSERT INTO tbl_quote_items (rfq_id, rfq_no, quote_id, product_variant_id, variant, unit_price, total_price, comment, delivery_period, quantity)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $7, '', '1')`,
            [rfq_id, rfq_no, q.id, p.vid, p.variant, price, comment]
          );
        }
      }

      // tech evaluation on some products
      for (const p of products) {
        const te = r.next();
        if (te > 0.35) continue;
        const stuck = te < 0.08;
        const complete = te >= 0.08 && te < 0.18;
        const ev = await t.one(
          `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, is_complete, current_round, blocked_insufficient_vendors, total_passed_verified)
           VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
          [rfq_id, p.id, complete, stuck, stuck ? 0 : r.int(0, 2)]
        );
        const clauses = [];
        for (let c = 0; c < r.int(1, 3); c++) {
          const cl = await t.one(
            `INSERT INTO tbl_rfq_product_tech_evaluation_clauses (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
             VALUES ($1, $2, 10, $3) RETURNING id`,
            [ev.id, `Clause ${c}`, c === 2 ? "sampling" : "clause"]
          );
          clauses.push(cl.id);
        }
        if (complete) {
          for (const v of (invited.get(p.id) || []).slice(0, 2)) {
            await t.none(
              `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors (tbl_rfq_product_tech_evaluation_id, vendor_id, status) VALUES ($1, $2, 1)`,
              [ev.id, v]
            );
          }
        } else if (!stuck && r.chance(0.5)) {
          // partial answers only — keeps some products unstartable
          const v = (invited.get(p.id) || [])[0];
          if (v) {
            await t.none(
              `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response)
               VALUES ($1, $2, $3)`,
              [clauses[0], v, r.pick(["agree", "", "N/A"])]
            );
          }
        }
      }

      // finalisation + POs
      const finalizedVendor = new Map();
      for (const p of products) {
        const candidates = (invited.get(p.id) || []).filter((v) => quoteByVendor.has(v) && !quoteByVendor.get(v).regret);
        if (!candidates.length || r.chance(0.35)) continue;
        const v = r.pick(candidates);
        finalizedVendor.set(p.id, v);
        await t.none(
          `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, variant, vendor_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [rfq_id, rfq_no, quoteByVendor.get(v).id, p.vid, p.variant, v, createdBy]
        );
      }
      // group finalized products by vendor -> one PO per vendor (multi-line when >1)
      const byVendor = new Map();
      for (const [pid, v] of finalizedVendor) {
        if (!byVendor.has(v)) byVendor.set(v, []);
        byVendor.get(v).push(products.find((p) => p.id === pid));
      }
      for (const [v, lines] of byVendor) {
        if (r.chance(0.3)) continue; // finalized, PO not yet raised (AWAITING_PO)
        const poStatus = r.pick(PO_STATUSES);
        const po = await makeMultiLinePO(t, { rfq_id, lines, vendor: v, status: poStatus, createdBy, r, created });
        track.pos.push(po.po_id);
        if (poStatus === "pending_approval") {
          const inst = await makeInstance(t, {
            entity_type: "PO", entity_id: po.po_id, policy: IDS.policies.A1_P1_PO, company, hotel, dept, proc,
            initiated_by: createdBy, approvers: r.sample(approvers, r.int(1, 2)), metadata: { rfq_id },
          });
          track.instances.push(inst);
          await t.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`, [inst, po.po_id]);
        }
        if (poStatus === "rejected" || poStatus === "rejected_by_vendor") {
          // A rejection de-finalises its products; sometimes the product is
          // re-awarded to another vendor with a live replacement PO.
          for (const line of lines) {
            if (r.chance(0.7)) {
              await t.none(
                `DELETE FROM tbl_quote_finalization WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
                [rfq_id, line.vid, line.variant]
              );
            }
          }
          if (r.chance(0.4)) {
            const other = VENDOR_POOL.find((x) => x !== v && quoteByVendor.has(x) && !quoteByVendor.get(x).regret);
            if (other) {
              const repl = await makeMultiLinePO(t, { rfq_id, lines: [lines[0]], vendor: other, status: r.pick(["approved", "pending_approval"]), createdBy, r, created });
              track.pos.push(repl.po_id);
            }
          }
        }
      }

      // lifecycle-driving approval instances
      if (r.chance(0.15)) {
        track.instances.push(await makeInstance(t, {
          entity_type: "TECHNICAL", entity_id: rfq_id, policy: IDS.policies.A1_P1_TECHNICAL, company, hotel, dept, proc,
          initiated_by: createdBy, approvers: r.sample(approvers, 1), metadata: { rfq_id },
        }));
      }
      if (r.chance(0.15)) {
        track.instances.push(await makeInstance(t, {
          entity_type: "NEGOTIATION_QUOTE", entity_id: rfq_id, policy: IDS.policies.A1_P1_NEGOTIATION_QUOTE, company, hotel, dept, proc,
          initiated_by: createdBy, approvers: r.sample(approvers, 2), metadata: { rfq_id },
        }));
      }

      // vendor query messages (some read by the creator / wide user)
      if (vendorsOnRfq.length && r.chance(0.4)) {
        for (let m = 0; m < r.int(1, 3); m++) {
          const msg = await t.one(
            `INSERT INTO tbl_query_messages (rfq_id, sender_id, receiver_id, sender_type, message_text) VALUES ($1, $2, $3, 3, 'question') RETURNING id`,
            [rfq_id, r.pick(vendorsOnRfq), createdBy]
          );
          if (r.chance(0.4)) {
            await t.none(`INSERT INTO tbl_query_message_reads (message_id, user_id) VALUES ($1, $2)`, [msg.id, r.pick([createdBy, WORLD_USERS.wide])]);
          }
        }
      }
      if (r.chance(0.1) && vendorsOnRfq.length) {
        const c = await t.one(
          `INSERT INTO tbl_rfq_clarifications (rfq_id, raised_by, subject, question, status) VALUES ($1, $2, 'Spec', 'Which size?', 'OPEN') RETURNING id`,
          [rfq_id, vendorsOnRfq[0]]
        );
        track.clarifications.push(c.id);
      }
      if (r.chance(0.12)) {
        await t.none(
          `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, end_date, status, created_by, source_type, source_id)
           VALUES ($1, 1, (now() AT TIME ZONE 'UTC') - interval '2 days', 'ACTIVE', $2, 'RFQ', $1)`,
          [rfq_id, createdBy]
        );
      }
    }
  });

  return {
    users: WORLD_USERS,
    vendors: WORLD_VENDORS,
    rfqIds: track.rfqs,
    cleanup: () => cleanupPerfWorld(db, track),
  };
}

async function makeInstance(t, { entity_type, entity_id, policy, company, hotel, dept, proc, initiated_by, approvers, metadata }) {
  const inst = await t.one(
    `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id, department_id, process_id, initiated_by, metadata)
     VALUES ($1, $2, $3, 'PENDING', 1, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [entity_type, entity_id, policy, company, hotel, dept, proc, initiated_by, JSON.stringify(metadata || {})]
  );
  const step = await t.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status, decision_rule) VALUES ($1, 1, 'PENDING', 'ANY') RETURNING id`,
    [inst.id]
  );
  for (const a of approvers) {
    await t.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status) VALUES ($1, $2, 'PENDING')`,
      [step.id, a]
    );
  }
  return inst.id;
}

async function makeMultiLinePO(t, { rfq_id, lines, vendor, status, createdBy, r, created }) {
  const unit = r.int(80, 700);
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id, total_value, quote_id, initiated_by, created_at, vendor_rejection_reason, vendor_action_at)
     VALUES ($1, $2, $3, $4, $5::int[], $6, $7, $8, $9, ARRAY[]::int[], $10, $11, $12, $13)
     RETURNING id`,
    [
      rfq_id, IDS.companies.A, `WPO-${rfq_id}-${vendor}-${r.int(1, 1e6)}`, status, lines.map((l) => l.id),
      lines.length, unit, vendor, unit * lines.length, createdBy,
      new Date(created.getTime() + 3 * 86400000 + r.int(0, 40) * 86400000).toISOString(),
      status === "rejected_by_vendor" ? "price changed" : null,
      status === "rejected_by_vendor" ? naive(new Date(created.getTime() + 4 * 86400000)) : null,
    ]
  );
  for (const l of lines) {
    const qty = r.int(1, 20);
    const price = r.int(50, 900);
    await t.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, product_variant_id)
       VALUES ($1, $2, 0, $3, 'units', $4, $5, $6)`,
      [po.id, l.id, qty, price, qty * price, l.vid]
    );
  }
  return { po_id: po.id };
}

export async function cleanupPerfWorld(db, track) {
  const rfqs = track.rfqs;
  await db.tx(async (t) => {
    if (rfqs.length) {
      await t.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1))`, [rfqs]);
      await t.none(`DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1)`, [rfqs]);
    }
    if (track.instances.length) await t.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1)`, [track.instances]);
    if (rfqs.length) {
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
           SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id WHERE te.rfq_id = ANY($1))`,
        [rfqs]
      );
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1))`,
        [rfqs]
      );
      await t.none(
        `DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1))`,
        [rfqs]
      );
      await t.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1)`, [rfqs]);
      await t.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfqs]);
      // query messages, hotel mappings and negotiation rounds cascade from tbl_rfq
      await t.none(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, [rfqs]);
    }
    if (track.vendorApprove.length) await t.none(`DELETE FROM tbl_vendorapprove_product_mapping WHERE id = ANY($1)`, [track.vendorApprove]);
    if (track.pvvm.length) await t.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1)`, [track.pvvm]);
    if (track.subs.length) await t.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1)`, [track.subs]);
    if (track.scopes.length) await t.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1)`, [track.scopes]);
    if (track.hum.length) await t.none(`DELETE FROM tbl_hospitality_user_mappings WHERE id = ANY($1)`, [track.hum]);
    if (track.users.length) {
      await t.none(`DELETE FROM tbl_query_message_reads WHERE user_id = ANY($1)`, [track.users]);
      await t.none(`DELETE FROM tbl_users WHERE id = ANY($1)`, [track.users]);
    }
  });
}
