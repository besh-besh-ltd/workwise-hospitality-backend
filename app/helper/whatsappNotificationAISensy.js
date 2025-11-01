
import axios from 'axios'; // Import axios for making HTTP requests

const flux_chat_api = process.env.FLUX_CHAT_API
const flux_chat_bearer_token =  process.env.FLUX_CHAT_KEY

const aisensy_api = process.env.AISENSY_API
const aisensy_bearer_token =  process.env.AISENSY_API_KEY


const formatPhoneNumber = (input) => {
  // Remove all spaces and special characters
  let cleanedInput = input.replace(/[^\d]/g, '');

  // Remove leading zeros
  cleanedInput = cleanedInput.replace(/^0+/, '');

  // Check the length and format the number
  if (cleanedInput.length === 10) {
      return '+91' + cleanedInput;
  } else {
      return '+' + cleanedInput;
  }
}

//  contact us form submited 
const whatsappNotificationAISensy = {

  // Function to send a notification when a buyer creates an RFQ
buyerCreatesRFQNotification: async (payload) => {
  // Construct the data payload for the WhatsApp message
  const data = {
    apiKey: aisensy_bearer_token,
    campaignName: 'buyerCreatesRFQNotification',
    destination: formatPhoneNumber(payload.mobile),
    userName: 'letsworkwise',
    templateParams: [
      `${payload.rfq_no}`,
      `dashboard/buyer/rfq-management-details?type=buyer-view&id=${payload.rfq_id}`
    ],
    source: 'Workwise Platform',
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {},
    paramsFallbackValue: {
      FirstName: 'user'
    }
  };

  // Headers for the API request
  
  const headers = {
    'Content-Type': 'application/json',
  };

  // Make the POST request to the messaging API
  await axios.post(aisensy_api, data, { headers: headers })
  .then(response => {
      console.log('RFQ creation notification sent:');
    })
    .catch(error => {
      console.error(
        'Failed to send RFQ creation notification:'
      );
    });
},

vendorReceivesRFQNotification: async (payload) => {
  // Construct the data payload for the WhatsApp message
  const data = {
    apiKey: aisensy_bearer_token,
    campaignName: 'VendorRecievesRFQFromBuyer',
    destination: formatPhoneNumber(payload.mobile),
    userName: 'letsworkwise',
    templateParams: [
      `${payload.vendorName}`,
      `${payload.buyerName}`,
      `${payload.productDetails}`,
      `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
    ],
    source: 'Workwise Platform',
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {},
    paramsFallbackValue: {
      FirstName: 'user'
    }
  };
  // Headers for the API request
  const headers = {
    'Content-Type': 'application/json',
  };
  // Make the POST request to the messaging API
  await axios.post(aisensy_api, data, { headers: headers })
  .then(response => {
      console.log('RFQ received notification sent to vendor:', response.data);
    })
    .catch(error => {
      console.error(
        'Failed to send RFQ received notification to vendor:',
        error.response ? error.response.data : error.message
      );
    });
},


sendQuoteSubmissionNotification: async (payload) =>{

  const data = {
    apiKey: aisensy_bearer_token,
    campaignName: 'VendorSubmitQuote',
    destination: formatPhoneNumber(payload.mobile),
    userName: 'letsworkwise',
    templateParams: [
      `${payload.name}`,
      `${payload.message}`,
      `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
    ],
    source: 'new-landing-page form',
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {},
    paramsFallbackValue: {
      FirstName: 'user'
    }
  };

    const headers = {
      'Content-Type': 'application/json',
    };
  
   await axios
      .post(aisensy_api, data, { headers: headers })
      .then((response) => {
        console.log('WhatsApp Message Sent:', response.data);
      })
      .catch((error) => {
        console.error(
          'Failed to send WhatsApp message:',
          error.response ? error.response.data : error.message
        );
      });
},

  contactUsFormWhatsAppMessage: async (payload) => {
    const data = {
      apiKey: aisensy_bearer_token,
      campaignName: 'ContactFormSubmit',
      destination: formatPhoneNumber(payload.phone),
      userName: 'letsworkwise',
      templateParams: [`${payload.name}`],
      source: 'new-landing-page form',
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: {},
      paramsFallbackValue: {
        FirstName: 'user'
      }
    };
    const headers = {
      'Content-Type': 'application/json',
    };
  
   await axios
      .post(aisensy_api, data, { headers: headers })
      .then((response) => {
        console.log('WhatsApp Message Sent:', response.data);
      })
      .catch((error) => {
        console.error(
          'Failed to send WhatsApp message:',
          error.response ? error.response.data : error.message
        );
      });
  },

  sendQuoteReminderNotificationToVendor: async (payload) => {

    const data = {
      apiKey: aisensy_bearer_token,
      campaignName: 'SendReminderNotification',
      destination: formatPhoneNumber(payload.mobile),
      userName: 'letsworkwise',
      templateParams: [
        `${payload.name}`,
        `${payload.buyerName}`,
        `${payload.rfq_no}`,
        `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
      ],
      source: 'Workwise Platform',
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: {},
      paramsFallbackValue: {
        FirstName: 'user'
      }
    };
  
    // Construct the data payload
    // const data = {
    //   "messaging_product": "whatsapp",
    //   "recipient_type": "individual",
    //   "to": formatPhoneNumber(payload.mobile),
    //   "type": "template",
    //   "template": {
    //     "name": "rfq_quote_reminder_temp_vendor",
    //     "language": {
    //       "policy": "deterministic",
    //       "code": "en_US"
    //     },
    //     "components": [
    //       {
    //         "type": "body",
    //         "parameters": [
    //           {
    //             "type": "text",
    //             "text": payload.name
    //           },
    //           {
    //             "type": "text",
    //             "text": payload.buyerName
    //           },
    //           {
    //             "type": "text",
    //             "text": payload.rfq_no
    //           }
    //         ]
    //       },
    //       {
    //         "type": "button",
    //         "sub_type": "url",
    //         "index": 0,
    //         "parameters": [
    //           {
    //             "type": "text",
    //             "text": `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
    //           }
    //         ]
    //       }
    //     ]
    //   }
    // }
  
    const headers = {
      'Content-Type': 'application/json',
    };
  
    console.log(data)

    // 4) Make the POST request
    await axios.post(aisensy_api, data, { headers: headers })
    .then(response => {
        console.log('New Quote Notification Sent:', response.data);
      })
      .catch(error => {
        console.error(
          'Failed to send new quote notification:',
          error.response ? error.response.data : error.message
        );
      });
  },

  sendNewQuoteNotificationToBuyer: async (payload) => {
  
    // Construct the data payload
    const data = {
      apiKey: aisensy_bearer_token,
      campaignName: 'BuyerNewQuoteReceived',
      destination: formatPhoneNumber(payload.mobile),
      userName: 'letsworkwise',
      templateParams: [
        `${payload.rfqNumber}`
        `${payload?.buyerName}`,
        `${payload?.vendorName}`,
        `${payload?.projectName}`,
        `${payload.rfqNumber}`,
        `dashboard/buyer/quote-compare?rfq=${payload.rfqID}`
      ],
      source: 'new-landing-page form',
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: {},
      paramsFallbackValue: {
        FirstName: 'user'
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
    };

    // 4) Make the POST request
    await axios.post(aisensy_api, data, { headers: headers })
    .then(response => {
        console.log('New Quote Notification Sent:', response.data);
      })
      .catch(error => {
        console.error(
          'Failed to send new quote notification:',
          error.response ? error.response.data : error.message
        );
      });
  },

  buyerAddedVendorNotificationToVendor: async (payload) => {
    // Construct the data payload
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile) , 
      type: "template",
      template: {
        name: "vendor_added_on_portal_by_buyer",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "text",
                text: payload.buyerName // e.g., the buyer name
              }
            ]
          },
          // Body - The template has 4 placeholders for body text
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: payload?.buyerName // 1st placeholder, e.g., buyer name
              },
              {
                type: "text",
                text: payload?.email // 2nd placeholder, e.g., vendor name
              },
              {
                type: "text",
                text: payload?.password  // 3rd placeholder, e.g., project name
              }
            ]
          }
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    console.log(data)

    // 4) Make the POST request
    await axios.post(flux_chat_api, data, { headers: headers })
    .then(response => {
        console.log('vendor added on workwise by buyer :', response.data);
      })
      .catch(error => {
        console.error(
          'Failed to add vendor on workwise by buyer :',
          error.response ? error.response.data : error.message
        );
      });

  }
}



export default whatsappNotificationAISensy;
