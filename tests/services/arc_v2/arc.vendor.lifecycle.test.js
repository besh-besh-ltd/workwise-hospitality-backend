// ARC v2 — vendor lifecycle endpoint (GET /vendor/requests/:arcId/lifecycle)
//
// Tests the new vendor-projected lifecycle endpoint introduced by the
// vendor-side rate-contract quote page feature.
//
// Product-level: real Express + Postgres. No mocks.
//
// Vendor fixture users (from ids.js):
//   vendor_alpha (80101) — active subscription, invited → happy path
//   vendor_epsilon (80105) — NOT invited to this ARC → 403 case
//
// Category used: BEVERAGES (215) with ARC floated, open submission window.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedAutoApproveArcPolicy, cleanupArcPublishPolicy } from "../../helpers/arcPublishPolicy.js";

describe("ARC v2 — vendor lifecycle endpoint security + correctness", () => {
  const BUYER     = IDS.users.a1_proc_buyer;
  const HC        = IDS.hospitality.A;
  const HOTEL     = IDS.hotels.A1;
  const DEPT      = IDS.departments.proc;
  const CATEGORY  = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const PUBLISH_POLICY_ID = 64923; // auto-approve ARC policy so publish floats

  let buyerClient, alphaClient, epsilonClient;
  let arcId, itemId;
  const createdArcIds = [];

  async function createAndPublish({ title }) {
    const today = new Date();
    const res = await buyerClient.post("/api/v1/arc-v2").send({
      title,
      category_id: CATEGORY,
      hotel_id:    HOTEL,
      department_id: DEPT,
      eligibility_type: "open",
      submission_start_at: new Date(today.getTime() - 2 * 86400_000).toISOString(),
      submission_end_at:   new Date(today.getTime() + 10 * 86400_000).toISOString(),
      contract_start_at:   new Date(today.getTime() + 30 * 86400_000).toISOString(),
      contract_end_at:     new Date(today.getTime() + 365 * 86400_000).toISOString(),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    const id     = Number(res.body.data.arc.id);
    const iId    = Number(res.body.data.items[0].id);
    createdArcIds.push(id);
    const pub = await buyerClient.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    return { id, itemId: iId };
  }

  beforeAll(async () => {
    // Ensure dept-category mapping and correct user types.
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[IDS.users.vendor_alpha, IDS.users.vendor_epsilon]]
    );

    buyerClient  = await httpClient(BUYER);
    alphaClient  = await httpClient(IDS.users.vendor_alpha);
    epsilonClient = await httpClient(IDS.users.vendor_epsilon);

    // Auto-approve ARC publish policy so /publish floats immediately (pre-gate intent).
    await seedAutoApproveArcPolicy({
      policyId: PUBLISH_POLICY_ID, hospitalityCompanyId: HC, hotelId: HOTEL,
      departmentId: null, processId: null, createdBy: BUYER, approver: BUYER,
    });

    ({ id: arcId, itemId } = await createAndPublish({ title: "Vendor lifecycle · beverages" }));
  });

  afterAll(async () => {
    await cleanupArcPublishPolicy({ policyId: PUBLISH_POLICY_ID, arcIds: createdArcIds });
    if (createdArcIds.length) {
      await db.none(
        `DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`,
        [createdArcIds.map(String)]
      );
      await db.none(
        `DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN
           (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  // ── HAPPY PATH ─────────────────────────────────────────────────────────────

  test("happy path — invited vendor gets 200 with 5 stage keys, default_stage, and vendor_action", async () => {
    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d).toBeDefined();

    // Must have the 5 stage keys.
    const stageKeys = d.stages.map((s) => s.key);
    expect(stageKeys).toContain("overview");
    expect(stageKeys).toContain("technical");
    expect(stageKeys).toContain("commercial");
    expect(stageKeys).toContain("awarding");
    expect(stageKeys).toContain("active");
    expect(stageKeys).toHaveLength(5);

    // default_stage must be present and be one of the 5 keys.
    expect(d.default_stage).toBeDefined();
    expect(stageKeys).toContain(d.default_stage);

    // Each stage must carry a vendor_action field.
    for (const stage of d.stages) {
      expect(stage).toHaveProperty("vendor_action");
    }

    // Arc summary must be present.
    expect(d.arc).toBeDefined();
    expect(Number(d.arc.id)).toBe(arcId);
    expect(d.current_status).toBeDefined();
  });

  // ── SECURITY / PROJECTION ──────────────────────────────────────────────────

  test("security — response does NOT contain buyer-internal or other-vendor fields", async () => {
    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const bodyStr = JSON.stringify(res.body);

    // These buyer-internal fields must not appear anywhere in the payload.
    expect(bodyStr).not.toContain("vendors_in_play");
    expect(bodyStr).not.toContain("vendors_fully_scored");
    expect(bodyStr).not.toContain("items_allocated");

    // No approval-instance objects.
    expect(bodyStr).not.toContain("approval_instance");
    expect(bodyStr).not.toContain("approval_step");

    // No allocation matrix or other-vendor data.
    expect(bodyStr).not.toContain("allocation");

    // Each stage should only have vendor-safe keys (key, label, state, reason, vendor_action + allowed extras).
    // terms_accepted_at is the requesting vendor's OWN T&C acceptance timestamp (Phase 1 §3),
    // emitted only on the 'overview' stage. It is the vendor's own fact — not competitor data,
    // not buyer-internal data — so it is safe to include here.
    const allowedTopKeys = new Set([
      "key", "label", "state", "reason", "vendor_action",
      "window", "tech_submitted_at", "submitted_at", "withdrawn_at",
      "terms_accepted_at",
    ]);
    for (const stage of res.body.data.stages) {
      for (const k of Object.keys(stage)) {
        expect(allowedTopKeys.has(k)).toBe(true);
      }
    }
  });

  // ── AUTHORIZATION ──────────────────────────────────────────────────────────

  test("authorization — non-invited vendor gets 403 (scope from req.user, not client)", async () => {
    // epsilon is NOT invited to this ARC.
    const res = await epsilonClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect([403, 404]).toContain(res.status);
  });

  // ── ACTIONABILITY ─────────────────────────────────────────────────────────

  test("actionability — window open: default_stage=commercial, commercial.vendor_action=submit_quote", async () => {
    // Phase 1 §3 — terms must be accepted before commercial is reachable.
    // This ARC has no tech clauses, so accepting terms → commercial is immediately active.
    const terms = await alphaClient
      .post("/api/v1/arc-v2/vendor/quote/accept-terms")
      .send({ arc_id: arcId });
    expect(terms.status).toBe(200);

    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const d = res.body.data;
    // While the submission window is open and no quote submitted, vendor should focus on 'commercial'.
    expect(d.default_stage).toBe("commercial");

    const commercial = d.stages.find((s) => s.key === "commercial");
    expect(commercial).toBeDefined();
    expect(commercial.vendor_action).toBe("submit_quote");
  });

  test("actionability — after quote submit: commercial.state=complete, reason=quote_submitted, vendor_action=none", async () => {
    // Phase 1 §3 — terms acceptance is idempotent; call it again here so this test
    // is self-contained even if ordering changes. The COALESCE guard means calling
    // it multiple times preserves the original timestamp.
    const terms = await alphaClient
      .post("/api/v1/arc-v2/vendor/quote/accept-terms")
      .send({ arc_id: arcId });
    expect(terms.status).toBe(200);

    // Save a draft line then submit.
    const draft = await alphaClient.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId,
      lines: [{ arc_item_id: itemId, rate: 150, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);

    const submit = await alphaClient.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(submit.status).toBe(200);

    // Now check lifecycle reflects submitted state.
    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const commercial = res.body.data.stages.find((s) => s.key === "commercial");
    expect(commercial.state).toBe("complete");
    expect(commercial.reason).toBe("quote_submitted");
    expect(commercial.vendor_action).toBe("none");
    expect(commercial.submitted_at).toBeTruthy();
  });

  // ── D2 REGRESSION: submit → withdraw → re-quote ────────────────────────────

  test("D2 — after withdraw (submitted_at + withdrawn_at both set), lifecycle returns commercial back to actionable (vendor_action=submit_quote)", async () => {
    // Phase 1 §3 — idempotent terms call ensures this test is self-contained
    // regardless of execution order; COALESCE preserves the original timestamp.
    const terms = await alphaClient
      .post("/api/v1/arc-v2/vendor/quote/accept-terms")
      .send({ arc_id: arcId });
    expect(terms.status).toBe(200);

    // At this point, the quote is already submitted from the previous test
    // (tests share the same arcId). Withdraw it now.
    const withdraw = await alphaClient.post("/api/v1/arc-v2/vendor/quote/withdraw").send({ arc_id: arcId });
    expect(withdraw.status).toBe(200);

    // Both submitted_at and withdrawn_at are now set on the quote row.
    // Before the D2 fix, quoteWithdrawn = withdrawn_at && !submitted_at = false,
    // so quoteSubmitted fired and returned state:'complete'/vendor_action:'none'.
    // After the fix, withdrawn wins: quoteWithdrawn = !!withdrawn_at = true,
    // quoteSubmitted = submitted_at && !withdrawn_at = false.
    // The projector should reach the withdrawn_reopen branch.

    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const commercial = res.body.data.stages.find((s) => s.key === "commercial");
    expect(commercial).toBeDefined();

    // Regression assertion: must NOT be locked in "submitted" state.
    expect(commercial.state).not.toBe("complete");
    expect(commercial.vendor_action).not.toBe("none");

    // Must be back to actionable — vendor can re-quote.
    expect(commercial.vendor_action).toBe("submit_quote");
    expect(commercial.reason).toBe("withdrawn_reopen");
  });

  // ── D2 COMPLETION: re-submit after withdrawal clears withdrawn_at ──────────

  test("D2 completion — re-submit after withdrawal: commercial returns to state='complete', vendor_action='none' (withdrawn_at cleared)", async () => {
    // Phase 1 §3 — idempotent terms call ensures this test is self-contained.
    const terms = await alphaClient
      .post("/api/v1/arc-v2/vendor/quote/accept-terms")
      .send({ arc_id: arcId });
    expect(terms.status).toBe(200);

    // Quote is currently withdrawn (withdrawn_at set, submitted_at still set).
    // Re-save the draft lines (idempotent upsert) and re-submit.
    const draft = await alphaClient.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId,
      lines: [{ arc_item_id: itemId, rate: 175, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);

    const submit = await alphaClient.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(submit.status).toBe(200);

    // Lifecycle should now reflect clean submitted state — withdrawn_at cleared by submitQuote.
    const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const commercial = res.body.data.stages.find((s) => s.key === "commercial");
    expect(commercial).toBeDefined();

    // The D2 completion fix ensures submitted_at is set + withdrawn_at = NULL,
    // so the projector returns quoteSubmitted=true → state:'complete', vendor_action:'none'.
    expect(commercial.state).toBe("complete");
    expect(commercial.vendor_action).toBe("none");
    expect(commercial.reason).toBe("quote_submitted");

    // withdrawn_at must be NULL — confirmed by the lifecycle payload exposing it.
    // The endpoint includes withdrawn_at on the commercial stage (see allowedTopKeys test).
    expect(commercial.withdrawn_at).toBeFalsy();

    // submitted_at must be set and truthy — proving the re-submit landed.
    expect(commercial.submitted_at).toBeTruthy();
  });
});
