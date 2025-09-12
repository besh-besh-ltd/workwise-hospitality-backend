import db from '../config/dbConn.js';

const seoModel = {
    productSlugSitemap: async () => {
      return new Promise(function (resolve, reject) {
        db.any(`
          SELECT DISTINCT pv.slug
          FROM tbl_product_variant pv
          JOIN tbl_product_variant_vendor_mapping pvvm 
            ON pvvm.product_variant_id = pv.id
          WHERE pvvm.status = TRUE 
            AND pvvm.is_approved = TRUE
        `)
          .then(function (data) {
            resolve(data);
          })
          .catch(function (err) {
            let error = new Error(err);
            reject(error);
          });
      });
    }
}


export default seoModel;
