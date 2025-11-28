import { Router } from "express";
import { getProducts, getVendors } from "../../controllers/public/publicController.js";

const PublicRoutes = Router();

PublicRoutes.get('/products', getProducts);
PublicRoutes.get('/vendors', getVendors);

export default PublicRoutes;