import cron from 'node-cron';
import db from '../config/dbConn.js';
import { sendReminderMail } from './sendEmailFunctions/milestoneEmails.js';
import { sendGRNEmail } from './sendEmailFunctions/generalReminderEmails.js';
import { sendNegotiationExpiredNotification, sendNegotiationRoundEndedNotification } from './sendEmailFunctions/negotiationEmails.js';
import { recordLifecycleEvent, getApprovalWorkflowUsers } from '../models/generalModel.js';
import { createScheduleForRfqPublish, deleteRfqPublishSchedule } from './createSchedule.js';
import { sendRfqPublishedNotification, sendVendorRfqNotification } from './sendEmailFunctions/approvalEmails.js';
import rfqModel from '../models/rfqModel.js';
import userModel from '../models/userModel.js';
import negotiationModel from '../models/negotiationModel.js';
import rbacModel from '../models/rbacModel.js';
import { logger } from '../util/logger.js';
import { logError } from './common.js';

const milestoneCronRegistry = new Map();
const generalRemindersCronRegistry = new Map();
const negotiationRoundCronRegistry = new Map();

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
  logger.info('Scheduling GRN reminders')

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

    logger.info({ remindAt }, 'All the timers have been set');

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
        logError('Error in GRN reminder job', err);
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

  logger.info({ rfq_no, rfqId: id, is_tender }, `[RFQ Publisher] Published ${is_tender === 1 ? 'Tender' : 'RFQ'} #${rfq_no}`);

  // Send publish notification emails
  try {
    const rfqDetails = await dbConn.oneOrNone(
      `SELECT RFQ.id, RFQ.rfq_no, RFQ.is_tender, RFQ.title, RFQ.created_by,
              RFQ.bid_end_date,
              H.name AS hotel_name,
              HC.name AS hospitality_company_name
       FROM tbl_rfq RFQ
       LEFT JOIN tbl_hospitality_company_hotels H ON H.id = RFQ.hotel_id
       LEFT JOIN tbl_hospitality_companies HC ON HC.id = RFQ.hospitality_company_id
       WHERE RFQ.id = $1`,
      [id]
    );

    logger.debug({ rfqDetailsFound: !!rfqDetails, is_tender: rfqDetails?.is_tender, created_by: rfqDetails?.created_by }, '[RFQ Publisher] Email section - fetched rfqDetails');

    if (rfqDetails) {
      // 1. Notify approval workflow users + RFQ creator
      const entityType = rfqDetails.is_tender === 1 ? 'TENDER' : 'RFQ';
      const approvalUsers = await getApprovalWorkflowUsers(entityType, id, dbConn);
      logger.debug({ entityType, rfqId: id, count: approvalUsers.length, users: approvalUsers.map(u => ({ user_id: u.user_id, email: u.email })) }, `[RFQ Publisher] Approval users fetched`);

      const creatorAlreadyIncluded = approvalUsers.some(u => u.user_id === rfqDetails.created_by);
      let publishUsers = approvalUsers.map(u => ({ name: u.name, email: u.email }));

      if (!creatorAlreadyIncluded && rfqDetails.created_by) {
        const creatorDetails = await userModel.user_profile_detail(rfqDetails.created_by);
        const creator = creatorDetails?.[0];
        logger.debug({ creatorEmail: creator?.email }, '[RFQ Publisher] Creator not in approval users');
        if (creator?.email && creator.email.includes('@')) {
          publishUsers.push({ name: creator.name, email: creator.email });
        }
      }

      logger.debug({ count: publishUsers.length, emails: publishUsers.map(u => u.email) }, '[RFQ Publisher] Final publishUsers');

      if (publishUsers.length > 0) {
        await sendRfqPublishedNotification({
          rfqDetails: { id, rfq_no, is_tender, title: rfqDetails.title, bid_end_date: rfqDetails.bid_end_date, hotel_name: rfqDetails.hotel_name, hospitality_company_name: rfqDetails.hospitality_company_name },
          users: publishUsers
        });
      } else {
        logger.warn({ entityType, rfq_no, rfqId: id }, '[RFQ Publisher] No publish users found - skipping published email');
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
          logError(`Error generating token for vendor ${vendorId}`, tokenErr);
        }
      }

      if (vendorsWithTokens.length > 0) {
        sendVendorRfqNotification({
          rfq_id: id,
          rfq_no,
          is_tender,
          title: rfqDetails.title,
          bid_end_date: rfqDetails.bid_end_date,
          hotel_name: rfqDetails.hotel_name,
          hospitality_company_name: rfqDetails.hospitality_company_name,
          buyerName,
          vendors: vendorsWithTokens
        });
      }
    }
  } catch (emailError) {
    logError('[RFQ Publisher] Error sending publish notification emails', emailError);
  }
};

/**
 * publishRfqById
 *
 * Publish RFQ by ID - called by the scheduler endpoint.
 * Re-validates the RFQ state before publishing.
 * Auto-approves RFQs that are still pending approval at publish time.
 *
 * @param {number} rfqId - RFQ ID to publish
 * @param {string} rfq_no - RFQ number for logging
 */
export const publishRfqById = async (rfqId, rfq_no) => {
  return await db.tx(async t => {
    // Re-validate before publishing
    const rfq = await t.oneOrNone(`
      SELECT id, rfq_no, is_tender, created_by, status, is_published
      FROM tbl_rfq WHERE id = $1
    `, [rfqId]);

    if (!rfq) {
      logger.info({ rfq_no, rfqId }, '[RFQ Publisher] Skipping - RFQ not found');
      return { skipped: true, reason: 'not_found' };
    }

    if (rfq.is_published === 1) {
      logger.info({ rfq_no, rfqId }, '[RFQ Publisher] Skipping - RFQ already published');
      return { skipped: true, reason: 'already_published' };
    }

    if (rfq.status === 5) {
      logger.info({ rfq_no, rfqId }, '[RFQ Publisher] Skipping - RFQ publish request was withdrawn');
      return { skipped: true, reason: 'withdrawn' };
    }

    // Track if we auto-approved
    let wasAutoApproved = false;

    // If still pending approval (status = 3), auto-approve it since publish date has arrived
    if (rfq.status === 3) {
      wasAutoApproved = true;
      logger.info({ rfq_no, rfqId }, '[RFQ Publisher] Auto-approving RFQ - publish date arrived, no approver action taken');

      // Mark all pending approval instances as auto-approved
      await t.none(`
        UPDATE tbl_approval_instances
        SET status = 'APPROVED',
            completed_at = NOW(),
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{auto_approved_reason}',
              '"Publish date arrived - no approver action"'::jsonb
            )
        WHERE entity_type = $1
          AND entity_id = $2
          AND status = 'PENDING'
      `, [rfq.is_tender === 1 ? 'TENDER' : 'RFQ', rfqId]);

      // Mark all pending approval steps as auto-approved
      await t.none(`
        UPDATE tbl_approval_instance_steps
        SET status = 'APPROVED', completed_at = NOW()
        WHERE approval_instance_id IN (
          SELECT id FROM tbl_approval_instances
          WHERE entity_type = $1 AND entity_id = $2
        )
        AND status = 'PENDING'
      `, [rfq.is_tender === 1 ? 'TENDER' : 'RFQ', rfqId]);

      // Mark all pending step approvers as auto-approved
      await t.none(`
        UPDATE tbl_approval_step_approvers
        SET status = 'APPROVED', acted_at = NOW()
        WHERE approval_instance_step_id IN (
          SELECT ais.id FROM tbl_approval_instance_steps ais
          JOIN tbl_approval_instances ai ON ai.id = ais.approval_instance_id
          WHERE ai.entity_type = $1 AND ai.entity_id = $2
        )
        AND status = 'PENDING'
      `, [rfq.is_tender === 1 ? 'TENDER' : 'RFQ', rfqId]);

      // Update RFQ status to ready to publish (4)
      await t.none(`
        UPDATE tbl_rfq
        SET status = 4
        WHERE id = $1
      `, [rfqId]);

      // Record lifecycle event for auto-approval
      await recordLifecycleEvent({
        entity_type: rfq.is_tender === 1 ? 'TENDER' : 'RFQ',
        entity_id: rfqId,
        stage: 'APPROVED',
        action: 'AUTO_APPROVED',
        performed_by: rfq.created_by,
        metadata: {
          rfq_no: rfq.rfq_no,
          reason: 'Publish date arrived - no approver action taken',
          auto_approved_by: 'scheduler'
        },
        txContext: t
      });

      logger.info({ rfq_no, rfqId }, '[RFQ Publisher] Auto-approval completed');

      // Refresh rfq object with new status
      rfq.status = 4;
    }

    // Now validate status is ready to publish
    if (rfq.status !== 4 && rfq.status !== 1) {
      logger.info({ rfq_no, rfqId, status: rfq.status }, '[RFQ Publisher] Skipping - RFQ not in publishable state');
      return { skipped: true, reason: 'invalid_status' };
    }

    // Publish the RFQ
    await publishRfq(rfq, t);
    return { published: true, autoApproved: wasAutoApproved };
  });
};

/**
 * scheduleRfqPublish
 *
 * Schedules an EventBridge schedule to publish an RFQ/Tender at its tender_publish_date.
 * If no publish date is set, publishes immediately.
 *
 * @param {Object} rfq - RFQ object with id, rfq_no, is_tender, tender_publish_date, created_by
 * @param {Object} txContext - Optional transaction context to use same connection
 */
export const scheduleRfqPublish = async (rfq, txContext = null) => {
  const { id, rfq_no, is_tender, tender_publish_date, created_by } = rfq;

  // If no publish date set, publish immediately
  if (!tender_publish_date) {
    logger.info({ rfq_no }, '[RFQ Publisher] Publishing immediately (no publish date)');
    await publishRfq(rfq, txContext);
    return;
  }

  const publishAt = new Date(tender_publish_date);
  const now = new Date();

  // If publish date is in the past or now, publish immediately
  if (publishAt <= now) {
    logger.info({ rfq_no }, '[RFQ Publisher] Publish date passed, publishing now');
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

  logger.info({ rfq_no, scheduledTimeIST }, '[RFQ Publisher] Scheduling publish');

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

  logger.info({ rfq_no, rfqId: id }, '[RFQ Publisher] EventBridge schedule created');
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
      logger.info({ rfqId }, '[RFQ Publisher] Removed EventBridge schedule');
    } else {
      logger.info({ rfqId }, '[RFQ Publisher] No schedule found (may have already executed)');
    }
  } catch (error) {
    logError(`[RFQ Publisher] Failed to remove schedule for RFQ ${rfqId}`, error);
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
  logger.info('[RFQ Publisher] Using EventBridge - no rescheduling needed on startup');
};

// ============= VENDOR PO ACCEPTANCE REMINDERS =============

/**
 * Sends tiered reminder emails to vendors for POs still in acceptance_pending.
 * Schedule: Runs every day at 10:00 AM IST.
 * Reminders: Day 1 (gentle), Day 3 (firm), Day 5 (final).
 */
export const startVendorAcceptanceReminderCron = () => {
  // 10:00 AM IST → 4:30 AM UTC
  cron.schedule('30 4 * * *', async () => {
    logger.info('[Vendor Acceptance Reminder] Running daily check...');
    try {
      const pendingPOs = await db.any(`
        SELECT po.*, r.rfq_no
        FROM tbl_rfq_purchase_order po
        JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE po.status = 'acceptance_pending'
      `);

      if (pendingPOs.length === 0) {
        logger.info('[Vendor Acceptance Reminder] No pending POs found.');
        return;
      }

      const { sendPOAcceptanceReminderToVendor } = await import('../controllers/po/purchaseOrderEmails.js');

      for (const po of pendingPOs) {
        const daysSince = Math.floor((Date.now() - new Date(po.updated_at).getTime()) / (1000 * 60 * 60 * 24));
        const reminderCount = po.vendor_reminder_count || 0;
        let reminderToSend = null;

        if (daysSince >= 5 && reminderCount === 2) {
          reminderToSend = 3;
        } else if (daysSince >= 3 && reminderCount === 1) {
          reminderToSend = 2;
        } else if (daysSince >= 1 && reminderCount === 0) {
          reminderToSend = 1;
        }

        if (reminderToSend) {
          try {
            await sendPOAcceptanceReminderToVendor(po, { rfq_no: po.rfq_no }, reminderToSend);
            await db.none(
              `UPDATE tbl_rfq_purchase_order SET vendor_reminder_count = $2 WHERE id = $1`,
              [po.id, reminderToSend]
            );
            logger.info(`[Vendor Acceptance Reminder] Sent reminder #${reminderToSend} for PO ${po.po_number}`);
          } catch (emailError) {
            logError(`[Vendor Acceptance Reminder] Failed to send reminder for PO ${po.id}`, emailError);
          }
        }
      }

      logger.info(`[Vendor Acceptance Reminder] Processed ${pendingPOs.length} pending POs.`);
    } catch (error) {
      logError('[Vendor Acceptance Reminder] Cron job failed', error);
    }
  });

  logger.info('[Vendor Acceptance Reminder] Cron scheduled: daily at 10:00 AM IST');
};


// ============= NEGOTIATION ROUND EXPIRATION =============

/**
 * Core handler: processes a negotiation round when its end_date is reached.
 * Re-fetches the round from DB to handle concurrent status changes.
 */
const handleNegotiationRoundExpiration = async (roundId) => {
  try {
    const round = await negotiationModel.getRoundWithContext(roundId);
    if (!round) {
      logger.info(`[Negotiation Expiry] Round ${roundId} not found, skipping.`);
      return;
    }

    const hotelIds = round.hotel_id ? [round.hotel_id] : [];

    if (round.status === 'PENDING_APPROVAL') {
      // --- EXPIRE the round ---
      logger.info(`[Negotiation Expiry] Expiring PENDING_APPROVAL round ${roundId} for RFQ #${round.rfq_no}`);

      await db.tx(async (t) => {
        // Update round status to EXPIRED
        await t.none(
          `UPDATE tbl_negotiation_rounds SET status = 'EXPIRED', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [roundId]
        );

        // Cancel pending approval instances (entity_id = round_id)
        await t.none(
          `UPDATE tbl_approval_instances SET status = 'CANCELLED', completed_at = NOW()
           WHERE entity_type = 'NEGOTIATION' AND entity_id = $1 AND status = 'PENDING'`,
          [roundId]
        );

        // Cancel pending approval steps
        await t.none(
          `UPDATE tbl_approval_instance_steps SET status = 'CANCELLED', completed_at = NOW()
           WHERE approval_instance_id IN (
             SELECT id FROM tbl_approval_instances
             WHERE entity_type = 'NEGOTIATION' AND entity_id = $1 AND status = 'CANCELLED'
           ) AND status = 'PENDING'`,
          [roundId]
        );

        // Note: tbl_approval_step_approvers only allows PENDING/APPROVED/REJECTED.
        // Leaving approvers as PENDING is fine — the parent instance and steps
        // are already CANCELLED, and the ApprovalTimeline component uses
        // instanceStatus to render PENDING approvers as "Expired" when the
        // instance is CANCELLED.
      });

      // Record lifecycle event (fire-and-forget)
      recordLifecycleEvent({
        entity_type: 'NEGOTIATION',
        entity_id: round.rfq_id,
        stage: 'NEGOTIATION',
        action: 'NEGOTIATION_ROUND_EXPIRED',
        performed_by: round.created_by,
        metadata: { round_id: roundId, round_number: round.round_number, rfq_product_id: round.rfq_product_id }
      }).catch(err => logError('[Negotiation Expiry] Failed to record lifecycle event', err));

      // Send expiry email
      try {
        const initiatorData = await userModel.getUserById(round.created_by);
        const initiator = initiatorData && initiatorData.length > 0
          ? { name: initiatorData[0].name, email: initiatorData[0].email }
          : null;

        const commercialEvaluators = hotelIds.length > 0
          ? await rbacModel.getUsersWithModuleActionsForHotels(hotelIds, 'quote-compare', ['read', 'create'])
          : [];

        if (initiator) {
          await sendNegotiationExpiredNotification({
            round,
            rfqNo: round.rfq_no,
            productName: round.product_name,
            initiator,
            commercialEvaluators: commercialEvaluators.map(u => ({ name: u.name, email: u.email }))
          });
        }
      } catch (emailErr) {
        logError('[Negotiation Expiry] Failed to send expiry email', emailErr);
      }

      logger.info(`[Negotiation Expiry] Round ${roundId} expired successfully.`);

    } else if (round.status === 'ACTIVE') {
      // --- END the round ---
      logger.info(`[Negotiation Expiry] Ending ACTIVE round ${roundId} for RFQ #${round.rfq_no}`);

      await db.none(
        `UPDATE tbl_negotiation_rounds SET status = 'ENDED', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [roundId]
      );

      const quoteCount = await negotiationModel.getQuoteCountForRound(roundId);

      // Record lifecycle event (fire-and-forget)
      recordLifecycleEvent({
        entity_type: 'NEGOTIATION',
        entity_id: round.rfq_id,
        stage: 'NEGOTIATION',
        action: 'NEGOTIATION_ROUND_ENDED',
        performed_by: round.created_by,
        metadata: { round_id: roundId, round_number: round.round_number, rfq_product_id: round.rfq_product_id, quote_count: quoteCount }
      }).catch(err => logError('[Negotiation Expiry] Failed to record lifecycle event', err));

      // Send ended email
      try {
        const commercialEvaluators = hotelIds.length > 0
          ? await rbacModel.getUsersWithModuleActionsForHotels(hotelIds, 'quote-compare', ['read', 'create'])
          : [];

        if (commercialEvaluators.length > 0) {
          await sendNegotiationRoundEndedNotification({
            round,
            rfqNo: round.rfq_no,
            productName: round.product_name,
            quoteCount,
            commercialEvaluators: commercialEvaluators.map(u => ({ name: u.name, email: u.email }))
          });
        }
      } catch (emailErr) {
        logError('[Negotiation Expiry] Failed to send round-ended email', emailErr);
      }

      logger.info(`[Negotiation Expiry] Round ${roundId} ended successfully. ${quoteCount} quote(s) received.`);

    } else {
      // Round already closed/completed/rejected/cancelled — no-op
      logger.info(`[Negotiation Expiry] Round ${roundId} is already in status '${round.status}', skipping.`);
    }
  } catch (err) {
    logError(`[Negotiation Expiry] Error processing round ${roundId}`, err);
  }
};

/**
 * Schedule a one-time cron job to fire at the exact end_date of a negotiation round.
 * @param {Object} round - Must have { id, end_date }
 */
export const scheduleNegotiationRoundExpiration = (round) => {
  const { id: roundId, end_date } = round;

  // Remove any existing schedule for this round
  removeNegotiationRoundExpiration(roundId);

  const endDate = new Date(typeof end_date === 'string' && !end_date.includes('+') && !end_date.includes('Z')
    ? end_date.replace(' ', 'T') + 'Z'
    : end_date
  );

  if (isNaN(endDate.getTime()) || endDate <= new Date()) {
    logger.debug(`[Negotiation Expiry] Round ${roundId} end_date is in the past or invalid, skipping schedule.`);
    return;
  }

  const cronExpression = `${endDate.getMinutes()} ${endDate.getHours()} ${endDate.getDate()} ${endDate.getMonth() + 1} *`;

  const job = cron.schedule(cronExpression, async () => {
    logger.info(`[Negotiation Expiry] Cron fired for round ${roundId}`);
    await handleNegotiationRoundExpiration(roundId);
    job.stop();
    negotiationRoundCronRegistry.delete(roundId);
  });

  negotiationRoundCronRegistry.set(roundId, job);
  logger.info(`[Negotiation Expiry] Scheduled round ${roundId} to expire at ${endDate.toISOString()}`);
};

/**
 * Remove a scheduled expiration job for a negotiation round.
 * Call when a round is manually closed or rejected before end_date.
 * @param {number} roundId
 */
export const removeNegotiationRoundExpiration = (roundId) => {
  const job = negotiationRoundCronRegistry.get(roundId);
  if (job) {
    job.stop();
    negotiationRoundCronRegistry.delete(roundId);
    logger.info(`[Negotiation Expiry] Removed scheduled expiration for round ${roundId}`);
  }
};

/**
 * On server startup: reschedule expiration jobs for all future rounds
 * and immediately process any rounds that expired during downtime.
 */
export const rescheduleAllNegotiationRoundExpirations = async () => {
  try {
    // 1. Reschedule future rounds
    const futureRounds = await negotiationModel.getRoundsForReschedule();
    for (const round of futureRounds) {
      scheduleNegotiationRoundExpiration(round);
    }
    logger.info(`[Negotiation Expiry] Rescheduled ${futureRounds.length} future round(s).`);

    // 2. Process rounds that expired during downtime
    const expiredRounds = await negotiationModel.getExpiredRoundsDuringDowntime();
    for (const round of expiredRounds) {
      logger.info(`[Negotiation Expiry] Processing round ${round.id} that expired during downtime.`);
      await handleNegotiationRoundExpiration(round.id);
    }
    if (expiredRounds.length > 0) {
      logger.info(`[Negotiation Expiry] Processed ${expiredRounds.length} round(s) that expired during downtime.`);
    }
  } catch (err) {
    logError('[Negotiation Expiry] Failed to reschedule round expirations on startup', err);
  }
};