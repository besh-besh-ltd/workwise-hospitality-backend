import { Router } from 'express';
// import UsersController from '../../controllers/users/usersController.js';
import ProductsController from '../../controllers/products/productsController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/productValidation.js';
import { validateDbBody } from '../../validations/dbValidation/productDbValidation.js';
import passport from '../../middleware/passport.js';
import handle_auth from '../../helper/handleAuth.js';
import { acl } from '../../helper/common.js';

// const passportLogIn = passport.authenticate("jwtAdm", { session: false });

const passportLogIn = passport.authenticate('localUsr', { session: false });
const passportSignIn = passport.authenticate('jwtUsr', { session: false });

const ProductsRoutes = Router();
ProductsRoutes.post(
  '/product-search',
  // validateDbBody.user_id_profileexists,
  ProductsController.getProductSearch
);
ProductsRoutes.get(
  '/category-list',
  // validateDbBody.user_id_profileexists,
  ProductsController.categoryList
);
ProductsRoutes.post(
  '/vendor-list',
  // validateDbBody.user_id_profileexists,
  ProductsController.vendorList
);
ProductsRoutes.get(
  '/vendor-product-list',
  passportSignIn,
  acl([3, 4]),
  ProductsController.vendorProductList
);
ProductsRoutes.get(
  '/vendor-product-list-review',
  passportSignIn,
  acl([3, 4]),
  ProductsController.vendorProductListReview
);
ProductsRoutes.post(
  '/vendor-product-accept-review',
  passportSignIn,
  acl([3, 4]),
  validateBody(schemas.vendor_product_accept_review),
  ProductsController.vendorProductAcceptReview
);
ProductsRoutes.post(
  '/vendor-product-add',
  passportSignIn,
  acl([3, 4]),
  schema_posts.add_vendor_product,
  validateDbBody.add_vendor_product,
  ProductsController.vendorProductAdd
);
ProductsRoutes.put(
  '/vendor-product-edit/:id',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  validateDbBody.check_product,
  schema_posts.add_vendor_product,
  validateDbBody.add_vendor_product,
  ProductsController.vendorProductUpdate
);

ProductsRoutes.post(
  '/bulk-product-create',
  passportSignIn,
  acl([3, 4]),
  schema_posts.productBulkUpload,
  // validateBody(schemas.create_product)
  // validateDbBody.attributeIdExists,
  ProductsController.productBulkUpload
);

ProductsRoutes.get(
  '/vendor-product-details/:id',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  validateDbBody.check_product,
  ProductsController.vendorProductDetails
);

ProductsRoutes.delete(
  '/vendor-product-delete/:id',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  validateDbBody.check_product,
  ProductsController.vendorProductDelete
);

ProductsRoutes.get(
  '/approved-product-list',
  passportSignIn,
  acl([3, 4]),
  ProductsController.approvedProductList
);

//End API

export default ProductsRoutes;
