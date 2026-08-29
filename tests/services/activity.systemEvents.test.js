/**
 * Things the platform does on its own, in the activity trail.
 *
 * The HTTP capture middleware covers every mutating request, which is most of
 * what happens — but roughly a dozen consequential things happen with no
 * request behind them at all: a negotiation round closing on its deadline, a
 * rate contract lapsing, a scheduled publish going out or failing its last
 * retry. Several are critical, and today they happen invisibly: an admin
 * asking "why did this close?" has nowhere to look, because nobody did it.
 *
 * The two properties that matter are that the event lands in the right
 * company's feed — a cron job knows an entity id and nothing else — and that
 * it is attributed to the platform rather than to a person. Rendering a
 * scheduled closure as though somebody chose it is the fastest way to make an
 * admin distrust the whole feed.
 */
import { describe, it, expect, afterAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

jest.unstable_mockModule(
  "@aws-sdk/client-scheduler",
  () => ({
    SchedulerClient: class { send = async () => ({}); },
    CreateScheduleCommand: class {},
    UpdateScheduleCommand: class {},
    DeleteScheduleCommand: class {},
    GetScheduleCommand: class {},
    ListSchedulesCommand: class {},
    CreateScheduleGroupCommand: class {},
  })
);

const { recordSystemEvent } = await import("../../app/services/activity/systemEvents.js");

const madeRfqs = [];

const eventsFor = (entityId) =>
  db.any(
    `SELECT event_key, source, severity, actor_type, actor_user_id, actor_label,
            hospitality_company_id, hotel_id, entity_type, entity_id, entity_label, summary
       FROM tbl_activity_events
      WHERE entity_id = $1
      ORDER BY id DESC`,
    [entityId]
  );

afterAll(async () => {
  if (madeRfqs.length) {
    await db.none("DELETE FROM tbl_activity_events WHERE entity_id = ANY($1::bigint[])", [madeRfqs]);
    await db.none("DELETE FROM tbl_rfq WHERE id = ANY($1::int[])", [madeRfqs]);
  }
  await closeDb();
});

describe("an event with no request behind it", () => {
  it("finds the right company from the entity alone", async () => {
    // The whole difficulty: a scheduled job holds an entity id and nothing
    // about which company it belongs to, and the company is the scoping key —
    // without it the row could never be shown to anybody.
    const { rfq_id } = await makeRFQ(db, { createdBy: IDS.users.a1_proc_buyer });
    madeRfqs.push(rfq_id);

    const id = await recordSystemEvent({
      eventKey: "rfq_auto_published",
      entityType: "RFQ",
      entityId: rfq_id,
      summary: (label) => `RFQ ${label} was published automatically at its scheduled time`,
    });
    expect(id).toBeTruthy();

    const [event] = await eventsFor(rfq_id);
    expect(event.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(event.hotel_id).toBe(IDS.hotels.A1);
  });

  it("is attributed to the platform, not to a person", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: IDS.users.a1_proc_buyer });
    madeRfqs.push(rfq_id);

    await recordSystemEvent({
      eventKey: "negotiation_round_expired",
      severity: "critical",
      entityType: "RFQ",
      entityId: rfq_id,
      summary: "A negotiation round closed on its deadline",
    });

    const [event] = await eventsFor(rfq_id);
    expect(event.actor_type).toBe("SYSTEM");
    expect(event.actor_user_id).toBeNull();
    expect(event.source).toBe("CRON");
    expect(event.severity).toBe("critical");
  });

  it("names the entity in the sentence, which only the lookup knows", async () => {
    // A feed line reading "RFQ 536445" rather than "RFQ #12084" is the whole
    // reason the summary is a function of the resolved label.
    const { rfq_id, rfq_no } = await makeRFQ(db, { createdBy: IDS.users.a1_proc_buyer });
    madeRfqs.push(rfq_id);

    await recordSystemEvent({
      eventKey: "rfq_auto_published",
      entityType: "RFQ",
      entityId: rfq_id,
      summary: (label) => `RFQ ${label} was published automatically at its scheduled time`,
    });

    const [event] = await eventsFor(rfq_id);
    expect(event.entity_label).toBe(String(rfq_no));
    expect(event.summary).toContain(String(rfq_no));
  });

  it("writes nothing rather than an unshowable row when the entity is gone", async () => {
    const id = await recordSystemEvent({
      eventKey: "rfq_auto_published",
      entityType: "RFQ",
      entityId: 99999999,
      summary: "Something happened to an RFQ that does not exist",
    });
    expect(id).toBeNull();
  });

  it("returns null on nonsense rather than throwing it back at the job", async () => {
    // Narrower than it looks, and worth being precise about: an unknown entity
    // type resolves to no scope, so this exercises the no-company return, not
    // the catch below it.
    //
    // That catch is genuinely unreachable from here — resolveEntityScope and
    // recordActivityEvent each swallow their own errors and return null — so
    // there is no honest way to drive it from outside. It stays as defence
    // against a future callee that does throw, and the gap is recorded in a
    // comment on the function rather than papered over with a mock, which
    // would assert the mock and not the behaviour.
    await expect(
      recordSystemEvent({ eventKey: "broken", entityType: "NOT_A_TYPE", entityId: null })
    ).resolves.toBeNull();
  });
});
