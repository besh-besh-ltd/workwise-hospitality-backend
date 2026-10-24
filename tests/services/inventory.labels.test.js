// Label sheets (Task B4, spec §10.1).
//
// A label carries our QR (the item's short link), the item name, item code,
// stock unit and bin, plus batch and expiry when printed from a GRN or given
// by hand. Layouts: A4 65-up (38×21 mm), A4 24-up (64×34 mm) and a 50×25 mm
// thermal roll (one label per page). The PDF goes through the shared Chromium
// renderer to S3, the same way the PO PDF does.
//
// Chromium and S3 are stubbed in the test env (tests/setup/jestEnv.js); the
// Handlebars render runs for real, so the assertions read the HTML the
// renderer was handed. Everything runs inside withTx (always rolled back).

import { jest, describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "../helpers/roleScope.js";
import {
  storekeeperRoleId,
  roleWith,
  makeItem,
  setBin,
  makeRfqPo,
  makeGrn,
  thrownBy,
} from "../helpers/invScanFixtures.js";
import { pdfRenderer } from "../../app/util/pdfRenderer.js";
import { qrSvg } from "../../app/services/inventory/qr.js";
import { shortUrl } from "../../app/services/inventory/shortUrl.js";
import {
  LABEL_LAYOUTS,
  renderLabelsHtml,
  renderItemLabels,
  renderGrnLabels,
} from "../../app/services/inventory/labelService.js";

const A = IDS.hospitality.A;
const B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const B1 = IDS.hotels.B1;
const USER = { id: IDS.users.a1_proc_techApp, user_type: 2 };

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closeDb();
});

const countLabels = (html) => (html.match(/class="label[ "]/g) || []).length;

/** Spies on the (stubbed) renderer and returns the calls it received. */
const watchRenderer = () => jest.spyOn(pdfRenderer, "renderToFile");

describe("label HTML", () => {
  it("labels render HTML with QR and batch/expiry", () => {
    const html = renderLabelsHtml({
      layout: "A4_24",
      labels: [
        {
          invItemId: 12, name: "Paneer <fresh>", itemCode: "PNR-1", stockUom: "kg",
          binLabel: "R2-S3", batchNo: "LOT-7", expiryDate: "2027-03-31",
        },
        { invItemId: 13, name: "Sugar", itemCode: null, stockUom: "kg", binLabel: null, batchNo: null, expiryDate: null },
      ],
    });

    expect(html).toContain(qrSvg(shortUrl("i", 12)));
    expect(html).toContain(qrSvg(shortUrl("i", 13)));
    expect(html).toContain("Paneer &lt;fresh&gt;"); // escaped, never raw markup
    expect(html).not.toContain("Paneer <fresh>");
    for (const text of ["PNR-1", "kg", "R2-S3", "LOT-7", "31 Mar 2027", "Sugar"]) {
      expect([text, html.includes(text)]).toEqual([text, true]);
    }
    // The label with no batch / expiry prints no empty "Batch" / "Exp" rows.
    expect(html.match(/Batch/g)).toHaveLength(1);
    expect(html.match(/Exp/g)).toHaveLength(1);
    expect(countLabels(html)).toBe(2);
    // Self-contained: nothing for Chromium to fetch.
    expect(html).not.toMatch(/<link|<script|src="http/);
    // The sheet geometry comes from the layout.
    expect(html).toContain(LABEL_LAYOUTS.A4_24.labelWidth);
  });

  it("A4 sheets split into pages of the layout's size", () => {
    const labels = Array.from({ length: 70 }, (_, i) => ({ invItemId: i + 1, name: `Item ${i}`, stockUom: "pcs" }));
    const html = renderLabelsHtml({ layout: "A4_65", labels });
    expect(countLabels(html)).toBe(70);
    expect((html.match(/class="sheet"/g) || []).length).toBe(2); // 65 + 5
    const thermal = renderLabelsHtml({ layout: "THERMAL_50x25", labels: labels.slice(0, 3) });
    expect((thermal.match(/class="sheet"/g) || []).length).toBe(3); // one label per page
  });
});

describe("renderItemLabels", () => {
  it("prints the copies asked for, with the hotel's bin, and returns the S3 url", async () => {
    await withTx(async (t) => {
      await grantRoleScope(t, { userId: USER.id, roleId: await storekeeperRoleId(t), companyId: A, hotelId: A1 });
      const rice = await makeItem(t, { name: "Basmati rice", itemCode: "RICE-1", stockUom: "kg" });
      const oil = await makeItem(t, { name: "Sunflower oil", stockUom: "L" });
      await setBin(t, { hotelId: A1, invItemId: rice, binLabel: "DRY-R1" });
      const spy = watchRenderer();

      const out = await renderItemLabels(t, USER, {
        layout: "A4_65",
        hotelId: A1,
        items: [
          { invItemId: rice, copies: 3, batchNo: "LOT-1", expiryDate: "2027-01-15" },
          { invItemId: oil, copies: 1 },
        ],
      });

      expect(out).toEqual({ url: expect.stringMatching(/\/inventory\/labels\/10001\/.+\.pdf$/) });
      expect(spy).toHaveBeenCalledTimes(1);
      const [html, , options] = spy.mock.calls[0];
      expect(countLabels(html)).toBe(4);
      expect(html.match(/DRY-R1/g)).toHaveLength(3);
      expect(html.match(/15 Jan 2027/g)).toHaveLength(3);
      expect(html).toContain(qrSvg(shortUrl("i", oil)));
      expect(html).toContain("Sunflower oil");
      expect(options).toMatchObject({ format: "A4", preferCSSPageSize: true });

      // Without a hotel there is no bin to print.
      await renderItemLabels(t, USER, { layout: "THERMAL_50x25", items: [{ invItemId: rice, copies: 1 }] });
      const [thermalHtml, , thermalOptions] = spy.mock.calls[1];
      expect(thermalHtml).not.toContain("DRY-R1");
      expect(thermalOptions).toMatchObject({ width: "50mm", height: "25mm", preferCSSPageSize: true });
    });
  });

  it("refuses foreign items, read-only users and bad input", async () => {
    await withTx(async (t) => {
      const mine = await makeItem(t, { name: "Mine" });
      const foreign = await makeItem(t, { companyId: B, name: "Theirs" });

      // inventory.read only: can see the item, cannot print.
      await grantRoleScope(t, { userId: USER.id, roleId: await roleWith(t, ["inventory.read"]), companyId: A, hotelId: A1 });
      for (const payload of [
        { layout: "A4_24", hotelId: A1, items: [{ invItemId: mine, copies: 1 }] },
        { layout: "A4_24", items: [{ invItemId: mine, copies: 1 }] },
      ]) {
        const err = await thrownBy(t, (sp) => renderItemLabels(sp, USER, payload));
        expect([err.code, err.httpStatus]).toEqual(["FORBIDDEN", 403]);
      }

      await grantRoleScope(t, { userId: USER.id, roleId: await storekeeperRoleId(t), companyId: A, hotelId: A1 });
      for (const payload of [
        { layout: "A4_24", hotelId: A1, items: [{ invItemId: foreign, copies: 1 }] },
        { layout: "A4_24", items: [{ invItemId: foreign, copies: 1 }] },
        { layout: "A4_24", items: [{ invItemId: 999999999, copies: 1 }] },
        { layout: "A4_24", hotelId: B1, items: [{ invItemId: mine, copies: 1 }] },
      ]) {
        const err = await thrownBy(t, (sp) => renderItemLabels(sp, USER, payload));
        expect([err.code, err.httpStatus]).toEqual(["NOT_FOUND", 404]);
      }

      for (const [field, payload] of [
        ["layout", { layout: "A5", items: [{ invItemId: mine, copies: 1 }] }],
        ["items", { layout: "A4_24", items: [] }],
        ["copies", { layout: "A4_24", items: [{ invItemId: mine, copies: 0 }] }],
        ["copies", { layout: "A4_24", items: [{ invItemId: mine, copies: 2.5 }] }],
        ["expiryDate", { layout: "A4_24", items: [{ invItemId: mine, copies: 1, expiryDate: "2027-02-30" }] }],
        ["copies", { layout: "A4_24", items: [{ invItemId: mine, copies: 1500 }, { invItemId: mine, copies: 1500 }] }],
      ]) {
        const err = await thrownBy(t, (sp) => renderItemLabels(sp, USER, payload));
        expect([field, err.code, err.details.field]).toEqual([field, "VALIDATION", field]);
      }
    });
  });
});

describe("renderGrnLabels", () => {
  it("prints one label per stock unit or per pack, with the line's batch and expiry", async () => {
    await withTx(async (t) => {
      // grn.read is all it takes.
      await grantRoleScope(t, { userId: USER.id, roleId: await roleWith(t, ["grn.read"]), companyId: A, hotelId: A1 });
      const water = await makeItem(t, { name: "Mineral water 1L", stockUom: "bottle" });
      const paneer = await makeItem(t, { name: "Paneer", stockUom: "kg" });
      const spoilt = await makeItem(t, { name: "Spoilt" });
      await setBin(t, { hotelId: A1, invItemId: water, binLabel: "BEV-2" });
      const { poId, lineIds } = await makeRfqPo(t, { lines: [{ qty: 2, unit: "Case" }, { qty: 3 }, { qty: 1 }] });
      const grnId = await makeGrn(t, {
        poId,
        lines: [
          // 2 cases of 12 = 24 bottles.
          { poLineId: lineIds[0], invItemId: water, accepted: 2, poUom: "Case", uomFactor: 12, stockQty: 24,
            batchNo: "LOT-A", expiryDate: "2027-05-31" },
          { poLineId: lineIds[1], invItemId: paneer, accepted: 2.5 },
          { poLineId: lineIds[2], invItemId: spoilt, accepted: 0, rejected: 1 },
        ],
      });
      const spy = watchRenderer();

      const perPack = await renderGrnLabels(t, USER, grnId, { layout: "A4_24", mode: "per_pack" });
      expect(perPack.url).toMatch(/\/inventory\/labels\/10001\/.+\.pdf$/);
      let html = spy.mock.calls[0][0];
      expect(countLabels(html)).toBe(2 + 3); // 2 cases + ceil(2.5) kg
      expect(html.match(/LOT-A/g)).toHaveLength(2);
      expect(html.match(/31 May 2027/g)).toHaveLength(2);
      expect(html.match(/BEV-2/g)).toHaveLength(2);
      expect(html).not.toContain("Spoilt"); // nothing accepted, nothing to label

      await renderGrnLabels(t, USER, grnId, { layout: "THERMAL_50x25", mode: "per_unit" });
      html = spy.mock.calls[1][0];
      expect(countLabels(html)).toBe(24 + 3);
      expect(html.match(/LOT-A/g)).toHaveLength(24);
    });
  });

  it("is 404 outside scope, 403 without grn.read, 400 for a reversal", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      const { poId, lineIds } = await makeRfqPo(t, { lines: [{ qty: 1 }] });
      const grnId = await makeGrn(t, { poId, lines: [{ poLineId: lineIds[0], invItemId: item, accepted: 1 }] });

      // Mapped to the company, no grn.read: the GRN's hotel is visible, the action is not.
      let err = await thrownBy(t, (sp) => renderGrnLabels(sp, USER, grnId, { layout: "A4_24", mode: "per_unit" }));
      expect([err.code, err.httpStatus]).toEqual(["FORBIDDEN", 403]);

      await grantRoleScope(t, { userId: USER.id, roleId: await roleWith(t, ["grn.read"]), companyId: A, hotelId: A1 });
      const foreignItem = await makeItem(t, { companyId: B });
      const { poId: foreignPo, lineIds: fl } = await makeRfqPo(t, {
        hospitality: B, company: IDS.companies.B, hotel: B1, lines: [{ qty: 1 }],
      });
      const foreignGrn = await makeGrn(t, {
        companyId: B, hotelId: B1, poId: foreignPo, lines: [{ poLineId: fl[0], invItemId: foreignItem, accepted: 1 }],
      });
      for (const id of [foreignGrn, 999999999, "abc"]) {
        err = await thrownBy(t, (sp) => renderGrnLabels(sp, USER, id, { layout: "A4_24", mode: "per_unit" }));
        expect([id, err.code, err.httpStatus]).toEqual([id, "NOT_FOUND", 404]);
      }

      const reversal = await makeGrn(t, { poId, docType: "REVERSAL", reversesGrnId: grnId, lines: [] });
      err = await thrownBy(t, (sp) => renderGrnLabels(sp, USER, reversal, { layout: "A4_24", mode: "per_unit" }));
      expect([err.code, err.httpStatus]).toEqual(["VALIDATION", 400]);
      err = await thrownBy(t, (sp) => renderGrnLabels(sp, USER, grnId, { layout: "A4_24", mode: "per_box" }));
      expect([err.code, err.details.field]).toEqual(["VALIDATION", "mode"]);
    });
  });
});
