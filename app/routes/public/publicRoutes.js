import { Router } from "express";
import { getProducts, getVendors, getAllHotels } from "../../controllers/public/publicController.js";

const PublicRoutes = Router();

PublicRoutes.get('/products', getProducts);
PublicRoutes.get('/vendors', getVendors);
PublicRoutes.get('/hotels', getAllHotels);

export default PublicRoutes;