import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
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

export const createSchedule = async ({ rfqId, type, vendor_id="", scheduledTimeIST, payload }) => {
  const scheduleName = `${type}-rfq-${rfqId}-${vendor_id}`;
  const istTime = new Date(scheduledTimeIST);

  if (isNaN(istTime.getTime())) {
    throw new Error("Invalid scheduledTimeIST format");
  }

  // Format to AWS-compatible string: yyyy-mm-ddThh:mm:ss
  const awsTimeString = istTime.toISOString().replace(/\.\d{3}Z$/, '');
  
  const params = {
    Name: scheduleName,
    GroupName: process.env.GroupName, // Use the environment variable for group name
    ScheduleExpression: `at(${awsTimeString})`,  // Removed milliseconds and 'Z'
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: {
      Arn: process.env.LAMBDA_ARN,
      RoleArn: process.env.EVENTBRIDGE_ROLE_ARN,
      Input: JSON.stringify({
        type,
        payload: {
          ...payload,
          startTime: scheduledTimeIST
        }
      }),
    },
  };

  console.log("AWS ScheduleExpression:", params.ScheduleExpression);
  
  try {
    const command = new CreateScheduleCommand(params);
    const response = await client.send(command);
    console.log("✅ Schedule created:", scheduleName);
    return response;
  } catch (err) {
    console.error("❌ Schedule creation failed:", err);
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
