// Minimal RFQ factory. Creates a single tbl_rfq row with all NOT-NULL columns
// satisfied. Useful for tests that need an RFQ to act on (withdraw, terminate,
// finalize, etc.) without going through the full create/edit flow.
//
// Returns { rfq_id, rfq_no }.
//
// Usage:
//   const { rfq_id } = await makeRFQ(t, { createdBy: IDS.users.a1_proc_buyer });

import { IDS } from "../fixtures/ids.js";

// Factory-issued rfq_no values must not collide with rfq_no values minted by
// production code (duplicateRfqForHotels, copy controller, etc.) which all
// compute MAX(rfq_no) + 1 from tbl_rfq. A module-local monotonic counter
// would race against those inserts and trip the uq_tbl_rfq_rfq_no unique
// constraint mid-suite. Defer to the database so factory and controllers
// share one source of truth.
async function nextRfqNo(t) {
  const row = await t.one(
    `SELECT COALESCE(MAX(rfq_no), 8000000) + 1 AS next FROM tbl_rfq`
  );
  return Number(row.next);
}

/**
 * Create a fixture-shaped RFQ. All columns default to fixture values; pass
 * overrides via the `opts` argument (e.g. `status: 4` for READY_TO_PUBLISH).
 *
 * @param {object} t - pg-promise transaction or db
 * @param {object} opts
 * @param {number} opts.createdBy - user_id (required)
 * @param {number} [opts.hospitality] - tbl_hospitality_companies.id (default A)
 * @param {number} [opts.hotel] - hotel id (default A1)
 * @param {number|null} [opts.department] - department id (default null)
 * @param {number} [opts.process] - process id (default A_P1)
 * @param {number} [opts.status] - 0=Draft, 3=PendingApproval, 4=ReadyToPublish, 1=Published, 5=Withdrawn, 2=Closed
 * @param {0|1} [opts.is_published]
 * @param {0|1} [opts.is_tender]
 * @param {string} [opts.bid_end_date] - text; default 7 days hence
 * @param {string} [opts.title]
 */
export async function makeRFQ(t, opts) {
  if (!opts || !opts.createdBy) {
    throw new Error("makeRFQ: createdBy is required");
  }
  const rfqNo = opts.rfq_no ?? (await nextRfqNo(t));
  const status = opts.status ?? 0;
  const isPublished = opts.is_published ?? 0;
  const isTender = opts.is_tender ?? 0;
  const hospitality = opts.hospitality ?? IDS.hospitality.A;
  const hotel = opts.hotel ?? IDS.hotels.A1;
  const department = opts.department ?? null;
  const processId = opts.process ?? IDS.processes.A_P1;

  const sevenDaysFromNow = new Date(Date.now() + 7 * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const bidEndDate = opts.bid_end_date ?? sevenDaysFromNow;
  const title = opts.title ?? `Test RFQ ${rfqNo}`;
  const tenderPublishDate =
    opts.tender_publish_date ??
    new Date(Date.now() + 1 * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const vendorClarificationDate =
    opts.vendor_clarification_date ??
    new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19);

  const row = await t.one(
    `INSERT INTO tbl_rfq (
       rfq_no, comment, company_name, response_email, contact_name,
       contact_number, bid_end_date, location, is_published, status,
       created_by, updated_by, "timestamp",
       hospitality_company_id, hotel_id, department_id, process_id,
       is_tender, tender_publish_date, vendor_clarification_date, title, rfq_type
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(),
             $13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id, rfq_no`,
    [
      rfqNo,
      opts.comment ?? "Test RFQ comment",
      opts.company_name ?? "Test Company",
      opts.response_email ?? "test@example.com",
      opts.contact_name ?? "Test Contact",
      opts.contact_number ?? "+91-9999999999",
      bidEndDate,
      opts.location ?? "Test Location",
      isPublished,
      status,
      opts.createdBy,
      opts.updatedBy ?? opts.createdBy,
      hospitality,
      hotel,
      department,
      processId,
      isTender,
      tenderPublishDate,
      vendorClarificationDate,
      title,
      opts.rfq_type ?? "RFQ",
    ]
  );

  return { rfq_id: row.id, rfq_no: row.rfq_no };
}

/**
 * Insert a PENDING approval instance for the given RFQ. Used by tests that
 * need to assert the cancel-on-withdraw behaviour.
 */
export async function makePendingApproval(t, { entity_type = "RFQ", entity_id, policy_id, initiated_by, hospitality }) {
  const inst = await t.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id)
     VALUES ($1, $2, $3, 'PENDING', 1, $4, $5)
     RETURNING *`,
    [entity_type, entity_id, policy_id, initiated_by, hospitality]
  );
  return inst;
}
