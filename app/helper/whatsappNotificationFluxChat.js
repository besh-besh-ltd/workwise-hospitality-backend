
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

  }


}



export default whatsappNotificationFluxChat;
