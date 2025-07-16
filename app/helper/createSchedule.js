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
  const ist = new Date(scheduledTimeIST);

  if (Number.isNaN(ist.getTime())) {
    throw new Error("Invalid scheduledTimeIST format");
  }

  // keep the value as IST and let Scheduler do the TZ conversion
  const isoWithoutMs = ist.toISOString().replace(/\.\d{3}Z$/, "");

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
