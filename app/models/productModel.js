import db from '../config/dbConn.js';
import pgp from 'pg-promise';
import Config from '../config/app.config.js';
import { buildProductFilters, logError } from '../helper/common.js';

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
  productCategoryExist:async (id,category) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_product_categories where product_id = $1 AND category_name = $2', [id,category])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  productCategoryIdExist:async (id,categoryId) => {
    return new Promise(function (resolve, reject) {
      db.any('select * from tbl_product_categories where product_id = $1 AND category_id = $2', [id,categoryId])
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
  getParentCategoryList: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `select TC.*
          from tbl_category TC where TC.is_deleted !='1' AND (TC.parent_id = 0 OR TC.parent_id IS NULL) order by title asc`,
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
  getSubCategory: async (parent_id = null, slug = null) => {
    return new Promise(async (resolve, reject) => {
      try {
        if (!parent_id && !slug) {
          throw new Error('Either parent_id or slug must be provided');
        }
  
        // Case 1: Fetch by parent_id directly
        if (parent_id) {
          const result = await db.any(
            `SELECT * FROM tbl_category WHERE parent_id = $1 AND is_deleted != '1'`,
            [parent_id]
          );
          return resolve(result);
        }
  
        // Case 2: Fetch by slug path
        const slugParts = slug.split(",");
        if (slugParts.length === 0) {
          return reject(new Error("Slug cannot be empty after splitting"));
        }
  
        const query = `
          WITH RECURSIVE category_hierarchy AS (
            SELECT id, parent_id, slug, CAST(ARRAY[slug] AS character varying[]) AS slug_path, 1 AS depth
            FROM tbl_category
            WHERE parent_id = 0 AND is_deleted != '1'
  
            UNION ALL
  
            SELECT c.id, c.parent_id, c.slug, ch.slug_path || c.slug, ch.depth + 1
            FROM tbl_category c
            INNER JOIN category_hierarchy ch ON c.parent_id = ch.id
            WHERE c.is_deleted != '1'
          ),
          matching_path AS (
            SELECT id
            FROM category_hierarchy
            WHERE slug_path = $1::character varying[]
            AND depth = $2
            LIMIT 1
          ),
          selected_id AS (
            SELECT id FROM matching_path
          )
          SELECT 
            (SELECT id FROM selected_id) AS matched_category_id,
            (
              SELECT json_agg(
                json_build_object(
                  'id', id,
                  'title', title,
                  'parent_id', parent_id,
                  'slug', slug
                )
              )
              FROM tbl_category
              WHERE parent_id = (SELECT id FROM selected_id) AND is_deleted != '1'
            ) AS subcategories;
        `;
  
        const params = [slugParts, slugParts.length];
        const result = await db.one(query, params);
  
        // Return 404-like response if slug matched but no subcategories found
        if (!result.subcategories || result.subcategories.length === 0) {
          return resolve({
            status: 404,
            message: 'No subcategories found for the given slug path.',
            category_id: result.matched_category_id
          });
        }
  
        resolve(result.subcategories);
      } catch (err) {
        reject(new Error(err.message));
      }
    });
  },
  getProductBycategory : async (category_id) =>{
    return new Promise((resolve, reject) => {
      db.any(
        `SELECT *
         FROM tbl_product_categories tpc
         JOIN tbl_product tp ON tpc.product_id = tp.id
         WHERE tpc.category_id = $1
         ORDER BY tp.created_at ASC
         `,
        [category_id]
      )
        .then((data) => resolve(data))
        .catch((error) => reject(new Error(error)));
    });
  },
  getProductById: async (product_id) => {
    try {
      return await db.any(`
        SELECT P.*,
          C.name AS created_by,
          U.name AS updated_by,
          A.name AS vendor_approved_by,
          ARRAY (SELECT JSON_BUILD_OBJECT('id', C.id, 'category_name', C.title) 
          FROM tbl_product_categories PC 
          JOIN tbl_category C ON PC.category_id = C.id 
          WHERE PC.product_id = P.id) AS product_categories 
        FROM tbl_product P 
        LEFT JOIN tbl_users C ON P.created_by = C.id
        LEFT JOIN tbl_users U ON P.updated_by = U.id
        LEFT JOIN tbl_users A ON P.vendor_approved_by = A.id
        WHERE P.id = $1
        `, [product_id]);
    } catch (error) {
      throw new Error(error); // Rethrow the error so the caller can handle it
    }
  },
  
  
  getParentCategoryList: async () => {
    try {
        const query = `
            SELECT *
            FROM (
                SELECT DISTINCT ON (c.slug)
                    c.id,
                    c.title,
                    c.slug
                FROM tbl_category c
                JOIN tbl_product_categories pc ON c.id = pc.category_id
                JOIN tbl_product p ON pc.product_id = p.id
                WHERE c.parent_id = 0
                  AND c.is_deleted = 0
                  AND p.is_deleted = 0
                  AND p.status = 1  -- Ensure product is active
                  AND p.is_approve = 1  -- Ensure product is active
                ORDER BY c.slug, c.id
            ) AS distinct_categories
            ORDER BY id;
        `;

        const result = await db.query(query);
        return result;
    } catch (error) {
        console.log(error);
        throw new Error("Error fetching parent categories with products.");
    }
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
  addProductApproveBy: async (productApproveArray, productId = 0) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const { ColumnSet } = pgp().helpers;
      const cs = new ColumnSet(['product_id', 'variant_vendor_mapping_id', 'vendor_approve_id'], {
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

   
  },
  updateVendorProduct: async (productObj) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij May 02, 2025 [Fixed query to remove columns that don't exist in database]
      db.one(
        `update 
				tbl_product set 
				description = ($1),
				slug = ($2),
				sku = ($3),
				status = ($4),
				updated_by = ($5),
        name = ($6)
       	where id=($7) 
        RETURNING id`,
        [
          productObj.description,
          productObj.slug,
          productObj.sku,
          productObj.status,
          productObj.updated_by,
          productObj.name,
          productObj.productId
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
  getProductByVariant: async (variantId) => {
    try {
      let q = `
      SELECT P.id 
      FROM tbl_product_variant PV
      JOIN tbl_product P ON P.id = PV.product_id
      WHERE PV.id = $1
      LIMIT 1;
      `

      return await db.any(q, [variantId])
    } catch (e) {
      throw e;
    }
  },
  getVariantsByProductId: async (productId) => {
    try {
      let q = `
      SELECT 
      pv.id,
      pv.name,
      pv.created_by,
      pv.product_id

      FROM tbl_product_variant pv
      WHERE pv.product_id = $1
      `

      return await db.any(q, [productId]);
    } catch (e) {
      throw e;
    }
  },
  createProductveriants: async (variantObj) => {
    return new Promise(function (resolve, reject) {
      // Update object keys to match table columns
      // Changes by Agnij May 02, 2025 [Added is_approve field with default 0]
      const updatedObj = {
        product_id: variantObj.product_id,
        name: variantObj.variant_name || variantObj.name,
        status: 1,
        is_approve: 0, // Set default to disapproved
        created_at: new Date()
      };
      
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(updatedObj, null, 'tbl_product_variant') +
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
        `DELETE FROM tbl_product_variant
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
  deletePreviousApprovedByMapping: async (vendorId, variantId) => {
    try {
      let q = `
      DELETE FROM tbl_vendorapprove_product_mapping vapm
      WHERE variant_vendor_mapping_id IN (
        SELECT id FROM tbl_product_variant_vendor_mapping
        WHERE product_variant_id = $1
          AND vendor_id = $2
      );
      `

      return await db.any(q, [variantId, vendorId])
    } catch (e) {
      throw e
    };
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
  createProductCategories: async (category_id, product_id) => {
    return new Promise(function (resolve, reject) {
      const query = `
        WITH category_info AS (
          SELECT title
          FROM tbl_category
          WHERE id = $1
        )
        INSERT INTO tbl_product_categories (product_id, category_name, category_id)
        SELECT $2, title, $1
        FROM category_info
        RETURNING *;
      `;

      db.one(query, [category_id, product_id])
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
      // Changes by Agnij April 30, 2025 [Fixed column names to match actual database schema]
      try {
        // Ensure we have all required fields with proper defaults
        // Accept 'variant_name' from frontend but use 'name' for the database
        if (!variantObj.product_id || (!variantObj.variant_name && !variantObj.name)) {
          console.error("Missing required fields for variant creation:", variantObj);
          return reject(new Error("Missing required fields: product_id and variant name are required"));
        }
        
        // Set up all the fields with appropriate defaults
        // Use variant_name from input if available, otherwise use name
        const variantName = variantObj.variant_name || variantObj.name;
        
        // Changes by Agnij May 02, 2025 [Set is_approve to 0 by default]
        const fields = {
          product_id: variantObj.product_id,
          name: variantName, // Database column is 'name'
          status: variantObj.status !== undefined ? variantObj.status : 1,
          is_deleted: variantObj.is_deleted !== undefined ? variantObj.is_deleted : 0,
          is_review: variantObj.is_review !== undefined ? variantObj.is_review : 0,
          is_approve: variantObj.is_approve !== undefined ? variantObj.is_approve : 0, // Changed default from 1 to 0
          created_at: variantObj.created_at || new Date(),
          updated_at: variantObj.updated_at || new Date(),
          created_by: variantObj.created_by || null,
          updated_by: variantObj.updated_by || null,
          added_by: variantObj.added_by || null
        };

        
        // Build column names and value placeholders for the insert query
        const columns = Object.keys(fields).join(', ');
        const placeholders = Object.keys(fields).map((_, i) => `$${i + 1}`).join(', ');
        const values = Object.values(fields);

        // Use explicit parameterized query for safety
        const query = `
          INSERT INTO tbl_product_variant(${columns}) 
          VALUES(${placeholders}) 
          RETURNING id
        `;
        
        db.one(query, values)
          .then(function (data) {
            resolve({id: data.id});
          })
          .catch(function (err) {
            console.error("Error creating product variant:", err);
            reject(new Error(err.message || "Failed to create product variant"));
          });
      } catch (err) {
        console.error("Exception in createProductVariant:", err);
        reject(new Error(err.message || "Exception in createProductVariant"));
      }
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
        dynamicQuery += ` AND vendor = ${vendorId}`;
      }
      if (productId) {
        dynamicQuery += ` AND id != ${productId}`;
      }
      if (added_by) {
        dynamicQuery += ` AND added_by = ${added_by} AND created_by = ${added_by}`;
      }
      db.any(`SELECT * FROM tbl_product WHERE LOWER(name) = $1 ${dynamicQuery}`, [
        name.toLowerCase() // Convert name to lowercase before passing it
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
  checkVariantExists: async (
    name,
    vendorId = null,
    variantId = null,
    added_by = null
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      let joinQuery = '';
      if (vendorId) {
        joinQuery += `JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = PV.id `;
        dynamicQuery += ` AND pvvm.vendor_id = ${vendorId}`;
      }
      if (variantId) {
        dynamicQuery += ` AND PV.id != ${variantId}`;
      }
      if (added_by) {
        joinQuery += `JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = PV.id `;
        dynamicQuery += ` AND pvvm.created_by = ${added_by}`;
      }
      db.any(`SELECT * FROM tbl_product_variant PV WHERE LOWER(name) = $1 ${dynamicQuery}`, [
        name.toLowerCase() // Convert name to lowercase before passing it
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
  checkVariantExistsForVendor: async (vendorId, variantId) => {
    try {
      let q = `
      SELECT pvvm.id
      FROM tbl_product_variant_vendor_mapping pvvm
      JOIN tbl_product_variant pv ON pv.id = pvvm.product_variant_id
      WHERE pvvm.vendor_id = $1 AND pv.id = $2
      `
  
      return db.any(q, [vendorId, variantId])
    } catch (e) {
      throw e;
    }
  },
  productExistForVendor: async (
    name,
    vendorId = null,
    category
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (vendorId) {
        dynamicQuery += ` AND p.created_by = ${vendorId}`;
      }

      db.any(
        `SELECT p.*
        FROM tbl_product p
        JOIN tbl_product_categories tpc ON p.id = tpc.product_id
        JOIN tbl_category tc ON tpc.category_id = tc.id
        WHERE p.name = $1 AND tc.title = $2${dynamicQuery}`,
        [name, category]
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
  
  checkMasterNameExist: async (name, productId) => {
    let dynamicQuery = '';
    if (productId) {
      dynamicQuery += `AND id != ${productId}`;
    }
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_product WHERE is_deleted = 0 AND is_approve = 1 AND name = $1 AND created_by = 1 ${dynamicQuery}`,
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
  productWithCategoryExist:( productName, catName )=> {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT p.*
        FROM tbl_product p
        JOIN tbl_product_categories tpc ON p.id = tpc.product_id
        JOIN tbl_category tc ON tpc.category_id = tc.id
        WHERE p.name = $1 AND tc.title = $2 AND p.is_deleted = 0 AND p.is_approve = 1;`,
        [productName, catName]
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
        `SELECT STRING_AGG(pv.id::TEXT, ',') AS id_array 
          FROM tbl_vendorapprove_product_mapping vpm 
          JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.id = vpm.variant_vendor_mapping_id 
          JOIN tbl_product_variant pv ON pv.id = pvvm.product_variant_id
          WHERE vpm.vendor_approve_id = $1`,
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
    isFeatured,
    userId,
    categoryId,
    dateFrom,
    dateTo,
    is_approve
  ) => {
    // Changes by Agnij May 01, 2025 [Modified to return base products only, not variants]
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      // Product name search with full-text search and similarity
      if (productName && productName !== '') {
        dynamicQuery += `
          AND (
            to_tsvector('english', CONCAT(PV.name, ' - ', PD.name)) @@ plainto_tsquery('english', '${productName}')
            OR similarity(CONCAT(PV.name, ' - ', PD.name), '${productName}') > 0.1
          )`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
  
      if (vendorId && vendorId !== '') {
        dynamicQuery += `
          AND EXISTS (
            SELECT 1 FROM tbl_product_variant pv
            JOIN tbl_product_variant_vendor_mapping pvm
            ON pv.id = pvm.product_variant_id
            WHERE pv.product_id = PD.id AND pvm.vendor_id = ${vendorId}
          )`;
      }
      if (userId && userId !== '') {
        dynamicQuery += `
          AND EXISTS (
            SELECT 1 FROM tbl_product_variant pv
            JOIN tbl_product_variant_vendor_mapping pvm
            ON pv.id = pvm.product_variant_id
            WHERE pv.product_id = PD.id AND pvm.vendor_id = ${userId}
          )`;
      }
      if (isFeatured && isFeatured !== '') {
        dynamicQuery += ` AND PD.is_featured = '${isFeatured}'`;
      }
      if (categoryId) {
        dynamicQuery += ` AND EXISTS (
          SELECT 1 FROM tbl_product_categories
          WHERE tbl_product_categories.product_id = PD.id 
          AND tbl_product_categories.category_id = ${categoryId}
        )`;
      }
      if (dateFrom) {
        dynamicQuery += ` AND DATE(PV.created_at) >= '${dateFrom}'`;
      }
      if (dateTo) {
        dynamicQuery += ` AND DATE(PV.created_at) <= '${dateTo}'`;
      }
      if (is_approve !== null && is_approve !== undefined) {
        dynamicQuery += ` AND PV.is_approve = ${is_approve}`;
      }
      
      let q = `
      SELECT 
        PV.*, 
        PD.name as product_name,
        NULL AS vendor_name,
        CONCAT(PV.name, ' - ', PD.name) AS unified_name,
        ${productName ? `
          similarity(CONCAT(PV.name, ' - ', PD.name), '${productName}') AS similarity_score,
          ts_rank_cd(to_tsvector('english', CONCAT(PV.name, ' - ', PD.name)), plainto_tsquery('english', '${productName}')) AS rank,
        ` : ''}
        ARRAY
        (SELECT json_build_object('category_name', tc.title, 'id', tc.id)
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id
          WHERE PD.id = pc.product_id ORDER BY pc.id
        ) AS product_categories,
        ARRAY
        (SELECT json_build_object('id', pv.id, 'name', pv.name, 'product_id', pv.product_id, 'is_approve', pv.is_approve)
          FROM tbl_product_variant pv
          WHERE PD.id = pv.product_id
        ) AS product_variants

      FROM tbl_product_variant PV
      JOIN tbl_product PD ON PD.id = PV.product_id
      JOIN tbl_users tu ON tu.id = PD.created_by
      WHERE PV.status = 1 
      ${dynamicQuery}

      ${productName ? `ORDER BY rank DESC, similarity_score DESC, CONCAT(PV.name, ' - ', PD.name) ASC` : `ORDER BY PV.created_at DESC`} 
      LIMIT ${limit} OFFSET $1
      `;

      db.any(
        q,
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
  getMasterProductsPaginated: async (filters, page = 1, limit = 10) => {
    return new Promise(async function (resolve, reject) {
      try {
        const { productName,
          vendorId,
          categoryId,
          addedBy,
          dateFrom,
          dateTo,
          is_approve, } = filters;

        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        if (page < 1) page = 1;
        if (limit < 1) limit = 10;
        const offset = (page - 1) * limit;

        let conditions = ['p.is_deleted = 0'];
        let params = [];
        let paramIndex = 1;

        // Handle search term using ILIKE
        if (productName && productName.trim() !== '') {
          conditions.push(`(
            to_tsvector('english', P.name) @@ plainto_tsquery('english', '${productName}')
            OR similarity(P.name, '${productName}') > 0.1
          )`);
          params.push(`%${productName.trim()}%`);
          paramIndex++;
        }

        // Handle date range
        if (dateFrom) {
          try {
            const startDate = new Date(dateFrom);
            if (!isNaN(startDate.getTime())) {
              conditions.push(`p.created_at >= $${paramIndex}`);
              params.push(startDate);
              paramIndex++;
            }
          } catch (e) { console.error("Invalid dateFrom:", e); }
        }

        if (dateTo) {
          try {
            const endDate = new Date(dateTo);
            if (!isNaN(endDate.getTime())) {
              endDate.setDate(endDate.getDate() + 1); // Include the whole end day
              conditions.push(`p.created_at <= $${paramIndex}`);
              params.push(endDate);
              paramIndex++;
            }
          } catch (e) { console.error("Invalid dateTo:", e); }
        }

        // Handle vendor filter
        if (vendorId && vendorId !== '') {
          conditions.push(`EXISTS (SELECT 1 FROM tbl_product_variant_vendor_mapping pvvm JOIN tbl_product_variant PV on PV.id = pvvm.product_variant_id WHERE PV.product_id = p.id AND pvvm.vendor_id = $${paramIndex})`);
          params.push(vendorId);
          paramIndex++;
        }

        // Handle category filter
        if (categoryId && categoryId !== '') {
          conditions.push(`EXISTS (SELECT 1 FROM tbl_product_categories pc WHERE pc.product_id = p.id AND pc.category_id = $${paramIndex})`);
          params.push(categoryId);
          paramIndex++;
        }
        
        // Handle added by filter
        if (addedBy && addedBy !== '') {
          // Assuming addedBy refers to the variant creator
          conditions.push(`p.created_by = $${paramIndex}`); 
          params.push(addedBy);
          paramIndex++;
        }

        // Handle approval status filter
        if (is_approve !== undefined && is_approve !== null && is_approve !== '') {
           // Ensure is_approve is treated as a number/boolean
           const approvalValue = (is_approve === '1' || is_approve === 1 || is_approve === true) ? 1 : 0;
           conditions.push(`p.is_approve = $${paramIndex}`);
           params.push(approvalValue);
           paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // --- Count Query ---
        const countQuery = `
          SELECT COUNT(DISTINCT p.id) as total_count
          FROM 
            tbl_product p
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          ${whereClause}
        `;

        // --- Data Query ---
        // const dataQuery = `
        //   SELECT 
        //     P.*,
        //     ${productName ? `
        //       similarity(P.name, '${productName}') AS similarity_score,
        //       ts_rank_cd(to_tsvector('english', P.name), plainto_tsquery('english', '${productName}')) AS rank,
        //     ` : ''}
        //   ARRAY(
        //     SELECT json_build_object('category_name', tc.title, 'id', tc.id)
        //     FROM tbl_product_categories pc
        //     LEFT JOIN tbl_category tc ON pc.category_id = tc.id
        //     WHERE pc.product_id = p.id
        //     ORDER BY pc.id
        //   ) AS product_categories
        //   FROM 
        //     tbl_product_v2 p
        //   LEFT JOIN 
        //     tbl_product_categories pc ON p.id = pc.product_id
        //   LEFT JOIN 
        //     tbl_category c ON pc.category_id = c.id

        //   ${whereClause}

        //   ${productName ? `ORDER BY rank DESC, similarity_score DESC, P.name ASC` : `ORDER BY P.created_at DESC`} 
        //   LIMIT $${paramIndex}
        //   OFFSET $${paramIndex + 1}
        // `;

        const dataQuery = `
          WITH paginated_products AS (
            SELECT
                P.id,
                P.name,
                ${productName ? `
                  similarity(P.name, '${productName}') AS similarity_score,
                  ts_rank_cd(to_tsvector('english', P.name), plainto_tsquery('english', '${productName}')) AS rank,
                ` : ''}
                P.description,
                P.slug,
                P.sku,
                P.created_at,
                P.updated_at,
                P.approved_at,
                C.name AS created_by,
                U.name AS updated_by,
                A.name AS approved_by,
                P.status,
                P.is_deleted,
                P.is_review,
                P.added_by,
                P.is_approve,
                (SELECT COUNT(*) FROM tbl_product_variant PV WHERE PV.product_id = P.id)::int AS variant_count
            FROM tbl_product P
            LEFT JOIN tbl_users C ON C.id = P.created_by
            LEFT JOIN tbl_users U ON U.id = P.updated_by
            LEFT JOIN tbl_users A ON A.id = P.vendor_approved_by
            ${whereClause}
            ${productName ? `ORDER BY rank DESC, similarity_score DESC, P.name ASC` : `ORDER BY P.created_at DESC`} 
            LIMIT $${paramIndex}
                OFFSET $${paramIndex + 1}
          )
          SELECT
              p.*,
              ARRAY(
                SELECT json_build_object('category_name', tc.title, 'id', tc.id)
                FROM tbl_product_categories pc
                        LEFT JOIN tbl_category tc ON pc.category_id = tc.id
                WHERE pc.product_id = p.id
                ORDER BY pc.id
              ) AS product_categories
          FROM paginated_products p;
        `

        console.log(dataQuery)
        
        // Add limit and offset parameters for data query
        const dataParams = [...params, limit, offset];

        // Execute count query
        const countResult = await db.one(countQuery, params);
        const totalItems = parseInt(countResult.total_count, 10) || 0;
        const totalPages = Math.ceil(totalItems / limit);

        // Execute data query
        const data = await db.any(dataQuery, dataParams);

        resolve({
          data: data || [],
          filtered_count: totalItems,
          page,
          limit,
          pages: totalPages,
          // pagination: {
          //   total: totalItems,
          //   page: page,
          //   limit: limit,
          //   pages: totalPages
          // }
        });

      } catch (error) {
        console.error("Error in getMasterProductsPaginated:", error);
        // Return empty result on error to avoid breaking frontend
        resolve({
          data: [],
          // pagination: { total: 0, page: page, limit: limit, pages: 1 }
          filtered_count: 0,
          page,
          limit,
          pages: 1,
        });
      }
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
          (SELECT json_build_object('id',pv.id,'name',pv.name,'product_id',pv.product_id)
            FROM tbl_product_variant pv WHERE  PD.id = pv.product_id) AS "product_variants"  
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
  // getProductCount: async (vendorId, productName, filterProduct, isFeatured, userId, categoryId, dateFrom, dateTo, is_approve) => {
  //   return new Promise(function (resolve, reject) {
  //     let dynamicQuery = '';
  //     if (productName && productName != '') {
  //       dynamicQuery += `
  //         AND (
  //           to_tsvector('english', tbl_product.name) @@ plainto_tsquery('english', '${productName}')
  //           OR similarity(tbl_product.name, '${productName}') > 0.1
  //         )`;
  //     }
  //     if (filterProduct?.id_array) {
  //       dynamicQuery += ` AND tbl_product.id IN (${filterProduct.id_array})`;
  //     }
  //     if (vendorId && vendorId != '') {
  //       dynamicQuery += ` AND tbl_product.id IN (SELECT product_id FROM tbl_product_variant WHERE status = 1)`;
  //     }
  //     if (userId && userId != '') {
  //       dynamicQuery += ` AND tbl_product.status = 1`;
  //     }
  //     if (isFeatured && isFeatured != '') {
  //       dynamicQuery += ` AND tbl_product.is_featured = '${isFeatured}'`;
  //     }
  //     if (categoryId) {
  //       dynamicQuery += ` AND EXISTS (
  //         SELECT 1 FROM tbl_product_categories
  //         WHERE tbl_product_categories.product_id = tbl_product.id 
  //         AND tbl_product_categories.category_id = ${categoryId}
  //       )`;
  //     }
  //     if (dateFrom) {
  //       dynamicQuery += ` AND DATE(tbl_product.created_at) >= '${dateFrom}'`;
  //     }
  //     if (dateTo) {
  //       dynamicQuery += ` AND DATE(tbl_product.created_at) <= '${dateTo}'`;
  //     }
  //     if (is_approve !== null && is_approve !== undefined) {
  //       dynamicQuery += ` AND tbl_product.is_approve = ${is_approve}`;
  //     }
      
  //     db.any(
  //       `SELECT COUNT(*) as count FROM tbl_product
  //        LEFT JOIN tbl_users tu ON tbl_product.created_by = tu.id
  //        WHERE tbl_product.status = 1 AND tu.user_type NOT IN (2, 3) ${dynamicQuery}`
  //     )
  //       .then(function (data) {
  //         resolve(data);
  //       })
  //       .catch(function (err) {
  //         let error = new Error(err);
  //         reject(error);
  //       });
  //   });
  // },
  getProductCount: async (
    vendorId,
    productName,
    filterProduct,
    isFeatured,
    userId,
    categoryId,
    dateFrom,
    dateTo,
    is_approve
  ) => {
    const filterParams = {
      vendorId,
      productName,
      filterProduct,
      isFeatured,
      userId,
      categoryId,
      dateFrom,
      dateTo,
      is_approve
    };
  
    const whereClause = buildProductFilters(filterParams);
  
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM tbl_product PD
      JOIN tbl_users tu ON tu.id = PD.created_by
      ${whereClause}
    `;
  
    const result = await db.one(countQuery, filterParams);
    return parseInt(result.count, 10);
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
        dynamicQuery += `
          AND (
            to_tsvector('english', PD.name) @@ plainto_tsquery('english', '${productName}')
            OR similarity(PD.name, '${productName}') > 0.1
          )`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND PD.id IN (SELECT product_id FROM tbl_product_variant WHERE status = 1)`;
      }

      let q = `
        SELECT 
          PD.*,
          USERS.name as vendor_name,
          ${productName ? `
            similarity(PD.name, '${productName}') AS similarity_score,
            ts_rank_cd(to_tsvector('english', PD.name), plainto_tsquery('english', '${productName}')) AS rank,
          ` : ''}
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
            (SELECT json_build_object('id',pv.id,'name',pv.name,'product_id',pv.product_id)
              FROM tbl_product_variant pv WHERE  PD.id = pv.product_id) AS "product_variants"
              FROM tbl_product PD 
              LEFT JOIN tbl_users USERS ON PD.id IN (SELECT product_id FROM tbl_product_variant WHERE status = 1) 
              WHERE PD.status = 1 ${dynamicQuery}     
          ${productName ? `ORDER BY rank DESC, similarity_score DESC, PD.name ASC` : `ORDER BY PD.created_at DESC`}
          LIMIT ${limit} OFFSET $1
      `;

      db.any(q, [offset])
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
        dynamicQuery += `
          AND (
            to_tsvector('english', PD.name) @@ plainto_tsquery('english', '${productName}')
            OR similarity(PD.name, '${productName}') > 0.1
          )`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND PD.id IN (SELECT product_id FROM tbl_product_variant WHERE status = 1)`;
      }
      db.any(
        `select * from tbl_product PD
        LEFT JOIN tbl_users USERS ON PD.id IN (SELECT product_id FROM tbl_product_variant WHERE status = 1)
        WHERE PD.status = 1 ${dynamicQuery}`
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
      if (prdObj.user_id && prdObj.user_id != '') {
        dynamicQuery += ` AND P.created_by = '${prdObj.user_id}'`;
      }
      if (prdObj.cat_id && prdObj.cat_id != '') {
        dynamicQuery += ` AND C.id = '${prdObj.cat_id}'`;
      }

      let q = `
        SELECT DISTINCT 
          P.id as product_id, 
          C.title as category_name, 
          P.name as product_name,
          P.description,
          P.created_by,
          ${prdObj.product_name ? `
            similarity(P.name, '${prdObj.product_name}') AS similarity_score,
            ts_rank_cd(to_tsvector('english', P.name), plainto_tsquery('english', '${prdObj.product_name}')) AS rank
          ` : ''}
        FROM tbl_product P  
        LEFT JOIN tbl_product_categories PC ON P.id = PC.product_id 
        LEFT JOIN tbl_category C ON PC.category_id = C.id 
        WHERE P.status = '1' AND P.is_deleted = 0
          ${prdObj.product_name ? `
            AND (
              to_tsvector('english', P.name) @@ plainto_tsquery('english', '${prdObj.product_name}')
              OR similarity(P.name, '${prdObj.product_name}') > 0.1
            )
          ` : ''}
          ${dynamicQuery}
        ${prdObj.product_name ? `ORDER BY rank DESC, similarity_score DESC, P.name ASC` : `ORDER BY P.name ASC`}
      `;

      db.any(q)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  productSearchByCategory: async (cat_id, limit, offset) => {
    try {
      const query = `
        WITH RECURSIVE subcategories AS (
            SELECT 
                id,
                parent_id,
                title
            FROM tbl_category
            WHERE id = $1 AND is_deleted = 0

            UNION ALL
            SELECT 
                c.id,
                c.parent_id,
                c.title
            FROM tbl_category c
            INNER JOIN subcategories sc ON c.parent_id = sc.id
            WHERE c.is_deleted = 0
        )
SELECT *
FROM (
        SELECT DISTINCT ON (TP.name)
            TP.id AS product_id,
            TP.name AS product_name,
            TP.description,
            TP.slug,
            ARRAY (
                SELECT 
                    json_build_object(
                        'category_name', TC.title,
                        'id', TC.id,
                        'parent_id', TC.parent_id
                    )
                FROM tbl_product_categories TPC
                LEFT JOIN tbl_category TC 
                    ON TPC.category_id = TC.id
                WHERE TPC.product_id = TP.id
                  AND TC.id IS NOT NULL
                  AND TC.is_deleted = 0
                  AND (TC.id IN (SELECT id FROM subcategories) OR TC.id = $1) 
                ORDER BY TPC.id
            ) AS product_categories,
        (SELECT COUNT(*) FROM tbl_product TP2 WHERE TP2.name = TP.name AND TP2.is_deleted = 0) AS product_count
        FROM tbl_product TP
        WHERE TP.is_deleted = 0
        AND TP.status = 1
          AND EXISTS (
              SELECT 1
              FROM tbl_product_categories TPC
              LEFT JOIN tbl_category TC 
                  ON TPC.category_id = TC.id
              WHERE TPC.product_id = TP.id
                AND (TC.id IN (SELECT id FROM subcategories) OR TC.id = $1) 
          )
) AS sorted_products 
        ORDER BY product_count DESC, product_name, product_id  -- Sorting now applied in outer query
        LIMIT $2 OFFSET $3;
      `;

      const result = await db.query(query, [cat_id, limit, offset]);
      return result;
    } catch (error) {
      console.error("Error in productSearchByCategory:", error.message);
      throw new Error("Failed to fetch products by category");
    }
  },

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
  updateVendorDetail: async (userObj, user_id) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;

      let query = pgp().helpers.update(userObj, null, 'tbl_users') + condition;

      db.any(query, [user_id])
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
      const condition = ` WHERE id = $1 RETURNING id`;
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
    vendorApprove,
    products
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      let joinQuery = '';

      if (productName && productName != '') {
        dynamicQuery += ` AND PV.name ILIKE '%${productName}%'`;
      }
      if (vendorApprove) {
        joinQuery += `JOIN tbl_vendorapprove_product_mapping VPM ON VPM.variant_vendor_mapping_id = pvvm.id `
        dynamicQuery += ` AND VPM.vendor_approve_id = ${vendorApprove}`;
      }
      if (products && products.length > 0) {
        dynamicQuery += `AND PV.id IN (${products.join(",")})`;
      }
      db.any(`
        SELECT 
          PV.*,
          ARRAY(
            SELECT json_build_object('category_name', tc.title, 'id', tc.id)
            FROM tbl_product_categories pc
            LEFT JOIN tbl_category tc ON pc.category_id = tc.id
            WHERE pc.product_id = PD.id
            ORDER BY pc.id
          ) AS product_categories
      
        FROM tbl_product_variant PV
      
        JOIN tbl_product PD ON PD.id = PV.product_id
        JOIN tbl_product_variant_vendor_mapping pvvm ON PV.id = pvvm.product_variant_id
        ${joinQuery}
      
        WHERE pvvm.vendor_id = $2
        ${dynamicQuery}
      
        ORDER BY pvvm.created_at DESC
        LIMIT ${limit} OFFSET $1
      `, [offset, vendorId])      
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  getVendorProductCount: async (vendorId, productName, vendorApprove) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      let joinQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND name ILIKE '%${productName}%'`;
      }
      if (vendorApprove) {
        joinQuery += `JOIN tbl_vendorapprove_product_mapping VPM ON VPM.variant_vendor_mapping_id = pvvm.id `
        dynamicQuery += ` AND VPM.vendor_approve_id = ${vendorApprove}`;
      }
      db.one(
        `SELECT count(*) 
        FROM tbl_product_variant_vendor_mapping pvvm 
        JOIN tbl_product_variant pv ON pv.id = pvvm.product_variant_id 
        ${joinQuery} 
        WHERE pvvm.vendor_id = $1 
        AND pv.is_deleted = 0 
        ${dynamicQuery}`,
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
          (SELECT json_build_object('id',pv.id,'name',pv.name,'product_id',pv.product_id)
            FROM tbl_product_variant pv WHERE  PD.id = pv.product_id) AS "product_variants"  
          FROM tbl_product PD 
          LEFT JOIN tbl_vendor_approve tva ON PD.status = 1
          WHERE PD.status = 1 ${dynamicQuery}
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
        `SELECT count(id) FROM tbl_product WHERE status = 1 ${dynamicQuery}`,
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
      // Changes by Agnij May 02, 2025 [Improved product/variant lookup with better error handling]
      try {
        if (!productId) {
          resolve([]);
          return;
        }
        
        // First check in the product table
        db.any(
          `SELECT * FROM tbl_product WHERE id = $1`,
          [productId]
        )
          .then(function (productData) {
            if (productData && productData.length > 0) {
              resolve(productData);
            } else {
              resolve([]);
            }
          })
          .catch(function (err) {
            // Error in product query
            resolve([]);
          });
      } catch (error) {
        console.error("Exception in check_product:", error);
        resolve([]); // Return empty array on exception
      }
    });
  },
  checkVariantById: async (variantId, created_by = null) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij May 02, 2025 [Improved product/variant lookup with better error handling]
      try {
        if (!variantId) {
          resolve([]);
          return;
        }
        
        // First check in the product table
        db.any(
          `SELECT * FROM tbl_product_variant WHERE id = $1`,
          [variantId]
        )
          .then(function (productData) {
            if (productData && productData.length > 0) {
              resolve(productData);
            } else {
              resolve([]);
            }
          })
          .catch(function (err) {
            // Error in product query
            resolve([]);
          });
      } catch (error) {
        console.error("Exception in checkVariantById:", error);
        resolve([]); // Return empty array on exception
      }
    });
  },
  productDetails: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT PD.*,
        ARRAY
        (SELECT json_build_object('category_name', tc.title,'id',pc.category_id )
          FROM tbl_product_categories pc
          LEFT JOIN tbl_category tc ON pc.category_id = tc.id   WHERE  PD.id = pc.product_id ORDER BY pc.id) AS "product_categories",
        ARRAY
          (SELECT json_build_object('id',pv.id,'name',pv.name,'product_id',pv.product_id)
            FROM tbl_product_variant pv WHERE  PD.id = pv.product_id) AS "product_variants"
            FROM tbl_product PD 
            WHERE PD.status = 1 And PD.id = $1`,
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
        dynamicWhere = `AND PVVM.vendor_id = ${vendorId}`;
      }

      let q = `SELECT PV.*,
          CONCAT(PV.name, ' - ', PD.name) AS unified_name,
          ARRAY
          (SELECT vpm.vendor_approve_id FROM tbl_vendorapprove_product_mapping vpm WHERE vpm.variant_vendor_mapping_id = PVVM.id) as vendor_approved_by,
          ARRAY
          (SELECT json_build_object('category_name', tc.title,'id',pc.category_id )
            FROM tbl_product_categories pc
            LEFT JOIN tbl_category tc ON pc.category_id = tc.id 
            WHERE  PD.id = pc.product_id ORDER BY pc.id) AS "product_categories"

        FROM tbl_product_variant_vendor_mapping PVVM
        JOIN tbl_product_variant PV ON PVVM.product_variant_id = PV.id
        JOIN tbl_product PD ON PD.id = PV.product_id

        WHERE PV.status = 1 AND PV.id = $1 ${dynamicWhere}`

      console.log(q)

      db.any(
        q,
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
      let dynamicWhere = ``;

      let q = `SELECT PV.*
        FROM tbl_product_variant PV
        WHERE PV.status = 1 AND PV.id = $1 ${dynamicWhere}`

      db.any(
        q,
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
  },
  approveProduct: async (productObj, productId) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij May 02, 2025 [Removed vendor_approved_by field which doesn't exist in the database]
      const condition = ` WHERE id = $1 RETURNING id,name,created_by`;
      const values = [productId];
      
      // Changes by Agnij May 02, 2025 [Removed approved_at field which doesn't exist in the database]
      // Don't add approved_at field as it doesn't exist in the tbl_product table
      
      let query = pgp().helpers.update(productObj, null, 'tbl_product') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error in approveProduct:", err);
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
      const condition = ` WHERE is_review = 1 ${dynamicCondition} RETURNING id`;
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
  getAllProduct: async (uniqueProduct = false) => {
    return new Promise(function (resolve, reject) {
        let query = uniqueProduct
            ? `SELECT DISTINCT name FROM tbl_product WHERE status = 1 AND is_deleted = 0 AND is_review = 0 AND is_approve = 1 AND created_by NOT IN (1, 111) `  
            : `SELECT COUNT(id) FROM tbl_product WHERE is_deleted = 0 AND is_review = 0`;

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
  },

  topProductsWithVendors: async (userId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `
          WITH ranked_products AS (
              SELECT 
                  TP.id AS product_id,
                  TP.name AS product_name,
                  ARRAY (
                      SELECT 
                          json_build_object(
                              'category_name', TC.title,
                              'id', TC.id
                          )
                      FROM tbl_product_categories TPC
                      LEFT JOIN tbl_category TC 
                          ON TPC.category_id = TC.id
                      WHERE TPC.product_id = TP.id
                      AND TC.id IS NOT NULL
                      ORDER BY TPC.id
                  ) AS product_categories,
                  COUNT(TR.id)::INT AS rfq_count,
                  ROW_NUMBER() OVER (PARTITION BY TP.name ORDER BY COUNT(TR.id) DESC) AS rn
              FROM tbl_rfq TR
              JOIN tbl_rfq_products TRP
                  ON TRP.rfq_id = TR.id
              JOIN tbl_product_variant PV ON PV.id = TRP.product_variant_id
            JOIN tbl_product TP ON TP.id = PV.product_id
              WHERE TR.created_by = $1
                  AND TP.is_deleted = 0 AND TP.is_approve = 1
              GROUP BY 
                  TP.id, TP.name
          )
          SELECT 
              product_id,
              product_name,
              product_categories,
              rfq_count
          FROM ranked_products
          WHERE rn = 1 
          ORDER BY rfq_count DESC
          LIMIT 10;
        `,
        [userId]
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
  getProductBySlugAndCategorySlug: async (slugString) => {
    // Split the slug string into array and separate category slugs from product slug
    const slugs = slugString.split(',');
    const productSlug = slugs.pop(); // Last item is product slug
    const categorySlugs = slugs; // Remaining items are category slugs

    return new Promise(function (resolve, reject) {
        db.oneOrNone(`
WITH RECURSIVE temp_category_path AS (
    SELECT id, title, slug, parent_id, status, is_deleted, 1 AS depth
    FROM tbl_category
    WHERE slug = $1
      AND parent_id = 0 
      AND is_deleted = 0 
      AND status = 1
    UNION ALL
    SELECT c.id, c.title, c.slug, c.parent_id, c.status, c.is_deleted, tcp.depth + 1 AS depth
    FROM tbl_category c
    INNER JOIN temp_category_path tcp ON c.parent_id = tcp.id
    WHERE c.slug = ANY($2::varchar[])
      AND c.is_deleted = 0
      AND c.status = 1
)
SELECT 
    p.id AS product_id,
    p.name AS product_name,
    p.slug AS product_slug,
    p.description AS product_description,
    p.manufacturer,
    p.availability,
    p.sku,
    c.id AS category_id,
    c.title AS category_title,
    c.slug AS category_slug,
    c.depth AS category_depth,
    cms.description AS cms_content,
    cms.title AS cms_title
FROM 
    tbl_product p
INNER JOIN 
    tbl_product_categories pc ON p.id = pc.product_id
INNER JOIN 
    temp_category_path c ON pc.category_id = c.id
LEFT JOIN 
    tbl_product_cms cms ON p.id = cms.product_id
WHERE 
    p.slug = $3
    AND p.is_deleted = 0
    AND p.status = 1
    AND p.created_by = 1
LIMIT 1;
        `,
        [
            categorySlugs.length > 0 ? categorySlugs[0] : null, // $1: First category slug (root) or null
            categorySlugs.length > 0 ? categorySlugs : '{}',    // $2: Array of category slugs or empty array
            productSlug                                        // $3: Product slug
        ])
        .then(function (data) {
            resolve(data);
        })
        .catch(function (err) {
            let error = new Error(err.message);
            reject(error);
        });
    });
},

getProductTechSpecByID: async (productId) => {
  return new Promise(function (resolve, reject) {
    db.any(  'SELECT title, value FROM tbl_product_tech_spec WHERE product_id = $1 ',[productId])
      .then(function (data) {
        resolve(data);
      })
      .catch(function (err) {
        logError(err);
        res
          .status(400)
          .json({
            status: 3,
            message: Config?.errorText?.value || 'Something went wrong',
          })
          .end();
      });
  });
},

  createProductVariant: async (variantObj) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij April 30, 2025 [Fixed column names to match actual database schema]
      try {
        // Ensure we have all required fields with proper defaults
        // Accept 'variant_name' from frontend but use 'name' for the database
        if (!variantObj.product_id || (!variantObj.variant_name && !variantObj.name)) {
          console.error("Missing required fields for variant creation:", variantObj);
          return reject(new Error("Missing required fields: product_id and variant name are required"));
        }
        
        // Set up all the fields with appropriate defaults
        // Use variant_name from input if available, otherwise use name
        const variantName = variantObj.variant_name || variantObj.name;
        
        // Changes by Agnij May 02, 2025 [Set is_approve to 0 by default]
        const fields = {
          product_id: variantObj.product_id,
          name: variantName, // Database column is 'name'
          status: variantObj.status !== undefined ? variantObj.status : 1,
          is_deleted: variantObj.is_deleted !== undefined ? variantObj.is_deleted : 0,
          is_review: variantObj.is_review !== undefined ? variantObj.is_review : 0,
          is_approve: variantObj.is_approve !== undefined ? variantObj.is_approve : 0, // Changed default from 1 to 0
          created_at: variantObj.created_at || new Date(),
          updated_at: variantObj.updated_at || new Date(),
          created_by: variantObj.created_by || null,
          updated_by: variantObj.updated_by || null,
          added_by: variantObj.added_by || null
        };

        
        // Build column names and value placeholders for the insert query
        const columns = Object.keys(fields).join(', ');
        const placeholders = Object.keys(fields).map((_, i) => `$${i + 1}`).join(', ');
        const values = Object.values(fields);

        // Use explicit parameterized query for safety
        const query = `
          INSERT INTO tbl_product_variant(${columns}) 
          VALUES(${placeholders}) 
          RETURNING id
        `;
        
        db.one(query, values)
          .then(function (data) {
            resolve({id: data.id});
          })
          .catch(function (err) {
            console.error("Error creating product variant:", err);
            reject(new Error(err.message || "Failed to create product variant"));
          });
      } catch (err) {
        console.error("Exception in createProductVariant:", err);
        reject(new Error(err.message || "Exception in createProductVariant"));
      }
    });
  },
  
  getProductVariants: async (productId) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij May 02, 2025 [Fixed column names and return type to ensure always array]
      
      try {
        // Use a query that explicitly lists all needed columns instead of pv.*
        const query = `
          SELECT 
            pv.id, 
            pv.product_id, 
            pv.name AS variant_name, 
            pv.status,
            pv.is_approve,
            pv.created_at,
            pv.updated_at,
            pv.created_by,
            pv.updated_by,
            pv.is_deleted,
            p.name as product_name,
            ARRAY_AGG(DISTINCT c.title) FILTER (WHERE c.title IS NOT NULL) as category_names
          FROM 
            tbl_product_variant pv
          LEFT JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          WHERE 
            pv.product_id = $1 AND 
            pv.is_deleted = 0
          GROUP BY 
            pv.id, pv.product_id, pv.name, pv.status, pv.is_approve, pv.created_at, pv.updated_at, 
            pv.created_by, pv.updated_by, pv.is_deleted, p.name
          ORDER BY pv.created_at DESC`;
        
        db.any(query, [productId])
          .then(function (data) {
            // Always return an array, even if empty
            resolve(data || []);
          })
          .catch(function (err) {
            console.error("Error in getProductVariants query:", err);
            reject(new Error(err.message || "Database error in getProductVariants"));
          });
      } catch (error) {
        console.error("Error in getProductVariants:", error);
        reject(new Error(error.message || "Exception in getProductVariants"));
      }
    });
  },
  
  // Changes by Agnij April 30, 2025 [Added search function for variants across all products]
  searchProductVariants: async (id, searchTerm, start_date, end_date, vendor_id, category_id, added_by, is_approve) => {
    return new Promise(function (resolve, reject) {
      
      try {
        // Build dynamic filter conditions and parameter list
        let conditions = [];
        let params = [];
        let paramIndex = 1;
        
        // Changes by Agnij May 02, 2025 [Fixed filter implementation to match product filters]
        // Base condition to filter out deleted variants
        conditions.push(`pv.is_deleted = 0`);
        
        // If ID is provided, add a specific variant ID filter
        if (id) {
          conditions.push(`pv.id = $${paramIndex}`);
          params.push(id);
          paramIndex++;
        }
        
        // Search term filter - improved with full-text search and similarity
        if (searchTerm && searchTerm.trim() !== "") {
          conditions.push(`(
            to_tsvector('english', pv.name) @@ plainto_tsquery('english', $${paramIndex})
            OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $${paramIndex})
            OR similarity(pv.name, $${paramIndex}) > 0.1
            OR similarity(p.name, $${paramIndex}) > 0.1
          )`);
          params.push(searchTerm);
          paramIndex++;
        }
        
        // Date range filter - with proper parsing and validation
        if (start_date) {
          try {
            const startDate = new Date(start_date);
            if (!isNaN(startDate.getTime())) {
              conditions.push(`pv.created_at >= $${paramIndex}`);
              params.push(startDate);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid start_date format:", e);
          }
        }
        
        if (end_date) {
          try {
            const endDate = new Date(end_date);
            if (!isNaN(endDate.getTime())) {
              // Add one day to include the entire end date
              endDate.setDate(endDate.getDate() + 1);
              conditions.push(`pv.created_at <= $${paramIndex}`);
              params.push(endDate);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid end_date format:", e);
          }
        }
        
        // Changes by Agnij May 02, 2025 [Added additional filters]
        // Vendor filter - improved to properly check any vendor mapping
        if (vendor_id && vendor_id !== '') {
          conditions.push(`EXISTS (
            SELECT 1 FROM tbl_product_variant_vendor_mapping pvvm
            WHERE pvvm.product_variant_id = pv.id AND pvvm.vendor_id = $${paramIndex}
          )`);
          params.push(vendor_id);
          paramIndex++;
        }
        
        // Category filter - improved to match all variants of products in the category
        if (category_id && category_id !== '') {
          conditions.push(`EXISTS (
            SELECT 1 FROM tbl_product_categories pc
            WHERE pc.product_id = p.id AND pc.category_id = $${paramIndex}
          )`);
          params.push(category_id);
          paramIndex++;
        }
        
        // Added by filter - properly check creators
        if (added_by && added_by !== '') {
          conditions.push(`(pv.created_by = $${paramIndex} OR p.created_by = $${paramIndex})`);
          params.push(added_by);
          paramIndex++;
        }
        
        // Approval status filter - with proper null/undefined checking
        if (is_approve !== undefined && is_approve !== null) {
          conditions.push(`pv.is_approve = $${paramIndex}`);
          params.push(is_approve);
          paramIndex++;
        }
        
        // Build the final WHERE clause
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        
        // Build the complete query with improved fields and sorting
        const query = `
          SELECT 
            pv.id, 
            pv.product_id, 
            pv.name, 
            pv.status,
            pv.is_approve,
            pv.created_at,
            pv.updated_at,
            pv.created_by,
            pv.updated_by,
            pv.is_deleted,
            pv.reject_reason_id,
            trr.reject_reason,
            p.name as product_name,
            ARRAY_AGG(DISTINCT c.title) FILTER (WHERE c.title IS NOT NULL) as category_names
          FROM 
            tbl_product_variant pv
          LEFT JOIN tbl_product_variant_vendor_mapping PVM ON PVM.product_variant_id = PV.id
          LEFT JOIN tbl_users U ON U.id = PVM.vendor_id
          LEFT JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          LEFT JOIN
            tbl_reject_reason trr ON pv.reject_reason_id = trr.id
          ${whereClause}
          GROUP BY 
            pv.id, pv.product_id, pv.name, pv.status, pv.is_approve,
            pv.created_at, pv.updated_at, pv.created_by, pv.updated_by, 
            pv.is_deleted, pv.reject_reason_id, trr.reject_reason, p.name
            ${searchTerm ? `, v_similarity_score, p_similarity_score, v_rank, p_rank` : ''}
          ORDER BY 
            ${searchTerm ? `
              GREATEST(v_rank, p_rank) DESC,
              GREATEST(v_similarity_score, p_similarity_score) DESC,
            ` : ''}
            pv.created_at DESC
          LIMIT 1000000
        `;
        
        
        db.any(query, params)
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            console.error("Error in searchProductVariants:", err);
            resolve([]);  // Return empty array on error to maintain consistent behavior
          });
      } catch (error) {
        console.error("Exception in searchProductVariants:", error);
        resolve([]);  // Return empty array on exception to maintain consistent behavior
      }
    });
  },
  
  updateProductVariant: async (variantObj, variantId) => {
    return new Promise(function (resolve, reject) {
      try {
        // Changes by Agnij May 02, 2025 [Enhanced to handle all edge cases in approval]
        if (!variantId) {
          reject(new Error("Variant ID is required"));
          return;
        }
        
        
        // Create dynamic update query based on provided fields
        let updateFields = [];
        let params = [];
        let paramIndex = 1;

        // Handle all possible fields that might be in the variantObj
        if (variantObj.name || variantObj.variant_name) {
          updateFields.push(`name = $${paramIndex}`);
          params.push(variantObj.variant_name || variantObj.name);
          paramIndex++;
        }
        
        // Ensure approval status is handled correctly
        if (variantObj.is_approve !== undefined) {
          // Convert to numeric value (0 or 1)
          const approvalValue = typeof variantObj.is_approve === 'string' 
            ? (variantObj.is_approve === '1' || variantObj.is_approve.toLowerCase() === 'true' ? 1 : 0)
            : (variantObj.is_approve ? 1 : 0);
            
          updateFields.push(`is_approve = $${paramIndex}`);
          params.push(approvalValue);
          paramIndex++;
        }
        
        // Handle rejection reason
        if (variantObj.reject_reason_id !== undefined) {
          updateFields.push(`reject_reason_id = $${paramIndex}`);
          params.push(variantObj.reject_reason_id);
          paramIndex++;
        }
        
        // Handle user who updated
        if (variantObj.updated_by !== undefined) {
          updateFields.push(`updated_by = $${paramIndex}`);
          params.push(variantObj.updated_by);
          paramIndex++;
        }
        
        // Always update the updated_at timestamp
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
        
        // Add the variantId as the last parameter
        params.push(variantId);
        
        // Only proceed if we have fields to update
        if (updateFields.length === 0) {
          console.error("No fields to update in updateProductVariant");
          reject(new Error("No valid fields provided for update"));
          return;
        }
        
        // Build and execute the query
        const query = `
          UPDATE tbl_product_variant 
          SET ${updateFields.join(', ')}
          WHERE id = $${paramIndex} 
          RETURNING id, name, is_approve, reject_reason_id, updated_at
        `;
        

        
        db.one(query, params)
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            console.error(`Error in updateProductVariant for ID ${variantId}:`, err);
            
            // Try with a simpler, more direct query as fallback
            const fallbackQuery = `
              UPDATE tbl_product_variant 
              SET is_approve = $1, 
                  reject_reason_id = $2,
                  updated_by = $3,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $4
              RETURNING id, name, is_approve
            `;
            
            
            db.one(fallbackQuery, [
              variantObj.is_approve !== undefined ? variantObj.is_approve : null,
              variantObj.reject_reason_id,
              variantObj.updated_by,
              variantId
            ])
              .then(function (fallbackData) {
                resolve(fallbackData);
              })
              .catch(function (fallbackErr) {
                console.error("Fallback update also failed:", fallbackErr);
                reject(new Error(`Failed to update variant: ${fallbackErr.message}`));
              });
          });
      } catch (error) {
        console.error("Exception in updateProductVariant:", error);
        reject(new Error(error.message || "Exception in updateProductVariant"));
      }
    });
  },
  
  deleteProductVariant: async (variantId) => {
    return new Promise(function (resolve, reject) {
      db.one(
        `DELETE FROM tbl_product_variant 
        WHERE id = $1 
        RETURNING id`,
        [variantId]
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
  
  createProductVariantVendorMapping: async (mappingObj) => {
    return new Promise(function (resolve, reject) {
      // Construct the dynamic SQL query
      const query =
        pgp().helpers.insert(mappingObj, null, 'tbl_product_variant_vendor_mapping') +
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
  
  getProductVariantDetails: async (variantId) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij May 2, 2025 [Fixed variant details query to include all necessary fields]
      
      try {
        if (!variantId) {
          resolve([]);
          return;
        }
        
        // Enhanced query to get all necessary variant details
        const query = `
          SELECT 
            pv.id, 
            pv.product_id, 
            pv.name as variant_name,
            pv.status,
            pv.is_approve,
            pv.reject_reason_id, 
            pv.created_at,
            pv.updated_at,
            pv.created_by,
            pv.updated_by,
            pv.is_deleted,
            p.name as product_name,
            p.description as product_description,
            trr.reject_reason,
            ARRAY_AGG(DISTINCT jsonb_build_object(
              'category_name', c.title,
              'category_id', c.id
            )) FILTER (WHERE c.id IS NOT NULL) as categories
          FROM 
            tbl_product_variant pv
          LEFT JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN 
            tbl_reject_reason trr ON pv.reject_reason_id = trr.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          WHERE 
            pv.id = $1 AND pv.is_deleted = 0
          GROUP BY 
            pv.id, pv.product_id, pv.name, pv.status, pv.is_approve,
            pv.reject_reason_id, pv.created_at, pv.updated_at, pv.created_by, 
            pv.updated_by, pv.is_deleted, p.name, p.description, trr.reject_reason
        `;
        
        
        db.any(query, [variantId])
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            console.error("Error in getProductVariantDetails:", err);
            reject(new Error(`Failed to get variant details: ${err.message}`));
          });
      } catch (err) {
        console.error("Exception in getProductVariantDetails:", err);
        reject(new Error(`Exception in getProductVariantDetails: ${err.message}`));
      }
    });
  },

  // Changes by Agnij May 2, 2025 [Added function to map variant with vendor]
  mapVariantWithVendor: async (variantId, vendorId) => {
    return new Promise(function (resolve, reject) {
      
      try {
        if (!variantId || !vendorId) {
          reject(new Error("Missing required parameters for mapping"));
          return;
        }

        // First check if mapping already exists
        db.oneOrNone(
          `SELECT id FROM tbl_product_variant_vendor_mapping 
           WHERE product_variant_id = $1 AND vendor_id = $2`,
          [variantId, vendorId]
        )
          .then(function (existingMapping) {
            if (existingMapping) {
              reject(new Error("Mapping already exists for this variant and vendor"));
              return;
            }

            // If no existing mapping, create new one
            const query = `
              INSERT INTO tbl_product_variant_vendor_mapping
                (product_variant_id, vendor_id, status, created_at)
              VALUES
                ($1, $2, true, CURRENT_TIMESTAMP)
              RETURNING 
                id as mapping_id,
                product_variant_id as variant_id,
                vendor_id,
                status,
                created_at as mapped_at
            `;

            db.one(query, [variantId, vendorId])
              .then(function (data) {

                resolve(data);
              })
              .catch(function (err) {
                console.error("Error creating mapping:", err);
                reject(new Error(`Failed to create mapping: ${err.message}`));
              });
          })
          .catch(function (err) {
            console.error("Error checking existing mapping:", err);
            reject(new Error(`Failed to check existing mapping: ${err.message}`));
          });
      } catch (err) {
        console.error("Exception in mapVariantWithVendor:", err);
        reject(new Error(`Exception in mapVariantWithVendor: ${err.message}`));
      }
    });
  },
  
  // Changes by Agnij May 2, 2025 [Added function to update variant-vendor mapping]
  updateVariantVendorMapping: async (mappingId, updateData) => {
    return new Promise(function (resolve, reject) {
      
      try {
        if (!mappingId || !updateData) {
          reject(new Error("Missing required parameters for mapping update"));
          return;
        }

        const query = `
          UPDATE tbl_product_variant_vendor_mapping
          SET 
            vendor_id = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING 
            id as mapping_id,
            product_variant_id as variant_id,
            vendor_id,
            status,
            created_at as mapped_at
        `;

        db.one(query, [updateData.vendor_id, mappingId])
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            console.error("Error updating mapping:", err);
            reject(new Error(`Failed to update mapping: ${err.message}`));
          });
      } catch (err) {
        console.error("Exception in updateVariantVendorMapping:", err);
        reject(new Error(`Exception in updateVariantVendorMapping: ${err.message}`));
      }
    });
  },
  
  deleteProductVariants: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `DELETE FROM tbl_product_variant
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
  
  checkDuplicateVariantName: async (productId, variantName) => {
    return new Promise(function (resolve, reject) {
      // Changes by Agnij April 30, 2025 [Fixed column name to match actual database schema]
      if (!productId || !variantName) {
        resolve([]);
        return;
      }

      // Simple, focused query to check for duplicate variant names
      const query = `
        SELECT id, name 
        FROM tbl_product_variant 
        WHERE LOWER(name) = LOWER($1) 
        AND product_id = $2
        AND is_deleted = 0
      `;
      
      
      db.any(query, [variantName, productId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error in checkDuplicateVariantName:", err);
          // In case of error, treat as if no duplicates exist to avoid blocking creation
          // but log the error for debugging
          resolve([]);
        });
    });
  },
  
  // Changes by Agnij 2023-05-30 [Fixed mapping check to handle deleted field]
  checkDuplicateVariantVendorMapping: async (variantId, vendorId) => {
    return new Promise(function (resolve, reject) {
      // First check if the table has a 'deleted' column
      db.any("SELECT column_name FROM information_schema.columns WHERE table_name = 'tbl_product_variant_vendor_mapping' AND column_name = 'deleted'")
        .then(function (columns) {
          let query;
          if (columns && columns.length > 0) {
            // Table has 'deleted' column
            // Changes by Agnij April 30, 2025 [Fixed column name from variant_id to product_variant_id]
            query = `SELECT * FROM tbl_product_variant_vendor_mapping 
                    WHERE product_variant_id = $1 AND vendor_id = $2 AND deleted = false`;
          } else {
            // Table doesn't have 'deleted' column
            // Changes by Agnij April 30, 2025 [Fixed column name from variant_id to product_variant_id]
            query = `SELECT * FROM tbl_product_variant_vendor_mapping 
                    WHERE product_variant_id = $1 AND vendor_id = $2`;
          }
          
          // Execute the appropriate query
          db.any(query, [variantId, vendorId])
            .then(function (data) {
              resolve(data);
            })
            .catch(function (err) {
              let error = new Error(err);
              reject(error);
            });
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  },
  
  getProductCategories: async (productId) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT pc.*, c.title as category_title, c.slug as category_slug 
        FROM tbl_product_categories pc
        INNER JOIN tbl_category c ON pc.category_id = c.id
        WHERE pc.product_id = $1`,
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

  // Changes by Agnij May 18, 2025 [Added function to get all variant-vendor mappings]
  // Changes by Agnij June 12, 2024 [Added variant_id parameter support]
  getVariantVendorMappings: (searchTerm, start_date, end_date, vendor_id, category_id, added_by, is_approve, page, limit, variant_id) => {
    return new Promise(function (resolve, reject) {
      try {
        // Changes by Agnij May 02, 2025 [Improved error handling for similarity search]

        // Parse pagination parameters with defaults
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;

        if (page < 1) page = 1;
        if (limit < 1) limit = 10;
        
        // Build WHERE conditions
        let conditions = [];
        let params = [];
        let paramIndex = 1;
        
        // Handle search term without using similarity or ts_rank that could cause errors
        if (searchTerm && searchTerm.trim() !== "") {
          // Use ILIKE for case insensitive matching instead of full text search or similarity
          conditions.push(`(
            v.name ILIKE $${paramIndex}
            OR p.name ILIKE $${paramIndex}
            OR u.name ILIKE $${paramIndex}
            OR u.email ILIKE $${paramIndex}
          )`);
          params.push(`%${searchTerm.trim()}%`);
          paramIndex++;
        }

        // Handle date filters
        if (start_date) {
          try {
            const startDate = new Date(start_date);
            if (!isNaN(startDate.getTime())) {
              conditions.push(`m.created_at >= $${paramIndex}`);
              params.push(startDate);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid start_date format:", e);
          }
        }

        if (end_date) {
          try {
            const endDate = new Date(end_date);
            if (!isNaN(endDate.getTime())) {
              endDate.setDate(endDate.getDate() + 1);
              conditions.push(`m.created_at <= $${paramIndex}`);
              params.push(endDate);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid end_date format:", e);
          }
        }

        // Changes by Agnij May 02, 2025 [Fixed vendor filter to properly find records]
        // Handle vendor filter - using correct field and parameter
        if (vendor_id && vendor_id !== '') {
          // The m.vendor_id is the correct field, but ensure it's cast to proper type
          conditions.push(`CAST(m.vendor_id AS TEXT) = $${paramIndex}`);
          params.push(vendor_id.toString());
          paramIndex++;
        }
        
        // Changes by Agnij June 12, 2024 [Added variant filter]
        // Handle variant filter - filter by specific variant ID
        if (variant_id && variant_id !== '') {
          conditions.push(`CAST(m.product_variant_id AS TEXT) = $${paramIndex}`);
          params.push(variant_id.toString());
          paramIndex++;
        }

        // Handle category filter - improved query to match products in the category
        if (category_id && category_id !== '') {
          conditions.push(`EXISTS (
            SELECT 1 FROM tbl_product_categories pc 
            WHERE pc.product_id = p.id AND pc.category_id = $${paramIndex}
          )`);
          params.push(category_id);
          paramIndex++;
        }

        // Changes by Agnij May 02, 2025 [Fixed added_by filter to check both variant and product creator]
        // Handle added_by filter to check both the variant creator and product creator
        if (added_by && added_by !== '') {
          conditions.push(`(m.created_by = $${paramIndex})`);
          params.push(added_by);
          paramIndex++;
        }

        // Handle approval status filter - proper null/undefined checking
        if (is_approve !== null && is_approve !== undefined && is_approve.trim() != '') {
          conditions.push(`${is_approve == '0' ? 'NOT' : ''} m.is_approved`);
        }

        // Build WHERE clause
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        
        // Changes by Agnij May 02, 2025 [Added pagination support to the query]
        // Calculate pagination values
        const offset = (page - 1) * limit;
        
        // First, get the total count of records for pagination
        const countQuery = `
          SELECT COUNT(DISTINCT m.id) as total_count
          FROM 
            tbl_product_variant_vendor_mapping m
          JOIN
            tbl_product_variant v ON v.id = m.product_variant_id
          JOIN
            tbl_product p ON p.id = v.product_id
          LEFT JOIN
            tbl_users u ON u.id = m.vendor_id
          LEFT JOIN
            tbl_reject_reason trr ON v.reject_reason_id = trr.id
          LEFT JOIN
            tbl_product_categories pc ON pc.product_id = p.id
          LEFT JOIN
            tbl_category c ON c.id = pc.category_id
          ${whereClause}
        `;
        
        // Build complete query with additional fields, sorting and pagination
        const query = `
          SELECT 
            m.id AS mapping_id,
            m.product_variant_id AS variant_id,
            m.vendor_id,
            m.status,
            m.created_at AS mapped_at,
            m.updated_at,
            m.approved_at,
            v.name AS variant_name,
            m.is_approved AS is_approve,
            v.reject_reason_id,
            rr.reject_reason,
            TC.name AS created_by,
            TU.name AS updated_by,
            TA.name AS approved_by,
            p.id AS product_id,
            p.name AS product_name,
            p.created_by AS product_created_by,
            u.id AS vendor_user_id,
            u.name AS vendor_name,
            u.email AS vendor_email,
            COALESCE(c.company_name, u.organization_name, u.name) AS vendor_organization,
            COALESCE(c.company_name, u.organization_name, u.name, 'Unknown Vendor') AS vendor_display_name,
            ${searchTerm ? `
              similarity(v.name, '${searchTerm}') AS v_similarity_score,
              similarity(p.name, '${searchTerm}') AS p_similarity_score,
              ts_rank_cd(to_tsvector('english', v.name), plainto_tsquery('english', '${searchTerm}')) AS v_rank,
              ts_rank_cd(to_tsvector('english', p.name), plainto_tsquery('english', '${searchTerm}')) AS p_rank,
            ` : ''}
            (
              SELECT json_agg(DISTINCT jsonb_build_object(
                'category_id', c.id,
                'category_name', c.title
              ))
              FROM tbl_product_categories pc
              LEFT JOIN tbl_category c ON c.id = pc.category_id
              WHERE pc.product_id = p.id
            ) AS categories
          FROM tbl_product_variant_vendor_mapping m
          JOIN tbl_product_variant v ON v.id = m.product_variant_id
          JOIN tbl_product p ON p.id = v.product_id
          LEFT JOIN tbl_users TC ON m.created_by = TC.id
          LEFT JOIN tbl_users TU ON m.updated_by = TU.id
          LEFT JOIN tbl_users TA ON m.approved_by = TA.id
          LEFT JOIN tbl_users u ON u.id = m.vendor_id
          LEFT JOIN tbl_company c ON c.id = u.company_id
          LEFT JOIN tbl_reject_reason rr ON rr.id = v.reject_reason_id
          ${whereClause}
          ORDER BY
            ${searchTerm ? `
              GREATEST(
                ts_rank_cd(to_tsvector('english', v.name), plainto_tsquery('english', '${searchTerm}')),
                ts_rank_cd(to_tsvector('english', p.name), plainto_tsquery('english', '${searchTerm}'))
              ) DESC,
              GREATEST(
                similarity(v.name, '${searchTerm}'),
                similarity(p.name, '${searchTerm}')
              ) DESC,
            ` : ''}
            m.id DESC
          LIMIT $${paramIndex}
          OFFSET $${paramIndex + 1}
        `;
        
        // Add pagination parameters
        params.push(limit);
        paramIndex++;
        params.push(offset);
        paramIndex++;

        
        // First get the count of total records
        db.one(countQuery, params.slice(0, params.length - 2))
          .then(countResult => {
            const totalItems = parseInt(countResult.total_count);
            
            // Then get the paginated data
            db.any(query, params)
              .then(function (data) {
                resolve({
                  data: data,
                  pagination: {
                    total: totalItems,
                    page: page,
                    limit: limit,
                    pages: Math.ceil(totalItems / limit)
                  }
                });
              })
              .catch(function (err) {
                console.error("Error in getVariantVendorMappings data query:", err);
                // Resolve with empty array instead of rejecting to maintain consistent behavior
                resolve({
                  data: [],
                  pagination: {
                    total: 0,
                    page: page,
                    limit: limit,
                    pages: 0
                  }
                });
              });
          })
          .catch(function (err) {
            console.error("Error in getVariantVendorMappings count query:", err);
            // Resolve with empty array instead of rejecting to maintain consistent behavior
            resolve({
              data: [],
              pagination: {
                total: 0,
                page: page,
                limit: limit,
                pages: 0
              }
            });
          });
      } catch (error) {
        console.error("Exception in getVariantVendorMappings:", error);
        // Resolve with empty array to maintain consistent behavior with other search functions
        resolve({
          data: [],
          pagination: {
            total: 0,
            page: page,
            limit: limit,
            pages: 0
          }
        });
      }
    });
  },

  // Changes by Agnij May 02, 2025 [Added function to approve/reject mappings]
  approveMapping: async (mappingObj, mappingId) => {

    console.log("Mapping Object:", mappingObj);
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;
      const values = [mappingId];
      
      let query = pgp().helpers.update(mappingObj, null, 'tbl_product_variant_vendor_mapping') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error approving mapping:", err);
          let error = new Error(err);
          reject(error);
        });
    });
  },
  
  // Changes by Agnij May 01, 2025 [Added function to get mapping by ID]
  // 25-05-2025 mukul make_name added
  getVariantVendorMappingById: async (mappingId) => {
    return new Promise(function (resolve, reject) {
      db.oneOrNone(
        `SELECT 
  m.id AS mapping_id,
  m.product_variant_id AS variant_id,
 
  created_by_user_m.name AS mapping_created_by_name,
  m.created_at AS mapping_created_at,
 
  updated_by_user_m.name AS mapping_updated_by_name,
  m.updated_at AS mapping_updated_at,

  approved_by_user_m.name AS mapping_approved_by_name,
  m.approved_at AS mapping_approved_at,

  ARRAY(
    SELECT vpm.vendor_approve_id 
    FROM tbl_vendorapprove_product_mapping vpm 
    WHERE vpm.variant_vendor_mapping_id = m.id
  ) AS approved_ids,

ARRAY(
  SELECT json_build_object('id', pvvm.id, 'make_name', pvvm.make_name)
  FROM tbl_product_variant_vendor_make pvvm
  WHERE pvvm.variant_vendor_map_id = m.id
) AS make_list,

  TU.name AS vendor_name,
  TU.email AS vendor_email,
  COALESCE(TC.company_name, TU.organization_name, TU.name) AS vendor_organization,
  TU.id AS vendor_id,

  m.status,
  m.created_at AS mapped_at,

  v.is_approve,
  v.reject_reason_id,
  trr.reject_reason,
  v.name AS variant_name,
 
  created_by_user_v.name AS variant_created_by_name,
  v.created_at AS variant_created_at,
 
  updated_by_user_v.name AS variant_updated_by_name,
  v.updated_at AS variant_updated_at,

  approved_by_user_v.name AS variant_approved_by_name,
  v.approved_at AS variant_approved_at,

  p.name AS product_name,
 
  created_by_user_p.name AS product_created_by_name,
  p.created_at AS product_created_at,
  
  updated_by_user_p.name AS product_updated_by_name,
  p.updated_at AS product_updated_at,

  approved_by_user_p.name AS product_approved_by_name,
  p.approved_at AS product_approved_at

FROM tbl_product_variant_vendor_mapping m

LEFT JOIN tbl_users TU ON TU.id = m.vendor_id
LEFT JOIN tbl_company TC ON TC.id = TU.company_id
LEFT JOIN tbl_product_variant v ON v.id = m.product_variant_id
LEFT JOIN tbl_product p ON p.id = v.product_id
LEFT JOIN tbl_reject_reason trr ON v.reject_reason_id = trr.id

-- JOINs for mapping-related users
LEFT JOIN tbl_users created_by_user_m ON created_by_user_m.id = m.created_by
LEFT JOIN tbl_users updated_by_user_m ON updated_by_user_m.id = m.updated_by
LEFT JOIN tbl_users approved_by_user_m ON approved_by_user_m.id = m.approved_by

-- JOINs for variant-related users
LEFT JOIN tbl_users created_by_user_v ON created_by_user_v.id = v.created_by
LEFT JOIN tbl_users updated_by_user_v ON updated_by_user_v.id = v.updated_by
LEFT JOIN tbl_users approved_by_user_v ON approved_by_user_v.id = v.approved_by

-- JOINs for product-related users
LEFT JOIN tbl_users created_by_user_p ON created_by_user_p.id = p.created_by
LEFT JOIN tbl_users updated_by_user_p ON updated_by_user_p.id = p.updated_by
LEFT JOIN tbl_users approved_by_user_p ON approved_by_user_p.id = p.vendor_approved_by

WHERE m.id = $1;

`,
        [mappingId]
      )
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error('Error getting mapping by ID:', err);
          let error = new Error(err);
          reject(error);
        });
    });
  },
  
  // Changes by Agnij May 01, 2025 [Added helper function to update a product variant]
  updateProductVariant: async (variantObj, variantId) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;
      const values = [variantId];
      
      let query = pgp().helpers.update(variantObj, null, 'tbl_product_variant') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error updating product variant:", err);
          let error = new Error(err);
          reject(error);
        });
    });
  },

  updateVariantMappingByData: async (variantObj, mappingId) => {
    return new Promise(function (resolve, reject) {
      const condition = ` WHERE id = $1 RETURNING id`;
      const values = [mappingId];
      
      let query = pgp().helpers.update(variantObj, null, 'tbl_product_variant_vendor_mapping') + condition;

      db.one(query, values)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error updating product variant vendor mapping:", err);
          let error = new Error(err);
          reject(error);
        });
    });
  },
  
  // Changes by Agnij May 02, 2025 [Added function to update variant approval status]
  updateProductVariantApproval: async (variantId, isApproved, rejectReasonId = null) => {
    return new Promise(function (resolve, reject) {
      // Create update object with approval status
      const updateObj = {
        is_approve: isApproved,
        updated_at: new Date()
      };
      
      // Add reject reason if provided and the status is rejected
      if (isApproved === 0 && rejectReasonId) {
        updateObj.reject_reason_id = rejectReasonId;
      }
      
      // If approving, clear any reject reason
      if (isApproved === 1) {
        updateObj.reject_reason_id = null;
      }
      
      // Build and execute query
      const query = pgp().helpers.update(updateObj, null, 'tbl_product_variant') + ` WHERE id = $1 RETURNING id`;
      
      db.one(query, [variantId])
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.error("Error updating variant approval:", err);
          reject(err);
        });
    });
  },
  // Changes by Agnij May 02, 2025 [Fixed v_rank column reference error]
  searchProductVariants: (id, searchTerm = "", startDate = null, endDate = null, vendorId = null, categoryId = null, addedBy = null, isApprove = null) => {
    return new Promise(function (resolve, reject) {
      try {
        const conditions = ['pv.is_deleted = 0'];
        const params = [];
        let paramIndex = 1;

        // Handle ID search
        if (id) {
          conditions.push(`pv.id = $${paramIndex}`);
          params.push(id);
          paramIndex++;
        }

        // Handle search term
        if (searchTerm && searchTerm.trim() !== '') {
          const searchTermParam = searchTerm.trim();
          
          // Add search conditions but don't reference calculated columns
          conditions.push(`(
            to_tsvector('english', pv.name) @@ plainto_tsquery('english', $${paramIndex})
            OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $${paramIndex})
            OR similarity(pv.name, $${paramIndex}) > 0.1
            OR similarity(p.name, $${paramIndex}) > 0.1
          )`);
          params.push(searchTermParam);
          paramIndex++;
        }

        // Handle date range
        if (startDate) {
          try {
            const startDateObj = new Date(startDate);
            if (!isNaN(startDateObj.getTime())) {
              conditions.push(`m.created_at >= $${paramIndex}`);
              params.push(startDateObj);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid start_date format:", e);
          }
        }

        if (endDate) {
          try {
            const endDateObj = new Date(endDate);
            if (!isNaN(endDateObj.getTime())) {
              endDateObj.setDate(endDateObj.getDate() + 1);
              conditions.push(`m.created_at <= $${paramIndex}`);
              params.push(endDateObj);
              paramIndex++;
            }
          } catch (e) {
            console.error("Invalid end_date format:", e);
          }
        }

        // Handle vendor filter
        if (vendorId && vendorId !== '') {
          conditions.push(`CAST(m.vendor_id AS TEXT) = $${paramIndex}`);
          params.push(vendorId.toString());
          paramIndex++;
        }

        // Handle category filter
        if (categoryId && categoryId !== '') {
          conditions.push(`EXISTS (
            SELECT 1 FROM tbl_product_categories pc 
            WHERE pc.product_id = p.id AND pc.category_id = $${paramIndex}
          )`);
          params.push(categoryId);
          paramIndex++;
        }

        // Handle added_by filter
        if (addedBy && addedBy !== '') {
          conditions.push(`(pv.added_by = $${paramIndex} OR p.added_by = $${paramIndex})`);
          params.push(addedBy);
          paramIndex++;
        }

        // Handle approval status filter
        if (isApprove !== null && isApprove !== undefined) {
          conditions.push(`pv.is_approve = $${paramIndex}`);
          params.push(isApprove);
          paramIndex++;
        }

        // Construct the full SQL query, avoiding alias references in GROUP BY
        const query = `
          SELECT 
            pv.id, 
            pv.product_id, 
            pv.name, 
            pv.status,
            pv.is_approve,
            pv.created_at,
            pv.updated_at,
            pv.created_by,
            pv.updated_by,
            pv.is_deleted,
            pv.reject_reason_id,
            trr.reject_reason,
            p.name as product_name,
            CASE WHEN $${paramIndex} <> '' THEN
              similarity(pv.name, $${paramIndex})
            ELSE 0 END AS v_similarity_score,
            CASE WHEN $${paramIndex} <> '' THEN
              similarity(p.name, $${paramIndex}) 
            ELSE 0 END AS p_similarity_score,
            ARRAY_AGG(DISTINCT jsonb_build_object(
              'category_name', c.title,
              'category_id', c.id
            )) FILTER (WHERE c.id IS NOT NULL) as categories,
            (
              SELECT ARRAY_AGG(DISTINCT vendor_id) 
              FROM tbl_product_variant_vendor_mapping pvvm 
              WHERE pvvm.product_variant_id = pv.id
            ) as vendor_ids,
            (
              SELECT ARRAY_AGG(DISTINCT u.name)
              FROM tbl_product_variant_vendor_mapping pvvm 
              JOIN tbl_users u ON pvvm.vendor_id = u.id
              WHERE pvvm.product_variant_id = pv.id
            ) as vendor_names
          FROM 
            tbl_product_variant pv
          JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          LEFT JOIN
            tbl_reject_reason trr ON pv.reject_reason_id = trr.id
          LEFT JOIN
            tbl_product_variant_vendor_mapping m ON pv.id = m.product_variant_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY 
            pv.id, pv.product_id, pv.name, pv.status, pv.is_approve,
            pv.created_at, pv.updated_at, pv.created_by, pv.updated_by, 
            pv.is_deleted, pv.reject_reason_id, trr.reject_reason, p.name
          ORDER BY 
            ${searchTerm && searchTerm.trim() !== '' ? 
              `GREATEST(
                CASE WHEN $${paramIndex} <> '' THEN similarity(pv.name, $${paramIndex}) ELSE 0 END,
                CASE WHEN $${paramIndex} <> '' THEN similarity(p.name, $${paramIndex}) ELSE 0 END
              ) DESC,` : 
              ''
            }
            pv.created_at DESC
          LIMIT 1000000
        `;
        
        // Add search term as the last parameter for similarity calculation
        params.push(searchTerm || '');

        db.any(query, params)
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            console.error("Error in searchProductVariants:", err);
            reject(err);
          });
      } catch (error) {
        console.error("Error in searchProductVariants try/catch:", error);
        reject(error);
      }
    });
  },
  
  // Changes by Agnij <current_date> [Implement server-side pagination for variant search]
  searchProductVariantsPaginated: async (filters, page = 1, limit = 10) => {
    return new Promise(async function (resolve, reject) {
      try {
        const { id, search_term, start_date, end_date, vendor_id, category_id, added_by, is_approve } = filters;

        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        if (page < 1) page = 1;
        if (limit < 1) limit = 10;
        const offset = (page - 1) * limit;

        let conditions = ['pv.is_deleted = 0'];
        let params = [];
        let paramIndex = 1;

        // Handle ID filter
        if (id) {
          conditions.push(`pv.id = $${paramIndex}`);
          params.push(id);
          paramIndex++;
        }

        // Handle search term using ILIKE
        if (search_term && search_term.trim() !== '') {
          conditions.push(`(
            to_tsvector('english', CONCAT(PV.name, ' - ', P.name)) @@ plainto_tsquery('english', '${search_term}')
            OR similarity(CONCAT(PV.name, ' - ', P.name), '${search_term}') > 0.1
          )`);
          params.push(`%${search_term.trim()}%`);
          paramIndex++;
        }

        // Handle date range
        if (start_date) {
          try {
            const startDate = new Date(start_date);
            if (!isNaN(startDate.getTime())) {
              conditions.push(`pv.created_at >= $${paramIndex}`);
              params.push(startDate);
              paramIndex++;
            }
          } catch (e) { console.error("Invalid start_date:", e); }
        }

        if (end_date) {
          try {
            const endDate = new Date(end_date);
            if (!isNaN(endDate.getTime())) {
              endDate.setDate(endDate.getDate() + 1); // Include the whole end day
              conditions.push(`pv.created_at <= $${paramIndex}`);
              params.push(endDate);
              paramIndex++;
            }
          } catch (e) { console.error("Invalid end_date:", e); }
        }

        // Handle vendor filter
        if (vendor_id && vendor_id !== '') {
          conditions.push(`EXISTS (SELECT 1 FROM tbl_product_variant_vendor_mapping pvvm WHERE pvvm.product_variant_id = pv.id AND pvvm.vendor_id = $${paramIndex})`);
          params.push(vendor_id);
          paramIndex++;
        }

        // Handle category filter
        if (category_id && category_id !== '') {
          conditions.push(`EXISTS (SELECT 1 FROM tbl_product_categories pc WHERE pc.product_id = p.id AND pc.category_id = $${paramIndex})`);
          params.push(category_id);
          paramIndex++;
        }
        
        // Handle added by filter
        if (added_by && added_by !== '') {
          // Assuming added_by refers to the variant creator
          conditions.push(`pv.created_by = $${paramIndex}`); 
          params.push(added_by);
          paramIndex++;
        }

        // Handle approval status filter
        if (is_approve !== undefined && is_approve !== null && is_approve !== '') {
           // Ensure is_approve is treated as a number/boolean
           const approvalValue = (is_approve === '1' || is_approve === 1 || is_approve === true) ? 1 : 0;
           conditions.push(`pv.is_approve = $${paramIndex}`);
           params.push(approvalValue);
           paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // --- Count Query ---
        const countQuery = `
          SELECT COUNT(DISTINCT pv.id) as total_count
          FROM 
            tbl_product_variant pv
          JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id
          ${whereClause}
        `;

        // --- Data Query ---
        const dataQuery = `
          SELECT 
            pv.id, 
            pv.product_id, 
            pv.name, 
            pv.status,
            pv.is_approve,
            pv.created_at,
            pv.updated_at,
            pv.approved_at,
            TC.name AS created_by,
            TU.name AS updated_by,
            TA.name AS approved_by,
            pv.is_deleted,
            pv.reject_reason_id,
            p.name as product_name,
            ${filters.id ? `
              JSON_BUILD_OBJECT(
                'approved', (
                  SELECT COUNT(*) 
                  FROM tbl_product_variant_vendor_mapping PVVM 
                  WHERE PVVM.product_variant_id = PV.id 
                  AND PVVM.is_approved
                ),
                'disapproved', (
                  SELECT COUNT(*) 
                  FROM tbl_product_variant_vendor_mapping PVVM 
                  WHERE PVVM.product_variant_id = PV.id 
                  AND NOT PVVM.is_approved
                )
              ) AS vendor_count,
            ` : ``}            
            ${search_term ? `
              similarity(CONCAT(PV.name, ' - ', P.name), '${search_term}') AS similarity_score,
              ts_rank_cd(to_tsvector('english', CONCAT(PV.name, ' - ', P.name)), plainto_tsquery('english', '${search_term}')) AS rank,
            ` : ''}
            ARRAY_AGG(DISTINCT c.title) FILTER (WHERE c.title IS NOT NULL) as category_names
          FROM 
            tbl_product_variant pv
          JOIN 
            tbl_product p ON pv.product_id = p.id
          LEFT JOIN tbl_users TC ON pv.created_by = TC.id
          LEFT JOIN tbl_users TU ON pv.updated_by = TU.id
          LEFT JOIN tbl_users TA ON pv.approved_by = TA.id
          LEFT JOIN 
            tbl_product_categories pc ON p.id = pc.product_id
          LEFT JOIN 
            tbl_category c ON pc.category_id = c.id

          ${whereClause}
          GROUP BY 
            pv.id, pv.product_id, pv.name, pv.status, pv.is_approve,
            pv.created_at, pv.updated_at, pv.created_by, pv.updated_by, 
            pv.is_deleted, pv.reject_reason_id, p.name, TC.name, TU.name, TA.name

          ${search_term ? `ORDER BY rank DESC, similarity_score DESC, PV.name ASC` : `ORDER BY PV.created_at DESC`} 
          LIMIT $${paramIndex}
          OFFSET $${paramIndex + 1}
        `;

        console.log("QUERY --------- ", dataQuery)
        
        // Add limit and offset parameters for data query
        const dataParams = [...params, limit, offset];

        // Execute count query
        const countResult = await db.one(countQuery, params);
        const totalItems = parseInt(countResult.total_count, 10) || 0;
        const totalPages = Math.ceil(totalItems / limit);

        // Execute data query
        const data = await db.any(dataQuery, dataParams);

        resolve({
          data: data || [],
          pagination: {
            total: totalItems,
            page: page,
            limit: limit,
            pages: totalPages
          }
        });

      } catch (error) {
        console.error("Error in searchProductVariantsPaginated:", error);
        // Return empty result on error to avoid breaking frontend
        resolve({
          data: [],
          pagination: { total: 0, page: page, limit: limit, pages: 1 }
        });
      }
    });
  },

  // 26-05-2025 mukul added function to get unique value from make list by variant id
 getMakeListByVariantId : async (variantId) => {
  return new Promise(function (resolve, reject) {
  const query = `
  SELECT DISTINCT m.id, m.make_name
  FROM tbl_product_variant_vendor_make m
  JOIN tbl_product_variant_vendor_mapping map ON m.variant_vendor_map_id = map.id
  JOIN tbl_product_variant v ON map.product_variant_id = v.id
  JOIN tbl_product p ON v.product_id = p.id
  WHERE map.product_variant_id = $1
  AND map.is_approved = TRUE   -- Vendor approval (minimum 1 approved vendor)
  AND v.is_approve = 1         -- Variant must be approved
  AND p.is_approve = 1         -- Product of variant must be approved
  `;

    db.any(query, [variantId])
      .then(function (data) {
        resolve(data); // Extract just the make_name
      })
      .catch(function (err) {
        let error = new Error(err);
        reject(error);
      });
  });
}
};

export default productModel;
