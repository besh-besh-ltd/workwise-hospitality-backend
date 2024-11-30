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
    let q = `SELECT * FROM tbl_location_cities ORDER BY city_name ASC`;
    let value = [];
    if(state_id){
      q = `SELECT * FROM tbl_location_cities where state_id = $1 ORDER BY city_name ASC`;
      value = [state_id]
    }


    return new Promise(function (resolve, reject) {
      db.any(q, value)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          console.log(err)
          let error = new Error(err);
          reject(error);
        });
    });
  }
};

export default generalModel;
