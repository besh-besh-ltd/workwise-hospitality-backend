//import blogModel from '../../models/blogModel.js';
import cmsModel from '../../models/cmsModel.js';
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';
import Moment from 'moment';
import rfqModel from '../../models/rfqModel.js';
import productModel from '../../models/productModel.js';

const cmsController = {
  pageList: async (req, res, next) => {
    try {
      let pageList = await cmsModel.getPageList();
      res
        .status(200)
        .json({
          status: 1,
          data: pageList
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  create_banner: async (req, res, next) => {
    try {
      let created_by = req.user.id;
      console.log('created_by--', created_by);
      // return false;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { page_id, content, status } = req.body;
      // console.log('page_id--', page_id);

      let filename = req.file.filename;
      let original_filename = req.file.originalname;
      let banner = await cmsModel.bannerInsert(
        page_id,
        content,
        `${Config.download_url}/banner_image/${filename}`,
        status || 1,
        created_by
      );
      if (banner) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Banner Added'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  create_logo: async (req, res, next) => {
    try {
      let created_by = req.user.id;
      console.log('created_by--', created_by);
      // return false;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { status } = req.body;
      // console.log('page_id--', page_id);

      let filename = `${Config.download_url}/company_image/${req.file.filename}`;
      let original_filename = req.file.originalname;
      let banner = await cmsModel.logoInsert(filename, status || 1);
      if (banner) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Company logo added'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  bannerListing: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let bannerList = await cmsModel.getbannerList(limit, offset);
      let bannerCount = await cmsModel.getBannerCount();
      res
        .status(200)
        .json({
          status: 1,
          data: bannerList,
          total_count: bannerCount.length
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  logoListing: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let logoList = await cmsModel.getlogoList(limit, offset);
      let logoCount = await cmsModel.getLogoCount();
      res
        .status(200)
        .json({
          status: 1,
          data: logoList,
          total_count: logoCount.length
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  update_banner: async (req, res, next) => {
    try {
      var created_by = req.user.id;
      let banner_id = req.params.banner_id;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { page_id, content, status } = req.body;
      let filename = '';
      let original_filename = '';
      let banner = '';
      if (req.file?.filename) {
        filename = `${Config.download_url}/banner_image/${req.file.filename}`;
        original_filename = req.file.originalname;
        banner = await cmsModel.bannerUpdateFilename(
          page_id,
          content,
          filename,
          status || 1,
          banner_id
        );
      } else {
        banner = await cmsModel.bannerUpdate(
          page_id,
          content,

          status || 1,
          banner_id
        );
      }

      if (banner) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Banner updated'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  update_logo: async (req, res, next) => {
    try {
      var created_by = req.user.id;
      let logo_id = req.params.logo_id;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { status } = req.body;
      let filename = '';
      let original_filename = '';
      let banner = '';
      if (req.file?.filename) {
        filename = `$${Config.download_url}/company_image/${req.file.filename}`;
        original_filename = req.file.originalname;
        banner = await cmsModel.logoUpdateFilename(
          filename,
          status || 1,
          logo_id
        );
      } else {
        banner = await cmsModel.logoUpdate(status || 1, logo_id);
      }

      if (banner) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Logo updated'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  bannerDetail: async (req, res, next) => {
    try {
      // let page_id = req.params.page_id;
      let banner_id = req.params.banner_id;
      let bannerDetail = await cmsModel.getBannerDetail(banner_id);
      res
        .status(200)
        .json({
          status: 1,
          data: bannerDetail
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
  logoDetail: async (req, res, next) => {
    try {
      // let page_id = req.params.page_id;
      let logo_id = req.params.logo_id;
      let logoDetail = await cmsModel.getLogoDetail(logo_id);
      res
        .status(200)
        .json({
          status: 1,
          data: logoDetail
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
  deleteBanner: async (req, res, next) => {
    try {
      let banner_id = req.params.banner_id;
      let updatedBy = req.user.id;
      await cmsModel.deleteBanner(banner_id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Banner successfully deleted'
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
  deleteLogo: async (req, res, next) => {
    try {
      let logo_id = req.params.logo_id;
      let updatedBy = req.user.id;
      await cmsModel.deleteLogo(logo_id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Logo successfully deleted'
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
  create_pagecontent: async (req, res, next) => {
    try {
      var created_by = req.user.id;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { page_id, section_name, content } = req.body;

      let banner = await cmsModel.pageContentInsert(
        page_id,
        section_name,
        content
      );
      res
        .status(200)
        .json({
          status: 1,
          message: 'Page section Added'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  pageContentListing: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let pageContentList = await cmsModel.getPageContentList(limit, offset);
      let pageContentCount = await cmsModel.getPageContentCount();
      // console.log('pageContentCount--', pageContentCount.length);
      // return false;
      res
        .status(200)
        .json({
          status: 1,
          data: pageContentList,
          count: pageContentCount.length
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  update_pagecontent: async (req, res, next) => {
    try {
      let created_by = req.user.id;
      let page_content_id = req.params.page_content_id;
      const { page_id, section_name, content } = req.body;

      let banner = await cmsModel.pageContentUpdate(
        page_id,
        section_name,
        content,
        page_content_id
      );
      res
        .status(200)
        .json({
          status: 1,
          message: 'Page section updated'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  deletePageContent: async (req, res, next) => {
    try {
      let page_content_id = req.params.page_content_id;
      let updatedBy = req.user.id;
      await cmsModel.deletePageContent(page_content_id);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Page Content successfully deleted'
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
  pageContentDetails: async (req, res, next) => {
    try {
      let page_id = req.params.page_id;
      let pageContentDetail = await cmsModel.getPageContentDetail(page_id);
      res
        .status(200)
        .json({
          status: 1,
          data: pageContentDetail
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
  updateCmsPageStatus: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let page_content_id = req.params.page_content_id;
      let status = req.body.status;
      await cmsModel.approveCmsPageContent(page_content_id, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Page section successfully ${
            status == 0 ? 'Inactive' : 'Active'
          }`
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
  contactUsListing: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let pageContentList = await cmsModel.getContactUsList(limit, offset);
      let pageContentCount = await cmsModel.getContactUsCount();
      // console.log('pageContentCount--', pageContentCount.length);
      // return false;
      res
        .status(200)
        .json({
          status: 1,
          data: pageContentList,
          count: pageContentCount.length
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  /*   update_banner: async (req, res, next) => {
    try {
      var created_by = req.user.id;
      const banner_id = req.params.banner_id;
      const now = currentDateTime();
      const created_at = dateFormat(now, 'yyyy-mm-dd HH:MM:ss');
      const { title, url, status } = req.body;
      //const slug = titleToSlug(product_name);
      const find_one_banner = await cmsModel.banner_find_one(banner_id);
      if (find_one_banner.length < 1) {
        res.status(400).json({
          status: 3,
          message: 'Banner not found'
        });
      }

      if (!req.file) {
        const data_obj = find_one_banner[0];
        const data_custom = Object.assign({}, data_obj, req.body);

        const update_without_image = await cmsModel.banner_update_one(
          data_custom.title,
          data_custom.filename,
          data_custom.original_filename,
          data_custom.url,
          data_custom.status,
          banner_id
        );

        if (update_without_image) {
          res.status(200).json({
            status: 1,
            message: 'Banner update success'
          });
        }
      } else {
        const filename = req.file.filename;
        const original_filename = req.file.originalname;

        const data_obj = find_one_banner[0];
        const data_custom = Object.assign({}, data_obj, req.body);

        const file_path = Config.upload.banner_image;
        const file_link = `${file_path}/${find_one_banner[0].filename}`;
        const update_with_image = await cmsModel.banner_update_one(
          data_custom.title,
          filename,
          original_filename,
          data_custom.url,
          data_custom.status,
          banner_id
        );

        // delete existing file
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
            //   console.log(file_link);
          }
        });

        if (update_with_image) {
          res.status(200).json({
            status: 1,
            message: 'Banner Updated'
          });
        }
      }

      //return false;
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },

  delete_banner: async (req, res, next) => {
    try {
      var banner_id = req.params.banner_id;
      const find_one_banner = await cmsModel.banner_find_one(banner_id);
      if (find_one_banner.length > 0) {
        //   console.log('find_one_banner--', find_one_banner);
        const file_path = Config.upload.banner_image;
        const file_link = `${file_path}/${find_one_banner[0].filename}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
            //   console.log(file_link);
          }
        });
      }
      let cms = await cmsModel.delete_banner(banner_id);
      // return false;

      if (cms) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Banner deleted'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },*/
  createFaq: async (req, res, next) => {
    try {
      const { question, description, status } = req.body;
      let faqObj = {
        question: question,
        description: description,
        status: status || 1
      };
      // console.log('faqObj-->', faqObj);
      // return false;
      let faq = await cmsModel.createFaq(faqObj);
      if (faq) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'FAQ Added'
          })
          .end();
      } else {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      }
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  faqDetail: async (req, res, next) => {
    try {
      // let page_id = req.params.page_id;
      let faq_id = req.params.id;
      let faqDetail = await cmsModel.getFaqDetail(faq_id);
      res
        .status(200)
        .json({
          status: 1,
          data: faqDetail
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
  blogDetail: async (req, res, next) => {
    try {
      // let page_id = req.params.page_id;
      let blog_id = req.params.id;
      let blogDetail = await cmsModel.getBlogDetail(blog_id);
      res
        .status(200)
        .json({
          status: 1,
          data: blogDetail
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
  testimonialDetail: async (req, res, next) => {
    try {
      // let page_id = req.params.page_id;
      // let blog_id = req.params.id;
      let testimonial_id = req.params.id;
      let testimonialDetail = await cmsModel.getTestimonialDetail(
        testimonial_id
      );
      res
        .status(200)
        .json({
          status: 1,
          data: testimonialDetail
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
  updateFaq: async (req, res, next) => {
    try {
      const { question, description, status } = req.body;
      let faqId = req.params.id;
      let faqObj = {
        question: question,
        description: description,
        status: status || 1
      };
      await cmsModel.updateFaq(faqObj, faqId);
      res.status(200).json({
        status: 1,
        message: 'FAQ update success'
      });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  faqList: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      let search = req.query?.search;

      let faqList = await cmsModel.getAllFaq(limit, offset, search);
      let faqCount = await cmsModel.getAllFaqCount(search);
      res
        .status(200)
        .json({
          status: 1,
          data: faqList,
          total_count: faqCount.count
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  deleteFaq: async (req, res, next) => {
    try {
      let faqId = req.params.id;
      let faqObj = {
        status: 2
      };
      await cmsModel.deleteFaq(faqObj, faqId);

      res
        .status(200)
        .json({
          status: 1,
          message: 'FAQ deleted'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  createTestimonial: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { title, description, url, status, created_name } = req.body;
      // let filename = req.file.filename;
      // let original_filename = req.file.originalname;

      let testimonialObj = {
        title: title,
        description: description,
        created_by: createdBy,
        url: url,
        status: status,
        thumbnail_image:
          req?.files?.image?.length > 0
            ? `${Config.download_url}/testimonial_image/${req.files.image[0].filename}`
            : null,
        created_name,
        created_image:
          req?.files?.created_image?.length > 0
            ? `${Config.download_url}/testimonial_image/${req.files.created_image[0].filename}`
            : null
        // original_filename: original_filename
      };

      await cmsModel.createTestimonial(testimonialObj);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Testimonial added'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  testimonialList: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let search = req.query?.search;

      let testimonialList = await cmsModel.getAllTestimonial(
        limit,
        offset,
        search
      );
      let testimonialCount = await cmsModel.getAllTestimonialCount(search);
      res
        .status(200)
        .json({
          status: 1,
          data: testimonialList,
          total_count: testimonialCount.count
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  deleteTestimonial: async (req, res, next) => {
    try {
      let testimonialId = req.params.id;
      let testimonialObj = {
        status: 2
      };

      await cmsModel.deleteTestimonial(testimonialObj, testimonialId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Testimonial deleted'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  updateTestimonial: async (req, res, next) => {
    try {
      const testimonialId = req.params.id;
      const { title, description, url, status, created_name } = req.body;

      const findOneTestimonial = await cmsModel.checkTestimonial(testimonialId);
      // console.log('findOneTestimonial-->', findOneTestimonial);
      let testimonialObj = {
        title: title,
        description: description,
        url: url,
        status: status,
        thumbnail_image:
          req?.files?.image?.length > 0
            ? `${Config.download_url}/testimonial_image/${req.files.image[0].filename}`
            : findOneTestimonial[0].thumbnail_image,
        created_name,
        created_image:
          req?.files?.created_image?.length > 0
            ? `${Config.download_url}/testimonial_image/${req.files.created_image[0].filename}`
            : findOneTestimonial[0].created_image
        /* original_filename: req.file
          ? req.file.originalname
          : findOneTestimonial[0].original_filename */
      };
      // console.log('testimonialObj-->', testimonialObj);
      await cmsModel.testimonialUpdateOne(testimonialObj, testimonialId);

      /* if (req.file) {
        const file_path = Config.upload.testimonial_image;
        const file_link = `${file_path}/${findOneTestimonial[0].thumbnail_image}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
            console.log('File deleted');
          }
        });
      } */

      res.status(200).json({
        status: 1,
        message: 'Testimonial Updated success'
      });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  blogCategoryList: async (req, res, next) => {
    try {
      let blogCategoryList = await cmsModel.getAllBlogCategory();
      res
        .status(200)
        .json({
          status: 1,
          data: blogCategoryList
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  createBlog: async (req, res, next) => {
    try {
      let createdBy = req.user.id;
      const { title, description, blog_category, slug, status } = req.body;
      let filename = `${Config.download_url}/blog_image/${req.file.filename}`;
      let original_filename = req.file.originalname;
      let blogObj = {
        title: title,
        description: description,
        blog_cat_id: blog_category,
        created_by: createdBy,
        slug: slug || titleToSlug(title),
        status: status || 1,
        image: filename,
        original_filename: original_filename
      };

      await cmsModel.createBlog(blogObj);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Blog added'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  blogList: async (req, res, next) => {
    try {
      let page, limit, offset;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let search = req.query?.search;

      let blogList = await cmsModel.getAllBlog(limit, offset, search);
      let blogCount = await cmsModel.getAllBlogCount(search);
      res
        .status(200)
        .json({
          status: 1,
          data: blogList,
          total_count: blogCount.count
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  updateBlog: async (req, res, next) => {
    try {
      const blogId = req.params.id;
      const { title, description, blog_category, slug, status } = req.body;

      const findOneBlog = await cmsModel.checkBlog(blogId);

      let blogObj = {
        title: title,
        description: description,
        blog_cat_id: blog_category,
        slug: slug || titleToSlug(title),
        status: status || 1,
        image: req.file
          ? `${Config.download_url}/blog_image/${req.file.filename}`
          : findOneBlog[0].image,
        original_filename: req.file
          ? req.file.originalname
          : findOneBlog[0].original_filename
      };

      await cmsModel.blogUpdateOne(blogObj, blogId);

      /* if (req.file) {
        const file_path = Config.upload.blog_image;
        const file_link = `${file_path}/${findOneBlog[0].image}`;
        fs.unlink(file_link, (err) => {
          if (err) console.log(err);
          else {
            console.log('File deleted');
          }
        });
      } */

      res.status(200).json({
        status: 1,
        message: 'Blog Updated success'
      });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  deleteBlog: async (req, res, next) => {
    try {
      let blogId = req.params.id;
      let blogObj = {
        status: 2
      };

      await cmsModel.deleteBlog(blogObj, blogId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Blog deleted'
        })
        .end();
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  analytics_dashboard: async (req, res, next) => {
    try {
      let analytics_dashboard = {};
      let totalUser = await cmsModel.getTotalUser(); //Total user except deleted and admin and sub admin
      // console.log('totalUser ==>>', totalUser);
      analytics_dashboard.total_user = totalUser.count;
      const startDate = Moment();
      const lastDate = startDate
        .clone()
        .subtract(30, 'day')
        .format('YYYY-MM-DD');
      let newUser = await cmsModel.getTotalUser(lastDate);
      analytics_dashboard.new_user = newUser.count;
      let activeUser = await cmsModel.getTotalUser('', 1);
      analytics_dashboard.active_user = activeUser.count;
      let totalBuyers = await cmsModel.getTotalUser('', '', 2);
      analytics_dashboard.total_buyers = totalBuyers.count;
      let totalVendor = await cmsModel.getTotalUser('', '', 3);
      analytics_dashboard.total_vendor = totalVendor.count;
      let totalOther = await cmsModel.getTotalUser('', '', 4);
      analytics_dashboard.total_other = totalOther.count;
      let paidUsers = await cmsModel.getPaidUsers();
      analytics_dashboard.paid_users = paidUsers.count;
      /* let unpaidUsers = await cmsModel.getPaidUsers();
      analytics_dashboard.unpaid_users = unpaidUsers.count; */
      let totalRfq = await rfqModel.getAllRfq();
      analytics_dashboard.total_rfq = totalRfq.count;
      let activeRfq = await rfqModel.getAllRfq(1);
      analytics_dashboard.active_rfq = activeRfq.count;
      let totalProduct = await productModel.getAllProduct();
      analytics_dashboard.total_product = totalProduct.count;
      res
        .status(200)
        .json({
          status: 1,
          data: analytics_dashboard
        })
        .end();
    } catch (err) {
      logError(err);
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
export default cmsController;
