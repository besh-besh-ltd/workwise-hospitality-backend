import { Router } from 'express';
import ProductsRoutes from './productsRoutes.js';

const products = Router();
products.use('/', ProductsRoutes);

export default products;
