import db from '../config/dbConn.js';

const generalModel = {
  getStates: async () => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_location_states ORDER BY state_name ASC`
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
  getCities: async (state_id) => {
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT id, city_name FROM tbl_location_cities WHERE state_id = ${state_id} ORDER BY city_name ASC`
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

export default generalModel;
