import userModel from '../../models/userModel.js';
import productModel from '../../models/productModel.js';
import vendorapproveModel from '../../models/vendorapproveModel.js';
import Config from '../../config/app.config.js';
import {
  logError,
  currentDateTime,
  titleToSlug,
  generateOTPRandomNo,
  generateRandomString,
  createPay,
  sendMail,
  arraysHaveSameData
} from '../../helper/common.js';
import jwtHelper from '../../helper/jwtHelper.js';
import dateFormat from 'dateformat';
import Cryptr from 'cryptr';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { v4 } from 'uuid';
import excelJS from 'exceljs';
import xlsx from 'xlsx';

import JWT from 'jsonwebtoken';

import {
  schemas,
  validateBodyController
} from '../../validations/paramValidation/userValidation.js';
async function getAllData(products) {
  const promises = products.map(async (item) => {
    try {
      const data = await productModel.getUserDetail(item.created_by);
      item.user_detail = data;
      if (
        item.user_detail[0].new_profile_image == null ||
        item.user_detail[0].new_profile_image == ''
      ) {
        item.user_detail[0].image_url = '';
      } else {
        item.user_detail[0].image_url = item.user_detail[0].new_profile_image;
      }
      return item;
    } catch (error) {
      return item;
    }
  });
  return Promise.all(promises);
}
async function getAllVendorData(vendorList, product_name, cat_id, approve_by) {
  const promises = vendorList.map(async (item) => {
    try {
      const data = await productModel.getProductDetail(
        item,
        product_name,
        cat_id,
        approve_by
      );
      // console.log('data-->', data);
      item.product_detail = data;

      return item;
    } catch (error) {
      console.log('error--', error);
      //   return item;
      // return item;
    }
  });
  return Promise.all(promises);
}
const ProductsController = {
  getProductSearch: async (req, res, next) => {
    try {
      const { cat_id, product_name, approve_by } = req.body;
      let approveObj = {
        approve_by
      };

      let apprObj = Object.fromEntries(
        Object.entries(approveObj).filter(([key, value]) => value !== undefined)
      );
      let user_id = '';
      // console.log('approveObj-->', approveObj.approve_by);
      // return false;
      if (approveObj[0]?.approve_by != '') {
        // console.log('apprObj-->', apprObj);
        user_id = await productModel.getUserIdByApproveBy(
          approveObj[0]?.approve_by
        );
      }

      let productObj = {
        cat_id,
        product_name,
        user_id: user_id.user_id
      };

      let prdObj = Object.fromEntries(
        Object.entries(productObj).filter(([key, value]) => value !== undefined)
      );
      const products = await productModel.productSearch(prdObj);
      getAllData(products)
        .then((rsp) => {
          res
            .status(200)
            .json({
              status: 1,
              data: rsp
            })
            .end();
        })
        .catch((error) => console.error(`Error: ${error.message}`));
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
  getProductListbyCategory: async (req, res, next) => {
    try {
      let { cat_id, page, limit } = req.query;
      let offset = 0;

      if (page && page > 0) {
        limit = limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }

      // Check if category exists and its parent category
      const idExists = await productModel.categoryIDExist(cat_id);
      if (!idExists) {
        res
          .status(404)
          .json({
            status: 3,
            message: 'Category not exists...!'
          })
          .end();
      }

      const productList = await productModel.productSearchByCategory(
        cat_id,
        limit,
        offset
      );
     
      res
        .status(200)
        .json({
          status: 1,
          data: productList
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
  categoryList: async (req, res, next) => {
    try {
      let categoryList = await productModel.getCategoryListFront();

      res
        .status(200)
        .json({
          status: 1,
          data: categoryList
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
  parentCategoryList: async (req, res, next) => {
    try {

      const {slug } = req.query;
      let subcategories = null    

      const parentCategories = await productModel.getParentCategoryList();

        if (!slug || typeof slug !== "string" || slug != "all") {
          subcategories = await productModel.getSubCategory("",slug);
        }

      res
        .status(200)
        .json({
          status: 1,
          data: {parentCategories: parentCategories, subcategories: subcategories || []}
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
  vendorList: async (req, res, next) => {
    try {
      const { product_name, cat_id, approve_by } = req.body;
      let vendorList = await productModel.getVendorList();
      getAllVendorData(vendorList, product_name, cat_id, approve_by)
        .then((rsp) => {
          // console.log('Response--', rsp);
          let vendorFilter = vendorList.filter((itemss) => {
            if (itemss.product_detail.length > 0) {
              return itemss;
            }
          });
          res
            .status(200)
            .json({
              status: 1,
              data: rsp
            })
            .end();
        })
        .catch((error) => console.error(`Error: ${error.message}`));
      /*  res
        .status(200)
        .json({
          status: 1,
          data: vendorFilter
        })
        .end(); */
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
  vendorProductList: async (req, res, next) => {
    try {
      let vendorId = req.user.id;
      let page,
        limit,
        offset,
        products = [];
      if (req.query.page && req.query.page > 0) {
        page = req.query.page;
        limit = req.query.limit || Config.globalAdminLimit;
        offset = (page - 1) * limit;
      } else {
        limit = Config.globalAdminLimit;
        offset = 0;
      }
      let productName = req.query?.productName;
      let filterProduct = {};
      let vendorApprove = req.query?.vendorApprove;
      if (vendorApprove) {
        filterProduct = await productModel.getApprovedByProduct(vendorApprove);
        console.log("FILTER PROD --------- ", filterProduct)
      }
      if (req.query?.download == 'true' && req.query?.downloadAll === 'true') {
        offset = 0;
        limit = 'ALL';
      }
      if (req.query?.download == 'true' && req.query?.product_ids) {
        products = JSON.parse(req.query.product_ids);
      }

      let productList = await productModel.getVendorProductList(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct,
        products
      );
      let productCount = await productModel.getVendorProductCount(
        vendorId,
        productName,
        filterProduct
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Products');

        // Add headers
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

        let counter = 1;

        productList.forEach((prod) => {
          prod.s_no = counter;
          prod.availability =
            prod.availability == 1 ? 'Available' : 'Not Available';
          prod.status = prod.status == 1 ? 'Active' : 'Not active';
          prod.category = prod.product_categories?.[0]?.category_name || '';
          prod.specification_Key = prod.product_variants?.[0]?.variant_name || '';
          prod.vendor_approve =
            prod.product_approve_by.length > 0
              ? prod.product_approve_by
                  .map((item) => item.vendor_approve_name)
                  .join(',')
              : '';
          prod.specification_value =
            prod.product_variants?.[0]?.variant_value || '';
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
              if (prod.product_variants?.[index]?.variant_name) {
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

        // Set content type and disposition
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=products.xlsx'
        );

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: productList,
            total_count: productCount.count
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
  vendorProductListReview: async (req, res, next) => {
    try {
      let vendorId = req.user.id;
      let page,
        limit,
        offset,
        products = [];
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
      if (req.query?.download == 'true' && req.query?.downloadAll === 'true') {
        offset = 0;
        limit = 'ALL';
      }
      if (req.query?.download == 'true' && req.query?.product_ids) {
        products = JSON.parse(req.query.product_ids);
      }

      let productList = await productModel.vendorProductListReview(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct,
        products
      );
      let productCount = await productModel.getVendorReviewProductCount(
        vendorId,
        productName,
        filterProduct
      );

      if (req.query.download == 'true') {
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Products');

        // Add headers
        worksheet.columns = [
          { header: 'S no.', key: 's_no', width: 5 },
          { header: 'Name', key: 'name', width: 20 },
          { header: 'Manufacturer', key: 'manufacturer', width: 20 },
          { header: 'Slug', key: 'slug', width: 20 },
          { header: 'Approved By', key: 'vendor_approve', width: 20 },
          { header: 'Availability', key: 'availability', width: 20 },
          { header: 'Status', key: 'status', width: 20 }
        ];

        let counter = 1;

        productList.forEach((prod) => {
          prod.s_no = counter;
          prod.availability =
            prod.availability == 1 ? 'Available' : 'Not Available';
          prod.status = prod.status == 1 ? 'Active' : 'Not active';
          prod.vendor_approve =
            prod.product_approve_by.length > 0
              ? prod.product_approve_by
                  .map((item) => item.vendor_approve_name)
                  .join(',')
              : '';
          worksheet.addRow(prod); // Add data in worksheet

          counter++;
        });

        // Making first line in excel bold
        worksheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true };
        });

        // Set content type and disposition
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename=productsReview.xlsx'
        );

        // Write workbook to response
        workbook.xlsx.write(res).then(() => {
          res.end();
        });
      } else {
        res
          .status(200)
          .json({
            status: 1,
            data: productList,
            total_count: productCount.count
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
  vendorProductAcceptReview: async (req, res, next) => {
    try {
      let vendorId = req.user.id;
      let { products, all } = req.body;
      if (all == true) {
        let acceptReviewObj = {
          is_review: 0,
          updated_by: vendorId
        };
        await productModel.vendorProductAcceptReview(acceptReviewObj, vendorId);
      } else {
        for await (const productId of products) {
          let acceptReviewObj = {
            is_review: 0,
            updated_by: vendorId
          };
          await productModel.vendorProductAcceptReview(
            acceptReviewObj,
            vendorId,
            productId
          );
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
  vendorProductAdd: async (req, res, next) => {
    try {
      const vendorId = req.user.id;

      let {
        name,
        description,
        categories,
        status,
        approved_id,
        approved_name,
        master_id
      } = req.body;

      const productResult = await productModel.getProductByVariant(master_id)
      let productId = productResult?.[0]?.id

      if (approved_id) {
        if (typeof approved_id === 'string') {
          approved_id = JSON.parse(approved_id);
        }
        // Ensure it's an array of numbers
        else if (!Array.isArray(approved_id)) {
          approved_id = [approved_id];
        }
      }

      let vendorApproveId = [];
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

      let mappingObj = {
        product_variant_id: master_id,
        vendor_id: vendorId,
        is_approved: false,
        created_by: req.user.id,
        updated_by: req.user.id,
        approved_at: (new Date()).toISOString(),
      }

      let mappingResult = await productModel.createProductVariantVendorMapping(mappingObj)

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
  vendorProductUpdate: async (req, res, next) => {
    try {
      const vendorId = req.user.id;
      
      let {
        approved_id,
        approved_name
      } = req.body;
      
      if (approved_id) {
        approved_id = JSON.parse(approved_id);
      }
      
      let variantId = req.params.id;
      let productResult = await productModel.getProductByVariant(variantId)
      let productId = productResult?.[0]?.id

      let vendorApproveId = [];
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

      let mappingResult = await productModel.checkVariantExistsForVendor(vendorId, variantId)
      mappingResult = mappingResult?.[0]

      if (vendorApproveId.length > 0 && mappingResult) {
        // First delete all the previous approvedBy Mapping for user
        await productModel.deletePreviousApprovedByMapping(vendorId, variantId);

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
  productBulkUpload: async (req, res, next) => {
    try {
      let file = req.file;
      let err = 0;
      let errors = {};
      // return false;
      //userExist

      const excelHeaders = [
        'Product Name',
        'Vendor Approved By',
        'Category',
        'Product Brochure\r\n(file)'
      ];

      const workbook = xlsx.readFile(file.path); // Replace 'example.xlsx' with your Excel file name
      // console.log('workbook==>>>>>>>>', workbook);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const firstHeaderData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      let headerCheck = await arraysHaveSameData(
        excelHeaders,
        firstHeaderData[0]
      );
      // console.log('headerCheck====', headerCheck);
      console.log(excelHeaders, firstHeaderData[0]);
      if (!headerCheck) {
        err++;
        errors.message = 'Download the sample Excel and check all column name';

        res
          .status(400)
          .json({
            status: 2,
            errors: errors
          })
          .end();

        return;
      }

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
      let vendor_id = req.user.id;
      let isMaster = 0;
      let previousCategory = '';

      for await (const [index, value] of jsonData.entries()) {
        // console.log('product==========>>>>>>>>', index, value);
        if (value['Product Name'] && headerCheck) {
          // check vendor exist or not
          previousCategory = '';
          let check_master_exist = await productModel.checkMasterNameExist(
            value['Product Name']
          );
          if (check_master_exist.length == 0) {
            isMaster = 0;
            let prodNameExists = await productModel.checkProductExists(
              value['Product Name'],
              vendor_id
            );
            //    console.log('prodNameExists--->', prodNameExists);
            // return false;
            let productObj = '';

            if (prodNameExists && prodNameExists.length == 0) {
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
                created_by: req.user.id,
                vendor: vendor_id,
                is_review: 1,
                is_approve: 0,
                added_by: req.user.id,
                brochure_file: value['Product Brochure\r\n(file)'] || null
              };
              product = await productModel.createProduct(productObj);

              //  await productModel.createProduct(productObj);
            } else {
              productObj = {
                description: value['Product description'] || null,
                manufacturer: value['Manufacturer'] || null,
                availability:
                  value['Product Availability'] == 'Available' ? 1 : 0,
                slug: titleToSlug(value['Product Name']),
                sku: value['Product Name'],
                // vendor_approved_by: vendorApproveId == 0 ? null : vendorApproveId,
                status: 1,
                created_by: req.user.id,
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
              //After update product mappings are deleted
              // delete product approved by
              await productModel.deleteProductApproveBy(prodNameExists[0].id);
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
          } else {
            isMaster = 1;
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
              created_by: req.user.id,
              added_by: req.user.id,
              is_approve: 1
            };

            let product = await productModel.createProduct(productObj);

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
                adm_id: vendor_id
              };
              category_id = await productModel.addCategory(catObj);
              // console.log('category_id--', category_id);
              // return false;
            }
            // Delete product category
            await productModel.deleteProductCategory(productId);
            let categoryObj = {
              product_id: productId,
              category_name: value['Category'],
              category_id: category_id.id
            };
            previousCategory = category_id.id;
            await productModel.createProductCategory(categoryObj);
            categoryCount++;
          }
          if (previousProductId != productId) {
            previousProductId = productId;
            categoryCount = 0;
          }
        }
      }
      if (err == 0) {
        res
          .status(200)
          .json({
            status: 1,
            message: 'Product Added'
          })
          .end();
      } else {
        console.log('productArray==>>>>', productArray);
        for await (let id of productArray) {
          if (id != 0) {
            let productObj = {
              is_deleted: 1,
              updated_by: req.user.id
            };

            await productModel.deleteProduct(productObj, id);

            await productModel.deleteProductCategory(id);
            await productModel.deleteProductVariants(id);
          }
        }
        res
          .status(400)
          .json({
            status: 2,
            errors: errors
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
  vendorProductDetails: async (req, res, next) => {
    try {
      let productId = req.params.id;

      let productList = await productModel.vendorProductDetails(productId);
      res
        .status(200)
        .json({
          status: 1,
          data: productList[0]
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
  vendorProductDelete: async (req, res, next) => {
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
  approvedProductList: async (req, res, next) => {

    // change by mukul (11-04-2025), removed req.user.id from getProductList parameters and in response replaced productCount.length with productCount[0]?.count

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

      // @getProductList(limit, offset, vendorId, productName, filterProduct, isFeatured, addedBy, categoryId, dateFrom, dateTo, is_approve)
      let productList = await productModel.getProductList(
        limit,
        offset,
        vendorId,
        productName,
        filterProduct,
        isFeatured,
      );

      // getProductCount(vendorId, productName, filterProduct, isFeatured, userId, categoryId, dateFrom, dateTo, is_approve)
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
          total_count: productCount[0]?.count || 0
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
  // not in use delete this ASAP, after reviewing all the code
  searchProductsByCategory: async (req, res, next) => {
    try {
      const { product_id, category_id } = req.query;

      if (!product_id && !category_id) {
        return res
          .status(400)
          .json({ error: 'Either product_id or category_id is required.' })
          .end();
      }

      let response;

      if (category_id) {
        response = await productModel.getProductBycategory(category_id);

        console.log("-------------------------->",response);
      } else if (product_id) {
        response = await productModel.getProductById(product_id);
      }

      if (!response || response.length === 0) {
        return res.status(404).json({ error: 'No products found.' }).end();
      }

      return res.status(200).json({ status: 1, data: response }).end();
    } catch (error) {
      console.error('Error in searchProductsByCategory:', error);
      return res
        .status(500)
        .json({ error: 'Internal server error. Please try again later.' })
        .end();
    }
  },

  getProductBySlugAndCategorySlug: async (req, res, next) => {
    try {
      const { productSlug } = req.query;

      if (!productSlug) {
        return res
          .status(400)
          .json({ error: 'Either productSlug is required.' })
          .end();
      }

      const productData = await productModel.getProductBySlugAndCategorySlug(productSlug)
      const productImages = await productModel.getProductImages(productData?.product_id, 0)
      const productSpec = await productModel.getProductTechSpecByID(productData?.product_id)
      const result = {
        productData: productData,
        productImages: productImages,
        productSpec: productSpec
      }

      return res.status(200).json({ status: 1, data: result }).end();
      
    } catch (error) {
      console.error('Error in searchProductsByCategory:', error);
      return res
        .status(500)
        .json({ error: 'Internal server error. Please try again later.' })
        .end();
    }
  }

};
export default ProductsController;
