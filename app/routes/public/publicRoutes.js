import { Router } from "express";
import { addPublicUsers, getProducts, getPublicUsers, getVendors, getAllHotels } from "../../controllers/public/publicController.js";

const PublicRoutes = Router();

PublicRoutes.get('/products', getProducts);
PublicRoutes.get('/vendors', getVendors);
PublicRoutes.get('/hotels', getAllHotels);
PublicRoutes.post('/add-public-users',addPublicUsers);
PublicRoutes.get('/get-public-users',getPublicUsers);

export default PublicRoutes;