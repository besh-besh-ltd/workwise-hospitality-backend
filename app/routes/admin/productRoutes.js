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
  '/parent-category-list',
  productController.parentCategoryList
);
productRoutes.get(
  '/category-list',
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

productRoutes.post(
  '/admin-product-add',
  passportSignIn,
  // schema_posts.add_admin_product,
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
productRoutes.put(
  '/accept-variant/:id',
  passportSignIn,
  validateParam(schemas.id),
  // validateBody(schemas.product_approval),
  validateDbBody.variant_approve_check,
  productController.approveVariant
);
productRoutes.post(
  '/bulk-product-create',
  passportSignIn,
  schema_posts.productBulkUpload,
  productController.productBulkUpload
);
productRoutes.post(
  '/bulk-only-product-create',
  passportSignIn,
  schema_posts.productBulkUpload,
  productController.onlyProductBulkUpload
); 
productRoutes.get(
  '/product-count',
  passportSignIn,
  productController.productCount
);
productRoutes.get(
  '/get-product-by-id/:id',
  passportSignIn,
  productController.getProductById
);
productRoutes.get(
  '/product-list',
  passportSignIn,
  productController.productListImproved
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

productRoutes.post(
  '/map-vendor-with-product',
  passportSignIn,
  validateBody(schemas.vendor_product_map),
  validateDbBody.check_product,
  productController.mapVendorWithProduct
);

// Product Variant Routes
productRoutes.post(
  '/product-variant',
  passportSignIn,
  productController.addProductVariant
);

productRoutes.get(
  '/product-variant/:product_id',
  passportSignIn,
  productController.getProductVariants
);

productRoutes.get(
  '/search-variants',
  passportSignIn,
  productController.searchVariants
);

// Changes by Agnij May 02, 2025 [Added safe variant search endpoint without v_rank]
productRoutes.get(
  '/search-variants-safe',
  passportSignIn,
  productController.searchVariantsSafe
);

productRoutes.put(
  '/product-variant/:variant_id',
  passportSignIn,
  productController.updateProductVariant
);

productRoutes.delete(
  '/product-variant/:variant_id',
  passportSignIn,
  productController.deleteProductVariant
);

productRoutes.post(
  '/map-variant-with-vendor',
  passportSignIn,
  productController.mapVariantWithVendor
);

productRoutes.get(
  '/variant-mappings',
  passportSignIn,
  productController.getVariantMappings
);

productRoutes.get(
  '/variant-mappings/:id',
  passportSignIn,
  productController.getVariantMappingById
);

// Changes by Agnij April 30, 2025 [Added route for mapping approval]
productRoutes.put(
  '/mapping-approve/:id',
  passportSignIn,
  productController.approveMapping
);

productRoutes.post(
  '/variant-mapping-approve',
  passportSignIn,
  productController.approvedByVariantMapping
)

export default productRoutes;
