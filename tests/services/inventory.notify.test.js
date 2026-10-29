// Receiving notices and the GRN document (Task B5, spec §10 "Notifications").
//
//   GRN posted    → PO initiator and vendor, in-app + email, accepted /
//                   rejected per line
//   rejections    → vendor in-app notice with the reasons (the one vendor
//                   email per GRN comes from the GRN-posted notice)
//   short-close   → vendor and initiator
//   RTV dispatched → vendor
//
// The real builders run; only the mail transport (sendMail) and the in-app
// dispatch are replaced so the payloads can be read. Every notifier is handed
// the test's transaction, so the fixtures stay inside withTx.

import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";

const sentMails = [];
const dispatched = [];

const actualCommon = await import("../../app/helper/common.js");
jest.unstable_mockModule("../../app/helper/common.js", () => ({
  ...actualCommon,
  sendMail: async (opts) => {
    sentMails.push(opts);
    return { messageId: "<captured>" };
  },
}));
const actualNotifications = await import("../../app/services/notificationService.js");
jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  ...actualNotifications,
  dispatch: async (args) => {
    dispatched.push(args);
    return [];
  },
}));

const { withTx, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const {
  notifyGrnPosted, notifyGrnRejections, notifyShortClose, notifyRtvDispatched,
} = await import("../../app/services/inventory/notices/receivingNotices.js");
const { shortClose } = await import("../../app/services/inventory/shortCloseService.js");
const { createRtv, dispatchRtv } = await import("../../app/services/inventory/rtvService.js");
const { loadGrnDocument, buildGrnHtml, renderGrnPdf } = await import("../../app/services/inventory/grnPdf.js");
const { shortUrl } = await import("../../app/services/inventory/shortUrl.js");
const { inventoryGrn, vendorPoDeliveries, inventoryPoDeliveries } = await import("../../app/services/notificationLinks.js");
const { grantRoleScope } = await import("../helpers/roleScope.js");
const {
  CO, A1, BUYER, VENDOR, makeRfqPo, setPlan, postReceiptGrn,
} = await import("../helpers/invReceiptFixtures.js");

const OWNER = { id: IDS.users.companyA_admin, user_type: 2 };
const STORES = { id: BUYER, user_type: 2 };

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

afterAll(async () => {
  await closeDb();
});

const emailOf = async (t, id) => (await t.one(`SELECT email FROM tbl_users WHERE id = $1`, [id])).email;
const mailTo = (email) => sentMails.filter((m) => m.to === email);
const noticeFor = (userId) => dispatched.filter((d) => d.userIds.includes(userId));

/** A two-line PO at A1, received: line 1 8 accepted + 2 damaged, line 2 5 accepted. */
async function receivedPo(t) {
  const po = await makeRfqPo(t, {
    lines: [{ qty: 10, unit: "kg", variantId: 1 }, { qty: 5, unit: "nos", variantId: 3 }],
  });
  const [l1, l2] = po.lineIds;
  const grn = await postReceiptGrn(t, {
    poId: po.poId, vendorChallanNo: "DC-4471",
    lines: [
      { poLineId: l1, accepted: 8, rejected: 2, rejectionReason: "damaged", batchNo: "B-77", expiryDate: "2027-03-31" },
      { poLineId: l2, accepted: 5 },
    ],
  });
  return { ...po, grn };
}

describe("receiving notices", () => {
  it("GRN post notifies initiator and vendor with accepted/rejected", async () => {
    await withTx(async (t) => {
      const { poId, poNumber, grn } = await receivedPo(t);
      await notifyGrnPosted(t, { grnId: grn.grnId });

      const [toInitiator] = noticeFor(BUYER);
      expect(toInitiator).toMatchObject({
        category: "grn", type: "GRN_POSTED", actionUrl: inventoryGrn(grn.grnId),
        data: { po_id: poId, grn_id: grn.grnId },
      });
      expect(toInitiator.title).toContain(grn.grnNumber);
      expect(toInitiator.body).toMatch(/13 accepted, 2 rejected/);
      const [toVendor] = noticeFor(VENDOR);
      expect(toVendor).toMatchObject({ actionUrl: vendorPoDeliveries(poId), data: { po_id: poId, grn_id: grn.grnId } });
      expect(toVendor.title).toContain(poNumber);
      expect(dispatched).toHaveLength(2);

      const [vendorMail] = mailTo(await emailOf(t, VENDOR));
      expect(vendorMail.subject).toContain(grn.grnNumber);
      for (const s of ["7 UP PEPSI 1.5 LTR", "PEPSI 600 ML", "Damaged", "DC-4471"]) expect(vendorMail.html).toContain(s);
      expect(vendorMail.html).toMatch(/>8<\/td>\s*<td[^>]*>2<\/td>/); // accepted 8, rejected 2 on line 1
      const [initiatorMail] = mailTo(await emailOf(t, BUYER));
      expect(initiatorMail.html).toContain("Damaged");
      expect(sentMails).toHaveLength(2);
    });
  });

  it("posting a GRN with rejections sends exactly one vendor email", async () => {
    await withTx(async (t) => {
      const { poId, grn } = await receivedPo(t);
      // B1 calls both after the post commits.
      await notifyGrnPosted(t, { grnId: grn.grnId });
      await notifyGrnRejections(t, { grnId: grn.grnId });

      const vendorMails = mailTo(await emailOf(t, VENDOR));
      expect(vendorMails).toHaveLength(1);
      expect(vendorMails[0].html).toContain("Damaged");
      expect(vendorMails[0].html).toMatch(/>8<\/td>\s*<td[^>]*>2<\/td>/);

      // The rejections add one in-app notice for the vendor, naming only the rejected lines.
      const rejections = dispatched.filter((d) => d.type === "GRN_REJECTIONS");
      expect(rejections).toEqual([expect.objectContaining({
        userIds: [VENDOR], category: "grn", actionUrl: vendorPoDeliveries(poId), data: { po_id: poId, grn_id: grn.grnId },
      })]);
      expect(rejections[0].title).toContain(grn.grnNumber);
      expect(rejections[0].body).toContain("7 UP PEPSI 1.5 LTR");
      expect(rejections[0].body).toContain("Damaged");
      expect(rejections[0].body).not.toContain("PEPSI 600 ML");
    });
  });

  it("GRN rejections stay quiet without rejections", async () => {
    await withTx(async (t) => {
      const clean = await makeRfqPo(t);
      const ok = await postReceiptGrn(t, { poId: clean.poId, lines: [{ poLineId: clean.lineIds[0], accepted: 10 }] });
      await notifyGrnRejections(t, { grnId: ok.grnId });
      expect(sentMails).toEqual([]);
      expect(dispatched).toEqual([]);
    });
  });

  it("short-close notifies vendor", async () => {
    await withTx(async (t) => {
      const { poId, lineIds: [line] } = await makeRfqPo(t);
      await setPlan(t, poId, [
        { hotelId: A1, phaseNo: 1, lines: { [line]: 6 } },
        { hotelId: A1, phaseNo: 2, lines: { [line]: 4 } },
      ]);
      const out = await shortClose(t, OWNER, poId, {
        target: { type: "po" }, reasonCode: "vendor_cannot_supply", remarks: "Season over",
      });
      await notifyShortClose(t, { poId, shortCloseIds: out.shortCloseIds });

      const [toVendor] = noticeFor(VENDOR);
      expect(toVendor).toMatchObject({ category: "grn", type: "PO_SHORT_CLOSED", actionUrl: vendorPoDeliveries(poId) });
      expect(toVendor.body).toContain("10");
      const [toInitiator] = noticeFor(BUYER);
      expect(toInitiator).toMatchObject({ actionUrl: inventoryPoDeliveries(poId) });

      const [mail] = mailTo(await emailOf(t, VENDOR));
      expect(mail.subject).toMatch(/short-closed/i);
      for (const s of ["7 UP PEPSI 1.5 LTR", "Vendor cannot supply", "Season over", "Phase 2"]) expect(mail.html).toContain(s);
      expect(mailTo(await emailOf(t, BUYER))).toHaveLength(1);
    });
  });

  it("the initiator is not told about their own short-close", async () => {
    await withTx(async (t) => {
      const { poId } = await makeRfqPo(t, { initiatedBy: OWNER.id });
      const out = await shortClose(t, OWNER, poId, { target: { type: "po" }, reasonCode: "no_longer_needed" });
      await notifyShortClose(t, { poId, shortCloseIds: out.shortCloseIds });
      expect(dispatched.map((d) => d.userIds)).toEqual([[VENDOR]]);
      expect(sentMails.map((m) => m.to)).toEqual([await emailOf(t, VENDOR)]);
    });
  });

  it("RTV dispatched notifies vendor", async () => {
    await withTx(async (t) => {
      const role = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Inventory Controller' AND created_by IS NULL`);
      await grantRoleScope(t, { userId: STORES.id, roleId: role.id, companyId: CO, hotelId: A1 });
      const { poId, grn } = await receivedPo(t);
      const rtv = await createRtv(t, STORES, {
        grnId: grn.grnId, disposition: "REPLACE", lines: [{ grnLineId: grn.lines[1].grnLineId, qty: 2, reason: "Dented cans" }],
      });
      const sent = await dispatchRtv(t, STORES, rtv.id, {});
      await notifyRtvDispatched(t, { rtvId: rtv.id });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        userIds: [VENDOR], type: "RTV_DISPATCHED", actionUrl: vendorPoDeliveries(poId), data: { po_id: poId, rtv_id: rtv.id },
      });
      const [mail] = sentMails;
      expect(mail.to).toBe(await emailOf(t, VENDOR));
      expect(mail.subject).toContain(sent.rtvNumber);
      for (const s of ["PEPSI 600 ML", "Dented cans", "replacement"]) expect(mail.html).toContain(s);
    });
  });

  it("never throws, whatever goes wrong", async () => {
    await withTx(async (t) => {
      await expect(notifyGrnPosted(t, { grnId: 999999999 })).resolves.toBeUndefined();
      await expect(notifyShortClose(t, { poId: 999999999, shortCloseIds: [1] })).resolves.toBeUndefined();
      await expect(notifyRtvDispatched(t, { rtvId: "nope" })).resolves.toBeUndefined();
      await expect(notifyGrnRejections(null, {})).resolves.toBeUndefined();
      expect(dispatched).toEqual([]);
      expect(sentMails).toEqual([]);
    });
  });
});

describe("GRN document", () => {
  it("GRN PDF HTML contains lines, rejection reasons and QR", async () => {
    await withTx(async (t) => {
      const { poNumber, grn } = await receivedPo(t);
      const ctx = await loadGrnDocument(t, grn.grnId);
      const html = buildGrnHtml(ctx);

      for (const s of [
        "Goods Receipt Note", grn.grnNumber, poNumber, "DC-4471",
        "7 UP PEPSI 1.5 LTR", "PEPSI 600 ML", "Damaged", "B-77", "31 Mar 2027",
        "Received by", "Checked by", "Approved by",
      ]) {
        expect(html).toContain(s);
      }
      // Line 1: ordered for the hotel 10, received 10, accepted 8, rejected 2.
      expect(ctx.lines[0]).toMatchObject({ orderedForHotel: 10, received: 10, accepted: 8, rejected: 2, rejectionLabel: "Damaged" });
      expect(html).toContain("<svg");
      expect(html).toContain(shortUrl("g", grn.grnId));
      expect(html).not.toMatch(/<script|https?:\/\/(?!localhost)[^"]*\.(css|js|png)/i);

      const url = await renderGrnPdf(t, grn.grnId);
      expect(url).toMatch(new RegExp(`/grn/${CO}/${grn.grnId}-`));
    });
  });
});
