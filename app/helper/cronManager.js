import cron from 'node-cron';
import db from '../config/dbConn.js';
import { sendReminderMail } from './sendEmailFunctions/milestoneEmails.js';
import { sendGRNEmail } from './sendEmailFunctions/generalReminderEmails.js';

const milestoneCronRegistry = new Map();
const generalRemindersCronRegistry = new Map();

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

export const scheduleGRNReminders = async (purchase_order, reminder_users = [], testMode = false) => {
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
        console.log("SENDING GRN EMAIL FOR OFFSET:", offset);
        await sendGRNEmail(po, reminder_users, offset);

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