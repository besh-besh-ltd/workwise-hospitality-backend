import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { randomUUID } from "crypto";

const client = new SchedulerClient({ region: "ap-south-1" });




/**
 * Delete an existing EventBridge Scheduler schedule.
 *
 * @param {Object}   opts
 * @param {string}   opts.rfqId        – RFQ id that was embedded in the schedule name
 * @param {string}   opts.type         – schedule prefix (e.g. "auctionStartVendor")
 * @param {string=}  opts.vendor_id    – user / vendor id, default empty string
 */

export const createSchedule = async ({
  rfqId,
  type,
  vendor_id = "",
  scheduledTimeIST,
  payload,
}) => {
  // ---------- 1. build identifiers ----------
  const scheduleName = `${type}-rfq-${rfqId}-${vendor_id}`;
  const istTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  if (!istTimeRegex.test(scheduledTimeIST)) {
    throw new Error("Invalid scheduledTimeIST format. Expected format: YYYY-MM-DDTHH:mm:ss");
  }

  console.log("Creating schedule with IST time:---------->", scheduledTimeIST);

  // keep the value as IST and let Scheduler do the TZ conversion
  const isoWithoutMs = scheduledTimeIST.replace(/\.\d{3}$/, "");

  // base request shared by both create & update paths
  const baseParams = {
    GroupName: process.env.GroupName,
    Name: scheduleName,
    // run exactly once at() expression
    ScheduleExpression: `at(${isoWithoutMs})`,
    ScheduleExpressionTimezone: "Asia/Kolkata",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE", // auto‑remove after execution
    ClientToken: randomUUID(),       // idempotency
    Target: {
      Arn: process.env.LAMBDA_ARN,
      RoleArn: process.env.EVENTBRIDGE_ROLE_ARN,
      Input: JSON.stringify({
        type,
        payload: {
          ...payload,
          startTime: scheduledTimeIST,
        },
      }),
    },
  };

  try {
    // ---------- 2. attempt to create ----------
    const command = new CreateScheduleCommand(baseParams);
    const res = await client.send(command);
    console.log("✅ Schedule created:", scheduleName);
    return { created: true, arn: res.ScheduleArn };
  } catch (err) {
    // ---------- 3. handle “already exists” ----------
    if (err.name === "ConflictException") {
      // clash == the schedule name exists → update it in‑place
      const updateCmd = new UpdateScheduleCommand(baseParams);
      const res = await client.send(updateCmd);
      console.log("🔄 Schedule updated:", scheduleName);
      return { created: false, updated: true, arn: res.ScheduleArn };
    }

    console.error("❌ Schedule operation failed:", err);
    throw err; // rethrow anything we didn’t expect
  }
};

// ============================================
// RFQ Publish Scheduling (Separate from Auction)
// ============================================

// Use separate group for RFQ publish schedules to avoid mixing with auction schedules
const RFQ_PUBLISH_GROUP = process.env.RFQ_PUBLISH_GROUP_NAME || 'rfqPublishSchedules';

/**
 * Create schedule specifically for RFQ publishing
 * Uses separate schedule group from auction schedules for better organization
 * @param {Object} opts
 * @param {number} opts.rfqId - RFQ ID
 * @param {string} opts.scheduledTimeIST - Time in IST format: YYYY-MM-DDTHH:mm:ss
 * @param {Object} opts.payload - Payload to send to the endpoint
 */
export const createScheduleForRfqPublish = async ({ rfqId, scheduledTimeIST, payload }) => {
  const scheduleName = `rfqPublish-${rfqId}`;

  const istTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  if (!istTimeRegex.test(scheduledTimeIST)) {
    throw new Error("Invalid scheduledTimeIST format. Expected: YYYY-MM-DDTHH:mm:ss");
  }

  console.log(`[RFQ Publish] Creating schedule: ${scheduleName} at ${scheduledTimeIST} IST`);

  const baseParams = {
    GroupName: RFQ_PUBLISH_GROUP,
    Name: scheduleName,
    ScheduleExpression: `at(${scheduledTimeIST})`,
    ScheduleExpressionTimezone: "Asia/Kolkata",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    ClientToken: randomUUID(),
    Target: {
      Arn: process.env.LAMBDA_ARN,
      RoleArn: process.env.EVENTBRIDGE_ROLE_ARN,
      Input: JSON.stringify({
        type: 'genericTask',
        payload: {
          scheduleId: scheduleName,
          endpoint: '/api/v1/rfq/internal/publish',
          method: 'POST',
          payload: payload
        }
      }),
    },
  };

  try {
    const command = new CreateScheduleCommand(baseParams);
    const res = await client.send(command);
    console.log(`✅ [RFQ Publish] Schedule created: ${scheduleName}`);
    return { created: true, arn: res.ScheduleArn };
  } catch (err) {
    if (err.name === "ConflictException") {
      const updateCmd = new UpdateScheduleCommand(baseParams);
      const res = await client.send(updateCmd);
      console.log(`🔄 [RFQ Publish] Schedule updated: ${scheduleName}`);
      return { created: false, updated: true, arn: res.ScheduleArn };
    }
    console.error(`❌ [RFQ Publish] Schedule operation failed:`, err);
    throw err;
  }
};

/**
 * Delete RFQ publish schedule
 * @param {number} rfqId - RFQ ID
 */
export const deleteRfqPublishSchedule = async (rfqId) => {
  const scheduleName = `rfqPublish-${rfqId}`;
  const params = {
    Name: scheduleName,
    GroupName: RFQ_PUBLISH_GROUP,
    ClientToken: randomUUID(),
  };

  try {
    await client.send(new DeleteScheduleCommand(params));
    console.log(`✅ [RFQ Publish] Schedule deleted: ${scheduleName}`);
    return { ok: true, scheduleName };
  } catch (err) {
    if (err.name === "ResourceNotFoundException") {
      console.warn(`⚠️ [RFQ Publish] Schedule not found (already executed?): ${scheduleName}`);
      return { ok: false, reason: "not_found", scheduleName };
    }
    console.error(`❌ [RFQ Publish] Schedule deletion failed:`, err);
    throw err;
  }
};

export const deleteSchedule = async (rfq_id , type , vendor_id = "") => {
  const scheduleName = `${type}-rfq-${rfq_id}-${vendor_id}`;
  const params = {
    Name: scheduleName,
    GroupName: process.env.GroupName || "default", // same group you used at creation
    ClientToken: randomUUID(),                     // idempotency
  };

  try {
    const cmd = new DeleteScheduleCommand(params);
    await client.send(cmd);
    console.log("✅ Schedule deleted:", scheduleName);
    return { ok: true, scheduleName };
  } catch (err) {
    // Swallow “not found” so repeated deletes don’t crash your service
    if (err.name === "ResourceNotFoundException") {
      console.warn("⚠️  Schedule not found (already deleted?):", scheduleName);
      return { ok: false, reason: "not_found", scheduleName };
    }
    console.error("❌ Schedule deletion failed:", err);
    throw err; // re‑throw for unexpected errors
  }
};
