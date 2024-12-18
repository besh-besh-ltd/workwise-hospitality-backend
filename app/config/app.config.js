import dotenv from "dotenv";
import dateFormat from "dateformat";

// env config
dotenv.config();

// get env data
const env = process.env.NODE_ENV || "development";

const userImageUploadPath = process.env.USER_IMAGE || null;
const productExportImageUploadPath = process.env.PRODUCT_FILE || null;
const vendorApproveImageUploadPath = process.env.VENDOR_APPROVE_IMAGE || null;
const mediaImageUploadPath = process.env.MEDIA_IMAGE || null;
const testimonialImageUploadPath = process.env.TESTIMONIAL_IMAGE || null;
const companyImageUploadPath = process.env.COMPANY_IMAGE || null;
const managementImageUploadPath = process.env.MANAGEMENT_IMAGE || null;
const bannerImageUploadPath = process.env.BANNER_IMAGE || null;
const productImageUploadPath = process.env.PRODUCT_IMAGE || null;
const blogImageUploadPath = process.env.BLOG_IMAGE || null;
const agentImageUploadPath = process.env.AGENT_USER_IMAGE || null;
const termConditionPath = process.env.TERM_CONDITION || null;
const documentPathUploadPath = process.env.DOCUMENT_PATH || null;
const programBrochurePathUploadPath = process.env.PORGRAM_BROCHURE_PATH || null;
const buyerUploadVendorFile = process.env.BUYER_UPLOAD_VENDOR_FILE || null;
const projectFileUploadPath = process.env.PROJECT_FILE_UPLOAD_PATH || null;
const teamMemberImageUploadPath = process.env.TEAM_MEMBER_IMAGE || null;
const addClauseUploadPath = process.env.ADD_CLAUSE_FILE || null;

const queryMessageFilesUploadPath =
  process.env.QUERY_MESSAGE_FILE_UPLOAD_PATH || null;

// const productImageUploadPath = process.env.PRODUCT_IMAGE || null;
const bulkProductUploadPath = process.env.BULK_PRODUCT_FILE || null;
const magicSearchFileUploadPath = process.env.MAGIC_SEARCH_FILE || null;
const invoiceFileUploadPath = process.env.INVOICE_FILE || null;
// const blogImageUploadPath = process.env.BLOG_IMAGE || null;

const downloadURL = process.env.DOWNLOADD_URL || null;
const jwtSecret = process.env.JWT_SECRET || "sfs64SG4wg";
const cryptSecret = process.env.CRYPT_SECRET || "Anha%43wsfse";
const globalAdminLimit = process.env.LIMIT || 20;
const sgst = process.env.SGST || 0.0015;
const cgst = process.env.CGST || 0.0015;
const app_version = process.env.APP_VERSION || 1.0;
const base_url =
  // process.env.BASE_URL || 'https://panacheapi.indusnettechnologies.com';
  process.env.BASE_URL || "http://api.localhost:3001";

if (
  (jwtSecret == undefined || jwtSecret == null) &&
  (cryptSecret == undefined || cryptSecret == null)
) {
  throw new Error("Please set JWT secret and Crypt Secret in env file");
}

if (env == "development" && (downloadURL == undefined || downloadURL == null)) {
  throw new Error("Please set download URL in env file");
}

if (
  env == "development" &&
  (userImageUploadPath == undefined || userImageUploadPath == null)
) {
  throw new Error("Please set user image upload path in env file");
}
if (
  env == "development" &&
  (productExportImageUploadPath == undefined ||
    productExportImageUploadPath == null)
) {
  throw new Error("Please set product image upload path in env file");
}
if (
  env == "development" &&
  (vendorApproveImageUploadPath == undefined ||
    vendorApproveImageUploadPath == null)
) {
  throw new Error("Please set vendor approve image upload path in env file");
}
if (
  env == "development" &&
  (mediaImageUploadPath == undefined || mediaImageUploadPath == null)
) {
  throw new Error("Please set media image upload path in env file");
}
if (
  env == "development" &&
  (bulkProductUploadPath == undefined || bulkProductUploadPath == null)
) {
  throw new Error("Please set bulk product file upload path in env file");
}
if (
  env == "development" &&
  (teamMemberImageUploadPath == undefined || teamMemberImageUploadPath == null)
) {
  throw new Error("Please set team_memebrs image upload path in env file");
}

if (
  env == "development" &&
  (testimonialImageUploadPath == undefined ||
    testimonialImageUploadPath == null)
) {
  throw new Error("Please set testimonial image upload path in env file");
}
if (
  env == "development" &&
  (companyImageUploadPath == undefined || companyImageUploadPath == null)
) {
  throw new Error("Please set company image upload path in env file");
}
if (
  env == "development" &&
  (managementImageUploadPath == undefined || managementImageUploadPath == null)
) {
  throw new Error("Please set management image upload path in env file");
}
if (
  env == "development" &&
  (bannerImageUploadPath == undefined || bannerImageUploadPath == null)
) {
  throw new Error("Please set banner image upload path in env file");
}
if (
  env == "development" &&
  (productImageUploadPath == undefined || productImageUploadPath == null)
) {
  throw new Error("Please set product image upload path in env file");
}
if (
  env == "development" &&
  (blogImageUploadPath == undefined || blogImageUploadPath == null)
) {
  throw new Error("Please set blog image upload path in env file");
}

if (
  env == "development" &&
  (agentImageUploadPath == undefined || agentImageUploadPath == null)
) {
  throw new Error("Please set agent image upload path in env file");
}
if (
  env == "development" &&
  (invoiceFileUploadPath == undefined || invoiceFileUploadPath == null)
) {
  throw new Error("Please set invoice upload path in env file");
}

if (
  env == "development" &&
  (termConditionPath == undefined || termConditionPath == null)
) {
  throw new Error("Please set user image upload path in env file");
}

if (
  env == "development" &&
  (documentPathUploadPath == undefined || documentPathUploadPath == null)
) {
  throw new Error("Please set user image upload path in env file");
}

if (
  env == "development" &&
  (programBrochurePathUploadPath == undefined ||
    programBrochurePathUploadPath == null)
) {
  throw new Error("Please set program brochure upload path in env file");
}

if (env == "development" && (base_url == undefined || base_url == null)) {
  throw new Error("Please set user image upload path in env file");
}

if (
  env == "development" &&
  (addClauseUploadPath == undefined || addClauseUploadPath == null)
) {
  throw new Error("Please set add clause file path in env file");
}

const config = {
  app_version: app_version,
  jwt: {
    secret: jwtSecret,
  },
  cryptR: {
    secret: cryptSecret,
  },
  gst: {
    sgst: sgst,
    cgst: cgst,
  },
  upload: {
    user_image:
      env == "development"
        ? userImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/user_image",
    product_export:
      env == "development"
        ? productExportImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/product_export",
    vendor_approve:
      env == "development"
        ? vendorApproveImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/vendor_approve",
    media_image:
      env == "development"
        ? mediaImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/media_image",
    team_member_image:
      env == "development"
        ? teamMemberImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/team_member_image",
    testimonial_image:
      env == "development"
        ? testimonialImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/testimonial_image",
    product_image:
      env == "development"
        ? productImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/product_image",
    company_image:
      env == "development"
        ? companyImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/company_image",
    management_image:
      env == "development"
        ? managementImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/management_image",
    banner_image:
      env == "development"
        ? bannerImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/banner_image",
    blog_image:
      env == "development"
        ? blogImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/blog_image",
    agent_user_image:
      env == "development"
        ? agentImageUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/agent_user_image",
    user_document:
      env == "development"
        ? documentPathUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/user_document/",
    program_brochure:
      env == "development"
        ? documentPathUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/course_brochure",
    term_condition:
      env == "development"
        ? termConditionPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/term_condition",
    bulk_product_file:
      env == "development"
        ? bulkProductUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/bulk_product_file",
    magic_search_file:
      env == "development"
        ? magicSearchFileUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/magic_search_file",
    query_message_file:
      env == "development"
        ? queryMessageFilesUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/query_message_files",
    invoice_file:
      env == "development"
        ? invoiceFileUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/invoice_file",
    project_file:
      env == "development"
        ? projectFileUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/project_file",
    buyer_upload_vendor_file:
      env == "development"
        ? buyerUploadVendorFile
        : "/application/de_technico/web-backend/des-technico/app/uploads/buyer_upload_vendor_file",
    add_clause_file:
      env == "development"
        ? addClauseUploadPath
        : "/application/de_technico/web-backend/des-technico/app/uploads/add_clause_file",
  },
  download_url:
    // env == 'development' ? downloadURL : 'http://143.110.242.57:8112',
    env == "development" ? downloadURL : "https://api.letsworkwise.com",
  // base_url: env == 'development' ? base_url : 'http://localhost:3000',
  // base_url: 'http://143.110.242.57:8112',
  base_url: "https://api.letsworkwise.com",
  globalAdminLimit: globalAdminLimit,
  errorText: {
    value: "An internal error has occurred. Please try again later.",
  },
  errorFileName: `./app/storage/internal/error_log_${dateFormat(
    new Date(),
    "mm_yyyy"
  )}.txt`,

  transportConfig: {
    host: "smtp-relay.brevo.com",
    port: 587,
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_USER_PASSWORD,
    },
  },
  developers: [
    "Gyan <gyan@letsworkwise.com>",
    "Yash <yash@letsworkwise.com>",
    "Imtiaj <imtiaj@letsworkwise.com >",
    // "Sourav Maity <sourav.maity@indusnet.co.in>",
    // "Abhisek Pal <abhisek.pal@indusnet.co.in>",
  ],
  admin_email: [
    'mukul@letsworkwise.com',
    // 'sourav.maity@indusnet.co.in',
    // 'abhisek.pal@indusnet.co.in',
    // 'ranit.majumder@indusnet.co.in',
    // 'anumita.banerjee@indusnet.co.in'
  ],
  webmasterMail: "Work Wise <hello@letsworkwise.com>",
  template_path:
    process.env.TEMPLATE_PATH ||
    "/application/de_technico/web-backend/des-technico/app/helper/email_template",
  razorpay: {
    razorpay_key: process.env.RAZORPAY_KEY,
    razorpay_secret: process.env.RAZORPAY_SECRET,
    razorpay_signature: process.env.RAZORPAY_SIGNATURE,
  },
};
export default config;
