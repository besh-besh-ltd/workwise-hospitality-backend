// ARC v2 — Blind technical evaluation (anti-favoritism).
//
// Proves the server-side identity redaction the coder added across the
// technical-evaluation AND tech-approval phases (RESOLVED DECISIONS 1-7 +
// SECURITY MANDATE). During TECH eval + tech approval, every buyer-facing
// response must carry ONLY a stable per-ARC alias ("Vendor A/B/C") — never the
// real name / email / company / avatar / initials / vendor_id / file_url. The
// reveal happens at COMMERCIAL (getCommEval + downstream). Always-on. The
// vendor's self-view of their OWN identity is preserved.
//
// Mapped test cases (see .pipeline/spec.md §7 + the TESTER brief):
//   1.  getTechEvalForItem — real name/email/company/vendor_id ABSENT from the
//       serialized body; each response row carries a "Vendor X" label + key.
//   2.  scoreResponse — echo does not leak real vendor_id/name.
//   3.  decideTechEval scores[] — aliased; approver stays blind.
//   4.  file_url ABSENT from the tech matrix (file_id present).
//   5.  Alias stability — same vendor → same alias across TWO items + repeated
//       calls.
//   6.  Evaluator == approver — the alias for a vendor via getTechEvalForItem
//       equals the alias in decide scores[].
//   7.  NOT vendor_id-ordered — vendor_beta (higher id) submits FIRST ⇒ it is
//       "Vendor A", proving submission-order aliasing (verified against the DB
//       row + the HTTP label).
//   8.  Reveal at commercial — getCommEval carries real names + vendor_id; the
//       disqualified-vendor price redaction still holds.
//   9.  Vendor self-view preserved — a vendor reading their OWN portal envelope
//       still sees their own data, un-blinded.
//   10. Permissions — a buyer without arc-tech perms is denied the tech read.
//
// Product-level: real Express app + local Postgres. Assertions on HTTP + DB
// rows only (never on internal call counts).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_techApp;
const NOPERM_BUYER = IDS.users.a1_eng_buyer; // buyer with NO arc-tech role here
const VENDOR_ALPHA = IDS.users.vendor_alpha; // 80101 (lower id)
const VENDOR_BETA  = IDS.users.vendor_beta;  // 80102 (higher id) — submits FIRST
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const TECH_POLICY_ID = 64930;

const E = "/api/v1/arc-v2/evaluation";
const VENDOR_BASE = "/api/v1/arc-v2/vendor";

// Distinctive real-identity sentinels stamped onto the two vendor users in
// beforeAll and restored in afterAll. If ANY of these strings appears in a
// technical-phase JSON body, identity has leaked → the case FAILS.
const SENTINEL = {
  [VENDOR_ALPHA]: {
    name: "ZZALPHASENTINELNAME",
    email: "zzalpha.sentinel@leakcheck.invalid",
    org: "ZZAlphaSentinelOrg",
  },
  [VENDOR_BETA]: {
    name: "ZZBETASENTINELNAME",
    email: "zzbeta.sentinel@leakcheck.invalid",
    org: "ZZBetaSentinelOrg",
  },
};

describe("ARC v2 — blind technical evaluation (anti-favoritism)", () => {
  let buyerClient, approverClient, noPermClient, betaVendorClient;
  // ARC with TWO items (for cross-item alias stability), each with one
  // weighted clause. Two vendors respond; vendor_beta seals tech FIRST.
  let arcId;
  let itemId1, teId1, clause1, respAlpha1, respBeta1;
  let itemId2, teId2, clause2, respAlpha2, respBeta2;
  let evidenceFileId; // seeded evidence row, to assert file_url absence.
  const savedUsers = {}; // original name/email/org for restore.

  async function seedClause(teId, text, weight, mandatory = false, type = "compliance") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teId, text, weight, type, mandatory])).id);
  }
  async function seedResponse(clauseId, vendorId, vendorResponse = "submitted") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3) RETURNING id`,
      [clauseId, vendorId, vendorResponse])).id);
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`,
      [[BUYER, APPROVER, NOPERM_BUYER]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_ALPHA, VENDOR_BETA]]);

    // Stamp distinctive sentinels onto the two vendors; remember the originals.
    for (const vid of [VENDOR_ALPHA, VENDOR_BETA]) {
      const orig = await db.one(
        `SELECT name, email, organization_name FROM tbl_users WHERE id = $1`, [vid]);
      savedUsers[vid] = orig;
      await db.none(
        `UPDATE tbl_users SET name = $2, email = $3, organization_name = $4 WHERE id = $1`,
        [vid, SENTINEL[vid].name, SENTINEL[vid].email, SENTINEL[vid].org]);
    }

    buyerClient      = await httpClient(BUYER);
    approverClient   = await httpClient(APPROVER);
    noPermClient     = await httpClient(NOPERM_BUYER);
    betaVendorClient = await httpClient(VENDOR_BETA);
    // Only BUYER gets arc-tech/comm perms; NOPERM_BUYER deliberately has none.
    await seedArcEvalPerms(db, [BUYER]);

    // ARC_TECH policy so submitTechEval can spawn the approval instance and the
    // approver can decide.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_TECH', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [TECH_POLICY_ID, HC, HOTEL, BUYER, PROC]);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [TECH_POLICY_ID, APPROVER]);

    // ARC — submission closed, ready to score.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-BLIND-1', 'Blind tech eval', $1, $2, $3, $4, $5, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = Number(arc.id);

    // Item 1 + tech eval + one weighted clause; both vendors respond.
    itemId1 = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100) RETURNING id`, [arcId, VARIANT_ID])).id);
    teId1 = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId1])).id);
    clause1 = await seedClause(teId1, "Quality SOP item1", 100, false, "spec");
    respAlpha1 = await seedResponse(clause1, VENDOR_ALPHA, "alpha answer item1");
    respBeta1  = await seedResponse(clause1, VENDOR_BETA, "beta answer item1");

    // Item 2 + tech eval + one weighted clause; both vendors respond.
    // tbl_arc_item is UNIQUE on (arc_id, product_variant_id) — item2 needs a
    // distinct variant (1 and 2 are both seeded beverages).
    itemId2 = Number((await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 500, 'litre', 80) RETURNING id`, [arcId, VARIANT_ID + 1])).id);
    teId2 = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`, [itemId2])).id);
    clause2 = await seedClause(teId2, "Quality SOP item2", 100, false, "spec");
    respAlpha2 = await seedResponse(clause2, VENDOR_ALPHA, "alpha answer item2");
    respBeta2  = await seedResponse(clause2, VENDOR_BETA, "beta answer item2");

    // Evidence file on vendor_alpha's item1 response — used to prove file_url
    // is dropped from the tech matrix payload (only file_id survives).
    evidenceFileId = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response_files
         (arc_item_tech_evaluation_vendors_response_id, file_url)
       VALUES ($1, 'https://leakcheck.invalid/ZZALPHASENTINELNAME-evidence.pdf') RETURNING id`,
      [respAlpha1])).id);

    // Quotes: vendor_beta seals its tech envelope FIRST (earlier
    // tech_submitted_at) despite having the HIGHER vendor_id. This is the crux
    // of case 7 — the alias is submission-ordered, NOT vendor_id-ordered, so
    // beta (80102) must become "Vendor A" (alias_index 0).
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW(), NOW() - INTERVAL '2 hours')
       ON CONFLICT (arc_id, vendor_id) DO UPDATE SET tech_submitted_at = EXCLUDED.tech_submitted_at`,
      [arcId, VENDOR_BETA]);
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW(), NOW() - INTERVAL '1 hour')
       ON CONFLICT (arc_id, vendor_id) DO UPDATE SET tech_submitted_at = EXCLUDED.tech_submitted_at`,
      [arcId, VENDOR_ALPHA]);
    // Quote lines for comm-eval (case 8).
    for (const [vendor, rate] of [[VENDOR_ALPHA, 90], [VENDOR_BETA, 95]]) {
      const q = await db.one(`SELECT id FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`, [arcId, vendor]);
      for (const it of [itemId1, itemId2]) {
        await db.none(
          `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
           VALUES ($1, $2, $3, 5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`,
          [q.id, it, rate]);
      }
    }
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       VALUES ($1,$2,'submitted'),($1,$3,'submitted') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [arcId, VENDOR_ALPHA, VENDOR_BETA]);
  });

  afterAll(async () => {
    const arcIds = [arcId];
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = ANY($1::bigint[])`,
      [arcIds])).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_tech_eval_edit_history WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_vendor_alias WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation_history WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_cleared_vendors
                    WHERE arc_item_tech_evaluation_id = ANY($1::bigint[])`, [[teId1, teId2]]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files
                    WHERE arc_item_tech_evaluation_vendors_response_id = ANY($1::bigint[])`,
      [[respAlpha1, respBeta1, respAlpha2, respBeta2]]);
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);
    await cleanupArcEvalPerms(db, [BUYER]);
    // Restore the vendors' real identity strings.
    for (const vid of [VENDOR_ALPHA, VENDOR_BETA]) {
      const o = savedUsers[vid];
      if (o) {
        await db.none(
          `UPDATE tbl_users SET name = $2, email = $3, organization_name = $4 WHERE id = $1`,
          [vid, o.name, o.email, o.organization_name]);
      }
    }
  });

  // Scan a serialized body for ANY of the seeded real-identity sentinels.
  function assertNoIdentityLeak(body) {
    const blob = JSON.stringify(body);
    for (const vid of [VENDOR_ALPHA, VENDOR_BETA]) {
      expect(blob).not.toContain(SENTINEL[vid].name);
      expect(blob).not.toContain(SENTINEL[vid].email);
      expect(blob).not.toContain(SENTINEL[vid].org);
    }
    // The real vendor_id must be absent as a "vendor_id" field value too. We
    // can't ban the bare integer everywhere (response_ids etc. differ), so we
    // assert there is no `"vendor_id"` KEY anywhere in the tech body.
    expect(blob).not.toMatch(/"vendor_id"/);
  }

  // ── Case 1 — getTechEvalForItem redaction + alias labels/keys ──
  test("1. getTechEvalForItem hides real name/email/company/vendor_id; emits Vendor X alias + key", async () => {
    const res = await buyerClient.get(`${E}/items/${itemId1}/tech-eval`);
    expect(res.status).toBe(200);
    const { responses, scores } = res.body.data;
    expect(responses.length).toBe(2);

    // Network-shaped leak check: NO real identity anywhere in the body.
    assertNoIdentityLeak(res.body.data);

    // Every response row carries a stable alias label + key, and NO vendor_id.
    for (const r of responses) {
      expect(r.vendor_alias).toMatch(/^Vendor [A-Z]+$/);
      expect(r.vendor_alias_key).toEqual(expect.any(Number));
      expect(r).not.toHaveProperty("vendor_id");
      expect(r).not.toHaveProperty("vendor_name");
    }
    // Both distinct vendors surface as distinct aliases ("Vendor A" + "Vendor B").
    const labels = new Set(responses.map((r) => r.vendor_alias));
    expect(labels.has("Vendor A")).toBe(true);
    expect(labels.has("Vendor B")).toBe(true);

    // scores[] are aliased too (no vendor_id key).
    for (const s of scores) {
      expect(s.vendor_alias).toMatch(/^Vendor [A-Z]+$/);
      expect(s).not.toHaveProperty("vendor_id");
    }
  });

  // ── Case 2 — scoreResponse echo never leaks real vendor_id/name ──
  test("2. scoreResponse echo carries the alias, never the real vendor_id/name", async () => {
    const res = await buyerClient.post(`${E}/tech-eval/score`).send({
      response_id: respAlpha1, buyer_marks: 80,
    });
    expect(res.status).toBe(200);
    const echo = res.body.data.response;
    // The model returns the row with PK `id` (a numeric string from pg). The
    // echo must point back at the scored response — and carry NO real id.
    expect(Number(echo.id)).toBe(respAlpha1);
    expect(echo.vendor_alias).toMatch(/^Vendor [A-Z]+$/);
    expect(echo.vendor_alias_key).toEqual(expect.any(Number));
    expect(echo).not.toHaveProperty("vendor_id");
    expect(echo).not.toHaveProperty("vendor_name");
    assertNoIdentityLeak(res.body.data);
  });

  // ── Case 4 — file_url dropped from the tech matrix payload (file_id kept) ──
  test("4. tech matrix files carry file_id only — no raw file_url (S3 key sealed)", async () => {
    const res = await buyerClient.get(`${E}/items/${itemId1}/tech-eval`);
    expect(res.status).toBe(200);
    const blob = JSON.stringify(res.body.data);
    // The seeded S3 URL (which embeds a vendor-identifying name) must be absent.
    expect(blob).not.toContain("leakcheck.invalid");
    expect(blob).not.toContain("file_url");
    // The evidence file is still reachable via its file_id handle.
    const withFile = res.body.data.responses.find((r) => (r.files || []).length > 0);
    expect(withFile).toBeTruthy();
    const f = withFile.files[0];
    expect(f.file_id).toBe(evidenceFileId);
    expect(f).not.toHaveProperty("file_url");
  });

  // ── Case 5 — alias stability across TWO items + repeated calls ──
  test("5. same vendor → same alias across two items and across repeated GETs", async () => {
    // Build alias_key → alias_label maps for item1 (two reads) and item2.
    const read = async (itemId) => {
      const r = await buyerClient.get(`${E}/items/${itemId}/tech-eval`);
      expect(r.status).toBe(200);
      const m = new Map();
      for (const row of r.body.data.responses) m.set(row.vendor_alias_key, row.vendor_alias);
      return m;
    };
    const item1a = await read(itemId1);
    const item1b = await read(itemId1);
    const item2  = await read(itemId2);

    // Repeated calls on the same item are identical.
    expect([...item1a.entries()].sort()).toEqual([...item1b.entries()].sort());
    // Cross-item: every alias_key maps to the SAME label in both items.
    for (const [key, label] of item1a.entries()) {
      expect(item2.get(key)).toBe(label);
    }
    // And both items expose the same two keys.
    expect([...item1a.keys()].sort()).toEqual([...item2.keys()].sort());
  });

  // ── Case 7 — NOT vendor_id-ordered: beta (higher id) submitted FIRST → Vendor A ──
  test("7. alias is submission-ordered, not vendor_id-ordered (beta is Vendor A)", async () => {
    // Ground truth from the alias table: vendor_beta (higher id) sealed tech
    // FIRST, so it must own alias_index 0; vendor_alpha (lower id) owns index 1.
    const betaRow = await db.one(
      `SELECT alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_BETA]);
    const alphaRow = await db.one(
      `SELECT alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1 AND vendor_id = $2`,
      [arcId, VENDOR_ALPHA]);
    expect(Number(betaRow.alias_index)).toBe(0);  // first submitter
    expect(Number(alphaRow.alias_index)).toBe(1);
    // Sanity: this is the OPPOSITE of vendor_id ordering (beta id > alpha id).
    expect(VENDOR_BETA).toBeGreaterThan(VENDOR_ALPHA);

    // Now correlate the HTTP label with the underlying vendor. We scored
    // vendor_alpha's item1 response (respAlpha1, marks 80) in case 2, so the
    // matrix row for that response_id is unambiguously alpha → its alias must be
    // "Vendor B" (index 1), while the OTHER row (beta) must be "Vendor A".
    const res = await buyerClient.get(`${E}/items/${itemId1}/tech-eval`);
    // response_id arrives as a numeric string from pg — compare numerically.
    const alphaRowHttp = res.body.data.responses.find((r) => Number(r.response_id) === respAlpha1);
    const betaRowHttp  = res.body.data.responses.find((r) => Number(r.response_id) === respBeta1);
    expect(alphaRowHttp.vendor_alias).toBe("Vendor B");
    expect(alphaRowHttp.vendor_alias_key).toBe(1);
    expect(betaRowHttp.vendor_alias).toBe("Vendor A"); // higher-id vendor, but FIRST → A
    expect(betaRowHttp.vendor_alias_key).toBe(0);
  });

  // ── Cases 3 + 6 — decide scores[] aliased; approver alias == evaluator alias ──
  test("3 + 6. decide scores[] are aliased (approver blind) and match the evaluator's aliases", async () => {
    // Capture the evaluator's alias_key → label map (covers both items).
    const evalMap = new Map();
    for (const itemId of [itemId1, itemId2]) {
      const r = await buyerClient.get(`${E}/items/${itemId}/tech-eval`);
      for (const row of r.body.data.responses) evalMap.set(row.vendor_alias_key, row.vendor_alias);
    }

    // Score the remaining responses so submit can record cleared_vendors.
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respBeta1, buyer_marks: 70 });
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respAlpha2, buyer_marks: 65 });
    await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respBeta2, buyer_marks: 75 });

    const submit = await buyerClient.post(`${E}/${arcId}/tech-eval/submit`).send({});
    expect(submit.status).toBe(200);

    // Approver decides WITH an amend (touches an item so decide returns scores[]).
    const decide = await approverClient.post(`${E}/${arcId}/tech-eval/decide`).send({
      decision: "approve",
      comment: "verified blind",
      amend: { marks: [{ response_id: respAlpha1, buyer_marks: 85 }] },
    });
    expect(decide.status).toBe(200);
    expect(decide.body.data.approval.status).toBe("APPROVED");

    const scores = decide.body.data.scores;
    expect(scores.length).toBeGreaterThan(0);
    // Approver stays blind: NO real identity, every score row aliased.
    assertNoIdentityLeak(decide.body.data.scores);
    for (const s of scores) {
      expect(s.vendor_alias).toMatch(/^Vendor [A-Z]+$/);
      expect(s).not.toHaveProperty("vendor_id");
      expect(s).not.toHaveProperty("vendor_name");
      // Case 6: the approver's alias for a key equals the evaluator's alias.
      expect(s.vendor_alias).toBe(evalMap.get(s.vendor_alias_key));
    }
  });

  // ── Case 8 — reveal at commercial (real names + vendor_id), redaction intact ──
  test("8. getCommEval reveals real vendor_name + vendor_id; disqualified price redacted", async () => {
    const ce = await buyerClient.get(`${E}/${arcId}/comm-eval`);
    expect(ce.status).toBe(200);
    const quotes = ce.body.data.quotes;
    expect(quotes.length).toBeGreaterThan(0);

    // The reveal: real names + vendor_id ARE present at commercial.
    const blob = JSON.stringify(ce.body.data);
    expect(blob).toContain(SENTINEL[VENDOR_ALPHA].name);
    expect(blob).toContain(SENTINEL[VENDOR_BETA].name);
    const alphaQ = quotes.find((q) => Number(q.vendor_id) === VENDOR_ALPHA);
    expect(alphaQ).toBeTruthy();
    expect(alphaQ.vendor_name).toBe(SENTINEL[VENDOR_ALPHA].name);

    // No alias fields bleed into the commercial reveal.
    expect(blob).not.toContain("vendor_alias");

    // Regression: the disqualified-vendor price-redaction gate still works. Make
    // one vendor technically disqualified on item1 by forcing its cleared row to
    // not_qualified, then assert its item1 line is redacted while a qualified
    // line keeps its rate.
    await db.none(
      `UPDATE tbl_arc_item_tech_evaluation_cleared_vendors
          SET status = 'not_qualified'
        WHERE arc_item_tech_evaluation_id = $1 AND vendor_id = $2 AND evaluation_round = 1`,
      [teId1, VENDOR_ALPHA]);
    const ce2 = await buyerClient.get(`${E}/${arcId}/comm-eval`);
    const dqLines = ce2.body.data.quotes.filter(
      (q) => Number(q.vendor_id) === VENDOR_ALPHA && Number(q.arc_item_id) === itemId1);
    expect(dqLines.length).toBeGreaterThan(0);
    expect(dqLines.every((q) => q.rate === null && q.technically_disqualified === true)).toBe(true);
    // A qualified vendor's line keeps its real rate (reveal + no redaction).
    const okLines = ce2.body.data.quotes.filter(
      (q) => Number(q.vendor_id) === VENDOR_BETA && Number(q.arc_item_id) === itemId1);
    expect(okLines.every((q) => q.rate !== null && !q.technically_disqualified)).toBe(true);
  });

  // ── Case 9 — vendor self-view preserved (un-blinded own envelope) ──
  test("9. a vendor reading their OWN tech envelope sees their own data, not an alias", async () => {
    const res = await betaVendorClient.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items.length).toBeGreaterThan(0);
    // The vendor sees their OWN authored response text (not blinded from self).
    const blob = JSON.stringify(res.body.data);
    expect(blob).toContain("beta answer item1");
    // No alias machinery is applied on the vendor side.
    expect(blob).not.toContain("vendor_alias");
    // Cross-vendor leak guard: the OTHER vendor's answer never appears here.
    expect(blob).not.toContain("alpha answer item1");
  });

  // ── Case 10 — permissions unchanged (light regression; controller was touched) ──
  test("10. a buyer without arc-tech permission is denied getTechEvalForItem", async () => {
    const res = await noPermClient.get(`${E}/items/${itemId1}/tech-eval`);
    expect(res.status).toBe(403);
    // No identity (or clause data) leaks through the denial body.
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL[VENDOR_ALPHA].name);
  });

  // ── Case 11 — getTechEvalApproval (chain + edit history) leaks no vendor identity ──
  // (Reviewer gap.) The edit-history join is on `changed_by` (the BUYER editor),
  // not the vendor — but an amend touches a vendor's response, so we seed a real
  // edit-history row pointing at vendor_alpha's response and assert the approval
  // body still carries NO vendor name/email/org.
  test("11. the tech-eval approval body (chain + edit history) carries no vendor identity", async () => {
    // Seed an edit-history row referencing vendor_alpha's response (as an amend would).
    const editId = Number((await db.one(
      `INSERT INTO tbl_arc_tech_eval_edit_history
         (arc_id, response_id, field_changed, before_value, after_value, changed_by, comment)
       VALUES ($1, $2, 'buyer_marks', $3::jsonb, $4::jsonb, $5, 'amend during approval')
       RETURNING id`,
      [arcId, respAlpha1, JSON.stringify(40), JSON.stringify(80), APPROVER])).id);
    try {
      const res = await buyerClient.get(`${E}/${arcId}/tech-eval/approval`);
      expect(res.status).toBe(200);
      const blob = JSON.stringify(res.body);
      // Neither vendor's real identity may appear anywhere in the approval body.
      for (const vid of [VENDOR_ALPHA, VENDOR_BETA]) {
        expect(blob).not.toContain(SENTINEL[vid].name);
        expect(blob).not.toContain(SENTINEL[vid].email);
        expect(blob).not.toContain(SENTINEL[vid].org);
      }
    } finally {
      await db.none(`DELETE FROM tbl_arc_tech_eval_edit_history WHERE id = $1`, [editId]);
    }
  });

  // ── Case 12 — the evidence proxy never echoes the vendor-identifying S3 key ──
  // (Reviewer gap.) The seeded file_url literally embeds vendor_alpha's sentinel
  // ("ZZALPHASENTINELNAME-evidence.pdf"). The proxy must serve a SYNTHETIC
  // filename ("evidence-<id>") and never surface the raw key — in headers OR
  // body — regardless of whether the S3 fetch succeeds (it 502s in CI: no creds).
  test("12. the evidence proxy uses a synthetic filename and never leaks the S3 key", async () => {
    const res = await buyerClient.get(`${E}/tech-eval/evidence/${evidenceFileId}`);
    const headerBlob = JSON.stringify(res.headers || {});
    const bodyBlob = typeof res.text === "string" ? res.text : JSON.stringify(res.body || {});
    // The vendor sentinel that's embedded in the stored S3 url must NOT surface.
    expect(headerBlob).not.toContain(SENTINEL[VENDOR_ALPHA].name);
    expect(bodyBlob).not.toContain(SENTINEL[VENDOR_ALPHA].name);
    // If a Content-Disposition was set, it must be the synthetic form.
    const cd = res.headers?.["content-disposition"];
    if (cd) {
      expect(cd).toContain(`evidence-${evidenceFileId}`);
      expect(cd).not.toContain(".pdf"); // the raw key's extension never echoed
    }
  });

  // ── Case 13 — a 3rd vendor gets a distinct blind alias; aliasing is append-only ──
  // (Reviewer gap: 3rd vendor + round-safe persistence.) A vendor appearing later
  // must get the NEXT index ("Vendor C") without reshuffling the existing A/B —
  // the same guarantee that keeps aliases stable across re-evaluation rounds.
  test("13. a later 3rd vendor becomes 'Vendor C' and the existing aliases are unchanged", async () => {
    const GAMMA = IDS.users.vendor_gamma; // 80103
    const GAMMA_SENTINEL = "ZZGAMMASENTINELNAME";
    const origGamma = await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [GAMMA]);
    // Snapshot the existing aliases (assigned by earlier cases' reads).
    const before = await db.any(
      `SELECT vendor_id, alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1 ORDER BY alias_index`, [arcId]);
    const aliasOf = (rows, vid) => rows.find((r) => Number(r.vendor_id) === vid)?.alias_index;

    await db.none(`UPDATE tbl_users SET name = $2 WHERE id = $1`, [GAMMA, GAMMA_SENTINEL]);
    const gammaResp = Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, 'gamma answer') RETURNING id`, [clause1, GAMMA])).id);
    // Sr 54 (GROUP K) — the technical-evaluation set is now gated to the
    // commercial-ranked shortlist: a vendor with a sealed tech envelope but NO
    // commercial quote is unrankable and is correctly EXCLUDED from tech-eval
    // (see arc.techShortlist.test.js). Gamma must be a COMPLETE, rankable bid
    // (tech envelope + commercial quote) to re-enter the shortlist here, same
    // as alpha/beta's seeding above — this is a seed fix, not a loosening of
    // the blind-alias assertion below (gamma's real name must still never leak).
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (arc_id, vendor_id) DO UPDATE SET tech_submitted_at = EXCLUDED.tech_submitted_at`,
      [arcId, GAMMA]);
    const gammaQuote = await db.one(`SELECT id FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`, [arcId, GAMMA]);
    for (const it of [itemId1, itemId2]) {
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`,
        [gammaQuote.id, it, 92]);
    }
    // The shortlist was already computed+persisted (alpha+beta only) by the
    // very first getTechEvalForItem call earlier in this file (Sr 54's lazy
    // backstop only computes ONCE per ARC — ensureShortlist is a no-op once
    // any row exists, by design, since in real usage all commercial quotes are
    // sealed before submission closes and the shortlist is ever read). Gamma's
    // quote above simulates a bid that's now complete; clear the stale
    // 2-vendor snapshot so the upcoming read recomputes fresh over all 3
    // complete bids (alpha, beta, gamma — all <=5, so all end up in_eval).
    await db.none(`DELETE FROM tbl_arc_tech_shortlist WHERE arc_id = $1`, [arcId]);
    try {
      // Reading the matrix assigns gamma an alias.
      const res = await buyerClient.get(`${E}/items/${itemId1}/tech-eval`);
      expect(res.status).toBe(200);
      const blob = JSON.stringify(res.body);
      // Gamma is blind too — its real name must not appear.
      expect(blob).not.toContain(GAMMA_SENTINEL);

      const after = await db.any(
        `SELECT vendor_id, alias_index FROM tbl_arc_vendor_alias WHERE arc_id = $1 ORDER BY alias_index`, [arcId]);
      // Existing vendors KEEP their alias_index (append-only / round-safe).
      for (const r of before) {
        expect(aliasOf(after, Number(r.vendor_id))).toBe(r.alias_index);
      }
      // Gamma got the NEXT index = previous max + 1, and surfaces as that label.
      const gammaIdx = aliasOf(after, GAMMA);
      const prevMax = Math.max(...before.map((r) => Number(r.alias_index)));
      expect(gammaIdx).toBe(prevMax + 1);
      // With beta=A(0) and alpha=B(1) from earlier, gamma is the 3rd ⇒ "Vendor C".
      const labels = (res.body.data.scores || []).map((s) => s.vendor_alias);
      expect(labels).toContain("Vendor C");
    } finally {
      await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_vendors_response WHERE id = $1`, [gammaResp]);
      await db.none(`DELETE FROM tbl_arc_vendor_alias WHERE arc_id = $1 AND vendor_id = $2`, [arcId, GAMMA]);
      await db.none(`UPDATE tbl_users SET name = $2 WHERE id = $1`, [GAMMA, origGamma.name]);
    }
  });
});
