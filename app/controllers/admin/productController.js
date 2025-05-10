import productModel from '../../models/productModel.js';
import vendorModel from '../../models/vendorModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';
import Config from '../../config/app.config.js';
import fs from 'fs';

import {
  logError,
  currentDateTime,
  titleToSlug,
  sendMail,
  addDefaultNotifications,
  getFileNameFromUrl
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import xlsx from 'xlsx';
import { Parser } from 'json2csv';
import excelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import rolesModel from '../../models/rolesModel.js';
import userModel from '../../models/userModel.js';
import path from 'path';
import subscriptionModel from '../../models/subscriptionModel.js';
import moment from 'moment';
import db from '../../config/dbConn.js';

const cryptr = new Cryptr(Config.cryptR.secret);

const generatePassword = (password) => {
  var salt = bcrypt.genSaltSync(10);
  var hash = bcrypt.hashSync(password, salt);
  return hash;
};

// validate bulk produts and vendor add inputs
// created by mukul jatav 11/sep/2024
const validateBulkProductVendorInputs = (value) => {
  let errors = [];

  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const isValidPhoneNumber = (phone) => {
    return phone.toString().length > 15 ? true : false;
  };

  if(!(value['Category'] || "").trim()) {
    errors.push("Product Category is missing");
  }

  if (!(value['Vendor Name'] || "").trim()) {
    errors.push('vendor name is missing');
  }

  if (!isValidEmail(value['Vendor Email'])) {
    errors.push('Invalid/missing vendor email');
  }

  const vendorContactNumber = value['Vendor company owner/hr/official contact number'] || "";
  if (!vendorContactNumber) {
    errors.push('Vendor contact number is missing');
  } else if (isValidPhoneNumber(vendorContactNumber)) {
    errors.push('Invalid vendor contact number (not more then 15 digit)');
  }

  // SPOC Fields validation (validate only if at least one of them is not empty)
  const spoc_name = value['Sales SPOC Name'] || "";
  const spoc_role = value['Sales SPOC Position/Role'] || "";
  const spoc_email = value['Sales SPOC Business Email'] || "";
  const spoc_mobile = value['Sales SPOC Mobile'] || "";

  if (spoc_email || spoc_mobile || spoc_name || spoc_role) {
  
    // Validate spoc_name if provided
    if (!spoc_name || spoc_name.trim() === '') {
      errors.push('SPOC name is missing');
    }

    // Validate spoc_email if provided and not empty
    if (!isValidEmail(spoc_email)) {
      errors.push('Invalid/Missing SPOC email');
    }

    // Validate spoc_mobile if provided and not empty
    if (spoc_mobile && isValidPhoneNumber(spoc_mobile)) {
      errors.push('Invalid/Missing SPOC Mobile');
    }
  }
  return errors;
};



const spocInputsValidation = (value) => {

  let errors = [];

  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const isValidPhoneNumber = (phone) => {
    return phone.toString().length > 15 ? true : false;
  };

  // SPOC Fields validation (validate only if at least one of them is not empty)
  const spoc_name = value['Sales SPOC Name'] || "";
  const spoc_role = value['Sales SPOC Position/Role'] || "";
  const spoc_email = value['Sales SPOC Business Email'] || "";
  const spoc_mobile = value['Sales SPOC Mobile'] || "";

  const isAnySPOCFieldNonEmpty = spoc_name || spoc_role || spoc_email || spoc_mobile;

  if (isAnySPOCFieldNonEmpty) {
    // Validate spoc_name if provided
    if (!spoc_name || spoc_name.trim() === '') {
      errors.push('SPOC name is missing');
    }

    // if (!spoc_role) {
    //   errors.push("SPOC role is missing");
    // }

    // Validate spoc_email if provided and not empty
    if (!isValidEmail(spoc_email)) {
      errors.push('Invalid/Missing SPOC email');
    }

    // Validate spoc_mobile if provided and not empty
    if (spoc_mobile && isValidPhoneNumber(spoc_mobile)) {
      errors.push('Invalid SPOC Mobile');
    }
  }

  return errors;
}


const productController = {
  productCount: async (req, res, next) => {
    try {
      // Get query parameters
      let productName = req.query?.productName;
      let vendorApprove = req.query?.vendorApprove;
      let vendorId = req.query?.vendorId;
      let isFeatured = req.query?.isFeatured;
      let filterProduct = {};
      const onlyAddedByAdmin = req.query?.onlyAddedByAdmin;
      
      if (vendorApprove) {
        filterProduct = await productModel.getApprovedByProduct(vendorApprove);
      }
      
      // Get all products for counting
      let productCount = await productModel.getProductCount(
        vendorId,
        productName,
        filterProduct,
        isFeatured,
        req.user.id
      );
      
      // Calculate counts
      const approve_count = productCount?.filter((item) => { return item.is_approve == 1 })?.length || 0;
      const total_count = productCount?.length || 0;
      const disapprove_count = total_count - approve_count;
      
      res
        .status(200)
        .json({
          status: 1,
          total_count: total_count,
          approve_count: approve_count,
          disapprove_count: disapprove_count
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
  
  createCategory: async (req, res, next) => {
    try {
      let adm_id = req.user.id;

      let { title, parent_id, slug, status } = req.body;
      if (parent_id == '' || parent_id == null || parent_id == undefined) {
        parent_id = '0';
      }
      if (slug == '' || slug == null || slug == undefined) {
        slug = titleToSlug(title);
      }

      let catObj = {
        title,
        slug,
        parent_id,
        status,
        adm_id
      };

      let category = await productModel.addCategory(catObj);
      // return false;

      if (category) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Category Added'
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
  categoryList: async (req, res, next) => {
    try {
      let page, limit, offset;
      let parent_id = req.query.parent_id; // Assign parent_id properly  
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
  
      // If parent_id is present, fetch subcategories and return response immediately
      if (parent_id) {
        let subcategories = await productModel.getSubCategory(parent_id, "");
        return res.status(200)
          .json({
            status: 1,
            data: subcategories
          })
          .end();
      }
  
      // If no parent_id, fetch main category list
      let categoryList = await productModel.getCategoryList(limit, offset);
      let categoryCount = await productModel.getCategoryListCount();
  
      res.status(200)
        .json({
          status: 1,
          data: categoryList,
          total_count: categoryCount.length
        })
        .end();
  
    } catch (error) {
      logError(error);
      res.status(400)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  categoryDropdown: async (req, res, next) => {
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

      let categoryList = await productModel.getCategoryDropdown(limit, offset);
      let categoryCount = await productModel.getCategoryListCount();
      res
        .status(200)
        .json({
          status: 1,
          data: categoryList,
          total_count: categoryCount.length
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
  deleteCategory: async (req, res, next) => {
    try {
      var cat_id = req.params.id;
      let category_id = await productModel.delete_category(cat_id);

      if (category_id) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Category deleted'
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
  categoryDetails: async (req, res, next) => {
    try {
      let categoryId = req.params.id;
      let categoryDetails = await productModel.getCategoryDetails(categoryId);
      res
        .status(200)
        .json({
          status: 1,
          data: categoryDetails
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
  updateCategory: async (req, res, next) => {
    try {
      let adm_id = req.user.id;
      let categoryId = req.params.id;

      let { title, parent_id, slug, status } = req.body;
      if (parent_id == '' || parent_id == null || parent_id == undefined) {
        parent_id = '0';
      }
      if (slug == '' || slug == null || slug == undefined) {
        slug = titleToSlug(title);
      }

      let catObj = {
        title,
        slug,
        parent_id,
        status,
        adm_id,
        categoryId
      };

      let category = await productModel.updateCategory(catObj);
      // return false;

      if (category) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Category Updated'
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
  attributeList: async (req, res, next) => {
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

      if (req.query.all == 'true') {
        offset = 0;
        limit = 'ALL';
      }

      let attributeList = await productModel.attributeList(limit, offset);
      let attributeCount = await productModel.attributeListCount();
      res
        .status(200)
        .json({
          status: 1,
          data: attributeList,
          total_count: attributeCount.count
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
  attributeDetails: async (req, res, next) => {
    try {
      let attributeID = req.params.id;

      let attributeDetails = await productModel.attributeDetails(attributeID);
      res
        .status(200)
        .json({
          status: 1,
          data: attributeDetails
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
  createAttributeValue: async (req, res, next) => {
    try {
      let adm_id = req.user.id;
      let { attribute_id, attribute_values } = req.body;
      let err = 0;

      for (let index = 0; index < attribute_values.length; index++) {
        if (attribute_values[index].id) {
          let attributeValueObj = {
            attribute_id,
            attribute_value: attribute_values[index].attribute_value,
            attribute_value_id: attribute_values[index].id,
            adm_id
          };
          let updateAttributeValue = await productModel.updateAttributeValue(
            attributeValueObj
          );
          if (!updateAttributeValue) {
            err++;
          }
        } else {
          let attributeValueObj = {
            attribute_id,
            attribute_value: attribute_values[index].attribute_value,
            adm_id
          };
          let attributeValue = await productModel.createAttributeValue(
            attributeValueObj
          );
          if (!attributeValue) {
            err++;
          }
        }
      }

      if (err > 0) {
        res
          .status(400)
          .json({
            status: 3,
            message: Config.errorText.value
          })
          .end();
      } else {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Attribute value Added'
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
  createProduct: async (req, res, next) => {
    try {
      let adm_id = req.user.id;
      let values = req.body;
      // ---------------- products ----------------
      let productObj = {
        name: values.name,
        description: values.description,
        manufacturer: values.manufacturer,
        availability: values.availability,
        slug: values.slug,
        sku: values.sku,
        created_by: adm_id,
        vendor: values.vendor,
        status: values.status
      };

      let product = await productModel.createProduct(productObj);
      // console.log('product ==>>>>>>>>', product);
      let productId = product.id;
      // ---------------- categories ---------------
      // console.log(values.categories);
      for await (const categoryId of values.categories) {
        let categoryObj = {
          category_id: categoryId,
          product_id: productId
        };
        // console.log(categoryObj);

        await productModel.createProductCategories(categoryObj);
      }

      // ---------------- variations ----------------
      for await (const { attribute, selectedValues } of values.variations) {
        console.log(attribute, selectedValues);
        let attributeObj = {
          product_id: productId,
          attribute_id: attribute
        };
        let attributeId = await productModel.createProductAttribute(
          attributeObj
        );

        const productAttributeId = attributeId.id;

        for await (const attributeValueId of selectedValues) {
          let attributeValuesObj = {
            product_attribute_id: productAttributeId,
            attribute_value_id: attributeValueId
          };
          let productAttributeValueId =
            await productModel.createProductAttributeValue(attributeValuesObj);
        }
      }

      console.log('=====>>>>>>>>>>>>>>>>', values.variationOptions);

      // ---------------- variation_options ----------------
      for await (const optValues of values.variationOptions) {
        // insert variant_options

        let variantOptionsObj = {
          title: optValues.title,
          product_id: productId,
          price: optValues.price,
          quantity: optValues.quantity,
          sku: optValues.sku,
          status: optValues.status
        };
        let productVariantOptions =
          await productModel.createProductVariantOptions(variantOptionsObj);

        const variantOptionId = productVariantOptions.id;

        let variantObj = {
          variant_option: optValues.title,
          product_id: productId,
          variant_option_id: variantOptionId
        };

        let productVariant = await productModel.createProductVariant(
          variantObj
        );

        const variantId = productVariant.id;

        for await (const attributeValueId of optValues.options) {
          let getAttributeValue = await productModel.getAttributeValue(
            attributeValueId
          );

          let attributeId = getAttributeValue[0].attribute_id;

          let getProductAttributeId = await productModel.getProductAttribute(
            attributeId,
            productId
          );
          let productAttributeId = getProductAttributeId[0].id;

          let getProductAttributeValueId =
            await productModel.getProductAttributeValue(
              productAttributeId,
              attributeValueId
            );
          let optionProductAttributeValueId = getProductAttributeValueId[0].id;
          let variantValueObj = {
            variant_id: variantId,
            product_attribute_value_id: optionProductAttributeValueId
          };
          let productVariant = await productModel.insertVariantValue(
            variantValueObj
          );
        }
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Added'
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
  productBulkUpload: async (req, res, next) => {
    try {

      // edit by mukul - 11/sep/2024
      // we will validate vendor name, email and mobile if not foun d creating an error object and include this in api response
      // Logic change: If a product is not found in our master data (i.e., products added by the admin), we will not add that product to our database.
      // not deleting just Commenting out the lines that are no longer needed

      let file = req.file;
      let adm_id = req.user.id;
      // console.log(adm_id);
      // return false;
      //userExist

      const workbook = xlsx.readFile(file.path); // Replace 'example.xlsx' with your Excel file name
      // console.log('workbook==>>>>>>>>', workbook);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      // const firstHeaderData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      // console.log('firstHeaderData==>>>>>>>>', firstHeaderData);
      // const options = {
      //   header: 1, // Treat the first row as header
      //   defval: '', // Replace undefined or null values with an empty string
      //   blankrows: false // Do not include blank rows
      // };

      // Convert sheet to JSON
      // console.log(sheet);
      let jsonData = xlsx.utils.sheet_to_json(sheet);

      // let NewProduct = false;
      let productId = 0;
      let product = 0;
      
      let previousCategory = '';

      let errorsObj = []
      let vendor_id = '';
      let vendorName = '';
      let vendorEmail = '';


      for await (const [index, value] of jsonData.entries()) {

        const productName = (value['Product Name'] || "").trim()
        const productCategory = (value['Category'] || "").trim()
        let categoryId = 0;
        let isMaster = 0;

        if (productName) {


          //  check input validatation for vendor name number and email 
          const errors = validateBulkProductVendorInputs(value);
          if (errors.length > 0) {
            const errObj = {
              vendorName: value['Vendor Name'] || null,
              vendorEmail: value['Vendor Email'] || null,
              productName: productName,
              Row: index + 1,
              errors: errors
            }
            errorsObj.push(errObj)
            continue
          }


           // check category exist in the system or not
           const catNameExists = await productModel.topParentparentNameExists(productCategory);
           if(catNameExists.length < 1){
             const errObj = {
               vendorName: value['Vendor Name'] || null,
               vendorEmail: value['Vendor Email'] || null,
               productName: productName,
               Row: index + 1,
               errors:  `${productCategory} Category does not exist`
             }
             errorsObj.push(errObj);
             continue;
           }else{
             categoryId = catNameExists[0].id;
           }


          vendorName = value['Vendor Name'];
          vendorEmail = value['Vendor Email'];
          

          // check vendor exist or not
          previousCategory = '';
          // let userExist = '';
          let vendor = '';
          let password = (value['Vendor Name'] || "").trim().replace(/\s+/g, '');
          let orgChar = password.match(/[a-zA-Z]/g).join('');
          orgChar = orgChar.toLowerCase();
          let capitalizeFourOrganizationLetter = `${orgChar
            .charAt(0)
            .toUpperCase()}${orgChar.substring(1, 4)}`;
          /* password = `${capitalizeFourOrganizationLetter}@${
            value['Vendor company owner/hr/official contact number'].length >= 8
              ? value['Vendor company owner/hr/official contact number']
                  .toString()
                  .substring(6, 10)
              : 1234
          }`; */
          password = `${capitalizeFourOrganizationLetter}@${
            value['Vendor company owner/hr/official contact number'].length < 8
              ? 1234
              : value['Vendor company owner/hr/official contact number']
                  .toString()
                  .slice(-4) // Get the last 4 digits as a string
          }`;


          let vendor_email = (value['Vendor Email'] || "").trim();

          if (vendor_email != undefined && vendor_email != '') {
            let checkState = await vendorModel.checkState(
              value['State\r\n(drop down)']
            );
            let checkCity = await vendorModel.checkCity(value['City']);
            // console.log('checkState checkCity', checkState, checkCity);
            let vendorObj = {
              name: value['Vendor Name'],
              email: vendor_email.toLowerCase(),
              organization_name: value['Vendor Name'],
              address: value['Address'] || null,
              city: checkCity.length > 0 ? checkCity[0].id : null,
              state: checkState.length > 0 ? checkState[0].id : null,
              country: 1 || null,
              mobile:
                value['Vendor company owner/hr/official contact number'] ||
                null,
              website: value['Website'] || null,
              postal_code: value['Postal Code'] || null,
              user_type: '3',
              status: '1',
              new_profile_image: value['Logo\r\n(file)'] || null
            };

            let companyObj = {
              profile: value['About Vendor Company'] || null,
              logo: value['Logo\r\n(file)'] || null,
              email: vendor_email.toLowerCase() || null,
              mobile:
                value['Vendor company owner/hr/official contact number'] ||
                null,
              company_name: value['Vendor Name'],
              nature_of_business:
                value['Nature of Business\r\n(drop down)'] || null,
              established_year: value['Established Year'] || null,
              gstin: value['GSTIN'] || null,
              import_export_code: value['Import Export Code'] || null,
              cin: value['CIN'] || null,
              turnover: value['Turn Over\r\n(dropdown)'] || null,
              no_of_employess: value['Total Number of Employees'] || null,
              project_name: value['PTR- Project Name'] || null,
              project_description: value['PTR- Project Description'] || null,
              project_start_date: value['PTR- Project Start Date'] || null,
              project_end_date: value['PTR- Project End Date'] || null
            };


            // checking vendor email and mobile both to be exist
            const userExist = await userModel.user_exist(vendor_email.toLowerCase(),value['Vendor company owner/hr/official contact number'].toString());
            
            if (userExist.length < 1) {
              vendorObj.password = generatePassword(password);
              vendor = await productModel.vendor_register(vendorObj);

              companyObj.user_id = vendor[0].id;
              await productModel.addCompany(companyObj);
              addDefaultNotifications(vendor[0].id);
              if (value['PTR (Past Track Record) (file)']) {
                const urlObject = new URL(
                  value['PTR (Past Track Record) (file)']
                );
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['PTR (Past Track Record) (file)'],
                  file_name: fileName || null,
                  doc_type: 'ptr',
                  user_id: vendor[0].id
                };
                await productModel.addFile(filesObj);
              }
              if (value['Certifications\r\n(file)']) {
                const urlObject = new URL(value['Certifications\r\n(file)']);
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['Certifications\r\n(file)'],
                  file_name: fileName || null,
                  doc_type: 'crt',
                  user_id: vendor[0].id
                };
                await productModel.addFile(filesObj);
              }
              if (value['Brochure\r\n(file']) {
                const urlObject = new URL(value['Brochure\r\n(file']);
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['Brochure\r\n(file'],
                  file_name: fileName || null,
                  doc_type: 'brochure',
                  user_id: vendor[0].id
                };
                await productModel.addFile(filesObj);
              }

              const spocList = await vendorModel.getSpocDetails(vendor[0]?.id)

              // console.log(" products contoller 815 spoc console ", vendor[0].id,  spocList)

              
      // let mailRecipients = {
      //   from: Config.webmasterMail,
      //   subject: `Work wise | Registration`,
      //   html: `Dear ${value['Vendor Name']}, Your login credential Userid: ${value['Vendor Email']} and password ${password}`
      //       };
      let mailRecipients = {
          from: Config.webmasterMail,
          subject: `Work wise | Registration`,
          html: `
              <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #333;">
                  <p>Dear <strong>${value['Vendor Name']}</strong>,</p>
                  <p>Your login credentials are as follows:</p>
                  <div style="background-color: #f9f9f9; border: 1px solid #ddd; padding: 10px; margin-top: 10px;">
                      <p><strong>User ID:</strong> ${value['Vendor Email']}</p>
                      <p><strong>Password:</strong> ${password}</p>
                  </div>
                  <p>Thank you for registering with us!</p>
              </div>
          `
      };

      if (spocList && spocList.length > 0) {
        mailRecipients.to = spocList.map(spoc => spoc.email);
        mailRecipients.cc = vendor_email.toLowerCase();
      } else {
        mailRecipients.to = vendor_email.toLowerCase();
      }

      sendMail(mailRecipients);

              // console.log('vendor-->', vendor);
              vendor_id = vendor[0].id;
              // sendMail({
              //   from: Config.webmasterMail, // sender address
              //   to: vendor_email, // list of receivers
              //   subject: `Work wise | Registration`, // Subject line
              //   // html: dynamic_html // plain text body
              //   html: `Dear ${value['Vendor Name']}, Your login credential Userid: ${value['Vendor Email']} and password ${password}`
              // });

              // let checkFreeSubscription =
              //   await subscriptionModel.checkFreeSubscription();
              // if (checkFreeSubscription.length > 0) {
              //   const startDate = moment(); // Replace with the actual start date

              //   const billingCycleMonths = checkFreeSubscription[0].duration;

              //   // Calculate the end date by adding the billing cycle and subtracting one day
              //   const endDate = startDate
              //     .clone()
              //     .add(billingCycleMonths, 'months')
              //     .subtract(1, 'day');
              //   const renewDate = startDate
              //     .clone()
              //     .add(billingCycleMonths, 'months');


              //   let UserSubscriptionObj = {
              //     user_id: vendor[0].id,
              //     plan_id: checkFreeSubscription[0].id,
              //     status: 1, //By default payment done
              //     start_date: startDate.format('YYYY-MM-DD'),
              //     end_date: endDate.format('YYYY-MM-DD'),
              //     renew_date: renewDate.format('YYYY-MM-DD')
              //   };

              //   let createUserSubscription =
              //     await subscriptionModel.createUserSubscription(
              //       UserSubscriptionObj
              //     );

              //   await subscriptionModel.updateUserSubscriptionId(
              //     checkFreeSubscription[0].id,
              //     vendor[0].id
              //   );
              //   let subscriptionMappingDetails =
              //     await subscriptionModel.getSubscriptionMappingDetails(
              //       checkFreeSubscription[0].id
              //     );

              //   for await (const {
              //     allocated_feature,
              //     feature_id
              //   } of subscriptionMappingDetails) {
              //     let userSubscriptionFeatureObj = {
              //       user_subscriptions_id: createUserSubscription.id,
              //       feature_id: feature_id,
              //       plan_id: checkFreeSubscription[0].id,
              //       used_feature_count: 0,
              //       allocated_feature: allocated_feature,
              //       user_id: vendor[0].id
              //     };
              //     await subscriptionModel.createUserSubscriptionFeature(
              //       userSubscriptionFeatureObj
              //     );
              //   }
              // }
            } else {

              vendorObj.email = userExist[0].email;
              vendorObj.mobile = userExist[0].mobile;
              companyObj.email = userExist[0].email;
              companyObj.mobile = userExist[0].mobile;
              vendor = await productModel.updateVendorDetail(vendorObj, userExist[0].id);
              companyObj.user_id = vendor[0].id;

              await productModel.updateCompany(companyObj);
              if (value['PTR (Past Track Record) (file)']) {
                const urlObject = new URL(
                  value['PTR (Past Track Record) (file)']
                );
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['PTR (Past Track Record) (file)'],
                  file_name: fileName || null,
                  doc_type: 'ptr',
                  user_id: userExist[0].id
                };
                await productModel.addFile(filesObj);
              }
              if (value['Certifications\r\n(file)']) {
                const urlObject = new URL(value['Certifications\r\n(file)']);
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['Certifications\r\n(file)'],
                  file_name: fileName || null,
                  doc_type: 'crt',
                  user_id: userExist[0].id
                };
                await productModel.addFile(filesObj);
              }
              if (value['Brochure\r\n(file']) {
                const urlObject = new URL(value['Brochure\r\n(file']);
                const pathname = urlObject.pathname;
                const fileName = path.basename(pathname);
                let filesObj = {
                  file_path: value['Brochure\r\n(file'],
                  file_name: fileName || null,
                  doc_type: 'brochure',
                  user_id: userExist[0].id
                };
                await productModel.addFile(filesObj);
              }
              // const userexist = await productModel.checkVendorExist(vendor_email.toLowerCase());
              vendor_id = userExist[0].id;
            }
          }

          let prodNameExists = await productModel.productExistForVendor(
            productName,
            vendor_id,
            productCategory
          );



          // checking whehter the product exist with the same vendor
          // console.log("............................",prodNameExists);
          if(prodNameExists.length>0){
            const errObj = {
              vendorName: value['Vendor Name'] || null,
              vendorEmail: value['Vendor Email'] || null,
              productName: productName,
              Row: index + 1,
              errors: "product already present with the vendor"
            }
            errorsObj.push(errObj);
            continue;
          }

          let productObj = '';

          let check_master_exist = await productModel.productWithCategoryExist(
            productName,
            productCategory
          );

          if (check_master_exist.length == 0) {
            const errObj = {
              vendorName: value['Vendor Name'] || null,
              vendorEmail: value['Vendor Email'] || null,
              productName: productName,
              Row: index + 1,
              errors: "Product name either not found in master database or is deleted or not approved"
            }
            errorsObj.push(errObj)
            continue
            // isMaster = 0;
          } else {

            for(let i=0;i<check_master_exist.length;i++){
              const catProductMapExist = await productModel.productCategoryIdExist(check_master_exist[i].id, categoryId);
              if(catProductMapExist.length > 0){
                isMaster = 1;
                break;
              }
            }
            
            if(isMaster !== 1){
              errorsObj.push(
                {
                  vendorName: value['Vendor Name'] || null,
                  vendorEmail: value['Vendor Email'] || null,
                  productName: productName,
                  Row: index + 1,
                  errors: `${productName} with ${productCategory} does not exist`
                }
              )
            }

          }
          // console.log('check_master_exist--->', isMaster);
          if (isMaster == 1) {
            let productDetails = await productModel.vendorProductDetails(
              check_master_exist[0].id
            );
            let productObj = {
              name: productDetails[0].name,
              description: productDetails[0].description,
              qap_new_file_name: productDetails[0].qap_new_file_name,
              qap_original_file_name: productDetails[0].qap_original_file_name,
              tds_new_file_name: productDetails[0].tds_new_file_name,
              tds_original_file_name: productDetails[0].tds_original_file_name,
              slug: titleToSlug(productDetails[0].name),
              // Changes by Agnij May 02, 2025 [Removed availability field which doesn't exist in database]
              // availability: 0,
              sku: productDetails[0].name,
              created_by: vendor_id,
              added_by: req.user.id,
              is_approve: 1,
              vendor: vendor_id
            };

            product = await productModel.createProduct(productObj);

            // ---------------- categories ---------------
            // console.log(categories);
            for await (const { id } of productDetails[0].product_categories) {
              let categoryObj = {
                category_id: id,
                product_id: product.id
              };
              // console.log(categoryObj);

              await productModel.createProductCategories(categoryObj);
            }

            for await (const {
              product_image_url,
              product_image,
              is_featured
            } of productDetails[0].product_images) {
              let featuredImageObj = {
                product_id: product.id,
                is_featured: is_featured,
                original_image_name: product_image,
                new_image_name: product_image_url
              };
              await productModel.insertProductImages(featuredImageObj);
            }
          }

          // if (
          //   prodNameExists &&
          //   prodNameExists.length == 0 &&
          //   vendor_id &&
          //   isMaster == 0
          // ) {
          //   productObj = {
          //     name: productName,
          //     description: value['Product description'] || null,
          //     manufacturer: value['Manufacturer'] || null,
          //     availability:
          //       value['Product Availability'] == 'Available' ? 1 : 0,
          //     slug: titleToSlug(productName),
          //     sku: productName,
          //     // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
          //     status: 1,
          //     created_by: vendor_id,
          //     vendor: vendor_id,
          //     is_review: 1,
          //     added_by: adm_id,
          //     is_approve: 1,
          //     brochure_file: value['Product Brochure\r\n(file)'] || null
          //   };
          //   product = await productModel.createProduct(productObj);


          //   //  await productModel.createProduct(productObj);
          // } else if (vendor_id && isMaster == 0) {


          //   productObj = {
          //     description: value['Product description'] || null,
          //     manufacturer: value['Manufacturer'] || null,
          //     availability:
          //       value['Product Availability'] == 'Available' ? 1 : 0,
          //     slug: titleToSlug(productName),
          //     sku: productName,
          //     // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
          //     status: 1,
          //     created_by: vendor_id,
          //     vendor: vendor_id,
          //     is_review: prodNameExists[0].is_review,
          //     is_approve: prodNameExists[0].is_approve,
          //     brochure_file:
          //       value['Product Brochure\r\n(file)'] ||
          //       prodNameExists[0].brochure_file
          //   };

          //   product = await productModel.updateProduct(
          //     productObj,
          //     prodNameExists[0].id
          //   );
          //   // console.log('product===============>>>>>>>>>>>>', product);
          //   //After update product mappings are deleted
          //   // Delete variants
          //   await productModel.deleteProductVariants(prodNameExists[0].id);
          //   // Delete product category
          //   await productModel.deleteProductCategory(prodNameExists[0].id);
          //   // delete product approved by
          //   await productModel.deleteProductApproveBy(prodNameExists[0].id);

          // }

          // console.log('product ==>>>>>>>>', product);
          productId = product.id;

        }
        // console.log('productId ==>>>>>>>>', productId);
        if (productId > 0) {
          if (value['Specification Key'] && value['Specification Value']) {
            let varientObj = {
              product_id: productId,
              variant_name: value['Specification Key'],
              variant_value: value['Specification Value']
            };
            // console.log(categoryObj);

            await productModel.createProductveriants(varientObj);
          }

          //return false;
          // if (value['Category'] && isMaster == 0) {
          //   let catNameExists = [];
          //   if (previousCategory) {
          //     catNameExists = await productModel.topParentparentCatExists(
          //       value['Category'],
          //       previousCategory
          //     );
          //   } else {
          //     catNameExists = await productModel.topParentparentNameExists(
          //       value['Category']
          //     );
          //   }
          //   console.log(catNameExists);
          //   let category_id = '';
          //   if (catNameExists.length > 0) {
          //     category_id = { id: catNameExists[0].id };
          //   } else {
          //     console.log('test--->', value['Category']);
          //     //  return false;
          //     let catObj = {
          //       title: value['Category'],
          //       parent_id: previousCategory || '0',
          //       slug:
          //         value['Category'] == undefined
          //           ? ''
          //           : titleToSlug(value['Category']),
          //       status: '1',
          //       adm_id: adm_id
          //     };
          //     category_id = await productModel.addCategory(catObj);
          //     // console.log('category_id--', category_id);
          //     // return false;
          //   }
          //   previousCategory = category_id.id;
          //   let categoryObj = {
          //     product_id: productId,
          //     category_name: value['Category'],
          //     category_id: category_id.id
          //   };
          //   await productModel.createProductCategory(categoryObj);
          // }

          // creating spoc object with user_id of the vendor
          let spocObj = {
            spoc_name: value['Sales SPOC Name'] || null,
            spoc_role: value['Sales SPOC Position/Role'] || null,
            spoc_email: value['Sales SPOC Business Email']?.toLowerCase() || null,
            spoc_mobile: value['Sales SPOC Mobile'] || null,
          }

          // you can apply logic of spoc here, because it even run on if there is no product name & only approved by column
          // adding spoc data only when atleast one of the below data is empty
          if (spocObj.spoc_email || spocObj.spoc_mobile || spocObj.spoc_name || spocObj.spoc_role) {

            const errors = spocInputsValidation(value);
            if (errors.length > 0) {
              const errObj = {
                vendorName: vendorName,
                vendorEmail: vendorEmail,
                productName: productName,
                Row: index + 1,
                errors: errors
              }
              errorsObj.push(errObj)
              continue;
            } else {
              spocObj.user_id = vendor_id;

              // adding the vendor id to the spocObj object
              spocObj.spoc_mobile = spocObj.spoc_mobile?.toString();

              // check for exactly same input existence
              const response = await userModel.check_exactly_same_spoc(spocObj);

              if (response.length < 1) {
                // now inserting the details of the spocObj to the table
                await userModel.add_user_spoc(spocObj);
              }
            }

          }


          if (value['Vendor Approved By']) {
            // let vendorApproveArray = [value['Vendor Approved By']];
            let vendorApproveArray = value['Vendor Approved By']?.split(',');
            let vendorApproveArrayId = [];
            for (let index = 0; index < vendorApproveArray.length; index++) {
              const element = vendorApproveArray[index];
              let vendorApproveId = 0;
              let findVendorApprove =
                await vendorapproveModel.findVendorApproveBulkByName(element);
              // console.log('findVendorApprove--->', findVendorApprove);
              if (findVendorApprove.length == 0) {
                let vendorApproveObj = {
                  vendor_approve: element,
                  status: 0
                };
                let createVendorApprove =
                  await vendorapproveModel.createVendorApprove(
                    vendorApproveObj
                  );
                vendorApproveId = createVendorApprove.id;
              } else {
                vendorApproveId = findVendorApprove[0].id;
              }
              vendorApproveArrayId.push({
                product_id: productId,
                vendor_approve_id: vendorApproveId
              });
            }
            // console.log('vendorApproveArrayId ==>>>>>', vendorApproveArrayId);
            await productModel.addProductApproveBy(
              vendorApproveArrayId,
              productId
            );
          }
        }
      }

      // check if all row are failed in our validation
      if (errorsObj.length === jsonData.length) {
        return res
          .status(400)
          .json({
            status: 3,
            message: "All rows have validation errors. Please check your data and try again.",
            errorsObj: errorsObj
          })
          .end();
        // Exit early if every row has an error
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Added',
          errorsObj: errorsObj
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
  /**
   * Handles the bulk upload of products from an Excel file.
   *
   * This function reads an Excel file, parses the data, and creates or updates products in the database based on the data in the file.
   * It supports creating new products, updating existing products, and managing vendor approvals, product images, and categories.
   *
   * @param {Object} req - The HTTP request object.
   * @param {Object} res - The HTTP response object.
   * @param {Function} next - The next middleware function.
   * @returns {Promise<void>} - A Promise that resolves when the operation is complete.
   */
  // onlyProductBulkUpload: async (req, res, next) => {
  //   try {
  //     let file = req.file;
  //     // return false;
  //     //userExist

  //     const excelHeaders = [
  //       'Product Name',
  //       'Vendor Approved By',
  //       'Category',
  //       'Product\r\nDescription',
  //       'Product Featured Image\r\n(file)',
  //       'Product Images\r\n(file)',
  //       'Product Brochure\r\n(file)',
  //       'Product QAP\r\n(file)',
  //       'Product TDS\r\n(file)'
  //     ];

  //     const workbook = xlsx.readFile(file.path); // Replace 'example.xlsx' with your Excel file name
  //     // console.log('workbook==>>>>>>>>', workbook);
  //     const sheetName = workbook.SheetNames[0];
  //     const sheet = workbook.Sheets[sheetName];
  //     const firstHeaderData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  //     /*  let headerCheck = await arraysHaveSameData(
  //       excelHeaders,
  //       firstHeaderData[0]
  //     ); */
  //     // console.log('headerCheck====', headerCheck);
  //     // console.log(excelHeaders, firstHeaderData[0]);
  //     /* if (!headerCheck) {
  //       err++;
  //       errors.message = 'Download the sample Excel and check all column name';
  //     } */

  //     // const options = {
  //     //   header: 1, // Treat the first row as header
  //     //   defval: '', // Replace undefined or null values with an empty string
  //     //   blankrows: false // Do not include blank rows
  //     // };

  //     // Convert sheet to JSON
  //     // console.log(sheet);
  //     const jsonData = xlsx.utils.sheet_to_json(sheet);

  //     // console.log(jsonData);
  //     // return false;

  //     // let NewProduct = false;
  //     let productId = 0;
  //     let productArray = [];
  //     let previousProductId = 0;
  //     let categoryCount = 0;
  //     let product = 0;
  //     let vendor_id = null;
  //     let errors = [];

  //     for await (const [index, value] of jsonData.entries()) {

  //       //  Error handling for the product name and category

  //       const productName = (value['Product Name'] || "").trim()
  //       const productCategory = (value['Category'] || "").trim();

  //       // this is the first row
  //       if (productName) {
  //         // check vendor exist or not

  //         let prodNameExists = await productModel.checkProductExists(
  //           productName,
  //           // category,
  //           null,
  //           null,
  //           req.user.id
  //         );
  //         // console.log('prodNameExists--->', prodNameExists);
  //         // return false;
  //         let productObj = '';

  //         if (prodNameExists && prodNameExists.length == 0) {
  //           productObj = {
  //             name: productName,
  //             description: value['Product\r\nDescription'] || null,
  //             manufacturer: value['Manufacturer'] || null,
  //             availability:
  //               value['Product Availability'] == 'Available' ? 1 : 0,
  //             slug: titleToSlug(productName),
  //             sku: productName,
  //             // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
  //             status: 1,
  //             created_by: req.user.id,
  //             vendor: null,
  //             is_review: 1,
  //             is_approve: 0,
  //             added_by: req.user.id,
  //             brochure_file: value['Product Brochure\r\n(file)'] || null,
  //             qap_new_file_name: value['Product QAP\r\n(file)'] || null,
  //             qap_original_file_name: value['Product QAP\r\n(file)']
  //               ? await getFileNameFromUrl(value['Product QAP\r\n(file)'])
  //               : null,
  //             tds_new_file_name: value['Product TDS\r\n(file)'] || null,
  //             tds_original_file_name: value['Product TDS\r\n(file)']
  //               ? await getFileNameFromUrl(value['Product TDS\r\n(file)'])
  //               : null
  //           };
  //           product = await productModel.createProduct(productObj);

  //           // if (value['Vendor Approved By']) {
  //           //   // let vendorApproveArray = value['Vendor Approved By'].split(',');
  //           //   let vendorApproveArray = [value['Vendor Approved By']];
  //           //   let vendorApproveArrayId = [];
  //           //   for (let index = 0; index < vendorApproveArray.length; index++) {
  //           //     const element = vendorApproveArray[index];
  //           //     let vendorApproveId = 0;
  //           //     let findVendorApprove =
  //           //       await vendorapproveModel.findVendorApproveByName(element);
  //           //     if (findVendorApprove.length == 0) {
  //           //       let vendorApproveObj = {
  //           //         vendor_approve: element,
  //           //         status: 1
  //           //       };
  //           //       let createVendorApprove =
  //           //         await vendorapproveModel.createVendorApprove(
  //           //           vendorApproveObj
  //           //         );
  //           //       vendorApproveId = createVendorApprove.id;
  //           //     } else {
  //           //       vendorApproveId = findVendorApprove[0].id;
  //           //     }
  //           //     vendorApproveArrayId.push({
  //           //       product_id: product.id,
  //           //       vendor_approve_id: vendorApproveId
  //           //     });
  //           //   }
  //           //   await productModel.addProductApproveBy(
  //           //     vendorApproveArrayId,
  //           //     product.id
  //           //   );
  //           // }

  //           //  await productModel.createProduct(productObj);
  //         } else {

  //           // productObj = {
  //           //   description: value['Product\r\nDescription'] || null,
  //           //   manufacturer: value['Manufacturer'] || null,
  //           //   availability:
  //           //     value['Product Availability'] == 'Available' ? 1 : 0,
  //           //   slug: titleToSlug(productName),
  //           //   sku: productName,
  //           //   // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
  //           //   status: 1,
  //           //   created_by: prodNameExists[0].created_by,
  //           //   vendor: vendor_id || prodNameExists[0].vendor,
  //           //   is_review: prodNameExists[0].is_review,
  //           //   is_approve: prodNameExists[0].is_approve,
  //           //   brochure_file:
  //           //     value['Product Brochure\r\n(file)'] ||
  //           //     prodNameExists[0].brochure_file,
  //           //   qap_new_file_name:
  //           //     value['Product QAP\r\n(file)'] ||
  //           //     prodNameExists[0].qap_new_file_name,
  //           //   qap_original_file_name: value['Product QAP\r\n(file)']
  //           //     ? await getFileNameFromUrl(value['Product QAP\r\n(file)'])
  //           //     : prodNameExists[0].qap_original_file_name,
  //           //   tds_new_file_name:
  //           //     value['Product TDS\r\n(file)'] ||
  //           //     prodNameExists[0].tds_new_file_name,
  //           //   tds_original_file_name: value['Product TDS\r\n(file)']
  //           //     ? await getFileNameFromUrl(value['Product TDS\r\n(file)'])
  //           //     : prodNameExists[0].tds_new_file_name
  //           // };
  //           // product = await productModel.updateProduct(
  //           //   productObj,
  //           //   prodNameExists[0].id
  //           // );
  //           // //After update product mappings are deleted
  //           // // delete product approved by

  //           // if (value['Vendor Approved By']) {
  //           //   await productModel.deleteProductApproveBy(prodNameExists[0].id);
  //           //   // let vendorApproveArray = value['Vendor Approved By'].split(',');
  //           //   let vendorApproveArray = [value['Vendor Approved By']];
  //           //   let vendorApproveArrayId = [];
  //           //   for (let index = 0; index < vendorApproveArray.length; index++) {
  //           //     const element = vendorApproveArray[index];
  //           //     let vendorApproveId = 0;
  //           //     let findVendorApprove =
  //           //       await vendorapproveModel.findVendorApproveByName(element);
  //           //     if (findVendorApprove.length == 0) {
  //           //       let vendorApproveObj = {
  //           //         vendor_approve: element,
  //           //         status: 1
  //           //       };
  //           //       let createVendorApprove =
  //           //         await vendorapproveModel.createVendorApprove(
  //           //           vendorApproveObj
  //           //         );
  //           //       vendorApproveId = createVendorApprove.id;
  //           //     } else {
  //           //       vendorApproveId = findVendorApprove[0].id;
  //           //     }
  //           //     vendorApproveArrayId.push({
  //           //       product_id: prodNameExists[0].id,
  //           //       vendor_approve_id: vendorApproveId
  //           //     });
  //           //   }
  //           //   await productModel.addProductApproveBy(
  //           //     vendorApproveArrayId,
  //           //     prodNameExists[0].id
  //           //   );
  //           // }

  //           product = prodNameExists[0].id
  //         }

  //         // console.log('product ==>>>>>>>>', product);
  //         productId = product;
  //         if (value['Product Images\r\n(file)']) {
  //           let galleryImage = await productModel.getProductImages(
  //             productId,
  //             0
  //           );
  //           if (galleryImage.length > 0) {
  //             for await (const { new_image_name, id } of galleryImage) {
  //               await productModel.deleteProductImages(productId, 0, id);
  //             }
  //           }
  //         }

  //         // if (productCategory) {
  //         //   await productModel.deleteProductCategory(productId);
  //         // }
  //       }




  //       if (productId > 0) {
  //         // Delete variants
  //         await productModel.deleteProductVariants(productId);
  //         if (value['Specification Key'] && value['Specification Value']) {
  //           let varientObj = {
  //             product_id: productId,
  //             variant_name: value['Specification Key'],
  //             variant_value: value['Specification Value']
  //           };
  //           // console.log(categoryObj);

  //           await productModel.createProductveriants(varientObj);
  //         }

  //         //approve by
  //         if (value['Vendor Approved By']) {
  //           // let vendorApproveArray = value['Vendor Approved By'].split(',');
  //           let vendorApproveArray = [value['Vendor Approved By']];
  //           let vendorApproveArrayId = [];
  //           for (let index = 0; index < vendorApproveArray.length; index++) {
  //             const element = vendorApproveArray[index];
  //             let vendorApproveId = 0;
  //             let findVendorApprove =
  //               await vendorapproveModel.findVendorApproveByName(element);
  //             if (findVendorApprove.length == 0) {
  //               let vendorApproveObj = {
  //                 vendor_approve: element,
  //                 status: 1
  //               };
  //               let createVendorApprove =
  //                 await vendorapproveModel.createVendorApprove(
  //                   vendorApproveObj
  //                 );
  //               vendorApproveId = createVendorApprove.id;
  //             } else {
  //               vendorApproveId = findVendorApprove[0].id;
  //             }
  //             vendorApproveArrayId.push({
  //               product_id: productId,
  //               vendor_approve_id: vendorApproveId
  //             });
  //           }
  //           await productModel.addProductApproveBy(
  //             vendorApproveArrayId,
  //             productId
  //           );
  //         }

  //         //return false;
  //         if (value['Category']) {
  //           let catNameExists = await productModel.topParentparentNameExists(
  //             value['Category']
  //           );
  //           // console.log(catNameExists);
  //           let category_id = '';
  //           if (catNameExists.length > 0) {
  //             category_id = { id: catNameExists[0].id };
  //           } else {
  //             // console.log('test--->', value['Category']);
  //             //  return false;
  //             let catObj = {
  //               title: value['Category'],
  //               parent_id: '0',
  //               slug:
  //                 value['Category'] == undefined
  //                   ? ''
  //                   : titleToSlug(value['Category']),
  //               status: '1',
  //               adm_id: req.user.id
  //             };
  //             category_id = await productModel.addCategory(catObj);
  //             // console.log('category_id--', category_id);
  //             // return false;
  //           }
  //           // Delete product category
  //           let categoryObj = {
  //             product_id: productId,
  //             category_name: value['Category'],
  //             category_id: category_id.id
  //           };
  //           await productModel.createProductCategory(categoryObj);
  //         }

  //         if (value['Product Featured Image\r\n(file)']) {
  //           let featuredImage = await productModel.getProductImages(
  //             productId,
  //             1
  //           );
  //           if (featuredImage.length > 0) {
  //             await productModel.deleteProductImages(
  //               productId,
  //               1,
  //               featuredImage[0].id
  //             );
  //           }

  //           let featuredImageObj = {
  //             product_id: productId,
  //             is_featured: 1,
  //             original_image_name: value['Product Featured Image\r\n(file)']
  //               ? await getFileNameFromUrl(
  //                 value['Product Featured Image\r\n(file)']
  //               )
  //               : null,
  //             new_image_name: value['Product Featured Image\r\n(file)'] || null
  //           };
  //           await productModel.insertProductImages(featuredImageObj);
  //         }
  //         if (value['Product Images\r\n(file)']) {
  //           let featuredImageObj = {
  //             product_id: productId,
  //             is_featured: 0,
  //             original_image_name: value['Product Images\r\n(file)']
  //               ? await getFileNameFromUrl(value['Product Images\r\n(file)'])
  //               : null,
  //             new_image_name: value['Product Images\r\n(file)'] || null
  //           };
  //           await productModel.insertProductImages(featuredImageObj);
  //         }
  //       }
  //     }

  //     res
  //       .status(200)
  //       .json({
  //         status: 1,
  //         message: errors.length > 0 ? 'Partially Added' : 'Product Added',
  //         errors: errors
  //       })
  //       .end();
  //   } catch (err) {
  //     logError(err);
  //     res
  //       .status(400)
  //       .json({
  //         status: 3,
  //         message: Config.errorText.value
  //       })
  //       .end();
  //   }
  // },


  // controller for adding only product using excel

  onlyProductBulkUpload: async (req, res, next) => {
    try {

      let file = req.file;
      const workbook = xlsx.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const firstHeaderData = xlsx.utils.sheet_to_json(sheet, { header: 1 });

      const jsonData = xlsx.utils.sheet_to_json(sheet);

      let errors = [];

      let productError = false;
      let prodObj = { category: [],
        name: "",
        productId: null,
      };


      for (const [index, value] of jsonData.entries()) {
        const productName = (value['Product Name'] || "").trim();
        const productCategory = (value['Category'] || "").trim();

        if (productName && productCategory) {
          // when Product Name founds in a row
          if (prodObj.name != "" && !productError) {
              // means we have to add previous prodObj which do not have error 
              if(prodObj.productId == null ){
                // means new product
                const product = await productModel.createProduct(prodObj.newProduct);
                prodObj.productId = product.id;
              }

              // now map the product with all categories
              for await (const value of prodObj.category){
                let categoryObj = {
                    product_id: prodObj.productId,
                    category_name: value.title,
                    category_id: value.id
                  };
                  await productModel.createProductCategory(categoryObj);
              }
        
          }
          // Also check for product name exist or not afterwards 
          let prodNameExists  = await productModel.productWithCategoryExist(productName, productCategory);

          if (prodNameExists && prodNameExists.length == 0) {
            const productObj = {
              name: productName,
              description: value['Product\r\nDescription'] || null,
              manufacturer: value['Manufacturer'] || null,
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(productName),
              sku: productName,
              // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
              status: 1,
              created_by: 1,
              vendor: null,
              is_review: 1,
              is_approve: 0,
              added_by: 1,
              brochure_file: value['Product Brochure\r\n(file)'] || null,
              qap_new_file_name: value['Product QAP\r\n(file)'] || null,
              qap_original_file_name: value['Product QAP\r\n(file)']
                ? await getFileNameFromUrl(value['Product QAP\r\n(file)'])
                : null,
              tds_new_file_name: value['Product TDS\r\n(file)'] || null,
              tds_original_file_name: value['Product TDS\r\n(file)']
                ? await getFileNameFromUrl(value['Product TDS\r\n(file)'])
                : null
            };
            prodObj.newProduct = productObj;
          } else {
             // category does not exist
             productError = true;
             const err = {
               Row: index + 2,
               error: `Product ${productName} already exist`
             }
             errors.push(err);
             prodObj = {
               category: [],
               name: "",
               productId: null,
             };
             continue;
            // prodObj.productId = prodNameExists[0].id;
            // prodObj.newProduct = prodNameExists[0];
          }

          prodObj.category = [],
          prodObj.name = productName;
          productError = false;
          prodObj.productId=null;
          
          
          // first validation for the category
          const catNameExists = await productModel.topParentparentNameExists(productCategory);
          if (catNameExists < 1) {
            // category does not exist
            productError = true;
            const err = {
              Row: index + 2,
              error: `Category ${productCategory} does not exist`
            }
            errors.push(err);
            prodObj = {
              category: [],
              name: "",
              productId: null,
            };
            continue;

          } else {
              prodObj.category.push(catNameExists[0]);
          }
        } else if (productCategory && prodObj.name && !productError) {
          // when there is no Product Name 
          // now check whether there is category exist and 
          // there should no product error i.e. productError = false
          const catNameExists = await productModel.topParentparentNameExists(productCategory);
          if (catNameExists < 1) {
            // category does not exist
            productError = true;
            const err = {
              Row: index + 2,
              error: `Category ${productCategory} does not exist`
            }
            errors.push(err);
            prodObj = {
              category: [],
              name: "",
              productId: null,
            };
            continue;
          } else {
              prodObj.category.push(catNameExists[0]);
          }

        } else if (productCategory && productError) {
          continue;
        } else {
          // case where productCategory having black space 
          productError = true;
          const err = {
            Row: index + 2,
            error: "Category is Missing"
          }
          errors.push(err);
          prodObj = {
            category: [],
            name: "",
            productId: null,
          };
        }
      }

      // final product object to be executed here

      if(!productError){
        //means last product name does not have any error, now to be inserted
        if(prodObj.productId == null ){
          // means new product
          const product = await productModel.createProduct(prodObj.newProduct);
          prodObj.productId = product.id;
        }

        // now map the product with all categories
        for await (const value of prodObj.category){
          let categoryObj = {
              product_id: prodObj.productId,
              category_name: value.title,
              category_id: value.id
            };
            await productModel.createProductCategory(categoryObj);
        }
      }

      res
        .status(200)
        .json({
          status:1,
          message: errors.length>0 ? "Partially Product Added" : "All Product Added",
          errors:errors
        })

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
  mapVendorWithProduct: async (req, res, next) => {
    try {
      const { product_id, vendor_id, approved_by } = req.body;

      const product = await productModel.vendorProductDetails(product_id);
      const vendor = await vendorModel.getVendorDetails(vendor_id);

      if (!vendor) {
        return res
          .status(404)
          .json({
            status: 3,
            message: "Vendor not found, Please check and retry."
          })
          .end()
      }

      const prodAlreadyExists = await productModel.productExistForVendor(
        product[0]?.name,
        vendor_id,
        product[0]?.product_categories[0]?.category_name);

      if (prodAlreadyExists.length > 0) {
        return res
          .status(409)
          .json({
            status: 3,
            message: "Product is already added with the Vendor."
          })
          .end()
      }

      const productObj = {
        name: product[0].name,
        description: product[0].description || "",
        qap_new_file_name: product[0].qap_new_file_name || null,
        qap_original_file_name: product[0].qap_original_file_name || null,
        tds_new_file_name: product[0].tds_new_file_name || null,
        tds_original_file_name: product[0].tds_original_file_name || null,
        slug: titleToSlug(product[0].name),
        availability: 1,
        sku: product[0].name,
        created_by: vendor_id,
        added_by: req.user.id,
        is_approve: 0,
        vendor: vendor_id
      };

      const mappedProduct = await productModel.createProduct(productObj);

      // ---------------- Categories ---------------
      for (const { id } of product[0].product_categories) {
        await productModel.createProductCategories(id, mappedProduct.id);
      }

      // ---------------- Approved By -----------------
      if (approved_by && approved_by.length > 0) {
        let approvedIdArray = [];
        for (const approved_id of approved_by) {
          approvedIdArray.push({
            product_id,
            vendor_approve_id: approved_id
          })
        };
        await productModel.addProductApproveBy(approvedIdArray);
      }

      // ---------------- Featured Image Section -----------------
      for await (const { product_image_url, product_image, is_featured } of product[0].product_images) {
        let featuredImageObj = {
          product_id: mappedProduct.id,
          is_featured: is_featured,
          original_image_name: product_image,
          new_image_name: product_image_url
        };
        await productModel.insertProductImages(featuredImageObj);
      }

      return res
        .status(200)
        .json({
          status: 1,
          message: `${vendor[0]?.name} is successfully mapped with ${product[0]?.name}`
        })
        .end()

    } catch (error) {
      logError(error);
      res
        .status(500)
        .json({
          status: 3,
          message: Config.errorText.value
        })
        .end();
    }
  },
  bulkProductUploadPreview: async (req, res, next) => {
    try {
      let file = req.file;
      var adm_id = req.user.id;
      // console.log(adm_id);
      // return false;

      const workbook = xlsx.readFile(file.path); // Replace 'example.xlsx' with your Excel file name
      // console.log('workbook==>>>>>>>>', workbook);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // const options = {
      //   header: 1, // Treat the first row as header
      //   defval: '', // Replace undefined or null values with an empty string
      //   blankrows: false // Do not include blank rows
      // };

      // Convert sheet to JSON
      //      //      // console.log(sheet);
      const jsonData = xlsx.utils.sheet_to_json(sheet);

      console.log(jsonData);
      return false;

      // let NewProduct = false;
      let productId = 0;
      let product = 0;

      for await (const [index, value] of jsonData.entries()) {
        // console.log('product==========>>>>>>>>', index, value);
        if (value['Product name']) {
          let prodNameExists = await productModel.checkProductExists(
            value['Product name']
          );
          let productObj = '';
          if (prodNameExists && prodNameExists.length == 0) {
            productObj = {
              name: value['Product name'],
              description: value['Product description'],
              manufacturer: value['Manufacturer'],
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product name']),
              sku: value['Product name'],
              vendor_approved_by: value['Vendor Approved By'],
              status: 1,
              created_by: req.user.id
            };
            product = await productModel.createProduct(productObj);
          } else {
            productObj = {
              description: value['Product description'],
              manufacturer: value['Manufacturer'],
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product name']),
              sku: value['Product name'],
              vendor_approved_by: value['Vendor Approved By'],
              status: 1,
              created_by: req.user.id,
              product_id: prodNameExists[0].id
            };
            product = await productModel.updateProduct(productObj);
          }

          // console.log('product ==>>>>>>>>', product);
          productId = product.id;

          // if (value['Specification Key'] && value['Specification Value']) {
          //   let varientObj = {
          //     product_id: productId,
          //     variant_name: value['Specification Key'],
          //     variant_value: value['Specification Value']
          //   };
          //   // console.log(categoryObj);

          //   await productModel.createProductveriants(varientObj);
          // }

          // if (value['Category']) {
          //   let categoryObj = {
          //     product_id: productId,
          //     category_name: value['Category']
          //   };
          //   await productModel.createProductCategory(categoryObj);
          // }
        }

        if (productId > 0) {
          if (value['Specification Key'] && value['Specification Value']) {
            let varientObj = {
              product_id: productId,
              variant_name: value['Specification Key'],
              variant_value: value['Specification Value']
            };
            // console.log(categoryObj);

            await productModel.createProductveriants(varientObj);
          }
          let catNameExists = await productModel.topParentparentNameExists(
            value['Category']
          );
          console.log(catNameExists);
          let category_id = '';
          if (catNameExists.length > 0) {
            category_id = catNameExists[0].id;
          } else {
            let catObj = {
              title: value['Category'],
              parent_id: '0',
              slug: titleToSlug(value['Category']),
              status: '1',
              adm_id: adm_id
            };
            category_id = await productModel.addCategory(catObj);
            // console.log('category_id--', category_id);
            // return false;
          }
          //return false;
          if (value['Category']) {
            let categoryObj = {
              product_id: productId,
              category_name: value['Category'],
              category_id: category_id.id
            };
            await productModel.createProductCategory(categoryObj);
          }
        }
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Added'
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
  productListImproved: async (req, res) => {
    try {
      const {
        productName,
        vendorApprove,
        vendorId,
        isFeatured,
        categoryId,
        addedBy,
        dateFrom,
        dateTo,
        is_approve,
        page,
        limit,
      } = req.query;

      const filters = {
        productName,
        vendorApprove,
        vendorId,
        isFeatured,
        categoryId,
        addedBy,
        dateFrom,
        dateTo,
        is_approve,
      };

      const result = await productModel.getMasterProductsPaginated(
        filters,
        page,
        limit
      );

      const responsePayload = {
        status: 1,
        // data: result.data || [],
        // pagination: result.pagination || { total: 0, page: page, limit: limit, pages: 1 } // Ensure pagination object exists
        ...result
      };
      
      res.status(200).json(responsePayload).end();

    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Failed to search product',
        error: error.message
      });
    }
  },
  adminProductListReview: async (req, res, next) => {
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

      let productName = req.query?.productName;
      let vendorApprove = req.query?.vendorApprove;
      let filterProduct = {};
      if (vendorApprove) {
        filterProduct = await productModel.getApprovedByProduct(vendorApprove);
      }
      let vendorId = req.query?.vendorId;

      let productList = await productModel.adminProductListReview(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct
      );
      let productCount = await productModel.getAdminProductListReviewCount(
        vendorId,
        productName,
        filterProduct
      );
      res
        .status(200)
        .json({
          status: 1,
          data: productList,
          total_count: productCount.length
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
  adminProductAcceptReview: async (req, res, next) => {
    try {
      let { products, all } = req.body;
      if (all == true) {
        // let acceptReviewObj = {
        //   is_review: 0,
        //   updated_by: req.user.id
        // };
        res
        .status(500)
        .json({
          status: 1,
          message: 'Select the list of products you want to approve'
        })
        .end();
        // await productModel.adminProductAcceptReview(acceptReviewObj);
      } 
      else {
        for await (const productId of products) {
          let acceptReviewObj = {
            is_review: 0,
            updated_by: req.user.id
          };
          await productModel.adminProductAcceptReview(
            acceptReviewObj,
            productId
          );
        }
      }

      // for await (const productId of products) {
      //   let productDetails = await productModel.vendorProductDetails(productId);

      //   let checkMasterNameExist = await productModel.checkMasterNameExist(
      //     productDetails[0].name
      //   );
      //   if (checkMasterNameExist.length == 0 && status == 1) {
      //     let productObj = {
      //       name: productDetails[0].name,
      //       description: productDetails[0].description,
      //       qap_new_file_name: productDetails[0].qap_new_file_name,
      //       qap_original_file_name: productDetails[0].qap_original_file_name,
      //       tds_new_file_name: productDetails[0].tds_new_file_name,
      //       tds_original_file_name: productDetails[0].tds_original_file_name,
      //       slug: titleToSlug(productDetails[0].name),
      //       availability: 0,
      //       sku: productDetails[0].name,
      //       created_by: 1,
      //       updated_by: 1,
      //       added_by: 1,
      //       is_approve: 1
      //     };

      //     let product = await productModel.createProduct(productObj);

      //     if (productDetails[0].vendor_approved_by.length > 0) {
      //       let productApproveArray = [];
      //       productDetails[0].vendor_approved_by.forEach((item) => {
      //         productApproveArray.push({
      //           product_id: product.id,
      //           vendor_approve_id: item
      //         });
      //       });
      //       await productModel.addProductApproveBy(
      //         productApproveArray,
      //         product.id
      //       );
      //     }

      //     // ---------------- categories ---------------
      //     // console.log(categories);
      //     for await (const { id } of productDetails[0].product_categories) {
      //       let categoryObj = {
      //         category_id: id,
      //         product_id: product.id
      //       };
      //       // console.log(categoryObj);

      //       await productModel.createProductCategories(categoryObj);
      //     }

      //     for await (const {
      //       product_image_url,
      //       product_image,
      //       is_featured
      //     } of productDetails[0].product_images) {
      //       let featuredImageObj = {
      //         product_id: product.id,
      //         is_featured: is_featured,
      //         original_image_name: product_image,
      //         new_image_name: product_image_url
      //       };
      //       await productModel.insertProductImages(featuredImageObj);
      //     }
      //   }
      // }
      res
        .status(200)
        .json({
          status: 1,
          message: 'Review completed. Product added to product list'
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
  exportProducts: async (req, res, next) => {
    try {
      const { product_id } = req.body;

      let prodList = await productModel.getExportProductList(product_id);
      const workbook = new excelJS.Workbook(); // Create a new workbook
      const worksheet = workbook.addWorksheet('Products'); // New Worksheet
      // const path = './files'; // Path to download excel
      const path = `${Config.upload.product_export}`; // Path to download excel
      worksheet.columns = [
        { header: 'S no.', key: 's_no', width: 5 },
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Manufacturer', key: 'manufacturer', width: 20 },
        // { header: 'Slug', key: 'slug', width: 20 },
        { header: 'Category', key: 'category', width: 20 },
        { header: 'Specification Key', key: 'specification_Key', width: 20 },
        {
          header: 'Specification Value',
          key: 'specification_value',
          width: 20
        },
        { header: 'Approved By', key: 'vendor_approve', width: 20 },
        { header: 'Availability', key: 'availability', width: 20 },
        { header: 'Status', key: 'status', width: 20 }
      ];

      // Looping through User data
      let counter = 1;

      prodList.forEach((prod) => {
        prod.s_no = counter;
        prod.availability =
          prod.availability == 1 ? 'Available' : 'Not Available';
        prod.status = prod.status == 1 ? 'Active' : 'Not active';
        prod.category = prod.product_categories[0]?.category_name || '';
        prod.specification_Key = prod.product_variants[0]?.variant_name || '';
        prod.vendor_approve =
          prod.product_approve_by.length > 0
            ? prod.product_approve_by
              .map((item) => item.vendor_approve_name)
              .join(',')
            : '';
        prod.specification_value =
          prod.product_variants[0]?.variant_value || '';
        worksheet.addRow(prod); // Add data in worksheet
        if (
          prod.product_categories?.length > 1 ||
          prod.product_variants?.length > 1
        ) {
          let maxCount = Math.max(
            prod.product_categories?.length || 0,
            prod.product_variants?.length || 0
          );
          for (let index = 1; index < maxCount; index++) {
            let newData = {};
            if (prod.product_categories[index]?.category_name) {
              newData.category = prod.product_categories[index].category_name;
            }
            if (prod.product_variants[index]?.variant_name) {
              newData.specification_Key =
                prod.product_variants[index].variant_name;
              newData.specification_value =
                prod.product_variants[index].variant_value;
            }
            worksheet.addRow(newData);
          }
        }

        counter++;
      });

      // Making first line in excel bold
      worksheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true };
      });
      try {
        const data = await workbook.xlsx
          .writeFile(`${path}/products.xlsx`)
          .then(() => {
            res.send({
              status: 'success',
              message: 'file successfully downloaded',
              path: `${path}/products.xlsx`,
              download_url: `${Config.base_url}/product_export/products.xlsx`
            });
          });
      } catch (err) {
        console.log('err: ', err);
        res.send({
          status: 'error',
          message: 'Something went wrong'
        });
      }

      /* if (prodList.length > 0) {
        const json2csvParser = new Parser();
        const csv = json2csvParser.parse(prodList);
        res.attachment('product_list.csv');
        res.status(200).send(csv);
        res.download('product_list.csv');
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: prodList,
            total_count: prodList.count
          })
          .end();
      } */
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
  adminProductAdd: async (req, res, next) => {
    try {
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
        vendor,
        is_featured
      } = req.body;
  
      let vendorApproveId = 0;
      if (!approved_id && approved_name) {
        let findVendorApprove = await vendorapproveModel.findVendorApproveByName(approved_name);
        if (findVendorApprove.length == 0) {
          let vendorApproveObj = {
            vendor_approve: approved_name,
            status: 1
          };
          let createVendorApprove = await vendorapproveModel.createVendorApprove(vendorApproveObj);
          vendorApproveId = [createVendorApprove.id];
        } else {
          vendorApproveId = [findVendorApprove[0].id];
        }
      } else {
        vendorApproveId = approved_id;
      }
  
      // ---------------- products ----------------
      let productObj = {
        name: name,
        description: description || null,
        // Changes by Agnij May 02, 2025 [Removed manufacturer field which doesn't exist in database]
        // manufacturer: manufacturer || null,
        // Changes by Agnij May 02, 2025 [Removed availability field which doesn't exist in database]
        // availability: availability || 0,
        slug: titleToSlug(name),
        sku: name,
        created_by: vendor || req.user.id,
        // Changes by Agnij May 02, 2025 [Removed vendor field which doesn't exist in database]
        // vendor: vendor || null,
        status: status || 1,
        // Changes by Agnij May 02, 2025 [Removed is_featured field which doesn't exist in database]
        // is_featured: is_featured || 0,
        is_approve: 0,
        added_by: req.user.id,
        // Changes by Agnij May 02, 2025 [Removed file fields which don't exist in database]
        // qap_new_file_name: req.files?.['qap[]']?.[0]?.location || null,
        // qap_original_file_name: req.files?.['qap[]']?.[0]?.originalname || null,
        // tds_new_file_name: req.files?.['tds[]']?.[0]?.location || null,
        // tds_original_file_name: req.files?.['tds[]']?.[0]?.originalname || null
      };

      let product = await productModel.createProduct(productObj);
      let productId = product.id;
      if (vendorApproveId.length > 0) {
        let productApproveArray = vendorApproveId.map((id) => ({
          product_id: productId,
          vendor_approve_id: id
        }));
        await productModel.addProductApproveBy(productApproveArray, productId);
      }
  
      // ---------------- categories ----------------
      for (const categoryId of categories) {
        await productModel.createProductCategories(categoryId, productId);
      }
  
      // ---------------- variations ----------------
      for await (const { attribute, attributeValue } of variations) {
        // Changes by Agnij May 02, 2025 [Added check for empty attribute name]
        // Skip creating variants with empty names or use a default name
        if (!attribute || attribute.trim() === '') {
          // Either skip this variant
          continue;
          
          // Or use product name as default variant name if attribute is empty
          // let variantObj = {
          //   product_id: productId,
          //   name: `Default variant for ${name}`,
          //   status: 1,
          //   created_at: new Date()
          // };
          // await productModel.createProductVariant(variantObj);
        } else {
          let variantObj = {
            product_id: productId,
            name: attribute,
            status: 1,
            created_at: new Date(),
            // Changes by Agnij May 02, 2025 [Added created_by to ensure proper attribution]
            created_by: req.user.id,
            added_by: req.user.id
          };
          await productModel.createProductVariant(variantObj);
        }
      }

      // ---------------- featured image ----------------
      if (req.files?.['featured[]']?.length > 0) {
        const file = req.files['featured[]'][0];
        let featuredImageObj = {
          product_id: productId,
          is_featured: 1,
          original_image_name: file.originalname,
          new_image_name: file.location
        };
        await productModel.insertProductImages(featuredImageObj);
      }
  
      // ---------------- gallery images ----------------
      if (req.files?.['gallery[]']?.length > 0) {
        for await (const file of req.files['gallery[]']) {
          let imageObj = {
            product_id: productId,
            is_featured: 0,
            original_image_name: file.originalname,
            new_image_name: file.location
          };
          await productModel.insertProductImages(imageObj);
        }
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Added'
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
  approveProduct: async (req, res) => {
    try {
      let { reject_reason, reject_reason_id, status } = req.body;
      const productId = req.params.id;

      // Changes by Agnij May 02, 2025 [Fixed approveProduct to remove vendor_approved_by field]
      
      // Validate status is present and valid
      if (status === undefined || status === null) {
        return res.status(400).json({
          status: 3,
          message: 'Status is required'
        });
      }
      
      // Ensure status is treated as a string for comparison
      status = status.toString();
      
      if (status !== '0' && status !== '1') {
        return res.status(400).json({
          status: 3,
          message: 'Status must be 0 or 1'
        });
      }

      
      let reasonId = null;
      if (status === '0') {
        if (reject_reason_id) {
          reasonId = reject_reason_id;
        } else if (reject_reason) {
          let checkReason = await vendorModel.findReasonByText(reject_reason);
          if (checkReason.length > 0) {
            reasonId = checkReason[0].id;
          } else {
            let reasonObj = {
              status: 1,
              reject_reason: reject_reason,
              type: 2
            };
            let createReason = await vendorModel.createReason(reasonObj);
            reasonId = createReason[0].id;
          }
        } else {
          return res.status(400).json({
            status: 3,
            message: 'Reject reason is required when rejecting a product'
          });
        }
      }

      const currentTime = new Date();
      let productObj = {
        is_approve: status,
        updated_by: req.user.id,
        reject_reason_id: reasonId || null,
        updated_at: currentTime
      };
      
      // Add approved_at field when approving
      if (status === '1') {
        productObj.approved_at = currentTime;
      }

      const approveProduct = await productModel.approveProduct(
        productObj,
        productId
      );
      
      // If this product has a vendor, try to send an email notification
      // if (approveProduct && approveProduct.created_by) {
      //   try {
      //     let userDetail = await vendorModel.userDetailById(
      //       approveProduct.created_by
      //     );
          
      //     if (userDetail && userDetail.length > 0) {
      //       let html_variables = [
      //         { name: userDetail[0].name },
      //         {
      //           message:
      //             status == 1
      //               ? `Your product ${approveProduct.name} has been approved`
      //               : `Your product ${approveProduct.name} has been rejected`
      //         }
      //       ];
            
      //       let dynamic_html = fs
      //         .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
      //         .toString();

      //       for (let index = 0; index < html_variables.length; index++) {
      //         const element = html_variables[index];
      //         let dynamic_key = Object.keys(element)[0];
      //         let replace_char = html_variables[index][dynamic_key];
      //         let replace_var = `[${dynamic_key.toLowerCase()}]`;

      //         dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
      //       }

      //       // Send the email to the SPOC or vendor
      //       const spocList = await vendorModel.getSpocDetails(userDetail[0]?.id);
            
      //       let mailRecipients = {
      //         from: Config.webmasterMail,
      //         subject: `Work Wise | Product Review Status`,
      //         html: dynamic_html
      //       };

      //       if (spocList && spocList.length > 0) {
      //         mailRecipients.to = spocList.map(spoc => spoc.email);
      //         mailRecipients.cc = userDetail[0].email;
      //       } else {
      //         mailRecipients.to = userDetail[0].email;
      //       }

      //       sendMail(mailRecipients);
      //     }
      //   } catch (emailError) {
      //     console.error("Error sending notification email:", emailError);
      //     // Continue with the response even if email fails
      //   }
      // }

      return res.status(200).json({
        status: 1,
        message: `Product successfully ${status == 0 ? 'Disapproved' : 'Approved'}`
      });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || Config.errorText.value
      });
    }
  },

  approveVariant: async (req, res) => {
    try {
      let { reject_reason, reject_reason_id, status } = req.body;
      const productId = req.params.id;

      // Changes by Agnij May 02, 2025 [Fixed approveProduct to remove vendor_approved_by field]
      
      // Validate status is present and valid
      if (status === undefined || status === null) {
        return res.status(400).json({
          status: 3,
          message: 'Status is required'
        });
      }
      
      // Ensure status is treated as a string for comparison
      status = status.toString();
      
      if (status !== '0' && status !== '1') {
        return res.status(400).json({
          status: 3,
          message: 'Status must be 0 or 1'
        });
      }

      let reasonId = null;
        // if (status === '0') {
        //   if (reject_reason_id) {
        //     reasonId = reject_reason_id;
        //   } else if (reject_reason) {
        //     let checkReason = await vendorModel.findReasonByText(reject_reason);
        //     if (checkReason.length > 0) {
        //       reasonId = checkReason[0].id;
        //     } else {
        //       let reasonObj = {
        //         status: 1,
        //         reject_reason: reject_reason,
        //         type: 2
        //       };
        //       let createReason = await vendorModel.createReason(reasonObj);
        //       reasonId = createReason[0].id;
        //     }
        //   } else {
        //     return res.status(400).json({
        //       status: 3,
        //       message: 'Reject reason is required when rejecting a product'
        //     });
        //   }
        // }
        
        // Update variant status
        const currentTime = new Date();
        const variantObj = {
          is_approve: parseInt(status),
          updated_by: req.user.id,
          reject_reason_id: reasonId || null,
          updated_at: currentTime
        };
        
        await productModel.updateProductVariant(variantObj, productId);
        
        return res.status(200).json({
          status: 1,
          message: `Variant successfully ${status === '0' ? 'Disapproved' : 'Approved'}`
        });
    } catch (error) {
      logError(error);
      return res.status(400).json({
        status: 3,
        message: error.message || Config.errorText.value
      });
    }
  },
  adminProductUpdate: async (req, res, next) => {
    try {
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
        vendor,
        is_featured
      } = req.body;
  
      const productId = req.params.id;
      const productDetails = await productModel.check_product(productId);
  
      // ---------------- vendor approval ----------------
      let vendorApproveId = [];
      if (!approved_id && approved_name) {
        let findVendorApprove = await vendorapproveModel.findVendorApproveByName(approved_name);
        if (findVendorApprove.length === 0) {
          let vendorApproveObj = {
            vendor_approve: approved_name,
            status: 1
          };
          let createVendorApprove = await vendorapproveModel.createVendorApprove(vendorApproveObj);
          vendorApproveId = [createVendorApprove.id];
        } else {
          vendorApproveId = [findVendorApprove[0].id];
        }
      } else if (approved_id) {
        vendorApproveId = approved_id.split(',').map((id) => parseInt(id.trim()));
      }
  
      // ---------------- update product ----------------
      let productObj = {
        name: name,
        description: description || null,
        manufacturer: manufacturer || null,
        availability: availability || 0,
        slug: titleToSlug(name),
        sku: name,
        updated_by: req.user.id,
        // Changes by Agnij May 02, 2025 [Removed vendor field which doesn't exist in database]
        // vendor: vendor || productDetails[0].vendor,
        status: status || 1,
        // vendor_approved_by: vendorApproveId || null,
        productId: productId
        // Changes by Agnij May 02, 2025 [Removed is_featured field which doesn't exist in database]
        // is_featured: is_featured || 0,
        // Changes by Agnij May 02, 2025 [Removed file fields which don't exist in database]
        // qap_new_file_name: req.files?.['qap[]']?.[0]?.location || null,
        // qap_original_file_name: req.files?.['qap[]']?.[0]?.originalname || null,
        // tds_new_file_name: req.files?.['tds[]']?.[0]?.location || null,
        // tds_original_file_name: req.files?.['tds[]']?.[0]?.originalname || productDetails[0].tds_original_file_name || null
      };
  
      await productModel.updateVendorProduct(productObj);
  
      // ---------------- remove old data ----------------
      await productModel.deleteProductVariants(productId);
      await productModel.deleteProductCategory(productId);
      await productModel.deleteProductApproveBy(productId);
  
      // ---------------- add categories ----------------
      for (const categoryId of categories) {
        await productModel.createProductCategories(categoryId, productId);
      }
  
      // ---------------- add variations ----------------
      for await (const { attribute, attributeValue } of variations) {
        // Changes by Agnij May 02, 2025 [Added check for empty variant names during update]
        if (!attribute || attribute.trim() === '') {
          continue; // Skip empty variant names
        }
        
        let variantObj = {
          product_id: productId,
          name: attribute,
          status: 1,
          created_at: new Date(),
          created_by: req.user.id,
          added_by: req.user.id
        };
        await productModel.createProductVariant(variantObj);
      }
  
      // ---------------- add approval ----------------
      if (vendorApproveId.length > 0) {
        let productApproveArray = vendorApproveId.map((id) => ({
          product_id: productId,
          vendor_approve_id: id
        }));
        await productModel.addProductApproveBy(productApproveArray, productId);
      }
  
      // ---------------- featured image ----------------
      if (req.files?.['featured[]']?.length > 0) {
        let featuredImage = await productModel.getProductImages(productId, 1);
        if (featuredImage.length > 0) {
          await productModel.deleteProductImages(productId, 1, featuredImage[0].id);
        }
  
        const file = req.files['featured[]'][0];
        let featuredImageObj = {
          product_id: productId,
          is_featured: 1,
          original_image_name: file.originalname,
          new_image_name: file.location
        };
        await productModel.insertProductImages(featuredImageObj);
      }
  
      // ---------------- gallery images ----------------
      if (req.files?.['gallery[]']?.length > 0) {
        let galleryImage = await productModel.getProductImages(productId, 0);
        if (galleryImage.length > 0) {
          for await (const { id } of galleryImage) {
            await productModel.deleteProductImages(productId, 0, id);
          }
        }
  
        for await (const file of req.files['gallery[]']) {
          let imageObj = {
            product_id: productId,
            is_featured: 0,
            original_image_name: file.originalname,
            new_image_name: file.location
          };
          await productModel.insertProductImages(imageObj);
        }
      }

      // ---------------- Delete qap and tds file  ----------------
      /* if (req.files?.qap?.length > 0) {
        fs.unlink(
          `${Config.upload.product_image}/${productDetails[0].qap_new_file_name}`,
          (unlinkError) => {
            if (unlinkError) {
              console.error('Error deleting file:', unlinkError);
            }
          }
        );
      } */
      /* if (req.files?.tds?.length > 0) {
        fs.unlink(
          `${Config.upload.product_image}/${productDetails[0].tds_new_file_name}`,
          (unlinkError) => {
            if (unlinkError) {
              console.error('Error deleting file:', unlinkError);
            }
          }
        );
      } */

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Updated successfully'
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
  productDetails: async (req, res, next) => {
    try {
      let productId = req.params.id;

      // Changes by Agnij May 02, 2025 [Removed vendor list retrieval]
      let productList = await productModel.productDetails(productId);
      const product = productList?.[0];
      if(!product) return res.status(404).json({
        status: 3,
        message: 'Product Not Found!'
      })
      
      res
        .status(200)
        .json({
          status: 1,
          data: productList[0],
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
  adminProductDelete: async (req, res, next) => {
    try {
      let productId = req.params.id;
      let productObj = {
        is_deleted: 1,
        updated_by: req.user.id
      };

      await productModel.deleteProduct(productObj, productId);
      res
        .status(200)
        .json({
          status: 1,
          message: 'Product deleted'
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
  // New functions for product variant management
  addProductVariant: async (req, res) => {
    try {
      // Changes by Agnij May 01, 2025 [Removed debug console logs]
      
      // Get input parameters, supporting both name and variant_name
      const { product_id, variant_name, name } = req.body;
      const variantNameValue = variant_name || name;
      
      // Validate input
      if (!product_id || !variantNameValue) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Product ID and variant name are required' 
        });
      }
      
      // Check if product exists
      const product = await productModel.check_product(product_id);
      if (!product || product.length === 0) {
        return res.status(404).json({ 
          status: 3, 
          message: 'Product not found' 
        });
      }
      
      // Check if variant name already exists for this product
      const existingVariant = await productModel.checkDuplicateVariantName(product_id, variantNameValue);
      if (existingVariant && existingVariant.length > 0) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Variant name already exists for this product' 
        });
      }
      
      // Create variant with complete structure matching the example in tbl_product_variant_query_output.txt
      // Changes by Agnij May 01, 2025 [Set is_approve to 0 by default]
      const variantObj = {
        product_id,
        name: variantNameValue, // Store in name field as per DB structure
        slug: variantNameValue.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        sku: variantNameValue, // Use variant name as sku
        status: 1,
        is_deleted: 0,
        is_review: 0,
        is_approve: 0, // Changed from 1 to 0 as default
        created_at: new Date(),
        created_by: req.user?.id || null,
        added_by: req.user?.id || null
      };
      
      try {
        const result = await productModel.createProductVariant(variantObj);
        
        if (!result || !result.id) {
          return res.status(500).json({
            status: 3,
            message: 'Failed to create product variant: No ID returned from database',
          });
        }
        
        return res.status(201).json({
          status: 1,
          message: 'Product variant added successfully',
          data: { 
            id: result.id,
            product_id: product_id,
            variant_name: variantNameValue
          }
        });
      } catch (createError) {
        return res.status(500).json({
          status: 3,
          message: 'Error creating variant',
          error: createError.message
        });
      }
      
    } catch (error) {
      return res.status(500).json({
        status: 3,
        message: Config?.errorText?.value || 'Something went wrong',
        error: error.message
      });
    }
  },
  
  getProductVariants: async (req, res) => {
    try {
      const { product_id } = req.params;
      
      // Validate input
      if (!product_id) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Product ID is required' 
        });
      }
      
      // Get variants for the product
      const variants = await productModel.getProductVariants(product_id);
      
      // Changes by Agnij April 30, 2025 [Ensuring consistent empty array return instead of null]
      return res.status(200).json({
        status: 1,
        data: variants || [] // Return empty array instead of null
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Failed to fetch product variants'
      });
    }
  },
  
  updateProductVariant: async (req, res) => {
    try {
      // Changes by Agnij July 25, 2025 [Added support for changing parent product and auto-disapproval]
      const { variant_id } = req.params;
      const { variant_name, name, product_id, is_approve } = req.body;
      
      // Get the variant name from either variant_name or name field
      const variantNameValue = variant_name || name;
      
      // Validate input
      if (!variant_id) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Variant ID is required' 
        });
      }
      
      // Check if variant exists
      const variant = await productModel.getProductVariantDetails(variant_id);
      if (!variant || variant.length === 0) {
        return res.status(404).json({ 
          status: 3, 
          message: 'Variant not found' 
        });
      }
      
      // Check if product exists (if changing parent product)
      if (product_id && product_id !== variant[0].product_id) {
        const product = await productModel.check_product(product_id);
        if (!product || product.length === 0) {
          return res.status(404).json({ 
            status: 3, 
            message: 'Parent product not found' 
          });
        }
      }
      
      // Build variant object dynamically based on what values were provided
      const variantObj = {
        updated_at: new Date(),
        updated_by: req.user?.id
      };
      
      // Only add name if it was provided
      if (variantNameValue) {
        variantObj.name = variantNameValue;
      }
      
      // Include product_id if provided
      if (product_id) {
        variantObj.product_id = product_id;
      }
      
      // Set is_approve to provided value or 0 by default
      variantObj.is_approve = is_approve !== undefined ? is_approve : 0;
      
      // Update variant
      const updatedVariant = await productModel.updateProductVariant(variantObj, variant_id);
      
      return res.status(200).json({
        status: 1,
        message: 'Product variant updated successfully',
        data: {
          id: variant_id,
          variant_name: variantNameValue,
          product_id: product_id || variant[0].product_id,
          is_approve: variantObj.is_approve,
          vendor_approved_by: updatedVariant?.vendor_approved_by || null
        }
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 3,
        message: Config?.errorText?.value || 'Something went wrong'
      });
    }
  },
  
  deleteProductVariant: async (req, res) => {
    try {
      // Changes by Agnij April 30, 2025 [Fixed parameter name to match route]
      const { variant_id } = req.params;
      
      // Validate input
      if (!variant_id) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Variant ID is required' 
        });
      }
      
      // Check if variant exists
      const variant = await productModel.getProductVariantDetails(variant_id);
      if (!variant || variant.length === 0) {
        return res.status(404).json({ 
          status: 3, 
          message: 'Variant not found' 
        });
      }
      
      // Delete variant
      await productModel.deleteProductVariant(variant_id);
      
      return res.status(200).json({
        status: 1,
        message: 'Product variant deleted successfully'
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 3,
        message: Config?.errorText?.value || 'Something went wrong'
      });
    }
  },
  
  mapVariantWithVendor: async (req, res) => {
    try {
      // Changes by Agnij May 01, 2025 [Removed debug console logs]
      
      // Support both naming conventions: variant_id and product_variant_id
      const variantId = req.body.variant_id || req.body.product_variant_id;
      const vendorId = req.body.vendor_id;
      let vendorApproveId = req.body.approved_by ?? [];
      
      // Validate input
      if (!variantId || !vendorId) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Variant ID and vendor ID are required' 
        });
      }
      
      // Check if variant exists
      const variant = await productModel.getProductVariantDetails(variantId);
      if (!variant || variant.length === 0) {
        return res.status(404).json({ 
          status: 3, 
          message: 'Variant not found' 
        });
      }
      
      // Check if vendor exists
      const vendor = await vendorModel.getVendorDetails(vendorId);
      if (!vendor || vendor.length === 0) {
        return res.status(404).json({ 
          status: 3, 
          message: 'Vendor not found' 
        });
      }
      
      // Check if mapping already exists
      const existingMapping = await productModel.checkDuplicateVariantVendorMapping(variantId, vendorId);
      if (existingMapping && existingMapping.length > 0) {
        return res.status(400).json({ 
          status: 3, 
          message: 'Variant is already mapped with this vendor' 
        });
      }

      const productResult = await productModel.getProductByVariant(variantId)
      let productId = productResult?.[0]?.id
      
      // Changes by Agnij May 02, 2025 [Set is_approve to 0 (disapproved) by default for new mappings]
      // Create mapping
      const mappingObj = {
        product_variant_id: variantId,
        vendor_id: vendorId,
        created_at: new Date(),
        status: true,
        is_approved: false,
        created_by: req.user.id,
        updated_by: req.user.id,
      };
      
      // Create the mapping
      const mappingResult = await productModel.createProductVariantVendorMapping(mappingObj);

      console.log("MAPPING RES: ", mappingResult, "\nVENDOR APPROVE ID: ", vendorApproveId);

      if (vendorApproveId.length > 0 && mappingResult) {
        let productApproveArray = [];
        vendorApproveId.forEach((item) => {
          productApproveArray.push({
            product_id: productId,
            variant_vendor_mapping_id: mappingResult.id,
            vendor_approve_id: item
          });
        });

        await productModel.addProductApproveBy(productApproveArray, productId);
      }
      
      // Update variant to disapproved state by default
      // await productModel.updateProductVariantApproval(variantId, 0);
      
      return res.status(200).json({
        status: 1,
        message: 'Variant mapped with vendor successfully'
      });
      
    } catch (error) {
      return res.status(500).json({
        status: 3,
        message: Config?.errorText?.value || 'Something went wrong',
        error: error.message
      });
    }
  },
  createProductVariant: async (variantObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantObj, null, 'tbl_product_variant') +
        ' RETURNING id';

      db.one(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  // Changes by Agnij April 30, 2025 [Added endpoint to search all product variants]
  searchVariants: async (req, res) => {
    try {
      // Changes by Agnij May 01, 2025 [Added all filter parameters]
      const { 
        id, 
        search_term, 
        start_date, 
        end_date,
        vendor_id,
        category_id,
        added_by,
        is_approve
      } = req.query;
      
      // Search for variants across all products with all filter parameters
      const variants = await productModel.searchProductVariants(
        id, 
        search_term || "", 
        start_date, 
        end_date,
        vendor_id,
        category_id,
        added_by,
        is_approve
      );
      
      return res.status(200).json({
        status: 1,
        data: variants || []
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Failed to search product variants'
      });
    }
  },
  
  // Changes by Agnij May 02, 2025 [Added safe variant search function that avoids v_rank issues]
  searchVariantsSafe: async (req, res) => {
    try {
      // Changes by Agnij May 03, 2025 [Utilize paginated model function]
      const {
        id,
        search_term,
        start_date,
        end_date,
        vendor_id,
        category_id,
        added_by,
        is_approve,
        page, // Get page from query
        limit // Get limit from query
      } = req.query;

      // Package filters
      const filters = {
        id,
        search_term,
        start_date,
        end_date,
        vendor_id,
        category_id,
        added_by,
        is_approve
      };

      // Call the new paginated model function
      const result = await productModel.searchProductVariantsPaginated(
        filters,
        page, // Pass page
        limit // Pass limit
      );

      // Changes by Agnij May 03, 2025 [Correct response structure to include pagination]
      // Explicitly build the response object
      const responsePayload = {
        status: 1,
        data: result.data || [], // Ensure data is always an array
        pagination: result.pagination || { total: 0, page: page, limit: limit, pages: 1 } // Ensure pagination object exists
      };
      
      // Log the final payload just before sending
      console.log("searchVariantsSafe: Sending response payload:", JSON.stringify(responsePayload));
      
      // Send the explicitly constructed payload
      res.status(200).json(responsePayload).end();

    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Failed to search product variants',
        error: error.message
      });
    }
  },
  // Changes by Agnij May 18, 2025 [Added endpoint to get variant-vendor mappings]
  getVariantMappings: async (req, res) => {
    try {
      // Changes by Agnij May 02, 2025 [Added pagination parameters]
      const { 
        search_term, 
        start_date, 
        end_date,
        vendor_id,
        category_id,
        added_by,
        is_approve,
        page = 1,
        limit = 10,
        variant_id // Changes by Agnij June 12, 2024 [Added variant_id parameter for filtering]
      } = req.query;
      
      // Parse pagination parameters
      const pageNumber = parseInt(page) || 1;
      const pageSize = parseInt(limit) || 10;
      
      
      // Get mappings using the model function with all filters and pagination
      const result = await productModel.getVariantVendorMappings(
        search_term || "", 
        start_date, 
        end_date, 
        vendor_id,
        category_id,
        added_by,
        is_approve,
        pageNumber,
        pageSize,
        variant_id // Changes by Agnij June 12, 2024 [Added variant_id parameter]
      );
      
      
      // Changes by Agnij May 02, 2025 [Fixed response format to ensure pagination is properly included]
      return res.status(200).json({
        status: 1,
        data: result.data || [],
        pagination: result.pagination || {
          total: 0,
          page: pageNumber,
          limit: pageSize,
          pages: 1
        }
      });
    } catch (error) {
      logError(error);
      return res.status(500).json({
        status: 0,
        message: 'Failed to get variant-vendor mappings',
        error: error.message
      });
    }
  },
  // Changes by Agnij May 01, 2025 [Added approval function for variant-vendor mappings]
  approveMapping: async (req, res) => {
    try {
      const mappingId = req.params.id;
      
      if (!mappingId) {
        return res.status(400).json({
          status: 3,
          message: 'Mapping ID is required'
        });
      }
      
      // First, get the mapping to find the associated variant
      const mappingDetails = await productModel.getVariantVendorMappingById(mappingId);
      
      if (!mappingDetails) {
        return res.status(404).json({
          status: 3,
          message: 'Mapping not found'
        });
      }
      
      // Check for variant ID in the mapping (may be called variant_id or product_variant_id)
      const variantId = mappingDetails.variant_id || mappingDetails.product_variant_id;
      
      if (!variantId) {
        return res.status(404).json({
          status: 3,
          message: 'Invalid mapping: no variant associated'
        });
      }
      
      
      let status = req.body.status;
      
      // Ensure status is valid
      if (status === undefined || status === null) {
        return res.status(400).json({
          status: 3,
          message: 'Status is required'
        });
      }
      
      // Convert status to appropriate format (handle various input formats)
      if (typeof status === 'string') {
        status = status === '1' || status.toLowerCase() === 'true' ? 1 : 0;
      } else {
        status = status ? 1 : 0;
      }
      
      let reject_reason = req.body.reject_reason || null;
      let reject_reason_id = req.body.reject_reason_id || null;
      
      
      // Handle rejection reason for rejections
      if (status === 0 && !reject_reason_id && !reject_reason) {
        return res.status(400).json({
          status: 3,
          message: 'Reject reason is required when rejecting'
        });
      }
      
      // Prepare the variant update object
      const variantObj = {
        is_approved: status == "1",
        updated_by: req.user.id,
        updated_at: new Date(),
        approved_by: req.user.id,
        approved_at: status == 1 ? new Date() : null,
      };

      console.log("MAPPING OBJ: ", variantObj)
      
      // Update the variant instead of the mapping
      // Update by Kushal: We want to update the mapping not variant as the mapping is going to be used when showing vendors not variant
      try {
        const result = await productModel.updateVariantMappingByData(variantObj, mappingId);
        
        return res.status(200).json({
          status: 1,
          message: status === 1 ? 'Mapping approved successfully' : 'Mapping disapproved successfully'
        });
      } catch (updateError) {
        console.error("Error updating mapping:", updateError);
        return res.status(500).json({
          status: 3,
          message: 'Error updating mapping approval status',
          error: updateError.message
        });
      }
    } catch (error) {
      console.error("Exception in approveMapping:", error);
      logError(error);
      return res.status(500).json({
        status: 3,
        message: Config?.errorText?.value || 'Something went wrong while updating approval',
        error: error.message
      });
    }
  },
};
export default productController;
