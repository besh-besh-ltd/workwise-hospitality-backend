// ARC v2 — a Manual ARC draft must be identifiable, and must never be editable
// through the ordinary create-wizard endpoints.
//
// Product-level: real Express app + local Postgres. Asserts OBSERVABLE
// end-to-end behaviour over HTTP + DB rows.
//
// ── The defect this pins ─────────────────────────────────────────────────────
// A Manual ARC is an ordinary tbl_arc row (status='draft') plus a companion
// tbl_arc_manual_entry row. Nothing outside the manual workspace knew that
// companion row existed, so:
//
//   1. Every listing routed a manual draft to the standard create wizard
//      (…/create?c=<id>) — the wrong page. The FE could not tell the two kinds
//      of draft apart because neither the listing nor the detail payload
//      carried a marker. → R1/R2/R3 below.
//   2. Once in the wrong wizard, "Save draft & exit" / "Submit" called
//      PATCH /arc-v2/:id, which reconciles the item set and the invitation list
//      against the wizard's (empty) selection — deleting the manually entered
//      line items and vendor invitations — and overwrote the backdated scalars
//      with the wizard's future-dated defaults. Publish would then float a
//      back-office backfill record to real vendors. → R4/R5 below.
//
// Cases:
//   R1  GET /arc-v2/:id on a manual draft → is_manual:true + manual_target_stage.
//   R2  GET /arc-v2/:id on an ordinary draft → is_manual falsy.
//   R3  the marker survives both listing endpoints (POST /list-view, GET /).
//   R4  PATCH /arc-v2/:id on a manual ARC → 409, items + invitations intact.
//   R5  POST /arc-v2/:id/publish on a manual ARC → 409, still a draft.
//   R6  the ordinary create-wizard draft is still fully PATCHable (no collateral).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BASE = "/api/v1/arc-v2";

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1; // '7 UP PEPSI 1.5 LTR' — seed_reference.sql
const VENDOR = IDS.users.vendor_alpha;

const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

describe("ARC v2 manual — draft is identifiable and create-wizard-proof", () => {
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (!createdArcIds.length) return;
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
  });

  // A manual draft carrying exactly what the client's stuck drafts carry:
  // line items and invited vendors, but NO tbl_arc date columns (the backdated
  // chain lives in tbl_arc_manual_entry.backdated_dates — see SC-5).
  async function newManualDraft(targetStage = "draft") {
    const res = await client.post(`${BASE}/manual/draft`).send({
      header: { title: "Manual ARC — resume routing", type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: targetStage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = Number(res.body.data.arc.id);
    createdArcIds.push(id);

    const items = await client.put(`${BASE}/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre", target_price: 100 }],
    });
    expect(items.status).toBe(200);

    const vendors = await client.put(`${BASE}/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR }], override: true,
    });
    expect(vendors.status).toBe(200);
    return id;
  }

  // An ordinary create-wizard draft — the control group.
  async function newWizardDraft() {
    const res = await client.post(`${BASE}`).send({
      title: "Wizard ARC — resume routing",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "product",
      eligibility_type: "invitation",
      submission_start_at: D(1),
      submission_end_at: D(5),
      contract_start_at: D(10),
      contract_end_at: D(370),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 10, uom: "litre", spec_text: "spec" }],
      invited_vendor_ids: [VENDOR],
    });
    expect(res.status).toBe(200);
    const id = Number((res.body.data.arc || res.body.data).id);
    createdArcIds.push(id);
    return id;
  }

  test("R1 — the detail payload flags a manual draft and carries its target stage", async () => {
    const id = await newManualDraft("floated");
    const res = await client.get(`${BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.is_manual).toBe(true);
    expect(res.body.data.arc.manual_target_stage).toBe("floated");
  });

  test("R2 — an ordinary create-wizard draft is not flagged manual", async () => {
    const id = await newWizardDraft();
    const res = await client.get(`${BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.is_manual).toBeFalsy();
    expect(res.body.data.arc.manual_target_stage ?? null).toBeNull();
  });

  test("R3 — both listing endpoints carry the marker, so a card can route correctly", async () => {
    const manualId = await newManualDraft("draft");
    const wizardId = await newWizardDraft();

    const listView = await client.post(`${BASE}/list-view`).send({ tab: "all", page: 1, limit: 200 });
    expect(listView.status).toBe(200);
    const lvRows = listView.body.data.rows;
    expect(lvRows.find((r) => Number(r.id) === manualId)?.is_manual).toBe(true);
    expect(lvRows.find((r) => Number(r.id) === wizardId)?.is_manual).toBeFalsy();

    const list = await client.get(`${BASE}?page=1&limit=200`);
    expect(list.status).toBe(200);
    const rows = list.body.data.data;
    expect(rows.find((r) => Number(r.id) === manualId)?.is_manual).toBe(true);
    expect(rows.find((r) => Number(r.id) === manualId)?.manual_target_stage).toBe("draft");
    expect(rows.find((r) => Number(r.id) === wizardId)?.is_manual).toBeFalsy();
  });

  test("R4 — the create wizard's PATCH is refused and destroys nothing", async () => {
    const id = await newManualDraft("floated");

    const res = await client.patch(`${BASE}/${id}`).send({
      title: "Overwritten by the wrong wizard",
      // Exactly what create.js sends from a resumed draft whose items never
      // hydrated: an empty selection, which the reconciler would honour by
      // deleting every manually entered row.
      items: [],
      invited_vendor_ids: [],
      submission_start_at: D(2),
      submission_end_at: D(12),
      contract_start_at: D(20),
      contract_end_at: D(380),
    });
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/manual/i);

    const items = await db.any(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    const invitations = await db.any(`SELECT id FROM tbl_arc_invitation WHERE arc_id = $1`, [id]);
    const arc = await db.one(`SELECT title, submission_start_at FROM tbl_arc WHERE id = $1`, [id]);
    expect(items).toHaveLength(1);
    expect(invitations).toHaveLength(1);
    expect(arc.title).toBe("Manual ARC — resume routing");
    expect(arc.submission_start_at).toBeNull();
  });

  test("R5 — the create wizard's publish is refused; a backfill never floats", async () => {
    const id = await newManualDraft("floated");
    const res = await client.post(`${BASE}/${id}/publish`).send({});
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/manual/i);
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [id]);
    expect(arc.status).toBe("draft");
  });

  test("R6 — an ordinary draft is still fully editable through the wizard", async () => {
    const id = await newWizardDraft();
    const res = await client.patch(`${BASE}/${id}`).send({
      title: "Wizard ARC — edited",
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 25, uom: "litre", spec_text: "revised" }],
    });
    expect(res.status).toBe(200);
    const arc = await db.one(`SELECT title FROM tbl_arc WHERE id = $1`, [id]);
    expect(arc.title).toBe("Wizard ARC — edited");
    const item = await db.one(`SELECT indicative_qty FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    expect(Number(item.indicative_qty)).toBe(25);
  });
});
