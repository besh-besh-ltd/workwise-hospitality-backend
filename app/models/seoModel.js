import db from '../config/dbConn.js';

const seoModel = {
    productSlugSitemap: async (limit = 50000, offset = 0) => {
      return new Promise(function (resolve, reject) {
        // First get total count
        db.one(`
          SELECT COUNT(DISTINCT pv.slug) as total
          FROM tbl_product_variant pv
          JOIN tbl_product_variant_vendor_mapping pvvm 
            ON pvvm.product_variant_id = pv.id
          WHERE pvvm.status = TRUE 
            AND pvvm.is_approved = TRUE
        `)
          .then(function (countResult) {
            // Then get paginated data
            db.any(`
              SELECT DISTINCT pv.slug
              FROM tbl_product_variant pv
              JOIN tbl_product_variant_vendor_mapping pvvm 
                ON pvvm.product_variant_id = pv.id
              WHERE pvvm.status = TRUE 
                AND pvvm.is_approved = TRUE
              ORDER BY pv.slug
              LIMIT $1 OFFSET $2
            `, [limit, offset])
              .then(function (data) {
                resolve({
                  productSlugList: data,
                  total: parseInt(countResult.total)
                });
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
    }
}


export default seoModel;
