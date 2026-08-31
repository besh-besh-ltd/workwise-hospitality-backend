// middleware/schedulerAuth.js
import crypto from 'crypto';
import { logger } from '../util/logger.js';

const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;

/**
* Middleware to verify requests from the scheduler Lambda
*/
const verifySchedulerRequest = (req, res, next) => {
// Get the signature from headers
const receivedSignature = req.headers['x-scheduler-signature'];
const scheduleId = req.headers['x-schedule-id'];

// Check if signature header exists
if (!receivedSignature) {
logger.error('Missing X-Scheduler-Signature header');
return res.status(401).json({ error: 'Unauthorized: Missing signature' });
}

// Check if secret is configured
if (!SCHEDULER_SECRET) {
logger.error('SCHEDULER_SECRET not configured on backend');
return res.status(500).json({ error: 'Server configuration error' });
}

// Recreate the signature using the request body
const expectedSignature = crypto
.createHmac('sha256', SCHEDULER_SECRET)
.update(JSON.stringify(req.body))
.digest('hex');

// Compare signatures using timing-safe comparison
const isValid = crypto.timingSafeEqual(
Buffer.from(receivedSignature, 'hex'),
Buffer.from(expectedSignature, 'hex')
);

if (!isValid) {
logger.error({ scheduleId }, 'Invalid signature for schedule');
return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
}

logger.info({ scheduleId }, 'Verified scheduler request');
// Marks the caller as the scheduler so the activity trail attributes what
// follows to the system rather than to nobody. See middleware/requestContext.
req.isSchedulerRequest = true;
next();
};

export default verifySchedulerRequest;