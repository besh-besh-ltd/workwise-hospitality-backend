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

const cryptr = new Cryptr(Config.cryptR.secret);

const generatePassword = (password) => {
  var salt = bcrypt.genSaltSync(10);
  var hash = bcrypt.hashSync(password, salt);
  return hash;
};

const productController = {
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
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      let categoryList = await productModel.getCategoryList(limit, offset);
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
      let isMaster = 0;
      let previousCategory = '';

      for await (const [index, value] of jsonData.entries()) {
        if (value['Product Name']) {
          // check vendor exist or not
          previousCategory = '';
          let userExist = '';
          let vendor = '';
          let vendor_id = '';
          let password = value['Vendor Name'].replace(/\s+/g, '');
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
              : value['Vendor company owner/hr/official contact number'] % 10000
          }`;

          let vendor_email = value['Vendor Email'];

          if (vendor_email != undefined && vendor_email != '') {
            let checkState = await vendorModel.checkState(
              value['State\r\n(drop down)']
            );
            let checkCity = await vendorModel.checkCity(value['City']);
            // console.log('checkState checkCity', checkState, checkCity);
            let vendorObj = {
              name: value['Vendor Name'],
              email: value['Vendor Email'],
              organization_name: value['Contact Person Name'],
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
              email: value['Vendor Email'] || null,
              mobile:
                value['Vendor company owner/hr/official contact number'] ||
                null,
              company_name: value['Vendor Name'],
              nature_of_business:
                value['Nature of Business\r\n(drop down)'] || null,
              established_year: value['Established Year'] || null,
              spoc_name: value['Sales SPOC Name'] || null,
              spoc_role: value['Sales SPOC Position/Role'] || null,
              spoc_email: value['Sales SPOC Business Email'] || null,
              spoc_mobile: value['Sales SPOC Mobile'] || null,
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

            userExist = await productModel.checkVendorExist(vendor_email);
            // console.log('userExist-->', userExist);
            // console.log('webmail-->', Config.webmasterMail);
            // return false;
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

              // console.log('vendor-->', vendor);
              vendor_id = vendor[0].id;
              sendMail({
                from: Config.webmasterMail, // sender address
                to: vendor_email, // list of receivers
                subject: `Work wise | Registration`, // Subject line
                // html: dynamic_html // plain text body
                html: `Dear ${value['Vendor Name']}, Your login credential Userid: ${value['Vendor Email']} and password ${password}`
              });

              let checkFreeSubscription =
                await subscriptionModel.checkFreeSubscription();
              if (checkFreeSubscription.length > 0) {
                const startDate = moment(); // Replace with the actual start date

                const billingCycleMonths = checkFreeSubscription[0].duration;

                // Calculate the end date by adding the billing cycle and subtracting one day
                const endDate = startDate
                  .clone()
                  .add(billingCycleMonths, 'months')
                  .subtract(1, 'day');
                const renewDate = startDate
                  .clone()
                  .add(billingCycleMonths, 'months');

                // console.log('Start Date:', startDate.format('YYYY-MM-DD'));
                // console.log('End Date:', endDate.format('YYYY-MM-DD'));
                // console.log('Renew Date:', renewDate.format('YYYY-MM-DD'));

                let UserSubscriptionObj = {
                  user_id: vendor[0].id,
                  plan_id: checkFreeSubscription[0].id,
                  status: 1, //By default payment done
                  start_date: startDate.format('YYYY-MM-DD'),
                  end_date: endDate.format('YYYY-MM-DD'),
                  renew_date: renewDate.format('YYYY-MM-DD')
                };

                let createUserSubscription =
                  await subscriptionModel.createUserSubscription(
                    UserSubscriptionObj
                  );

                await subscriptionModel.updateUserSubscriptionId(
                  checkFreeSubscription[0].id,
                  vendor[0].id
                );
                let subscriptionMappingDetails =
                  await subscriptionModel.getSubscriptionMappingDetails(
                    checkFreeSubscription[0].id
                  );
                // console.log(
                //   'subscriptionMappingDetails==>>>>',
                //   subscriptionMappingDetails
                // );
                for await (const {
                  allocated_feature,
                  feature_id
                } of subscriptionMappingDetails) {
                  let userSubscriptionFeatureObj = {
                    user_subscriptions_id: createUserSubscription.id,
                    feature_id: feature_id,
                    plan_id: checkFreeSubscription[0].id,
                    used_feature_count: 0,
                    allocated_feature: allocated_feature,
                    user_id: vendor[0].id
                  };
                  await subscriptionModel.createUserSubscriptionFeature(
                    userSubscriptionFeatureObj
                  );
                }
              }
            } else {
              vendor = await productModel.updateVendorDetail(vendorObj);
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
              userExist = await productModel.checkVendorExist(vendor_email);
              vendor_id = userExist[0].id;
            }
          }

          let prodNameExists = await productModel.checkProductExists(
            value['Product Name'],
            vendor_id
          );
          //    console.log('prodNameExists--->', prodNameExists);
          // return false;
          let productObj = '';

          let check_master_exist = await productModel.checkMasterNameExist(
            value['Product Name']
          );
          if (check_master_exist.length == 0) {
            isMaster = 0;
          } else {
            isMaster = 1;
          }
          console.log('check_master_exist--->', isMaster);
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
              availability: 0,
              sku: productDetails[0].name,
              created_by: vendor_id,
              added_by: req.user.id,
              is_approve: 1
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

          if (
            prodNameExists &&
            prodNameExists.length == 0 &&
            vendor_id &&
            isMaster == 0
          ) {
            productObj = {
              name: value['Product Name'],
              description: value['Product description'] || null,
              manufacturer: value['Manufacturer'] || null,
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product Name']),
              sku: value['Product Name'],
              // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
              status: 1,
              created_by: vendor_id,
              vendor: vendor_id,
              is_review: 1,
              added_by: adm_id,
              is_approve: 1,
              brochure_file: value['Product Brochure\r\n(file)'] || null
            };
            product = await productModel.createProduct(productObj);

            /*  if (value['Vendor Approved By']) {
              // let vendorApproveArray = value['Vendor Approved By'].split(',');
              let vendorApproveArray = [value['Vendor Approved By']];
              let vendorApproveArrayId = [];
              for (let index = 0; index < vendorApproveArray.length; index++) {
                const element = vendorApproveArray[index];
                let vendorApproveId = 0;
                let findVendorApprove =
                  await vendorapproveModel.findVendorApproveByName(element);
                if (findVendorApprove.length == 0) {
                  let vendorApproveObj = {
                    vendor_approve: element,
                    status: 1
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
                  product_id: product.id,
                  vendor_approve_id: vendorApproveId
                });
              }
              await productModel.addProductApproveBy(
                vendorApproveArrayId,
                product.id
              );
            } */

            /* let checkApprove = await userModel.checkVendorApproveDetail(
                vendor_id,
                vendorApproveId
              );
              if (checkApprove.length == 0) {
                await userModel.vendorApproveUserMap(
                  vendor_id,
                  vendorApproveId
                );
              } */

            //  await productModel.createProduct(productObj);
          } else if (vendor_id && isMaster == 0) {
            /* let checkApprove = await userModel.checkVendorApproveDetail(
              vendor_id,
              vendorApproveId
            );
            if (checkApprove.length == 0) {
              await userModel.vendorApproveUserMap(vendor_id, vendorApproveId);
            } */

            productObj = {
              description: value['Product description'] || null,
              manufacturer: value['Manufacturer'] || null,
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product Name']),
              sku: value['Product Name'],
              // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
              status: 1,
              created_by: vendor_id,
              vendor: vendor_id,
              is_review: prodNameExists[0].is_review,
              is_approve: prodNameExists[0].is_approve,
              brochure_file:
                value['Product Brochure\r\n(file)'] ||
                prodNameExists[0].brochure_file
            };

            product = await productModel.updateProduct(
              productObj,
              prodNameExists[0].id
            );
            // console.log('product===============>>>>>>>>>>>>', product);
            //After update product mappings are deleted
            // Delete variants
            await productModel.deleteProductVariants(prodNameExists[0].id);
            // Delete product category
            await productModel.deleteProductCategory(prodNameExists[0].id);
            // delete product approved by
            await productModel.deleteProductApproveBy(prodNameExists[0].id);

            /* if (value['Vendor Approved By']) {
              let vendorApproveArray = [value['Vendor Approved By']];
              // let vendorApproveArray = value['Vendor Approved By'].split(',');
              let vendorApproveArrayId = [];
              for (let index = 0; index < vendorApproveArray.length; index++) {
                const element = vendorApproveArray[index];
                let vendorApproveId = 0;
                let findVendorApprove =
                  await vendorapproveModel.findVendorApproveByName(element);
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
                  product_id: prodNameExists[0].id,
                  vendor_approve_id: vendorApproveId
                });
              }
              // console.log('vendorApproveArrayId ==>>>>>', vendorApproveArrayId);
              await productModel.addProductApproveBy(
                vendorApproveArrayId,
                prodNameExists[0].id
              );
            } */
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
          if (value['Category'] && isMaster == 0) {
            let catNameExists = [];
            if (previousCategory) {
              catNameExists = await productModel.topParentparentCatExists(
                value['Category'],
                previousCategory
              );
            } else {
              catNameExists = await productModel.topParentparentNameExists(
                value['Category']
              );
            }
            console.log(catNameExists);
            let category_id = '';
            if (catNameExists.length > 0) {
              category_id = { id: catNameExists[0].id };
            } else {
              console.log('test--->', value['Category']);
              //  return false;
              let catObj = {
                title: value['Category'],
                parent_id: previousCategory || '0',
                slug:
                  value['Category'] == undefined
                    ? ''
                    : titleToSlug(value['Category']),
                status: '1',
                adm_id: adm_id
              };
              category_id = await productModel.addCategory(catObj);
              // console.log('category_id--', category_id);
              // return false;
            }
            previousCategory = category_id.id;
            let categoryObj = {
              product_id: productId,
              category_name: value['Category'],
              category_id: category_id.id
            };
            await productModel.createProductCategory(categoryObj);
          }

          if (value['Vendor Approved By']) {
            let vendorApproveArray = [value['Vendor Approved By']];
            // let vendorApproveArray = value['Vendor Approved By'].split(',');
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
  onlyProductBulkUpload: async (req, res, next) => {
    try {
      let file = req.file;
      // return false;
      //userExist

      const excelHeaders = [
        'Product Name',
        'Vendor Approved By',
        'Category',
        'Product\r\nDescription',
        'Product Featured Image\r\n(file)',
        'Product Images\r\n(file)',
        'Product Brochure\r\n(file)',
        'Product QAP\r\n(file)',
        'Product TDS\r\n(file)'
      ];

      const workbook = xlsx.readFile(file.path); // Replace 'example.xlsx' with your Excel file name
      // console.log('workbook==>>>>>>>>', workbook);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const firstHeaderData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      /*  let headerCheck = await arraysHaveSameData(
        excelHeaders,
        firstHeaderData[0]
      ); */
      // console.log('headerCheck====', headerCheck);
      // console.log(excelHeaders, firstHeaderData[0]);
      /* if (!headerCheck) {
        err++;
        errors.message = 'Download the sample Excel and check all column name';
      } */

      // const options = {
      //   header: 1, // Treat the first row as header
      //   defval: '', // Replace undefined or null values with an empty string
      //   blankrows: false // Do not include blank rows
      // };

      // Convert sheet to JSON
      // console.log(sheet);
      const jsonData = xlsx.utils.sheet_to_json(sheet);

      // console.log(jsonData);
      // return false;

      // let NewProduct = false;
      let productId = 0;
      let productArray = [];
      let previousProductId = 0;
      let categoryCount = 0;
      let product = 0;
      let vendor_id = null;

      for await (const [index, value] of jsonData.entries()) {
        // console.log('product==========>>>>>>>>', index, value);
        if (value['Product Name']) {
          // check vendor exist or not

          let prodNameExists = await productModel.checkProductExists(
            value['Product Name'],
            null,
            null,
            req.user.id
          );
          // console.log('prodNameExists--->', prodNameExists);
          // return false;
          let productObj = '';

          if (prodNameExists && prodNameExists.length == 0) {
            productObj = {
              name: value['Product Name'],
              description: value['Product\r\nDescription'] || null,
              manufacturer: value['Manufacturer'] || null,
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product Name']),
              sku: value['Product Name'],
              // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
              status: 1,
              created_by: req.user.id,
              vendor: null,
              is_review: 1,
              is_approve: 0,
              added_by: req.user.id,
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
            product = await productModel.createProduct(productObj);

            if (value['Vendor Approved By']) {
              // let vendorApproveArray = value['Vendor Approved By'].split(',');
              let vendorApproveArray = [value['Vendor Approved By']];
              let vendorApproveArrayId = [];
              for (let index = 0; index < vendorApproveArray.length; index++) {
                const element = vendorApproveArray[index];
                let vendorApproveId = 0;
                let findVendorApprove =
                  await vendorapproveModel.findVendorApproveByName(element);
                if (findVendorApprove.length == 0) {
                  let vendorApproveObj = {
                    vendor_approve: element,
                    status: 1
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
                  product_id: product.id,
                  vendor_approve_id: vendorApproveId
                });
              }
              await productModel.addProductApproveBy(
                vendorApproveArrayId,
                product.id
              );
            }

            //  await productModel.createProduct(productObj);
          } else {
            productObj = {
              description: value['Product\r\nDescription'] || null,
              manufacturer: value['Manufacturer'] || null,
              availability:
                value['Product Availability'] == 'Available' ? 1 : 0,
              slug: titleToSlug(value['Product Name']),
              sku: value['Product Name'],
              // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
              status: 1,
              created_by: prodNameExists[0].created_by,
              vendor: vendor_id || prodNameExists[0].vendor,
              is_review: prodNameExists[0].is_review,
              is_approve: prodNameExists[0].is_approve,
              brochure_file:
                value['Product Brochure\r\n(file)'] ||
                prodNameExists[0].brochure_file,
              qap_new_file_name:
                value['Product QAP\r\n(file)'] ||
                prodNameExists[0].qap_new_file_name,
              qap_original_file_name: value['Product QAP\r\n(file)']
                ? await getFileNameFromUrl(value['Product QAP\r\n(file)'])
                : prodNameExists[0].qap_original_file_name,
              tds_new_file_name:
                value['Product TDS\r\n(file)'] ||
                prodNameExists[0].tds_new_file_name,
              tds_original_file_name: value['Product TDS\r\n(file)']
                ? await getFileNameFromUrl(value['Product TDS\r\n(file)'])
                : prodNameExists[0].tds_new_file_name
            };
            product = await productModel.updateProduct(
              productObj,
              prodNameExists[0].id
            );
            //After update product mappings are deleted
            // delete product approved by

            if (value['Vendor Approved By']) {
              await productModel.deleteProductApproveBy(prodNameExists[0].id);
              // let vendorApproveArray = value['Vendor Approved By'].split(',');
              let vendorApproveArray = [value['Vendor Approved By']];
              let vendorApproveArrayId = [];
              for (let index = 0; index < vendorApproveArray.length; index++) {
                const element = vendorApproveArray[index];
                let vendorApproveId = 0;
                let findVendorApprove =
                  await vendorapproveModel.findVendorApproveByName(element);
                if (findVendorApprove.length == 0) {
                  let vendorApproveObj = {
                    vendor_approve: element,
                    status: 1
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
                  product_id: prodNameExists[0].id,
                  vendor_approve_id: vendorApproveId
                });
              }
              await productModel.addProductApproveBy(
                vendorApproveArrayId,
                prodNameExists[0].id
              );
            }
          }

          // console.log('product ==>>>>>>>>', product);
          productId = product.id;
          if (value['Product Images\r\n(file)']) {
            let galleryImage = await productModel.getProductImages(
              productId,
              0
            );
            if (galleryImage.length > 0) {
              for await (const { new_image_name, id } of galleryImage) {
                await productModel.deleteProductImages(productId, 0, id);
              }
            }
          }

          if (value['Category']) {
            await productModel.deleteProductCategory(productId);
          }
        }
        if (productId > 0) {
          // Delete variants
          await productModel.deleteProductVariants(productId);
          if (value['Specification Key'] && value['Specification Value']) {
            let varientObj = {
              product_id: productId,
              variant_name: value['Specification Key'],
              variant_value: value['Specification Value']
            };
            // console.log(categoryObj);

            await productModel.createProductveriants(varientObj);
          }

          //approve by
          if (value['Vendor Approved By']) {
            // let vendorApproveArray = value['Vendor Approved By'].split(',');
            let vendorApproveArray = [value['Vendor Approved By']];
            let vendorApproveArrayId = [];
            for (let index = 0; index < vendorApproveArray.length; index++) {
              const element = vendorApproveArray[index];
              let vendorApproveId = 0;
              let findVendorApprove =
                await vendorapproveModel.findVendorApproveByName(element);
              if (findVendorApprove.length == 0) {
                let vendorApproveObj = {
                  vendor_approve: element,
                  status: 1
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
            await productModel.addProductApproveBy(
              vendorApproveArrayId,
              productId
            );
          }

          //return false;
          if (value['Category']) {
            let catNameExists = await productModel.topParentparentNameExists(
              value['Category']
            );
            console.log(catNameExists);
            let category_id = '';
            if (catNameExists.length > 0) {
              category_id = { id: catNameExists[0].id };
            } else {
              console.log('test--->', value['Category']);
              //  return false;
              let catObj = {
                title: value['Category'],
                parent_id: '0',
                slug:
                  value['Category'] == undefined
                    ? ''
                    : titleToSlug(value['Category']),
                status: '1',
                adm_id: req.user.id
              };
              category_id = await productModel.addCategory(catObj);
              // console.log('category_id--', category_id);
              // return false;
            }
            // Delete product category
            let categoryObj = {
              product_id: productId,
              category_name: value['Category'],
              category_id: category_id.id
            };
            await productModel.createProductCategory(categoryObj);
          }

          if (value['Product Featured Image\r\n(file)']) {
            let featuredImage = await productModel.getProductImages(
              productId,
              1
            );
            if (featuredImage.length > 0) {
              await productModel.deleteProductImages(
                productId,
                1,
                featuredImage[0].id
              );
            }

            let featuredImageObj = {
              product_id: productId,
              is_featured: 1,
              original_image_name: value['Product Featured Image\r\n(file)']
                ? await getFileNameFromUrl(
                    value['Product Featured Image\r\n(file)']
                  )
                : null,
              new_image_name: value['Product Featured Image\r\n(file)'] || null
            };
            await productModel.insertProductImages(featuredImageObj);
          }
          if (value['Product Images\r\n(file)']) {
            let featuredImageObj = {
              product_id: productId,
              is_featured: 0,
              original_image_name: value['Product Images\r\n(file)']
                ? await getFileNameFromUrl(value['Product Images\r\n(file)'])
                : null,
              new_image_name: value['Product Images\r\n(file)'] || null
            };
            await productModel.insertProductImages(featuredImageObj);
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
      // console.log(sheet);
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
          console.log('prodNameExists--->', prodNameExists);
          // return false;
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
  productList: async (req, res, next) => {
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
      let vendorId = req.query?.vendorId;
      let isFeatured = req.query?.isFeatured;
      let filterProduct = {};
      if (vendorApprove) {
        filterProduct = await productModel.getApprovedByProduct(vendorApprove);
      }

      let productList = await productModel.getProductList(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct,
        isFeatured
      );
      let productCount = await productModel.getProductCount(
        vendorId,
        productName,
        filterProduct,
        isFeatured
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
        let acceptReviewObj = {
          is_review: 0,
          updated_by: req.user.id
        };
        await productModel.adminProductAcceptReview(acceptReviewObj);
      } else {
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

      for await (const productId of products) {
        let productDetails = await productModel.vendorProductDetails(productId);

        let checkMasterNameExist = await productModel.checkMasterNameExist(
          productDetails[0].name
        );
        if (checkMasterNameExist.length == 0 && status == 1) {
          let productObj = {
            name: productDetails[0].name,
            description: productDetails[0].description,
            qap_new_file_name: productDetails[0].qap_new_file_name,
            qap_original_file_name: productDetails[0].qap_original_file_name,
            tds_new_file_name: productDetails[0].tds_new_file_name,
            tds_original_file_name: productDetails[0].tds_original_file_name,
            slug: titleToSlug(productDetails[0].name),
            availability: 0,
            sku: productDetails[0].name,
            created_by: 1,
            updated_by: 1,
            added_by: 1,
            is_approve: 1
          };

          let product = await productModel.createProduct(productObj);

          if (productDetails[0].vendor_approved_by.length > 0) {
            let productApproveArray = [];
            productDetails[0].vendor_approved_by.forEach((item) => {
              productApproveArray.push({
                product_id: product.id,
                vendor_approve_id: item
              });
            });
            await productModel.addProductApproveBy(
              productApproveArray,
              product.id
            );
          }

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
      }
      res
        .status(200)
        .json({
          status: 1,
          message: 'Review completed .Product added to product list'
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
  /*  exportProducts: async (req, res, next) => {
    try {
      const { product_id } = req.body;

      let prodList = await productModel.getExportProductList(product_id);
      if (prodList.length > 0) {
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
  }, */
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
        console.log('err ==>>>>>>>>>>>>>>>>>>', err);
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
      categories = JSON.parse(categories);
      variations = JSON.parse(variations);
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
      let productObj = {
        name: name,
        description: description || null,
        manufacturer: manufacturer || null,
        availability: availability || 0,
        slug: titleToSlug(name),
        sku: name,
        created_by: vendor || req.user.id,
        vendor: vendor || null,
        status: status || 1,
        // vendor_approved_by: vendorApproveId || null,
        is_featured: is_featured || 0,
        is_approve: 1,
        added_by: req.user.id,
        qap_new_file_name:
          req.files?.qap.length > 0
            ? `${Config.download_url}/product_image/${req.files.qap[0].filename}`
            : null,
        qap_original_file_name:
          req.files?.qap.length > 0 ? req.files.qap[0].originalname : null,
        tds_new_file_name:
          req.files?.tds.length > 0
            ? `${Config.download_url}/product_image/${req.files.tds[0].filename}`
            : null,
        tds_original_file_name:
          req.files?.tds.length > 0 ? req.files.tds[0].originalname : null
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
      }

      res
        .status(200)
        .json({
          status: 1,
          message: 'Product Added'
        })
        .end();
    } catch (err) {
      /* if (req.files?.featured && req.files?.featured.length > 0) {
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
      if (req.files?.qap && req.files?.qap.length > 0) {
        req.files.qap.forEach((file) => {
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
      } */
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
  approveProduct: async (req, res, next) => {
    try {
      let productId = req.params.id;
      let { status, reject_reason, reject_reason_id } = req.body;
      let reasonId = '';
      if (reject_reason_id && status == 0) {
        reasonId = reject_reason_id;
      } else if (!reject_reason_id && status == 0) {
        let checkRejectReason = await vendorModel.checkRejectReason(
          reject_reason
        );
        if (checkRejectReason.length > 0) {
          reasonId = checkRejectReason[0].id;
        } else {
          let reasonObj = {
            status: 1,
            reject_reason: reject_reason,
            type: 2
          };
          let createReason = await vendorModel.createReason(reasonObj);
          reasonId = createReason[0].id;
        }
      }

      let productObj = {
        is_approve: status,
        reject_reason_id: reasonId || null
      };

      let approveProduct = await productModel.approveProduct(
        productObj,
        productId
      );
      // clone product for admin

      let productDetails = await productModel.vendorProductDetails(productId);

      let checkMasterNameExist = await productModel.checkMasterNameExist(
        productDetails[0].name
      );
      if (checkMasterNameExist.length == 0 && status == 1) {
        let productObj = {
          name: productDetails[0].name,
          description: productDetails[0].description,
          qap_new_file_name: productDetails[0].qap_new_file_name,
          qap_original_file_name: productDetails[0].qap_original_file_name,
          tds_new_file_name: productDetails[0].tds_new_file_name,
          tds_original_file_name: productDetails[0].tds_original_file_name,
          slug: titleToSlug(productDetails[0].name),
          availability: 0,
          sku: productDetails[0].name,
          created_by: 1,
          updated_by: 1,
          added_by: 1,
          is_approve: 1
        };

        let product = await productModel.createProduct(productObj);

        if (productDetails[0].vendor_approved_by.length > 0) {
          let productApproveArray = [];
          productDetails[0].vendor_approved_by.forEach((item) => {
            productApproveArray.push({
              product_id: product.id,
              vendor_approve_id: item
            });
          });
          await productModel.addProductApproveBy(
            productApproveArray,
            product.id
          );
        }

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

      let userDetail = await vendorModel.userDetailById(
        approveProduct.created_by
      );
      let html_variables = [
        { name: userDetail[0].name },
        {
          message:
            status == 1
              ? `Your product ${approveProduct.name} has been approved`
              : `Your product ${approveProduct.name} has been rejected`
        }
      ];
      let dynamic_html = fs
        .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
        .toString();

      for (let index = 0; index < html_variables.length; index++) {
        const element = html_variables[index];
        let dynamic_key = Object.keys(element)[0];
        let replace_char = html_variables[index][dynamic_key];
        let replace_var = `[${dynamic_key.toLowerCase()}]`;

        dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
      }
      sendMail({
        from: Config.webmasterMail, // sender address
        to: userDetail[0].email, // list of receivers
        subject: `Work wise | Product`, // Subject line
        html: dynamic_html // plain text body
      });

      res
        .status(200)
        .json({
          status: 1,
          message: `Product successfully ${
            status == 0 ? 'Disapproved' : 'Approved'
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
  adminProductUpdate: async (req, res, next) => {
    try {
      console.log(req.files);
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

      categories = JSON.parse(categories);
      variations = JSON.parse(variations);

      if (approved_id) {
        approved_id = JSON.parse(approved_id);
      }

      let productId = req.params.id;

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
          vendorApproveId = createVendorApprove.id;
        } else {
          vendorApproveId = findVendorApprove[0].id;
        }
      } else {
        vendorApproveId = approved_id;
      }

      // ---------------- products ----------------

      let productDetails = await productModel.check_product(productId);
      let productObj = {
        name: name,
        description: description || null,
        manufacturer: manufacturer || null,
        availability: availability || 0,
        slug: titleToSlug(name),
        sku: name,
        updated_by: req.user.id,
        vendor: vendor || productDetails[0].vendor,
        status: status || 1,
        // vendor_approved_by: vendorApproveId || null,
        productId: productId,
        is_featured: is_featured || 0,
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

      await productModel.updateVendorProduct(productObj);
      // Delete variants
      await productModel.deleteProductVariants(productId);
      // Delete product category
      await productModel.deleteProductCategory(productId);
      // delete product approved by
      await productModel.deleteProductApproveBy(productId);

      // console.log('product ==>>>>>>>>', product);
      // let productId = product.id;
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
        let variantObj = {
          product_id: productId,
          variant_name: attribute,
          variant_value: attributeValue
        };
        // console.log(categoryObj);

        await productModel.createProductveriants(variantObj);
      }

      // -------------multiple approved by ------------------------------
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

      // ---------------- featured image ----------------
      if (req.files?.featured && req.files?.featured.length > 0) {
        let featuredImage = await productModel.getProductImages(productId, 1);
        if (featuredImage.length > 0) {
          /* fs.unlink(
            `${Config.upload.product_image}/${featuredImage[0].new_image_name}`,
            (unlinkError) => {
              if (unlinkError) {
                console.error('Error deleting file:', unlinkError);
              }
            }
          ); */
          await productModel.deleteProductImages(
            productId,
            1,
            featuredImage[0].id
          );
        }

        let featuredImageObj = {
          product_id: productId,
          is_featured: 1,
          original_image_name: req.files.featured[0].originalname,
          new_image_name: `${Config.download_url}/product_image/${req.files.featured[0].filename}`
        };
        await productModel.insertProductImages(featuredImageObj);
      }
      // ---------------- gallery image ----------------
      if (req.files?.gallery && req.files?.gallery.length > 0) {
        let galleryImage = await productModel.getProductImages(productId, 0);
        if (galleryImage.length > 0) {
          for await (const { new_image_name, id } of galleryImage) {
            /* fs.unlink(
              `${Config.upload.product_image}/${new_image_name}`,
              (unlinkError) => {
                if (unlinkError) {
                  console.error('Error deleting file:', unlinkError);
                }
              }
            ); */
            await productModel.deleteProductImages(productId, 0, id);
          }
        }

        for await (const { originalname, filename } of req.files?.gallery) {
          let featuredImageObj = {
            product_id: productId,
            is_featured: 0,
            original_image_name: originalname,
            new_image_name: `${Config.download_url}/product_image/${filename}`
          };
          await productModel.insertProductImages(featuredImageObj);
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
      /* if (req.files?.featured && req.files?.featured.length > 0) {
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

      let productList = await productModel.productDetails(productId);
      let vendorListProductWise = await productModel.vendorListProductWise(
        productList[0].name
      );
      res
        .status(200)
        .json({
          status: 1,
          data: productList[0],
          vendor_list: vendorListProductWise
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
  }
};
export default productController;
