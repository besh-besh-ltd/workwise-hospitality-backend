import userModel from '../models/userModel.js';
import notificationModel from '../models/notificationModel.js';
import webpush from 'web-push';
const publicVapidKey =
  'BMlcHp3X2DtYmsKkev81HR4CJeOqxTyLEZC0JU3Fnxi7qaKqM7-qOWvgPCb4Q9FmFW6-hyc9AG4w4BtrHTkwO2c';

const privateVapidKey = 'U10j4lgXBPb5esS3hat9I1M92p59vXbMGBsOZLasjgE';
// Setup the public and private VAPID keys to web-push library.
webpush.setVapidDetails(
  'mailto:sourav.maity@indusnet.co.in',
  publicVapidKey,
  privateVapidKey
);
// import sendPushNotification from '../helper/pushNotification.js';

// const notificationModel = models.notification;
// const userDeviceTokenModel = models.user_device_token;

/** Get Delivery Boy list */
const sendNotification = async (
  senderUserId,
  receiverUserIds = [],
  data,
  payload,
  subscription
) => {
  try {
    const { type, title, message, additional_data } = data;

    /** Save notification in database */

    const createNotification = await notificationModel.createNotification({
      sender_user_id: senderUserId,
      // receiver_user_ids: receiverUserIds,
      type,
      title,
      message,
      additional_data: additional_data ? additional_data : null
    });
    // const payload = JSON.stringify({
    //   title: 'Hello World',
    //   body: 'This is the first push notification'
    // });

    webpush
      .sendNotification(subscription, JSON.stringify(payload))
      .catch(console.log);
    /* if (createNotification) {
      //Check if device tokens available
      if (receiverUserIds.length) {
        const getDeviceTokens = [
          ...(await userDeviceTokenModel.findAll({
            where: {
              user_id: receiverUserIds
            },
            attributes: ['device_token'],
            raw: true
          }))
        ].map((device) => device.device_token);
       
        console.log('token', getDeviceTokens);
        // if (getDeviceTokens.length >= 2) {
        //Send push notification
        const pushData = {
          title,
          body: message,
          additionalData: { type }
        };
        // await sendPushNotification(getDeviceTokens, pushData); // Implement after push notification
        // }
      }
    } */
  } catch (error) {
    throw error;
  }
};

export { sendNotification };
