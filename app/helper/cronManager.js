import cron from 'node-cron';
import db from '../config/dbConn.js';
import { sendReminderMail } from './sendEmailFunctions/milestoneEmails.js';
import { sendGRNEmail } from './sendEmailFunctions/generalReminderEmails.js';
import { recordLifecycleEvent } from '../models/generalModel.js';
import { createScheduleForRfqPublish, deleteRfqPublishSchedule } from './createSchedule.js';
import { sendRfqPublishedNotification, sendVendorRfqNotification } from './sendEmailFunctions/approvalEmails.js';
import rfqModel from '../models/rfqModel.js';
import projectModel from '../models/projectModel.js';
import userModel from '../models/userModel.js';

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
 * @param {Object} txContext - Optional transaction context to use same connection
 */
const publishRfq = async (rfq, txContext = null) => {
  const dbConn = txContext || db;
  const { id, rfq_no, is_tender, created_by } = rfq;

  // Update RFQ to published state
  await dbConn.none(`
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
    metadata: { rfq_no, published_by: 'scheduler' },
    txContext: txContext
  });

  console.log(`[RFQ Publisher] Published ${is_tender === 1 ? 'Tender' : 'RFQ'} #${rfq_no} (ID: ${id})`);

  // Send publish notification emails (fire-and-forget)
  try {
    const rfqDetails = await db.oneOrNone(
      'SELECT id, rfq_no, is_tender, title, project_id, created_by FROM tbl_rfq WHERE id = $1',
      [id]
    );

    if (rfqDetails) {
      // 1. Notify project team members
      if (rfqDetails.project_id) {
        const teamMembers = await projectModel.getProjectTeamMembers(rfqDetails.project_id);
        const users = (teamMembers || [])
          .filter(m => m.email && m.email.includes('@'))
          .map(m => ({ name: m.name, email: m.email }));

        if (users.length > 0) {
          sendRfqPublishedNotification({
            rfqDetails: { id, rfq_no, is_tender, title: rfqDetails.title },
            users
          });
        }
      }

      // 2. Notify vendors
      const products = await rfqModel.getProductsByRfqId(id);
      const buyerDetails = await userModel.user_profile_detail(rfqDetails.created_by);
      const buyerName = buyerDetails?.[0]?.company_name || buyerDetails?.[0]?.organization_name || buyerDetails?.[0]?.name || 'Buyer';

      // Build unique vendor map with their products
      const vendorMap = {};
      for (const product of products) {
        if (!product.vendors) continue;
        for (const vendor of product.vendors) {
          if (!vendorMap[vendor.user_id]) {
            vendorMap[vendor.user_id] = { ...vendor, products: [] };
          }
          vendorMap[vendor.user_id].products.push(product.name);
        }
      }

      // Generate tokens and send vendor emails
      const vendorsWithTokens = [];
      for (const vendorId of Object.keys(vendorMap)) {
        const vendor = vendorMap[vendorId];
        try {
          const token = await rfqModel.insertVendorRfqToken(vendor.user_id, id);
          vendorsWithTokens.push({
            user_id: vendor.user_id,
            name: vendor.name,
            email: vendor.email,
            token,
            products: vendor.products
          });
        } catch (tokenErr) {
          console.error(`Error generating token for vendor ${vendorId}:`, tokenErr);
        }
      }

      if (vendorsWithTokens.length > 0) {
        sendVendorRfqNotification({
          rfq_id: id,
          rfq_no,
          is_tender,
          buyerName,
          vendors: vendorsWithTokens
        });
      }
    }
  } catch (emailError) {
    console.error('[RFQ Publisher] Error sending publish notification emails:', emailError);
  }
};

/**
 * publishRfqById
 *
 * Publish RFQ by ID - called by the scheduler endpoint.
 * Re-validates the RFQ state before publishing.
 *
 * @param {number} rfqId - RFQ ID to publish
 * @param {string} rfq_no - RFQ number for logging
 */
export const publishRfqById = async (rfqId, rfq_no) => {
  // Re-validate before publishing (same logic as original cron job)
  const rfq = await db.oneOrNone(`
    SELECT id, rfq_no, is_tender, created_by, status, is_published
    FROM tbl_rfq WHERE id = $1
  `, [rfqId]);

  if (!rfq) {
    console.log(`[RFQ Publisher] Skipping - RFQ ${rfq_no} (ID: ${rfqId}) not found`);
    return { skipped: true, reason: 'not_found' };
  }

  if (rfq.is_published === 1) {
    console.log(`[RFQ Publisher] Skipping - RFQ ${rfq_no} (ID: ${rfqId}) already published`);
    return { skipped: true, reason: 'already_published' };
  }

  if (rfq.status === 3) {
    console.log(`[RFQ Publisher] Skipping - RFQ ${rfq_no} (ID: ${rfqId}) still pending approval, cannot publish`);
    return { skipped: true, reason: 'pending_approval' };
  }

  if (rfq.status !== 4) {
    console.log(`[RFQ Publisher] Skipping - RFQ ${rfq_no} (ID: ${rfqId}) not in publishable state (status: ${rfq.status})`);
    return { skipped: true, reason: 'invalid_status' };
  }

  await publishRfq(rfq);
  return { published: true };
};

/**
 * scheduleRfqPublish
 *
 * Schedules an EventBridge schedule to publish an RFQ/Tender at its tender_publish_date.
 * For regular RFQs (non-tenders), publishes immediately.
 *
 * @param {Object} rfq - RFQ object with id, rfq_no, is_tender, tender_publish_date, created_by
 * @param {Object} txContext - Optional transaction context to use same connection
 */
export const scheduleRfqPublish = async (rfq, txContext = null) => {
  const { id, rfq_no, is_tender, tender_publish_date, created_by } = rfq;

  // For non-tenders or if no publish date, publish immediately
  if (is_tender !== 1 || !tender_publish_date) {
    console.log(`[RFQ Publisher] Publishing immediately: ${rfq_no}`);
    await publishRfq(rfq, txContext);
    return;
  }

  const publishAt = new Date(tender_publish_date);
  const now = new Date();

  // If publish date is in the past or now, publish immediately
  if (publishAt <= now) {
    console.log(`[RFQ Publisher] Publish date passed, publishing now: ${rfq_no}`);
    await publishRfq(rfq, txContext);
    return;
  }

  // Format the date for EventBridge (IST timezone): YYYY-MM-DDTHH:mm:ss
  // tender_publish_date may come as "2026-02-03 16:55:00" (space) or ISO format
  // Normalize to YYYY-MM-DDTHH:mm:ss format
  const scheduledTimeIST = tender_publish_date
    .replace(/\.\d{3}Z$/, '')  // Remove .000Z if present
    .replace('Z', '')           // Remove trailing Z if present
    .replace(' ', 'T');         // Replace space with T for DB format

  console.log(`[RFQ Publisher] Scheduling publish for ${rfq_no} at ${scheduledTimeIST} IST`);

  // Schedule via EventBridge
  await createScheduleForRfqPublish({
    rfqId: id,
    scheduledTimeIST,
    payload: {
      rfqId: id,
      rfq_no,
      created_by
    }
  });

  console.log(`✅ EventBridge schedule created for RFQ: ${rfq_no} (ID: ${id})`);
};

/**
 * removeRfqPublishJob
 *
 * Cancels and removes a scheduled RFQ publish job from EventBridge.
 *
 * @param {number} rfqId - RFQ ID
 */
export const removeRfqPublishJob = async (rfqId) => {
  try {
    const result = await deleteRfqPublishSchedule(rfqId);
    if (result.ok) {
      console.log(`✅ Removed EventBridge schedule for RFQ: ${rfqId}`);
    } else {
      console.log(`ℹ️ No schedule found for RFQ: ${rfqId} (may have already executed)`);
    }
  } catch (error) {
    console.error(`❌ Failed to remove schedule for RFQ ${rfqId}:`, error.message);
  }
};

/**
 * rescheduleAllRfqPublishJobs
 *
 * @deprecated No longer needed - EventBridge persists schedules independently.
 * Kept for backwards compatibility during migration period.
 * Can be removed after migration is verified working in production.
 */
export const rescheduleAllRfqPublishJobs = async () => {
  console.log('[RFQ Publisher] Using EventBridge - no rescheduling needed on startup');
};