import db from '../config/dbConn.js';

const adminModel = {
  getUser: async (email) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_users WHERE status= 1 AND is_deleted = 0 AND email = $1 AND user_type NOT IN (2,3,4)`,
        [email]
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
  getUserById: async (id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_users WHERE status= 1 AND is_deleted = 0 AND id = $1`,
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
  }
};

export default adminModel;
