/**
 * Purchase Requisitions in the company activity trail (PR Task 11).
 *
 * Product-level: real PR requests over real HTTP, then the trail read back the
 * way an admin reads it (GET /api/v1/activity). What matters here:
 *   - the PR mutations land under their own category, as entity PR/<id>, in the
 *     company and unit the PR belongs to (derived from the PR row);
 *   - the company-admin review-routing changes, which no PR event covers, are
 *     recorded too;
 *   - the trail is company-scoped and admin-only: a plain buyer cannot read it
 *     and another company's admin sees none of it;
 *   - no PR route is left unnamed (a new route added without an entry fails).
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, cleanupPrs, makePrPolicy, dropPrPolicies, unmapAll, draftBody, firstUsableVariant,
} from "../helpers/prFixtures.js";
import PrRoutes from "../../app/routes/pr/index.js";
import { lookupEvent, CATEGORIES } from "../../app/services/activity/eventRegistry.js";
import { getUncataloguedRoutes, resetUncataloguedRoutes } from "../../app/middleware/activityCapture.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP1 = IDS.users.a1_proc_commApp;
const ADMIN_A = IDS.users.companyA_admin;
const ADMIN_B = IDS.users.companyB_admin;
const PERSONAS = [REQ, AP1];
const CATEGORY = "Purchase Requisitions";

const prIds = [];
let originalTypes = [];
let reqC, ap1C, adminAC, adminBC;
let routingMapId = null;

const eventsSince = (since) =>
  db.any(
    `SELECT event_key, category, severity, actor_user_id, hospitality_company_id, hotel_id,
            entity_type, entity_id::int AS entity_id, entity_label, summary, route_pattern, http_method, status_code
       FROM tbl_activity_events WHERE occurred_at >= $1 ORDER BY id`,
    [since]
  );

// Capture runs on the response's `finish`, a moment after the client has its answer.
const waitForEvent = async (since, predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await eventsSince(since)).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  originalTypes = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[...PERSONAS, ADMIN_A, ADMIN_B]]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = ANY($1::int[])`, [[ADMIN_A, ADMIN_B]]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP1, "PR Approver", { departmentId: ENG });
  await firstUsableVariant();
  reqC = await httpClient(REQ);
  ap1C = await httpClient(AP1);
  adminAC = await httpClient(ADMIN_A);
  adminBC = await httpClient(ADMIN_B);
  resetUncataloguedRoutes();
});

afterEach(() => dropPrPolicies());

afterAll(async () => {
  if (routingMapId) await db.none(`DELETE FROM tbl_pr_review_category_map WHERE id = $1`, [routingMapId]);
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await revokeAllPr(PERSONAS);
  for (const u of originalTypes) await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  await db.none(`DELETE FROM tbl_activity_events WHERE hospitality_company_id = ANY($1::int[])`, [[A, IDS.hospitality.B]]);
  await closeDb();
});

describe("PR activity trail", () => {
  it("every mutating PR route has a registry entry under the Purchase Requisitions category", () => {
    const missing = [];
    let seen = 0;
    for (const layer of PrRoutes.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (!["post", "put", "patch", "delete"].includes(method)) continue;
        seen += 1;
        const pattern = `/pr${layer.route.path === "/" ? "" : layer.route.path}`;
        // A POST that only computes a preview changes nothing: like the other
        // POST-shaped queries it is deliberately not in the feed.
        if (pattern === "/pr/routing-preview") continue;
        const entry = lookupEvent(method, pattern);
        if (!entry || entry.category !== CATEGORIES.PURCHASE_REQUISITIONS) missing.push(`${method.toUpperCase()} ${pattern}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(21);
    expect(missing).toEqual([]);
    expect(CATEGORIES.PURCHASE_REQUISITIONS).toBe(CATEGORY);
  });

  it("create / update / submit / comment / withdraw / cancel are recorded as PR/<id> in the PR's company and unit", async () => {
    const since = new Date().toISOString();
    const created = await reqC.post("/api/v1/pr").send(await draftBody({ title: "Activity probe" }));
    expect(created.status).toBe(200);
    const { id, pr_number } = created.body.data;
    prIds.push(id);

    const createdEvent = await waitForEvent(since, (e) => e.event_key === "pr_created");
    expect(createdEvent).toMatchObject({
      category: CATEGORY, entity_type: "PR", entity_id: id, entity_label: pr_number,
      hospitality_company_id: A, hotel_id: A1, actor_user_id: REQ, http_method: "POST", route_pattern: "/pr", status_code: 200,
    });
    expect(createdEvent.summary).toContain(pr_number);

    expect((await reqC.put(`/api/v1/pr/${id}`).send(await draftBody({ title: "Activity probe 2" }))).status).toBe(200);
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });
    const submitted = await reqC.post(`/api/v1/pr/${id}/submit`).send({});
    expect(submitted.status).toBe(200);
    expect((await reqC.post(`/api/v1/pr/${id}/comments`).send({ body: "Please look at this" })).status).toBe(200);
    expect((await reqC.post(`/api/v1/pr/${id}/withdraw`).send({})).status).toBe(200);
    expect((await reqC.post(`/api/v1/pr/${id}/cancel`).send({ reason: "Not needed" })).status).toBe(200);

    for (const key of ["pr_updated", "pr_submitted", "pr_comment_added", "pr_withdrawn", "pr_cancelled"]) {
      const e = await waitForEvent(since, (x) => x.event_key === key);
      expect(e).toMatchObject({
        category: CATEGORY, entity_type: "PR", entity_id: id, entity_label: pr_number, hospitality_company_id: A, hotel_id: A1,
        actor_user_id: REQ,
      });
    }
    const submittedEvent = await waitForEvent(since, (x) => x.event_key === "pr_submitted");
    expect(submittedEvent.severity).toBe("notable");
  });

  it("a PR approved through the approval engine names the requisition in the trail", async () => {
    const since = new Date().toISOString();
    const created = await reqC.post("/api/v1/pr").send(await draftBody({ title: "Approve probe" }));
    const { id, pr_number } = created.body.data;
    prIds.push(id);
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }] });
    expect((await reqC.post(`/api/v1/pr/${id}/submit`).send({})).status).toBe(200);
    const { approval_instance_id: instance } = await db.one(
      `SELECT approval_instance_id FROM tbl_purchase_requisition WHERE id = $1`, [id]);
    const res = await ap1C.post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: instance, action: "APPROVE", comment: "ok" });
    expect(res.status).toBe(200);
    const e = await waitForEvent(since, (x) => x.event_key === "approval_decided");
    expect(e).not.toBeNull();
    expect(e.hospitality_company_id).toBe(A);
  });

  it("the company admin's review-routing changes are recorded (save and remove)", async () => {
    const since = new Date().toISOString();
    const cat = Number((await db.one(
      `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 ORDER BY id LIMIT 1`)).id);
    const saved = await adminAC.post("/api/v1/pr/admin/review-routing").send({ category_id: cat, department_id: PROC });
    expect(saved.status).toBe(200);
    routingMapId = saved.body.data.id;

    const savedEvent = await waitForEvent(since, (e) => e.event_key === "pr_review_routing_saved");
    expect(savedEvent).toMatchObject({
      category: CATEGORY, severity: "critical", hospitality_company_id: A, actor_user_id: ADMIN_A, entity_type: "PR_REVIEW_ROUTING",
      entity_id: routingMapId,
    });

    expect((await adminAC.delete(`/api/v1/pr/admin/review-routing/${routingMapId}`)).status).toBe(200);
    routingMapId = null;
    const removedEvent = await waitForEvent(since, (e) => e.event_key === "pr_review_routing_removed");
    expect(removedEvent).toMatchObject({ category: CATEGORY, hospitality_company_id: A, actor_user_id: ADMIN_A });
  });

  it("no PR route the suite exercised ended up unnamed in the coverage gaps", async () => {
    const gaps = getUncataloguedRoutes().filter((g) => g.route.includes(" /pr"));
    expect(gaps).toEqual([]);
  });

  it("the company admin reads PR events by entity; a plain buyer cannot read the trail; another company's admin sees none", async () => {
    const id = prIds[0];
    const mine = await adminAC.get(`/api/v1/activity?entity_type=PR&entity_id=${id}&category=${encodeURIComponent(CATEGORY)}&limit=200`);
    expect(mine.status).toBe(200);
    const keys = mine.body.data.rows.map((r) => r.event_key);
    expect(keys).toEqual(expect.arrayContaining(["pr_created", "pr_updated", "pr_submitted", "pr_comment_added", "pr_withdrawn", "pr_cancelled"]));
    expect(mine.body.data.rows.every((r) => r.entity_type === "PR" && Number(r.entity_id) === id)).toBe(true);

    // A buyer who raised and can read the PR still cannot read the company trail.
    expect([401, 403]).toContain((await reqC.get(`/api/v1/activity?entity_type=PR&entity_id=${id}`)).status);

    const other = await adminBC.get(`/api/v1/activity?entity_type=PR&entity_id=${id}&limit=200`);
    expect(other.status).toBe(200);
    expect(other.body.data.rows).toEqual([]);
    expect((await adminBC.get("/api/v1/activity?limit=200")).body.data.rows.some((r) => r.category === CATEGORY)).toBe(false);
  });
});
