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
const passportSignIn = passport.authenticate(['jwtUsr', 'jwtAdm'], { session: false });

const ProductsRoutes = Router();
ProductsRoutes.post(
  '/product-search',
  // validateDbBody.user_id_profileexists,
  ProductsController.getProductSearch
);
ProductsRoutes.get(
  '/product-list-by-category',
  // validateDbBody.user_id_profileexists,
  ProductsController.getProductListbyCategory
);
ProductsRoutes.get(
  '/category-list',
  // validateDbBody.user_id_profileexists,
  ProductsController.categoryList
);
ProductsRoutes.get(
  '/parent-category-list',
  // validateDbBody.user_id_profileexists,
  ProductsController.parentCategoryList
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
  // schema_posts.add_vendor_product,
  validateDbBody.add_vendor_product,
  ProductsController.vendorProductAdd
);
ProductsRoutes.put(
  '/vendor-product-edit/:id',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  validateDbBody.checkVariant,
  // schema_posts.add_vendor_product,
  validateDbBody.add_vendor_product,
  ProductsController.vendorProductUpdate
);

// mukul 07-06-2025 ,  not in use, cross check and remove
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
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  // validateDbBody.check_product,
  ProductsController.vendorProductDetails
);
ProductsRoutes.get(
  '/product-details/:id',
  passportSignIn,
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  // validateDbBody.check_product,
  ProductsController.productDetails
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
  acl([2, 3, 8]),
  ProductsController.approvedProductList
);


//  delete this api ASAP, after review route again
ProductsRoutes.get(
  '/products-search-by-name-or-category',
   ProductsController.searchProductsByCategory
  );

  // mukul 07-06-2025 ,  not in use, cross check and remove
  ProductsRoutes.get(
    '/products-by-name-category-slug',
     ProductsController.getProductBySlugAndCategorySlug
    );

//  this api return a uniqle list for make product filter, mainly used in search vendor page of letsworkwise
ProductsRoutes.get(
'/product-make-list',
// passportSignIn,
ProductsController.getProductMakeList
);
//End API

// Package-related routes
ProductsRoutes.post(
  '/package-product',
  passportSignIn,
  acl([3, 4]),
  ProductsController.createPackageProduct
);

ProductsRoutes.put(
  '/package-product/:id',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  ProductsController.updatePackageProduct
);

ProductsRoutes.get(
  '/package-product/:id',
  passportSignIn,
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  ProductsController.getPackageProductDetails
);

ProductsRoutes.post(
  '/package-product/:id/items',
  passportSignIn,
  acl([3, 4]),
  validateParam(schemas.id),
  ProductsController.addPackageItem
);

ProductsRoutes.delete(
  '/package-items/:itemId',
  passportSignIn,
  acl([3, 4]),
  ProductsController.removePackageItem
);

ProductsRoutes.post(
  '/package-product/:id/vendors',
  passportSignIn,
  // acl([2, 3, 4]),
  validateParam(schemas.id),
  ProductsController.addPackageVendor
);

ProductsRoutes.delete(
  '/package-vendors/:id',
  passportSignIn,
  acl([3, 4]),
  ProductsController.removePackageVendor
);

ProductsRoutes.get(
  '/package-product/:id/items',
  passportSignIn,
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  ProductsController.getPackageItems
);

ProductsRoutes.get(
  '/package-product/:id/vendors',
  passportSignIn,
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  ProductsController.getPackageVendors
);

ProductsRoutes.put(
  '/package-vendor-mapping/:id',
  passportSignIn,
  acl([1, 2, 3, 4]),
  validateParam(schemas.id),
  ProductsController.updatePackageVendorMapping
);

export default ProductsRoutes;
