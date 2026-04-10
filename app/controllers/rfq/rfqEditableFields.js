/**
 * WH-69: Single source of truth for what is editable on an RFQ and what
 * counts as a "material" change (one that re-triggers approval).
 *
 * The keys here are tbl_rfq column names. To add a new editable field:
 *   1) Add an entry to RFQ_EDITABLE_FIELDS
 *   2) Add it to the snapshot validation in app/validations/rfqValidation.js
 *   3) Surface it in the frontend edit form
 *
 * `material: true` means: changing this field cancels the current approval
 * instance and creates a new one.
 *
 * Hotels are intentionally NOT in this map — hotel mappings are immutable
 * post-create. The diff helper rejects any attempt to change them.
 */

export const RFQ_EDITABLE_FIELDS = {
  // ── Cosmetic ───────────────────────────────────────────────────────────
  title:           { material: false },
  comment:         { material: false },
  contact_name:    { material: false },
  contact_number:  { material: false },
  response_email:  { material: false },
  location:        { material: false },

  // ── Material (re-trigger approval) ─────────────────────────────────────
  bid_end_date:              { material: true },
  tender_publish_date:       { material: true },
  tender_fees:               { material: true },
  vendor_clarification_date: { material: true },
  rfq_type:                  { material: true },
  reverse_auction:           { material: true },
  ra_start_date:             { material: true },
  ra_end_date:               { material: true },
  project_id:                { material: true }
};

/**
 * Material rules for non-RFQ entities. Anything not listed here is cosmetic.
 */
export const ENTITY_MATERIAL_RULES = {
  PRODUCT:           { CREATE: true,  DELETE: true,  UPDATE: false }, // product comment is the only updatable field, treat cosmetic
  PRODUCT_SPEC:      { CREATE: true,  DELETE: true,  UPDATE: true  },
  PRODUCT_FILE:      { CREATE: true,  DELETE: true,  UPDATE: true  },
  PRODUCT_VENDOR:    { CREATE: true,  DELETE: true,  UPDATE: true  },
  PRODUCT_TECH_EVAL: { CREATE: true,  DELETE: true,  UPDATE: true  },
  TERMS:             { CREATE: false, DELETE: false, UPDATE: false }
};

export function isFieldMaterial(fieldName) {
  return !!RFQ_EDITABLE_FIELDS[fieldName]?.material;
}

export function isEntityChangeMaterial(entityType, changeType) {
  return !!ENTITY_MATERIAL_RULES[entityType]?.[changeType];
}

export function isFieldEditable(fieldName) {
  return Object.prototype.hasOwnProperty.call(RFQ_EDITABLE_FIELDS, fieldName);
}
