/* eslint-disable no-console */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import dateFormat from 'dateformat';
import config from '../config/app.config.js';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import userModel from '../models/userModel.js';
import { URL } from 'url';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import crypto from 'crypto';

// Persistence Statuses
export const PERSISTENCE_STATUSES = {
  INITIATED: 'initiated',
  PROCESSING: 'processing',
  PARTIAL_COMPLETED: 'partially_completed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TERMINATED: 'terminated'
}

/** Log data for debugging purpose
 * Only work when in DEV env
 */
const consoleLogData = (...args) => {
  const theEnv = process.env.NODE_ENV;
  if (theEnv == 'development' || theEnv == 'uat') {
    console.warn(...args);
  }
};

const buildProductFilters = ({
  vendorId,
  productName,
  filterProduct,
  isFeatured,
  userId,
  categoryId,
  dateFrom,
  dateTo,
  is_approve
}) => {
  let conditions = [`PD.created_by IN (1, 111)`]; // hardcoded fallback

  if (productName) {
    conditions.push(`
      (
        to_tsvector('english', PD.name) @@ plainto_tsquery('english', $/productName/)
        OR similarity(PD.name, $/productName/) > 0.1
      )
    `);
  }

  if (filterProduct?.id_array?.length) {
    conditions.push(`PD.id IN (${filterProduct.id_array.join(',')})`);
  }

  if (vendorId) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM tbl_product_variant pv
        JOIN tbl_product_variant_vendor_mapping pvm ON pv.id = pvm.product_variant_id
        WHERE pv.product_id = PD.id AND pvm.vendor_id = $/vendorId/
      )
    `);
  }

  if (userId) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM tbl_product_variant pv
        JOIN tbl_product_variant_vendor_mapping pvm ON pv.id = pvm.product_variant_id
        WHERE pv.product_id = PD.id AND pvm.vendor_id = $/userId/
      )
    `);
  }

  if (isFeatured) {
    conditions.push(`PD.is_featured = $/isFeatured/`);
  }

  if (categoryId) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM tbl_product_categories pc
        WHERE pc.product_id = PD.id AND pc.category_id = $/categoryId/
      )
    `);
  }

  if (dateFrom) {
    conditions.push(`PD.created_at::date >= $/dateFrom/`);
  }

  if (dateTo) {
    conditions.push(`PD.created_at::date <= $/dateTo/`);
  }

  if (is_approve !== null && is_approve !== undefined) {
    conditions.push(`PD.is_approve = $/is_approve/`);
  }

  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
};

const calcTime = () => {
  // create Date object for current location
  let d = new Date();

  // convert to msec
  // subtract local time zone offset
  // get UTC time in msec
  let utc = d.getTime() + d.getTimezoneOffset() * 60000;

  // create new Date object for different city
  // using supplied offset
  let nd = new Date(utc + 3600000 * 5.5);

  // return time as a string
  return nd;
};

var createPay = (payment) => {
  return new Promise((resolve, reject) => {
    paypal.payment.create(payment, function (err, payment) {
      if (err) {
        reject(err);
      } else {
        resolve(payment);
      }
    });
  });
};

const logError = (...args) => {
  // Support both (err) and (message, err) signatures
  let err = null;
  let msg = null;

  if (args.length === 1) {
    err = args[0] instanceof Error ? args[0] : null;
    msg = err ? null : args[0];
  } else if (args.length >= 2) {
    msg = args[0];
    err = args[1] instanceof Error ? args[1] : null;
  }

  console.error('Error from common ==>', msg || err, err || msg);

  if (!err || !err.stack) {
    return;
  }

  let matches = err.stack.split('\n');
  let regex1 = /\((.*):(\d+):(\d+)\)$/;
  let regex2 = /(.*):(\d+):(\d+)$/;
  let errorArr1 = regex1.exec(matches[1]);
  let errorArr2 = regex2.exec(matches[1]);
  if (errorArr1 !== null || errorArr2 !== null) {
    let errorText = matches[0];
    if (errorArr1 !== null) {
      var errorFile = errorArr1[1];
      var errorLine = errorArr1[2];
    } else if (errorArr2 !== null) {
      var errorFile = errorArr2[1];
      var errorLine = errorArr2[2];
    }

    let now = calcTime();
    let date_format = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');

    let errMsg = `\n DateTime: ${date_format} \n ${errorText} \n Line No : ${errorLine} \n File Path: ${errorFile} \n`;
    fs.appendFile(config.errorFileName, errMsg, (err) => {
      if (err) throw err;
      //console.log('The file has been saved!');
    });
  }
};
const currentDateTime = () => {
  let now = calcTime();

  return dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
};

const generateOTPRandomNo = () => {
  let digits = '0123456789';
  let OTP = '';
  for (let i = 0; i < 6; i++) {
    OTP += digits[Math.floor(Math.random() * 10)];
  }
  return OTP;
};

const generateRandomString = (length = 24) => {
  let digits = 'abcdefghijklmnopqrstuxy';
  let str = '';
  for (let i = 0; i < length; i++) {
    str += digits[Math.floor(Math.random() * 10)];
  }
  return str;
};

const titleToSlug = (title) => {
  let slug;

  // convert to lower case
  slug = title.toLowerCase();

  // remove special characters
  slug = slug.replace(
    /\`|\~|\!|\@|\#|\||\$|\%|\^|\&|\*|\(|\)|\+|\=|\,|\.|\/|\?|\>|\<|\'|\"|\:|\;|_/gi,
    ''
  );
  // The /gi modifier is used to do a case insensitive search of all occurrences of a regular expression in a string

  // replace spaces with dash symbols
  slug = slug.replace(/ /gi, '-');

  // remove consecutive dash symbols
  slug = slug.replace(/\-\-\-\-\-/gi, '-');
  slug = slug.replace(/\-\-\-\-/gi, '-');
  slug = slug.replace(/\-\-\-/gi, '-');
  slug = slug.replace(/\-\-/gi, '-');

  // remove the unwanted dash symbols at the beginning and the end of the slug
  slug = '@' + slug + '@';
  slug = slug.replace(/\@\-|\-\@|\@/gi, '');
  return slug;
};

const containsDuplicates = (size_arr) => {
  for (let i = 0; i < size_arr.length; i++) {
    if (size_arr[i] != '') {
      if (size_arr.indexOf(size_arr[i]) !== size_arr.lastIndexOf(size_arr[i])) {
        return true;
      }
    }
  }
  return false;
};

const getErrorText = (err) => {
  let matches = err.stack.split('\n');
  return matches[0];
};

const sendMail = (mailOptions) => {
  return new Promise((resolve, reject) => {
    console.log('[MAIL] sendMail called');
    console.log('[MAIL] To:', mailOptions.to);
    console.log('[MAIL] From:', mailOptions.from);
    console.log('[MAIL] Subject:', mailOptions.subject);

    if (!mailOptions.to || mailOptions.to === '') {
      console.log('[MAIL] ERROR: No recipient email provided');
      return resolve(false);
    }

    console.log('[MAIL] Creating transport...');
    let transporter = nodemailer.createTransport(config.transportConfig);

    console.log('[MAIL] Sending email...');
    transporter.sendMail(mailOptions, function (err, info) {
      if (err) {
        console.error('[MAIL] ERROR sending email:', err.message);
        console.error('[MAIL] Full error:', err);
        return resolve(false);
      } else {
        console.log('[MAIL] Email sent successfully!');
        console.log('[MAIL] Message ID:', info.messageId);
        console.log('[MAIL] Response:', info.response);
        return resolve(true);
      }
    });
  });
};
const notificationMail = (mailOptions) => {
  let dynamic_html = fs
    .readFileSync(
      `${config.template_path}/dynamic_message_withoutname_template.txt`
    )
    .toString();

  let html_variables = [{ message: mailOptions.html }];
  for (let index = 0; index < html_variables.length; index++) {
    const element = html_variables[index];
    let dynamic_key = Object.keys(element)[0];
    let replace_char = html_variables[index][dynamic_key];
    let replace_var = `[${dynamic_key.toLowerCase()}]`;

    dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
  }
  mailOptions.html = dynamic_html;
  if (mailOptions.to && mailOptions.to != '') {
    let transporter = nodemailer.createTransport(config.transportConfig);
    transporter.sendMail(mailOptions, function (err, info) {
      if (err) {
        // console.error('Mail err=>', err);
        return false;
      } else {
        // console.log('Mail Info=>', info);
        return true;
      }
    });
  }
};

const generatePassword = (password) => {
  let salt = bcrypt.genSaltSync(10);
  let hash = bcrypt.hashSync(password, salt);
  return hash;
};

const acl = function (role) {
  return (req, res, next) => {
    const userRoles = req.user.user_type;
    let check = role.find((e) => e === userRoles);
    if (check) {
      next();
    } else {
      res.status(403).json({ message: 'Insufficient permissions' });
    }
  };
};

const noAcl = function (deniedRoles) {
  return (req, res, next) => {
    const userRole = req.user.user_type;
    const isDenied = deniedRoles.includes(userRole);

    if (isDenied) {
      res.status(403).json({ message: 'Access denied for this role' });
    } else {
      next();
    }
  };
};

/**
 * Generate an HMAC SHA256 signature
 * @param {string} message - The message you want to HASH
 * @param {string} secret - Your secret key
 * @returns {string} base64url-encoded signature
 */
export function generateSignature(message, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(message);
  const signature = hmac.digest('base64url');
  
  return signature;
}

export function verifyAIWebhookBody(req, res, next) {
  const { file_name, user, expires, signature } = req.query;
  const { type, jsonFileUrl, availableSheets, errors } = req.body;

  if (!file_name || !user || !expires || !signature) {
    return res.status(400).json({ error: 'Missing parameters.' });
  }

  if(!errors && (!jsonFileUrl || !availableSheets)) {
    return res.status(400).json({ error: 'Missing payload data, jsonFileUrl and availableSheets are required when there are no errors!' });
  }

  if(!type || !['rfq', 'simplified', 'cost-estimation'].includes(type)) {
    return res.status(400).json({ error: 'Type out of bound.' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > parseInt(expires, 10)) {
    return res.status(403).json({ error: 'Webhook URL or Signature has been expired, please .' });
  }

  const secret = process.env.WEBHOOK_SECRET;
  const message = `${file_name}_${user}_${expires}`;
  const expectedSignature = generateSignature(message, secret);

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    return res.status(403).json({ error: 'Invalid signature.' });
  }

  // All good!
  next();
}

export function normalizeErrors(errors) {
  if (!errors) return [];

  if (typeof errors === 'string') {
    return [{ message: errors }];
  }

  if (Array.isArray(errors) || typeof errors === 'object') {
    return errors;
  }

  return [{ message: String(errors) }];
}

const convertSixDigit = (id) => {
  try {
    let str = '' + id;
    let pad = '000000';
    let ans = pad.substring(0, pad.length - str.length) + str;
    return ans;
  } catch (error) {
    throw error;
  }
};

const addDefaultNotifications = async (userId) => {
  const rsp = await userModel.communicationSettingsListCTRL();
  for await (const { id } of rsp) {
    const rsp = await userModel.setCommunicationSettings(userId, 1, 1, id);
  }
};

const arraysHaveSameData = async (arr1, arr2) => {
  if (arr1.length !== arr2.length) {
    return false;
  }

  return (
    JSON.stringify(arr1.slice().sort()) === JSON.stringify(arr2.slice().sort())
  );
};

const getFileNameFromUrl = async (url) => {
  try {
    const urlObject = new URL(url);
    const path = urlObject.pathname;
    const segments = path.split('/');
    const fileName = segments.pop();
    return fileName;
  } catch (error) {
    console.error('Invalid URL:', error.message);
    return null;
  }
};

const getDateRange = (filter) => {
  const today = new Date();
  const endDate = today; 
  let startDate;

  switch (filter) {
      case 'past7days':
          startDate = new Date();
          startDate.setDate(today.getDate() - 6);
          break;
      case 'currentMonth':
          startDate = new Date(today.getFullYear(), today.getMonth(), 1);
          break;
      case 'past3months':
          startDate = new Date(today.getFullYear(), today.getMonth() - 2, 1);
          break;
      case 'past6months':
          startDate = new Date(today.getFullYear(), today.getMonth() - 5, 1);
          break;
      case 'wholeYear':
          startDate = new Date(today.getFullYear(), 0, 1);
          break;
      default:
          throw new Error('Invalid chart filter');
  }

  return { startDate, endDate };
};

async function deleteFileFromS3(s3Client, fileUrl) {
  try {
    // Parse the S3 file URL to get the Key (path inside the bucket)
    const url = new URL(fileUrl); // e.g. https://bucket-name.s3.amazonaws.com/banner_image/abc.jpg
    const key = decodeURIComponent(url.pathname.slice(1)); // removes leading '/'

    const params = {
      Bucket: "test-workwise-bucket",
      Key: key,
    };

    const command = new DeleteObjectCommand(params);
    const response = await s3Client.send(command);
    console.log("✅ File deleted:", response);
  } catch (error) {
    console.error("❌ Error deleting file from S3:", error);
  }
}


function withTransaction(model, transaction) {
  // Wraps the model methods to automatically pass the transaction

  // This function creates a proxy around the model to intercept method calls

  return new Proxy(model, {
    get(target, propKey) {
      const originalMethod = target[propKey];

      if (typeof originalMethod === 'function') {
        return function (...args) {
          // Add transaction as last argument

          return originalMethod.apply(target, [...args, transaction]);
        };
      }

      return originalMethod;
    }
  });
}

const validateNumber = (value) => value && !isNaN(parseInt(value))


export {
  consoleLogData,
  calcTime,
  logError,
  getErrorText,
  currentDateTime,
  titleToSlug,
  generateOTPRandomNo,
  generateRandomString,
  containsDuplicates,
  sendMail,
  createPay,
  generatePassword,
  acl,
  noAcl,
  convertSixDigit,
  notificationMail,
  addDefaultNotifications,
  arraysHaveSameData,
  getFileNameFromUrl,
  getDateRange,
  deleteFileFromS3,
  buildProductFilters,
  withTransaction,
  validateNumber
};
