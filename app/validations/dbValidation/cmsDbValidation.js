import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug } from '../../helper/common.js';
import cmsModel from '../../models/cmsModel.js';
// import blogModel from '../../models/blogModel.js';
// import storeModel from '../../models/storeModel.js';
import { encode } from 'html-entities';
import fs from 'fs';

const validateDbBody = {
  banner_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { title } = req.body;

      if (title) {
        const bannerExists = await cmsModel.banner_exists(title);
        if (bannerExists.length > 0) {
          const file_path = Config.upload.banner_image;
          const file_link = req.file.path;
          err++;
          errors.title = 'Banner exists';

          // delete existing file
          /* fs.unlink(file_link, (err) => {
            if (err) console.log(err);
            else {
              //console.log('file_link unlink ------', file_link);
            }
          }); */
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  page_content_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let page_content_id = req.params.page_content_id;

      if (page_content_id) {
        const pageContentIdExists = await cmsModel.getPageContentCount(
          page_content_id
        );
        if (pageContentIdExists.length < 1) {
          err++;
          errors.page_content_id = 'Page Content ID not exists';
          // delete existing file
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  banner_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let banner_id = req.params.banner_id;

      if (banner_id) {
        const bannerIdExists = await cmsModel.getBannerDetail(banner_id);
        // console.log('bannerIdExists-->', bannerIdExists);
        if (bannerIdExists.length < 1) {
          err++;
          errors.banner_id = 'Banner ID not exists';
          // delete existing file
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  budget_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let budget_id = req.params.budget_id;

      if (budget_id) {
        const budgetIdExists = await cmsModel.budget_find_one(budget_id);
        if (budgetIdExists.length < 1) {
          err++;
          errors.budget_id = 'Budget not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  shop_by_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let shop_by_category_id = req.params.shop_by_category_id;

      if (shop_by_category_id) {
        const shopByIdExists = await cmsModel.shop_by_find_one(
          shop_by_category_id
        );
        if (shopByIdExists.length < 1) {
          err++;
          errors.shop_by_category_id = 'Shop by category not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  print_media_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let print_media_id = req.params.print_media_id;

      if (print_media_id) {
        const printMediaIdExists = await cmsModel.print_media_find_one(
          print_media_id
        );
        if (printMediaIdExists.length < 1) {
          err++;
          errors.budget_id = 'Print media not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  photo_gallery_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let photo_gallery_id = req.params.photo_gallery_id;

      if (photo_gallery_id) {
        const printMediaIdExists = await cmsModel.photo_gallery_find_one(
          photo_gallery_id
        );
        if (printMediaIdExists.length < 1) {
          err++;
          errors.budget_id = 'Photo gallery not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  lookbook_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let lookbook_id = req.params.lookbook_id;

      if (lookbook_id) {
        const lookbookIdExists = await cmsModel.lookbook_find_one(lookbook_id);
        if (lookbookIdExists.length < 1) {
          err++;
          errors.lookbook_id = 'Lookbook not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  page_content_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let page_content_id = req.params.id;
      let status = req.body.status;

      if (page_content_id) {
        const pageContentIDExists = await cmsModel.getPageContentCount(
          page_content_id
        );
        if (pageContentIDExists.length == 0) {
          err++;
          errors.id = 'Page content ID not found';
        }
        if (status == 1 && pageContentIDExists[0].status == 1) {
          err++;
          errors.status = 'Page content already active';
        } else if (status == 0 && pageContentIDExists[0].status == 0) {
          err++;
          errors.status = 'Page content already inactive';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  faq_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let faqId = req.params.id;

      const faqIdIdExists = await cmsModel.checkFaq(faqId);
      if (faqIdIdExists.length == 0) {
        err++;
        errors.id = 'Faq not exists';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  testimonial_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let testimonialId = req.params.id;

      const testimonialIdIdExists = await cmsModel.checkTestimonial(
        testimonialId
      );
      if (testimonialIdIdExists.length == 0) {
        err++;
        errors.id = 'Testimonial not exists';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  blog_category_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let blogCategoryId = req.body.blog_category;

      const blogCategoryIdIdExists = await cmsModel.checkBlogCategory(
        blogCategoryId
      );
      if (blogCategoryIdIdExists.length == 0) {
        err++;
        errors.id = 'Blog category not exists';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  blog_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let blogId = req.params.id;

      const blogIdIdExists = await cmsModel.checkBlog(blogId);
      if (blogIdIdExists.length == 0) {
        err++;
        errors.id = 'Blog not exists';
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  }
  /*  gift_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let gift_id = req.params.gift_id;

      if (gift_id) {
        const giftIdExists = await cmsModel.gift_find_one(gift_id);
        if (giftIdExists.length < 1) {
          err++;
          errors.gift_id = 'Gift not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  gender_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let gender_id = req.params.gender_id;

      if (gender_id) {
        const genderIdExists = await cmsModel.gender_find_one(gender_id);
        if (genderIdExists.length < 1) {
          err++;
          errors.gender_id = 'Gender not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  press_room_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let press_room_id = req.params.press_room_id;

      if (press_room_id) {
        const pressRoomIdExists = await cmsModel.press_room_find_one(
          press_room_id
        );
        if (pressRoomIdExists.length < 1) {
          err++;
          errors.press_room_id = 'Press room not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  governance_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let governance_id = req.params.governance_id;

      if (governance_id) {
        const governanceIdExists = await cmsModel.governance_find_one(
          governance_id
        );
        if (governanceIdExists.length < 1) {
          err++;
          errors.governance_id = 'Governance not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  faq_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let faq_id = req.params.faq_id;
      //  console.log('test db validation');
      if (faq_id) {
        const faqIdExists = await cmsModel.faq_find_one(faq_id);
        if (faqIdExists.length < 1) {
          err++;
          errors.faq_id = 'FAQ ID not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  blog_slug_exist: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let blog_slug = req.params.slug;
      //  console.log('test db validation');
      if (blog_slug) {
        const blogSlugExists = await blogModel.blog_slug_exists(blog_slug);
        if (blogSlugExists.length == 0) {
          err++;
          errors.blog_slug = 'Blog not exists';
        }
      } else {
        err++;
        errors.blog_slug = 'Blog not exists';
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  blog_category_slug_exist: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let blog_category_slug = req.params.slug;
      if (blog_category_slug) {
        const blogCategorySlugExists = await blogModel.category_slug_exists(
          blog_category_slug
        );
        if (blogCategorySlugExists.length == 0) {
          err++;
          errors.blog_slug = 'Blog category not exists';
        }
      } else {
        err++;
        errors.blog_slug = 'Blog not exists';
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  page_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let page_name = req.params.page_name;

      if (page_name) {
        const pageExists = await cmsModel.page_find_one(page_name);
        if (pageExists.length < 1) {
          err++;
          errors.page_name = 'Page not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  state_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let state_id = req.params?.state_id || req.body?.state_id;

      if (state_id) {
        const stateIdExists = await storeModel.state_id_exists(
          state_id,
          'active'
        );
        if (stateIdExists.length == 0) {
          err++;
          errors.state_id = 'State ID not exists';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  city_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let city_id = req.params?.city_id || req.body?.city_id;

      if (city_id) {
        const cityIdExists = await storeModel.city_id_exists(city_id, 'active');
        if (cityIdExists.length == 0) {
          err++;
          errors.city_id = 'City ID not exists';
        }
      }
      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  store_id_exists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let store_id = req.params?.store_id || req.body?.store_id;

      if (store_id) {
        const storeIdExists = await storeModel.store_id_exists(
          store_id,
          'active'
        );
        if (storeIdExists.length == 0) {
          err++;
          errors.store_id = 'Store ID not exists';
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        next();
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
  } */
};

export { validateDbBody };
