import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  containsDuplicates
} from '../../helper/common.js';
import productModel from '../../models/productModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';
import userModel from '../../models/userModel.js';
import { encode } from 'html-entities';
import fs from 'fs';

const validateDbBody = {
  parentIdExists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let cat_id = [];
      let { parent_id, title, slug } = req.body;
      console.log('parent_id-->', parent_id);
      console.log('title-->', title);
      if (parent_id && parent_id != '0') {
        let parentIdExists = await productModel.parentIdExists(parent_id);
        if (parentIdExists.length > 0) {
        } else {
          err++;
          errors.cat_id = 'Please enter proper category id';
        }
      }

      if (title && parent_id && parent_id != '0') {
        let parentNameExists = await productModel.parentNameExists(
          title,
          parent_id
        );
        if (parentNameExists.length > 0) {
          err++;
          errors.title = 'Category already exists';
        } else {
        }
      }
      if (title && parent_id && parent_id == '0') {
        let topparentNameExists = await productModel.topParentparentNameExists(
          title
        );
        if (topparentNameExists.length > 0) {
          err++;
          errors.title = 'Category already exists';
        } else {
        }
      }
      if (slug) {
        let categorySlugExists = await productModel.categorySlugExists(slug);
        if (categorySlugExists.length > 0) {
          err++;
          errors.slug = 'Slug already exists';
        } else {
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
  categoryIdExists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let categoryId = req.params.id;

      if (categoryId) {
        const categoryIDExist = await productModel.categoryIDExist(categoryId);
        if (categoryIDExist.length == 0) {
          err++;
          errors.cat_id = 'Category ID not exits';
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
  categoryActiveIdExists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let categoryId = req.params.id;

      if (categoryId) {
        const categoryIDExist = await productModel.categoryActiveIDExist(
          categoryId
        );
        if (categoryIDExist.length == 0) {
          err++;
          errors.cat_id = 'Category ID not exits';
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
  updateCategoryExists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let categoryId = req.params.id;
      let { parent_id, title, slug } = req.body;

      if (categoryId) {
        const categoryIDExist = await productModel.categoryIDExist(categoryId);
        if (categoryIDExist.length == 0) {
          err++;
          errors.cat_id = 'Category ID not exits';
        }
      }
      if (parent_id) {
        const parentIDExist = await productModel.parentIdExists(parent_id);
        if (parentIDExist.length == 0) {
          err++;
          errors.parent_id = 'Parent ID not exits';
        }
      }

      /*       if (title && parent_id && parent_id != '0') {
        console.log('title-->', title);
        console.log('parent_id case-->', parent_id);
        const categoryTitleExist = await productModel.categoryTitleExist(
          title,
          categoryId
        );
        if (categoryTitleExist.length > 0) {
          err++;
          errors.title = 'Title already exists';
        }
      }
      if (title && parent_id && parent_id == '0') {
        const categoryTitleExist =
          await productModel.topParentcategoryTitleExist(title);
        if (categoryTitleExist.length > 0) {
          err++;
          errors.title = 'Title already exists';
        }
      } */
      if (slug) {
        let categorySlugExists = await productModel.categorySlugUpdateExists(
          slug,
          categoryId
        );
        if (categorySlugExists.length > 0) {
          err++;
          errors.slug = 'Slug already exists';
        } else {
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
  attributeIdExists: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { attribute_id } = req.body;
      let id = req.params?.id;

      if (attribute_id || id) {
        let attributeIdExists = await productModel.attributeIdExists(
          attribute_id || id
        );
        if (attributeIdExists.length == 0) {
          err++;
          attribute_id
            ? (errors.attribute_id = 'Please enter proper attribute')
            : (errors.id = 'Please enter proper attribute');
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
  add_vendor_product: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;

      let { name, approved_id, master_id } = req.body;
      
      if (approved_id) {
        /*  approved_id = JSON.parse(approved_id);
        for await (const approveId of approved_id) {
          let findVendorApprove =
            await vendorapproveModel.findVendorApproveById(approveId);
          if (findVendorApprove.length == 0) {
            err++;
            errors.approved_id = 'Approved by not found';
          }
        } */
      }

      let prodNameExists = await productModel.checkVariantExistsForVendor(
        req.user.id,
        master_id,
      );
      if (prodNameExists.length > 0) {
        err++;
        errors.name = 'Product is already mapped with vendor';
      }
      if (req.method == 'PUT' && req.findProduct.is_approve != 1) {
        let checkMasterNameExist = await productModel.checkMasterNameExist(
          name,
          req.params?.id
        );
        if (checkMasterNameExist.length > 0) {
          err++;
          errors.name = 'This product is available in master product';
        }
      } else if (req.method != 'PUT' && !master_id) {
        let checkMasterNameExist = await productModel.checkMasterNameExist(
          name
        );
        if (checkMasterNameExist.length > 0) {
          err++;
          errors.name = 'This product is available in master product';
        }
      }

      if (master_id) {
        let findProduct = await productModel.checkVariantById(master_id);
        if (findProduct.length == 0) {
          err++;
          errors.master_id = 'Product not found';
        }
      }

      if (err > 0) {
        /*  if (req.files?.featured && req.files?.featured.length > 0) {
          fs.unlink(req.files.featured[0].path, (unlinkError) => {
            if (unlinkError) {
              console.error('Error deleting file:', unlinkError);
            }
          });
        }
        if (req.files?.gallery && req.files?.gallery.length > 0) {
          req.files.gallery.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        } */
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
  check_product: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let productId = req.params?.id || req.body?.product_id;

      let created_by = 0;
      if (req.user.user_type == 3 || req.user.user_type == 4) {
        created_by = req.user.id;
      }
      let findProduct;
      if (productId) {
        findProduct = await productModel.check_product(productId);
        if (findProduct.length == 0) {
          err++;
          errors.id = 'Product not found';
        }
      }
      if (err > 0) {
        /*  if (req.files?.featured && req.files?.featured.length > 0) {
          fs.unlink(req.files.featured[0].path, (unlinkError) => {
            if (unlinkError) {
              console.error('Error deleting file:', unlinkError);
            }
          });
        }
        if (req.files?.gallery && req.files?.gallery.length > 0) {
          req.files.gallery.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        }
        if (req.files?.tds && req.files?.tds.length > 0) {
          req.files.tds.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        }
        if (req.files?.qap && req.files?.qap.length > 0) {
          req.files.qap.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        } */
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        req.findProduct = findProduct[0];
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
  checkVariant: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let variantId = req.params?.id || req.body?.variant_id;

      let created_by = 0;
      if (req.user.user_type == 3 || req.user.user_type == 4) {
        created_by = req.user.id;
      }
      let findVariant;
      if (variantId) {
        findVariant = await productModel.checkVariantById(variantId);
        if (findVariant.length == 0) {
          err++;
          errors.id = 'Product not found';
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
        req.findVariant = findVariant[0];
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
  product_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let productId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;

      console.log(`Validating product approval for ID: ${productId}, status: ${status}`);
      
      // Validate basic parameters
      if (status === undefined || status === null) {
        err++;
        errors.status = 'Status is required';
        console.log("Missing status parameter");
      }
      
      if (!productId) {
        err++;
        errors.id = 'Product ID is required';
        console.log("Missing product ID");
      } else {
        // Check if product or variant exists
        const productIDExists = await productModel.check_product(productId);
        console.log(`Product search results for ID ${productId}:`, productIDExists?.length || 0);
        
        if (!productIDExists || productIDExists.length === 0) {
          err++;
          errors.id = 'Product or variant not found';
          console.log(`Product/variant ID ${productId} not found`);
        } else {
          // Changes by Agnij May 02, 2025 [Removed check for already approved/rejected items to allow re-approval/re-rejection]
          const item = productIDExists[0];
          console.log(`Found item of type ${item.product_id ? 'variant' : 'product'}`);
          
          // We no longer block already approved/rejected items to make the UI more forgiving
          if (item && item.is_approve !== undefined) {
            const numericStatus = status === '1' || status === 1 || status === true ? 1 : 0;
            console.log(`Current approval status: ${item.is_approve}, Requested status: ${numericStatus}`);
            
            // Just log but don't block if it's the same status
            if (numericStatus === 1 && item.is_approve === 1) {
              console.log("Item is already approved, but allowing re-approval");
            } else if (numericStatus === 0 && item.is_approve === 0) {
              console.log("Item is already rejected, but allowing re-rejection");
            }
          } else {
            console.log(`Item has no is_approve property or is undefined`);
          }
        }
      }

      // Check rejection reason if rejecting
      if (status === '0' || status === 0 || status === false) {
        if (!reject_reason_id && !reject_reason) {
          err++;
          errors.reject_reason_id = 'Reject reason is required';
          console.log("Missing reject reason for rejection");
        }
      }

      if (err > 0) {
        console.log("Validation failed with errors:", errors);
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        console.log("Validation passed");
        next();
      }
    } catch (err) {
      console.error("Error in product_approve_check:", err);
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
  variant_approve_check: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let variantId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;
      
      // Validate basic parameters
      if (status === undefined || status === null) {
        err++;
        errors.status = 'Status is required';
      }
      
      if (!variantId) {
        err++;
        errors.id = 'Product ID is required';
      } else {
        // Check if product or variant exists
        const variantIdExists = await productModel.checkVariantById(variantId);
        
        if (!variantIdExists || variantIdExists.length === 0) {
          err++;
          errors.id = 'Product or variant not found';
        } else {
          // Changes by Agnij May 02, 2025 [Removed check for already approved/rejected items to allow re-approval/re-rejection]
          const item = variantIdExists[0];
          console.log(`Found item of type ${item.product_id ? 'variant' : 'product'}`);
          
          // We no longer block already approved/rejected items to make the UI more forgiving
          if (item && item.is_approve !== undefined) {
            const numericStatus = status === '1' || status === 1 || status === true ? 1 : 0;
            
            // Just log but don't block if it's the same status
            if (numericStatus === 1 && item.is_approve === 1) {
              console.log("Item is already approved, but allowing re-approval");
            } else if (numericStatus === 0 && item.is_approve === 0) {
              console.log("Item is already rejected, but allowing re-rejection");
            }
          } else {
            console.log(`Item has no is_approve property or is undefined`);
          }
        }
      }

      // // Check rejection reason if rejecting
      // if (status === '0' || status === 0 || status === false) {
      //   if (!reject_reason_id && !reject_reason) {
      //     err++;
      //     errors.reject_reason_id = 'Reject reason is required';
      //     console.log("Missing reject reason for rejection");
      //   }
      // }

      if (err > 0) {
        console.log("Validation failed with errors:", errors);
        res
          .status(400)
          .json({
            status: 2,
            errors
          })
          .end();
      } else {
        console.log("Validation passed");
        next();
      }
    } catch (err) {
      console.error("Error in variant_approve_check:", err);
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
  add_admin_product: async (req, res, next) => {
    try {
      let errors = {};
      let err = 0;
      let { name, categories, approved_id, vendor } = req.body;
      console.log("MESSY ------- ", categories)
      // categories = JSON.parse(categories);
      /* if (vendor) {
        let checkVendor = await userModel.findActiveVendor(vendor);
        if (checkVendor.length == 0) {
          err++;
          errors.vendor = 'Vendor not found';
        }
      } */
      if (approved_id) {
        /*  approved_id = JSON.parse(approved_id);
        for await (const approveId of approved_id) {
          let findVendorApprove =
            await vendorapproveModel.findVendorApproveById(approveId);
          if (findVendorApprove.length == 0) {
            err++;
            errors.approved_id = 'Approved by not found';
          }
        } */
      }

      for await (const categoryId of categories) {
        let categoryExist = await productModel.parentIdExists(categoryId);
        if (categoryExist.length == 0) {
          err++;
          errors.categories = 'Category not found';
        }
      }
      /*  let prodNameExists = await productModel.checkProductExists(
        name,
        vendor,
        req.params?.id || null
      );
      if (prodNameExists.length > 0) {
        err++;
        errors.name = 'Product name already exist';
      } */

      if (err > 0) {
        /*  if (req.files?.featured && req.files?.featured.length > 0) {
          fs.unlink(req.files.featured[0].path, (unlinkError) => {
            if (unlinkError) {
              console.error('Error deleting file:', unlinkError);
            }
          });
        }
        if (req.files?.gallery && req.files?.gallery.length > 0) {
          req.files.gallery.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        }
        if (req.files?.tds && req.files?.tds.length > 0) {
          req.files.tds.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        }
        if (req.files?.qap && req.files?.qap.length > 0) {
          req.files.qap.forEach((file) => {
            fs.unlink(file.path, (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            });
          });
        } */
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
};

export { validateDbBody };
