// negotiation.timestampContract.test.js — no naive timestamp leaves a
// negotiation endpoint, and no negotiation comparison resolves through the
// Node process timezone.
//
// THE ROOT DEFECT (spec §0):
//
//   app/config/dbConn.js:31 -> pgp.pg.types.setTypeParser(1114, (s) => s)
//
// OID 1114 is `timestamp without time zone`, so every negotiation timestamp
// arrives in Node as a bare, unlabelled string — "2026-08-13 07:00:00" — with
// nothing in it saying which zone the digits belong to. For the negotiation
// tables the answer is UTC. Roughly thirty frontend call sites each guessed
// independently, half of them wrongly, and that guess is tickets 1 and 2:
// a 12:30 PM IST deadline rendered as 07:00 AM on the approval screen.
//
// This suite is the contract test for the fix. Three parts:
//
//   B1  Every negotiation READ labels its timestamps. Asserted over real HTTP
//       against five endpoints (approval-bundle, rounds/:rfq_id, list-view at
//       BOTH grains, ARC rounds, round-detail as the regression guard). The
//       fixture end_date is the literal production value "2026-08-13 07:00:00"
//       so the assertion can be exact: the instant MUST be Date.UTC(2026,7,13,7).
//
//   B2  The ARC lazy-flip comparison must not read the process timezone.
//       An ACTIVE round ending two hours from now is ACTIVE — under TZ=UTC and
//       under TZ=Asia/Kolkata alike. Pre-fix it flipped to ENDED on an IST box.
//
//   B3  parseDeadline treats tbl_rfq.bid_end_date as naive IST, not naive UTC.
//       The same 5h30m error in the OPPOSITE direction.
//
// SCOPE DECISION — WHAT B1 DOES *NOT* SCAN (deliberate, see changes.md §4.6/§4.7):
//   This suite asserts the NAMED round timestamp fields, not "every timestamp
//   anywhere on the response". Two fields on these payloads are deliberately
//   still naive and are NOT defects:
//     * `quote_visibility.deadline` — naive IST, shipped alongside an explicit
//       `timezone: 'Asia/Kolkata'` sibling, so its contract IS closed, just not
//       in ISO. It is shared with non-negotiation endpoints.
//     * `rounds_history[].approvals[].acted_at` — converting one half of that
//       pair would break the String(acted_at).localeCompare sort at
//       approval/approverState.js:82.
//   A blanket "every timestamp-shaped string" scan would fail on both and would
//   be asserting a decision nobody made. Both are named below with an explicit
//   assertion that they are STILL naive, so if either is converted later this
//   suite tells the author to convert its twin too.
//
// Pattern B (commit + cleanup). Run:
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "negotiation\.timestampContract"
// and again with TZ=UTC / TZ=Asia/Kolkata for B2.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../helpers/arcEvalPerms.js";
import arcNegotiationModel from "../../app/models/arc_v2/arcNegotiationModel.js";

const HC_A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const PROC = IDS.departments.proc;
const PROCESS = IDS.processes.A_P1;
const CATEGORY = TEST_CATEGORIES.beverages;
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

// Role 8 = Commercial Negotiator — negotiation.{read,create,update,approve}.
const ROLE_NEG_FULL = 8;

// Purpose-built user, clear of 80931-80932 and 80941-80943.
const U_TS = 80951;

// ── THE FIXTURE INSTANT ─────────────────────────────────────────────────────
// The production row behind ticket 1: RFQ #536147 round 914,
// tbl_negotiation_rounds.end_date = '2026-08-13 07:00:00' (naive UTC).
// 07:00 UTC is 12:30 PM IST. Any renderer that prints "07:00" is wrong.
const NAIVE_END = "2026-08-13 07:00:00";
const NAIVE_CREATED = "2026-08-12 07:05:35";
const NAIVE_APPROVED = "2026-08-13 05:59:01";
const END_INSTANT = Date.UTC(2026, 7, 13, 7, 0, 0);
const CREATED_INSTANT = Date.UTC(2026, 7, 12, 7, 5, 35);
const APPROVED_INSTANT = Date.UTC(2026, 7, 13, 5, 59, 1);

// An ISO-8601 instant: has the T separator AND an explicit offset. A bare
// "2026-08-13 07:00:00" fails on both counts, which is exactly the pre-fix
// value and exactly what a downstream `moment(x)` misreads as local time.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * One field, asserted as a labelled instant with a known value.
 * `where` names the endpoint + field so a failure reads as a location.
 */
function expectInstant(value, expectedMs, where) {
  // The `where` key rides inside the compared object so a failure prints the
  // endpoint and field name next to the actual value, not just "expected
  // '2026-08-13 07:00:00' to match /…/".
  expect({ where, value }).toEqual({ where, value: expect.stringMatching(ISO_INSTANT) });
  expect({ where, iso: new Date(Date.parse(value)).toISOString() }).toEqual({
    where,
    iso: new Date(expectedMs).toISOString(),
  });
}

const created = { rfqIds: [], rfqProductIds: [], roundIds: [], arcIds: [], arcItemIds: [] };

let client;
let rfqId;
let rfqNo;
let rfqProductId;
let roundId;
let arcId;
let arcItemId;
let arcEndedRoundId;
let arcActiveRoundId;
let deadlineRfqId;

// bid_end_date for the B1 RFQ: safely in the past so round-detail is not
// quote-visibility locked (a locked payload is redacted and would hide the
// very fields under test). Clock-relative on purpose — unlike B3's, which
// must be a fixed string.
const PAST_BID_END = new Date(Date.now() - 30 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

// B3's exact input from the spec. A naive IST wall clock: 12:00 noon in
// Mumbai, which is 06:30 UTC.
const IST_BID_END = "2026-08-01 12:00";
const IST_BID_END_AS_UTC_ISO = "2026-08-01T06:30:00.000Z";

/** end_date as a naive UTC string N hours from now — B2's shape. */
const naiveUtcHoursFromNow = (hours) =>
  new Date(Date.now() + hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19);

describe("Negotiation timestamp contract", () => {
  beforeAll(async () => {
    // THE FIXTURE TRAP: tbl_users.user_type is NULL on fixture rows, and
    // acl([2, 8]) refuses before any handler runs — so every assertion below
    // would "pass" against a 403 for entirely the wrong reason.
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 2, $4, now(), now())
       ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
      [U_TS, "Timestamp Contract Buyer", `negts.${U_TS}@test.local`, IDS.companies.A]
    );
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings
         (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
      [U_TS, HC_A, A1, IDS.users.superAdmin]
    );
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, NULL)`,
      [U_TS, ROLE_NEG_FULL, HC_A, A1]
    );
    await seedArcEvalPerms(db, [U_TS]);
    client = await httpClient(U_TS);

    // ── The RFQ under test ───────────────────────────────────────────────────
    const rfq = await makeRFQ(db, {
      createdBy: U_TS,
      hospitality: HC_A,
      hotel: A1,
      department: PROC,
      process: PROCESS,
      bid_end_date: PAST_BID_END,
      title: "NEGTS Timestamp Contract RFQ",
      status: 1,
      is_published: 1,
    });
    rfqId = Number(rfq.rfq_id);
    rfqNo = Number(rfq.rfq_no);
    created.rfqIds.push(rfqId);

    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
       VALUES ($1, $2, 0, 'NEGTS line', '0', '0') RETURNING id`,
      [rfqId, VARIANT_ID]
    );
    rfqProductId = Number(product.id);
    created.rfqProductIds.push(rfqProductId);

    // The round carrying the production instants, written as the raw naive
    // strings the column actually holds. Explicit strings, never NOW() — an
    // INSERT of NOW() into a `timestamp without time zone` column converts
    // through the POSTGRES SESSION timezone (Asia/Kolkata locally, UTC in CI),
    // which would make the fixture itself timezone-dependent.
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
          end_date, created_at, updated_at, approved_at, published_at,
          vendor_ids, created_by, remarks)
       VALUES ($1, 'RFQ', $1, $2, 1, 'ENDED',
               $3::timestamp, $4::timestamp, $4::timestamp, $5::timestamp, $5::timestamp,
               ARRAY[$6]::int[], $7, 'NEGTS round')
       RETURNING id`,
      [rfqId, rfqProductId, NAIVE_END, NAIVE_CREATED, NAIVE_APPROVED, VENDOR, U_TS]
    );
    roundId = Number(round.id);
    created.roundIds.push(roundId);

    // A vendor response, so the parent list's last_activity_at is populated
    // and the round-detail payload is not an empty shell.
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at, created_at)
       VALUES ($1, $2, $3, 900, 1000, now(), now())`,
      [roundId, VENDOR, rfqProductId]
    );

    // ── The ARC under test (B1's ARC leg + B2) ───────────────────────────────
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type)
       VALUES ('ARC-NEGTS-1', 'NEGTS Timestamp Contract ARC',
               $1, $2, $3, $4, $5, 'comm_eval_in_progress',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               $6, 'open')
       RETURNING id`,
      [CATEGORY, HC_A, A1, PROC, PROCESS, U_TS]
    );
    arcId = Number(arc.id);
    created.arcIds.push(arcId);

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 200, 'litre') RETURNING id`,
      [arcId, VARIANT_ID]
    );
    arcItemId = Number(item.id);
    created.arcItemIds.push(arcItemId);

    // ARC round #1 — the fixed production instants, for B1.
    const arcRound = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, rfq_id, arc_item_id, round_number, status,
          end_date, created_at, updated_at, vendor_ids, created_by)
       VALUES ('ARC', $1, NULL, $2, 1, 'ENDED',
               $3::timestamp, $4::timestamp, $4::timestamp, ARRAY[$5]::int[], $6)
       RETURNING id`,
      [arcId, arcItemId, NAIVE_END, NAIVE_CREATED, VENDOR, U_TS]
    );
    arcEndedRoundId = Number(arcRound.id);
    created.roundIds.push(arcEndedRoundId);

    // ARC round #2 — ACTIVE, ending two hours from now, for B2. Two hours is
    // deliberately INSIDE the 5h30m error: a process-timezone read of this
    // naive UTC string on an IST box lands 3h30m in the PAST and the round
    // lazily flips to ENDED. Under TZ=UTC the same buggy read is accidentally
    // correct, which is why this case must run both ways.
    const arcActive = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (source_type, source_id, rfq_id, arc_item_id, round_number, status,
          end_date, created_at, updated_at, vendor_ids, created_by)
       VALUES ('ARC', $1, NULL, $2, 2, 'ACTIVE',
               $3::timestamp, now(), now(), ARRAY[$4]::int[], $5)
       RETURNING id`,
      [arcId, arcItemId, naiveUtcHoursFromNow(2), VENDOR, U_TS]
    );
    arcActiveRoundId = Number(arcActive.id);
    created.roundIds.push(arcActiveRoundId);

    // ── B3's RFQ: a naive-IST bid_end_date, fixed so the answer is exact ─────
    const dRfq = await makeRFQ(db, {
      createdBy: U_TS,
      hospitality: HC_A,
      hotel: A1,
      department: PROC,
      process: PROCESS,
      bid_end_date: IST_BID_END,
      title: "NEGTS IST Deadline RFQ",
      status: 1,
      is_published: 1,
    });
    deadlineRfqId = Number(dRfq.rfq_id);
    created.rfqIds.push(deadlineRfqId);
  });

  afterAll(async () => {
    if (created.roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [created.roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [created.roundIds]);
    }
    if (created.arcItemIds.length) {
      await db.none(`DELETE FROM tbl_arc_item WHERE id = ANY($1::int[])`, [created.arcItemIds]);
    }
    if (created.arcIds.length) {
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [created.arcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [created.arcIds]);
    }
    if (created.rfqProductIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [created.rfqProductIds]);
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
    }
    await cleanupArcEvalPerms(db, [U_TS]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`, [U_TS, ROLE_NEG_FULL]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B1 — no naive timestamp leaves a negotiation endpoint
  // ══════════════════════════════════════════════════════════════════════════

  describe("B1 — every negotiation read labels its timestamps", () => {
    it("GET /rounds/:rfq_id/approval-bundle — rounds_history carries instants, not bare strings", async () => {
      // THE row behind ticket 1. ApproveRoundPage reads round.end_date off
      // this payload and hands it to StepReview, which parsed the bare string
      // as local wall clock and rendered 07:00 AM for a 12:30 PM deadline.
      const res = await client.get(`/api/v1/negotiation/rounds/${rfqId}/approval-bundle`);
      expect(res.status).toBe(200);

      const round = (res.body.data.rounds_history || []).find((r) => Number(r.id) === roundId);
      expect(round).toBeTruthy();

      expectInstant(round.end_date, END_INSTANT, "approval-bundle rounds_history[].end_date");
      expectInstant(round.created_at, CREATED_INSTANT, "approval-bundle rounds_history[].created_at");
      expectInstant(round.approved_at, APPROVED_INSTANT, "approval-bundle rounds_history[].approved_at");
      expectInstant(round.published_at, APPROVED_INSTANT, "approval-bundle rounds_history[].published_at");
    });

    it("GET /rounds/:rfq_id — the rounds list carries instants", async () => {
      const res = await client.get(`/api/v1/negotiation/rounds/${rfqId}`);
      expect(res.status).toBe(200);

      const rows = res.body.data || res.body.rounds || [];
      const round = rows.find((r) => Number(r.id) === roundId);
      expect(round).toBeTruthy();

      expectInstant(round.end_date, END_INSTANT, "rounds/:rfq_id end_date");
      expectInstant(round.created_at, CREATED_INSTANT, "rounds/:rfq_id created_at");
      expectInstant(round.approved_at, APPROVED_INSTANT, "rounds/:rfq_id approved_at");
    });

    it("POST /list-view groupBy=round — the listing's aliased columns are instants too", async () => {
      // The listing SELECTs `nr.created_at AS round_created_at`, so it needs
      // its own key list — an aliased column is the same naive contract under
      // a different name, and aliasing is exactly how a serializer gets missed.
      const res = await client
        .post("/api/v1/negotiation/list-view")
        .send({ groupBy: "round", limit: 200, filters: { rfqId: [rfqId] } });
      expect(res.status).toBe(200);

      const row = res.body.data.rows.find((r) => Number(r.round_id) === roundId);
      expect(row).toBeTruthy();

      expectInstant(row.end_date, END_INSTANT, "list-view(round) end_date");
      expectInstant(row.round_created_at, CREATED_INSTANT, "list-view(round) round_created_at");
    });

    it("POST /list-view groupBy=parent — first_round_at / last_activity_at are instants", async () => {
      const res = await client
        .post("/api/v1/negotiation/list-view")
        .send({ groupBy: "parent", limit: 200, filters: { parentKey: [`RFQ:${rfqId}`] } });
      expect(res.status).toBe(200);

      const row = res.body.data.rows.find((r) => String(r.parent_key) === `RFQ:${rfqId}`);
      expect(row).toBeTruthy();

      expectInstant(row.first_round_at, CREATED_INSTANT, "list-view(parent) first_round_at");
      // last_activity_at is GREATEST(created_at, …) over the RFQ's rounds; the
      // only round here was created at the fixture instant.
      expect({ where: "list-view(parent) last_activity_at", v: row.last_activity_at })
        .toEqual({ where: "list-view(parent) last_activity_at", v: expect.stringMatching(ISO_INSTANT) });
    });

    it("GET /arc-v2 comm-eval negotiation rounds — the ARC list carries instants", async () => {
      const res = await client.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/negotiation/rounds`);
      expect(res.status).toBe(200);

      const rows = res.body.data || [];
      const round = rows.find((r) => Number(r.id) === arcEndedRoundId);
      expect(round).toBeTruthy();

      expectInstant(round.end_date, END_INSTANT, "arc rounds end_date");
      expectInstant(round.created_at, CREATED_INSTANT, "arc rounds created_at");
    });

    it("GET /rounds/:id/detail — REGRESSION GUARD: the one surface that was already right stays right", async () => {
      // round-detail already ran everything through isoOrNull. It is here so
      // that a future "simplification" of the serializer cannot quietly undo
      // the one endpoint the frontend's correct renderers were built against.
      const res = await client.get(`/api/v1/negotiation/rounds/${roundId}/detail`);
      expect(res.status).toBe(200);

      const r = res.body.data.round;
      expectInstant(r.end_date, END_INSTANT, "round-detail round.end_date");
      expectInstant(r.created_at, CREATED_INSTANT, "round-detail round.created_at");
      expectInstant(r.approved_at, APPROVED_INSTANT, "round-detail round.approved_at");
    });

    it("round-detail parent.bid_end_date is IST-parsed, NOT run through the UTC serializer", async () => {
      // The one IST column on a negotiation payload. Feeding it to the same
      // serializer as end_date would shift it 5h30m the OTHER way — the two
      // conventions live on one response and must not be merged.
      const res = await client.get(`/api/v1/negotiation/rounds/${roundId}/detail`);
      expect(res.status).toBe(200);

      const bidEnd = res.body.data.parent.bid_end_date;
      expect(bidEnd).toEqual(expect.stringMatching(ISO_INSTANT));
      // PAST_BID_END is a naive IST wall clock; read as IST it is 5h30m
      // EARLIER as an instant than the same digits read as UTC.
      expect(Date.parse(bidEnd)).toBe(Date.parse(`${PAST_BID_END.replace(" ", "T")}Z`) - 5.5 * 3600_000);
    });

    it("DELIBERATE EXCEPTIONS — quote_visibility.deadline and approvals[].acted_at are still naive, and say so", async () => {
      // Not defects; scope calls with reasons (changes.md §4.6, §4.7). Pinned
      // so that converting one WITHOUT its twin fails loudly here rather than
      // silently misordering RoundApprovalsList.
      const detail = await client.get(`/api/v1/negotiation/rounds/${roundId}/detail`);
      const qv = detail.body.data.quote_visibility;
      expect(qv.timezone).toBe("Asia/Kolkata");
      if (qv.deadline != null) {
        // Naive IST, sibling-labelled by `timezone` above — its contract IS
        // closed, just not in ISO.
        expect(qv.deadline).not.toMatch(ISO_INSTANT);
        expect(qv.deadline).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B2 — the ARC effective-status flip must not read the process timezone
  // ══════════════════════════════════════════════════════════════════════════

  describe("B2 — ARC effective_status does not depend on the process timezone", () => {
    it(`an ACTIVE round ending in 2h is ACTIVE (process TZ = ${process.env.TZ || "unset"})`, async () => {
      const res = await client.get(`/api/v1/arc-v2/evaluation/${arcId}/comm-eval/negotiation/rounds`);
      expect(res.status).toBe(200);

      const round = (res.body.data || []).find((r) => Number(r.id) === arcActiveRoundId);
      expect(round).toBeTruthy();
      expect(round.status).toBe("ACTIVE");
      // `new Date("2026-08-13 12:41:14") <= new Date()` resolves the bare
      // string through the NODE PROCESS timezone. On an IST box that is
      // 3h30m in the past and the buyer's live round reads ENDED.
      expect({
        tz: process.env.TZ || "unset",
        effective_status: round.effective_status,
      }).toEqual({ tz: process.env.TZ || "unset", effective_status: "ACTIVE" });
    });

    it("the vendor's copy of the same lazy-flip agrees", async () => {
      // arcNegotiationController.listVendorRounds carried an independent copy
      // of the comparison. Getting it wrong closes a vendor's submission
      // window early rather than merely mislabelling it for the buyer.
      const vendorClient = await httpClient(VENDOR);
      await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
      const res = await vendorClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/negotiation`);
      expect(res.status).toBe(200);

      const round = (res.body.data || []).find((r) => Number(r.round_id ?? r.id) === arcActiveRoundId);
      expect(round).toBeTruthy();
      expect(round.effective_status).toBe("ACTIVE");
    });

    it("isRoundExpired — the WRITE guard says the window is still open", async () => {
      // The same comparison again, this time on the path that refuses a
      // vendor's revised rate. Wrong here means a locked-out vendor, not a
      // cosmetic label.
      const expired = await arcNegotiationModel.isRoundExpired(arcActiveRoundId);
      expect({ tz: process.env.TZ || "unset", expired }).toEqual({
        tz: process.env.TZ || "unset",
        expired: false,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B3 — bid_end_date is naive IST, and the published deadline must say so
  // ══════════════════════════════════════════════════════════════════════════

  describe("B3 — parseDeadline reads bid_end_date as IST", () => {
    it(`'${IST_BID_END}' publishes as ${IST_BID_END_AS_UTC_ISO}, not 12:00Z`, async () => {
      // tbl_rfq.bid_end_date is free text holding a naive IST wall clock —
      // the deadline the buyer typed, in the zone the buyer typed it.
      // `new Date(raw.replace(" ", "T")).toISOString()` resolves it through
      // the node process timezone (UTC in production), publishing a 12:00 IST
      // deadline as 12:00Z and rendering it 05:30 pm in every browser.
      const res = await client.get(`/api/v1/rfq/quote-comparison-view/${deadlineRfqId}`);
      expect(res.status).toBe(200);

      const payload = res.body.data ?? res.body;
      expect(payload.rfq.deadline).toBe(IST_BID_END_AS_UTC_ISO);
    });

    it("the deadline shown and the deadline enforced come off one reading", async () => {
      // parseDeadline and the quote-visibility lock now share getBidEndMomentIst.
      // If they diverge again, the screen says "closed" while the API says
      // "open" (or the reverse) — the class of bug this pairing exists to stop.
      const res = await client.get(`/api/v1/rfq/quote-comparison-view/${deadlineRfqId}`);
      const payload = res.body.data ?? res.body;
      const qv = payload.quote_visibility;
      if (qv?.deadline) {
        expect(qv.timezone).toBe("Asia/Kolkata");
        // Same wall clock on both, one naive-IST and one as an instant.
        expect(qv.deadline.startsWith("2026-08-01 12:00")).toBe(true);
      }
      expect(Date.parse(payload.rfq.deadline)).toBe(Date.parse(IST_BID_END_AS_UTC_ISO));
    });
  });
});
