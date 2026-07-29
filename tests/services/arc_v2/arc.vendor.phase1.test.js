// ARC v2 — Phase 1 vendor quote revamp: backend-observable behavior tests.
//
// Phase 1 behaviors under test:
//   §3 Terms-acceptance gate (POST /arc-v2/vendor/quote/accept-terms):
//     T1. Before acceptance: lifecycle shows default_stage='overview'; technical
//         and commercial stages are LOCKED with reason 'terms_required'.
//     T2. accept-terms persists terms_accepted_at; re-fetch shows it set and
//         stages unlock (technical if clauses exist, commercial otherwise).
//     T3. Idempotent: accept-terms twice does NOT error and does NOT move the
//         timestamp forward (COALESCE keeps first-write value).
//     T4. Scope/security: non-invited vendor gets 403 (never 200).
//     T5. Window-closed: accept-terms 409s when submission deadline has passed.
//   §B Seal completeness guard (POST /vendor/tech-envelope/submit):
//     T6. Sealing with UNANSWERED clauses → 409 with message about answering first.
//     T7. After ALL clauses answered → seal succeeds (200) and sets tech_submitted_at.
//   §C original_name — tech evidence filename persist + read-back (UX polish):
//     TN1. addVendorResponseFile persists original_name; getVendorTechEnvelope
//          returns it on the files array for that clause.
//     TN2. A file seeded WITHOUT original_name returns original_name: null (backward-
//          compat — additive nullable migration).
//     TN3. Non-invited vendor uploading evidence via HTTP gets 403 (scope guard
//          fires before S3, so this is testable without real S3 credentials).
//
// Note on the HTTP upload happy-path (invited vendor → 200):
//   uploadTechEvidence calls uploadToS3 after auth/scope guards. The test env
//   uses dummy AWS credentials (test_aws_key / test-workwise-bucket) and no
//   LocalStack, so the S3 PutObject call fails. The model-layer assertions (TN1,
//   TN2) directly exercise addVendorResponseFile + getVendorTechEnvelope and are
//   the authoritative product-observable checks that original_name persists and
//   is returned. The HTTP path is covered up to the S3 gate (scope/auth in TN3).
//
// Not tested here (not HTTP-observable):
//   - FE-only changes (orange accent, charges modal, aside layout, freight field)
//   - Phase 2 (no preview endpoint exists yet)
//
// Product-level: real Express + real Postgres. No mocks.
// Pattern: direct SQL seeding (mirrors arc.techEnvelope.test.js), real HTTP via httpClient.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import arcEvalModel from "../../../app/models/arc_v2/arcEvaluationModel.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;   // active subscription, invited
const VENDOR_E = IDS.users.vendor_epsilon; // NOT invited to these ARCs
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = "/api/v1/arc-v2/vendor";

describe("ARC v2 — Phase 1: terms-acceptance gate + seal completeness guard", () => {
  let buyerClient, alphaClient, epsilonClient;
  // Main ARC: open window, has tech clauses — exercises terms gate + unlock + seal guard.
  let arcId, itemId, clauseA, clauseB;
  // Past-deadline ARC: window closed — exercises 409 on accept-terms.
  let pastArcId;

  const createdArcIds = [];

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Direct-SQL seed: ARC row + one item + optional tech-eval clauses. */
  async function seedArcDirect({ number, title, status, endOffsetDays, clauses = [] }) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - INTERVAL '7 days',
               NOW() + ($9 || ' days')::interval,
               NOW() + INTERVAL '30 days',
               NOW() + INTERVAL '365 days',
               $10)
       RETURNING *`,
      [number, title, CATEGORY, HC, HOTEL, DEPT, PROC, status, String(endOffsetDays), BUYER]
    );
    createdArcIds.push(Number(arc.id));

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 500, 'litre', 120) RETURNING *`,
      [arc.id, VARIANT_ID]
    );

    const clauseIds = [];
    if (clauses.length > 0) {
      const te = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
         VALUES ($1, 60) RETURNING id`,
        [item.id]
      );
      for (const c of clauses) {
        const row = await db.one(
          `INSERT INTO tbl_arc_item_tech_evaluation_clauses
             (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
           VALUES ($1, $2, $3, 'compliance', false) RETURNING id`,
          [te.id, c.text, c.weight]
        );
        clauseIds.push(Number(row.id));
      }
    }

    return { arcId: Number(arc.id), itemId: Number(item.id), clauseIds };
  }

  /** Invite a vendor to an ARC. */
  async function invite(aId, vendorId) {
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'invited')
       ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [aId, vendorId]
    );
  }

  // ── setup / teardown ───────────────────────────────────────────────────────

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_A, VENDOR_E]]
    );

    buyerClient   = await httpClient(BUYER);
    alphaClient   = await httpClient(VENDOR_A);
    epsilonClient = await httpClient(VENDOR_E);

    // Main ARC: open window (+10 days), two tech clauses.
    const main = await seedArcDirect({
      number: "ARC-PH1-MAIN", title: "Phase 1 main (window open + tech clauses)",
      status: "floated", endOffsetDays: 10,
      clauses: [
        { text: "ISO 9001 certificate", weight: 50 },
        { text: "Quality assurance SOP",  weight: 50 },
      ],
    });
    arcId  = main.arcId;
    itemId = main.itemId;
    [clauseA, clauseB] = main.clauseIds;

    // Past-deadline ARC: no tech clauses.
    const past = await seedArcDirect({
      number: "ARC-PH1-PAST", title: "Phase 1 past deadline",
      status: "floated", endOffsetDays: 10, clauses: [],
    });
    pastArcId = past.arcId;
    await db.none(
      `UPDATE tbl_arc SET submission_end_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [pastArcId]
    );

    // Invite alpha to both; epsilon to NEITHER.
    await invite(arcId, VENDOR_A);
    await invite(pastArcId, VENDOR_A);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      // Cleanup in dependency order (child rows first).
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files
          WHERE arc_item_tech_evaluation_vendors_response_id IN (
            SELECT r.id FROM tbl_arc_item_tech_evaluation_vendors_response r
            JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
            JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response
          WHERE arc_item_tech_evaluation_clauses_id IN (
            SELECT c.id FROM tbl_arc_item_tech_evaluation_clauses c
            JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN
           (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE arc_item_tech_evaluation_id IN
           (SELECT te.id FROM tbl_arc_item_tech_evaluation te
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation WHERE arc_item_id IN
           (SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
  });

  // ── T1: Before acceptance — lifecycle locks technical + commercial ──────────

  test("T1: before accept-terms → default_stage=overview; technical+commercial are LOCKED with reason terms_required", async () => {
    const res = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const { default_stage, stages } = res.body.data;
    expect(default_stage).toBe("overview");

    const overview = stages.find((s) => s.key === "overview");
    expect(overview).toBeDefined();
    // Overview should be active / awaiting acceptance, not locked.
    expect(overview.state).not.toBe("locked");

    const technical = stages.find((s) => s.key === "technical");
    expect(technical).toBeDefined();
    expect(technical.state).toBe("locked");
    expect(technical.reason).toBe("terms_required");

    const commercial = stages.find((s) => s.key === "commercial");
    expect(commercial).toBeDefined();
    expect(commercial.state).toBe("locked");
    expect(commercial.reason).toBe("terms_required");
  });

  // ── T2: accept-terms persists timestamp + unlocks next stage ──────────────

  test("T2: accept-terms persists terms_accepted_at and unlocks technical/commercial", async () => {
    const res = await alphaClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
    expect(res.status).toBe(200);
    expect(res.body.data.terms_accepted_at).toBeTruthy();

    // Verify DB row has the timestamp set.
    const row = await db.oneOrNone(
      `SELECT terms_accepted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    expect(row).toBeDefined();
    expect(row.terms_accepted_at).not.toBeNull();

    // Re-fetch lifecycle: overview complete, technical unlocked (has clauses → active/submit_tech).
    const lc = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}/lifecycle`);
    expect(lc.status).toBe(200);

    const { default_stage, stages } = lc.body.data;

    const overview = stages.find((s) => s.key === "overview");
    expect(overview.state).toBe("complete");
    expect(overview.reason).toBe("terms_accepted");

    // With tech clauses present, technical is now the next active stage.
    const technical = stages.find((s) => s.key === "technical");
    expect(technical.state).not.toBe("locked");
    // The default stage should now be 'technical' (clauses present, not yet sealed).
    expect(default_stage).toBe("technical");

    // Commercial is still locked behind tech (tech_required) but NOT terms_required.
    const commercial = stages.find((s) => s.key === "commercial");
    expect(commercial.state).toBe("locked");
    expect(commercial.reason).toBe("tech_required");
    expect(commercial.reason).not.toBe("terms_required");
  });

  // ── T3: Idempotent — second call keeps the original timestamp ─────────────

  test("T3: accept-terms twice does not error and does not move the timestamp", async () => {
    // First call already happened in T2 (tests run sequentially for same arcId).
    const before = await db.oneOrNone(
      `SELECT terms_accepted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    expect(before?.terms_accepted_at).toBeTruthy();
    const originalTs = before.terms_accepted_at;

    // Short pause to ensure clock can tick if idempotency is broken.
    await new Promise((r) => setTimeout(r, 50));

    const res = await alphaClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
    expect(res.status).toBe(200); // must not error

    const after = await db.oneOrNone(
      `SELECT terms_accepted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    // COALESCE keeps the first-write value; the timestamp must not change.
    expect(new Date(after.terms_accepted_at).getTime()).toBe(new Date(originalTs).getTime());
  });

  // ── T4: Scope/security — non-invited vendor gets 403 ─────────────────────

  test("T4: non-invited vendor cannot accept terms — gets 403", async () => {
    const res = await epsilonClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
    expect([403, 404]).toContain(res.status);
    // Make sure it's the invitation-scope rejection (403), not a generic 404.
    expect(res.status).toBe(403);
  });

  // ── T5: Window-closed — accept-terms 409 when deadline passed ────────────

  test("T5: accept-terms 409s when submission window has closed", async () => {
    const res = await alphaClient
      .post(`${VENDOR_BASE}/quote/accept-terms`)
      .send({ arc_id: pastArcId });
    expect(res.status).toBe(409);
  });

  // ── T6: Seal completeness guard — 409 with unanswered clauses ─────────────

  test("T6: seal tech envelope with UNANSWERED clauses → 409 (completeness guard)", async () => {
    // At this point alpha has accepted terms for arcId (from T2/T3).
    // The tech-envelope has two clauses; neither has been answered yet by alpha
    // in THIS describe block's scope (T2 only did accept-terms, not tech-draft).
    // Attempt to seal without answering → must be blocked.
    const res = await alphaClient
      .post(`${VENDOR_BASE}/tech-envelope/submit`)
      .send({ arc_id: arcId });
    expect(res.status).toBe(409);
    // The error message should reference answering all clauses.
    const body = JSON.stringify(res.body);
    expect(body.toLowerCase()).toMatch(/clause|answer|respond/);
  });

  // ── T7: Seal succeeds after all clauses answered ──────────────────────────

  test("T7: after answering ALL clauses, seal tech envelope succeeds (200)", async () => {
    // Answer both clauses for vendor_alpha.
    const draft = await alphaClient.post(`${VENDOR_BASE}/tech-envelope/draft`).send({
      arc_id: arcId,
      responses: [
        { clause_id: clauseA, vendor_response: "ISO 9001:2015 certified, cert #ISO-001" },
        { clause_id: clauseB, vendor_response: "QA SOP v3.2 attached and followed" },
      ],
    });
    expect(draft.status).toBe(200);
    expect(draft.body.data.saved).toBe(2);

    // Verify DB that both responses are present for VENDOR_A only (not epsilon).
    const rows = await db.any(
      `SELECT vendor_response FROM tbl_arc_item_tech_evaluation_vendors_response
        WHERE arc_item_tech_evaluation_clauses_id = ANY($1::bigint[]) AND vendor_id = $2`,
      [[clauseA, clauseB], VENDOR_A]
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.vendor_response !== null && r.vendor_response !== '')).toBe(true);

    // Now seal.
    const seal = await alphaClient
      .post(`${VENDOR_BASE}/tech-envelope/submit`)
      .send({ arc_id: arcId });
    expect(seal.status).toBe(200);
    expect(seal.body.data.tech_submitted_at).toBeTruthy();

    // DB: tech_submitted_at is now set on the quote row.
    const quote = await db.oneOrNone(
      `SELECT tech_submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    expect(quote).toBeDefined();
    expect(quote.tech_submitted_at).not.toBeNull();

    // Lifecycle should now show technical=complete and commercial as the next stage.
    const lc = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}/lifecycle`);
    expect(lc.status).toBe(200);
    const technical = lc.body.data.stages.find((s) => s.key === "technical");
    expect(technical.state).toBe("complete");
    expect(technical.reason).toBe("envelope_sealed");
    // default_stage advances to commercial (window still open, no quote yet).
    expect(lc.body.data.default_stage).toBe("commercial");
  });
});

// ── §C: original_name — tech evidence filename persist + read-back ─────────────
//
// Tests the additive `original_name` column on
// tbl_arc_item_tech_evaluation_vendors_response_files.
//
// Model-layer approach: the test env uses dummy S3 credentials so a real
// multipart HTTP upload (POST /tech-envelope/clause/:id/file) would fail at the
// PutObject step, after scope guards but before the DB insert. We therefore
// assert directly on the model functions that the controller calls —
// addVendorResponseFile (INSERT) and getVendorTechEnvelope (SELECT) — which are
// the authoritative product-observable data contract. The HTTP scope/auth path
// is covered by TN3.
// ──────────────────────────────────────────────────────────────────────────────
describe("ARC v2 — §C: original_name persist + read-back (tech evidence filename)", () => {
  let epsilonClient2;
  // A fresh ARC (unsealed, open window) isolated from the §T1-T7 ARC.
  let tnArcId, tnItemId, tnClauseId;
  const tnCreatedArcIds = [];

  beforeAll(async () => {
    epsilonClient2 = await httpClient(VENDOR_E);

    // Seed: one ARC, one item, one tech clause, window open.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'floated',
               NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '10 days',
               NOW() + INTERVAL '30 days',
               NOW() + INTERVAL '365 days',
               $8)
       RETURNING *`,
      [
        "ARC-TN-ORIGNAME", "§C original_name test",
        CATEGORY, HC, HOTEL, DEPT, PROC, BUYER,
      ]
    );
    tnArcId = Number(arc.id);
    tnCreatedArcIds.push(tnArcId);

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 100, 'kg', 50) RETURNING *`,
      [tnArcId, VARIANT_ID]
    );
    tnItemId = Number(item.id);

    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`,
      [tnItemId]
    );

    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, 'Technical specs document', 100, 'compliance', false) RETURNING id`,
      [te.id]
    );
    tnClauseId = Number(clause.id);

    // Invite VENDOR_A; VENDOR_E is NOT invited.
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1, $2, 'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [tnArcId, VENDOR_A]
    );
  });

  afterAll(async () => {
    if (tnCreatedArcIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files
          WHERE arc_item_tech_evaluation_vendors_response_id IN (
            SELECT r.id FROM tbl_arc_item_tech_evaluation_vendors_response r
            JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
            JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [tnCreatedArcIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response
          WHERE arc_item_tech_evaluation_clauses_id IN (
            SELECT c.id FROM tbl_arc_item_tech_evaluation_clauses c
            JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [tnCreatedArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [tnCreatedArcIds]);
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE arc_item_tech_evaluation_id IN
           (SELECT te.id FROM tbl_arc_item_tech_evaluation te
            JOIN tbl_arc_item i ON i.id = te.arc_item_id
            WHERE i.arc_id = ANY($1::bigint[]))`,
        [tnCreatedArcIds]
      );
      await db.none(
        `DELETE FROM tbl_arc_item_tech_evaluation WHERE arc_item_id IN
           (SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[]))`,
        [tnCreatedArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [tnCreatedArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [tnCreatedArcIds]);
    }
  });

  // TN1: addVendorResponseFile persists original_name and getVendorTechEnvelope
  //      returns it in the files array for that clause.
  test("TN1: addVendorResponseFile persists original_name; getVendorTechEnvelope returns it", async () => {
    // Mirror what uploadTechEvidence does after the S3 step.
    const responseRow = await arcEvalModel.ensureVendorResponseRow(tnClauseId, VENDOR_A);
    const file = await arcEvalModel.addVendorResponseFile(
      responseRow.id,
      "https://test-bucket.s3.ap-south-1.amazonaws.com/arc-tech-evidence/test.pdf",
      "test.pdf"
    );

    // INSERT return should carry original_name.
    expect(file.original_name).toBe("test.pdf");

    // Read-back via getVendorTechEnvelope (the path getTechClausesForVendor uses).
    const envelope = await arcEvalModel.getVendorTechEnvelope(tnArcId, VENDOR_A);
    const clauseRow = envelope.clauses.find((c) => Number(c.clause_id) === tnClauseId);
    expect(clauseRow).toBeDefined();

    const fileEntry = (envelope.filesByResponse[Number(clauseRow.response_id)] || [])
      .find((f) => Number(f.file_id) === Number(file.id));
    expect(fileEntry).toBeDefined();
    expect(fileEntry.original_name).toBe("test.pdf");
  });

  // TN2: A file row seeded without original_name returns null (migration is
  //      additive nullable — existing rows are unaffected).
  test("TN2: file seeded without original_name returns original_name: null (backward-compat)", async () => {
    // Insert directly into the response_files table, omitting original_name.
    const responseRow = await arcEvalModel.ensureVendorResponseRow(tnClauseId, VENDOR_A);
    const { rows } = await db.result(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, $2) RETURNING *`,
      [responseRow.id, "https://test-bucket.s3.ap-south-1.amazonaws.com/arc-tech-evidence/legacy.pdf"]
    );
    const legacyFile = rows[0];
    expect(legacyFile.original_name).toBeNull();

    // Confirm getVendorTechEnvelope surfaces null for that file.
    const envelope = await arcEvalModel.getVendorTechEnvelope(tnArcId, VENDOR_A);
    const clauseRow = envelope.clauses.find((c) => Number(c.clause_id) === tnClauseId);
    const legacyEntry = (envelope.filesByResponse[Number(clauseRow.response_id)] || [])
      .find((f) => Number(f.file_id) === Number(legacyFile.id));
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry.original_name).toBeNull();
  });

  // TN3: Non-invited vendor uploading evidence via HTTP gets 403.
  //      The scope guard fires before S3, so this is testable without real AWS creds.
  test("TN3: non-invited vendor uploading evidence gets 403 (scope guard before S3)", async () => {
    // .attach() makes supertest emit a multipart/form-data body with the correct
    // boundary; do NOT manually override Content-Type or the boundary is lost.
    const res = await epsilonClient2
      .post(`${VENDOR_BASE}/tech-envelope/clause/${tnClauseId}/file`)
      .attach("file", Buffer.from("%PDF-1.4 fake"), "evidence.pdf");
    expect(res.status).toBe(403);
  });
});
