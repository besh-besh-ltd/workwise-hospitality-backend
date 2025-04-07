import db from '../config/dbConn.js';
import pgp from 'pg-promise';
import Config from '../config/app.config.js';
import { logError } from '../helper/common.js';

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
      return await db.any(`SELECT * FROM tbl_product WHERE id = $1 & created_by=1`, [product_id]);
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
          console.log("......",err);
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
    isFeatured,
    userId,
    onlyAddedByAdmin = null,
    categoryId = null,
    dateFrom = null,
    dateTo = null,
    status = null
  ) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';

      // Product name search with full-text search and similarity
      if (productName && productName !== '') {
        dynamicQuery += `
          AND (
            to_tsvector('english', PD.name) @@ plainto_tsquery('english', '${productName}')
            OR similarity(PD.name, '${productName}') > 0.2
          )`;
      }

      // Filter by approved products
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND PD.id IN (${filterProduct.id_array})`;
      }

      // Filter by vendor
      if (vendorId && vendorId !== '') {
        dynamicQuery += ` AND PD.created_by = '${vendorId}'`;
      }

      // Filter by featured status
      if (isFeatured && isFeatured !== '') {
        dynamicQuery += ` AND PD.is_featured = '${isFeatured}'`;
      }

      // Filter by added_by
      if (userId && userId !== '') {
        dynamicQuery += ` AND (PD.added_by = '${userId}' OR PD.created_by = '${userId}')`;
      }

      // Filter admin-added products
      if (onlyAddedByAdmin) {
        dynamicQuery += ` AND PD.created_by = 1`;
      }

      // Filter by category
      if (categoryId) {
        dynamicQuery += ` AND EXISTS (
          SELECT 1 FROM tbl_product_categories
          WHERE tbl_product_categories.product_id = PD.id 
          AND tbl_product_categories.category_id = ${categoryId}
        )`;
      }

      // Filter by date range
      if (dateFrom) {
        dynamicQuery += ` AND DATE(PD.created_at) >= DATE('${dateFrom}')`;
      }
      if (dateTo) {
        dynamicQuery += ` AND DATE(PD.created_at) <= DATE('${dateTo}')`;
      }

      // Filter by status (approval status)
      if (status !== null && status !== undefined && status !== '') {
        // Convert status to integer to avoid type conversion issues
        const statusInt = parseInt(status, 10);
        if (!isNaN(statusInt)) {
          dynamicQuery += ` AND PD.is_approve = ${statusInt}`;
        }
      }

      // Determine the ORDER BY clause based on whether productName is provided
      let orderByClause = productName && productName !== ''
        ? `ORDER BY rank DESC, similarity_score DESC, PD.created_at DESC`
        : `ORDER BY PD.created_at DESC`;

      db.any(`
        SELECT 
          PD.*,
          USERS.name as vendor_name,
          approved_user.name as vendor_approved_by,
          added_user.name as added_by,
          trr.reject_reason,
          tpi.new_image_name,
          ARRAY (
            SELECT json_build_object('category_name', tc.title, 'id', tc.id)
            FROM tbl_product_categories pc
            LEFT JOIN tbl_category tc ON pc.category_id = tc.id
            WHERE PD.id = pc.product_id 
            ORDER BY pc.id
          ) AS "product_categories",
          ARRAY (
            SELECT json_build_object(
              'variant_name', pv.variant_name,
              'variant_value', pv.variant_value,
              'id', pv.id
            )
            FROM tbl_product_variants pv 
            WHERE PD.id = pv.product_id
          ) AS "product_variants",
          similarity(PD.name, '${productName}') AS similarity_score,
          ts_rank_cd(to_tsvector('english', PD.name), plainto_tsquery('english', '${productName}')) AS rank
        FROM tbl_product PD
        LEFT JOIN tbl_users USERS ON PD.created_by = USERS.id
        LEFT JOIN tbl_users approved_user ON PD.vendor_approved_by = approved_user.id
        LEFT JOIN tbl_users added_user ON PD.added_by = added_user.id
        LEFT JOIN tbl_reject_reason trr ON PD.reject_reason_id = trr.id
        LEFT JOIN tbl_product_images tpi ON PD.id = tpi.product_id AND tpi.is_featured = 1
        WHERE USERS.is_deleted = 0
        AND EXISTS (
          SELECT 1 
          FROM tbl_product_categories pc 
          WHERE pc.product_id = PD.id
        )
        ${dynamicQuery}
        ${orderByClause}
        LIMIT ${limit} OFFSET ${offset}
      `)
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
  getProductCount: async (vendorId, productName, filterProduct, isFeatured, userId, categoryId, dateFrom, dateTo, status) => {
    return new Promise(function (resolve, reject) {
      let dynamicQuery = '';
      if (productName && productName != '') {
        dynamicQuery += ` AND tbl_product.name ILIKE '%${productName}%'`;
      }
      if (filterProduct?.id_array) {
        dynamicQuery += ` AND tbl_product.id IN (${filterProduct.id_array})`;
      }
      if (vendorId && vendorId != '') {
        dynamicQuery += ` AND tbl_product.created_by = ${vendorId}`;
      }
      if (isFeatured && isFeatured != '') {
        dynamicQuery += ` AND tbl_product.is_featured = '${isFeatured}'`;
      }
      if (categoryId) {
        dynamicQuery += ` AND EXISTS (
          SELECT 1 FROM tbl_product_categories
          WHERE tbl_product_categories.product_id = tbl_product.id 
          AND tbl_product_categories.category_id = ${categoryId}
        )`;
      }
      if (dateFrom) {
        dynamicQuery += ` AND DATE(tbl_product.created_at) >= DATE('${dateFrom}')`;
      }
      if (dateTo) {
        dynamicQuery += ` AND DATE(tbl_product.created_at) <= DATE('${dateTo}')`;
      }
      if (status !== null && status !== undefined && status !== '') {
        // Convert status to integer to avoid type conversion issues
        const statusInt = parseInt(status, 10);
        if (!isNaN(statusInt)) {
          dynamicQuery += ` AND tbl_product.is_approve = ${statusInt}`;
        }
      }
      
      db.any(
        `SELECT tbl_product.* FROM tbl_product
         LEFT JOIN tbl_users ON tbl_product.created_by = tbl_users.id 
         WHERE tbl_users.is_deleted = 0 
         AND tbl_product.is_deleted = 0 
         AND tbl_product.is_review = 0 ${dynamicQuery}`
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
  }
};

export default productModel;
