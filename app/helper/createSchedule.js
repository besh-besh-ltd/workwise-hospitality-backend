import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";

const client = new SchedulerClient({ region: "ap-south-1" });

export const createSchedule = async ({ rfqId, type,vendor_id="", scheduledTimeIST, payload }) => {
  const scheduleName = `${type}-rfq-${rfqId}-${vendor_id}`;
  const istTime = new Date(scheduledTimeIST);

  if (isNaN(istTime.getTime())) {
    throw new Error("Invalid scheduledTimeIST format");
  }

  // Format to AWS-compatible string: yyyy-mm-ddThh:mm:ss
  const awsTimeString = istTime.toISOString().replace(/\.\d{3}Z$/, '');
  
  const params = {
    Name: scheduleName,
    GroupName: "default",
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
