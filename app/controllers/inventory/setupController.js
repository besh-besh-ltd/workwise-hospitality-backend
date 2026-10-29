// Admin endpoints for the inventory module (Task B3): items, units, barcodes,
// hotel levels, settings, category defaults and the opening-stock import.
//
// Every handler runs its service inside db.tx and answers AFTER the
// transaction. Tenancy comes from req.user and the entity row; the company
// header/query hint can only narrow among companies the caller already holds
// the permission in.

import db from '../../config/dbConn.js';
import { sendInventoryError, InventoryError } from '../../services/inventory/errors.js';
import * as setup from '../../services/inventory/setupService.js';
import * as opening from '../../services/inventory/openingImport.js';

const companyHint = (req) =>
  req.query?.hospitality_company_id ||
  req.headers?.['x-hospitality-company'] ||
  req.headers?.['x-hospitality-company-id'] ||
  null;

const ok = (res, data, message = 'Success') => res.status(200).json({ status: 1, message, data });

function setAudit(res, audit) {
  res.locals.activityDetail = {
    scope: {
      hospitalityCompanyId: audit.companyId ?? null,
      hotelId: audit.hotelId ?? null,
      entityLabel: audit.label || null,
    },
  };
}

/** Reads: { rows } straight from the service. */
const reader = (fn, message) => async (req, res) => {
  let data;
  try {
    data = await db.tx((t) => fn(t, req));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return ok(res, data, message);
};

/** Mutations: the service returns { result, audit }. */
const writer = (fn, message) => async (req, res) => {
  let out;
  try {
    out = await db.tx((t) => fn(t, req));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  setAudit(res, out.audit);
  return ok(res, out.result, message);
};

export const listItems = reader((t, req) =>
  setup.listItems(t, req.user, {
    search: req.query.search,
    page: req.query.page,
    hotelId: req.query.hotelId,
    companyHint: companyHint(req),
  })
);
export const createItem = writer(
  (t, req) => setup.createItem(t, req.user, req.body, { companyHint: companyHint(req) }),
  'Item created'
);
export const suggestItems = reader((t, req) =>
  setup.suggestItems(t, req.user, { productVariantId: req.query.productVariantId, companyHint: companyHint(req) })
);
export const updateItem = writer((t, req) => setup.updateItem(t, req.user, req.params.id, req.body), 'Item saved');
export const mapVariantToItem = writer(
  (t, req) => setup.mapVariantToItem(t, req.user, req.params.id, req.body),
  'Product mapped'
);
export const getItemUoms = reader((t, req) => setup.getItemUoms(t, req.user, req.params.id));
export const saveItemUoms = writer((t, req) => setup.saveItemUoms(t, req.user, req.params.id, req.body), 'Units saved');
export const addItemBarcode = writer((t, req) => setup.addItemBarcode(t, req.user, req.params.id, req.body), 'Barcode added');
export const deleteItemBarcode = writer(
  (t, req) => setup.deleteItemBarcode(t, req.user, req.params.id, req.params.barcodeId),
  'Barcode removed'
);
export const listHotelItems = reader((t, req) =>
  setup.listHotelItems(t, req.user, { hotelId: req.query.hotelId, search: req.query.search, page: req.query.page })
);
export const saveHotelItem = writer(
  (t, req) => setup.saveHotelItem(t, req.user, { hotelId: req.params.hotelId, invItemId: req.params.invItemId }, req.body),
  'Stock levels saved'
);
export const getCompanySettings = reader((t, req) => setup.getCompanySettings(t, req.user, { companyHint: companyHint(req) }));
export const saveCompanySettings = writer(
  (t, req) => setup.saveCompanySettings(t, req.user, req.body, { companyHint: companyHint(req) }),
  'Settings saved'
);
export const getHotelSettings = reader((t, req) => setup.getHotelSettings(t, req.user, req.params.hotelId));
export const saveHotelSettings = writer(
  (t, req) => setup.saveHotelSettings(t, req.user, req.params.hotelId, req.body),
  'Settings saved'
);
export const getCategoryDefaults = reader((t, req) => setup.getCategoryDefaults(t, req.user, { companyHint: companyHint(req) }));
export const saveCategoryDefaults = writer(
  (t, req) => setup.saveCategoryDefaults(t, req.user, req.body, { companyHint: companyHint(req) }),
  'Category defaults saved'
);

/** Preview is a POST that is not an event: it reads a file, then answers. */
export const previewOpeningStock = async (req, res) => {
  let data;
  try {
    if (!req.file?.buffer) throw new InventoryError('VALIDATION', 'Attach the opening stock .xlsx file', { field: 'file' });
    // Items may be created lazily from a Variant SKU, so this commits.
    data = await db.tx((t) => opening.previewOpeningStock(t, req.user, req.params.hotelId, req.file.buffer));
  } catch (err) {
    return sendInventoryError(res, err);
  }
  return ok(res, data);
};

export const postOpeningStock = writer(
  (t, req) => opening.postOpeningStock(t, req.user, req.params.hotelId, req.body?.rows, req.body?.clientEventId),
  'Opening stock posted'
);
