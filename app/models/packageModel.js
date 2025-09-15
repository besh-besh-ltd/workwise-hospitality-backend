import db from "../config/dbConn.js";

// Create package with optional items and vendors in one transaction
export async function createPackage({ name, created_by, updated_by, items = [], vendors = [] }) {
  return db.tx(async t => {
    const pkg = await t.one(
      `INSERT INTO tbl_package (name, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       RETURNING *`,
      [name ?? null, created_by ?? null, updated_by ?? null]
    );

    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        await t.one(
          `INSERT INTO tbl_package_items (name, package_id)
           VALUES ($1, $2)
           RETURNING id`,
          [it.name, pkg.id]
        );
      }
    }

    if (Array.isArray(vendors) && vendors.length > 0) {
      for (const v of vendors) {
        const vendorId = typeof v === 'object' ? v.vendor_id : v;
        await t.one(
          `INSERT INTO tbl_package_vendors (package_id, vendor_id)
           VALUES ($1, $2)
           RETURNING id`,
          [pkg.id, vendorId]
        );
      }
    }

    const full = await getPackageById(pkg.id, t);
    return full;
  });
}

// Read one package with items and vendors
export async function getPackageById(id, cn = db) {
  const pkg = await cn.oneOrNone(`SELECT * FROM tbl_package WHERE id = $1`, [id]);
  if (!pkg) return null;

  const items = await cn.manyOrNone(
    `SELECT id, name, package_id
     FROM tbl_package_items
     WHERE package_id = $1
     ORDER BY id`,
    [id]
  );

  const vendors = await cn.manyOrNone(
    `SELECT id, package_id, vendor_id
     FROM tbl_package_vendors
     WHERE package_id = $1
     ORDER BY id`,
    [id]
  );

  return { ...pkg, items, vendors };
}

// List packages with basic filters and pagination
export async function listPackages({ q = null, created_by = null, page = 1, limit = 20, sort = 'DESC' } = {}) {
  const offset = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(limit));
  const clauses = [];
  const values = [];
  let i = 1;

  if (q) {
    clauses.push(`LOWER(name) LIKE $${i++}`);
    values.push(`%${String(q).toLowerCase()}%`);
  }
  if (created_by != null) {
    clauses.push(`created_by = $${i++}`);
    values.push(Number(created_by));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const data = await db.manyOrNone(
    `SELECT *
     FROM tbl_package
     ${where}
     ORDER BY id ${sort === 'ASC' ? 'ASC' : 'DESC'}
     LIMIT ${Math.max(1, Number(limit))} OFFSET ${offset}`,
    values
  );

  const countRow = await db.one(`SELECT COUNT(*)::int AS count FROM tbl_package ${where}`, values);
  return { data, total: countRow.count, page: Number(page), limit: Number(limit) };
}

// Update package core fields and optionally replace items/vendors atomically
export async function updatePackage(id, { name, updated_by, items = null, vendors = null }) {
  return db.tx(async t => {
    // Update core
    const updated = await t.oneOrNone(
      `UPDATE tbl_package
       SET name = COALESCE($2, name),
           updated_by = COALESCE($3, updated_by),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, name ?? null, updated_by ?? null]
    );
    if (!updated) return null;

    // If items provided, replace set
    if (Array.isArray(items)) {
      await t.none(`DELETE FROM tbl_package_items WHERE package_id = $1`, [id]);
      for (const it of items) {
        await t.one(
          `INSERT INTO tbl_package_items (name, package_id)
           VALUES ($1, $2)
           RETURNING id`,
          [it.name, id]
        );
      }
    }

    // If vendors provided, replace set
    if (Array.isArray(vendors)) {
      await t.none(`DELETE FROM tbl_package_vendors WHERE package_id = $1`, [id]);
      for (const v of vendors) {
        const vendorId = typeof v === 'object' ? v.vendor_id : v;
        await t.one(
          `INSERT INTO tbl_package_vendors (package_id, vendor_id)
           VALUES ($1, $2)
           RETURNING id`,
          [id, vendorId]
        );
      }
    }

    const full = await getPackageById(id, t);
    return full;
  });
}

// Delete package and its relations
export async function deletePackage(id) {
  return db.tx(async t => {
    await t.none(`DELETE FROM tbl_package_items WHERE package_id = $1`, [id]);
    await t.none(`DELETE FROM tbl_package_vendors WHERE package_id = $1`, [id]);
    const deleted = await t.oneOrNone(`DELETE FROM tbl_package WHERE id = $1 RETURNING *`, [id]);
    return deleted;
  });
}

// Item-level CRUD (optional granularity)

// Add single item
export async function addPackageItem(package_id, { name }) {
  return db.one(
    `INSERT INTO tbl_package_items (name, package_id)
     VALUES ($1, $2)
     RETURNING *`,
    [name, package_id]
  );
}

// Remove single item
export async function removePackageItem(item_id) {
  return db.oneOrNone(
    `DELETE FROM tbl_package_items
     WHERE id = $1
     RETURNING *`,
    [item_id]
  );
}

// Vendor-level CRUD (optional granularity)

// Add single vendor
export async function addPackageVendor(package_id, vendor_id) {
  return db.one(
    `INSERT INTO tbl_package_vendors (package_id, vendor_id)
     VALUES ($1, $2)
     RETURNING *`,
    [package_id, vendor_id]
  );
}

// Remove single vendor
export async function removePackageVendor(id) {
  return db.oneOrNone(
    `DELETE FROM tbl_package_vendors
     WHERE id = $1
     RETURNING *`,
    [id]
  );
}