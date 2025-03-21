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
  create_media_section: async (req, res, next) => {
    try {
      const created_by = req.user.id;
      const {
        title = null,
        url = null,
        thumbnail_image = null,
        pageId = null
      } = req.body;

      const dataToInsert = {
        title: title,
        url: url,
        thumbnail_image: thumbnail_image,
        pageId: pageId
      };
      const mediaList = await cmsModel.mediaSectionInsert(dataToInsert)
      if (mediaList) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Media addead'
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
    } catch (error) {
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
          message: `Page section successfully ${status == 0 ? 'Inactive' : 'Active'
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

  demoBookingListing: async (req, res, next) => {
    try {
      let page, limit, offset;
      
      if (req.query.page && req.query.page > 0) {
        page = parseInt(req.query.page, 10); // Ensure page is an integer
        limit = parseInt(req.query.limit, 10) || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
  
      // Fetch paginated demo bookings and total count
      let demoBookings = await cmsModel.getDemoBookingList(limit, offset);
      let totalBookings = await cmsModel.getDemoBookingCount();
  
      res
        .status(200)
        .json({
          status: 1,
          data: demoBookings,
          count: totalBookings.length
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
  teamMemberDetail: async (req, res, next) => {
    try {
      let memberId = req.params.id;
      let memberDetails = await cmsModel.getTeamMemberDetails(memberId);
      res
        .status(200)
        .json({
          status: 1,
          data: memberDetails
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
      const { title, description, url, status, created_name, pageId } = req.body;
      // let filename = req.file.filename;
      // let original_filename = req.file.originalname;

      let testimonialObj = {
        title: title,
        description: description,
        created_by: createdBy,
        url: url,
        page_id: pageId,
        status: status,
        // thumbnail_image:
        //   req?.files?.image?.length > 0
        //     ? `${Config.download_url}/testimonial_image/${req.files.image[0].filename}`
        //     : null,
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
  createTeamMember: async (req, res, next) => {
    try {
      const createdBy = req.user.id;
      const { name, role, mobile, email, page_id, linkedin, twitter, facebook, whatsapp, status } = req.body;

      let teamMemberObj = {
        name, role, mobile, email, page_id, linkedin, twitter, facebook, whatsapp, status,
        created_by: createdBy,
        profile_image:
          req.file?.filename
            ? `${Config.download_url}/team_member_image/${req.file?.filename}`
            : null,
      };

      await cmsModel.createTeamMember(teamMemberObj);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Team Member added Successfully...!'
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
      // let id=req.params.id
      // if(!id){
      //   logError("no page id is provided");
      //   res
      //     .status(400)
      //     .json({
      //       status: 3,
      //       message: "no page id is provided "
      //     })
      //     .end();
      // }
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
      if(!testimonialId){
        logError("testimonialId is not given");
        res
          .status(400)
          .json({
            status: 3,
            message: "testimonialId is not given"
          })
          .end();
      }
      
      const { title, description, url, status, created_name } = req.body;

      const findOneTestimonial = await cmsModel.checkTestimonial(testimonialId);
      // console.log('findOneTestimonial-->', findOneTestimonial);
      let testimonialObj = {
        title: title,
        description: description,
        url: url,
        page_id: req.body.pageId ? req.body.pageId : findOneTestimonial[0]?.page_id,
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
  teamMemberList: async (req, res, next) => {
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

      const search = req.query?.search;
      const teamMemberList = await cmsModel.getAllTeamMembers( limit, offset, search );

      res
        .status(200)
        .json({
          status: 1,
          data: teamMemberList,
          total_count: teamMemberList.length
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
  updateTeamMember: async (req, res, next) => {
    try {
      const memberId = req.params.id;
      if (!memberId) {
        logError("Member_id is required");
        res
          .status(400)
          .json({
            status: 3,
            message: "Member_id is required"
          })
          .end();
      }

      const { name, role, mobile, email, page_id, linkedin, twitter, facebook, whatsapp, status } = req.body;

      const existingData = await cmsModel.checkTeamMember(memberId);

      let teamMemberObj = {
        name: name !== "" ? name : existingData.name,
        role: role !== "" ? role : existingData.role,
        mobile: mobile !== "" ? mobile : existingData.mobile,
        email: email !== "" ? email : existingData.email,
        page_id: page_id !== "" ? page_id : existingData.page_id,
        linkedin: linkedin !== "" ? linkedin : existingData.linkedin,
        twitter: twitter !== "" ? twitter : existingData.twitter,
        facebook: facebook !== "" ? facebook : existingData.facebook,
        whatsapp: whatsapp !== "" ? whatsapp : existingData.whatsapp,
        status: status !== "" ? status : existingData.status,
        updatedAt: new Date()
      };

      if (req.file) {
        teamMemberObj = {
          ...teamMemberObj,
          old_image: existingData.profile_image,
          profile_image: req.file?.filename
            ? `${Config.download_url}/team_member_image/${req.file?.filename}`
            : null,
        };
      }

      await cmsModel.teamMemberUpdateOne(teamMemberObj, memberId);

      res.status(200).json({
        status: 1,
        message: 'Member Updated successfully'
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
  deleteTeamMember: async (req, res, next) => {
    try {
      let memberId = req.params.id;

      await cmsModel.deleteTeamMember(memberId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Team Member deleted'
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
  },
  
  
 
  addLocation: async (req, res, next) => {
    //  country_name to add new country
    // state_name and country_id to add new state
    // city_name and state_id to add new city
    const {country_name, state_name, country_id, city_name,state_id   } = req.body;
    console.log("Controller Executed");
    let result = null;
    try {
     // Create the location object and call the service model to add the city
      if(state_id && city_name){
       // Capitalize each word in the city_name
        const formattedCityName = city_name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        const locationObj = { state_id: state_id, city_name: formattedCityName };
        result = await cmsModel.createLocation("city", locationObj);
      }
      else if(country_id && state_name){
        const formattedStateName = state_name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        const locationObj = { country_id: country_id, state_name: formattedStateName };
        result = await cmsModel.createLocation("state", locationObj);
      }
      else if(country_name){
        const formattedCountryName = country_name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        result = await cmsModel.createLocation("country", {country_name:formattedCountryName});
      }
      // Return the result
      res.status(200).json({ message: 'Location added successfully', data: result });
    } catch (err) {
      logError(err);
      res
        .status(400)
        .json({
          status: 3,
          message: Config?.errorText?.value || "Failed to add location"
        })
        .end();
    }
  },
  
 
  

  
  updateLocation: async (req, res) => {
    const { state_id, city_id, city_name } = req.query; // Receive parameters from query
  
    try {
      // Ensure that either state_id or city_id is provided
      if (!state_id && !city_id) {
        return res.status(400).json({ error: "Either state_id or city_id is required" });
      }
  
      // Ensure city_name is provided for the update
      if (!city_name) {
        return res.status(400).json({ error: "city_name is required to perform the update" });
      }
  
      // Prepare the update data
      const updateData = { city_name };
  
      // Call the service to update the data
      const result = await cmsModel.updateLocations(state_id, city_id, updateData);
  
      if (result) {
        return res.status(200).json({ message: "Location updated successfully", data: result });
      } else {
        return res.status(404).json({ error: "Location not found" });
      }
    } catch (err) {
      console.error("Error updating location:", err);
      // Directly send an error response without calling next()
      return res.status(500).json({ error: "An error occurred while updating location" });
    }
  }
  ,
    
  
  getAllLocations: async (req, res, next) => {
    try {
      const { 
        limit = 10, 
        offset = 0, 
        search = '',
        state = '' 
      } = req.query;
  
      const locations = await cmsModel.getAllLocations(
        Number(limit), 
        Number(offset), 
        search,
        state
      );
  
      res.status(200).json({
        success: true,
        data: locations,
        message: 'Locations fetched successfully',
      });
    } catch (error) {
      res.status(500).json({
        success: false, 
        message: 'Failed to fetch locations',
        error: error.message,
      });
    }
  },

  deleteLocation: async (req, res, next) => {
    const { city_id } = req.params;  // Changed from req.body to req.params
     try {
      // Call service to delete the city
      const result = await cmsModel.deleteLocations(city_id);
      console.log('Deletion result:', result);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error during deletion:', error);
      next(error); // Pass error to error-handling middleware
    }
  },
  addProductDescription : async (req , res , next ) =>{
     const { product_id , content  } = req.body

     try {
          const productDescriptionObj = {
            product_id: product_id,
           description: content
          };
          console.log("---------------------------",product_id,content);
          const response = await cmsModel.addProductDescription(productDescriptionObj);
         
          if (response) {
            res.status(200).json({
              status: 1,
              message: 'Product description added successfully'
            }).end();
          } else {
            res.status(400).json({
              status: 3,
              message: Config.errorText.value
            }).end();
          }
            } catch (error) {
          logError(error);
          res.status(500).json({
            status: 3,
            message: Config.errorText.value
          }).end();
            }
  },
  getProductDescription : async (req , res , next) =>{
    try {
      
      const productDescription = await cmsModel.getProductDescription();
      res
        .status(200)
        .json({
          status: 1,
          data: productDescription
        })
        .end();
    } catch (error) {
      res.status(500).json({
        success: false, 
        message: 'Failed to fetch locations',
        error: error.message
    })
      
    }
  },
  updateProductdescription: async (req, res, next) => {
    const { id, product_id, description } = req.body;


    
  
    // Check if the product description exists
    try {
      const existingProductDescription = await cmsModel.getProductDescriptionById(id);
      
      if (!existingProductDescription) {
        return res.status(404).json({
          status: 2,
          message: "Product description not found"
        }).end();
      }
  
      const updateProductObj = {
        id: id,
        product_id: product_id,
        description: description
      };
  
      const response = await cmsModel.updateProductDescription(updateProductObj);
  
      if (!response) {
        res.status(400).json({
          status: 2,
          message: "Unable to update Product description"
        }).end();
      } else {
        res.status(200).json({
          status: 1,
          message: "Product description updated successfully"
        }).end();
      }
    } catch (error) {
      logError(error);
      res.status(500).json({
        status: 3,
        message: Config.errorText.value
      }).end();
    }
  },
  deleteProductDescription: async (req, res, next) => {
    const { id } = req.params;
  
    try {
      // Check if the product description exists
      const existingProduct = await cmsModel.getProductDescriptionById(id);
  
      if (!existingProduct) {
        return res.status(404).json({
          status: 0,
          message: "Product description not found",
        }).end();
      }
  
      // Proceed with deletion if it exists
      const response = await cmsModel.deleteProductDescription(id);
  
      if (response) {
        res.status(200).json({
          status: 1,
          message: "Product description deleted successfully",
        }).end();
      } else {
        res.status(400).json({
          status: 0,
          message: "Failed to delete product description",
        }).end();
      }
    } catch (error) {
      res.status(500).json({
        status: 0,
        message: "Internal server error",
      }).end();
    }
  },
  getOneProductDescription : async (req , res , next) => {
    const { id } = req.params;
    try {
      let response =  await cmsModel.getOneProductDescription(id);

      if (response) {
        res.status(200).json({
          status: 1,
          data: response,
        }).end();
      }  else {
        res.status(400).json({
          status: 0,
          message: "Failed to delete product description",
        }).end();
      }
    } catch (error) {
      res.status(500).json({
        status: 0,
        message: "Internal server error",
      }).end();
    }
  }
  
   
  
};
export default cmsController;
