import { Router } from 'express';
import productController from '../../controllers/admin/productController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/productValidation.js';
import { validateDbBody } from '../../validations/dbValidation/productDbValidation.js';
import passport from '../../middleware/passport.js';

const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const productRoutes = Router();

productRoutes.post(
  '/create-category',
  passportSignIn,
  validateBody(schemas.create_category),
  validateDbBody.parentIdExists,
  productController.createCategory
);
productRoutes.get(
  '/category-list',
  passportSignIn,
  productController.categoryList
);
productRoutes.get(
  '/category-dropdown',
  passportSignIn,
  productController.categoryDropdown
);
productRoutes.get(
  '/category-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.categoryIdExists,
  productController.categoryDetails
);

productRoutes.post(
  '/update-category/:id',
  passportSignIn,
  validateBody(schemas.update_category),
  validateDbBody.updateCategoryExists,
  productController.updateCategory
);
productRoutes.get(
  '/attribute-list',
  passportSignIn,
  productController.attributeList
);
productRoutes.get(
  '/attribute-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.attributeIdExists,
  productController.attributeDetails
);
productRoutes.post(
  '/create-attribute-value',
  passportSignIn,
  validateBody(schemas.create_attribute_value),
  validateDbBody.attributeIdExists,
  productController.createAttributeValue
);

productRoutes.put(
  '/delete-category/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.categoryActiveIdExists,
  productController.deleteCategory
);

// productRoutes.post(
//   '/create-product',
//   passportSignIn,
//   schema_posts.add_product_image,
//   validateBody(schemas.create_product),
//   validateDbBody.attributeIdExists,
//   productController.createProduct
// );
productRoutes.post(
  '/admin-product-add',
  passportSignIn,
  schema_posts.add_admin_product,
  validateDbBody.add_admin_product,
  productController.adminProductAdd
);

productRoutes.put(
  '/accept-product/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.product_approval),
  validateDbBody.product_approve_check,
  productController.approveProduct
);
productRoutes.post(
  '/bulk-product-create',
  passportSignIn,
  schema_posts.productBulkUpload,
  // validateBody(schemas.create_product)
  // validateDbBody.attributeIdExists,
  productController.productBulkUpload
);
productRoutes.post(
  '/bulk-only-product-create',
  passportSignIn,
  schema_posts.productBulkUpload,
  // validateBody(schemas.create_product)
  // validateDbBody.attributeIdExists,
  productController.onlyProductBulkUpload
);
productRoutes.get(
  '/product-list',
  passportSignIn,
  productController.productList
);
productRoutes.get(
  '/admin-product-list-review',
  passportSignIn,
  productController.adminProductListReview
);
productRoutes.post(
  '/admin-product-accept-review',
  passportSignIn,
  validateBody(schemas.admin_product_accept_review),
  productController.adminProductAcceptReview
);

productRoutes.post(
  '/bulk-product-upload-preview',
  passportSignIn,
  schema_posts.productBulkUpload,
  productController.bulkProductUploadPreview
);

productRoutes.post(
  '/export-products',
  passportSignIn,
  productController.exportProducts
);

productRoutes.put(
  '/admin-product-edit/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.check_product,
  schema_posts.add_admin_product,
  validateDbBody.add_admin_product,
  productController.adminProductUpdate
);

productRoutes.get(
  '/admin-product-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.check_product,
  productController.productDetails
);

productRoutes.delete(
  '/admin-product-delete/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.check_product,
  productController.adminProductDelete
);

export default productRoutes;
