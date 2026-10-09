// Vendor Networks: call-off supplier block and GST split (spec §6.4 "Call-off POs", §7).
// Pattern B: committed fixtures (ids 95931..95945), removed in afterEach.
//
// World: one group ARC (lead H_MH), item VARIANT, two contracts on it:
//   - C_HQ of HQ (GSTIN 27…, Maharashtra), the network principal. M_UP (GSTIN 09…, Uttar
//     Pradesh) is an ACTIVE branch fulfilling H_MH and H_UP; H_NONE stays with HQ.
//   - C_LEG of LEG, a vendor with no GSTIN and no network.
// Hotels: H_MH has a GSTIN (27…); H_UP has none but state_id = Uttar Pradesh; H_NONE has
// neither, so its place of supply is unknown.
//
// SMTP: nodemailer.createTransport is swapped for a recorder.

import nodemailer from "nodemailer";
import { db, closeDb, withTx } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { deleteArcs } from "../helpers/arcGroupSeed.js";
import { seedVendorEntity, seedOrg, addEntity, seedHotel, cleanupVendorNetworkFixtures } from "../helpers/vendorNetworkSeed.js";
import { releaseForMr } from "../../app/services/callOffPoService.js";
import { loadCallOffPoContext, renderCallOffPoHtml } from "../../app/helper/arc_v2/callOffPoRenderer.js";
import {
  GST_STATE_CODES,
  stateCodeFromGstin,
  stateCodeFromName,
  stateCodeForHotel,
  taxSplitFor,
  taxLinesFor,
  supplierDetailsFor,
} from "../../app/helper/gstState.js";
import mrModel from "../../app/models/mr/mrModel.js";
import arcHotelModel from "../../app/models/arc_v2/arcHotelModel.js";
import arcContractModel from "../../app/models/arc_v2/arcContractModel.js";
import {
  loadContractVendorParty,
  loadContractDocContext,
  renderContractDocumentHtml,
} from "../../app/controllers/arc_v2/arcContractController.js";
import { findPosNeedingVendorReminder } from "../../app/helper/cronManager.js";
import { callOffLineTax, callOffPoTax } from "../../app/helper/arc_v2/callOffLineTax.js";
import { sendPOAcceptanceReminderToVendor } from "../../app/controllers/po/purchaseOrderEmails.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { makePO } from "../helpers/dashboardSeed.js";

const H_MH = 95931;
const H_UP = 95932;
const H_NONE = 95933;
const HQ = 95934;
const M_UP = 95935;
const LEG = 95936;
const ORG = 95931;

const MAHARASHTRA = 116; // tbl_location_states (seed_reference)
const UTTAR_PRADESH = 108;
const HQ_GSTIN = "27AABCH0971F1ZW";
const M_UP_GSTIN = "09AABCM0971F1Z3";
const H_MH_GSTIN = "27AAACH1234F1ZW";

const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const CREATOR = IDS.users.companyA_admin;

let VARIANT;
let arcId;
let hqContractId;
let legContractId;
let hqLineId;
let legLineId;
const mrIds = [];
const sentMail = [];
let realTransport;

beforeAll(async () => {
  realTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(mail, cb) {
      sentMail.push(mail);
      const info = { messageId: "<vn-gst>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
  VARIANT = (await db.one(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`)).id;
});

beforeEach(async () => {
  await seedHotel({ id: H_MH, name: "VN GST Mumbai", state: "Maharashtra", stateId: MAHARASHTRA });
  await db.none(`UPDATE tbl_hospitality_company_hotels SET gst = $2 WHERE id = $1`, [H_MH, H_MH_GSTIN]);
  await seedHotel({ id: H_UP, name: "VN GST Lucknow", state: "Uttar Pradesh", stateId: UTTAR_PRADESH });
  await seedHotel({ id: H_NONE, name: "VN GST Nowhere" });

  await seedVendorEntity({ id: HQ, companyId: HQ, name: "VN GST Principal", email: "vn-gst-hq@example.com", gstin: HQ_GSTIN, stateId: MAHARASHTRA });
  await seedVendorEntity({ id: M_UP, companyId: M_UP, name: "VN GST Noida Branch", email: "vn-gst-up@example.com", gstin: M_UP_GSTIN, stateId: UTTAR_PRADESH });
  await db.none(`UPDATE tbl_company_location SET address = '12 Industrial Area, Noida' WHERE company_id = $1`, [M_UP]);
  await seedVendorEntity({ id: LEG, companyId: LEG, name: "VN GST Legacy Supplier", email: "vn-gst-leg@example.com" });
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "VN GST Network" });
  await addEntity({ orgId: ORG, vendorId: M_UP });

  arcId = Number(
    (
      await db.one(
        `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                              status, is_group, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-VN-GST-1', 'Group linen', $1, $2, $3, $4,
                 'contract_active', true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '300 days', $5)
         RETURNING id`,
        [TEST_CATEGORIES.beverages, HC_A, H_MH, PROC, CREATOR]
      )
    ).id
  );
  await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [
    arcId,
    [H_MH, H_UP, H_NONE],
  ]);
  const itemId = (
    await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'pcs') RETURNING id`, [arcId, VARIANT])
  ).id;
  [hqContractId, hqLineId] = await contractWithLine(HQ, itemId);
  [legContractId, legLineId] = await contractWithLine(LEG, itemId);
  // M_UP fulfils H_MH and H_UP on HQ's contract.
  await db.none(
    `UPDATE tbl_arc_contract_line_hotel SET fulfilling_vendor_id = $2 WHERE arc_contract_line_id = $1 AND hotel_id = ANY($3::int[])`,
    [hqLineId, M_UP, [H_MH, H_UP]]
  );
});

afterEach(async () => {
  const poIds = (await db.any(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = ANY($1::bigint[])`, [mrIds])).map((r) => r.po_id);
  await db.none(`DELETE FROM tbl_arc_callof_po WHERE mr_id = ANY($1::bigint[])`, [mrIds]);
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]).catch(() => {});
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
  }
  await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::bigint[])`, [mrIds]);
  await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [mrIds]);
  mrIds.length = 0;
  await db.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arcId]);
  await deleteArcs([arcId]);
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_vendor_documents WHERE vendor_id = ANY($1::int[])`, [[HQ, M_UP, LEG]]);
  await cleanupVendorNetworkFixtures();
  sentMail.length = 0;
});

afterAll(async () => {
  nodemailer.createTransport = realTransport;
  await closeDb();
});

async function contractWithLine(vendorId, itemId) {
  const contractId = Number(
    (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, signed_by_vendor_at) VALUES ($1, $2, 'active', NOW()) RETURNING id`, [arcId, vendorId])).id
  );
  const lineId = Number(
    (
      await db.one(
        `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
         VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
        [contractId, itemId]
      )
    ).id
  );
  await db.none(
    `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
     VALUES ($1, $2, 300), ($1, $3, 300), ($1, $4, 300)`,
    [lineId, H_MH, H_UP, H_NONE]
  );
  return [contractId, lineId];
}

/**
 * An approved MR at `hotelId` for 10 of the contract's line, released in a transaction (as
 * mrController does). The PO number and release time are pinned so the document is stable.
 */
async function releaseCallOff(contractId, lineId, hotelId, tag) {
  const mrId = Number(
    (
      await db.one(
        `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id, status, raised_by)
         VALUES ($1, 'Linen', $2, $3, $4, 'approved', $5) RETURNING id`,
        [`MR-VN-GST-${tag}`, HC_A, hotelId, PROC, CREATOR]
      )
    ).id
  );
  mrIds.push(mrId);
  await db.none(
    `INSERT INTO tbl_material_requisition_item (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id)
     VALUES ($1, $2, 10, 'pcs', $3, $4)`,
    [mrId, VARIANT, contractId, lineId]
  );
  const released = await db.tx((t) => releaseForMr(mrId, t));
  expect(released).toHaveLength(1);
  const po = released[0].po;
  await db.none(`UPDATE tbl_rfq_purchase_order SET po_number = $2, created_at = '2026-10-06 10:00:00' WHERE id = $1`, [
    po.id,
    `CO-VN-GST-${tag}`,
  ]);
  return { ...po, po_number: `CO-VN-GST-${tag}` };
}

describe("call-off document with an unknown supplier state", () => {
  it("a no-GSTIN vendor's call-off renders exactly as before networks", async () => {
    const po = await releaseCallOff(legContractId, legLineId, H_MH, "LEG");
    const ctx = await loadCallOffPoContext(po.id);
    expect(renderCallOffPoHtml(ctx)).toMatchSnapshot();
  });
});

// --- gstState ---------------------------------------------------------------------------

describe("GST state codes", () => {
  it("reads the state code of a well-formed GSTIN, and nothing else", () => {
    expect(stateCodeFromGstin("27AABCD0971F1ZW")).toBe("27");
    expect(stateCodeFromGstin(" 09aabcm0971f1z3 ")).toBe("09");
    expect(stateCodeFromGstin("27AABCD0971F1Z")).toBeNull(); // 14 chars
    expect(stateCodeFromGstin("27AABCD0971F1XW")).toBeNull(); // 14th char must be Z
    expect(stateCodeFromGstin("99AABCD0971F1ZW")).toBeNull(); // no such state
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin("")).toBeNull();
  });

  it("is the full official list: 01-38 and 97", () => {
    const expected = [...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")), "97"];
    expect(Object.keys(GST_STATE_CODES).sort()).toEqual(expected);
    expect(GST_STATE_CODES["26"]).toBe("Dadra and Nagar Haveli and Daman and Diu");
    expect(GST_STATE_CODES["37"]).toBe("Andhra Pradesh");
    expect(GST_STATE_CODES["38"]).toBe("Ladakh");
  });

  it("matches state names, including the merged UTs, old names and the seed's typo", () => {
    expect(stateCodeFromName("Maharashtra")).toBe("27");
    expect(stateCodeFromName("  uttar  pradesh ")).toBe("09");
    expect(stateCodeFromName("Andhra Pradesh")).toBe("37");
    expect(stateCodeFromName("Dadra and Nagar Haveli")).toBe("26");
    expect(stateCodeFromName("Daman & Diu")).toBe("26");
    expect(stateCodeFromName("Orissa")).toBe("21");
    expect(stateCodeFromName("Himachal Praddesh")).toBe("02");
    expect(stateCodeFromName("Atlantis")).toBeNull();
    expect(stateCodeFromName(null)).toBeNull();
  });

  it("maps every Indian state in tbl_location_states to a code", async () => {
    const rows = await db.any(`SELECT state_name FROM tbl_location_states WHERE country_id = 1`);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => stateCodeFromName(r.state_name) == null).map((r) => r.state_name)).toEqual([]);
  });

  it("maps every Indian state name in production's tbl_location_states to a code", () => {
    // Production list (country 1), verified by the controller, typo row included.
    const prod = [
      "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
      "Chhattisgarh", "Dadra and Nagar Haveli", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Praddesh",
      "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
      "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab",
      "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttarakhand", "Uttar Pradesh", "West Bengal",
    ];
    expect(prod.filter((name) => stateCodeFromName(name) == null)).toEqual([]);
    expect(stateCodeFromName("Himachal Praddesh")).toBe("02");
    expect(stateCodeFromName("Dadra and Nagar Haveli")).toBe("26");
  });

  it("levies UTGST instead of SGST inside a Union Territory without a legislature", () => {
    expect(taxSplitFor("04", "04")).toBe("CGST_UTGST"); // Chandigarh
    expect(taxSplitFor("26", "26")).toBe("CGST_UTGST");
    expect(taxSplitFor("07", "07")).toBe("CGST_SGST"); // Delhi has a legislature
    expect(taxSplitFor("04", "03")).toBe("IGST");
    expect(taxLinesFor("CGST_UTGST", 18, 10.01)).toEqual([
      { label: "CGST", rate: 9, amount: 5 },
      { label: "UTGST", rate: 9, amount: 5.01 },
    ]);
  });

  it("does not guess a state for the pre-division Andhra Pradesh code 28", () => {
    expect(stateCodeFromGstin("28AABCD0971F1ZW")).toBe("28");
    expect(taxSplitFor("28", "37")).toBeNull();
    expect(taxSplitFor("28", "28")).toBeNull();
    expect(taxSplitFor("37", "28")).toBeNull();
  });

  it("splits within a state, charges IGST across states, and gives no answer when a side is unknown", () => {
    expect(taxSplitFor("27", "27")).toBe("CGST_SGST");
    expect(taxSplitFor("09", "27")).toBe("IGST");
    expect(taxSplitFor(null, "27")).toBeNull();
    expect(taxSplitFor("27", null)).toBeNull();
    expect(taxSplitFor("27", "99")).toBeNull();
    // A pre-merger Daman and Diu GSTIN (25) is the same territory as 26 today (a UT: UTGST).
    expect(taxSplitFor("25", "26")).toBe("CGST_UTGST");
  });

  it("halves the rate for CGST and SGST, and their amounts add up to the GST exactly", () => {
    expect(taxLinesFor("CGST_SGST", 5, 45.05)).toEqual([
      { label: "CGST", rate: 2.5, amount: 22.52 },
      { label: "SGST", rate: 2.5, amount: 22.53 },
    ]);
    expect(taxLinesFor("IGST", 18, 10)).toEqual([{ label: "IGST", rate: 18, amount: 10 }]);
    expect(taxLinesFor(null, 5, 45)).toEqual([{ label: "GST", rate: 5, amount: 45 }]);
  });

  it("takes the place of supply from the hotel GSTIN, else its state, else nothing", async () => {
    expect(await stateCodeForHotel(H_MH)).toBe("27");
    expect(await stateCodeForHotel(H_UP)).toBe("09");
    expect(await stateCodeForHotel(H_NONE)).toBeNull();
    // The GSTIN wins over a disagreeing state_id.
    await db.none(`UPDATE tbl_hospitality_company_hotels SET state_id = $2 WHERE id = $1`, [H_MH, UTTAR_PRADESH]);
    expect(await stateCodeForHotel(H_MH)).toBe("27");
  });

  it("reads the supplier's company name, GSTIN, latest address and state", async () => {
    expect(await supplierDetailsFor(M_UP)).toEqual({
      vendor_id: M_UP,
      name: "VN GST Noida Branch",
      email: "vn-gst-up@example.com",
      gstin: M_UP_GSTIN,
      address: "12 Industrial Area, Noida",
      state_name: "Uttar Pradesh",
      state_code: "09",
    });
  });

  it("falls back to the vendor's GST document when the company has no GSTIN", async () => {
    expect((await supplierDetailsFor(LEG)).gstin).toBeNull();
    await db.none(`INSERT INTO tbl_vendor_documents (vendor_id, document_type, document_number) VALUES ($1, 'gst', '24AABCL0971F1Z8')`, [LEG]);
    const leg = await supplierDetailsFor(LEG);
    expect(leg.gstin).toBe("24AABCL0971F1Z8");
    expect(leg.state_code).toBe("24");
    expect(leg.state_name).toBe("Gujarat");
  });
});

// --- call-off PO document -------------------------------------------------------------

describe("call-off document of a network member", () => {
  it("UP member delivering to a Maharashtra hotel: the member's block and IGST", async () => {
    const po = await releaseCallOff(hqContractId, hqLineId, H_MH, "IGST");
    expect(po.finalized_vendor_id).toBe(M_UP);
    const ctx = await loadCallOffPoContext(po.id);
    expect(ctx.supplier).toMatchObject({ name: "VN GST Noida Branch", gstin: M_UP_GSTIN, state_name: "Uttar Pradesh", state_code: "09" });
    expect(ctx.tax_split).toBe("IGST");

    const html = renderCallOffPoHtml(ctx);
    expect(html).toContain("VN GST Noida Branch");
    expect(html).toContain(`GSTIN: ${M_UP_GSTIN}`);
    expect(html).toContain("12 Industrial Area, Noida");
    expect(html).toContain("State: Uttar Pradesh (09)");
    expect(html).not.toContain("VN GST Principal");
    expect(html).toContain('<th class="r">IGST</th>');
    // 10 × ₹90 at 5%: ₹45 GST, all of it IGST.
    expect(html).toContain("5%<br/>₹45.00");
    expect(html).toContain("incl. IGST @ 5%</span><span>₹45.00");
    expect(html).not.toContain("CGST");
    expect(html).not.toContain("SGST");
  });

  it("UP member delivering to a UP hotel (state from state_id): CGST and SGST at half the rate each", async () => {
    const po = await releaseCallOff(hqContractId, hqLineId, H_UP, "SPLIT");
    const ctx = await loadCallOffPoContext(po.id);
    expect(ctx.tax_split).toBe("CGST_SGST");
    const html = renderCallOffPoHtml(ctx);
    expect(html).toContain('<th class="r">CGST</th><th class="r">SGST</th>');
    expect(html.split("2.5%<br/>₹22.50").length - 1).toBe(2);
    expect(html).toContain("incl. CGST @ 2.5%</span><span>₹22.50");
    expect(html).toContain("incl. SGST @ 2.5%</span><span>₹22.50");
    expect(html).not.toContain("IGST");
  });

  it("an unknown place of supply keeps the single GST column", async () => {
    const po = await releaseCallOff(hqContractId, hqLineId, H_NONE, "NONE");
    expect(po.finalized_vendor_id).toBe(HQ);
    const ctx = await loadCallOffPoContext(po.id);
    expect(ctx.tax_split).toBeNull();
    const html = renderCallOffPoHtml(ctx);
    expect(html).toContain('<th class="r">GST</th>');
    expect(html).toContain('<td class="r">5%</td>');
    expect(html).not.toMatch(/IGST|CGST|SGST|incl\./);
    // The supplier is still named with its registration.
    expect(html).toContain(`GSTIN: ${HQ_GSTIN}`);
  });

  it("the vendor PO detail API gives the same split", async () => {
    const igst = await releaseCallOff(hqContractId, hqLineId, H_MH, "API1");
    const split = await releaseCallOff(hqContractId, hqLineId, H_UP, "API2");
    const member = await httpClient(M_UP);

    const a = await member.get(`/api/v1/po/vendor/detail/${igst.id}`);
    expect(a.status).toBe(200);
    expect(a.body.data.tax_split).toBe("IGST");
    expect(a.body.data.place_of_supply_state_code).toBe("27");
    expect(a.body.data.pricing.tax_breakdown).toEqual([{ label: "IGST", rate: 5, amount: 45 }]);
    expect(a.body.data.pricing.taxable_value).toBe(900);
    expect(a.body.data.vendor).toMatchObject({ id: M_UP, gstin: M_UP_GSTIN, state_code: "09", state_name: "Uttar Pradesh", address: "12 Industrial Area, Noida" });

    const b = await member.get(`/api/v1/po/vendor/detail/${split.id}`);
    expect(b.body.data.tax_split).toBe("CGST_SGST");
    expect(b.body.data.pricing.tax_breakdown).toEqual([
      { label: "CGST", rate: 2.5, amount: 22.5 },
      { label: "SGST", rate: 2.5, amount: 22.5 },
    ]);
  });
});

describe("call-off GST includes the tax on charges", () => {
  // 10 × ₹90 at 5%, freight 2% of base (inherits 5%), packing ₹50 taxed at 18%:
  // base 900 + 45; freight 18 + 0.90; packing 50 + 9 → taxable 968, GST 54.90, total 1022.90.
  const CHARGES = [
    { name: "Freight", amount: 2, amount_mode: "percentage", tax: null },
    { name: "Packing", amount: 50, amount_mode: "absolute", tax: 18, tax_mode: "percentage" },
  ];
  const paise = (v) => Math.round(Number(v) * 100);
  const reconciles = (t, total) =>
    expect(paise(t.taxable_value) + t.tax_lines.reduce((sum, r) => sum + paise(r.amount), 0)).toBe(paise(total));

  it("every split reconciles to the line total to the paisa, odd rates included", () => {
    for (const freight of [2, 1.5, 0.37]) {
      for (const quantity of [1, 7, 10, 333]) {
        const line = {
          unit_price: 90.17, quantity, tax: 5,
          other_charges: [{ ...CHARGES[0], amount: freight }, CHARGES[1]],
        };
        for (const split of ["IGST", "CGST_SGST", "CGST_UTGST", null]) {
          const t = callOffLineTax(line, split);
          reconciles(t, t.total);
        }
      }
    }
  });

  it("IGST and CGST/SGST documents and the detail API carry the charge tax, reconciling to total_price", async () => {
    await db.none(`UPDATE tbl_arc_contract_line SET charges = $2 WHERE id = $1`, [hqLineId, JSON.stringify(CHARGES)]);
    const igst = await releaseCallOff(hqContractId, hqLineId, H_MH, "CHG1");
    const split = await releaseCallOff(hqContractId, hqLineId, H_UP, "CHG2");

    for (const [po, mode] of [[igst, "IGST"], [split, "CGST_SGST"]]) {
      const lines = await db.any(`SELECT unit_price, quantity, charges_meta, total_price FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po.id]);
      expect(Number(lines[0].total_price)).toBe(1022.9);
      const t = callOffPoTax(lines, mode);
      expect(t.taxable_value).toBe(968);
      reconciles(t, lines[0].total_price);
    }

    const igstHtml = renderCallOffPoHtml(await loadCallOffPoContext(igst.id));
    expect(igstHtml).toContain("Taxable value</span><span>₹968.00");
    expect(igstHtml).toContain("incl. IGST @ 5%</span><span>₹45.90");
    expect(igstHtml).toContain("incl. IGST @ 18%</span><span>₹9.00");
    expect(igstHtml).toContain("5% + 18%<br/>₹54.90");

    const splitHtml = renderCallOffPoHtml(await loadCallOffPoContext(split.id));
    expect(splitHtml).toContain("incl. CGST @ 2.5%</span><span>₹22.95");
    expect(splitHtml).toContain("incl. SGST @ 2.5%</span><span>₹22.95");
    expect(splitHtml).toContain("incl. CGST @ 9%</span><span>₹4.50");
    expect(splitHtml).toContain("incl. SGST @ 9%</span><span>₹4.50");

    const member = await httpClient(M_UP);
    const a = (await member.get(`/api/v1/po/vendor/detail/${igst.id}`)).body.data;
    expect(a.pricing.taxable_value).toBe(968);
    expect(a.pricing.tax_breakdown).toEqual([
      { label: "IGST", rate: 5, amount: 45.9 },
      { label: "IGST", rate: 18, amount: 9 },
    ]);
    const b = (await member.get(`/api/v1/po/vendor/detail/${split.id}`)).body.data;
    expect(b.pricing.tax_breakdown).toEqual([
      { label: "CGST", rate: 2.5, amount: 22.95 },
      { label: "SGST", rate: 2.5, amount: 22.95 },
      { label: "CGST", rate: 9, amount: 4.5 },
      { label: "SGST", rate: 9, amount: 4.5 },
    ]);
  });

  it("header tax, tax_breakdown and item gst_amount all carry the full line tax", async () => {
    await db.none(`UPDATE tbl_arc_contract_line SET charges = $2 WHERE id = $1`, [hqLineId, JSON.stringify(CHARGES)]);
    const igst = await releaseCallOff(hqContractId, hqLineId, H_MH, "FULL1");
    const split = await releaseCallOff(hqContractId, hqLineId, H_UP, "FULL2");
    const member = await httpClient(M_UP);
    for (const po of [igst, split]) {
      const d = (await member.get(`/api/v1/po/vendor/detail/${po.id}`)).body.data;
      const breakdown = d.pricing.tax_breakdown.reduce((sum, r) => sum + paise(r.amount), 0);
      const items = d.items.reduce((sum, i) => sum + paise(i.gst_amount), 0);
      expect(paise(d.pricing.tax)).toBe(5490);
      expect(breakdown).toBe(5490);
      expect(items).toBe(5490);
      expect(paise(d.pricing.taxable_value) + paise(d.pricing.tax)).toBe(paise(d.pricing.total));
    }
  });
});

// --- contract PDF -----------------------------------------------------------------------

describe("contract document supplier GSTIN", () => {
  const supplierMeta = (html) => html.slice(html.indexOf('<div class="role">Supplier</div>'), html.indexOf("1. Scope"));

  async function renderFor(contractId) {
    const contract = await arcContractModel.getById(contractId);
    const vendor = await loadContractVendorParty(contract);
    const ctx = await loadContractDocContext(arcId);
    const lines = await arcContractModel.listLines(contractId);
    return { vendor, html: renderContractDocumentHtml(ctx, vendor, lines, { annexures: [] }) };
  }

  it("prints the principal's GSTIN, not N/A", async () => {
    const { vendor, html } = await renderFor(hqContractId);
    expect(vendor).toEqual({ name: "VN GST Principal", email: "vn-gst-hq@example.com", gstin: HQ_GSTIN });
    expect(supplierMeta(html)).toContain(`GSTIN: ${HQ_GSTIN}`);
    expect(supplierMeta(html)).not.toContain("GSTIN: N/A");
  });

  it("prefers the GSTIN the vendor quoted under", async () => {
    await db.none(`INSERT INTO tbl_arc_quote (arc_id, vendor_id, gstin_used) VALUES ($1, $2, '27AABCH0971F2ZV')`, [arcId, HQ]);
    const { html } = await renderFor(hqContractId);
    expect(supplierMeta(html)).toContain("GSTIN: 27AABCH0971F2ZV");
  });

  const purchaserMeta = (html) => html.slice(html.indexOf('<div class="role">Purchaser</div>'), html.indexOf('<div class="role">Supplier</div>'));

  it("prints the lead hotel's GSTIN for the purchaser, else its company's, else N/A", async () => {
    expect(purchaserMeta((await renderFor(hqContractId)).html)).toContain(`GSTIN: ${H_MH_GSTIN}`);

    const companyGst = (await db.one(`SELECT gst FROM tbl_hospitality_companies WHERE id = $1`, [HC_A])).gst;
    try {
      await db.none(`UPDATE tbl_hospitality_company_hotels SET gst = NULL WHERE id = $1`, [H_MH]);
      await db.none(`UPDATE tbl_hospitality_companies SET gst = '27AAACW1234F1ZQ' WHERE id = $1`, [HC_A]);
      expect(purchaserMeta((await renderFor(hqContractId)).html)).toContain("GSTIN: 27AAACW1234F1ZQ");
      await db.none(`UPDATE tbl_hospitality_companies SET gst = NULL WHERE id = $1`, [HC_A]);
      expect(purchaserMeta((await renderFor(hqContractId)).html)).toContain("GSTIN: N/A");
    } finally {
      await db.none(`UPDATE tbl_hospitality_companies SET gst = $2 WHERE id = $1`, [HC_A, companyGst]);
    }
  });

  it("still prints N/A for a vendor with no GSTIN anywhere", async () => {
    const { vendor, html } = await renderFor(legContractId);
    expect(vendor.gstin).toBeNull();
    expect(supplierMeta(html)).toContain("GSTIN: N/A");
  });

  // Task 20 / D2: the vendor accept/contract page previews the document from this JSON,
  // so it must carry the same two GSTINs the PDF prints.
  const detail = async (userId, contractId) => {
    const res = await (await httpClient(userId)).get(`/api/v1/arc-v2/vendor/contracts/${contractId}`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it("the vendor contract detail JSON carries the document's supplier and purchaser GSTINs", async () => {
    const hq = await detail(HQ, hqContractId);
    expect(hq.contract.vendor_gstin).toBe(HQ_GSTIN);
    expect(hq.arc.purchaser_gstin).toBe(H_MH_GSTIN);
    expect(hq.arc).not.toHaveProperty("company_gstin");

    await db.none(`INSERT INTO tbl_arc_quote (arc_id, vendor_id, gstin_used) VALUES ($1, $2, '27AABCH0971F2ZV')`, [arcId, HQ]);
    expect((await detail(HQ, hqContractId)).contract.vendor_gstin).toBe("27AABCH0971F2ZV");

    const leg = await detail(LEG, legContractId);
    expect(leg.contract.vendor_gstin).toBeNull();
  });

  it("a fulfilment member's view names the contract holder's GSTIN; a hidden lead hotel's GSTIN is withheld", async () => {
    // The member view is granted by ACCEPTED ARC_HOTEL assignments (spec §6.4).
    await db.none(
      `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status)
       SELECT $1, 'ARC_HOTEL', $2, h, $3, 'ACCEPTED' FROM unnest($4::int[]) h`,
      [ORG, hqContractId, M_UP, [H_MH, H_UP]]
    );
    const member = await detail(M_UP, hqContractId);
    expect(member.viewer_role).toBe("fulfilment_member");
    expect(member.contract.vendor_gstin).toBe(HQ_GSTIN);
    expect(member.arc.purchaser_gstin).toBe(H_MH_GSTIN); // it fulfils the lead hotel

    // M_UP keeps only H_UP: the lead hotel (and its GSTIN) is no longer its business.
    await db.none(
      `UPDATE tbl_vendor_routing_assignments SET status = 'REVOKED'
        WHERE org_id = $1 AND subject_id = $2 AND hotel_id = $3`,
      [ORG, hqContractId, H_MH]
    );
    await db.none(
      `UPDATE tbl_arc_contract_line_hotel SET fulfilling_vendor_id = NULL WHERE arc_contract_line_id = $1 AND hotel_id = $2`,
      [hqLineId, H_MH]
    );
    const companyGst = (await db.one(`SELECT NULLIF(trim(gst), '') AS gst FROM tbl_hospitality_companies WHERE id = $1`, [HC_A])).gst;
    const narrowed = await detail(M_UP, hqContractId);
    expect(narrowed.arc.hotel_name).toBeNull();
    expect(narrowed.arc.purchaser_gstin).toBe(companyGst);
    expect(narrowed.arc.purchaser_gstin).not.toBe(H_MH_GSTIN);
  });
});

// --- MR picker and ledger inheritance use the release's ACTIVE gate ---------------------

describe("the effective supplier is the same everywhere", () => {
  const hqRow = async (hotelId) =>
    (await mrModel.searchContractedItems({ hotel_id: hotelId, department_id: PROC })).find(
      (r) => Number(r.arc_contract_id) === hqContractId
    );

  it("the MR picker shows the ACTIVE member fulfilling the hotel, and the principal after a suspension", async () => {
    expect(await hqRow(H_MH)).toMatchObject({ vendor_id: M_UP, vendor_name: "VN GST Noida Branch" });
    expect(await hqRow(H_NONE)).toMatchObject({ vendor_id: HQ, vendor_name: "VN GST Principal" });

    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE org_id = $1 AND vendor_id = $2`, [ORG, M_UP]);
    expect(await hqRow(H_MH)).toMatchObject({ vendor_id: HQ, vendor_name: "VN GST Principal" });
    // ...and the release agrees with the picker.
    const po = await releaseCallOff(hqContractId, hqLineId, H_MH, "SUSP");
    expect(po.finalized_vendor_id).toBe(HQ);
  });

  it("a new ledger row inherits the ACCEPTED assignee only while it is ACTIVE in the contract vendor's org", async () => {
    await db.none(
      `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status, acted_at)
       VALUES ($1, 'ARC_HOTEL', $2, $3, $4, 'ACCEPTED', now())`,
      [ORG, hqContractId, H_NONE, M_UP]
    );
    const award = [H_MH, H_UP, H_NONE].map((hotel_id) => ({ hotel_id, allocated_qty: 300 }));
    const resync = async () => {
      await db.none(`DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id = $1 AND hotel_id = $2`, [hqLineId, H_NONE]);
      await arcHotelModel.syncContractLineHotels(hqLineId, award);
      return (
        await db.one(`SELECT fulfilling_vendor_id FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id = $1 AND hotel_id = $2`, [
          hqLineId,
          H_NONE,
        ])
      ).fulfilling_vendor_id;
    };
    expect(await resync()).toBe(M_UP);
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE org_id = $1 AND vendor_id = $2`, [ORG, M_UP]);
    expect(await resync()).toBeNull();
  });
});

// --- vendor acceptance reminders ----------------------------------------------------------

describe("vendor acceptance reminders", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("a pending call-off is due a reminder, with its contract's ARC number", async () => {
    const po = await releaseCallOff(hqContractId, hqLineId, H_MH, "REM");
    await db.none(`UPDATE tbl_rfq_purchase_order SET updated_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [po.id]);
    const updatedAt = (await db.one(`SELECT updated_at FROM tbl_rfq_purchase_order WHERE id = $1`, [po.id])).updated_at;

    const due = (await findPosNeedingVendorReminder(new Date())).find((r) => r.id === po.id);
    expect(due).toMatchObject({ is_call_off: true, reminder_to_send: 1, arc_number: "ARC-VN-GST-1", rfq_no: null });
    const early = await findPosNeedingVendorReminder(new Date(new Date(updatedAt).getTime() + DAY / 2));
    expect(early.find((r) => r.id === po.id)).toBeUndefined();
  });

  it("the call-off reminder names the rate contract and its items, not an RFQ", async () => {
    const po = await releaseCallOff(hqContractId, hqLineId, H_MH, "MAIL");
    const [due] = (await findPosNeedingVendorReminder(new Date(Date.now() + 2 * DAY))).filter((r) => r.id === po.id);
    await sendPOAcceptanceReminderToVendor(due, { rfq_no: due.rfq_no, title: due.rfq_title, arc_number: due.arc_number }, 1);
    const mail = sentMail.find((m) => m.to === "vn-gst-up@example.com");
    expect(mail).toBeDefined();
    expect(mail.html).toContain("<strong>Rate contract:</strong> ARC-VN-GST-1");
    expect(mail.html).not.toContain("<strong>RFQ:</strong>");
    const product = (await db.one(`SELECT name FROM tbl_product_variant WHERE id = $1`, [VARIANT])).name;
    expect(mail.html).toContain(product);
    expect(mail.html).toContain("Rs. 945");
  });

  it("RFQ POs are reminded exactly as before: tiers by days and count, other statuses skipped", async () => {
    await withTx(async (t) => {
      const vendor = IDS.users.vendor_alpha;
      const { rfq_id, rfq_no } = await makeRFQ(t, { createdBy: IDS.users.a1_proc_buyer });
      const mk = async (status, count, daysAgo) => {
        const { po_id } = await makePO(t, { rfq_id, company_id: IDS.companies.A, vendor_user_id: vendor, status });
        await t.none(
          `UPDATE tbl_rfq_purchase_order SET vendor_reminder_count = $2, updated_at = NOW() - ($3 || ' days')::interval WHERE id = $1`,
          [po_id, count, String(daysAgo)]
        );
        return po_id;
      };
      const first = await mk("acceptance_pending", 0, 2);
      const second = await mk("acceptance_pending", 1, 4);
      const final = await mk("acceptance_pending", 2, 6);
      const tooSoon = await mk("acceptance_pending", 1, 2);
      const exhausted = await mk("acceptance_pending", 3, 10);
      const notPending = await mk("approved", 0, 10);

      const due = await findPosNeedingVendorReminder(new Date(), t);
      const mine = Object.fromEntries(
        due.filter((r) => [first, second, final, tooSoon, exhausted, notPending].includes(r.id)).map((r) => [r.id, r])
      );
      expect(Object.keys(mine).map(Number).sort((x, y) => x - y)).toEqual([first, second, final].sort((x, y) => x - y));
      expect(mine[first]).toMatchObject({ reminder_to_send: 1, rfq_no, is_call_off: false, arc_number: null });
      expect(mine[second].reminder_to_send).toBe(2);
      expect(mine[final].reminder_to_send).toBe(3);
    });
  });
});
