import express from 'express';
import multer from 'multer';
import { buyerGuard } from './guards.js';
import {
  listItems,
  createItem,
  suggestItems,
  updateItem,
  mapVariantToItem,
  getItemUoms,
  saveItemUoms,
  addItemBarcode,
  deleteItemBarcode,
  listHotelItems,
  saveHotelItem,
  getCompanySettings,
  saveCompanySettings,
  getHotelSettings,
  saveHotelSettings,
  getCategoryDefaults,
  saveCategoryDefaults,
  previewOpeningStock,
  postOpeningStock,
} from '../../controllers/inventory/setupController.js';

// The opening-stock sheet is parsed and never stored: keep it in memory.
const openingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/** Buyer routes: passportSignIn + noAcl([3]) per route. */
const router = express.Router();

router.get('/items', ...buyerGuard, listItems);
router.post('/items', ...buyerGuard, createItem);
router.get('/items/suggest', ...buyerGuard, suggestItems);
router.put('/items/:id', ...buyerGuard, updateItem);
router.post('/items/:id/variants', ...buyerGuard, mapVariantToItem);
router.get('/items/:id/uoms', ...buyerGuard, getItemUoms);
router.put('/items/:id/uoms', ...buyerGuard, saveItemUoms);
router.post('/items/:id/barcodes', ...buyerGuard, addItemBarcode);
router.delete('/items/:id/barcodes/:barcodeId', ...buyerGuard, deleteItemBarcode);
router.get('/hotel-items', ...buyerGuard, listHotelItems);
router.put('/hotel-items/:hotelId/:invItemId', ...buyerGuard, saveHotelItem);
router.get('/settings/company', ...buyerGuard, getCompanySettings);
router.put('/settings/company', ...buyerGuard, saveCompanySettings);
router.get('/settings/hotel/:hotelId', ...buyerGuard, getHotelSettings);
router.put('/settings/hotel/:hotelId', ...buyerGuard, saveHotelSettings);
router.get('/category-defaults', ...buyerGuard, getCategoryDefaults);
router.put('/category-defaults', ...buyerGuard, saveCategoryDefaults);
router.post('/opening/:hotelId/preview', ...buyerGuard, openingUpload.single('file'), previewOpeningStock);
router.post('/opening/:hotelId/post', ...buyerGuard, postOpeningStock);

export default router;
