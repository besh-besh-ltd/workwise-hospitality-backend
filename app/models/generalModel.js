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
  getCountryStates: async (country_id) => {
    return new Promise(function (resolve, reject) {
      db.any(`SELECT * FROM tbl_location_states WHERE country_id = $1 ORDER BY state_name ASC`, [country_id])
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
    let q = `SELECT tlc.*, tls.country_id FROM tbl_location_cities tlc JOIN tbl_location_states tls ON tlc.state_id = tls.id ORDER BY city_name ASC`;
    let value = [];
    if(state_id){
      q = `SELECT tlc.*, tls.country_id 
     FROM tbl_location_cities tlc
     JOIN tbl_location_states tls 
     ON tlc.state_id = tls.id 
     WHERE tlc.state_id = $1 
     ORDER BY city_name ASC`;
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
  },
  getCountries: async () =>{
    return new Promise(function (resolve, reject) {
      db.any(
        `SELECT * FROM tbl_location_country ORDER BY country_name ASC`
      ).then(function (data) {
        resolve(data);
      })
      .catch(function (err) {
        let error = new Error(err);
        reject(error);
      });

    })
  },
  getCountryCode : async () =>{
    return new Promise (function (resolve , reject ){
      db.any(`SELECT * FROM tbl_country_code ORDER BY phone_code ASC`)
      .then(function (data){
        resolve(data);
      }).catch(function (err){
        let error = new Error(err);
        reject(error);
      })
    })
  },
  getHolidays: async (date) => {
    return new Promise((resolve, reject) => {
      db.oneOrNone(`SELECT 1 FROM tbl_holidays WHERE date = $1`, [date])
        .then((data) => {
          resolve(data !== null); // true if date exists, false otherwise
        })
        .catch((err) => {
          reject(new Error(err));
        });
    });
  }
  
};

export default generalModel;
