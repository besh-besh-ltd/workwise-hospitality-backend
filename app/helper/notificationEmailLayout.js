function generateEmailTemplate(headerContent, containerContent) {
    return `
        <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; background-color: #ffe4e4eb; width: 100%; max-width: 768px; border-radius: 20px; margin: 0 auto; padding: 40px; box-sizing: border-box;">
            <div>
                <img style="width: 200px; mix-blend-mode: multiply; margin-left: -18px;" src="https://api.letsworkwise.com/user_document/1738825197968-2d5fea6d-0266-451e-96d0-025781f2a119.png" alt="workwise-Logo" />
                <p style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; font-size: 16px; font-weight: 600; color: #333333; margin-top: -7px;">
                    Suite no. 801, Synergy Business Park, ITT Bhatti, <br/>
                    Hanuman Tekdi, Goregaon, Mumbai, Maharashtra 400063
                </p>
            </div>

            <hr />

            ${headerContent}
            
            <div style="border-radius: 24px; padding: 32px 16px; margin-bottom: 24px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                ${containerContent}
            </div>
            
            <hr />
            
            <p style="font-size: 16px;">If you need assistance, contact us at <a href="mailto:hello@letsworkwise.com">hello@letsworkwise.com</a></p>
            <p style="font-size: 16px;">© WorkWise. All Rights Reserved.</p>
        </div>
    `;
}

function getRfqEmailContent({ vendor_name, rfq_no, buyer_name, rfq_id, token, emailType }) {
  const baseUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}`;

  switch (emailType) {
    case RFQ_EMAIL_TYPE.NEW_PRODUCT:
    case RFQ_EMAIL_TYPE.NEW_VENDOR:
      return {
        subject: `New RFQ Opportunity #${rfq_no} from ${buyer_name}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            A new RFQ #${rfq_no} has been created by ${buyer_name}. You are invited to participate.
          </p>
          <a href="${baseUrl}"
             style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
            View RFQ
          </a>
        `
      };

    case RFQ_EMAIL_TYPE.REMOVED_VENDOR:
      return {
        subject: `Update on RFQ #${rfq_no}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            You are no longer a participant in RFQ #${rfq_no} created by ${buyer_name}.
          </p>
        `
      };

    case RFQ_EMAIL_TYPE.UPDATED_RFQ:
    default:
      return {
        subject: `RFQ #${rfq_no} has been updated by ${buyer_name}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            RFQ #${rfq_no} has been updated by ${buyer_name}. Please review the latest details.
          </p>
          <a href="${baseUrl}"
             style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
            View RFQ
          </a>
        `
      };
  }
}
const RFQ_EMAIL_TYPE = {
  NEW_PRODUCT: 'NEW_PRODUCT',
  REMOVED_VENDOR: 'REMOVED_VENDOR',
  UPDATED_RFQ: 'UPDATED_RFQ',
  NEW_VENDOR: 'NEW_VENDOR'
};

export { generateEmailTemplate ,getRfqEmailContent , RFQ_EMAIL_TYPE}