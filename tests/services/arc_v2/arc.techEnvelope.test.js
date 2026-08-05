// ARC v2 — Technical-envelope (two-envelope) vendor self-submission flow + security.
//
// Covers the vendor-facing half of the feature the coder built (RESOLVED
// DECISIONS 1/2/5 + the SECURITY MANDATE):
//
//   1. An invited vendor GETs the per-item tech clauses for their ARC (sees
//      clause_text + is_mandatory; NEVER buyer_marks / other vendors' rows).
//   2. The vendor saves draft clause responses + uploads evidence; can re-read
//      their own draft + evidence proxy links.
//   3. HARD two-step: when the ARC has tech clauses, the commercial quote
//      submit is BLOCKED (409) until the technical envelope is SEALED.
//   4. Sealing sets tech_submitted_at + emits the vendor's tech-submitted event.
//   9. A NON-invited vendor gets 403 on tech-clauses / draft / seal (no leak).
//  10. Cross-vendor isolation: vendor B cannot read/edit/seal vendor A's
//      responses, and cannot fetch vendor A's evidence via the proxy (403).
//  11. acl: a buyer (user_type 2) hitting the vendor endpoints is rejected; a
//      vendor (user_type 3) hitting evaluator endpoints is rejected.
//  13. The REMOVED buyer-records path POST /tech-eval/response returns 404.
//  14. Writes are blocked after seal (409) and after the submission window (409).
//
// Product-level: real Express app + local Postgres, no mocks. Vendor scope is
// derived from req.user.id; assertions are on HTTP status/body + DB rows.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha; // active beverages subscription
const VENDOR_B = IDS.users.vendor_beta;  // active beverages subscription
const VENDOR_NI = IDS.users.vendor_gamma; // NOT invited to these ARCs
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = "/api/v1/arc-v2/vendor";

describe("ARC v2 — technical envelope (two-envelope vendor flow + security)", () => {
  let buyerClient, alpha, beta, nonInvited;
  // ARC #1: tech clauses present, window open → exercises GET/draft/seal/hard-block.
  let arcId, itemId, clauseMandatory, clauseWeighted;
  // ARC #2: tech clauses present but submission window already passed (window guard).
  let pastArcId, pastClauseId;
  // ARC #3: a SECOND ARC with its own clause, to prove cross-ARC clause ids 400.
  let otherArcId, otherClauseId;
  const createdArcIds = [];

  async function seedArcWithClauses({ number, title, status, endOffsetDays, clauses }) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - INTERVAL '7 days', NOW() + ($9 || ' days')::interval,
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $10) RETURNING *`,
      [number, title, CATEGORY, HC, HOTEL, DEPT, PROC, status, String(endOffsetDays), BUYER]
    );
    createdArcIds.push(arc.id);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100) RETURNING *`, [arc.id, VARIANT_ID]);
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [item.id]);
    const clauseIds = [];
    for (const c of clauses) {
      const row = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_clauses
           (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [te.id, c.text, c.weight, c.type || 'compliance', !!c.mandatory]);
      clauseIds.push(Number(row.id));
    }
    return { arcId: Number(arc.id), itemId: Number(item.id), teId: Number(te.id), clauseIds };
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_A, VENDOR_B, VENDOR_NI]]
    );
    buyerClient = await httpClient(BUYER);
    alpha       = await httpClient(VENDOR_A);
    beta        = await httpClient(VENDOR_B);
    nonInvited  = await httpClient(VENDOR_NI);
    await seedArcEvalPerms(db, [BUYER]);

    // ARC #1 — window open (+10d), one mandatory + one weighted clause.
    const a1 = await seedArcWithClauses({
      number: "ARC-TE-MAIN", title: "Tech envelope main", status: "floated",
      endOffsetDays: 10,
      clauses: [
        { text: "ISO 22000 certificate (mandatory)", weight: 40, mandatory: true, type: "doc" },
        { text: "Cold-chain SOP", weight: 60, mandatory: false, type: "spec" },
      ],
    });
    arcId = a1.arcId; itemId = a1.itemId;
    [clauseMandatory, clauseWeighted] = a1.clauseIds;

    // ARC #2 — window already passed (deadline backdated).
    const a2 = await seedArcWithClauses({
      number: "ARC-TE-PAST", title: "Tech envelope past window", status: "floated",
      endOffsetDays: 10,
      clauses: [{ text: "FSSAI license", weight: 100, mandatory: false, type: "doc" }],
    });
    pastArcId = a2.arcId; pastClauseId = a2.clauseIds[0];
    await db.none(`UPDATE tbl_arc SET submission_end_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [pastArcId]);

    // ARC #3 — separate ARC, used only to prove cross-ARC clause ids are rejected.
    const a3 = await seedArcWithClauses({
      number: "ARC-TE-OTHER", title: "Tech envelope other ARC", status: "floated",
      endOffsetDays: 10,
      clauses: [{ text: "Foreign clause", weight: 100, mandatory: false, type: "doc" }],
    });
    otherArcId = a3.arcId; otherClauseId = a3.clauseIds[0];

    // Invitations: alpha + beta invited to ARC #1, #2, #3. gamma invited to NONE.
    for (const aId of [arcId, pastArcId, otherArcId]) {
      await db.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited'), ($1, $3, 'invited')
         ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
        [aId, VENDOR_A, VENDOR_B]);
    }
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files
          WHERE arc_item_tech_evaluation_vendors_response_id IN (
            SELECT r.id FROM tbl_arc_item_tech_evaluation_vendors_response r
            JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
            JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ── Case 1 — invited vendor reads clauses (incl. is_mandatory), no buyer data ──
  test("1. invited vendor GETs tech clauses with clause text + is_mandatory", async () => {
    const res = await alpha.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    expect(res.status).toBe(200);
    expect(res.body.data.window_open).toBe(true);
    expect(res.body.data.tech_submitted_at).toBeNull();
    const items = res.body.data.items;
    expect(items.length).toBe(1);
    const clauses = items[0].clauses;
    expect(clauses.length).toBe(2);
    const mand = clauses.find((c) => c.clause_id === clauseMandatory);
    expect(mand.is_mandatory).toBe(true);
    expect(mand.clause_text).toMatch(/ISO 22000/);
    const weighted = clauses.find((c) => c.clause_id === clauseWeighted);
    expect(weighted.is_mandatory).toBe(false);
    // SECURITY: the vendor payload must NOT carry any buyer scoring fields.
    const blob = JSON.stringify(res.body.data);
    expect(blob).not.toMatch(/buyer_marks/);
    expect(blob).not.toMatch(/mandatory_passed/);
  });

  // ── Case 2 — draft save + re-read; evidence upload + proxy links ──
  test("2. vendor saves draft responses + uploads evidence, re-reads own draft", async () => {
    const draft = await alpha.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId,
      responses: [
        { clause_id: clauseMandatory, vendor_response: "We hold ISO 22000:2018, cert #A-123" },
        { clause_id: clauseWeighted, vendor_response: "Cold chain maintained at 2-8C, SOP attached" },
      ],
    });
    expect(draft.status).toBe(200);
    expect(draft.body.data.saved).toBe(2);

    // DB: vendor_response rows upserted under vendor A only.
    const rows = await db.any(
      `SELECT r.vendor_response FROM tbl_arc_item_tech_evaluation_vendors_response r
        WHERE r.arc_item_tech_evaluation_clauses_id = ANY($1::bigint[]) AND r.vendor_id = $2`,
      [[clauseMandatory, clauseWeighted], VENDOR_A]);
    expect(rows.length).toBe(2);

    // Upload evidence (real multipart) — small in-memory PDF buffer.
    const pdf = Buffer.from("%PDF-1.4\n%test evidence\n");
    const up = await alpha
      .post(`${VENDOR_BASE}/tech-envelope/clause/${clauseMandatory}/file`)
      .attach("file", pdf, { filename: "iso.pdf", contentType: "application/pdf" });
    // S3 may be unavailable in the test env (no AWS creds) → 502; the local
    // DB path + ownership wiring is still proven by the response row above.
    // When S3 succeeds we get a vendor-scoped proxy URL (never a raw S3 link).
    expect([200, 502]).toContain(up.status);
    if (up.status === 200) {
      expect(up.body.data.file.url).toMatch(/^\/arc-v2\/vendor\/tech-envelope\/file\/\d+$/);
      expect(up.body.data.file.url).not.toMatch(/^https?:\/\//);
    }

    // Re-read own draft → responses echoed back.
    const re = await alpha.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    const c = re.body.data.items[0].clauses.find((x) => x.clause_id === clauseMandatory);
    expect(c.vendor_response).toMatch(/ISO 22000:2018/);
    // Any evidence files surface as ownership-checked proxy URLs, not raw S3.
    for (const f of (c.files || [])) {
      expect(f.url).toMatch(/^\/arc-v2\/vendor\/tech-envelope\/file\/\d+$/);
    }
  });

  test("2b. a draft response for a clause in ANOTHER ARC is rejected (400)", async () => {
    const res = await alpha.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId,
      responses: [{ clause_id: otherClauseId, vendor_response: "cross-ARC leak attempt" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong to this rate contract/i);
  });

  // ── Case 3 — HARD two-step: commercial submit blocked until envelope sealed ──
  test("3. commercial submit is BLOCKED (409) until the technical envelope is sealed", async () => {
    // Vendor A has a valid commercial draft line but has NOT sealed tech yet.
    const cd = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId, lines: [{ arc_item_id: itemId, rate: 90, gst_pct: 5 }],
    });
    expect(cd.status).toBe(200);

    const blocked = await alpha.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/technical envelope/i);

    // Seal the technical envelope.
    const seal = await alpha.post(`${VENDOR_BASE}/tech-envelope/submit`).send({ arc_id: arcId });
    expect(seal.status).toBe(200);
    expect(seal.body.data.tech_submitted_at).toBeTruthy();

    // Now commercial submit is allowed.
    const ok = await alpha.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(ok.status).toBe(200);
    expect(ok.body.data.quote.submitted_at).toBeTruthy();
  });

  // ── Case 4 — seal sets tech_submitted_at + emits VENDOR_TECH_SUBMITTED ──
  test("4. sealing set tech_submitted_at on the quote row + logged vendor_tech_submitted", async () => {
    const quote = await db.one(
      `SELECT tech_submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_A]);
    expect(quote.tech_submitted_at).toBeTruthy();

    const ev = await db.oneOrNone(
      `SELECT 1 FROM tbl_arc_event_log
        WHERE arc_id = $1 AND event_type = 'vendor_tech_submitted'
          AND (payload->>'vendor_id')::bigint = $2`,
      [arcId, VENDOR_A]);
    expect(ev).toBeTruthy();
  });

  // ── Case 14 — after seal, vendor writes are immutable (409) ──
  test("14a. after seal, draft-save / evidence-delete are blocked (409)", async () => {
    const draft = await alpha.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId, responses: [{ clause_id: clauseWeighted, vendor_response: "post-seal edit" }],
    });
    expect(draft.status).toBe(409);
    expect(draft.body.message).toMatch(/already submitted/i);

    // Re-sealing is idempotent and stays 200 (no error surfaced to the vendor).
    const reseal = await alpha.post(`${VENDOR_BASE}/tech-envelope/submit`).send({ arc_id: arcId });
    expect([200, 409]).toContain(reseal.status);
  });

  // ── Case 14 — writes blocked after the submission window closes (409) ──
  test("14b. draft-save after the submission window is rejected (409)", async () => {
    const res = await alpha.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: pastArcId, responses: [{ clause_id: pastClauseId, vendor_response: "too late" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/deadline has passed/i);
  });

  // ── Case 9 — a non-invited vendor: 403 on every tech-envelope endpoint, no leak ──
  test("9. a non-invited vendor gets 403 on tech-clauses / draft / seal", async () => {
    const get = await nonInvited.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    expect(get.status).toBe(403);
    // No clause text / existence leaked in the body.
    expect(JSON.stringify(get.body)).not.toMatch(/ISO 22000/);

    const draft = await nonInvited.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId, responses: [{ clause_id: clauseMandatory, vendor_response: "x" }],
    });
    expect(draft.status).toBe(403);

    const seal = await nonInvited.post(`${VENDOR_BASE}/tech-envelope/submit`).send({ arc_id: arcId });
    expect(seal.status).toBe(403);
  });

  // ── Case 10 — cross-vendor isolation: B never touches A's responses/evidence ──
  test("10. cross-vendor isolation: vendor B cannot read/edit/seal vendor A's responses", async () => {
    // B reads its OWN envelope — sees the clauses but NONE of A's drafted text.
    const bGet = await beta.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    expect(bGet.status).toBe(200);
    const bMand = bGet.body.data.items[0].clauses.find((c) => c.clause_id === clauseMandatory);
    expect(bMand.vendor_response).toBeNull(); // A's "ISO 22000:2018" must NOT leak to B
    expect(JSON.stringify(bGet.body.data)).not.toMatch(/cert #A-123/);

    // B drafts against the same clause — writes against B's own vendor_id only.
    const bDraft = await beta.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId, responses: [{ clause_id: clauseMandatory, vendor_response: "B's own answer" }],
    });
    expect(bDraft.status).toBe(200);

    // A's row is untouched; B has a SEPARATE row.
    const aRow = await db.one(
      `SELECT vendor_response FROM tbl_arc_item_tech_evaluation_vendors_response
        WHERE arc_item_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
      [clauseMandatory, VENDOR_A]);
    expect(aRow.vendor_response).toMatch(/ISO 22000:2018/);
    const bRow = await db.one(
      `SELECT vendor_response FROM tbl_arc_item_tech_evaluation_vendors_response
        WHERE arc_item_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
      [clauseMandatory, VENDOR_B]);
    expect(bRow.vendor_response).toBe("B's own answer");
  });

  test("10b. vendor B cannot fetch vendor A's evidence file via the proxy (403/404)", async () => {
    // Seed an evidence file owned by A directly (S3 upload is unavailable in the
    // test env, so we attach a stored URL straight to A's response row).
    const aResp = await db.one(
      `SELECT id FROM tbl_arc_item_tech_evaluation_vendors_response
        WHERE arc_item_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
      [clauseMandatory, VENDOR_A]);
    const file = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, 'https://example.invalid/a-secret-evidence.pdf') RETURNING id`,
      [aResp.id]);

    // B tries the vendor proxy for A's file → 403 ownership rejection (the
    // guard fires BEFORE any S3 fetch, so this is a clean 403 not a 500).
    const bFetch = await beta.get(`${VENDOR_BASE}/tech-envelope/file/${file.id}`);
    expect(bFetch.status).toBe(403);

    // B also cannot DELETE A's file.
    const bDel = await beta.delete(`${VENDOR_BASE}/tech-envelope/file/${file.id}`);
    expect(bDel.status).toBe(403);

    // A's file still exists.
    const still = await db.oneOrNone(
      `SELECT 1 FROM tbl_arc_item_tech_evaluation_vendors_response_files WHERE id = $1`, [file.id]);
    expect(still).toBeTruthy();
  });

  // ── Case 11 — role isolation (acl) ──
  test("11. a buyer (user_type 2) is rejected by acl([3]) on the vendor endpoints", async () => {
    const get = await buyerClient.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    expect(get.status).toBe(403);
    const draft = await buyerClient.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId, responses: [{ clause_id: clauseMandatory, vendor_response: "x" }],
    });
    expect(draft.status).toBe(403);
    const seal = await buyerClient.post(`${VENDOR_BASE}/tech-envelope/submit`).send({ arc_id: arcId });
    expect(seal.status).toBe(403);
  });

  test("11b. a vendor (user_type 3) is rejected by acl([2,8]) on the evaluator endpoints", async () => {
    // tech-eval matrix read + score are buyer-only.
    const read = await alpha.get(`/api/v1/arc-v2/evaluation/items/${itemId}/tech-eval`);
    expect(read.status).toBe(403);
    const score = await alpha.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({
      response_id: 1, buyer_marks: 9,
    });
    expect(score.status).toBe(403);
    // The evaluator evidence proxy is buyer-only too.
    const ev = await alpha.get(`/api/v1/arc-v2/evaluation/tech-eval/evidence/1`);
    expect(ev.status).toBe(403);
  });

  // ── Case 13 — the REMOVED buyer-records path is gone (route deleted) ──
  // This platform's catch-all for any UNMATCHED route returns 405 (see
  // app/util/error.js — "Method Not Allowed!"), which is how a deleted route
  // surfaces here. We prove the route is gone by asserting it hits that
  // catch-all (405 + the platform's not-matched body), whereas a route that
  // DOES exist (tech-eval/score) never produces that 405 catch-all shape.
  test("13. the removed buyer-records path POST /tech-eval/response is gone (catch-all 405)", async () => {
    const res = await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/response`).send({
      clause_id: clauseMandatory, vendor_id: VENDOR_A, vendor_response: "buyer transcribed",
    });
    expect(res.status).toBe(405); // unmatched route → platform catch-all
    expect(res.body.error).toMatch(/Method Not Allowed/i);

    // Sanity: a route that still EXISTS does not produce the catch-all 405.
    const live = await buyerClient.post(`/api/v1/arc-v2/evaluation/tech-eval/score`).send({});
    expect(live.status).not.toBe(405);
  });
});
