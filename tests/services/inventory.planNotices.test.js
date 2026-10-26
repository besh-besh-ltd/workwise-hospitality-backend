// Delivery-plan notices to the vendor (Task B2, spec §7), with the real
// notifier: an accepted PO's plan change writes the vendor an in-app notice
// every time, and an email at most once per PO per quarter hour, so a buyer
// fixing two dates in a row does not send two emails.
//
// sendMail is wrapped (the transport is already stubbed by jestEnv) so the
// emails are countable; everything else runs for real and commits, and each
// test cleans up after itself.

import { describe, it, expect, afterAll, afterEach, jest } from "@jest/globals";

const actualCommon = await import("../../app/helper/common.js");
const sendMail = jest.fn((opts) => actualCommon.sendMail(opts));
jest.unstable_mockModule("../../app/helper/common.js", () => ({ ...actualCommon, sendMail }));

const { db, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const fx = await import("../helpers/invPlanFixtures.js");
const { httpClient } = await import("../helpers/http.js");
const { getDeliveries, planFollowUpsSettled } = await import("../../app/services/inventory/planService.js");
const { notifyPlanChanged } = await import("../../app/services/inventory/notices/planNotices.js");

const { VENDOR } = fx;
const ADMIN = IDS.users.companyA_admin;
const admin = { id: ADMIN, user_type: 2 };
const VENDOR_EMAIL = "alpha@vendor.test";

const tr = fx.newTracker();
afterEach(async () => {
  await planFollowUpsSettled();
  if (tr.poIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE type = 'po_delivery_plan_changed' AND (additional_data->>'po_id')::int = ANY($1::int[])`,
      [tr.poIds]
    );
  }
  await fx.cleanupTracked(db, tr);
  sendMail.mockClear();
});
afterAll(async () => {
  await closeDb();
});

const planNotices = (poId) => db.any(
  `SELECT recipient_user_id, title, action_url FROM tbl_notifications
    WHERE type = 'po_delivery_plan_changed' AND (additional_data->>'po_id')::int = $1
    ORDER BY id`,
  [poId]
);
const planEmails = (poNumber) => sendMail.mock.calls
  .map(([opts]) => opts)
  .filter((o) => o?.to === VENDOR_EMAIL && String(o?.subject).includes(poNumber));

describe("delivery plan notices", () => {
  it("tells the vendor in-app and by email, with the schedule and no prices", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10, unit: "kg" }] }));
    await db.tx((t) => getDeliveries(t, admin, po.poId));

    await notifyPlanChanged(db, { poId: po.poId, actorUserId: ADMIN });

    expect(await planNotices(po.poId)).toEqual([
      expect.objectContaining({
        recipient_user_id: VENDOR,
        title: `Delivery schedule updated for PO ${po.poNumber}`,
        action_url: expect.stringContaining(String(po.poId)),
      }),
    ]);
    const [mail] = planEmails(po.poNumber);
    expect(mail).toBeDefined();
    expect(mail.html).toContain("Hotel A-1");
    expect(mail.html).toContain("10 kg");
    expect(mail.html).not.toMatch(/₹|\bunit price\b|\brate\b|\bamount\b/i);
  });

  it("two date changes in a row: two in-app notices, one email", async () => {
    const po = await db.tx((t) => fx.makeRfqPo(t, { status: "approved", tracker: tr, lines: [{ qty: 10 }] }));
    const c = await httpClient(ADMIN);
    const read = await c.get(`/api/v1/inventory/po/${po.poId}/deliveries`);
    expect(read.status).toBe(200);
    const [delivery] = read.body.data.deliveries;

    const first = await c.patch(`/api/v1/inventory/po/${po.poId}/deliveries/${delivery.id}`).send({ dueDate: "2030-11-10" });
    const second = await c.patch(`/api/v1/inventory/po/${po.poId}/deliveries/${delivery.id}`).send({ dueDate: "2030-11-12" });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.data.deliveries[0].dueDate).toBe("2030-11-12");

    // The notices follow the responses.
    await planFollowUpsSettled();
    expect(await planNotices(po.poId)).toHaveLength(2);
    expect(planEmails(po.poNumber)).toHaveLength(1);
  });
});
