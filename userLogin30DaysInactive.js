import db from './app/config/dbConn.js';
import Config from './app/config/app.config.js';
import { logError, sendMail, notificationMail } from './app/helper/common.js';
import { sendNotification } from './app/services/notificationService.js';
import notificationModel from './app/models/notificationModel.js';

import Moment from 'moment';

try {
  const startDate = Moment();
  const notifyDate = startDate.clone().add(30, 'day');
  console.log('sevenEndDate ==>>>>>>', notifyDate);
  console.log('notifyDate ==>>>>>>', notifyDate.format('YYYY-MM-DD'));

  let query = `SELECT tll.user_id, MAX(tll.date) AS last_login,MAX(users.email) AS email
   FROM tbl_login_log tll
   LEFT JOIN tbl_users users ON tll.user_id = users.id
   GROUP BY tll.user_id
   HAVING MAX(tll.date) >= '${notifyDate.format('YYYY-MM-DD')}'`;
  let notLogin = await db.any(query);
  let findDynamicNotification = await notificationModel.findDynamicNotification(
    'account_inactivity_notification '
  );
  for await (const users of notLogin) {
    /* let html_variables = [
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
    }); */

    console.log(' users.email ==>>>>>', users.email);

    if (
      findDynamicNotification.length > 0 &&
      findDynamicNotification[0].notification_type == 1
    ) {
      notificationMail({
        from: Config.webmasterMail, // sender address
        to: users.email, // list of receivers
        subject: findDynamicNotification[0].title, // Subject line
        html: findDynamicNotification[0].content // plain text body
      });
    }
  }
} catch (err) {
  logError(err);
}
