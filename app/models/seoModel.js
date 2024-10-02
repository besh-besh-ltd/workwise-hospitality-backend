import db from '../config/dbConn.js';

const seoModel = {
    productSlugSitemap: async () => {
      return new Promise(function (resolve, reject) {
        db.any('select DISTINCT slug from tbl_product  WHERE created_by NOT IN (1, 111)')
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
