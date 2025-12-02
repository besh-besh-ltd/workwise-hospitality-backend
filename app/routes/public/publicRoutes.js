import { Router } from "express";
import { addPublicUsers, getProducts, getPublicUsers, getVendors } from "../../controllers/public/publicController.js";

const PublicRoutes = Router();

PublicRoutes.get('/products', getProducts);
PublicRoutes.get('/vendors', getVendors);
PublicRoutes.post('/add-public-users',addPublicUsers);
PublicRoutes.get('/get-public-users',getPublicUsers);

export default PublicRoutes;