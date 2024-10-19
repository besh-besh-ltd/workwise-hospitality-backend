import db from '../config/dbConn.js';
import pgp from 'pg-promise';
import Config from '../config/app.config.js';

const productModel = {
  parentIdExists: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_category where id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  parentNameExists: async (name, parent_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_category where title = $1 AND is_deleted = 0 AND parent_id = $2',
        [name, parent_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  topParentparentNameExists: async (name) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_category where title = $1 ', [name])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  topParentparentCatExists: async (name, parentId) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_category where title = $1 AND parent_id = $2', [
        name,
        parentId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  categorySlugExists: async (slug) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_category where slug = $1 AND is_deleted = 0', [
        slug
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  categorySlugUpdateExists: async (slug, cat_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'select * from tbl_category where slug = $1 AND is_deleted = 0 AND id != $2',
        [slug, cat_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  addCategory: async (catObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `insert into tbl_category(title, slug, parent_id, status,created_by) 
        values($1, $2, $3, $4, $5) returning id`,
        [
          catObj.title,
          catObj.slug,
          catObj.parent_id,
          catObj.status,
          catObj.adm_id
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          //	var errorText = common.getErrorText(err);
          //	var error = new Error(errorText);
          //		reject(error);
          reject(err);
        });
    });
  },

  getCategoryList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select TC.*,
        ARRAY
        (SELECT json_build_object('sub_category_id', tcm.id,'category_name',parent_cat.title )
          FROM tbl_category tcm, tbl_category parent_cat 
          WHERE  tcm.id = parent_cat.parent_id AND tcm.id =TC.id  group by tcm.id,parent_cat.title) AS "sub_category"  
          from tbl_category TC where TC.is_deleted !='1'  order by title asc limit ${limit} offset $1`,
        [offset]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorList: async (product_name) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT U.id,U.name as vendor_name,U.email,U.created_by,U.address,U.new_profile_image, C.profile as about, C.website,C.company_name, F.file_path as ptr_file,
        CASE
        WHEN U.new_profile_image IS NULL THEN
        NULL
        ELSE U.new_profile_image
        END AS image_url,
        ARRAY
        (SELECT json_build_object('vendor_approve',va.vendor_approve )
          FROM tbl_vendorapprove_user_mapping ucm, tbl_vendor_approve va 
          WHERE ucm.user_id = U.id AND ucm.vendor_approve_id = va.id  group by U.id,va.id) AS "vendor_approved" 
       
        FROM tbl_users U 
        LEFT JOIN tbl_company C ON C.user_id = U.id
        LEFT JOIN tbl_files F ON  U.id = F.user_id  AND F.doc_type = 'ptr'
         WHERE U.user_type = '3'  `
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCategoryListFront: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select TC.*,
        ARRAY
        (SELECT json_build_object('sub_category_id', tcm.id,'category_name',parent_cat.title )
          FROM tbl_category tcm, tbl_category parent_cat 
          WHERE  tcm.id = parent_cat.parent_id AND tcm.id =TC.id  group by tcm.id,parent_cat.title) AS "sub_category"  
          from tbl_category TC  order by title asc `
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  delete_category: async (cat_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_category set 
				is_deleted = '1'
       	where id=($1)`,
        [cat_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  getCategoryDropdown: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *  FROM tbl_category WHERE is_deleted = 0 
        ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCategoryListCount: async () => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT *  FROM tbl_category WHERE is_deleted = 0`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  categoryIDExist: async (categoryId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_category WHERE id = $1 AND is_deleted = 0', [
        categoryId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  categoryActiveIDExist: async (categoryId) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_category WHERE id = $1', [categoryId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },

  /* categoryTitleExist: async (title) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_category WHERE title = $1 AND is_deleted = 0', [
        title
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }, */
  categoryTitleExist: async (title, categoryId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_category WHERE title = $1 AND is_deleted = 0 AND id != $2',
        [title, categoryId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  topParentcategoryTitleExist: async (title) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_category WHERE title = $1 AND is_deleted = 0', [
        title
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getCategoryDetails: async (categoryId) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_category WHERE is_deleted = 0 AND id = $1`, [
        categoryId
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateCategory: async (catObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `update 
				tbl_category set 
				title = ($1),
				slug = ($2),
				parent_id = ($3),
				status = ($4),
				updated_by = ($5)
       	where id=($6)`,
        [
          catObj.title,
          catObj.slug,
          catObj.parent_id,
          catObj.status,
          catObj.adm_id,
          catObj.categoryId
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  attributeList: async (limit, offset) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT *  FROM tbl_attributes
        ORDER BY id DESC LIMIT ${limit} OFFSET $1`,
        [offset]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  attributeListCount: async () => {
    return new Promise(function (resolve, reject) {
      db.one(`SELECT COUNT(id) FROM tbl_attributes`)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  attributeIdExists: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_attributes WHERE id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  attributeDetails: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT tbl_attributes.*,
      ARRAY
      (SELECT json_build_object('id', tbl_attribute_values.id,'attribute_value',tbl_attribute_values.attribute_value)
        FROM tbl_attribute_values 
        WHERE tbl_attributes.id = tbl_attribute_values.attribute_id) AS "attributes_values"
      FROM tbl_attributes WHERE id = $1`,
        [id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createAttributeValue: async (attributeValueObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `INSERT INTO tbl_attribute_values(attribute_id, attribute_value, created_by) 
        VALUES($1, $2, $3) RETURNING id`,
        [
          attributeValueObj.attribute_id,
          attributeValueObj.attribute_value,
          attributeValueObj.adm_id
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateAttributeValue: async (attributeValueObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `UPDATE  
				tbl_attribute_values set 
				attribute_value = ($1),
				updated_by = ($3)
       	WHERE id=($4) AND attribute_id=($2) RETURNING id`,
        [
          attributeValueObj.attribute_value,
          attributeValueObj.attribute_id,
          attributeValueObj.adm_id,
          attributeValueObj.attribute_value_id
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  createProduct: async (productObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(productObj, null, 'tbl_product') + ' RETURNING id';

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
  addProductApproveBy: async (productApproveArray, productId) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const { ColumnSet } = pgp().helpers;
      const cs = new ColumnSet(['product_id', 'vendor_approve_id'], {
        table: 'tbl_vendorapprove_product_mapping'
      });
      const query = pgp().helpers.insert(productApproveArray, cs);

      db.none(query)
        .then(function (data) {
          resolve();
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateProduct: async (productObj, productId) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;
      const values = [productId];
      let query =
        pgp().helpers.update(productObj, null, 'tbl_product') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });

    /* return new Promise(function (resolve, reject) {
      db.one(
        `update 
				tbl_product set 
				description = ($1),
				manufacturer = ($2),
				availability = ($3),
				slug = ($4),
				sku = ($5),
				vendor_approved_by = ($6),
				status = ($7),
				created_by = ($8),
				vendor = ($9),
        is_review = ($11),
        is_approve = ($12),
        brochure_file=($13)
       	where id=($10) 
        RETURNING id`,
        [
          productObj.description,
          productObj.manufacturer,
          productObj.availability,
          productObj.slug,
          productObj.sku,
          productObj.vendor_approved_by,
          productObj.status,
          productObj.created_by,
          productObj.vendor,
          productObj.product_id,
          productObj.is_review || 0,
          productObj.is_approve,
          productObj.brochure_file
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    }); */
  },
  updateVendorProduct: async (productObj) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `update 
				tbl_product set 
				description = ($1),
				manufacturer = ($2),
				availability = ($3),
				slug = ($4),
				sku = ($5),
				status = ($6),
				updated_by = ($7),
				vendor = ($8),
        name = ($9),
        qap_new_file_name = ($11),
        qap_original_file_name = ($12),
        tds_new_file_name = ($13),
        tds_original_file_name = ($14),
        is_featured = ($15)
       	where id=($10) 
        RETURNING id`,
        [
          productObj.description,
          productObj.manufacturer,
          productObj.availability,
          productObj.slug,
          productObj.sku,
          productObj.status,
          productObj.updated_by,
          productObj.vendor,
          productObj.name,
          productObj.productId,
          productObj.qap_new_file_name,
          productObj.qap_original_file_name,
          productObj.tds_new_file_name,
          productObj.tds_original_file_name,
          productObj.is_featured
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          // var errorText = common.getErrorText(err);
          // var error = new Error(errorText);
          reject(err);
        });
    });
  },
  createProductveriants: async (variantObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantObj, null, 'tbl_product_variants') +
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
  deleteProductVariants: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `DELETE FROM tbl_product_variants
        WHERE product_id = $1`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  createProductCategory: async (categoryObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(categoryObj, null, 'tbl_product_categories') +
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
  deleteProductCategory: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `DELETE FROM tbl_product_categories
        WHERE product_id = $1`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  deleteProductApproveBy: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `DELETE FROM tbl_vendorapprove_product_mapping
        WHERE product_id = $1`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        });
    });
  },
  createProductCategories: async (categoryObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(categoryObj, null, 'tbl_product_categories') +
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
  createProductAttribute: async (attributeObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(attributeObj, null, 'tbl_product_attributes') +
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
  createProductAttributeValue: async (attributeValuesObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(
          attributeValuesObj,
          null,
          'tbl_product_attribute_values'
        ) + ' RETURNING id';

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
  createProductVariantOptions: async (variantOptionsObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantOptionsObj, null, 'tbl_variant_options') +
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
  createProductVariant: async (variantObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantObj, null, 'tbl_variants') +
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
  getAttributeValue: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any('SELECT * FROM tbl_attribute_values WHERE id = $1', [id])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductAttribute: async (attributeId, productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_product_attributes WHERE product_id = $1 AND attribute_id = $2',
        [productId, attributeId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductAttributeValue: async (productAttributeId, attributeId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT * FROM tbl_product_attribute_values WHERE product_attribute_id = $1 AND attribute_value_id = $2',
        [productAttributeId, attributeId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkProductExists: async (
    name,
    vendorId = null,
    productId = null,
    added_by = null
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (vendorId) {
        dynamicQuery += `AND vendor = ${vendorId}`;
      }
      if (productId) {
        dynamicQuery += `AND id != ${productId}`;
      }
      if (added_by) {
        dynamicQuery += `AND added_by = ${added_by} AND created_by = ${added_by}`;
      }
      db.any(`SELECT * FROM tbl_product WHERE name = $1 ${dynamicQuery}`, [
        name
      ])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkMasterNameExist: async (name, productId) => {
    let dynamicQuery = '';
    if (productId) {
      dynamicQuery += `AND id != ${productId}`;
    }
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_product WHERE name = $1 AND created_by = 1 ${dynamicQuery}`,
        [name]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductImages: async (productId, isFeatured) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_product_images WHERE product_id = $1 AND is_featured =  $2`,
        [productId, isFeatured]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  deleteProductImages: async (productId, isFeatured, id = null) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (id) {
        dynamicQuery += `AND id= ${id}`;
      }
      db.any(
        `DELETE from tbl_product_images WHERE product_id =($1) AND is_featured=($2) ${dynamicQuery}`,
        [productId, isFeatured]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  insertVariantValue: async (variantValueObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantValueObj, null, 'tbl_variant_values') +
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
  insertProductImages: async (variantValueObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(variantValueObj, null, 'tbl_product_images') +
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
  getApprovedByProduct: async (approveId) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT STRING_AGG(product_id::TEXT, ',') AS id_array FROM tbl_vendorapprove_product_mapping WHERE vendor_approve_id = $1`,
        [approveId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductList: async (
    limit,
    offset,
    vendorId,
    productName,
    filterProduct,
    isFeatured
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND PD.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND PD.created_by = '${vendorId}'`;
      }
      if (isFeatured && isFeatured != '') {
        dynamicQuery += ` AND PD.is_featured = '${isFeatured}'`;
      }
      db.any(
        `SELECT PD.*,USERS.name as vendor_name,trr.reject_reason,tpi.new_image_name,
        ARRAY
        (SELECT json_build_object('category_name',  tc.title,'id',tc.id )
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id
          WHERE PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants"
            FROM tbl_product PD 
            LEFT JOIN tbl_users USERS ON PD.created_by = USERS.id 
            LEFT JOIN tbl_reject_reason trr ON PD.reject_reason_id = trr.id
            LEFT JOIN tbl_product_images tpi ON PD.id = tpi.product_id AND tpi.is_featured = 1
            WHERE USERS.is_deleted = 0 AND PD.is_deleted = 0 AND PD.is_review = 0 ${dynamicQuery}     
        ORDER BY PD.created_at DESC LIMIT ${limit} OFFSET $1`,
        [offset]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getExportProductList: async (product_id) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';

      if (product_id != '') {
        dynamicQuery += `WHERE PD.id IN (${product_id})`;
      }
      db.any(
        `SELECT PD.*,
        ARRAY
        (SELECT json_build_object('category_name', pc.category_name,'id',pc.id )
          FROM tbl_product_categories pc WHERE  PD.id = pc.product_id) AS "product_categories",
          ARRAY
        (SELECT json_build_object('vendor_approve_name', tva.vendor_approve,'id',tva.id )
          FROM tbl_vendorapprove_product_mapping tvpm 
        LEFT JOIN tbl_vendor_approve tva ON tvpm.vendor_approve_id = tva.id
        WHERE PD.id = tvpm.product_id) AS "product_approve_by",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants"  
          FROM tbl_product PD ${dynamicQuery}
        ORDER BY PD.name ASC`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductCount: async (vendorId, productName, filterProduct, isFeatured) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND tbl_product.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND tbl_product.id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND tbl_product.created_by = '${vendorId}'`;
      }
      if (isFeatured && isFeatured != '') {
        dynamicQuery += ` AND tbl_product.is_featured = '${isFeatured}'`;
      }
      db.any(
        `select * from tbl_product
      LEFT JOIN tbl_users USERS ON tbl_product.created_by = USERS.id 
      WHERE USERS.is_deleted = 0 AND tbl_product.is_deleted = 0 AND tbl_product.is_review = 0 ${dynamicQuery}`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  adminProductListReview: async (
    limit,
    offset,
    vendorId,
    productName,
    filterProduct
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND PD.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND PD.created_by = '${vendorId}'`;
      }
      db.any(
        `SELECT PD.*,USERS.name as vendor_name,
        ARRAY
        (SELECT json_build_object('category_name',  tc.title,'id',tc.id )
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id
          WHERE PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
          ARRAY
        (SELECT json_build_object('vendor_approve_name', tva.vendor_approve,'id',tva.id )
          FROM tbl_vendorapprove_product_mapping tvpm 
        LEFT JOIN tbl_vendor_approve tva ON tvpm.vendor_approve_id = tva.id
        WHERE PD.id = tvpm.product_id) AS "product_approve_by",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants"
            FROM tbl_product PD 
            LEFT JOIN tbl_users USERS ON PD.created_by = USERS.id 
            WHERE USERS.is_deleted = 0 AND PD.is_deleted = 0 AND PD.is_review = 1 ${dynamicQuery}     
        ORDER BY PD.created_at DESC LIMIT ${limit} OFFSET $1`,
        [offset]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAdminProductListReviewCount: async (
    vendorId,
    productName,
    filterProduct
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND PD.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND PD.created_by = '${vendorId}'`;
      }
      db.any(
        `select * from tbl_product
      LEFT JOIN tbl_users USERS ON tbl_product.created_by = USERS.id 
      WHERE USERS.is_deleted = 0 AND tbl_product.is_deleted = 0 AND tbl_product.is_review = 1 ${dynamicQuery}`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  /*  productSearch: async (cat_id, product_name, approve_by) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (product_name && product_name != '') {
        dynamicQuery += `AND P.name LIKE '%${product_name}%'`;
      }
      if (approve_by && approve_by != '') {
        dynamicQuery += `AND P.created_by = '${approve_by}'`;
      }

      db.any(
        `SELECT PC.*,C.title, P.name as product_name,
        ARRAY
        (SELECT json_build_object('category_name', TC.title,'id',TC.id,'product_name', PD.name )
          FROM tbl_category TC 
          LEFT JOIN tbl_product_categories PCC ON TC.id = PCC.category_id 
          LEFT JOIN tbl_product PD ON PD.id = PCC.product_id 
          WHERE  C.parent_id = TC.id) AS "child_category"
        FROM tbl_product_categories PC 
         LEFT JOIN tbl_product P ON PC.product_id = P.id 
         LEFT JOIN tbl_category C ON PC.category_id = C.id 
         WHERE PC.category_id = $1 ${dynamicQuery}`,
        [cat_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }, */
  /*  productSearch: async (prdObj) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (prdObj.product_name && prdObj.product_name != '') {
        dynamicQuery += ` AND P.name LIKE '%${prdObj.product_name}%'`;
      }
      if (prdObj.user_id && prdObj.user_id != '') {
        dynamicQuery += ` AND P.created_by = '${prdObj.user_id}'`;
      }
      if (prdObj.cat_id && prdObj.cat_id != '') {
        dynamicQuery += ` AND PC.category_id = '${prdObj.cat_id}'`;
      }

      db.any(
        `SELECT DISTINCT P.id as product_id,PC.*,C.title as category_name, P.name as product_name,P.description,P.created_by
        FROM tbl_product P  
         LEFT JOIN tbl_product_categories PC ON P.id = PC.product_id AND PC.id = (  SELECT id FROM tbl_product_categories 
          WHERE P.id = tbl_product_categories.product_id 
          LIMIT 1
       )
         LEFT JOIN tbl_category C ON PC.category_id = C.id 
         WHERE P.status = '1' ${dynamicQuery}`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }, */
  productSearch: async (prdObj) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (prdObj.product_name && prdObj.product_name != '') {
        dynamicQuery += ` AND P.name LIKE '%${prdObj.product_name}%'`;
      }
      if (prdObj.user_id && prdObj.user_id != '') {
        dynamicQuery += ` AND P.created_by = '${prdObj.user_id}'`;
      }
      if (prdObj.cat_id && prdObj.cat_id != '') {
        dynamicQuery += ` AND C.id = '${prdObj.cat_id}'`;
      }

      db.any(
        `SELECT DISTINCT P.id as product_id, C.title as category_name, P.name as product_name,P.description,P.created_by
        FROM tbl_product P  
         LEFT JOIN tbl_product_categories PC ON P.id = PC.product_id 
         LEFT JOIN tbl_category C ON PC.category_id = C.id 
         WHERE P.status = '1' ${dynamicQuery}`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  /* getUserDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT U.name,U.email,U.address,U.new_profile_image,TC.website, TC.profile FROM tbl_users U
        LEFT JOIN tbl_company TC ON U.id = TC.user_id
        WHERE id = $1`,
        [user_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }, */
  getUserDetail: async (user_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT U.name,U.email,U.address,U.new_profile_image,TC.website, TC.profile FROM tbl_users U
        LEFT JOIN tbl_company TC ON U.id = TC.user_id
        WHERE U.id = $1`,
        [user_id]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getUserIdByApproveBy: async (approve_by) => {
    return new Promise(function (resolve, reject) {
      db.any(
        'SELECT user_id FROM tbl_vendorapprove_user_mapping WHERE vendor_approve_id = $1',
        [approve_by]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getProductDetail: async (item, product_name, cat_id, approve_by) => {
    console.log('item--', item);
    console.log('product_name--', product_name);
    console.log('cat_id--', cat_id);
    console.log('approve_by--', approve_by);
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (product_name && product_name != '') {
        dynamicQuery += ` AND P.name LIKE '%${product_name}%'`;
      }
      if (approve_by && approve_by != '') {
        dynamicQuery += ` AND P.vendor_approved_by = '${approve_by}'`;
      }
      if (cat_id && cat_id != '') {
        dynamicQuery += ` AND tbc.category_id = '${cat_id}'`;
      }
      db.any(
        `SELECT P.id, P.name,tbc.category_id FROM tbl_product P 
        LEFT JOIN tbl_product_categories tbc ON P.id = tbc.product_id
        WHERE P.created_by = ${item.id} ${dynamicQuery}`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  vendor_register: async (usrobj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(usrobj, null, 'tbl_users') + ' RETURNING id';

      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });

      /*  db.any(
        `insert into tbl_users(name, email,address, user_type, password, status) 
        values($1, $2,$3,$4,$5,$6) returning id`,
        [
          usrobj.name,
          usrobj.email,
          usrobj.address,
          usrobj.user_type,
          usrobj.password,
          usrobj.status
        ]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        }); */
    });
  },
  addCompany: async (companyObj) => {
    return new Promise(function (resolve, reject) {
      const query =
        pgp().helpers.insert(companyObj, null, 'tbl_company') + ' RETURNING id';

      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  addFile: async (fileObj) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_files WHERE doc_type = '${fileObj.doc_type}' AND user_id = '${fileObj.user_id}'`
      )
        .then(function (file) {
          if (file.length > 0) {
            const condition = ` WHERE id = '${file[0].id}' RETURNING id`;
            // const values = [userObj.email];
            let query =
              pgp().helpers.update(fileObj, null, 'tbl_files') + condition;

            db.any(query)
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
          } else {
            const query =
              pgp().helpers.insert(fileObj, null, 'tbl_files') +
              ' RETURNING id';

            db.any(query)
              .then(function (data) {
                resolve(data);
              })
              .catch(function (err) {
                let error = new Error(err);
                reject(error);
              });
          }
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  updateVendorDetail: async (userObj) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE email = '${userObj.email}' RETURNING id`;
      // const values = [userObj.email];
      let query = pgp().helpers.update(userObj, null, 'tbl_users') + condition;
      console.log('query--', query);

      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });

      /* db.any(
        `update 
				tbl_users set 
				name = ($1),
				address = ($3)
       	where email=($2)`,
        [userObj.name, userObj.email, userObj.address]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          reject(err);
        }); */
    });
  },
  updateCompany: async (companyObj) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE user_id = $1 RETURNING id`;
      const values = [companyObj.user_id];
      let query =
        pgp().helpers.update(companyObj, null, 'tbl_company') + condition;

      db.any(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  checkVendorExist: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_users  WHERE email = $1`, [email])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorProductList: async (
    limit,
    offset,
    vendorId,
    productName,
    filterProduct,
    products
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND PD.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
      if (products && products.length > 0) {
        dynamicQuery += `AND PD.id IN (${products})`;
      }
      db.any(
        `SELECT PD.*,tva.vendor_approve,trr.reject_reason,
        ARRAY
        (SELECT json_build_object('category_name', tc.title,'id',tc.id )
          FROM tbl_product_categories pc 
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id
          WHERE PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
          ARRAY
        (SELECT json_build_object('vendor_approve_name', tva.vendor_approve,'id',tva.id )
          FROM tbl_vendorapprove_product_mapping tvpm 
        LEFT JOIN tbl_vendor_approve tva ON tvpm.vendor_approve_id = tva.id
        WHERE PD.id = tvpm.product_id) AS "product_approve_by",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants"  
          FROM tbl_product PD 
          LEFT JOIN tbl_vendor_approve tva ON PD.vendor_approved_by = tva.id
           LEFT JOIN tbl_reject_reason trr ON PD.reject_reason_id = trr.id
          WHERE PD.created_by = $2 AND PD.is_deleted = 0  AND PD.is_review = 0 ${dynamicQuery}
        ORDER BY PD.created_at DESC LIMIT ${limit} OFFSET $1`,
        [offset, vendorId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorProductCount: async (vendorId, productName, filterProduct) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND vendor_approved_by IN (${filterProduct.id_array})`;
      }
      db.one(
        `SELECT count(id) FROM tbl_product WHERE created_by = $1 AND is_deleted = 0 AND is_review = 0 ${dynamicQuery}`,
        [vendorId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  vendorProductListReview: async (
    limit,
    offset,
    vendorId,
    productName,
    filterProduct,
    products
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND PD.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
      if (products && products.length > 0) {
        dynamicQuery += `AND PD.id IN (${products})`;
      }
      db.any(
        `SELECT PD.*,tva.vendor_approve,
        ARRAY
        (SELECT json_build_object('category_name', tc.title,'id',tc.id )
          FROM tbl_product_categories pc 
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id
          WHERE PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
          ARRAY
        (SELECT json_build_object('vendor_approve_name', tva.vendor_approve,'id',tva.id )
          FROM tbl_vendorapprove_product_mapping tvpm 
        LEFT JOIN tbl_vendor_approve tva ON tvpm.vendor_approve_id = tva.id
        WHERE PD.id = tvpm.product_id) AS "product_approve_by",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants"  
          FROM tbl_product PD 
          LEFT JOIN tbl_vendor_approve tva ON PD.vendor_approved_by = tva.id
          WHERE PD.created_by = $2 AND PD.is_deleted = 0  AND PD.is_review = 1 AND added_by !=1 ${dynamicQuery}
        ORDER BY PD.name ASC LIMIT ${limit} OFFSET $1`,
        [offset, vendorId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorReviewProductCount: async (vendorId, productName, filterProduct) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND id IN (${filterProduct.id_array})`;
      }
      db.one(
        `SELECT count(id) FROM tbl_product WHERE created_by = $1 AND is_deleted = 0 AND is_review = 1 ${dynamicQuery}`,
        [vendorId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  check_product: async (productId, created_by = null) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (created_by) {
        dynamicQuery = ` AND created_by = '${created_by}'`;
      }
      db.any(
        `SELECT * FROM tbl_product WHERE id = $1 AND is_deleted = 0 ${dynamicQuery}`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  productDetails: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT PD.*,USERS.name as vendor_name,
        CASE
        WHEN PD.qap_new_file_name IS NULL THEN
          NULL
          ELSE pd.qap_new_file_name
          END AS qap_new_file_name,
          CASE
          WHEN PD.tds_new_file_name IS NULL THEN
          NULL
          ELSE pd.tds_new_file_name
          END AS tds_new_file_name,
        ARRAY
        (SELECT json_build_object('category_name', tc.title,'id',pc.category_id )
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id   WHERE  PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants",
            ARRAY
          (SELECT json_build_object('product_image', tbl_product_images.new_image_name,'is_featured',tbl_product_images.is_featured,
          'product_image_url',  CASE
          WHEN tbl_product_images.new_image_name IS NULL THEN
          NULL
          ELSE tbl_product_images.new_image_name
          END)
            FROM tbl_product_images WHERE PD.id = tbl_product_images.product_id ) AS "product_images",
            ARRAY
          (SELECT tvpm.vendor_approve_id
            FROM tbl_vendorapprove_product_mapping tvpm WHERE  PD.id = tvpm.product_id) AS "vendor_approved_by"
            FROM tbl_product PD 
            LEFT JOIN tbl_users USERS ON PD.created_by = USERS.id 
            WHERE USERS.is_deleted = 0 AND PD.is_deleted = 0 And PD.id = $1`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  vendorListProductWise: async (productName) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT DISTINCT
    ON (tbl_users.name) tbl_users.name AS vendor_name, ARRAY 
    (SELECT json_build_object ('id',tvpm.vendor_approve_id,'name',tbl_vendor_approve.vendor_approve,'logo', tbl_vendor_approve.vendor_logo)
    FROM tbl_vendorapprove_product_mapping tvpm
    LEFT JOIN tbl_vendor_approve
        ON tvpm.vendor_approve_id = tbl_vendor_approve.id
    WHERE tbl_product.id = tvpm.product_id) AS "vendor_approved_by"
FROM tbl_product
LEFT JOIN tbl_users
    ON tbl_product.created_by = tbl_users.id
WHERE tbl_product.name = $1`,
        [productName]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  vendorProductDetails: async (productId, vendorId) => {
    return new Promise(function (resolve, reject) {
      let dynamicWhere = ``;
      if (vendorId) {
        dynamicWhere = `AND PD.created_by = ${vendorId}`;
      }
      db.any(
        `SELECT PD.*,USERS.name as vendor_name,
        ARRAY
        (SELECT json_build_object('category_name', tc.title,'id',pc.category_id )
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id   WHERE  PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
        ARRAY
          (SELECT json_build_object('variant_name', pv.variant_name,'variant_value',pv.variant_value,'id',pv.id)
            FROM tbl_product_variants pv WHERE  PD.id = pv.product_id) AS "product_variants",
            ARRAY
          (SELECT json_build_object('product_image', tbl_product_images.new_image_name,'is_featured',tbl_product_images.is_featured,
          'product_image_url',  CASE
          WHEN tbl_product_images.new_image_name IS NULL THEN
          NULL
          ELSE tbl_product_images.new_image_name
          END)
            FROM tbl_product_images WHERE PD.id = tbl_product_images.product_id ) AS "product_images",
            ARRAY
          (SELECT tvpm.vendor_approve_id
            FROM tbl_vendorapprove_product_mapping tvpm WHERE  PD.id = tvpm.product_id) AS "vendor_approved_by"
            FROM tbl_product PD 
            LEFT JOIN tbl_users USERS ON PD.created_by = USERS.id 
            WHERE USERS.is_deleted = 0 AND PD.is_deleted = 0 And PD.id = $1 ${dynamicWhere}`,
        [productId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  deleteProduct: async (productObj, productId) => {
    return new Promise(function (resolve, reject) {
      const condition = `WHERE id = $1 RETURNING id`;
      const values = [productId];
      let query =
        pgp().helpers.update(productObj, null, 'tbl_product') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  approveProduct: async (productObj, productId) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id,name,created_by`;
      const values = [productId];
      let query =
        pgp().helpers.update(productObj, null, 'tbl_product') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  vendorProductAcceptReview: async (acceptReviewObj, vendorId, productId) => {
    return new Promise(function (resolve, reject) {
      let dynamicCondition = '';
      if (productId) {
        dynamicCondition = `AND id = ${productId}`;
      }
      const condition = `WHERE created_by = $1  AND is_review = 1 ${dynamicCondition} RETURNING id`;
      const values = [vendorId];
      let query =
        pgp().helpers.update(acceptReviewObj, null, 'tbl_product') + condition;

      db.any(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  adminProductAcceptReview: async (acceptReviewObj, productId) => {
    return new Promise(function (resolve, reject) {
      let dynamicCondition = '';
      if (productId) {
        dynamicCondition = `AND id = ${productId}`;
      }
      const condition = `WHERE is_review = 1 ${dynamicCondition} RETURNING id`;
      let query =
        pgp().helpers.update(acceptReviewObj, null, 'tbl_product') + condition;

      db.any(query)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getAllProduct: async () => {
    return new Promise(function (resolve, reject) {
      db.one(
        `SELECT count(id) FROM tbl_product WHERE  is_deleted = 0 AND is_review = 0`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  approvedProductList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT MIN(id) AS id,
         name
        FROM tbl_product
        WHERE is_approve = 1 AND is_deleted = 0 AND created_by = 1
        GROUP BY name
        ORDER BY id DESC`
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }
};

export default productModel;
