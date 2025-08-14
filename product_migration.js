const fs = require('fs');
const csv = require('csv-parser');
const { Client } = require('pg');
const { default: db } = require('./app/config/dbConn');

async function readCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', data => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

// Tables where variant_id must be updated
const VARIANT_UPDATE_TABLES = [
    "tbl_product_variant_spec",
    "tbl_product_variant_vendor_make",
    "tbl_product_variant_vendor_mapping",
    "tbl_quote_items"
];

// ================= MAIN TASKS =================

// Process PRODUCT CSV
async function processProducts(products) {
    for (const p of products) {
        const id = p.product_id;
        const name = p.product_name;
        const action = p.action.trim().toLowerCase();
        const payload = p.action_payload;

        if (action === 'rename') {
            console.log(`Renaming product ${id} to "${payload}"`);
            await db.query('UPDATE tbl_product SET product_name = $1 WHERE product_id = $2', [payload, id]);
        
        } else if (action === 'remove') {
            console.log(`Replacing product ${id} with ${payload}`);
            // Re-map all variants from removable product_id to replaceable one
            await db.query('UPDATE tbl_product_variant SET product_id = $1 WHERE product_id = $2', [payload, id]);
            // Delete the old product record
            await db.query('DELETE FROM tbl_product WHERE product_id = $1', [id]);
        }
    }
}

// Process VARIANT CSV
async function processVariants(variants) {
    for (const v of variants) {
        const id = v.variant_id;
        const name = v.variant_name;
        const action = v.action.trim().toLowerCase();
        const payload = v.action_payload;

        if (action === 'rename') {
            console.log(`Renaming variant ${id} to "${payload}"`);
            await db.query('UPDATE tbl_product_variant SET variant_name = $1 WHERE product_variant_id = $2', [payload, id]);
        
        } else if (action === 'remove') {
            console.log(`Replacing variant ${id} with ${payload}`);
            
            // Update variant_id in all relevant tables
            for (const table of VARIANT_UPDATE_TABLES) {
                await db.query(
                    `UPDATE ${table} SET product_variant_id = $1 WHERE product_variant_id = $2`,
                    [payload, id]
                );
            }

            // Delete the old variant record
            await db.query('DELETE FROM tbl_product_variant WHERE product_variant_id = $1', [id]);
        }
    }
}

// ================ EXECUTION ================
(async () => {
    try {
        console.log('Reading CSV files...');
        const products = await readCSV('./product.csv');
        const variants = await readCSV('./variant.csv');

        console.log('Processing products...');
        await processProducts(products);

        console.log('Processing variants...');
        await processVariants(variants);

        console.log('Migration completed successfully!');
    } catch (err) {
        console.error('Error occurred:', err);
    } finally {
        await db.end();
    }
})();
