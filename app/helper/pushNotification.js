import admin from 'firebase-admin';
import fcm from 'fcm-node';
import accountCredentials from '../config/firebase/service-account.json' assert { type: 'json' };
import { logger } from '../util/logger.js';
import { logError } from './common.js';

const certPath = admin.credential.cert(accountCredentials);
const FCM = new fcm(certPath);

const sendPushNotification = async (deviceTokens, messageData) => {
  try {
    const checkDevice = validateDeviceTokens(deviceTokens);
    if (!checkDevice.status) {
      throw new Error(checkDevice.message);
    }
    const checkSubstitution = validateSubstitutions(messageData);
    if (!checkSubstitution.status) {
      throw new Error(checkSubstitution.message);
    }
    for (let deviceToken of deviceTokens) {
      if (deviceToken) {
        const message = {
          to: deviceToken,
          notification: {
            title: messageData.title,
            body: messageData.body,
            android_channel_id: 'notification_channel_db_app'
          },
          data: messageData.additionalData
        };
        logger.debug('Sending push notification message');
        // logger.debug(message);
        FCM.send(message, (err, res) => {
          if (err) {
            logError('FCM send failed', err);
          } else {
            logger.info('FCM message sent successfully');
          }
        });
      }
    }
  } catch (error) {
    throw new Error(error);
  }
};

const validateDeviceTokens = (deviceArr = []) => {
  const validArr = Array.isArray(deviceArr);
  if (validArr) {
    if (deviceArr.length > 0) {
      return { status: true };
    } else {
      return {
        status: false,
        message: "The 'deviceTokens' parameter can't be empty"
      };
    }
  } else {
    return {
      status: false,
      message: "The 'deviceTokens' parameter must be an array"
    };
  }
};

const validateSubstitutions = (messageObj = {}) => {
  if (messageObj.constructor.name === 'Object') {
    if (
      messageObj.title &&
      messageObj.title !== null &&
      messageObj.title != '' &&
      messageObj.body &&
      messageObj.body !== null &&
      messageObj.body != ''
    ) {
      return { status: true };
    } else {
      return {
        status: false,
        message: "The 'messageData' object must have all required parameters"
      };
    }
  } else {
    return {
      status: false,
      message: "The 'messageData' parameter must be an object"
    };
  }
};

export default sendPushNotification;

// data example
// const deviceTokens =  ['dhjfjhf', 'djfkjdkfj', 'ysysysyys', 'sjsjvcnnkcvkd'];
// const messageData = {'title': 'test', 'body': 'This is a test body', 'additionalData': {'test': 'any data'}};
// await pushNotification(
//     deviceTokens,
//     messageData,
// );
