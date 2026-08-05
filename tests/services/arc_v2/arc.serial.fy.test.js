// ARC v2 — Contract Serial must embed the Financial Year (Sr 26).
//
// Confirmed generated format (per changes.md, supersedes spec.md's tentative
// slash proposal): `ARC-<FY>-<seq4>`, e.g. `ARC-2026-27-0001` — dashes
// throughout, 4-digit zero-padded counter, resets per FY via the atomic
// `tbl_arc_number_seq` upsert (arcModel.nextArcNumber), minted inside the
// same tx that inserts the ARC row.
//
// Exercises POST /api/v1/arc-v2 (live create) and POST /api/v1/arc-v2/manual/draft
// (backdated manual entry) against the real Express app + Postgres — mirrors
// the harness in arc.create.flow.test.js / arc.manual.vendors.test.js.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { financialYearOf, currentFinancialYearIst } from "../../../app/helper/financialYear.js";
import arcModel from "../../../app/models/arc_v2/arcModel.js";

const ARC_NUMBER_RE = /^ARC-(\d{4}-\d{2})-(\d{4})$/;

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const CATEGORY = TEST_CATEGORIES.beverages;

describe("ARC v2 — contract serial embeds Financial Year", () => {
  let client;
  const createdArcIds = [];
  // FY labels used only by the direct-model "per-FY reset" test — far enough
  // in the future that no other suite/business date will ever collide with
  // them, and distinct from currentFinancialYearIst().
  const RESET_OLD_FY = "2091-92";
  const RESET_NEW_FY = "2092-93";

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
    await db.none(`DELETE FROM tbl_arc_number_seq WHERE fy = ANY($1::text[])`, [[RESET_OLD_FY, RESET_NEW_FY]]);
  });

  async function createLive(title) {
    const res = await client.post("/api/v1/arc-v2").send({
      title,
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
    });
    expect(res.status).toBe(200);
    const arc = res.body.data.arc;
    createdArcIds.push(arc.id);
    return arc;
  }

  async function createManual({ arcNumber, createdAt, title = "manual serial fy" } = {}) {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title, type: "product", ...(arcNumber ? { arc_number: arcNumber } : {}) },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "draft", created_at: createdAt },
    });
    return res;
  }

  // ── 1. Serial embeds current FY, correct format + padding ──────────────────
  test("create → arc_number matches ARC-<FY>-<seq4> and FY segment is the current IST FY", async () => {
    const arc = await createLive("Serial FY — format check");
    expect(arc.arc_number).toMatch(ARC_NUMBER_RE);
    const [, fy, seq] = arc.arc_number.match(ARC_NUMBER_RE);
    expect(fy).toBe(currentFinancialYearIst());
    expect(seq).toHaveLength(4); // zero-padded to 4 digits
  });

  // ── 2. Sequential within the same FY ────────────────────────────────────────
  test("second create in the same FY → sequence increments by 1", async () => {
    const first = await createLive("Serial FY — seq A");
    const second = await createLive("Serial FY — seq B");
    const [, fy1, seq1] = first.arc_number.match(ARC_NUMBER_RE);
    const [, fy2, seq2] = second.arc_number.match(ARC_NUMBER_RE);
    expect(fy2).toBe(fy1);
    expect(Number(seq2)).toBe(Number(seq1) + 1);
    expect(first.arc_number).not.toBe(second.arc_number);
  });

  // ── 3. Concurrency — no duplicates ──────────────────────────────────────────
  test("concurrent creates → all arc_numbers distinct, no 500s / UNIQUE violations", async () => {
    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        client.post("/api/v1/arc-v2").send({
          title: `Serial FY — concurrent ${i}`,
          category_id: CATEGORY,
          hotel_id: HOTEL,
          department_id: DEPT,
        })
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.data.arc.arc_number).toMatch(ARC_NUMBER_RE);
      createdArcIds.push(res.body.data.arc.id);
    }
    const numbers = responses.map((r) => r.body.data.arc.arc_number);
    expect(new Set(numbers).size).toBe(N); // all distinct — no dup serials
    // And the sequence portions themselves are pairwise distinct integers
    // (a stronger check than just string uniqueness — rules out e.g. two
    // different-looking strings that both round to the same seq by accident).
    const seqs = numbers.map((n) => Number(n.match(ARC_NUMBER_RE)[2]));
    expect(new Set(seqs).size).toBe(N);
  });

  // ── 4. Manual path — backdated created_at drives the FY, not "today" ───────
  test("manual entry with blank arc_number + backdated created_at → serial uses the BACKDATED FY", async () => {
    const backdated = "2019-06-15T00:00:00+05:30"; // well inside FY 2019-20, clearly prior to today
    const expectedFy = financialYearOf(backdated);
    expect(expectedFy).toBe("2019-20"); // sanity on the fixture date itself
    expect(expectedFy).not.toBe(currentFinancialYearIst());

    const res = await createManual({ createdAt: backdated });
    expect(res.status).toBe(200);
    createdArcIds.push(res.body.data.arc.id);
    const arcNumber = res.body.data.arc.arc_number;
    expect(arcNumber).toMatch(ARC_NUMBER_RE);
    const [, fy] = arcNumber.match(ARC_NUMBER_RE);
    expect(fy).toBe(expectedFy);
  });

  test("manual entry with blank arc_number + NO created_at → serial uses today's IST FY", async () => {
    const res = await createManual({});
    expect(res.status).toBe(200);
    createdArcIds.push(res.body.data.arc.id);
    const [, fy] = res.body.data.arc.arc_number.match(ARC_NUMBER_RE);
    expect(fy).toBe(currentFinancialYearIst());
  });

  // ── 5. Manual path — hand-keyed arc_number is respected unchanged ─────────
  test("manual entry with a supplied arc_number → respected verbatim; duplicate → 409", async () => {
    const legacyNumber = `ARC-LEGACY-FY-${Date.now()}`;
    const first = await createManual({ arcNumber: legacyNumber, createdAt: "2019-06-15T00:00:00+05:30" });
    expect(first.status).toBe(200);
    createdArcIds.push(first.body.data.arc.id);
    expect(first.body.data.arc.arc_number).toBe(legacyNumber); // untouched — not FY-reformatted

    const dupe = await createManual({ arcNumber: legacyNumber, createdAt: "2019-06-15T00:00:00+05:30" });
    expect(dupe.status).toBe(409);
  });

  // ── 6. Per-FY reset — a seeded prior-FY counter never leaks into a fresh FY ─
  // Direct model call (still the real atomic Postgres upsert, not mocked) so
  // the FY under test can be a value neither "today" nor touched by any other
  // suite in this run — the only way to deterministically prove a brand-new
  // FY starts at 0001 regardless of another FY's counter state.
  test("a fresh FY's counter starts at 0001 independent of a seeded prior-FY row", async () => {
    // Seed an unrelated FY with a large counter first.
    await db.tx((t) => arcModel.nextArcNumber(RESET_OLD_FY, t));
    for (let i = 0; i < 4; i++) await db.tx((t) => arcModel.nextArcNumber(RESET_OLD_FY, t)); // bump to 5
    const oldFySeeded = await db.one(`SELECT last_seq FROM tbl_arc_number_seq WHERE fy = $1`, [RESET_OLD_FY]);
    expect(Number(oldFySeeded.last_seq)).toBe(5);

    // A brand-new FY, never touched before, must start fresh at 1 regardless
    // of RESET_OLD_FY's already-bumped counter.
    const firstNew = await db.tx((t) => arcModel.nextArcNumber(RESET_NEW_FY, t));
    expect(firstNew).toBe(`ARC-${RESET_NEW_FY}-0001`);
    const secondNew = await db.tx((t) => arcModel.nextArcNumber(RESET_NEW_FY, t));
    expect(secondNew).toBe(`ARC-${RESET_NEW_FY}-0002`);

    // And the old FY's row is untouched by the new FY's activity.
    const oldFyAfter = await db.one(`SELECT last_seq FROM tbl_arc_number_seq WHERE fy = $1`, [RESET_OLD_FY]);
    expect(Number(oldFyAfter.last_seq)).toBe(5);
  });
});
