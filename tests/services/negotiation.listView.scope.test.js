// negotiation.listView.scope.test.js — P0 cross-hotel leak + price IDOR.
//
// PROVES THE SECURITY MANDATE for the negotiation module:
//
//   1. POST /api/v1/negotiation/list-view scopes rows to the caller's strict
//      per-row RBAC matrix (company × hotel × department × process) read from
//      tbl_user_role_scopes joined to negotiation.read — NOT merely to the
//      caller's hospitality company. A user mapped to one hotel must never see
//      another hotel's negotiation rounds, vendor identities or prices.
//   2. The derived surfaces (facets.buId, tab_counts, total) inherit the same
//      scope, because they are computed from the same scoped row set.
//   3. Client-side filters can NARROW within the matrix but can never WIDEN it.
//   4. The two detail endpoints — GET /rounds/:rfq_id and
//      GET /rounds/:id/quotes — enforce the same scope (they previously had no
//      tenant check at all: any authenticated buyer could read any round's
//      vendors, emails and negotiated prices by guessing an id).
//   5. The vendor no-login token path into GET /rounds/:rfq_id still works —
//      vendors legitimately reach that route from an email link.
//
// Fixtures: a grid of RFQ negotiation rounds across (hotel × department) cells
// under hospitality A, one under hospitality B, plus one ARC negotiation round
// (the ARC branch of the union has the identical leak), and purpose-built
// scoped users so off-diagonal cells are directly observable.
//
// NOTE ON PERMISSIONS: the read matrix keys off permission negotiation.read.
// The shared fixture role TENDER_CREATOR (role 2) does NOT carry it (true in
// production too), so the scoped users below are granted role 8 (Commercial
// Negotiator N1), which does.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const A3 = IDS.hotels.A3;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const ENG = IDS.departments.eng;
const PROCESS = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

// Role 8 = Commercial Negotiator N1 — carries permission negotiation.read.
const ROLE_NEG_READ = 8;

// Purpose-built users (range 80901+ to avoid clashing with shared fixtures).
const U_A1 = 80901;       // hotel-scoped: (HC_A, A1, all depts)
const U_COMPANY = 80902;  // company-wide: (HC_A, all hotels, all depts)
const U_OFFDIAG = 80903;  // (HC_A, A1, PROC) + (HC_A, A2, ENG)
const U_SUPER = 80904;    // user_type 8 — unrestricted, exercises the NULL path
const U_VENDOR = 80905;   // vendor (user_type 3) for the no-login token path

const VENDOR_TOKEN = 991122334455;

const PFX = "NEGSCOPE-";
const D = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
// Past bid_end_date so getRoundQuotes is not 423-locked by quote visibility.
const PAST_BID_END = new Date(Date.now() - 2 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

// Seeded RFQ grid: key → { hc, hotel, dept }
const RFQ_GRID = {
  A1_PROC: { hc: HC_A, hotel: A1, dept: PROC },
  A1_ENG: { hc: HC_A, hotel: A1, dept: ENG },
  A2_PROC: { hc: HC_A, hotel: A2, dept: PROC },
  A2_ENG: { hc: HC_A, hotel: A2, dept: ENG },
  A3_PROC: { hc: HC_A, hotel: A3, dept: PROC },
  B1_PROC: { hc: HC_B, hotel: B1, dept: PROC },
};

const rfqIds = {};   // key → rfq id
const rfqNos = {};   // key → rfq_no
const roundIds = {}; // key → negotiation round id
let arcId, arcItemId, arcRoundId; // ARC at (HC_A, A2, ENG)

async function makeScopedUser(userId, name, { company, mappings, scopes }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negscope.${userId}@test.local`, company]
  );
  for (const m of mappings) {
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings
         (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
      [userId, m.hc, m.hotel, m.hotel == null ? 0 : 1, IDS.users.superAdmin]
    );
  }
  for (const s of scopes) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, ROLE_NEG_READ, s.hc, s.hotel, s.dept]
    );
  }
}

describe("Negotiation scope — list-view RBAC matrix + detail-endpoint IDOR", () => {
  let clientA1, clientCompany, clientOffdiag, anonClient;

  beforeAll(async () => {
    // ── Users ────────────────────────────────────────────────────────────────
    await makeScopedUser(U_A1, "NegScope A1 User", {
      company: IDS.companies.A,
      mappings: [{ hc: HC_A, hotel: A1 }],
      scopes: [{ hc: HC_A, hotel: A1, dept: null }],
    });
    await makeScopedUser(U_COMPANY, "NegScope Company A User", {
      company: IDS.companies.A,
      mappings: [{ hc: HC_A, hotel: null }],
      scopes: [{ hc: HC_A, hotel: null, dept: null }],
    });
    await makeScopedUser(U_OFFDIAG, "NegScope Off-Diagonal User", {
      company: IDS.companies.A,
      mappings: [{ hc: HC_A, hotel: A1 }, { hc: HC_A, hotel: A2 }],
      scopes: [
        { hc: HC_A, hotel: A1, dept: PROC },
        { hc: HC_A, hotel: A2, dept: ENG },
      ],
    });
    // Dedicated super admin (own row, so shared fixtures stay untouched).
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, created_at, updated_at)
       VALUES ($1, 'NegScope Super Admin', 'negscope.super@test.local', 1, 8, now(), now())
       ON CONFLICT (id) DO UPDATE SET user_type = 8, status = 1`,
      [U_SUPER]
    );
    // Vendor user for the no-login token path (no scopes, no mappings).
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
       VALUES ($1, 'NegScope Vendor', 'negscope.vendor@test.local', 1, 3, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET user_type = 3, status = 1`,
      [U_VENDOR, IDS.companies.vendorAlpha]
    );

    // ── RFQ grid + one ACTIVE round each ─────────────────────────────────────
    for (const [key, cell] of Object.entries(RFQ_GRID)) {
      const { rfq_id, rfq_no } = await makeRFQ(db, {
        createdBy: IDS.users.superAdmin,
        hospitality: cell.hc,
        hotel: cell.hotel,
        department: cell.dept,
        process: PROCESS,
        bid_end_date: PAST_BID_END,
        title: `${PFX}${key}`,
      });
      rfqIds[key] = Number(rfq_id);
      rfqNos[key] = Number(rfq_no);

      const round = await db.one(
        `INSERT INTO tbl_negotiation_rounds
           (rfq_id, source_type, source_id, round_number, status, end_date, vendor_ids, created_by)
         VALUES ($1, 'RFQ', $1, 1, 'ACTIVE', $2, $3::int[], $4)
         RETURNING id`,
        [rfqIds[key], D(7), [U_VENDOR], IDS.users.superAdmin]
      );
      roundIds[key] = Number(round.id);
    }

    // ── ARC at (HC_A, A2, ENG) + one ACTIVE ARC negotiation round ────────────
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $8, 'open')
       RETURNING id`,
      [`${PFX}ARC-A2-ENG`, `${PFX}ARC A2 Eng`, CATEGORY, HC_A, A2, ENG, PROCESS, IDS.users.superAdmin]
    );
    arcId = Number(arc.id);

    const arcItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 10, 'kg')
       RETURNING id`,
      [arcId, VARIANT_ID]
    );
    arcItemId = Number(arcItem.id);

    const arcRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, vendor_ids, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'ACTIVE', $3, $4::int[], $5)
       RETURNING id`,
      [arcId, arcItemId, D(7), [U_VENDOR], IDS.users.superAdmin]
    );
    arcRoundId = Number(arcRound.id);

    // ── Vendor no-login token pointing at the A2 RFQ ─────────────────────────
    await db.none(
      `INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no)
       VALUES ($1, $2, $3)`,
      [VENDOR_TOKEN, U_VENDOR, rfqNos.A2_PROC]
    );

    clientA1 = await httpClient(U_A1);
    clientCompany = await httpClient(U_COMPANY);
    clientOffdiag = await httpClient(U_OFFDIAG);
    anonClient = await httpClient(null);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE token = $1`, [VENDOR_TOKEN]);
    const allRounds = [...Object.values(roundIds), arcRoundId].filter(Boolean);
    if (allRounds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [allRounds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [allRounds]);
    }
    if (arcItemId) await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [arcItemId]);
    if (arcId) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    }
    const allRfqs = Object.values(rfqIds).filter(Boolean);
    if (allRfqs.length) {
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [allRfqs]);
    }
    const tempUsers = [U_A1, U_COMPANY, U_OFFDIAG, U_SUPER, U_VENDOR];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [tempUsers]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [tempUsers]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [tempUsers]);
  });

  // groupBy defaults to 'parent' (one row per RFQ/ARC). This suite asserts on
  // round_id, so it pins the ROUND grain explicitly — and in doing so acts as
  // the regression guard that groupBy:'round' is unchanged.
  const listView = (client, body = {}) =>
    client.post("/api/v1/negotiation/list-view").send({ limit: 200, groupBy: "round", ...body });

  const idsOf = (res) => res.body.data.rows.map((r) => Number(r.round_id));
  const facetKeys = (res, name) => (res.body.data.facets[name] || []).map((f) => String(f.key));

  // ── CASE 1 — hotel-scoped user sees ONLY their hotel's rounds ─────────────
  test("CASE 1 — user scoped to hotel A1 sees only A1 rounds, never A2/A3/B1", async () => {
    const res = await listView(clientA1);
    expect(res.status).toBe(200);
    const ids = idsOf(res);

    // In scope: both departments at A1 (scope row has department_id NULL).
    expect(ids).toContain(roundIds.A1_PROC);
    expect(ids).toContain(roundIds.A1_ENG);

    // Out of scope — the leak.
    expect(ids).not.toContain(roundIds.A2_PROC);
    expect(ids).not.toContain(roundIds.A2_ENG);
    expect(ids).not.toContain(roundIds.A3_PROC);
    expect(ids).not.toContain(roundIds.B1_PROC);
    expect(ids).not.toContain(arcRoundId); // ARC branch is scoped too

    // No returned row may belong to a hotel outside the grant.
    for (const r of res.body.data.rows) {
      expect(Number(r.hotel_id)).toBe(A1);
    }
  });

  // ── CASE 2 — the buId facet (the surface the client complained about) ─────
  test("CASE 2 — buId facet for the A1-scoped user contains ONLY A1", async () => {
    const res = await listView(clientA1);
    expect(res.status).toBe(200);
    const buIds = facetKeys(res, "buId");
    expect(buIds).toContain(String(A1));
    expect(buIds).not.toContain(String(A2));
    expect(buIds).not.toContain(String(A3));
    expect(buIds).not.toContain(String(B1));
    expect(new Set(buIds)).toEqual(new Set([String(A1)]));

    // tab_counts / total are derived from the same scoped set.
    expect(res.body.data.tab_counts.all).toBe(res.body.data.rows.length);
    expect(res.body.data.total).toBe(res.body.data.rows.length);
    expect(res.body.data.source_counts.all).toBe(
      res.body.data.source_counts.RFQ + res.body.data.source_counts.ARC
    );
  });

  // ── CASE 3 — company-wide scope (hotel_id IS NULL) sees all A hotels ──────
  test("CASE 3 — company-wide user sees every hotel under company A, with no company-B bleed", async () => {
    const res = await listView(clientCompany);
    expect(res.status).toBe(200);
    const ids = idsOf(res);

    for (const key of ["A1_PROC", "A1_ENG", "A2_PROC", "A2_ENG", "A3_PROC"]) {
      expect(ids).toContain(roundIds[key]);
    }
    expect(ids).toContain(arcRoundId);

    // Company B must not bleed through.
    expect(ids).not.toContain(roundIds.B1_PROC);
    const buIds = facetKeys(res, "buId");
    expect(buIds).toEqual(expect.arrayContaining([String(A1), String(A2), String(A3)]));
    expect(buIds).not.toContain(String(B1));
  });

  // ── CASE 4 — sharp off-diagonal: (A1,PROC) + (A2,ENG) ────────────────────
  test("CASE 4 — off-diagonal user sees exactly (A1,Proc) and (A2,Eng), never (A2,Proc) or (A1,Eng)", async () => {
    const res = await listView(clientOffdiag);
    expect(res.status).toBe(200);
    const ids = idsOf(res);

    expect(ids).toContain(roundIds.A1_PROC);
    expect(ids).toContain(roundIds.A2_ENG);
    expect(ids).toContain(arcRoundId); // ARC lives at (A2, ENG) — a granted cell

    // The off-diagonal cells: same hotels, same depts, wrong pairing.
    expect(ids).not.toContain(roundIds.A2_PROC);
    expect(ids).not.toContain(roundIds.A1_ENG);
    // And nothing else.
    expect(ids).not.toContain(roundIds.A3_PROC);
    expect(ids).not.toContain(roundIds.B1_PROC);
  });

  // ── CASE 5 — a client filter narrows, never widens ───────────────────────
  test("CASE 5 — filters.buId=[A2] sent by an A1-scoped user returns zero rows", async () => {
    const res = await listView(clientA1, { filters: { buId: [String(A2)] } });
    expect(res.status).toBe(200);
    // Intersection of scope {A1} and filter {A2} is empty.
    expect(res.body.data.rows.length).toBe(0);
    expect(res.body.data.total).toBe(0);
  });

  // ── CASE 6 — detail-endpoint IDOR (vendor identities + negotiated prices) ─
  test("CASE 6a — GET /rounds/:rfq_id is denied for an out-of-scope RFQ, allowed in scope", async () => {
    const denied = await clientA1.get(`/api/v1/negotiation/rounds/${rfqIds.A2_PROC}`);
    expect([403, 404]).toContain(denied.status);
    expect(denied.body.data).toBeUndefined();

    const allowed = await clientA1.get(`/api/v1/negotiation/rounds/${rfqIds.A1_PROC}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.map((r) => Number(r.id))).toContain(roundIds.A1_PROC);
  });

  test("CASE 6b — GET /rounds/:id/quotes is denied for an out-of-scope round (RFQ and ARC), allowed in scope", async () => {
    const deniedRfq = await clientA1.get(`/api/v1/negotiation/rounds/${roundIds.A2_PROC}/quotes`);
    expect([403, 404]).toContain(deniedRfq.status);
    expect(deniedRfq.body.data).toBeUndefined();

    const deniedArc = await clientA1.get(`/api/v1/negotiation/rounds/${arcRoundId}/quotes`);
    expect([403, 404]).toContain(deniedArc.status);

    const allowed = await clientA1.get(`/api/v1/negotiation/rounds/${roundIds.A1_PROC}/quotes`);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.data)).toBe(true);
  });

  test("CASE 6c — the vendor no-login token path into GET /rounds/:rfq_id still works", async () => {
    const res = await anonClient.get(
      `/api/v1/negotiation/rounds/${rfqIds.A2_PROC}?token=${VENDOR_TOKEN}`
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    // The vendor is on the A2 round's vendor_ids, so they see it.
    expect(res.body.data.map((r) => Number(r.id))).toContain(roundIds.A2_PROC);
  });

  test("CASE 6d — a JWT vendor (user_type 3) still reaches GET /rounds/:rfq_id", async () => {
    const vendorClient = await httpClient(U_VENDOR);
    const res = await vendorClient.get(`/api/v1/negotiation/rounds/${rfqIds.A2_PROC}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => Number(r.id))).toContain(roundIds.A2_PROC);
  });

  // ── CASE 7 — super admin is unrestricted (the NULL-matrix path) ──────────
  test("CASE 7 — super admin (user_type 8) still sees every hotel and both companies", async () => {
    const superClient = await httpClient(U_SUPER);
    const res = await listView(superClient, { limit: 100 });
    expect(res.status).toBe(200);

    const buIds = facetKeys(res, "buId");
    expect(buIds).toEqual(
      expect.arrayContaining([String(A1), String(A2), String(A3), String(B1)])
    );

    // …and the detail endpoints stay open for them.
    const rounds = await superClient.get(`/api/v1/negotiation/rounds/${rfqIds.B1_PROC}`);
    expect(rounds.status).toBe(200);
    const quotes = await superClient.get(`/api/v1/negotiation/rounds/${arcRoundId}/quotes`);
    expect(quotes.status).toBe(200);
  });
});
