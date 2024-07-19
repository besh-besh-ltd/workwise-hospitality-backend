/* eslint-disable no-console */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import dateFormat from 'dateformat';
import config from '../config/app.config.js';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import userModel from '../models/userModel.js';
/** Log data for debugging purpose
 * Only work when in DEV env
 */
const consoleLogData = (...args) => {
  const theEnv = process.env.NODE_ENV;
  if (theEnv == 'development' || theEnv == 'uat') {
    console.warn(...args);
  }
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

const logError = (err) => {
  console.error('Error from common ==>', err);

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

const generateRandomString = () => {
  let digits = 'abcdefghijklmnopqrstuxy';
  let str = '';
  for (let i = 0; i < 24; i++) {
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
  convertSixDigit,
  notificationMail,
  addDefaultNotifications,
  arraysHaveSameData,
  getFileNameFromUrl
};
