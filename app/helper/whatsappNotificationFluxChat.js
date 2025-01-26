
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
}



export default whatsappNotificationFluxChat;
