
import axios from 'axios'; // Import axios for making HTTP requests

const flux_chat_api = process.env.FLUX_CHAT_API
const flux_chat_bearer_token =  process.env.FLUX_CHAT_KEY


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
const whatsappNotificationFluxChat = {

  // Function to send a notification when a buyer creates an RFQ
buyerCreatesRFQNotification: async (payload) => {
  // Construct the data payload for the WhatsApp message
  const data = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formatPhoneNumber(payload.mobile), // Assuming you have a function to format the phone number
    type: "template",
    template: {
      name: "buyer_creates_rfq",
      language: {
        policy: "deterministic",
        code: "en"
      },
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: `${payload.rfq_no}`
            }
          ]
        },
        {
          type: "button",
          sub_type: "url",
          index: 0,
          parameters: [
            {
              type: "text",
              text: `dashboard/buyer/rfq-management-details?type=buyer-view&id=${payload.rfq_id}` // Assuming you're passing RFQ ID to generate a URL
            }
          ]
        }
      ]
    }
  };

  // Headers for the API request
  const headers = {
    'Content-Type': 'application/json',
    Authorization: flux_chat_bearer_token // Replace with your actual API key for the messaging service
  };

  // Make the POST request to the messaging API
  await axios.post(flux_chat_api, data, { headers: headers })
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
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: formatPhoneNumber(payload.mobile), // Ensure to format the vendor's phone number
    type: "template",
    template: {
      name: "vendor_receives_rfq_from_buyer",
      language: {
        policy: "deterministic",
        code: "en_US"
      },
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: payload.vendorName // Example detail - RFQ number
            },
            {
              type: "text",
              text: payload.buyerName // Example detail - Buyer name
            },
            {
              type: "text",
              text: payload.productDetails // Example detail - Project name
            }
          ]
        },
        {
          type: "button",
          sub_type: "url",
          index: 0,
          parameters: [
            {
              type: "text",
              text: `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}` // Direct URL to RFQ details
            }
          ]
        }
      ]
    }
  }
  // Headers for the API request
  const headers = {
    'Content-Type': 'application/json',
    Authorization: flux_chat_bearer_token // Replace with your actual API key for the messaging service
  };
  // Make the POST request to the messaging API
  await axios.post(flux_chat_api, data, { headers: headers })
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
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": formatPhoneNumber(payload.mobile),
  "type": "template",
  "template": {
    "name": "vendor_submit_quote_to_buyer_temp_vendor",
    "language": {
      "policy": "deterministic",
      "code": "en_US"
    },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "text",
            "text": "Submitted"
          }
        ]
      },
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": payload.name
          },
          {
            "type": "text",
            "text": payload.message
          }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": 0,
        "parameters": [
          {
            "type": "text",
            "text": `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
          }
        ]
      }
    ]
  }
}

    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token // Replace with your Flux API key
    };
  
   await axios
      .post(flux_chat_api, data, { headers: headers })
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
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formatPhoneNumber(payload.phone) , // Replace with the recipient's phone number
      type: 'template',
      template: {
        name: 'contactus_form_submit_by_users',
        language: {
          policy: 'deterministic',
          code: 'en_US'
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: payload.name
              }
            ]
          }
        ]
      }
    };
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token // Replace with your Flux API key
    };
  
   await axios
      .post(flux_chat_api, data, { headers: headers })
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
  
    // Construct the data payload
    const data = {
      "messaging_product": "whatsapp",
      "recipient_type": "individual",
      "to": formatPhoneNumber(payload.mobile),
      "type": "template",
      "template": {
        "name": "rfq_quote_reminder_temp_vendor",
        "language": {
          "policy": "deterministic",
          "code": "en_US"
        },
        "components": [
          {
            "type": "body",
            "parameters": [
              {
                "type": "text",
                "text": payload.name
              },
              {
                "type": "text",
                "text": payload.buyerName
              },
              {
                "type": "text",
                "text": payload.rfq_no
              }
            ]
          },
          {
            "type": "button",
            "sub_type": "url",
            "index": 0,
            "parameters": [
              {
                "type": "text",
                "text": `dashboard/vendor/inquiries-details?id=${payload.rfq_id}&token=${payload.token}`
              }
            ]
          }
        ]
      }
    }
  
    // 3) Set your request headers (include your Flux API key)
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token // Replace with your Flux API key
    };
  
    console.log(data)

    // 4) Make the POST request
    await axios.post(flux_chat_api, data, { headers: headers })
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
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile) , 
      type: "template",
      template: {
        name: "buyer_new_quote_receive",
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
                text: payload.rfqNumber // e.g., the RFQ number
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
                text: payload?.vendorName // 2nd placeholder, e.g., vendor name
              },
              {
                type: "text",
                text: payload?.projectName || "" // 3rd placeholder, e.g., project name
              },
              {
                type: "text",
                text: payload.rfqNumber // 4th placeholder, e.g., other details
              }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: 0,
            parameters: [
              {
                type: "text",
                text: `dashboard/buyer/quote-compare?rfq=${payload.rfqID}`
              }
            ]
          }
        ]
      }
    };
  
    // 3) Set your request headers (include your Flux API key)
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token // Replace with your Flux API key
    };
  
    console.log(data)

    // 4) Make the POST request
    await axios.post(flux_chat_api, data, { headers: headers })
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
  
    // 3) Set your request headers (include your Flux API key)
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token // Replace with your Flux API key
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

  },

oneDayBeforeAuctionNotificationToVendor: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_start_day_before_vendor",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          {
            type: "header",
            parameters: [
              { type: "text", text: payload.vendor || "Vendor" }
            ]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: payload.productName || "Product" },
              { type: "text", text: payload.buyerCompanyName || "Company" },
              { type: "text", text: payload.startTime || "Start Time" }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: 0,
            parameters: [
              { type: "text", text: payload.detailsLink || "default-link" }
            ]
          }
        ]
      }
    };
    

    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
    console.log("------>", flux_chat_api);
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('1-day before auction reminder sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send 1-day before auction reminder:', error.response ? error.response.data : error.message);
      });
  },

auctionLiveNotificationToVendor: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_start_buyer",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          {
            type: "header",
            parameters: [
              { type: "text", text: payload.vendorName || "Vendor" }
            ]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: payload.productName || "Product" },
              { type: "text", text: payload.buyerCompanyName || "Company" },
              { type: "text", text: payload.endTime || "End Time" }
            ]
          }
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('Auction live notification sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send auction live notification:', error.response ? error.response.data : error.message);
      });
  },

halfwayAuctionReminderNotificationToVendor: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_mid_notification_vendor",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          {
            type: "header",
            parameters: [
              { type: "text", text: payload.vendorName || "Vendor" }
            ]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: payload.productName || "Product" },
              { type: "text", text: payload.buyerCompanyName || "Buyer" }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: 0,
            parameters: [
              { type: "text", text: payload.detailsLink || "https://letsworkwise.com/fallback" }
            ]
          }
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('Halfway auction reminder sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send halfway auction reminder:', error.response ? error.response.data : error.message);
      });
  },

auctionEndedVendorNotificationToVendor: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_end_vendor",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          // ✅ ADDED header component
          {
            type: "header",
            parameters: [
              { type: "text", text: payload.vendorName || "Vendor" }
            ]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: payload.productName || "Product" },
              { type: "text", text: payload.buyerCompanyName || "Buyer" }
            ]
          }
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('Auction ended vendor notification sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send auction ended vendor notification:', error.response ? error.response.data : error.message);
      });
  },
  
auctionStartedBuyerNotification: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_start_buyer",
        language: {
          policy: "deterministic",
          code: "en"
        },
        components: [
          {
            type: "header",
            parameters: [
              { type: "text", text: payload.buyerName || "Buyer" }
            ]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: payload.productName || "N/A" },
              { type: "text", text: payload.projectName || "N/A" },
              { type: "text", text: payload.startTime || "N/A" }
            ]
          }
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('Auction started buyer notification sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send auction started buyer notification:', error.response ? error.response.data : error.message);
      });
},

auctionEndedBuyerNotification: async (payload) => {
    const data = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatPhoneNumber(payload.mobile),
      type: "template",
      template: {
        name: "reverse_auction_end_buyer",
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
                text: payload.buyerName || "Buyer"
              }
            ]
          },
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: payload.productName || "N/A"
              },
              {
                type: "text",
                text: payload.buyerName || "Buyer"
              }
            ]
          }
          // 🔴 Removed button component — because your template doesn't include any buttons
        ]
      }
    };
  
    const headers = {
      'Content-Type': 'application/json',
      Authorization: flux_chat_bearer_token
    };
  
    await axios.post(flux_chat_api, data, { headers })
      .then(response => {
        console.log('Auction ended buyer notification sent:', response.data);
      })
      .catch(error => {
        console.error('Failed to send auction ended buyer notification:', error.response ? error.response.data : error.message);
      });
}
   
  
  
}



export default whatsappNotificationFluxChat;
