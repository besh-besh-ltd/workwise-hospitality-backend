/**
 * @Note few company requested to send email with there template ( color and name etc) so creating this object for each
 *
 */
const companyObj = [
  {
    companyID: 6729, // RS group prassana email id
    userID: 6729,
    logo: 'https://workwise-static-s3.s3.ap-south-1.amazonaws.com/user_document/1749634855405-e8d5a49f-cacc-4fa0-9ce4-8f3df7a4732a.jpg', //  mix-blend-mode: multiply; removed this from company logo
    primaryColor: '#29577b',
    primaryTextColor: '#FFFFFF',
    seconderyColor: '#013861',
    seconderyTextColor: '#FFFFFF',
    address: '',
    displayAddress: false
  },
  {
    companyID: 10335, // vineet buyer 
    userID: 10335,
    logo: 'https://workwise-static-s3.s3.ap-south-1.amazonaws.com/user_document/1749634855405-e8d5a49f-cacc-4fa0-9ce4-8f3df7a4732a.jpg', //  mix-blend-mode: multiply; removed this from company logo
    primaryColor: '#29577b',
    primaryTextColor: '#FFFFFF',
    seconderyColor: '#013861',
    seconderyTextColor: '#FFFFFF',
    address: 'this text display to workwis eonly, vineet castomized this email template',
    displayAddress: true
  }
];

const defaultEmailTemplate = {
  // Use WorkWise logo to avoid company-specific overrides
  logo: 'https://letsworkwise.com/assets/images/logo.png',
  address: `1st Floor, 271 Business Park, Model Industrial Estate, near Virwani Industrial Estate <br/>
      off Western Express Highway, Vishveshwar Nagar, Goregaon, Mumbai, Maharashtra 400063`,
  displayAddress: false,
  // Bluish-green gradient to match website theming. Using 'background' later keeps
  // company-specific solid colors working without any change to their objects.
  primaryColor: 'linear-gradient(135deg, #0ea5e9 0%, #06b6d4 50%, #10b981 100%)',
  primaryTextColor: '#000000',
  seconderyColor: '#ffffff',
  seconderyTextColor: '#000000'
};

/**
 * @param {*} email header ( this is not email subject - in header we have sender name like Hello Mukul) - text only
 * @param {*} main this is main content of email - text only
 * @param {*} company_id - optional - if company_id is provided then it will use company specific template otherwise it will use default template
 * @returns - return html email template
 * @created_by - mukul
 * @last_modified - 2023-11-01 - mukul, for company specific email template
 */
function generateEmailTemplate(headerContent, containerContent, userID = null) {
  const {
    logo,
    address,
    displayAddress,
    primaryColor,
    primaryTextColor,
    seconderyColor,
    seconderyTextColor
  } = userID
    ? {
        ...defaultEmailTemplate,
        ...(companyObj.find((c) => c.userID === userID) || {})
      }
    : defaultEmailTemplate;

  const headerBackground = userID && (companyObj.find((c) => c.userID === userID))
    ? primaryColor
    : 'linear-gradient(135deg, #0ea5e9 0%, #06b6d4 100%)';

  const isCompanySpecific = Boolean(userID && companyObj.find((c) => c.userID === userID));

  return `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; background: ${primaryColor}; color: ${primaryTextColor}; width: 100%; max-width: 768px; border-radius: 20px; margin: 0 auto; padding: 40px; box-sizing: border-box;">
        <div style="background: ${headerBackground}; padding: 32px 28px; border-radius: 16px; text-align: center; margin-bottom: 16px;">
            <img style="width: 190px; max-width: 100%; height: auto; display: inline-block; margin: 0 auto;" src="${logo}" alt="Company Logo" />
            ${isCompanySpecific ? '' : '<div style="margin-top: 0; font-size: 16px; font-weight: 600; color: #ffffff; letter-spacing: 0.4px;">Procurement Se Profit Banao</div>'}
        </div>
        <hr style="border-color: ${seconderyColor}" />
        <div style="border-radius: 24px; padding: 32px 16px; margin-bottom: 24px; background-color: #ffffff; color: #333333; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            ${headerContent}
            ${containerContent}
            </div>
            

        <hr style="border-color: ${seconderyColor}" />
        <div style="text-align: center; padding: 8px 0 0;">
          <p style="font-size: 16px; color: #ffffff; margin: 0; font-weight: 500;">If you need assistance, contact us at <a href="mailto:hello+phileeinhospitality@letsworkwise.com" style="color: #ffffff; text-decoration: underline;">hello+phileeinhospitality@letsworkwise.com</a></p>
          <p style="font-size: 14px; color: #ffffff; margin: 6px 0 0; font-weight: 500;">© WorkWise. All Rights Reserved.</p>
        </div>
    </div>
    `;
}

function getRfqEmailContent({
  vendor_name,
  rfq_no,
  buyer_name,
  rfq_id,
  token,
  emailType,
  changedDetails,
}) {
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
             style="background-color: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
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
      return {
        subject: `RFQ #${rfq_no} has been updated by ${buyer_name}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            RFQ #${rfq_no} has been updated by ${buyer_name}. Please review the latest details.
          </p>
          <a href="${baseUrl}"
             style="background-color: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
            View RFQ
          </a>
        `
      };
    case RFQ_EMAIL_TYPE.UPDATED_VENDOR_WITH_CHANGABLE:
      return {
        subject: `RFQ #${rfq_no} has been updated by ${buyer_name}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            RFQ #${rfq_no} has been updated by ${buyer_name}. Please review the latest details.
          </p>
          ${
            changedDetails
              ? `
            <p>
              ${changedDetails
                .map((detail) => `<strong>${detail}</strong>`)
                .join('<br>')}
            </p>
            `
              : ''
          }
          <a href="${baseUrl}"
             style="background-color: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
            View RFQ
          </a>
        `
      };
    default:
      return {
        subject: `RFQ #${rfq_no} has been updated by ${buyer_name}`,
        header: `<h2>Hello ${vendor_name},</h2>`,
        content: `
          <p style="font-size: 15px;">
            RFQ #${rfq_no} has been updated by ${buyer_name}. Please review the latest details.
          </p>
          <a href="${baseUrl}"
             style="background-color: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
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
  NEW_VENDOR: 'NEW_VENDOR',
  UPDATED_VENDOR_WITH_CHANGABLE: 'UPDATED_VENDOR_WITH_CHANGABLE'
};

export { generateEmailTemplate, getRfqEmailContent, RFQ_EMAIL_TYPE };
