// Mark out / return to stock (Task C3, spec §8.1-8.2).
//
// Service tests run inside withTx (rolled back). The replay tests commit for
// real (HTTP, and two concurrent transactions), so the suite truncates the
// dynamic tables before and after, and revokes its committed grants.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { IDS } from "../fixtures/ids.js";
import {
  CO, A1, A2, FB, HK, STORE, STORE_ID, CTRL, asUser, grant, grantCast, makeItem, stockIn, move, balanceOf, movementsOf,
  setCompanySettings, thrownBy,
} from "../helpers/invStockFixtures.js";
import { postOut, getOut, listOut } from "../../app/services/inventory/outService.js";
import { startCount, saveCountLines, submitCount } from "../../app/services/inventory/countService.js";
import { createAdjustment } from "../../app/services/inventory/adjustmentService.js";

/** No inventory role of their own in company A until a test grants one. */
const NARROW_ID = IDS.users.a1_proc_techEval;
const out = (over = {}) => ({
  hotelId: A1, docType: "OUT", departmentId: FB, clientEventId: randomUUID(), ...over,
});

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await truncateDynamic();
  await closeDb();
});

describe("mark out", () => {
  it("mark out posts MARK_OUT with department at avg cost", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "Paneer" });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 100 });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 200 }); // avg 150

      // the department is required
      const noDept = await thrownBy(t, (sp) => postOut(sp, STORE, out({ departmentId: null, lines: [{ invItemId: item, qty: 1 }] })));
      expect(noDept.code).toBe("VALIDATION");
      expect(noDept.details.field).toBe("departmentId");
      // quantities are > 0
      const zero = await thrownBy(t, (sp) => postOut(sp, STORE, out({ lines: [{ invItemId: item, qty: 0 }] })));
      expect(zero.code).toBe("VALIDATION");

      const { doc, replayed } = await postOut(t, STORE, out({ requestedByName: "Chef Ravi", lines: [{ invItemId: item, qty: 4 }] }));
      expect(replayed).toBe(false);
      expect(doc.outNumber).toMatch(/^OUT\/10101\/\d{4}-\d{2}\/00001$/);
      expect(doc).toMatchObject({
        docType: "OUT", hotelId: A1, departmentId: FB, requestedByName: "Chef Ravi", postedBy: STORE_ID,
      });
      expect(doc.departmentName).toBeTruthy();
      expect(doc.lines).toEqual([
        expect.objectContaining({ invItemId: item, displayName: "Paneer", qty: 4, stockUom: "kg", unitCost: 150, value: 600 }),
      ]);

      const moves = await movementsOf(t, { sourceType: "OUT", sourceId: doc.id });
      expect(moves).toEqual([
        expect.objectContaining({ type: "MARK_OUT", inv_item_id: item, qty: -4, unit_cost: 150, value: -600, department_id: FB }),
      ]);
      expect(await balanceOf(t, A1, item)).toEqual({ qty: 16, avgCost: 150, value: 2400 });

      // readable again, and listed
      expect((await getOut(t, STORE, doc.id)).outNumber).toBe(doc.outNumber);
      const list = await listOut(t, STORE, { hotelId: A1, departmentId: FB });
      expect(list.rows.map((r) => r.id)).toContain(doc.id);
      expect(list.rows.find((r) => r.id === doc.id)).toMatchObject({ lineCount: 1, value: 600, docType: "OUT" });
    });
  });

  it("mark out beyond stock lists all short lines", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const x = await makeItem(t, { name: "Butter" });
      const y = await makeItem(t, { name: "Cream" });
      const z = await makeItem(t, { name: "Milk" });
      await stockIn(t, { invItemId: x, qty: 2 });
      await stockIn(t, { invItemId: z, qty: 10 });

      const err = await thrownBy(t, (sp) => postOut(sp, STORE, out({
        lines: [{ invItemId: x, qty: 5 }, { invItemId: y, qty: 1 }, { invItemId: z, qty: 3 }],
      })));
      expect(err.code).toBe("NEGATIVE_STOCK");
      expect(err.httpStatus).toBe(409);
      expect(err.details.lines).toEqual([
        expect.objectContaining({ invItemId: x, itemName: "Butter", available: 2, requested: 5 }),
        expect.objectContaining({ invItemId: y, itemName: "Cream", available: 0, requested: 1 }),
      ]);
      // nothing was written
      expect(Number((await t.one(`SELECT count(*) FROM tbl_inv_out WHERE hotel_id = $1`, [A1])).count)).toBe(0);
      expect((await balanceOf(t, A1, z)).qty).toBe(10);

      // the same item twice in one session is refused
      const dup = await thrownBy(t, (sp) => postOut(sp, STORE, out({ lines: [{ invItemId: z, qty: 1 }, { invItemId: z, qty: 2 }] })));
      expect(dup.code).toBe("VALIDATION");
    });
  });

  it("return to stock posts RETURN_IN", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "Rice" });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 100 });
      await postOut(t, STORE, out({ lines: [{ invItemId: item, qty: 4 }] }));

      // stock on hand: back at the current average, tagged with the department
      const { doc } = await postOut(t, STORE, out({ docType: "RETURN", lines: [{ invItemId: item, qty: 1 }] }));
      expect(doc.outNumber).toMatch(/^RET\/10101\//);
      expect(await movementsOf(t, { sourceType: "OUT", sourceId: doc.id })).toEqual([
        expect.objectContaining({ type: "RETURN_IN", qty: 1, unit_cost: 100, department_id: FB }),
      ]);
      expect((await balanceOf(t, A1, item)).qty).toBe(7);

      // balance 0: the last MARK_OUT's unit cost, not the average.
      // 7 on hand @100; receive 3 @200 → avg 130; issue the whole lot by adjustment.
      await stockIn(t, { invItemId: item, qty: 3, unitCost: 200 });
      await move(t, { invItemId: item, type: "ADJUST_OUT", qty: -10 });
      expect((await balanceOf(t, A1, item)).qty).toBe(0);
      const { doc: back } = await postOut(t, STORE, out({ docType: "RETURN", lines: [{ invItemId: item, qty: 2 }] }));
      expect(await movementsOf(t, { sourceType: "OUT", sourceId: back.id })).toEqual([
        expect.objectContaining({ type: "RETURN_IN", qty: 2, unit_cost: 100, value: 200, department_id: FB }),
      ]);
      expect(await balanceOf(t, A1, item)).toEqual({ qty: 2, avgCost: 100, value: 200 });

      // nothing ever marked out at this hotel: nothing to return
      const fresh = await makeItem(t, { name: "Fresh" });
      const err = await thrownBy(t, (sp) => postOut(sp, STORE, out({ docType: "RETURN", lines: [{ invItemId: fresh, qty: 1 }] })));
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toMatchObject({ field: "lines", invItemId: fresh, maxReturnable: 0 });
    });
  });

  it("a department returns at most what it was issued, net of earlier returns", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t, { name: "Linen", stockUom: "pcs" });
      await stockIn(t, { invItemId: item, qty: 20, unitCost: 10 });
      await postOut(t, STORE, out({ departmentId: FB, lines: [{ invItemId: item, qty: 5 }] }));
      await postOut(t, STORE, out({ departmentId: FB, lines: [{ invItemId: item, qty: 3 }] }));
      await postOut(t, STORE, out({ docType: "RETURN", departmentId: FB, lines: [{ invItemId: item, qty: 2 }] }));

      // FB holds 5 + 3 − 2 = 6: 7 is one too many
      const over = await thrownBy(t, (sp) => postOut(sp, STORE, out({ docType: "RETURN", departmentId: FB, lines: [{ invItemId: item, qty: 7 }] })));
      expect(over.code).toBe("VALIDATION");
      expect(over.details).toEqual({ field: "lines", index: 0, invItemId: item, maxReturnable: 6 });
      expect(over.message).toMatch(/^Only 6 pcs of Linen was marked out to .+ here$/);

      // a department that never took any returns nothing: that is a FOUND adjustment
      const other = await thrownBy(t, (sp) => postOut(sp, STORE, out({ docType: "RETURN", departmentId: HK, lines: [{ invItemId: item, qty: 1 }] })));
      expect(other.details).toMatchObject({ field: "lines", invItemId: item, maxReturnable: 0 });

      // exactly the cap is fine, and then nothing more is returnable
      await postOut(t, STORE, out({ docType: "RETURN", departmentId: FB, lines: [{ invItemId: item, qty: 6 }] }));
      expect((await balanceOf(t, A1, item)).qty).toBe(20);
      const after = await thrownBy(t, (sp) => postOut(sp, STORE, out({ docType: "RETURN", departmentId: FB, lines: [{ invItemId: item, qty: 0.5 }] })));
      expect(after.details).toMatchObject({ maxReturnable: 0 });
    });
  });

  it("an in-company hotel outside the caller's scope is 404 on create", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { hotelId: A2, invItemId: item, qty: 5 });
      // a storekeeper of A1 only
      await grant(t, NARROW_ID, "Storekeeper", { hotelId: A1 });
      const narrow = asUser(NARROW_ID);

      const outErr = await thrownBy(t, (sp) => postOut(sp, narrow, out({ hotelId: A2, lines: [{ invItemId: item, qty: 1 }] })));
      const adjErr = await thrownBy(t, (sp) => createAdjustment(sp, narrow, {
        hotelId: A2, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: item, qty: -1 }],
      }));
      const cntErr = await thrownBy(t, (sp) => startCount(sp, narrow, { hotelId: A2, scope: "SELECTED", invItemIds: [item] }));
      expect([outErr, adjErr, cntErr].map((e) => [e.code, e.httpStatus])).toEqual([
        ["NOT_FOUND", 404], ["NOT_FOUND", 404], ["NOT_FOUND", 404],
      ]);

      // at their own hotel it works
      await stockIn(t, { invItemId: item, qty: 5 });
      await postOut(t, narrow, out({ lines: [{ invItemId: item, qty: 1 }] }));

      // once they can read A2 (but not post there), A2 answers FORBIDDEN instead
      const reader = await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ('C3 read only', 'out test', $1) RETURNING id`,
        [STORE_ID]
      );
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'inventory' AND action::text = 'read'`,
        [reader.id]
      );
      await grantRoleScope(t, { userId: NARROW_ID, roleId: Number(reader.id), companyId: CO, hotelId: A2 });
      const seen = await thrownBy(t, (sp) => postOut(sp, narrow, out({ hotelId: A2, lines: [{ invItemId: item, qty: 1 }] })));
      expect([seen.code, seen.httpStatus]).toEqual(["FORBIDDEN", 403]);
    });
  });

  it("freeze blocks mark out during open count when enabled", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { invItemId: item, qty: 10 });
      await stockIn(t, { hotelId: A2, invItemId: item, qty: 10 });
      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [item] });

      // freeze off (the default): stock keeps moving during a count
      await postOut(t, STORE, out({ lines: [{ invItemId: item, qty: 1 }] }));

      await setCompanySettings(t, { countFreeze: true });
      const err = await thrownBy(t, (sp) => postOut(sp, STORE, out({ lines: [{ invItemId: item, qty: 1 }] })));
      expect(err.code).toBe("LOCKED");
      expect(err.httpStatus).toBe(409);
      expect(err.details).toMatchObject({ countId: count.id, countNumber: count.countNumber });
      const ret = await thrownBy(t, (sp) => postOut(sp, STORE, out({ docType: "RETURN", lines: [{ invItemId: item, qty: 1 }] })));
      expect(ret.code).toBe("LOCKED");
      const adj = await thrownBy(t, (sp) => createAdjustment(sp, CTRL, {
        hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), lines: [{ invItemId: item, qty: -1 }],
      }));
      expect(adj.code).toBe("LOCKED");

      // another hotel is not frozen
      await postOut(t, STORE, out({ hotelId: A2, lines: [{ invItemId: item, qty: 1 }] }));

      // once the count is submitted, stock moves again
      await saveCountLines(t, STORE, count.id, [{ invItemId: item, countedQty: 9, clientEventId: randomUUID() }]);
      await submitCount(t, STORE, count.id);
      await postOut(t, STORE, out({ lines: [{ invItemId: item, qty: 1 }] }));
      expect((await balanceOf(t, A1, item)).qty).toBe(8);
    });
  });
});

describe("concurrency and replay (committed)", () => {
  let scopes = [];
  let item;

  beforeAll(async () => {
    scopes = await grantCast(db);
    item = await makeItem(db, { name: "Replay item" });
    await db.tx((t) => stockIn(t, { invItemId: item, qty: 20, unitCost: 50 }));
  });
  afterAll(async () => {
    await revokeRoleScopes(db, scopes);
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = ANY($1::text[])`, [["INV_OUT"]]);
  });

  it("replayed clientEventId returns the original document", async () => {
    const store = await httpClient(STORE_ID);
    const body = out({ lines: [{ invItemId: item, qty: 3 }] });

    const first = await store.post("/api/v1/inventory/out").send(body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ outNumber: expect.stringMatching(/^OUT\//), lines: [expect.objectContaining({ qty: 3 })] });

    // the connection dropped before the answer: the client sends the session again
    const again = await store.post("/api/v1/inventory/out").send(body);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, outNumber: first.body.data.outNumber, replayed: true });

    // a replay with a different payload still answers the original
    const changed = await store.post("/api/v1/inventory/out").send({ ...body, lines: [{ invItemId: item, qty: 9 }] });
    expect(changed.status).toBe(200);
    expect(changed.body.data.id).toBe(first.body.data.id);

    // one activity row: replays record nothing
    const events = async () => db.any(
      `SELECT event_key, hospitality_company_id, hotel_id, entity_label FROM tbl_activity_events
        WHERE entity_type = 'INV_OUT' AND entity_id = $1`,
      [String(first.body.data.id)]
    );
    const deadline = Date.now() + 5000;
    while (!(await events()).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800));
    expect(await events()).toEqual([expect.objectContaining({
      event_key: "inventory_stock_marked_out", hotel_id: A1, entity_label: first.body.data.outNumber,
    })]);

    const docs = await db.any(`SELECT id FROM tbl_inv_out WHERE client_event_id = $1`, [body.clientEventId]);
    expect(docs).toHaveLength(1);
    expect(await movementsOf(db, { sourceType: "OUT", sourceId: first.body.data.id })).toHaveLength(1);
    expect((await balanceOf(db, A1, item)).qty).toBe(17);

    // GET /out/:id answers the same document
    const read = await store.get(`/api/v1/inventory/out/${first.body.data.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.outNumber).toBe(first.body.data.outNumber);
  });

  it("two concurrent posts of one scan session produce one document", async () => {
    const body = out({ lines: [{ invItemId: item, qty: 2 }] });
    const results = await Promise.allSettled([
      db.tx((t) => postOut(t, STORE, body)),
      db.tx((t) => postOut(t, STORE, body)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const [a, b] = results.map((r) => r.value);
    expect(a.doc.id).toBe(b.doc.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await movementsOf(db, { sourceType: "OUT", sourceId: a.doc.id })).toHaveLength(1);
    expect((await balanceOf(db, A1, item)).qty).toBe(15);
  });

  it("two concurrent mark-outs draining one balance: one posts, the other is NEGATIVE_STOCK", async () => {
    const lot = await makeItem(db, { name: "Last crate" });
    await db.tx((t) => stockIn(t, { invItemId: lot, qty: 10, unitCost: 5 }));
    const results = await Promise.allSettled([
      db.tx((t) => postOut(t, STORE, out({ lines: [{ invItemId: lot, qty: 6 }] }))),
      db.tx((t) => postOut(t, STORE, out({ departmentId: HK, lines: [{ invItemId: lot, qty: 6 }] }))),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected").reason;
    expect(refused.code).toBe("NEGATIVE_STOCK");
    expect(refused.details.lines).toEqual([expect.objectContaining({ invItemId: lot, available: 4, requested: 6 })]);
    expect(await balanceOf(db, A1, lot)).toEqual({ qty: 4, avgCost: 5, value: 20 });
    expect(await db.one(`SELECT count(*)::int AS n FROM tbl_inv_out_line WHERE inv_item_id = $1`, [lot])).toEqual({ n: 1 });
  });
});
