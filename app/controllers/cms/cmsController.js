// import userModel from '../../models/userModel.js';
import cmsModel from '../../models/cmsModel.js';
import notificationModel from '../../models/notificationModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  generateOTPRandomNo,
  generateRandomString,
  createPay,
  sendMail,
  notificationMail
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { v4 } from 'uuid';
import admin from 'firebase-admin';
import fcm from 'fcm-notification';
import serviceAccount from '../../config/privateKey.json' assert { type: 'json' };

const CmsController = {
  homeBanner: async (req, res, next) => {
    try {
      let page_id = req.params.page_id;
      // return false;

      const bannerList = await cmsModel.homeBanner(page_id);
      if (bannerList && bannerList.length > 0) {
        res
          .status(200)
          .json({
            status: 1,
            data: bannerList
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Banner not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  cms_data: async (req, res, next) => {
    try {
      let page_id = req.params.page_id;

      let page_sections = await cmsModel.pageSectionContent(page_id);
      // console.log('page_sections-->', page_sections);
      // return false;

      if (page_sections != '') {
        res
          .status(200)
          .json({
            status: true,
            data: page_sections
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Page not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  contact_us: async (req, res, next) => {
    try {
      const { name, email, phone, subject, comment, submitted_from } = req.body;

      let contactObj = {
        name,
        email,
        phone,
        subject,
        comment,
        submitted_from: submitted_from || 1
      };
      let contact = await cmsModel.contactUsInsert(contactObj);
      // console.log('Test controller-->', contactObj);
      let dynamic_html = fs
        .readFileSync(`${Config.template_path}/admin_contact_template.txt`)
        .toString();

      let html_variables = [
        { name: name },
        { email: email },
        { phone: phone },
        { subject: subject },
        { comment: comment }
      ];
      for (let index = 0; index < html_variables.length; index++) {
        const element = html_variables[index];
        let dynamic_key = Object.keys(element)[0];
        let replace_char = html_variables[index][dynamic_key];
        let replace_var = `[${dynamic_key.toLowerCase()}]`;

        dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
      }

      sendMail({
        from: Config.webmasterMail, // sender address
        to: Config.admin_email, // list of receivers
        subject: `Work wise | Contact Us | ${name}`, // Subject line
        html: dynamic_html // plain text body
      });

      let user_dynamic_html = fs
        .readFileSync(`${Config.template_path}/user_contact_template.txt`)
        .toString();

      for (let index = 0; index < html_variables.length; index++) {
        const element = html_variables[index];
        let dynamic_key = Object.keys(element)[0];
        let replace_char = html_variables[index][dynamic_key];
        let replace_var = `[${dynamic_key.toLowerCase()}]`;

        user_dynamic_html = user_dynamic_html.replaceAll(
          replace_var,
          replace_char
        );
      }
      let emailNotification = '';
      if (submitted_from == '1') {
        emailNotification = 'contact_us';
      } else if (submitted_from == '2') {
        emailNotification = 'enquire_now';
      } else if (submitted_from == '3') {
        emailNotification = 'get_in_touch';
      }

      let findDynamicNotification =
        await notificationModel.findDynamicNotification(emailNotification);

      if (
        findDynamicNotification.length > 0 &&
        findDynamicNotification[0].notification_type == 1
      ) {
        notificationMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: findDynamicNotification[0].title, // Subject line
          html: findDynamicNotification[0].content // plain text body
        });
      } else {
        sendMail({
          from: Config.webmasterMail, // sender address
          to: email, // list of receivers
          subject: `Work wise | Contact Us`, // Subject line
          html: user_dynamic_html // plain text body
        });
      }

      res
        .status(200)
        .json({
          status: true,
          message: 'Contact success'
        })
        .end();
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  management_list: async (req, res, next) => {
    try {
      let management_type = req.params.management_type;

      let managementList = await cmsModel.managementList(management_type);

      if (managementList != '') {
        res
          .status(200)
          .json({
            status: true,
            data: managementList
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'No management exists'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  faq_listing: async (req, res, next) => {
    try {
      let faqListing = await cmsModel.faqListing();

      if (faqListing != '') {
        res
          .status(200)
          .json({
            status: true,
            data: faqListing
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Page not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  blog_listing: async (req, res, next) => {
    try {
      let blogListing = await cmsModel.blogListing();

      if (blogListing != '') {
        res
          .status(200)
          .json({
            status: true,
            data: blogListing
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Blog not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  media_section: async (req, res, next) => {
    try {
      let media = await cmsModel.mediaListing();
      if (media != '') {
        res
          .status(200)
          .json({
            status: true,
            data: media
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Media not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  company_list: async (req, res, next) => {
    try {
      let companyListing = await cmsModel.companyListing();

      if (companyListing != '') {
        res
          .status(200)
          .json({
            status: true,
            data: companyListing
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Company not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  testimonial_list: async (req, res, next) => {
    try {
      let testimonialListing = await cmsModel.testimonialListing();

      if (testimonialListing != '') {
        res
          .status(200)
          .json({
            status: true,
            data: testimonialListing
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Company not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  product_list: async (req, res, next) => {
    try {
      let productListing = await cmsModel.productListing();

      if (productListing != '') {
        res
          .status(200)
          .json({
            status: true,
            data: productListing
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 2,
            message: 'Product not exist'
          })
          .end();
      }
    } catch (error) {
      logError(error);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  }
};
export default CmsController;
