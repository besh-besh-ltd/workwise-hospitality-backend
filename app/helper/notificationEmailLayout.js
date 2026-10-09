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
  logo: 'https://test-workwise-bucket.s3.ap-south-1.amazonaws.com/logo.png',
  address: `1st Floor, 271 Business Park, Model Industrial Estate, near Virwani Industrial Estate <br/>
      off Western Express Highway, Vishveshwar Nagar, Goregaon, Mumbai, Maharashtra 400063`,
  displayAddress: false,
  primaryColor: '#1A5C7E',
  primaryTextColor: '#FFFFFF',
  seconderyColor: '#8BB92E',
  seconderyTextColor: '#FFFFFF'
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

  const isCompanySpecific = Boolean(userID && companyObj.find((c) => c.userID === userID));

  const outerBackground = isCompanySpecific ? primaryColor : `#151B2B`;

  const headerBg = isCompanySpecific ? primaryColor : `#151B2B`;

  // Table-based shell so it renders the same in Gmail (web + app), iOS Mail and
  // Outlook. The old version was a bare <div> fragment with no <head>: phones
  // laid it out at a ~980px desktop viewport and shrank it to unreadable text,
  // and the 40px + 16px of nested padding left ~280px for content on a 390px
  // screen. Desktop look is unchanged; the media query below only narrows the
  // gutters and stretches CTAs (see emailButton) on screens under 620px.
  // Inline styles alone must stay sane — some clients drop <style>.
  // NOTE: no square brackets anywhere in the <style> block: callers such as
  // usersController run `[key]` placeholder replacement over this output.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
<style>
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  img { border: 0; max-width: 100%; height: auto; }
  .ww-card-cell a { word-break: break-word; }
  @media only screen and (max-width: 620px) {
    .ww-shell { border-radius: 0 !important; }
    .ww-shell-cell { padding: 16px 10px !important; }
    .ww-logo-cell { padding: 20px 16px !important; }
    .ww-card-cell { padding: 20px 16px !important; border-radius: 16px !important; }
    .ww-card-cell h2 { font-size: 21px !important; line-height: 28px !important; }
    .ww-card-cell h3 { font-size: 19px !important; line-height: 26px !important; }
    .ww-btn-table { display: table !important; width: 100% !important; margin: 10px 0 0 0 !important; }
    .ww-btn { display: block !important; text-align: center !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; -webkit-text-size-adjust: 100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
  <tr>
    <td align="center" style="padding: 0;">
      <table role="presentation" class="ww-shell" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; border-collapse: separate; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; background: ${outerBackground}; background-color: #151B2B; color: ${primaryTextColor}; border-radius: 20px;">
        <tr>
          <td class="ww-shell-cell" style="padding: 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate;">
              <tr>
                <td class="ww-logo-cell" align="center" style="background: ${headerBg}; background-color: #151B2B; padding: 32px 28px; border-radius: 16px; text-align: center;">
                  <img width="260" style="width: 260px; max-width: 100%; height: auto; display: inline-block; margin: 0 auto; background-color: #151B2B; border: 0;" src="${logo}" alt="Phileein Hospitality" />
                </td>
              </tr>
              <tr><td style="height: 16px; line-height: 16px; font-size: 0;">&nbsp;</td></tr>
              <tr>
                <td class="ww-card-cell" style="border-radius: 24px; padding: 32px 16px; background-color: #ffffff; color: #333333; font-size: 16px; line-height: 1.5; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow-wrap: break-word; word-wrap: break-word; word-break: break-word;">
            ${headerContent}
            ${containerContent}
                </td>
              </tr>
              <tr><td style="height: 24px; line-height: 24px; font-size: 0;">&nbsp;</td></tr>
              <tr>
                <td>
                  <hr style="border-color: #fff" />
                  <div style="text-align: center; padding: 8px 0 0;">
                    <p style="font-size: 16px; color: #E0F0F8; margin: 0; font-weight: 500;">If you need assistance, contact us at <a href="mailto:support@phileeinhospitality.com" style="color: #E0F0F8; text-decoration: underline;">support@phileeinhospitality.com</a></p>
                    <p style="font-size: 14px; color: #E0F0F8; margin: 6px 0 0; font-weight: 500;">&copy; Phileein Hospitality Procurement Platform. All Rights Reserved.</p>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
}

/**
 * Bulletproof call-to-action button for the action emails (approve / quote /
 * accept). The coloured table cell is the tap target, so it stays a solid
 * button even where a client ignores padding on <a>. 14px + 20px + 14px keeps
 * it 48px tall (>= 44px touch target) from inline styles alone; under 620px the
 * layout's media query stretches it to full width.
 *
 * @param {string} href   - exact URL, emitted unchanged in a double-quoted href
 * @param {string} label  - visible text, emitted unchanged
 * @param {object} [opts]
 * @param {string} [opts.bg]     - button colour (default the existing CTA blue)
 * @param {string} [opts.color]  - text colour
 * @param {boolean} [opts.inline] - sits beside a sibling button on desktop
 *                                  (parent must be text-align:center)
 */
function emailButton(href, label, { bg = '#3B82F6', color = '#ffffff', inline = false } = {}) {
  const tableAttrs = inline
    ? `style="display: inline-table; border-collapse: separate; margin: 6px;"`
    : `align="center" style="border-collapse: separate; margin: 0 auto;"`;
  return `<table role="presentation" class="ww-btn-table" cellpadding="0" cellspacing="0" border="0" ${tableAttrs}>
              <tr>
                <td align="center" bgcolor="${bg}" style="background-color: ${bg}; border-radius: 8px;">
                  <a href="${href}" class="ww-btn" style="display: inline-block; padding: 14px 24px; font-size: 16px; line-height: 20px; font-weight: 600; color: ${color}; text-decoration: none; border-radius: 8px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;">${label}</a>
                </td>
              </tr>
            </table>`;
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
  const sendQuoteUrl = `${process.env.FRONT_END_WEBSITE}/dashboard/vendor/inquiries-details?id=${rfq_id}&token=${token}`;

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
          <a href="${sendQuoteUrl}"
             style="background-color: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px; margin-right: 10px;">
            Send Quote
          </a>
          <a href="${baseUrl}"
             style="background-color: #6b7280; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">
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

export { generateEmailTemplate, emailButton, getRfqEmailContent, RFQ_EMAIL_TYPE };
