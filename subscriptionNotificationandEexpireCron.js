import db from './app/config/dbConn.js';
import Config from './app/config/app.config.js';
import { logError, sendMail, notificationMail } from './app/helper/common.js';
import { sendNotification } from './app/services/notificationService.js';
import notificationModel from './app/models/notificationModel.js';

import Moment from 'moment';
import dateFormat from 'dateformat';
import fs from 'fs';

async function expireDayNotification(date, days) {
  let query = `SELECT tus.* ,users.user_type,users.name,users.email,users.endpoint
    FROM tbl_user_subscriptions tus
    LEFT JOIN tbl_users users ON tus.user_id = users.id
    WHERE tus.status = 1 AND end_date = '${date}'`;

  let expireSubscriptions = await db.any(query);

  for await (const expSubscriptions of expireSubscriptions) {
    let html_variables = [
      {
        name: expSubscriptions.name
      },
      {
        message:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`
      }
    ];
    let dynamic_html = fs
      .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
      .toString();

    for (let index = 0; index < html_variables.length; index++) {
      const element = html_variables[index];
      let dynamic_key = Object.keys(element)[0];
      let replace_char = html_variables[index][dynamic_key];
      let replace_var = `[${dynamic_key.toLowerCase()}]`;

      dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
    }
    let findDynamicNotification =
      await notificationModel.findDynamicNotification(
        days == 'today'
          ? 'user_subscription_expire_in_1_days'
          : days == 'seven'
          ? 'user_subscription_expire_in_7_days'
          : ''
      );

    if (
      findDynamicNotification.length > 0 &&
      findDynamicNotification[0].notification_type == 1
    ) {
      notificationMail({
        from: Config.webmasterMail, // sender address
        to: expSubscriptions.email, // list of receivers
        subject: findDynamicNotification[0].title, // Subject line
        html: findDynamicNotification[0].content // plain text body
      });
    }

    sendMail({
      from: Config.webmasterMail, // sender address
      to: expSubscriptions.email, // list of receivers
      subject: `Work Wise | Subscription Expire`, // Subject line
      // html: dynamicHTML // plain text body
      html: dynamic_html
    });

    if (expSubscriptions.endpoint) {
      const notificationData = {
        type: 'Subscription Expire Soon',
        title: `Subscription Expire Soon`,
        message:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`,
        additional_data: {
          user_type: expSubscriptions.user_type
        }
      };
      const payload = {
        title: `Hello ${expSubscriptions.name}`,
        body:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`
      };
      const ss = JSON.parse(expSubscriptions.endpoint);
      sendNotification(1, expSubscriptions.id, notificationData, payload, ss);
    }
  }
}

try {
  let today = dateFormat(new Date(), 'yyyy-mm-dd');
  let query = `SELECT tus.* ,users.user_type,users.name,users.email,users.endpoint
    FROM tbl_user_subscriptions tus
    LEFT JOIN tbl_users users ON tus.user_id = users.id
    WHERE tus.status = 1 AND renew_date = '${today}'`;
  let expireSubscriptions = await db.any(query);
  for await (const expSubscriptions of expireSubscriptions) {
    let expQuery = `UPDATE tbl_user_subscriptions SET status = 3 WHERE id = ${expSubscriptions.id} 
      AND user_id = ${expSubscriptions.user_id}`;
    await db.any(expQuery);
    let updateUserTableQuery = `UPDATE tbl_users SET subscription_plan_id = ${null} WHERE 
    id = ${expSubscriptions.user_id}`;
    await db.any(updateUserTableQuery);
    let updateSubscriptionFetcherDeleteQuery = `DELETE FROM tbl_user_subscription_feature 
      WHERE user_id = ${expSubscriptions.user_id} AND user_subscriptions_id=${expSubscriptions.id} 
      AND plan_id = ${expSubscriptions.plan_id}`;
    await db.any(updateSubscriptionFetcherDeleteQuery);

    let html_variables = [
      {
        name: expSubscriptions.name
      },
      {
        message: `Your subscription plan has been expired`
      }
    ];
    let dynamic_html = fs
      .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
      .toString();

    for (let index = 0; index < html_variables.length; index++) {
      const element = html_variables[index];
      let dynamic_key = Object.keys(element)[0];
      let replace_char = html_variables[index][dynamic_key];
      let replace_var = `[${dynamic_key.toLowerCase()}]`;

      dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
    }

    sendMail({
      from: Config.webmasterMail, // sender address
      to: expSubscriptions.email, // list of receivers
      subject: `Work Wise | Subscription Expire`, // Subject line
      // html: dynamicHTML // plain text body
      html: dynamic_html
    });

    let findDynamicNotification =
      await notificationModel.findDynamicNotification(
        'user_subscription_expired'
      );

    if (
      findDynamicNotification.length > 0 &&
      findDynamicNotification[0].notification_type == 1
    ) {
      notificationMail({
        from: Config.webmasterMail, // sender address
        to: expSubscriptions.email, // list of receivers
        subject: findDynamicNotification[0].title, // Subject line
        html: findDynamicNotification[0].content // plain text body
      });
    }

    if (expSubscriptions.endpoint) {
      const notificationData = {
        type: 'Subscription Expire',
        title: `Subscription Expire`,
        message: `Subscription Expire`,
        additional_data: {
          user_type: expSubscriptions.user_type
        }
      };
      const payload = {
        title: `Hello ${expSubscriptions.name}`,
        body: `Your subscription plan has been expired`
      };
      const ss = JSON.parse(expSubscriptions.endpoint);
      sendNotification(1, expSubscriptions.id, notificationData, payload, ss);
    }
  }

  const startDate = Moment();

  //7day notification
  const sevenEndDate = startDate.clone().add(7, 'day');
  expireDayNotification(sevenEndDate.format('YYYY-MM-DD'), 'seven');
  //5day notification
  const fiveEndDate = startDate.clone().add(5, 'day');
  expireDayNotification(fiveEndDate.format('YYYY-MM-DD'), 'five');
  //4day notification
  const fourEndDate = startDate.clone().add(4, 'day');
  expireDayNotification(fourEndDate.format('YYYY-MM-DD'), 'four');
  //3day notification
  const threeEndDate = startDate.clone().add(3, 'day');
  expireDayNotification(threeEndDate.format('YYYY-MM-DD'), 'three');
  //2day notification
  const secondEndDate = startDate.clone().add(2, 'day');
  expireDayNotification(secondEndDate.format('YYYY-MM-DD'), 'two');
  //1day notification
  const oneDate = startDate.clone().add(1, 'day');
  expireDayNotification(oneDate.format('YYYY-MM-DD'), 'one');
  //today notification
  const todayDate = startDate;
  expireDayNotification(todayDate.format('YYYY-MM-DD'), 'today');
} catch (err) {
  logError(err);
}
