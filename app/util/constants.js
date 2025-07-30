export const AVAILABLE_HIERARCHY_TYPES = {
  finalization: {
    type: 'finalization',
    target_entity_type: 'rfq_product'
  },
  po: {
    type: 'po',
    target_entity_type: 'purchase_order'
  }
};

export const APPROVAL_DECISIONS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

export const PO_STATUSES = {
  DRAFT: 'draft', 
  PENDING_APPROVAL: 'pending_approval', 
  APPROVED: 'approved', 
  SENT: 'sent', 
  GRN: 'GRN', 
  COMPLETED: 'completed', 
  CANCELLED: 'cancelled',
  REJECTED: 'rejected'
}
