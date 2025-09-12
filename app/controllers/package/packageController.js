import {
  createPackage,
  getPackageById,
  listPackages,
  updatePackage,
  deletePackage,
  addPackageItem,
  removePackageItem,
  addPackageVendor,
  removePackageVendor
} from '../../models/packageModel.js';

const packageController = {
  // POST /packages
  create: async (req, res) => {
    try {
      const { name, created_by, updated_by, items, vendors } = req.body;
      if (!name) {
        return res.status(400).json({ status: 3, message: 'name is required' });
      }
      const data = await createPackage({ name, created_by, updated_by, items, vendors });
      return res.status(201).json({ status: 1, data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to create package', error: err.message });
    }
  },

  // GET /packages/:id
  getById: async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ status: 3, message: 'invalid id' });

      const data = await getPackageById(id);
      if (!data) return res.status(404).json({ status: 2, message: 'Package not found' });
      return res.status(200).json({ status: 1, data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to fetch package', error: err.message });
    }
  },

  // GET /packages
  list: async (req, res) => {
    try {
      const { q, created_by, page, limit, sort } = req.query;
      const data = await listPackages({ q, created_by, page, limit, sort });
      return res.status(200).json({ status: 1, ...data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to list packages', error: err.message });
    }
  },

  // PUT /packages/:id
  update: async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ status: 3, message: 'invalid id' });

      const { name, updated_by, items, vendors } = req.body;
      const data = await updatePackage(id, { name, updated_by, items, vendors });
      if (!data) return res.status(404).json({ status: 2, message: 'Package not found' });

      return res.status(200).json({ status: 1, data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to update package', error: err.message });
    }
  },

  // DELETE /packages/:id
  remove: async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ status: 3, message: 'invalid id' });

      const deleted = await deletePackage(id);
      if (!deleted) return res.status(404).json({ status: 2, message: 'Package not found' });

      return res.status(200).json({ status: 1, message: 'Package deleted', data: deleted });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to delete package', error: err.message });
    }
  },

  // POST /packages/:id/items
  addItem: async (req, res) => {
    try {
      const package_id = Number(req.params.id);
      const { name } = req.body;
      if (!package_id || !name) {
        return res.status(400).json({ status: 3, message: 'package_id and name are required' });
      }
      const data = await addPackageItem(package_id, { name });
      return res.status(201).json({ status: 1, data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to add item', error: err.message });
    }
  },

  // DELETE /packages/items/:itemId
  removeItem: async (req, res) => {
    try {
      const itemId = Number(req.params.itemId);
      if (!itemId) return res.status(400).json({ status: 3, message: 'invalid item id' });

      const data = await removePackageItem(itemId);
      if (!data) return res.status(404).json({ status: 2, message: 'Item not found' });

      return res.status(200).json({ status: 1, message: 'Item deleted', data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to delete item', error: err.message });
    }
  },

  // POST /packages/:id/vendors
  addVendor: async (req, res) => {
    try {
      const package_id = Number(req.params.id);
      const { vendor_id } = req.body;
      if (!package_id || !vendor_id) {
        return res.status(400).json({ status: 3, message: 'package_id and vendor_id are required' });
      }
      const data = await addPackageVendor(package_id, Number(vendor_id));
      return res.status(201).json({ status: 1, data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to add vendor', error: err.message });
    }
  },

  // DELETE /packages/vendors/:id
  removeVendor: async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ status: 3, message: 'invalid id' });

      const data = await removePackageVendor(id);
      if (!data) return res.status(404).json({ status: 2, message: 'Vendor link not found' });

      return res.status(200).json({ status: 1, message: 'Vendor removed', data });
    } catch (err) {
      return res.status(500).json({ status: 3, message: 'Failed to remove vendor', error: err.message });
    }
  }
};

export default packageController;