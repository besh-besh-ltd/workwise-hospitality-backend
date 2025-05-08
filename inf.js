import vendorModel from './app/models/vendorModel.js';
import rfqModel from './app/models/rfqModel.js';


const rfqData = [
    { user_id: 212, email: "brightsteel_bbsr@rediffmail.com", company: "BRIGHT STEEL", id: 553, rfq_no: 402726 },
    { user_id: 2655, email: "sales@sbispat.com", company: "Shah Brothers Ispat Private Limited", id: 553, rfq_no: 402726 },
    { user_id: 2355, email: "rohit.bagaria@ofbusiness.in", company: "OFB TECH PRIVATE LIMITED", id: 553, rfq_no: 402726 },
    { user_id: 4157, email: "jainsjuhi@gmail.com", company: "INDIAN STEEL AND METALS", id: 553, rfq_no: 402726 },
    { user_id: 4115, email: "lisco1949@gmail.com", company: "LUCKNOW IRON AND STEEL CO.", id: 553, rfq_no: 402726 },
    { user_id: 1302, email: "info@jindalsteel.com", company: "JINDAL STEEL & POWER LTD.(JSPL)", id: 553, rfq_no: 402726 },
    { user_id: 1372, email: "chairman.sail@sail.in", company: "SAIL(STEEL AUTHORITY OF INDIA LTD)", id: 553, rfq_no: 402726 },
    { user_id: 2349, email: "accounts@gndispat.com", company: "GND ISPAT PVT. LTD.", id: 553, rfq_no: 402726 },
    { user_id: 8230, email: "superelectroenggs@yahoo.com", company: "Super Electro Processors Pvt Ltd", id: 553, rfq_no: 402726 },
    { user_id: 209, email: "sudhanshu@sail.in", company: "SAIL", id: 553, rfq_no: 402726 },
    { user_id: 1954, email: "accounts@gdkalani.com", company: "G.D. KALANI & SONS", id: 553, rfq_no: 402726 },
    { user_id: 1654, email: "jrcl_pnp@yahoo.com", company: "JRCL STEEL PVT LTD", id: 553, rfq_no: 402726 },
    { user_id: 2541, email: "commercial@essar.com", company: "ESSAR (MUMBAI)", id: 553, rfq_no: 402726 },
    { user_id: 1955, email: "kdguptaco@gmail.com", company: "K.D. GUPTA & CO", id: 553, rfq_no: 402726 },
    { user_id: 3457, email: "guptasonu444@gmail.com", company: "GUPTA STEEL TRADERS", id: 553, rfq_no: 402726 },
    { user_id: 1956, email: "jaindeepee@yahoo.co.in", company: "BISHAMBHERNATH JINESH CHAND JAIN", id: 553, rfq_no: 402726 },
    { user_id: 4100, email: "atturkar@gmail.com", company: "Mangalore Metal House", id: 553, rfq_no: 402726 },
    { user_id: 2653, email: "garodisteels@gmail.com", company: "SHREE GARODI STEELS", id: 553, rfq_no: 402726 },
    { user_id: 211, email: "shyamal@shyamsteel.com", company: "SHYAM STEEL INDUSTRIES LIMITED", id: 553, rfq_no: 402726 },
    { user_id: 3719, email: "info@sagargroup.co.in", company: "SAGAR ROOFINGS PVT. LTD.", id: 553, rfq_no: 402726 },
    { user_id: 1957, email: "info@patram.in", company: "Patram Ispat Bhandar", id: 553, rfq_no: 402726 },
    { user_id: 1958, email: "umangguna@gmail.com", company: "UMANG HARDWARE", id: 553, rfq_no: 402726 }
  ];
  
  
  



 


const htmlSend = async (rfqData)=>{


    const headerContent = `<h2>Hello ${rfqData.company},</h2>`;


    const  token = await rfqModel.getVendorRfqToken( rfqData.user_id , rfqData.id)
    const containerContent =  `<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
         <p>
           This is a friendly reminder from <strong>R.S. Group</strong> regarding the RFQ quotation. Ensure your quote is submitted on time to secure this opportunity.
         </p>
         <p>
           Please submit quote for products
         </p>

         <p> <strong> Deadline: </strong>07 - 05 - 2025</p>

         <a href="https://letsworkwise.com/dashboard/vendor/inquiries-details?id=553&token=${token[0].token}"
            style="background-color: #f87171; color: white; font-family: 'Roboto', sans-serif; text-align: center; padding: 10px 24px; display: block; border-radius: 9999px; width: 100%; max-width: 192px; margin: 0 auto; text-decoration: none;">
           Submit Your Quote Now
         </a>

         <p style="margin-top:20px; font-weight:bold; text-align:center">   Don't miss out on this opportunity!
         </p>
       </div>`

   const dynamicHTML = generateEmailTemplate(headerContent, containerContent)

    const spocList = await vendorModel.getSpocDetails(rfqData.user_id)


    let mailRecipients = {
      from:  `RS Group <hello@letsworkwise.com>`,
      subject: `Work Wise | Reminder for Quotation | Action Required`, // Subject line
      html: dynamicHTML,
      to: 'kushal@letsworkwise.com'
    };

    // if (spocList && spocList.length > 0) {
    //   mailRecipients.to = spocList.map(spoc => spoc.email);
    //   mailRecipients.cc = user_details[0].email;
    // } else {
    //   mailRecipients.to = user_details[0].email;
    // }
    sendMail(mailRecipients);
    console.log("Email sent to:", rfqData.company, "with token:", token[0].token);

}

rfqData.forEach((rfqData) => {
    htmlSend(rfqData)
}
)