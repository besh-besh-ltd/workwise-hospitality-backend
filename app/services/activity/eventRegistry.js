/**
 * The catalogue of things that happen, in the words an admin would use.
 *
 * Capture is registry-driven rather than call-site-driven. There are 343
 * mutating endpoints; hand-instrumenting them would never be complete and
 * would rot the first time somebody added number 344. The middleware records
 * every mutating request regardless — an unlisted route still produces a row —
 * and this file is what turns "POST /api/v1/rfq/finalize 200" into "Priya
 * awarded RFQ 536445 to 3 vendors".
 *
 * A missing entry is therefore a legibility gap, not a hole in the trail, and
 * the middleware counts them so the gap can be found rather than guessed at.
 *
 * Every `path` here was taken from the live Express router rather than read
 * off a controller, because a pattern that does not match is a silent failure:
 * the event simply stays unnamed forever.
 */

export const CATEGORIES = {
  SOURCING: 'Sourcing',
  QUOTING: 'Quoting',
  TECHNICAL: 'Technical Evaluation',
  NEGOTIATION: 'Negotiation',
  AWARDING: 'Awarding',
  ORDERS: 'Purchase Orders',
  RECEIPT: 'Goods Receipt',
  CONTRACTS: 'Rate Contracts',
  REQUISITIONS: 'Material Requisitions',
  ORGANISATION: 'Organisation',
  PEOPLE: 'People',
  ACCESS: 'Roles & Access',
  APPROVAL_CONFIG: 'Approval Setup',
  APPROVALS: 'Approvals',
  VENDORS: 'Vendors',
  BILLING: 'Billing',
  WORKWISE_ACCESS: 'Workwise Access',
  SYSTEM: 'System',
};

/** Where the entity id comes from. `response` covers the ~40 creations whose
 *  row does not exist until the insert returns. */
const P = (path) => ({ from: 'params', path });
const B = (path) => ({ from: 'body', path });
const R = (path = 'data.id') => ({ from: 'response', path });

/** How to find the company and unit. Never from headers — the codebase's own
 *  security work concluded those are not trustworthy for scoping. */
const SCOPE = {
  entity: (type) => ({ via: 'entity', type }),
  params: (companyKey, hotelKey) => ({ via: 'params', companyKey, hotelKey }),
  actor: () => ({ via: 'actor' }),
};

const e = (def) => def;

export const EVENTS = [
  // ── Sourcing ────────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/rfq/create', key: 'rfq_created',
    category: CATEGORIES.SOURCING, severity: 'notable',
    entity: { type: 'RFQ', id: R() }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} created RFQ ${c.entityLabel || ''}`.trim(),
  }),
  e({
    method: 'PUT', path: '/rfq/update', key: 'rfq_updated',
    category: CATEGORIES.SOURCING, severity: 'routine',
    entity: { type: 'RFQ', id: B('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} edited RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/rfq/force-publish/:id', key: 'rfq_force_published',
    category: CATEGORIES.SOURCING, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} force-published RFQ ${c.entityLabel} ahead of schedule`,
  }),
  e({
    method: 'POST', path: '/rfq/internal/publish', key: 'rfq_auto_published',
    category: CATEGORIES.SOURCING, severity: 'notable', source: 'CRON',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `RFQ ${c.entityLabel} was published automatically at its scheduled time`,
  }),
  e({
    method: 'POST', path: '/rfq/close-rfq/:id', key: 'rfq_closed',
    category: CATEGORIES.SOURCING, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} closed bidding on RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/rfq/withdraw-publish/:id', key: 'rfq_publish_withdrawn',
    category: CATEGORIES.SOURCING, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} withdrew RFQ ${c.entityLabel} from publication`,
  }),
  e({
    method: 'POST', path: '/rfq/terminate/:id', key: 'rfq_terminated',
    category: CATEGORIES.SOURCING, severity: 'critical',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} terminated RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/rfq/:id/approve-action', key: 'rfq_approval_decided',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) =>
      `${c.actor} ${c.body?.action === 'REJECT' ? 'rejected' : 'approved'} RFQ ${c.entityLabel} for publication`,
  }),

  // ── Quoting ─────────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/rfq/quote/create', key: 'quote_submitted',
    category: CATEGORIES.QUOTING, severity: 'critical',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} submitted a quote for RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'PUT', path: '/rfq/quote/update/:quoteId', key: 'quote_revised',
    category: CATEGORIES.QUOTING, severity: 'notable',
    entity: { type: 'QUOTE', id: P('quoteId') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} revised their quote`,
  }),

  // ── Technical evaluation ────────────────────────────────────────────────
  e({
    method: 'POST', path: '/rfq/tech-evaluation-cleared-vendors', key: 'tech_eval_cleared',
    category: CATEGORIES.TECHNICAL, severity: 'notable',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} recorded the technically cleared vendors for RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/rfq/tech-eval/submit-for-approval', key: 'tech_eval_submitted',
    category: CATEGORIES.TECHNICAL, severity: 'notable',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} submitted the technical evaluation of RFQ ${c.entityLabel} for approval`,
  }),
  e({
    method: 'POST', path: '/rfq/tech-eval/approval/action', key: 'tech_eval_decided',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) =>
      `${c.actor} ${c.body?.action === 'REJECT' ? 'rejected' : 'approved'} the technical evaluation of RFQ ${c.entityLabel}`,
  }),

  // ── Negotiation ─────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/negotiation/rounds', key: 'negotiation_round_opened',
    category: CATEGORIES.NEGOTIATION, severity: 'notable',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} opened a negotiation round on RFQ ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/negotiation/rounds/:id/approve', key: 'negotiation_round_approved',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'NEGOTIATION_ROUND', id: P('id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} approved negotiation round #${c.entityId}`,
  }),
  e({
    method: 'POST', path: '/negotiation/rounds/:id/reject', key: 'negotiation_round_rejected',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'NEGOTIATION_ROUND', id: P('id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} rejected negotiation round #${c.entityId}`,
  }),
  e({
    method: 'POST', path: '/negotiation/rounds/:id/close', key: 'negotiation_round_closed',
    category: CATEGORIES.NEGOTIATION, severity: 'notable',
    entity: { type: 'NEGOTIATION_ROUND', id: P('id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} closed negotiation round #${c.entityId}`,
  }),
  e({
    method: 'POST', path: '/negotiation/quotes/:rfq_product_id/approve', key: 'negotiated_quotes_approved',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'RFQ_PRODUCT', id: P('rfq_product_id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} approved the negotiated quotes for a product`,
  }),
  e({
    method: 'POST', path: '/negotiation/quotes/:rfq_product_id/reject', key: 'negotiated_quotes_rejected',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'RFQ_PRODUCT', id: P('rfq_product_id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} rejected the negotiated quotes for a product`,
  }),

  // ── Awarding ────────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/rfq/finalize', key: 'rfq_finalized',
    category: CATEGORIES.AWARDING, severity: 'critical',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} finalised the award on RFQ ${c.entityLabel}`,
  }),

  // ── Purchase orders ─────────────────────────────────────────────────────
  e({
    method: 'PUT', path: '/po/:po_id', key: 'po_updated',
    category: CATEGORIES.ORDERS, severity: 'notable',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} edited purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/initiate/:po_id', key: 'po_initiated',
    category: CATEGORIES.ORDERS, severity: 'notable',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} sent purchase order ${c.entityLabel} for approval`,
  }),
  e({
    method: 'POST', path: '/po/approve/:po_id', key: 'po_approved',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} approved purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/accept/:po_id', key: 'po_accepted',
    category: CATEGORIES.ORDERS, severity: 'critical',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} accepted purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/reject/:po_id', key: 'po_rejected',
    category: CATEGORIES.ORDERS, severity: 'critical',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} rejected purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/markGRN', key: 'po_grn_recorded',
    category: CATEGORIES.RECEIPT, severity: 'critical',
    entity: { type: 'PO', id: B('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} recorded goods receipt against purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/raiseInvoice', key: 'po_invoice_raised',
    category: CATEGORIES.ORDERS, severity: 'notable',
    entity: { type: 'PO', id: B('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} raised an invoice against purchase order ${c.entityLabel}`,
  }),

  // ── Organisation ────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/hospitality/company', key: 'company_created',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'COMPANY', id: R() }, scope: SCOPE.entity('COMPANY'),
    summary: (c) => `${c.actor} registered the company ${c.entityLabel || ''}`.trim(),
  }),
  e({
    method: 'PUT', path: '/hospitality/company/:company_id', key: 'company_updated',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'COMPANY', id: P('company_id') },
    // Entity first: it is the only source that knows the company's name, and
    // "updated the company profile for Company A" beats "for #10001".
    scope: [SCOPE.entity('COMPANY'), SCOPE.params('company_id')],
    summary: (c) => `${c.actor} updated the company profile for ${c.entityLabel || 'the company'}`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/hotels', key: 'business_unit_created',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'HOTEL', id: R() }, scope: SCOPE.params('company_id'),
    summary: (c) => `${c.actor} added the business unit ${c.entityLabel || c.body?.name || ''}`.trim(),
  }),
  e({
    method: 'PUT', path: '/hospitality/company/:company_id/hotels/:hotel_id', key: 'business_unit_updated',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'HOTEL', id: P('hotel_id') },
    scope: [SCOPE.entity('HOTEL'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) => `${c.actor} updated the business unit ${c.entityLabel || ''}`.trim(),
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/create-ho', key: 'head_office_created',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'COMPANY', id: P('company_id') },
    scope: [SCOPE.entity('COMPANY'), SCOPE.params('company_id')],
    summary: (c) => `${c.actor} created a head office unit for ${c.entityLabel || 'the company'}`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/map-users', key: 'users_mapped_to_unit',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'COMPANY', id: P('company_id') },
    scope: [SCOPE.entity('COMPANY'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) =>
      `${c.actor} gave ${(c.body?.user_ids || []).length || 'some'} user(s) access to ${c.entityLabel || 'the company'}`,
  }),
  e({
    method: 'DELETE', path: '/hospitality/user/:user_id/mapping', key: 'user_mapping_removed',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'USER', id: P('user_id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} removed a user's access to a business unit`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/hotels/:hotel_id/send-credentials',
    key: 'credentials_sent',
    category: CATEGORIES.PEOPLE, severity: 'notable',
    entity: { type: 'HOTEL', id: P('hotel_id') },
    scope: [SCOPE.entity('HOTEL'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) => `${c.actor} sent login credentials to users at ${c.entityLabel || 'a business unit'}`,
  }),

  // ── People and access ───────────────────────────────────────────────────
  e({
    method: 'POST', path: '/users/create-buyer-company-user', key: 'user_created',
    category: CATEGORIES.PEOPLE, severity: 'critical',
    entity: { type: 'USER', id: R() }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} created an account for ${c.body?.name || 'a new user'}`,
  }),
  e({
    method: 'PUT', path: '/users/update-user-detail', key: 'user_updated',
    category: CATEGORIES.PEOPLE, severity: 'notable',
    entity: { type: 'USER', id: B('user_id') }, scope: SCOPE.actor(),
    // This endpoint multiplexes profile edits, role grants, department moves
    // and activation. The middleware refines the sentence from what changed.
    summary: (c) => `${c.actor} updated a user account`,
  }),
  e({
    method: 'POST', path: '/users/:user_id/send-password-reset', key: 'password_reset_sent',
    category: CATEGORIES.PEOPLE, severity: 'critical',
    entity: { type: 'USER', id: P('user_id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} sent a password reset to a user`,
  }),
  e({
    method: 'POST', path: '/rbac/roles', key: 'role_created',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'ROLE', id: R() }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} created the role "${c.body?.title || 'a new role'}"`,
  }),
  e({
    method: 'PUT', path: '/rbac/roles/:roleId', key: 'role_updated',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'ROLE', id: P('roleId') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} changed what the role "${c.body?.title || `#${c.entityId}`}" can do`,
  }),

  // ── Approval configuration ──────────────────────────────────────────────
  e({
    method: 'POST', path: '/general/hospitality/approval/policies', key: 'approval_policy_saved',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical',
    entity: { type: 'APPROVAL_POLICY', id: R() },
    bodyScope: { companyKey: 'hospitality_company_id', hotelKey: 'hotel_id' },
    summary: (c) => `${c.actor} changed who approves ${c.body?.entity_type || 'work'} at this unit`,
  }),
  e({
    method: 'DELETE', path: '/general/hospitality/approval/policies/:id', key: 'approval_policy_deleted',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical',
    entity: { type: 'APPROVAL_POLICY', id: P('id') }, scope: SCOPE.entity('APPROVAL_POLICY'),
    summary: (c) => `${c.actor} deleted an approval policy`,
  }),
  e({
    method: 'POST', path: '/general/hospitality/approval/processes', key: 'approval_process_created',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'notable',
    entity: { type: 'APPROVAL_PROCESS', id: R() }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} created the approval workflow "${c.body?.name || 'a new workflow'}"`,
  }),
  e({
    method: 'DELETE', path: '/general/hospitality/approval/processes/:id', key: 'approval_process_deleted',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical',
    entity: { type: 'APPROVAL_PROCESS', id: P('id') }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} deleted an approval workflow`,
  }),

  // ── Approval decisions (the generic engine) ─────────────────────────────
  e({
    method: 'POST', path: '/general/hospitality/approval/submit', key: 'approval_submitted',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'APPROVAL_INSTANCE', id: R() }, scope: SCOPE.actor(),
    summary: (c) => `${c.actor} sent ${c.body?.entity_type || 'an item'} for approval`,
  }),
  e({
    method: 'POST', path: '/general/hospitality/approval/action', key: 'approval_decided',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'APPROVAL_INSTANCE', id: B('instance_id') },
    scope: SCOPE.entity('APPROVAL_INSTANCE'),
    summary: (c) =>
      `${c.actor} ${c.body?.action === 'REJECT' ? 'rejected' : 'approved'} ${c.entityLabel || 'an item'}`,
  }),
  e({
    method: 'POST', path: '/general/hospitality/approval/cancel', key: 'approval_cancelled',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'APPROVAL_INSTANCE', id: B('instance_id') },
    scope: SCOPE.entity('APPROVAL_INSTANCE'),
    summary: (c) => `${c.actor} cancelled an approval request`,
  }),

  // A GET that emails every vendor yet to quote. The verb says read; the
  // effect is a mail to every counterparty on the RFQ, which is exactly the
  // kind of event a buyer needs to see in the trail before they send a second
  // one. Naming it here is what makes it captured at all.
  e({
    method: 'GET', path: '/rfq/send-reminder/:id', key: 'rfq_reminder_sent',
    category: CATEGORIES.SOURCING, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `${c.actor} reminded every vendor yet to quote on RFQ ${c.entityLabel || c.entityId}`,
  }),

  // ── Workwise's own staff, in the internal console ───────────────────────
  //
  // The only entries here that are GETs. For a client's own people the trail
  // records what changed; for the supplier's staff working inside a customer's
  // account, looking is the thing worth recording, because "who at Workwise
  // can see our data" is the first question a client's security review asks.
  //
  // Unnamed internal routes are still recorded — the middleware files anything
  // by Workwise staff under this category — so this list makes the sentences
  // read properly rather than deciding what is captured.
  //
  // Routes that name no single customer (a list of every buyer, the companies
  // list) resolve to no company and so appear in nobody's feed. That is a
  // property of a cross-tenant endpoint, not an omission: there is no one
  // client whose trail it belongs in.
  e({
    method: 'GET', path: '/admin/buyer/buyer-details/:id', key: 'workwise_viewed_account',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) opened ${c.entityLabel || 'a user'}'s account`,
  }),
  e({
    method: 'GET', path: '/admin/buyer/buyer-rfq-list/:id', key: 'workwise_viewed_user_rfqs',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) listed ${c.entityLabel || 'a user'}'s RFQs`,
  }),
  e({
    method: 'PUT', path: '/admin/buyer/update-buyer/:id', key: 'workwise_edited_account',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'critical',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) edited ${c.entityLabel || 'a user'}'s account`,
  }),
  e({
    method: 'PUT', path: '/admin/buyer/block-buyer/:id', key: 'workwise_blocked_account',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'critical',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) blocked ${c.entityLabel || 'a user'}'s account`,
  }),
  e({
    method: 'PUT', path: '/admin/buyer/accept-buyer/:id', key: 'workwise_approved_account',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) approved ${c.entityLabel || 'a user'}'s account`,
  }),
  e({
    method: 'DELETE', path: '/admin/buyer/delete-buyer/:id', key: 'workwise_deleted_account',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'critical',
    entity: { type: 'USER', id: P('id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `Workwise staff (${c.actor}) deleted ${c.entityLabel || 'a user'}'s account`,
  }),
  e({
    method: 'GET', path: '/admin/rfq/rfq-list/:id', key: 'workwise_viewed_rfq',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `Workwise staff (${c.actor}) opened RFQ ${c.entityLabel || c.entityId}`,
  }),
  e({
    method: 'GET', path: '/admin/rfq/vendors-for-reminder/:id', key: 'workwise_viewed_rfq_vendors',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `Workwise staff (${c.actor}) listed the vendors yet to quote on RFQ ${c.entityLabel || c.entityId}`,
  }),
  // A GET that emails every vendor on the RFQ. Filtering capture on the verb
  // would have missed it entirely, which is why the registry is the trigger.
  e({
    method: 'GET', path: '/admin/rfq/send-reminder/:id', key: 'workwise_sent_reminder',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'critical',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `Workwise staff (${c.actor}) emailed every vendor yet to quote on RFQ ${c.entityLabel || c.entityId}`,
  }),
  e({
    method: 'POST', path: '/admin/rfq/send-selective-reminder/:id', key: 'workwise_sent_selective_reminder',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'critical',
    entity: { type: 'RFQ', id: P('id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) => `Workwise staff (${c.actor}) emailed selected vendors on RFQ ${c.entityLabel || c.entityId}`,
  }),
  e({
    method: 'POST', path: '/admin/rfq/update-status', key: 'workwise_changed_rfq_service_status',
    category: CATEGORIES.WORKWISE_ACCESS, severity: 'notable',
    entity: { type: 'RFQ', id: B('rfq_id') }, scope: SCOPE.entity('RFQ'),
    summary: (c) =>
      `Workwise staff (${c.actor}) marked their work on RFQ ${c.entityLabel || c.entityId} as ${c.body?.status || 'updated'}`,
  }),
];

const norm = (m, p) => `${m.toUpperCase()} ${p}`;

const BY_ROUTE = new Map(EVENTS.map((ev) => [norm(ev.method, ev.path), ev]));

export const lookupEvent = (method, path) => BY_ROUTE.get(norm(method, path)) || null;

export const REGISTRY_SIZE = EVENTS.length;
