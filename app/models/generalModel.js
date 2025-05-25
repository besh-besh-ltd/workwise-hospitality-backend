import db from '../config/dbConn.js';

const generalModel = {

// insertMany: used to insert multiple records into a table, Prevents SQL injection for values using positional placeholders, Suitable for low-to-medium data volume, problem is still we useing use input table_name good we create alist of while list tables for such models
// Example usage:
//  const tableName = "tbl_product_variant_vendor_make";
//  const data = [dor_map_id: 101, make_name: "Jindal"},
//   { variant_vendor_map_id: 102, make_name: "SAIL"}
// ];
  insertMany: async (tableName, data) => {
    if (!tableName || !data || !Array.isArray(data) || data.length === 0) {
    throw new Error("Table name and non-empty data array are required.");
  }

  // Extract column names from the first object in data array
  const columns = Object.keys(data[0]);
  const columnList = columns.map((col) => `"${col}"`).join(", ");

  // Prepare the positional placeholders and the value array
  const values = [];
  const valuePlaceholders = data
    .map((row, rowIndex) => {
      const placeholders = columns
        .map((col, colIndex) => {
          values.push(row[col]); // Collect values in order
          return `$${values.length}`; // Positional placeholders
        })
        .join(", ");
      return `(${placeholders})`;
    })
    .join(", ");

  const query = `INSERT INTO ${tableName} (${columnList}) VALUES ${valuePlaceholders} RETURNING *;`;

  try {
    const result = await db.any(query, values);
    return result;
  } catch (err) {
    throw new Error(err);
  }
  },

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
deleteFromTable : async (tableName, columnName, value) => {    //general function to delete a record from any table
  return new Promise((resolve, reject) => {
    // Validate inputs
    if (!tableName || !columnName) {
      return reject(new Error('Invalid table or column name'));
    }
    if (value === undefined || value === null) {
      return reject(new Error('Value to delete is required'));
    }

    const query = `DELETE FROM ${tableName} WHERE ${columnName} = $1`;

    db.result(query, [value])
      .then(result => {
        if (result.rowCount > 0) {
          resolve({ message: 'Delete successful', rowCount: result.rowCount });
        } else {
          resolve({ message: 'No rows deleted', rowCount: result.rowCount });
        }
      })
      .catch(err => {
        console.error('Error executing query', err);
        reject(new Error('Database error'));
      });
  });
},
}

export default generalModel;
