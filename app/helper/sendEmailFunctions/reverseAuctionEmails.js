import config from '../../config/app.config.js';
import { sendMail } from '../common.js';
import { generateEmailTemplate } from '../notificationEmailLayout.js';

// Template for 1 Day before auction mail
export const oneDayBeforeEmailTemplate = (vendor_email , vendor_name ,product_name , buyer_Company_name , start_date_time) => {
  const emailSubject = ` Upcoming Reverse Auction – Be Ready to Bid`;
  const emailHeader = `<h2>Dear ${vendor_name},</h2>`;
  const emailContent = `
    <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
      <p>This is a reminder that the reverse auction for <strong>${product_name}</strong> by <strong>${buyer_Company_name}</strong> is scheduled to start on <strong>Tommorow ${start_date_time}}</strong>.</p>
      
      <p>Please ensure your team is prepared to participate and offer your most competitive pricing.</p>

      <p>To view RFQ and auction details: 
        <a href="[Platform Link]" target="_blank" style="color:#1a73e8;">Click here</a>
      </p>

      <p>📩 If you face any difficulty or need guidance on how to proceed on Workwise, feel free to reach out to us at 
        <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a>.
      </p>

      <p>Wishing you a successful bidding experience!</p>

      <p>— Team Workwise</p>
    </div>
  `;

  const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);

  let mailRecipients = {
    from: config.webmasterMail,
    subject: emailSubject,
    html: dynamicHtmlTemplate,
    to:vendor_email
  };
  sendMail(mailRecipients);
};

// Template  After Reverse Auction started mail
export const auctionStartedEmailTemplate = (vendor_email , vendor_name ,product_name , buyer_Company_name , end_date_time) => {
  const emailHeader = `<h2>Dear ${vendor_name},</h2>`;

  const emailContent = `
  <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
    <p>The reverse auction for <strong>${product_name}</strong> by <strong>${buyer_Company_name}</strong> is now <span style="color:green;"><strong>live!</strong></span></p>

    <p>You can submit your bids until <strong>${end_date_time}</strong>.</p>

    <p>Join the auction here: 
      <a href="[Platform Link]" target="_blank" style="color:#1a73e8; text-decoration:underline;">Click here</a>
    </p>

    <p>📩 Facing any issues or need support? We’re here for you at 
      <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a>.
    </p>

    <p>All the best!</p>

    <p>— Team Workwise</p>
  </div>
`;

  const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);

  let mailRecipients = {
    from: config.webmasterMail,
    subject: ` Reverse Auction Live – Place Your Bids Now!`,
    html: dynamicHtmlTemplate,
    to : vendor_email
  };
  sendMail(mailRecipients);
};

//Template for 50 % time left for auction mail
export const auctionHalfWayEmailTemplate = (vendor_email , vendor_name ,product_name , buyer_Company_name , end_date_time) => {
  const emailSubject = 'Reverse Auction Ongoing – Submit Your Best Bid';

  const emailHeader = `<h2>Dear ${vendor_name},</h2>`;

  const emailContent = `
      <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
        <p>The reverse auction for <strong>${product_name}</strong> by <strong>${buyer_Company_name}</strong> is currently underway.</p>
    
        <p>We're halfway through the bidding window – make sure to submit or improve your offer before <strong>${end_date_time}</strong>.</p>
    
        <p>Auction link: 
          <a href="[Platform Link]" target="_blank" style="color:#1a73e8; text-decoration:underline;">Click here</a>
        </p>
    
        <p>📩 If you need any assistance, feel free to reach us at 
          <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a>.
        </p>
    
        <p>Best of luck!</p>
    
        <p>— Team Workwise</p>
      </div>
    `;
  const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);

  let mailRecipients = {
    from: config.webmasterMail,
    subject: emailSubject,
    html: dynamicHtmlTemplate,
    to :vendor_email
  };
  sendMail(mailRecipients);
};

//Template for auction has ended mail
export const auctionEndEmailTemplate = (vendor_email , vendor_name ,product_name , buyer_Company_name ) => {
  const emailSubject = 'Reverse Auction Closed – Thank You for Participating';

  const emailHeader = `<h2>Dear ${vendor_name},</h2>`;

  const emailContent = `
      <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
        <p>The reverse auction for <strong>${product_name}</strong> by <strong>${buyer_Company_name}</strong> has now concluded.</p>
    
        <p>Thank you for your active participation. The results will be shared shortly.</p>
    
        <p>📩 In case you have any questions or need support, please write to us at 
          <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a>.
        </p>
    
        <p>We appreciate your involvement and look forward to more opportunities together.</p>
    
        <p>— Team Workwise</p>
      </div>
    `;
  const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);
  let mailRecipients = {
    from: config.webmasterMail,
    subject: emailSubject,
    html: dynamicHtmlTemplate,
    to:vendor_email
  };
  sendMail(mailRecipients);
};

//Template for auction has started mail to buyer
export const auctionStartEmailTemplateToBuyer = (buyer_email , product_name , project_name , buyer_name) => {

const emailSubject = `Reverse Auction for ${product_name} in ${project_name} is Now Live on Workwise`;

const emailHeader = `<h2>Dear ${buyer_name},</h2>`;

const emailContent = `
  <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
    <p>The reverse auction for <strong>[Product Name]</strong> is now live on <strong>Workwise</strong>. All participating vendors have been notified and are submitting their bids in real time.</p>

    <p>You can monitor live bidding activity and responses here:</p>

    <p>🔗 
      <a href="[Auction Dashboard Link]" target="_blank" style="color:#1a73e8; text-decoration:underline;">
        View Auction Dashboard
      </a>
      <br>
      <small style="color:gray;">(This is the product-wise comparison view of the RFQ)</small>
    </p>

    <p>Our team is keeping a close eye to ensure smooth participation.</p>

    <p>Please feel free to reach out in case you need any support.</p>

    <p>Warm regards,</p>

    <p>Team Workwise<br>
    📩 <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a></p>
  </div>
`;
    
    const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);
    
    let mailRecipients = {
        from: config.webmasterMail,
        subject: emailSubject,
        html: dynamicHtmlTemplate,
        to :buyer_email
    };
    sendMail(mailRecipients);
};

//Template for auction has ended mail to buyer
export const auctionEndEmailTemplateToBuyer = (buyer_email , buyer_name, product_name) => {
  const emailSubject = `Reverse Auction Concluded for {product_name}`;

  const emailHeader = `<h2>Dear ${buyer_name},</h2>`;

  const emailContent = `
  <div style="font-size:16px; font-family: 'Roboto', sans-serif; line-height:1.6;">
    <p>The reverse auction for <strong>${product_name}</strong> has successfully concluded.</p>

    <p>All vendor bids have been logged and are now available for your review.</p>

    <p>📄 You can now view the final bid summary and vendor responses here:</p>

    <p>🔗 
      <a href="[Auction Summary Link]" target="_blank" style="color:#1a73e8; text-decoration:underline;">
        View Auction Summary
      </a>
      <br>
      <small style="color:gray;">(This is the product-wise comparison for that RFQ)</small>
    </p>

    <p>Our team will assist you in the evaluation and next steps if required.</p>

    <p>Thank you for using Workwise to drive a competitive and transparent procurement process.</p>

    <p>Warm regards,</p>

    <p>Team Workwise<br>
    📩 <a href="mailto:hello@letsworkwise.com" style="color:#1a73e8;">hello@letsworkwise.com</a></p>
  </div>
`;

  const dynamicHtmlTemplate = generateEmailTemplate(emailHeader, emailContent);

  let mailRecipients = {
    from: config.webmasterMail,
    subject: emailSubject,
    html: dynamicHtmlTemplate,
    to:buyer_email
  };
  sendMail(mailRecipients);
};