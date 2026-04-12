import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  CreateScheduleGroupCommand
} from "@aws-sdk/client-scheduler";
import { randomUUID } from "crypto";
import { logger } from '../util/logger.js';
import { logError } from './common.js';

const client = new SchedulerClient({ region: "ap-south-1" });

// Cache to track which groups we've already verified/created
const verifiedGroups = new Set();

/**
 * Ensures a schedule group exists, creates it if not
 * @param {string} groupName - The schedule group name
 */
const ensureScheduleGroupExists = async (groupName) => {
  // Skip if we've already verified this group in this session
  if (verifiedGroups.has(groupName)) {
    return;
  }

  try {
    const command = new CreateScheduleGroupCommand({ Name: groupName });
    await client.send(command);
    logger.info({ groupName }, 'Created schedule group');
    verifiedGroups.add(groupName);
  } catch (err) {
    if (err.name === "ConflictException") {
      // Group already exists, that's fine
      verifiedGroups.add(groupName);
    } else {
      logError(`Failed to create schedule group ${groupName}`, err);
      throw err;
    }
  }
};




/**
 * Delete an existing EventBridge Scheduler schedule.
 *
 * @param {Object}   opts
 * @param {string}   opts.rfqId        - RFQ id that was embedded in the schedule name
 * @param {string}   opts.type         - schedule prefix (e.g. "auctionStartVendor")
 * @param {string=}  opts.vendor_id    - user / vendor id, default empty string
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

  logger.info({ scheduledTimeIST }, 'Creating schedule with IST time');

  // keep the value as IST and let Scheduler do the TZ conversion
  const isoWithoutMs = scheduledTimeIST.replace(/\.\d{3}$/, "");

  // base request shared by both create & update paths
  const baseParams = {
    GroupName: process.env.GroupName || 'workwise-schedules',
    Name: scheduleName,
    // run exactly once at() expression
    ScheduleExpression: `at(${isoWithoutMs})`,
    ScheduleExpressionTimezone: "Asia/Kolkata",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE", // auto-remove after execution
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
    logger.info({ scheduleName }, 'Schedule created');
    return { created: true, arn: res.ScheduleArn };
  } catch (err) {
    // ---------- 3. handle "already exists" ----------
    if (err.name === "ConflictException") {
      // clash == the schedule name exists → update it in-place
      const updateCmd = new UpdateScheduleCommand(baseParams);
      const res = await client.send(updateCmd);
      logger.info({ scheduleName }, 'Schedule updated');
      return { created: false, updated: true, arn: res.ScheduleArn };
    }

    logError('Schedule operation failed', err);
    throw err; // rethrow anything we didn't expect
  }
};

// ============================================
// RFQ Publish Scheduling (Separate from Auction)
// ============================================

// Use separate group for RFQ publish schedules if configured, otherwise use existing group
// Schedule names are unique (rfqPublish-{id} vs auction-rfq-{id}-{vendor}) so no conflicts
const RFQ_PUBLISH_GROUP = process.env.RFQ_PUBLISH_GROUP_NAME || process.env.GroupName || 'workwise-rfq-schedules';

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

  // Ensure the schedule group exists (creates if not)
  await ensureScheduleGroupExists(RFQ_PUBLISH_GROUP);

  logger.info({ scheduleName, scheduledTimeIST, group: RFQ_PUBLISH_GROUP }, '[RFQ Publish] Creating schedule');

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
    logger.info({ scheduleName }, '[RFQ Publish] Schedule created');
    return { created: true, arn: res.ScheduleArn };
  } catch (err) {
    if (err.name === "ConflictException") {
      const updateCmd = new UpdateScheduleCommand(baseParams);
      const res = await client.send(updateCmd);
      logger.info({ scheduleName }, '[RFQ Publish] Schedule updated');
      return { created: false, updated: true, arn: res.ScheduleArn };
    }
    logError('[RFQ Publish] Schedule operation failed', err);
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
    logger.info({ scheduleName }, '[RFQ Publish] Schedule deleted');
    return { ok: true, scheduleName };
  } catch (err) {
    if (err.name === "ResourceNotFoundException") {
      logger.warn({ scheduleName }, '[RFQ Publish] Schedule not found (already executed?)');
      return { ok: false, reason: "not_found", scheduleName };
    }
    logError('[RFQ Publish] Schedule deletion failed', err);
    throw err;
  }
};

export const deleteSchedule = async (rfq_id , type , vendor_id = "") => {
  const scheduleName = `${type}-rfq-${rfq_id}-${vendor_id}`;
  const params = {
    Name: scheduleName,
    GroupName: process.env.GroupName || "workwise-schedules", // same group you used at creation
    ClientToken: randomUUID(),                     // idempotency
  };

  try {
    const cmd = new DeleteScheduleCommand(params);
    await client.send(cmd);
    logger.info({ scheduleName }, 'Schedule deleted');
    return { ok: true, scheduleName };
  } catch (err) {
    // Swallow "not found" so repeated deletes don't crash your service
    if (err.name === "ResourceNotFoundException") {
      logger.warn({ scheduleName }, 'Schedule not found (already deleted?)');
      return { ok: false, reason: "not_found", scheduleName };
    }
    logError('Schedule deletion failed', err);
    throw err; // re-throw for unexpected errors
  }
};
