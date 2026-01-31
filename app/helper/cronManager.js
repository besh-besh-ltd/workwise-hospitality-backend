import cron from 'node-cron';
import db from '../config/dbConn.js';
import { sendReminderMail } from './sendEmailFunctions/milestoneEmails.js';
import { sendGRNEmail } from './sendEmailFunctions/generalReminderEmails.js';
import { recordLifecycleEvent } from '../models/generalModel.js';

const milestoneCronRegistry = new Map();
const generalRemindersCronRegistry = new Map();
const rfqPublishCronRegistry = new Map();

export const scheduleMilestoneReminder = async (milestone) => {
  const { id, due_date, reminder_users } = milestone;
  const remindAt = new Date(due_date);
  remindAt.setHours(9, 0, 0); // 9AM IST

  if (remindAt <= new Date()) return;

  const cronExpression = `${remindAt.getMinutes()} ${remindAt.getHours()} ${remindAt.getDate()} ${remindAt.getMonth() + 1} *`;

  const job = cron.schedule(cronExpression, async () => {
    await sendReminderMail(milestone, reminder_users);
    await db.none(`UPDATE tbl_payment_milestone SET is_reminded = true, status = 'achieved' WHERE id = $1`, [id]);
    job.stop();
    milestoneCronRegistry.delete(id);
  });

  milestoneCronRegistry.set(id, job);
};

export const rescheduleMilestoneReminder = async (milestone) => {
  removeMilestoneReminder(milestone.id);
  await scheduleMilestoneReminder(milestone);
};

export const removeMilestoneReminder = (milestoneId) => {
  const job = milestoneCronRegistry.get(milestoneId);
  if (job) {
    job.stop();
    milestoneCronRegistry.delete(milestoneId);
  }
};

// To Reschedule all milestone based schedules
export const rescheduleAllMilestoneReminders = async () => {
  const milestones = await db.any(`
    SELECT * FROM tbl_payment_milestone
    WHERE status = 'pending' AND due_date > NOW() AND is_reminded = false
  `);

  for (const m of milestones) {
    await scheduleMilestoneReminder(m);
  }
};

// export const scheduleGRNReminders = async (purchase_order, reminder_users = []) => {
//   const { id: poId, delivery_period, po_approved_on } = purchase_order || {};

//   if (!poId || !delivery_period || !po_approved_on) {
//     return false;
//   }

//   const deliveryDays = parseInt(delivery_period, 10);
//   if (Number.isNaN(deliveryDays) || deliveryDays <= 0) return false;

//   // Delivery date = PO approved date + delivery_period (in days)
//   const base = new Date(po_approved_on);
//   if (Number.isNaN(base.getTime())) return false;

//   const deliveryDate = new Date(base.getTime());
//   deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);

//   // Reminder offsets in days relative to delivery date
//   const OFFSETS = [-3, 0, 3];

//   const scheduleReminderAtIndex = (index) => {
//     if (index >= OFFSETS.length) return;

//     const offset = OFFSETS[index];

//     // Compute reminder date for this offset
//     const remindAt = new Date(deliveryDate.getTime());
//     remindAt.setDate(remindAt.getDate() + offset);
//     // Fire at 9 AM IST equivalent on server (assuming server time ~IST or you handle TZ)
//     remindAt.setHours(9, 0, 0, 0);

//     // If this reminder time is in the past, skip to next
//     if (remindAt <= new Date()) {
//       scheduleReminderAtIndex(index + 1);
//       return;
//     }

//     // node-cron expression for specific date/time
//     const cronExpression = `${remindAt.getMinutes()} ${remindAt.getHours()} ${remindAt.getDate()} ${
//       remindAt.getMonth() + 1
//     } *`;

//     const jobKey = `grn_po_${poId}_offset_${offset}`;

//     const job = cron.schedule(cronExpression, async () => {
//       try {
//         // Always fetch the latest PO status from DB
//         const po = await db.one(
//           `SELECT * FROM tbl_rfq_purchase_order
//           WHERE id = $1`,
//           [poId]
//         )

//         if (!po || po.status !== "dispatched") {
//           // If it's no longer dispatched, stop the chain
//           return;
//         }

//         // Trigger the email for this reminder
//         // offset: -3, 0, or 3 to indicate which reminder this is
//         await sendGRNEmail(po, reminder_users, offset);

//         // Schedule the next reminder (+3 days step) if any
//         scheduleReminderAtIndex(index + 1);
//       } catch (err) {
//         console.error("Error in GRN reminder job: ", err);
//       } finally {
//         job.stop();
//         generalRemindersCronRegistry.delete(jobKey);
//       }
//     });

//     generalRemindersCronRegistry.set(jobKey, job);
//   };

//   // Start from the first (T-3) and let it chain to T and T+3
//   scheduleReminderAtIndex(0);

//   return true;
// };

export const scheduleGRNReminders = async (purchase_order, reminder_users = [], grn_rep_data, testMode = false) => {
  const { id: poId, delivery_period, po_approved_on } = purchase_order || {};
  console.log("SCHEDULING GRN REMINDERS")

  if (!poId || !delivery_period || !po_approved_on) {
    return false;
  }

  const deliveryDays = parseInt(delivery_period, 10);
  if (Number.isNaN(deliveryDays) || deliveryDays <= 0) return false;

  // Delivery date = PO approved date + delivery_period (in days)
  const base = new Date(po_approved_on);
  if (Number.isNaN(base.getTime())) return false;

  const deliveryDate = new Date(base.getTime());
  deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);

  // Reminder offsets in days relative to delivery date
  const OFFSETS = [-3, 0, 3];

  // For test mode: map offset -> minutes from now
  const TEST_OFFSET_MINUTES = {
    "-3": 1, // offset -3 -> fire in 1 minutes
    "0": 2,  // offset 0  -> fire in 2 minutes
    "3": 3,  // offset 3  -> fire in 3 minutes
  };

  const scheduleReminderAtIndex = (index) => {
    if (index >= OFFSETS.length) return;

    const offset = OFFSETS[index];

    let remindAt;

    if (testMode) {
      // 🔧 TEST MODE: schedule in a few minutes from "now"
      const minsFromNow = TEST_OFFSET_MINUTES[String(offset)] ?? 3;
      remindAt = new Date();
      remindAt.setMinutes(remindAt.getMinutes() + minsFromNow);
      // keep current hour/day/month, just adjust minutes
    } else {
      // 🟢 PRODUCTION MODE: schedule based on delivery date ± offset days
      remindAt = new Date(deliveryDate.getTime());
      remindAt.setDate(remindAt.getDate() + offset);
      // Fire at 9 AM (server local time — adjust if needed)
      remindAt.setHours(9, 0, 0, 0);

      // If this reminder time is in the past, skip to next
      if (remindAt <= new Date()) {
        scheduleReminderAtIndex(index + 1);
        return;
      }
    }

    console.log("ALL THE TIMERS HAVE BEEN SET:", remindAt);

    // node-cron expression for specific date/time
    const cronExpression = `${remindAt.getMinutes()} ${remindAt.getHours()} ${remindAt.getDate()} ${
      remindAt.getMonth() + 1
    } *`;

    const jobKey = `grn_po_${poId}_offset_${offset}`;

    const job = cron.schedule(cronExpression, async () => {
      try {
        // Always fetch the latest PO status from DB
        const po = await db.one(
          `SELECT * FROM tbl_rfq_purchase_order
           WHERE id = $1`,
          [poId]
        );

        if (!po || po.status !== "dispatched") {
          // If it's no longer dispatched, stop the chain
          return;
        }

        // Trigger the email for this reminder
        // offset: -3, 0, or 3 to indicate which reminder this is
        await sendGRNEmail(po, reminder_users, grn_rep_data, offset);

        // Schedule the next reminder if any
        scheduleReminderAtIndex(index + 1);
      } catch (err) {
        console.error("Error in GRN reminder job: ", err);
      } finally {
        job.stop();
        generalRemindersCronRegistry.delete(jobKey);
      }
    });

    generalRemindersCronRegistry.set(jobKey, job);
  };

  // Start from the first (T-3) and let it chain to T and T+3
  scheduleReminderAtIndex(0);

  return true;
};

// ============================================
// RFQ/Tender Auto-Publish Scheduler
// ============================================

/**
 * publishRfq
 *
 * Actually publishes the RFQ by updating status and is_published.
 *
 * @param {Object} rfq - RFQ object with id, rfq_no, is_tender, created_by
 */
const publishRfq = async (rfq) => {
  const { id, rfq_no, is_tender, created_by } = rfq;

  // Update RFQ to published state
  await db.none(`
    UPDATE tbl_rfq
    SET status = 1, is_published = 1
    WHERE id = $1
  `, [id]);

  // Record lifecycle event
  await recordLifecycleEvent({
    entity_type: is_tender === 1 ? 'TENDER' : 'RFQ',
    entity_id: id,
    stage: 'PUBLISHED',
    action: 'AUTO_PUBLISH',
    performed_by: created_by,
    metadata: { rfq_no, published_by: 'scheduler' }
  });

  console.log(`[RFQ Publisher] Published ${is_tender === 1 ? 'Tender' : 'RFQ'} #${rfq_no} (ID: ${id})`);
};

/**
 * scheduleRfqPublish
 *
 * Schedules a cron job to publish an RFQ/Tender at its tender_publish_date.
 * For regular RFQs (non-tenders), publishes immediately.
 *
 * @param {Object} rfq - RFQ object with id, rfq_no, is_tender, tender_publish_date, created_by
 */
export const scheduleRfqPublish = async (rfq) => {
  const { id, rfq_no, is_tender, tender_publish_date, created_by } = rfq;

  // For non-tenders or if no publish date, publish immediately
  if (is_tender !== 1 || !tender_publish_date) {
    await publishRfq(rfq);
    return;
  }

  const publishAt = new Date(tender_publish_date);

  // If publish date is in the past or now, publish immediately
  if (publishAt <= new Date()) {
    await publishRfq(rfq);
    return;
  }

  // Remove any existing job for this RFQ
  removeRfqPublishJob(id);

  // Create cron expression for the specific date/time
  const cronExpression = `${publishAt.getMinutes()} ${publishAt.getHours()} ${publishAt.getDate()} ${publishAt.getMonth() + 1} *`;

  const job = cron.schedule(cronExpression, async () => {
    try {
      // Re-fetch RFQ to ensure it's still in READY_TO_PUBLISH state
      const currentRfq = await db.oneOrNone(`
        SELECT id, rfq_no, is_tender, created_by, status, is_published
        FROM tbl_rfq WHERE id = $1
      `, [id]);

      if (!currentRfq || currentRfq.status !== 4 || currentRfq.is_published === 1) {
        console.log(`[RFQ Publisher] RFQ ${id} is no longer ready to publish, skipping`);
        return;
      }

      await publishRfq(currentRfq);
    } catch (err) {
      console.error(`[RFQ Publisher] Error publishing RFQ ${id}:`, err);
    } finally {
      job.stop();
      rfqPublishCronRegistry.delete(id);
    }
  });

  rfqPublishCronRegistry.set(id, job);
  console.log(`[RFQ Publisher] Scheduled ${is_tender === 1 ? 'Tender' : 'RFQ'} #${rfq_no} (ID: ${id}) for ${publishAt.toISOString()}`);
};

/**
 * removeRfqPublishJob
 *
 * Cancels and removes a scheduled RFQ publish job.
 *
 * @param {number} rfqId - RFQ ID
 */
export const removeRfqPublishJob = (rfqId) => {
  const job = rfqPublishCronRegistry.get(rfqId);
  if (job) {
    job.stop();
    rfqPublishCronRegistry.delete(rfqId);
  }
};

/**
 * rescheduleAllRfqPublishJobs
 *
 * Called on server startup to reschedule all pending RFQ publish jobs.
 * Queries for RFQs in READY_TO_PUBLISH status (status = 4) that are not yet published.
 */
export const rescheduleAllRfqPublishJobs = async () => {
  try {
    const rfqsToSchedule = await db.any(`
      SELECT id, rfq_no, is_tender, tender_publish_date, created_by
      FROM tbl_rfq
      WHERE status = 4
        AND is_published = 0
    `);

    for (const rfq of rfqsToSchedule) {
      await scheduleRfqPublish(rfq);
    }

    console.log(`[RFQ Publisher] Rescheduled ${rfqsToSchedule.length} RFQ publish jobs on startup`);
  } catch (err) {
    console.error('[RFQ Publisher] Error rescheduling RFQ publish jobs:', err);
  }
};