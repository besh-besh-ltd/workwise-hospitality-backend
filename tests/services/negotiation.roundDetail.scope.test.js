// negotiation.roundDetail.scope.test.js — MERGE GATE for the round-detail API.
//
// GET /api/v1/negotiation/rounds/:id/detail is a price-and-vendor surface. The
// negotiation module already shipped one cross-tenant leak (see
// negotiation.listView.scope.test.js); this suite is the standing proof that
// the new endpoint cannot repeat it.
//
// Enforced here:
//   1. The 4-axis RBAC read matrix (company x hotel x department x process,
//      gated on permission negotiation.read) decides access — a caller outside
//      any axis is refused, and refused BEFORE any state/visibility check so an
//      id probe reveals nothing.
//   2. A role that lacks negotiation.read is refused even inside its own hotel.
//   3. user_type 8 (super admin) bypasses the matrix.
//   4. An unknown id is indistinguishable from an out-of-scope id.
//   5. Quote-visibility lock (IST bid_end_date not yet passed) strips EVERY
//      price field and all totals from the payload — while keeping round
//      metadata, targets and vendor names, which the listing already shows.
//   6. scope=cycle re-applies the scope predicate to each sibling round rather
//      than trusting "siblings share a parent" — an out-of-scope sibling is
//      excluded from the lines AND from the aggregates.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const ENG = IDS.departments.eng;

const ROLE_NEG_READ = 8; // Commercial Negotiator N1 — carries negotiation.read
const ROLE_NO_NEG = 2; // Tender Creator — deliberately has NO negotiation.*

const U_A1_PROC = 80941; // (HC_A, A1, PROC)
const U_A1_ALL = 80942; // (HC_A, A1, any dept)
const U_B = 80943; // (HC_B, B1, any dept)
const U_NOPERM = 80944; // (HC_A, A1, any dept) but role without negotiation.read
const U_SUPER = 80945; // user_type 8

const VA = IDS.users.vendor_alpha;
const V1 = 1;

const PAST_BID_END = new Date(Date.now() - 3 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);
const FUTURE_BID_END = new Date(Date.now() + 3 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

const D = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const CELLS = {
  A1_PROC: { hc: HC_A, hotel: A1, dept: PROC },
  A1_ENG: { hc: HC_A, hotel: A1, dept: ENG },
  A2_PROC: { hc: HC_A, hotel: A2, dept: PROC },
  B1_PROC: { hc: HC_B, hotel: B1, dept: PROC },
};

const rfqIds = {};
const rfqNos = {};
const rpIds = {};
const roundIds = {};
let lockedRfqId, lockedRpId, lockedRoundId;
let siblingInScopeRoundId, siblingOutOfScopeRoundId;
const quoteIds = [];

async function makeUser(userId, name, { roleId, scopes, hotelForMapping }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negdetailscope.${userId}@test.local`, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, scopes[0].hc, hotelForMapping ?? scopes[0].hotel, IDS.users.superAdmin]
  );
  for (const s of scopes) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, roleId, s.hc, s.hotel, s.dept]
    );
  }
}

async function seedProduct(rfqId, rfqNo, vendorId) {
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, 0, 'scope line', '0', '0') RETURNING id`,
    [rfqId, V1]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
     VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
    [rfqId, rfqNo, vendorId]
  );
  quoteIds.push(Number(q.id));
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, product_name,
        unit_price, package_price, tax, freight_price, total_price, quantity, tax_mode,
        comment, delivery_period)
     VALUES ($1, $2, $3, $4, 0, 'scope product', 100, 0, 18, 0, 1180, '10', 'percentage', '', '7')`,
    [rfqId, rfqNo, q.id, V1]
  );
  return Number(rp.id);
}

async function seedRound(rfqId, sourceId, rfqProductId, roundNumber, vendorId, target) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, vendor_ids, vendor_approvals, created_by, created_at)
     VALUES ($1, 'RFQ', $2, $3, $4, 'ENDED', $5, $6::int[], $7::jsonb, $8, now())
     RETURNING id`,
    [
      rfqId,
      sourceId,
      rfqProductId,
      roundNumber,
      D(5),
      [vendorId],
      JSON.stringify([
        {
          vendor_id: vendorId,
          status: "PENDING",
          remarks: null,
          acted_by: null,
          acted_at: null,
          negotiation_fields: [{ name: "base_price", target: String(target) }],
        },
      ]),
      IDS.users.superAdmin,
    ]
  );
  return Number(row.id);
}

// Recursively collect every key name and every scalar in a JSON payload.
function walk(node, keys, scalars) {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, keys, scalars));
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      keys.add(k);
      walk(v, keys, scalars);
    }
    return;
  }
  scalars.add(String(node));
}

describe("Negotiation round detail — RBAC scope, visibility lock, sibling defence", () => {
  let clientA1Proc, clientA1All, clientB, clientNoPerm, clientSuper, anonClient;

  beforeAll(async () => {
    await makeUser(U_A1_PROC, "RD Scope A1/Proc", {
      roleId: ROLE_NEG_READ,
      scopes: [{ hc: HC_A, hotel: A1, dept: PROC }],
    });
    await makeUser(U_A1_ALL, "RD Scope A1/All", {
      roleId: ROLE_NEG_READ,
      scopes: [{ hc: HC_A, hotel: A1, dept: null }],
    });
    await makeUser(U_B, "RD Scope B", {
      roleId: ROLE_NEG_READ,
      scopes: [{ hc: HC_B, hotel: B1, dept: null }],
    });
    await makeUser(U_NOPERM, "RD Scope No Permission", {
      roleId: ROLE_NO_NEG,
      scopes: [{ hc: HC_A, hotel: A1, dept: null }],
    });
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, created_at, updated_at)
       VALUES ($1, 'RD Scope Super', 'negdetailscope.super@test.local', 1, 8, now(), now())
       ON CONFLICT (id) DO UPDATE SET user_type = 8, status = 1`,
      [U_SUPER]
    );

    for (const [key, cell] of Object.entries(CELLS)) {
      const { rfq_id, rfq_no } = await makeRFQ(db, {
        createdBy: IDS.users.superAdmin,
        hospitality: cell.hc,
        hotel: cell.hotel,
        department: cell.dept,
        bid_end_date: PAST_BID_END,
        title: `RDSCOPE-${key}`,
      });
      rfqIds[key] = Number(rfq_id);
      rfqNos[key] = Number(rfq_no);
      rpIds[key] = await seedProduct(rfqIds[key], rfqNos[key], VA);
      roundIds[key] = await seedRound(rfqIds[key], rfqIds[key], rpIds[key], 1, VA, 90);
    }

    // ── Locked-visibility RFQ (bid_end_date still in the future) ─────────────
    const locked = await makeRFQ(db, {
      createdBy: IDS.users.superAdmin,
      hospitality: HC_A,
      hotel: A1,
      department: PROC,
      bid_end_date: FUTURE_BID_END,
      title: "RDSCOPE-LOCKED",
    });
    lockedRfqId = Number(locked.rfq_id);
    lockedRpId = await seedProduct(lockedRfqId, Number(locked.rfq_no), VA);
    lockedRoundId = await seedRound(lockedRfqId, lockedRfqId, lockedRpId, 1, VA, 90);
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at, created_at)
       VALUES ($1, $2, $3, 1062, 1180, now(), now())`,
      [lockedRoundId, VA, lockedRpId]
    );

    // ── Cycle sibling pair sharing (source_type, source_id, round_number) ────
    // Both claim source_id = the A1/PROC RFQ, but the second one's OWN parent
    // (nr.rfq_id) is the out-of-scope B1 RFQ. A naive "siblings share a parent"
    // expansion would leak it.
    siblingInScopeRoundId = await seedRound(rfqIds.A1_PROC, rfqIds.A1_PROC, rpIds.A1_PROC, 7, VA, 80);
    siblingOutOfScopeRoundId = await seedRound(rfqIds.B1_PROC, rfqIds.A1_PROC, rpIds.B1_PROC, 7, VA, 70);
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at, created_at)
       VALUES ($1, $2, $3, 1000, 1180, now(), now()),
              ($4, $5, $6, 900, 1180, now(), now())`,
      [siblingInScopeRoundId, VA, rpIds.A1_PROC, siblingOutOfScopeRoundId, VA, rpIds.B1_PROC]
    );

    clientA1Proc = await httpClient(U_A1_PROC);
    clientA1All = await httpClient(U_A1_ALL);
    clientB = await httpClient(U_B);
    clientNoPerm = await httpClient(U_NOPERM);
    clientSuper = await httpClient(U_SUPER);
    anonClient = await httpClient(null);
  });

  afterAll(async () => {
    const allRounds = [
      ...Object.values(roundIds),
      lockedRoundId,
      siblingInScopeRoundId,
      siblingOutOfScopeRoundId,
    ].filter(Boolean);
    if (allRounds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [allRounds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [allRounds]);
    }
    if (quoteIds.length) {
      await db.none(
        `DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (
           SELECT id FROM tbl_quote_items WHERE quote_id = ANY($1::int[]))`,
        [quoteIds]
      );
      await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [quoteIds]);
      await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [quoteIds]);
    }
    const allRfqs = [...Object.values(rfqIds), lockedRfqId].filter(Boolean);
    if (allRfqs.length) {
      await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [allRfqs]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [allRfqs]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [allRfqs]);
    }
    const users = [U_A1_PROC, U_A1_ALL, U_B, U_NOPERM, U_SUPER];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
  });

  const detail = (client, roundId, qs = "") =>
    client.get(`/api/v1/negotiation/rounds/${roundId}/detail${qs}`);

  test("in-scope caller reads their own round", async () => {
    const res = await detail(clientA1Proc, roundIds.A1_PROC);
    expect(res.status).toBe(200);
    expect(res.body.data.round.round_id).toBe(roundIds.A1_PROC);
  });

  test("cross-hotel read is refused (A1 caller, A2 round)", async () => {
    const res = await detail(clientA1Proc, roundIds.A2_PROC);
    expect([403, 404]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });

  test("cross-department read is refused (A1/Proc caller, A1/Eng round)", async () => {
    const res = await detail(clientA1Proc, roundIds.A1_ENG);
    expect([403, 404]).toContain(res.status);
    expect(res.body.data).toBeUndefined();

    // ...and the dept-agnostic user at the same hotel CAN read it, proving the
    // refusal above is the department axis and not a blanket denial.
    const ok = await detail(clientA1All, roundIds.A1_ENG);
    expect(ok.status).toBe(200);
  });

  test("cross-company read is refused (company B caller, company A round)", async () => {
    const res = await detail(clientB, roundIds.A1_PROC);
    expect([403, 404]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });

  test("a role without negotiation.read is refused inside its own hotel", async () => {
    const res = await detail(clientNoPerm, roundIds.A1_PROC);
    expect([403, 404]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });

  test("user_type 8 bypasses the matrix", async () => {
    for (const key of Object.keys(CELLS)) {
      const res = await detail(clientSuper, roundIds[key]);
      expect(res.status).toBe(200);
      expect(res.body.data.round.round_id).toBe(roundIds[key]);
    }
  });

  test("an unknown id is indistinguishable from an out-of-scope id", async () => {
    const unknown = await detail(clientA1Proc, 999999999);
    expect([403, 404]).toContain(unknown.status);
    expect(unknown.body.data).toBeUndefined();
  });

  test("unauthenticated callers are rejected", async () => {
    const res = await detail(anonClient, roundIds.A1_PROC);
    expect([401, 403]).toContain(res.status);
  });

  test("locked quote visibility strips every price field and all totals", async () => {
    const res = await detail(clientA1All, lockedRoundId);
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d.quote_visibility.locked).toBe(true);
    expect(d.prices_hidden).toBe(true);

    // Metadata and targets survive.
    expect(d.round.round_id).toBe(lockedRoundId);
    expect(d.parent.rfq_id).toBe(lockedRfqId);
    expect(d.lines).toHaveLength(1);
    expect(Number(d.lines[0].target_unit)).toBeCloseTo(90, 4);
    // Vendor identity stays visible — the listing already shows it pre-deadline.
    expect(Number(d.lines[0].vendor_id)).toBe(VA);
    expect(typeof d.lines[0].vendor_name).toBe("string");

    // Aggregates are gone entirely.
    expect(d.totals).toBeNull();
    expect(d.cumulative).toBeNull();

    // Nothing anywhere in the body may carry a price key or a seeded price value.
    const keys = new Set();
    const scalars = new Set();
    walk(res.body, keys, scalars);

    const BANNED_KEYS = [
      "baseline_line_total",
      "baseline_unit",
      "achieved_line_total",
      "achieved_unit",
      "target_line_total",
      "saved_value",
      "saved_pct",
      "achieved_pct",
      "baseline_total",
      "achieved_total",
      "target_total",
      "quoted_price",
      "previous_price",
      "unit_price",
      "total_price",
      "attainment_pct",
    ];
    for (const k of BANNED_KEYS) {
      expect(Array.from(keys)).not.toContain(k);
    }
    for (const v of ["1062", "1180", "1062.00", "1180.00", "118"]) {
      expect(Array.from(scalars)).not.toContain(v);
    }
  });

  test("scope=cycle re-applies the scope predicate to sibling rounds", async () => {
    const res = await detail(clientA1All, siblingInScopeRoundId, "?scope=cycle");
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d.cycle.sibling_round_ids).toContain(siblingInScopeRoundId);
    expect(d.cycle.sibling_round_ids).not.toContain(siblingOutOfScopeRoundId);
    expect(d.cycle.excluded_sibling_count).toBe(1);

    // The out-of-scope sibling contributes no line...
    expect(d.lines.map((l) => Number(l.round_id))).not.toContain(siblingOutOfScopeRoundId);
    expect(d.lines).toHaveLength(1);
    // ...and no money: only the in-scope 1180 → 1000 leg is counted.
    expect(Number(d.totals.achieved_total)).toBeCloseTo(1000, 2);
    expect(Number(d.totals.saved_value)).toBeCloseTo(180, 2);

    // A super admin, who legitimately sees both, gets both.
    const superRes = await detail(clientSuper, siblingInScopeRoundId, "?scope=cycle");
    expect(superRes.status).toBe(200);
    expect(superRes.body.data.cycle.sibling_round_ids).toContain(siblingOutOfScopeRoundId);
    expect(superRes.body.data.cycle.excluded_sibling_count).toBe(0);
    expect(Number(superRes.body.data.totals.achieved_total)).toBeCloseTo(1900, 2);
  });
});
