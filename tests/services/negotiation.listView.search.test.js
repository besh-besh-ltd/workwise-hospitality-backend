// negotiation.listView.search.test.js — the "#" search bug on POST /negotiation/list-view.
//
// THE BUG (production, reported by users):
//   Every negotiation card and the RFQ facet label render the number as
//   "#536299". Users copy what they see and type "#536299" into the search box.
//   getNegotiationListView builds its in-memory haystack from
//     `${title} ${rfq_no} ${hotel_name} ${department_title}`
//   which contains NO "#", and matched with a single `hay.includes(search)`.
//   Result, verified against production: "536150" → 12 rows, "#536150" → 0 rows.
//
// THE FIX: tokenize the search term on whitespace, strip a leading "#" per
// token, and require EVERY token to be present in the haystack. As a bonus this
// makes multi-word search work ("orchid 536150" used to be a guaranteed zero).
//
// The ARC branch of the union comes along for free — getArcNegotiationRoundList
// aliases `a.arc_number AS rfq_no`, so "#<arc_number>" starts matching too.
//
// SCOPE IS NON-NEGOTIABLE: search filters WITHIN the caller's RBAC row set. It
// must never surface another company's round, no matter how exact the term.
//
// Fixtures follow negotiation.listView.scope.test.js: purpose-built users with
// an explicit tbl_user_role_scopes grant of the negotiation.read role, direct
// INSERT seeding, all assertions over real HTTP.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const PROCESS = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

// Role 8 = Commercial Negotiator N1 — carries permission negotiation.read.
const ROLE_NEG_READ = 8;

// Purpose-built users (80921+ — clear of negotiation.listView.scope.test.js's 80901-80905).
const U_A = 80921; // company-wide under hospitality A
const U_B = 80922; // company-wide under hospitality B

const PFX = "NEGSEARCH-";
const ARC_NUMBER = `${PFX}ARC-7781`;
const D = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

let clientA, clientB;
const rfq = {}; // key → { id, no }
const roundIds = {};
let arcId, arcItemId, arcRoundId;

async function makeScopedUser(userId, name, { company, hc }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negsearch.${userId}@test.local`, company]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, NULL, 0, $3)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, hc, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, NULL, NULL)`,
    [userId, ROLE_NEG_READ, hc]
  );
}

async function seedRfqWithRound(key, { hc, hotel, title }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.superAdmin,
    hospitality: hc,
    hotel,
    department: PROC,
    process: PROCESS,
    title,
  });
  rfq[key] = { id: Number(rfq_id), no: Number(rfq_no) };

  const round = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date, created_by)
     VALUES ($1, 'RFQ', $1, 1, 'ACTIVE', $2, $3)
     RETURNING id`,
    [rfq[key].id, D(7), IDS.users.superAdmin]
  );
  roundIds[key] = Number(round.id);
}

describe("Negotiation list-view search — '#'-prefixed numbers and multi-token terms", () => {
  beforeAll(async () => {
    await makeScopedUser(U_A, "NegSearch A User", { company: IDS.companies.A, hc: HC_A });
    await makeScopedUser(U_B, "NegSearch B User", { company: IDS.companies.B, hc: HC_B });

    // Two RFQs under hospitality A, one under hospitality B. Distinct title
    // words so multi-token search is observable.
    await seedRfqWithRound("ALPHA", { hc: HC_A, hotel: A1, title: `${PFX}Orchid Alpha` });
    await seedRfqWithRound("BETA", { hc: HC_A, hotel: A2, title: `${PFX}Tulip Beta` });
    await seedRfqWithRound("FOREIGN", { hc: HC_B, hotel: B1, title: `${PFX}Orchid Foreign` });

    // ARC branch of the union — `arc_number AS rfq_no`, so "#<arc_number>"
    // must match through the same tokenizer.
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
      [ARC_NUMBER, `${PFX}Jasmine Arc`, CATEGORY, HC_A, A1, PROC, PROCESS, IDS.users.superAdmin]
    );
    arcId = Number(arc.id);

    const arcItem = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 10, 'kg') RETURNING id`,
      [arcId, VARIANT_ID]
    );
    arcItemId = Number(arcItem.id);

    const arcRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, arc_item_id, rfq_id, round_number, status, end_date, created_by)
       VALUES ('ARC', $1, $2, NULL, 1, 'ACTIVE', $3, $4)
       RETURNING id`,
      [arcId, arcItemId, D(7), IDS.users.superAdmin]
    );
    arcRoundId = Number(arcRound.id);

    clientA = await httpClient(U_A);
    clientB = await httpClient(U_B);
  });

  afterAll(async () => {
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
    const rfqIds = Object.values(rfq).map((r) => r.id);
    if (rfqIds.length) await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    const users = [U_A, U_B];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
  });

  const search = (client, term, body = {}) =>
    client.post("/api/v1/negotiation/list-view").send({ limit: 200, search: term, ...body });

  const idsOf = (res) => res.body.data.rows.map((r) => Number(r.round_id));

  // ── Non-regression: the plain-number search that already works ────────────
  test("plain number search still finds the round (non-regression)", async () => {
    const res = await search(clientA, String(rfq.ALPHA.no));
    expect(res.status).toBe(200);
    expect(idsOf(res)).toContain(roundIds.ALPHA);
    expect(idsOf(res)).not.toContain(roundIds.BETA);
    expect(res.body.data.total).toBe(1);
  });

  // ── THE FIX: '#'-prefixed number, exactly as the UI renders it ────────────
  test("'#'-prefixed number finds the same round (the reported bug)", async () => {
    const res = await search(clientA, `#${rfq.ALPHA.no}`);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toContain(roundIds.ALPHA);
    expect(res.body.data.total).toBe(1);
  });

  test("surrounding whitespace around a '#'-prefixed number is tolerated", async () => {
    const res = await search(clientA, `   #${rfq.ALPHA.no}   `);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toContain(roundIds.ALPHA);
    expect(res.body.data.total).toBe(1);
  });

  // ── Tokenization: multi-word terms are ANDed rather than substring-matched ─
  test("multi-token term 'title-word #number' matches (was a guaranteed zero)", async () => {
    const res = await search(clientA, `Orchid #${rfq.ALPHA.no}`);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toContain(roundIds.ALPHA);
    // BETA shares neither token; FOREIGN shares "orchid" but is out of scope.
    expect(idsOf(res)).not.toContain(roundIds.BETA);
    expect(res.body.data.total).toBe(1);
  });

  test("every token must match — an unmatched token still yields zero rows", async () => {
    const res = await search(clientA, `Tulip #${rfq.ALPHA.no}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBe(0);
    expect(res.body.data.total).toBe(0);
  });

  // ── ARC branch (arc_number AS rfq_no) ────────────────────────────────────
  test("'#'-prefixed ARC number finds the ARC negotiation round", async () => {
    const plain = await search(clientA, ARC_NUMBER, { source: "ARC" });
    expect(plain.status).toBe(200);
    expect(idsOf(plain)).toContain(arcRoundId);

    const hashed = await search(clientA, `#${ARC_NUMBER}`, { source: "ARC" });
    expect(hashed.status).toBe(200);
    expect(idsOf(hashed)).toContain(arcRoundId);
    expect(hashed.body.data.total).toBe(1);
  });

  // ── Search NARROWS, never WIDENS ─────────────────────────────────────────
  test("an exact '#'-number for another company's RFQ returns nothing", async () => {
    // The row genuinely exists — the B-scoped user can see it.
    const visibleToB = await search(clientB, `#${rfq.FOREIGN.no}`);
    expect(visibleToB.status).toBe(200);
    expect(idsOf(visibleToB)).toContain(roundIds.FOREIGN);

    // …and stays invisible to the A-scoped user, hash or no hash.
    for (const term of [String(rfq.FOREIGN.no), `#${rfq.FOREIGN.no}`, `Orchid #${rfq.FOREIGN.no}`]) {
      const res = await search(clientA, term);
      expect(res.status).toBe(200);
      expect(idsOf(res)).not.toContain(roundIds.FOREIGN);
    }
  });

  test("a bare '#' with no digits does not act as a wildcard escape hatch", async () => {
    // "#" normalizes to an empty term → no search filter, but the RBAC row set
    // still bounds the result. Company B's round must not appear.
    const res = await search(clientA, "#");
    expect(res.status).toBe(200);
    expect(idsOf(res)).not.toContain(roundIds.FOREIGN);
  });
});
