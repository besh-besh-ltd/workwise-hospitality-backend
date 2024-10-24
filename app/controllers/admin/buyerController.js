import buyerModel from '../../models/buyerModel.js';
import rfqModel from '../../models/rfqModel.js';
import subscriptionModel from '../../models/subscriptionModel.js';
import Config from '../../config/app.config.js';
import { logError, currentDateTime, titleToSlug, addDefaultNotifications, sendMail, generatePassword } from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import fs from 'fs';
import vendorModel from '../../models/vendorModel.js';
import userModel from '../../models/userModel.js';
import productModel from '../../models/productModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const buyerController = {
  buyerList: async (req, res, next) => {
    try {
      let page, limit, offset, organization, verified, name;
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      if (req.query.name) {
        name = req.query.name;
      }
      if (req.query.organization) {
        organization = req.query.organization;
      }
      if (req.query.verified) {
        verified = req.query.verified;
      }

      let buyerList = await buyerModel.getBuyerList(
        limit,
        offset,
        organization,
        verified,
        name
      );
      let buyerCount = await buyerModel.getBuyerListCount(
        organization,
        verified,
        name
      );
      res
        .status(200)
        .json({
          status: 1,
          data: buyerList,
          total_count: buyerCount.count
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
  buyerDetails: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: buyerDetails
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
  buyer_rfq_list: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let page, limit, offset;
      if (req.body.page && req.body.page > 0) {
        page = req.body.page;
        limit = req.body.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      const listRfq = await rfqModel.getAllBuyerRfq(limit, offset, buyerId);
      let count = await rfqModel.getBuyerRfqCount(buyerId);
      res
        .status(200)
        .json({
          status: 1,
          data: listRfq,
          total_items: count.length
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
  buyer_subscription_details: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      const subscriberDetails = await subscriptionModel.getSubscriberDetails(
        buyerId
      );
      res
        .status(200)
        .json({
          status: 1,
          data: subscriberDetails
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
  blockBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      let status = req.body.status;
      status = status == 1 ? 2 : 1;
      await buyerModel.blockBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${status == 1 ? 'unblocked' : 'blocked'}`
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
  updateBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      const {
        name,
        email,
        mobile,
        organization_name,
        address,
        dob,
        country,
        linkedin,
        facebook,
        whatsapp,
        skype
      } = req.body;
      let fileName = req?.file?.filename;
      let originalFilename = req?.file?.originalname;
      let buyerDetails = await buyerModel.getBuyerDetails(buyerId);
      let buyerObj = {
        name,
        email,
        mobile,
        organization_name: organization_name || null,
        updatedBy,
        fileName,
        originalFilename,
        address: address || null,
        dob: dateFormat(dob, 'yyyy-mm-dd'),
        country: country || null,
        linkedin: linkedin || null,
        facebook: facebook || null,
        whatsapp: whatsapp || null,
        skype: skype || null
      };
      await buyerModel.updateBuyer(buyerId, buyerObj);

      /* if (fileName) {
        if (buyerDetails[0].new_profile_image) {
          const file_link = `${Config.upload.user_image}/${buyerDetails[0].new_profile_image}`;
          fs.unlink(file_link, (err) => {
            if (err) console.log(err);
            else {
              //   console.log(file_link);
            }
          });
        }
      } */
      res
        .status(200)
        .json({
          status: 1,
          message: 'Buyer successfully updated'
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
  approveBuyer: async (req, res, next) => {
    try {
      let updatedBy = req.user.id;
      let buyerId = req.params.id;
      let status = req.body.status;
      await buyerModel.approveBuyer(buyerId, updatedBy, status);
      res
        .status(200)
        .json({
          status: 1,
          message: `Buyer successfully ${status == 0 ? 'Disapproved' : 'Approved'
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
  deleteBuyer: async (req, res, next) => {
    try {
      let buyerId = req.params.id;
      let updatedBy = req.user.id;
      await buyerModel.deleteBuyer(buyerId, updatedBy);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Buyer successfully deleted'
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
  reviewBuyerPrivateVendors: async (req, res, next) => {
    try {
      let createdBy = req.user.id;

      // status -1 pending review, 0 disable user profile, 1 active user, 2 rejected  
      const { vendorTempId, status, reject_reason, buyerName, productdetails } = req.body

      const userDetails = await rfqModel.checkIfExists('tbl_temp_user', `id = ${vendorTempId}`);
      if (userDetails.length <= 0) {
        return res
          .status(200)
          .json({
            status: 1,
            message: 'user not exist'
          })
          .end();
      }

      // status -1 pending review, 0 disable user profile, 1 active user, 2 rejected  
      if (status == 2) {
        const rejectUser = await userModel.updateStatusInTempUserTable(vendorTempId, status, reject_reason)
        return res
          .status(200)
          .json({
            status: 1,
            data: rejectUser,
            message: "User Rejected"
          })
          .end();
      }

      if (status != 1) {
        return res
          .status(400)
          .json({
            status: 3,
            message: "Invalid status"
          })
          .end();
      }

      let orgChar = userDetails[0].vendor_name.match(/[a-zA-Z]/g).join('').toLowerCase();
      let capitalizeFourOrganizationLetter = `${orgChar.charAt(0).toUpperCase()}${orgChar.substring(1, 4)}`;
      let password = `${capitalizeFourOrganizationLetter}@${userDetails[0].mobile.substring(
        6,
        10
      )}`;

      let vendorObj = {
        name: userDetails[0].vendor_name || null,
        email: userDetails[0].email || null,
        mobile: userDetails[0].mobile || null,
        user_type: '3',
        password: generatePassword(password),
        status: '1',
        created_by: createdBy,
        organization_name: userDetails[0].name || null
      };

      let companyObj = {
        email: userDetails[0].email || null,
        mobile: userDetails[0].mobile || null,
        company_name: userDetails[0].vendor_name || null,
        is_private: !userDetails[0].is_private ? 0: userDetails[0].is_private,
      };

      let vendor = await productModel.vendor_register(vendorObj);

      companyObj.user_id = vendor[0].id;
      await productModel.addCompany(companyObj);

      await userModel.deleteVendorFromTempUserTable(vendorTempId);

      //  map vendor with the buyer
      await userModel.mapBuyerToVendor(userDetails[0].buyer_id, vendor[0].id);

      const vendorId = vendor[0].id;
      // add product in the tbl_product with the vendor 
      let errors = [];
      for(let i=0;i<productdetails.length;i++){
        console.log(productdetails[i]);
          const errors = add_vendor_product(productdetails[i],vendorId);
          if(errors.length > 0){
            errors.push({
              productName:productdetails[i].name,
              errors:errors,
            });
            continue;
          }

          // if no error then move further for adding to tbl_product  
          let {
            name,
            description,
            manufacturer,
            availability,
            categories,
            status,
            variations,
            approved_id,
            approved_name,
            master_id
          } = productdetails[i];

          
          if (approved_id) {
            approved_id = JSON.parse(approved_id);
          }
          let vendorApproveId = 0;
          if (!approved_id && approved_name) {
            let findVendorApprove =
              await vendorapproveModel.findVendorApproveByName(approved_name);
            if (findVendorApprove.length == 0) {
              let vendorApproveObj = {
                vendor_approve: approved_name,
                status: 1
              };
              let createVendorApprove =
                await vendorapproveModel.createVendorApprove(vendorApproveObj);
              vendorApproveId = [createVendorApprove.id];
            } else {
              vendorApproveId = [findVendorApprove[0].id];
            }
          } else {
            vendorApproveId = approved_id;
          }
    
          // ---------------- products ----------------
          let productDetails = '';
          if (master_id) {
            productDetails = await productModel.check_product(master_id);
          }
          let productObj = {
            name: name,
            description: description || null,
            manufacturer: manufacturer || null,
            availability: availability || 1,
            slug: titleToSlug(name),
            sku: name,
            created_by: vendorId,
            vendor: vendorId,
            status: status || 0,
            // vendor_approved_by: vendorApproveId || null,
            is_approve: master_id ? 1 : 0,
            added_by: req.user.id,
            qap_new_file_name:
              req.files?.qap?.length > 0
                ? `${Config.download_url}/product_image/${req.files.qap[0].filename}`
                : productDetails[0].qap_new_file_name,
            qap_original_file_name:
              req.files?.qap?.length > 0
                ? req.files.qap[0].originalname
                : productDetails[0].qap_original_file_name,
            tds_new_file_name:
              req.files?.tds?.length > 0
                ? `${Config.download_url}/product_image/${req.files.tds[0].filename}`
                : productDetails[0].tds_new_file_name,
            tds_original_file_name:
              req.files?.tds?.length > 0
                ? req.files.tds[0].originalname
                : productDetails[0].tds_original_file_name
          };
    
          let product = await productModel.createProduct(productObj);
          // console.log('product ==>>>>>>>>', product);
          let productId = product.id;
          if (vendorApproveId.length > 0) {
            let productApproveArray = [];
            vendorApproveId.forEach((item) => {
              productApproveArray.push({
                product_id: productId,
                vendor_approve_id: item
              });
            });
            await productModel.addProductApproveBy(productApproveArray, productId);
          }
    
          // ---------------- categories ---------------
          // console.log(categories);
          for await (const categoryId of categories) {
            let categoryObj = {
              category_id: categoryId,
              product_id: productId
            };
            // console.log(categoryObj);
    
            await productModel.createProductCategories(categoryObj);
          }
    
          // ---------------- variations ----------------
          for await (const { attribute, attributeValue } of variations) {
            // console.log(attribute, attributeValue);
            let varientObj = {
              product_id: productId,
              variant_name: attribute,
              variant_value: attributeValue
            };
            // console.log(categoryObj);
    
            await productModel.createProductveriants(varientObj);
          }
    
          // ---------------- featured image ----------------
          if (req.files?.featured && req.files?.featured.length > 0) {
            let featuredImageObj = {
              product_id: productId,
              is_featured: 1,
              original_image_name: req.files.featured[0].originalname,
              new_image_name: `${Config.download_url}/product_image/${req.files.featured[0].filename}`
            };
            await productModel.insertProductImages(featuredImageObj);
          } else if (master_id && !req.files?.featured) {
            let featuredImage = await productModel.getProductImages(master_id, 1);
            if (featuredImage.length > 0) {
              let featuredImageObj = {
                product_id: productId,
                is_featured: 1,
                original_image_name: featuredImage[0].original_image_name || null,
                new_image_name: featuredImage[0].new_image_name || null
              };
              await productModel.insertProductImages(featuredImageObj);
            }
          }
    
          // ---------------- gallery image ----------------
          if (req.files?.gallery && req.files?.gallery.length > 0) {
            for await (const { originalname, filename } of req.files?.gallery) {
              let featuredImageObj = {
                product_id: productId,
                is_featured: 0,
                original_image_name: originalname,
                new_image_name: `${Config.download_url}/product_image/${filename}`
              };
              await productModel.insertProductImages(featuredImageObj);
            }
          } else if (master_id && !req.files?.gallery) {
            let galleryImage = await productModel.getProductImages(master_id, 0);
    
            for await (const {
              original_image_name,
              new_image_name
            } of galleryImage) {
              let featuredImageObj = {
                product_id: productId,
                is_featured: 0,
                original_image_name: original_image_name || null,
                new_image_name: new_image_name || null
              };
              await productModel.insertProductImages(featuredImageObj);
            }
          }
      }

      addDefaultNotifications(vendor[0].id);

      if (vendor[0].id) {
        let html_variables = [{ name: userDetails[0].vendor_name }];

        sendMail({
          from: Config.webmasterMail, // sender address
          to: userDetails[0].email, // list of receivers
          subject: `${buyerName} Added You on Workwise`, // Subject line
          html: `To  ${userDetails[0].vendor_name},<br><br>

          We are pleased to inform you that <Buyer Firm Name> has added you as a preferred vendor on the Workwise platform. Going forward, ${buyerName} will manage their procurement activities through Workwise. <br><br>
          To ensure you receive all enquiries promptly, please complete your registration with us. Your login credentials are provided below:<br><br>
                 <strong>Email:</strong> ${userDetails[0].email}<br>
                 <strong>Password:</strong> ${password}<br>
                 We recommend changing your password after your first login for security reasons.<br><br>
          We look forward to supporting your business growth.<br><br>
         Best regards, <br>
        The Workwise Team<br>
        <a href="https://letsworkwise.com"> https://letsworkwise.com </a>   <br>     
                 Best regards,<br>
                 The Workwise Team`
        });


        res
          .status(200)
          .json({
            status: 1,
            message: 'Vendor successfully reviewed and added to user database',
            errors:errors
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
  getBuyerPrivateVendorList: async (req, res, next) => {
    try {

      const vendorsList = await userModel.getVendorsWithBuyerNames();

      return res
        .status(200)
        .json({
          status: 1,
          data: vendorsList
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
  /*  buyerDetails: async (req, res, next) => {
    try {
      let vendorId = req.params.id;
      let vendorDetails = await vendorModel.getVendorDetails(vendorId);
      res
        .status(200)
        .json({
          status: 1,
          data: vendorDetails
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
  } */
};

const add_vendor_product= async (productDetails,vendorId) => {
  try {
    let errors = {};
    let err = 0;

    let { name, categories, approved_id, master_id } = productDetails;

    if (categories.length > 0) {
      for await (const categoryId of categories) {
        let categoryExist = await productModel.parentIdExists(categoryId);
        if (categoryExist.length == 0) {
          err++;
          errors.categories = 'Category not found';
        }
      }
    } else {
      err++;
      errors.categories = 'Please select a category';
    }

    let prodNameExists = await productModel.checkProductExists(
      name,
      vendorId,
    );
    if (prodNameExists.length > 0) {
      err++;
      errors.name = 'Product name already exist';
    }
    // if (is_approve != 1) {
    //   let checkMasterNameExist = await productModel.checkMasterNameExist(
    //     name
    //   );
    //   if (checkMasterNameExist.length > 0) {
    //     err++;
    //     errors.name = 'This product is available in master product';
    //   }
    // } else 
    if (!master_id) {
      let checkMasterNameExist = await productModel.checkMasterNameExist(
        name
      );
      if (checkMasterNameExist.length > 0) {
        err++;
        errors.name = 'This product is available in master product';
      }
    }

    if (master_id) {
      let findProduct = await productModel.check_product(master_id);
      if (findProduct.length == 0) {
        err++;
        errors.master_id = 'Product not found';
      }
    }

    if (err > 0) {
      return errors
    }

  } catch (err) {
    logError(err);
    return err;
  }
}

export default buyerController;
