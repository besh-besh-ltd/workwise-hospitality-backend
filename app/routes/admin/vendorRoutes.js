import { Router } from 'express';

import vendorController from '../../controllers/admin/vendorController.js';
import {
  validateBody,
  validateParam,
  schemas,
  schema_posts
} from '../../validations/paramValidation/vendorValidation.js';
import { validateDbBody } from '../../validations/dbValidation/vendorDbValidation.js';

import passport from '../../middleware/passport.js';
const passportSignIn = passport.authenticate('jwtAdm', { session: false });

const vendorRoutes = Router();

vendorRoutes.get(
  '/vendor-list', 
  passportSignIn, 
  vendorController.vendorList
);

vendorRoutes.get(
  '/admin-users-list',
  passportSignIn,
  vendorController.getAdminUsers
);

vendorRoutes.post(
  '/create-vendor',
  passportSignIn,
  schema_posts.add_vendor,
  validateDbBody.vendor_exists,
  vendorController.addVendor
);
vendorRoutes.get(
  '/vendor-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.vendorDetails
);
vendorRoutes.get(
  '/vendor-edit-details/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.vendor_edit_details
);
vendorRoutes.get(
 '/get-vendor-locations/:id',
 passportSignIn,
 vendorController.getVendorLocations
)
vendorRoutes.post(
  '/map-spoc-location',
  passportSignIn,
  vendorController.mapSpocToLocation
)
vendorRoutes.post(
  '/add-vendor-location',
  passportSignIn,
  vendorController.addVendorLocation
)
vendorRoutes.put(
  '/update-vendor-location/:id',
  passportSignIn,
  vendorController.updateVendorLocation
)

vendorRoutes.delete(
  '/delete-vendor-location/:id',
  passportSignIn,
  vendorController.deleteVendorLocation
)
// vendorRoutes.get(
//   '/vendor-rfq-list/:id',
//   passportSignIn,
//   validateParam(schemas.id),
//   validateDbBody.vendor_id_exists,
//   vendorController.vendor_rfq_list
// );

vendorRoutes.delete(
  '/delete-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateDbBody.vendor_id_exists,
  vendorController.deleteVendor
);
vendorRoutes.put(
  '/block-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.vendor_block_check,
  vendorController.blockVendor
);
vendorRoutes.put(
  '/update-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  schema_posts.add_vendor,
  validateDbBody.vendor_id_exists,
  validateDbBody.vendor_email_mobile_exists,
  vendorController.updateVendor
);

// to add new spoc for the vendor
vendorRoutes.post(
  '/update-vendor/:id/add-spoc',
  passportSignIn,
  validateParam(schemas.new_spoc_params),
  validateBody(schemas.user_spoc),
  validateDbBody.vendor_id_exists,
  vendorController.addSpoc
)

vendorRoutes.put(
  '/update-vendor/:id/update-spoc/:spoc_id',
  passportSignIn,
  validateParam(schemas.spoc_params),
  validateBody(schemas.user_spoc),
  validateDbBody.vendor_id_exists,
  validateDbBody.spoc_id_exists,
  vendorController.updateSpoc
)
vendorRoutes.delete(
  '/update-vendor/:id/delete-spoc/:spoc_id',
  passportSignIn,
  validateParam(schemas.spoc_params),
  validateDbBody.vendor_id_exists,
  validateDbBody.spoc_id_exists,
  vendorController.deleteSpoc
)
vendorRoutes.put(
  '/accept-vendor/:id',
  passportSignIn,
  validateParam(schemas.id),
  validateBody(schemas.approval),
  validateDbBody.vendor_approve_check,
  vendorController.approveVendor
);

vendorRoutes.get(
  '/get-vendor-profile-documents',
  passportSignIn,
  vendorController.getVendorProfileDocuments
);

vendorRoutes.put(
  '/approve-vendor-profile-documents',
  passportSignIn,
  vendorController.approveVendorProfileDocuments
)

vendorRoutes.get(
  '/reject-reason-dropdown-list',
  passportSignIn,
  vendorController.rejectReasonDropdownList
);

vendorRoutes.get(
  '/vendor-dropdown-list',
  passportSignIn,
  vendorController.vendorDropdownList
);

vendorRoutes.get(
  '/buyer-company-dropdown',
  passportSignIn,
  vendorController.buyerCompanyDropdown
);

vendorRoutes.get(
  '/spoc-list',
  passportSignIn,
  vendorController.spocList
);

// Vendor Subscription Management
vendorRoutes.get(
  '/vendor-subscriptions/:id',
  passportSignIn,
  vendorController.getVendorSubscriptions
);
vendorRoutes.post(
  '/vendor-subscriptions/:id',
  passportSignIn,
  vendorController.upsertVendorSubscriptions
);
vendorRoutes.put(
  '/vendor-subscriptions/:id/status/:sub_id',
  passportSignIn,
  vendorController.updateSubscriptionStatus
);
vendorRoutes.delete(
  '/vendor-subscriptions/:id/delete/:sub_id',
  passportSignIn,
  vendorController.deleteSubscription
);
vendorRoutes.get(
  '/hotels-dropdown',
  passportSignIn,
  vendorController.getHotelsDropdown
);
vendorRoutes.get(
  '/categories-dropdown',
  passportSignIn,
  vendorController.getCategoriesDropdown
);

export default vendorRoutes;
