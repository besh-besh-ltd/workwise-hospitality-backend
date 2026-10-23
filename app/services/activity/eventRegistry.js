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
  // What the controller validated and handed over on res.locals.activityDetail
  // — the only source for a fact that no longer exists once the request is
  // done, like the business unit a user was just removed from.
  detail: () => ({ via: 'detail' }),
  // The acting user's own buyer company, as a company-wide event. For things
  // that belong to the company as a whole, where filing them under whichever
  // unit the actor happens to be mapped to would be wrong.
  buyer: () => ({ via: 'actorBuyer' }),
};

const e = (def) => def;

/**
 * The verb for `POST /po/approve/:po_id`, mirroring what approvePO actually
 * does with the body: `decision === 'approved'` approves, and any other value
 * that passes its validation (`rejected`, but also `pending` and `cancelled`)
 * is sent to the engine as REJECT. Anything else is refused with a 400, and a
 * refused request must not be written up as a decision either way.
 *
 * A rejection takes one of two routes. CANCEL ("not needed any more") cancels
 * the PO rather than sending it back for re-award, and the trail says so. The
 * route the server actually took (response `data.route`) wins; without one the
 * body is read with the server's own default (NOT_REQUIRED means CANCEL).
 */
const poDecisionVerb = (decision, { route, reasonCategory } = {}) => {
  if (decision === 'approved') return 'approved';
  if (['rejected', 'pending', 'cancelled'].includes(decision)) {
    const taken = route
      ? String(route).toUpperCase()
      : String(reasonCategory || '').toUpperCase() === 'NOT_REQUIRED' ? 'CANCEL' : 'COMMERCIAL';
    return taken === 'CANCEL' ? 'cancelled' : 'rejected';
  }
  return 'tried to decide on';
};

/** "Final Awarding P2 at The Orchid Hotel Mumbai (Engineering)". */
const scopePhrase = (s) => {
  let phrase = s.role;
  phrase += s.hotel ? ` at ${s.hotel}` : ' across the company';
  if (s.department) phrase += ` (${s.department})`;
  if (s.process) phrase += ` for ${s.process}`;
  return phrase;
};

/**
 * "removed Final Awarding P2 at X; added Final Awarding P1 at X", or null when
 * the save did not touch approval roles. Removals first: when approval moves
 * from one person to another, what somebody lost is the part that surprises.
 */
const roleScopeChangePhrase = (roleScopes) => {
  const removed = roleScopes?.removed || [];
  const added = roleScopes?.added || [];
  if (removed.length === 0 && added.length === 0) return null;
  const parts = [];
  if (removed.length) parts.push(`removed ${removed.map(scopePhrase).join(', ')}`);
  if (added.length) parts.push(`added ${added.map(scopePhrase).join(', ')}`);
  return parts.join('; ');
};

/** "3 September 2026" — a feed sentence must never contain an ISO instant. */
const onDate = (value) => {
  if (!value) return 'a set date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'a set date';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

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
  // One route, both decisions: `decision` in the body chooses. This entry used
  // to be keyed `po_approved` with a fixed "approved" summary, so every PO
  // rejection taken on the PO page went into the trail as an approval — RFQ
  // 536263's two rejections on 11 Sep read "Vishal Kamat approved purchase
  // order 138721". Neutral key and a body-read verb, like every other decision
  // endpoint in this file.
  e({
    method: 'POST', path: '/po/approve/:po_id', key: 'po_approval_decided',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} ${poDecisionVerb(c.body?.decision, {
      route: c.response?.data?.route || c.body?.route,
      reasonCategory: c.body?.reason_category,
    })} purchase order ${c.entityLabel}`,
  }),
  // A PO put on hold to ask someone for information, and how the hold ends.
  // Answer and withdraw act on a send-back id; the response carries the PO's
  // id beside the send-back so the event files under the PO.
  e({
    method: 'POST', path: '/po/:po_id/send-back', key: 'po_send_back_requested',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'PO', id: P('po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} put purchase order ${c.entityLabel} on hold to ask for information`,
  }),
  e({
    method: 'POST', path: '/po/send-back/:id/respond', key: 'po_send_back_answered',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'PO', id: R('data.po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} answered the request for information on purchase order ${c.entityLabel}`,
  }),
  e({
    method: 'POST', path: '/po/send-back/:id/withdraw', key: 'po_send_back_withdrawn',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'PO', id: R('data.po_id') }, scope: SCOPE.entity('PO'),
    summary: (c) => `${c.actor} withdrew the request for information on purchase order ${c.entityLabel}`,
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
  // The unit the user was removed from no longer has a mapping row to look up
  // once the request is done, and the user's remaining mappings would name the
  // wrong unit — so the controller captures both names before deleting and
  // hands them over. It does so only when the removal actually happens: the
  // same route answers 200 with an approval-impact warning and changes
  // nothing, and that must not read as a removal.
  e({
    method: 'DELETE', path: '/hospitality/user/:user_id/mapping', key: 'user_mapping_removed',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'USER', id: P('user_id') }, scope: SCOPE.detail(), requireDetail: true,
    summary: (c) => {
      const who = c.detail?.user_label || "a user";
      const unit = c.detail?.unit_label || 'a business unit';
      const roles = c.detail?.removed_role_scopes
        ? ` (and ${c.detail.removed_role_scopes} role assignment${c.detail.removed_role_scopes === 1 ? '' : 's'} there)`
        : '';
      return `${c.actor} removed ${who} from ${unit}${roles}`;
    },
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/hotels/:hotel_id/send-credentials',
    key: 'credentials_sent',
    category: CATEGORIES.PEOPLE, severity: 'notable',
    entity: { type: 'HOTEL', id: P('hotel_id') },
    scope: [SCOPE.entity('HOTEL'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) => `${c.actor} sent login credentials to users at ${c.entityLabel || 'a business unit'}`,
  }),

  // The buyer company's own profile (name, GSTIN, head-office address). Not
  // any one hospitality company's, so it is a company-wide event, labelled
  // with the company's name. Vendors use the same route for their own profile;
  // a vendor's company has no administrator to show it to, so those resolve
  // to nothing and are counted as unscoped rather than written.
  e({
    method: 'PUT', path: '/users/update-company-detail', key: 'company_details_updated',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    scope: SCOPE.buyer(), labelFromBuyer: true,
    summary: (c) => `${c.actor} updated the company details for ${c.entityLabel || 'the company'}`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/map-projects', key: 'projects_mapped_to_unit',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'COMPANY', id: P('company_id') },
    scope: [SCOPE.entity('COMPANY'), SCOPE.params('company_id')],
    summary: (c) => {
      const n = (c.body?.project_ids || []).length;
      const what = n ? `${n} project${n === 1 ? '' : 's'}` : 'projects';
      const where = c.body?.hotel_id ? `a business unit of ${c.entityLabel || 'the company'}` : (c.entityLabel || 'the company');
      return `${c.actor} linked ${what} to ${where}`;
    },
  }),
  e({
    method: 'DELETE', path: '/hospitality/project/:project_id/mapping', key: 'project_mapping_removed',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'PROJECT', id: P('project_id') }, scope: SCOPE.entity('PROJECT'),
    // Placed by the controller's detail, not the body: the body's company is
    // checked against the caller but its unit is not, so a unit id belonging
    // to another tenant would have been filed (and named, through the
    // business-unit filter) in this company's trail. The controller hands over
    // only a unit where a mapping was actually removed.
    requireDetail: true,
    summary: (c) =>
      `${c.actor} unlinked the project ${c.entityLabel ? `"${c.entityLabel}"` : `#${c.entityId}`} from a business unit`,
  }),

  // ── People and access ───────────────────────────────────────────────────
  e({
    method: 'POST', path: '/users/create-buyer-company-user', key: 'user_created',
    category: CATEGORIES.PEOPLE, severity: 'critical',
    // Scoped by the NEW user's company, then the actor — see user_updated. The
    // 15 Sep creation of RFQ 536263's new step-2 approver was dropped because
    // the admin who created him had no company mapping of their own.
    entity: { type: 'USER', id: R() }, scope: SCOPE.entity('USER'),
    summary: (c) => {
      const who = c.body?.name || c.entityLabel || 'a new user';
      const granted = c.detail?.role_scopes?.added || [];
      return granted.length
        ? `${c.actor} created an account for ${who} with approval roles — ${granted.map(scopePhrase).join(', ')}`
        : `${c.actor} created an account for ${who}`;
    },
  }),
  e({
    method: 'PUT', path: '/users/update-user-detail', key: 'user_updated',
    category: CATEGORIES.PEOPLE, severity: 'notable',
    // Scoped by the EDITED user, then the actor. Scoping by the actor alone
    // meant an administrator with no hospitality mapping of their own — the
    // platform account that moved RFQ 536263's step-2 approver on 15 Sep —
    // resolved to no company, and every one of their edits was dropped.
    // With no user_id the controller edits the caller's own account, so the
    // subject is the caller (`orActor`) — otherwise a self-edit was filed as
    // "changed a user's approval roles", naming nobody.
    entity: { type: 'USER', id: { ...B('user_id'), orActor: true } }, scope: SCOPE.entity('USER'),
    // This endpoint multiplexes profile edits, role grants, department moves
    // and activation. When the save changed approval roles the controller
    // hands over the exact diff, and the sentence says who gained and lost what.
    summary: (c) => {
      const self = c.entityId != null && c.actorUserId != null && Number(c.entityId) === Number(c.actorUserId);
      const whose = self ? 'their own' : c.entityLabel ? `${c.entityLabel}'s` : 'a user\'s';
      const changes = roleScopeChangePhrase(c.detail?.role_scopes);
      if (changes) return `${c.actor} changed ${whose} approval roles — ${changes}`;
      if (self) return `${c.actor} updated their own account`;
      return `${c.actor} updated ${c.entityLabel ? `${c.entityLabel}'s account` : 'a user account'}`;
    },
  }),
  e({
    method: 'POST', path: '/users/:user_id/send-password-reset', key: 'password_reset_sent',
    category: CATEGORIES.PEOPLE, severity: 'critical',
    entity: { type: 'USER', id: P('user_id') }, scope: SCOPE.entity('USER'),
    summary: (c) => `${c.actor} sent a password reset to ${c.entityLabel || 'a user'}`,
  }),
  // Roles belong to the buyer company as a whole — they are company-wide
  // events. The response carries the new role's id as data.role_id, not
  // data.id; extracting the wrong path left every creation with no entity.
  // A person changing their own password. Self-service, but the first thing a
  // security review asks about an account suspected of misuse.
  e({
    method: 'POST', path: '/users/change-password', key: 'password_changed',
    category: CATEGORIES.PEOPLE, severity: 'notable',
    summary: (c) => `${c.actor} changed their password`,
  }),
  e({
    method: 'POST', path: '/rbac/roles', key: 'role_created',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'ROLE', id: R('data.role_id') }, scope: SCOPE.entity('ROLE'),
    summary: (c) => `${c.actor} created the role "${c.entityLabel || c.body?.title || 'a new role'}"`,
  }),
  e({
    method: 'PUT', path: '/rbac/roles/:roleId', key: 'role_updated',
    category: CATEGORIES.ACCESS, severity: 'critical',
    entity: { type: 'ROLE', id: P('roleId') }, scope: SCOPE.entity('ROLE'),
    summary: (c) =>
      `${c.actor} changed what the role "${c.entityLabel || c.body?.title || `#${c.entityId}`}" can do`,
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
  // Approval workflows are buyer-company-wide (tbl_approval_processes.company_id
  // is the tbl_company id). Deletion is soft, so a deleted one is still named.
  e({
    method: 'POST', path: '/general/hospitality/approval/processes', key: 'approval_process_created',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'notable',
    entity: { type: 'APPROVAL_PROCESS', id: R() }, scope: SCOPE.entity('APPROVAL_PROCESS'),
    summary: (c) =>
      `${c.actor} created the approval workflow "${c.entityLabel || c.body?.name || 'a new workflow'}"`,
  }),
  e({
    method: 'PUT', path: '/general/hospitality/approval/processes/:id', key: 'approval_process_updated',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'notable',
    entity: { type: 'APPROVAL_PROCESS', id: P('id') }, scope: SCOPE.entity('APPROVAL_PROCESS'),
    summary: (c) => {
      const name = c.entityLabel || 'an approval workflow';
      if (c.body?.is_active === false) return `${c.actor} switched off the approval workflow "${name}"`;
      if (c.body?.is_active === true && Object.keys(c.body).length === 1) {
        return `${c.actor} switched on the approval workflow "${name}"`;
      }
      return `${c.actor} edited the approval workflow "${name}"`;
    },
  }),
  e({
    method: 'DELETE', path: '/general/hospitality/approval/processes/:id', key: 'approval_process_deleted',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical',
    entity: { type: 'APPROVAL_PROCESS', id: P('id') }, scope: SCOPE.entity('APPROVAL_PROCESS'),
    summary: (c) => `${c.actor} deactivated the approval workflow "${c.entityLabel || `#${c.entityId}`}"`,
  }),

  // The legacy approval hierarchy (pre-policy engine). Its tables are empty on
  // production (checked 2026-10-12) and the policy engine replaced it, but the
  // routes are still mounted, so any use of them is recorded rather than
  // silent. Company-wide: a hierarchy belongs to the buyer company.
  e({
    method: 'POST', path: '/general/hierarchy', key: 'approval_hierarchy_created',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical', scope: SCOPE.buyer(),
    summary: (c) => `${c.actor} created a legacy approval hierarchy${c.body?.type ? ` (${c.body.type})` : ''}`,
  }),
  e({
    method: 'PUT', path: '/general/hierarchy', key: 'approval_hierarchy_updated',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical', scope: SCOPE.buyer(),
    summary: (c) => `${c.actor} changed a legacy approval hierarchy${c.body?.type ? ` (${c.body.type})` : ''}`,
  }),
  e({
    method: 'DELETE', path: '/general/hierarchy/:id', key: 'approval_hierarchy_deleted',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'critical', scope: SCOPE.buyer(),
    summary: (c) => `${c.actor} deleted legacy approval hierarchy #${c.params?.id}`,
  }),
  e({
    method: 'POST', path: '/general/mapHierarchyToProject', key: 'approval_hierarchy_mapped',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'notable', scope: SCOPE.buyer(),
    summary: (c) => `${c.actor} attached a legacy approval hierarchy to project #${c.body?.project_id ?? '?'}`,
  }),
  e({
    method: 'POST', path: '/general/setDefaultHierarchy', key: 'approval_hierarchy_default_set',
    category: CATEGORIES.APPROVAL_CONFIG, severity: 'notable', scope: SCOPE.buyer(),
    summary: (c) => `${c.actor} made a legacy approval hierarchy the company default`,
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
  // Removing a business unit or a company. Critical without qualification —
  // an archive hides an estate's worth of work from every list, and a delete
  // is the one action here with no undo.
  e({
    method: 'DELETE', path: '/hospitality/company/:company_id/hotels/:hotel_id',
    key: 'business_unit_removed',
    category: CATEGORIES.ORGANISATION, severity: 'critical',
    entity: { type: 'HOTEL', id: P('hotel_id') },
    // Entity first so an ARCHIVED unit is still named — its row survives. A
    // hard delete leaves nothing to look up, so the params fall-back keeps the
    // event scoped and the sentence degrades to "a business unit" rather than
    // vanishing from the feed.
    scope: [SCOPE.entity('HOTEL'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) =>
      `${c.actor} ${c.query?.archive === 'true' ? 'archived' : 'deleted'} ${c.entityLabel || 'a business unit'}`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/:company_id/hotels/:hotel_id/restore',
    key: 'business_unit_restored',
    category: CATEGORIES.ORGANISATION, severity: 'notable',
    entity: { type: 'HOTEL', id: P('hotel_id') }, scope: SCOPE.entity('HOTEL'),
    summary: (c) => `${c.actor} restored ${c.entityLabel || 'a business unit'}`,
  }),
  e({
    method: 'DELETE', path: '/hospitality/company/:company_id',
    key: 'company_removed',
    category: CATEGORIES.ORGANISATION, severity: 'critical',
    entity: { type: 'COMPANY', id: P('company_id') },
    scope: SCOPE.params('company_id'),
    summary: (c) => `${c.actor} removed a hospitality company`,
  }),

  // Cover. Notable rather than critical: it changes who is asked on approvals
  // created from now on, but it cannot touch one that already exists and it
  // cannot reach outside the company.
  e({
    method: 'POST', path: '/general/hospitality/approval/delegations',
    key: 'approval_delegation_created',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'APPROVAL_DELEGATION', id: R() }, scope: SCOPE.entity('APPROVAL_DELEGATION'),
    summary: (c) =>
      `${c.actor} arranged for ${c.entityLabel || 'someone to cover approvals'} until ${onDate(c.body?.ends_at)}`,
  }),
  e({
    method: 'DELETE', path: '/general/hospitality/approval/delegations/:id',
    key: 'approval_delegation_revoked',
    category: CATEGORIES.APPROVALS, severity: 'notable',
    entity: { type: 'APPROVAL_DELEGATION', id: P('id') }, scope: SCOPE.entity('APPROVAL_DELEGATION'),
    summary: (c) =>
      `${c.actor} ended ${c.entityLabel ? `the arrangement for ${c.entityLabel}` : 'an approval cover arrangement'} early`,
  }),

  // Changing who authorises spend on a live item, with a mandatory reason.
  // Critical without qualification: an unexplained reassignment is
  // indistinguishable after the fact from routing an approval to a friend.
  e({
    method: 'POST', path: '/general/hospitality/approval/stuck/:id/reassign',
    key: 'approval_reassigned',
    category: CATEGORIES.APPROVALS, severity: 'critical',
    entity: { type: 'APPROVAL_INSTANCE', id: P('id') },
    scope: SCOPE.entity('APPROVAL_INSTANCE'),
    summary: (c) =>
      `${c.actor} moved an approval on ${c.entityLabel || 'an item'} to a different approver — ${c.body?.reason || 'no reason given'}`,
  }),

  // ── Billing ─────────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/hospitality/company/:company_id/hotels/:hotel_id/send-payment-link',
    key: 'payment_link_sent',
    category: CATEGORIES.BILLING, severity: 'notable',
    entity: { type: 'HOTEL', id: P('hotel_id') },
    scope: [SCOPE.entity('HOTEL'), SCOPE.params('company_id', 'hotel_id')],
    summary: (c) => `${c.actor} sent a subscription payment link for ${c.entityLabel || 'a business unit'}`,
  }),
  e({
    method: 'POST', path: '/hospitality/company/send-batch-payment-links', key: 'payment_links_sent',
    category: CATEGORIES.BILLING, severity: 'notable',
    entity: { type: 'COMPANY', id: B('company_id') },
    // Validated against the caller's buyer company before any link is sent.
    scope: SCOPE.entity('COMPANY'),
    summary: (c) => {
      const n = (c.body?.hotel_ids || []).length;
      return `${c.actor} sent subscription payment links for ${n || 'several'} business unit${n === 1 ? '' : 's'} of ${c.entityLabel || 'the company'}`;
    },
  }),

  // ── Vendors ─────────────────────────────────────────────────────────────
  e({
    method: 'POST', path: '/users/buyer-private-vendor', key: 'private_vendor_added',
    category: CATEGORIES.VENDORS, severity: 'notable',
    summary: (c) =>
      `${c.actor} added ${c.body?.vendorName || 'a vendor'} to the company's ${Number(c.body?.is_private) === 1 ? 'private' : 'approved'} vendor list`,
  }),
  e({
    method: 'POST', path: '/users/buyer-excel-add-vendor', key: 'vendors_uploaded',
    category: CATEGORIES.VENDORS, severity: 'notable',
    summary: (c) => `${c.actor} added vendors to the company's vendor list from a spreadsheet`,
  }),

  // ── Workwise's own staff, in the internal console ───────────────────────
  //
  // The only entries here that are GETs. For a client's own people the trail
  // records what changed; for the supplier's staff working inside a customer's
  // account, looking is the thing worth recording, because "who at Workwise
  // can see our data" is the first question a client's security review asks.
  //
  // A staff event is placed only by what it touched — never by the staff
  // account's own company — so an internal route that should reach a
  // customer's trail needs an entry here naming its entity. An unnamed one
  // can only be placed by a controller's validated detail, and otherwise lands
  // nowhere rather than in the wrong client's feed.
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

/**
 * Mutating routes under the company-administration routers that are known NOT
 * to be events, so they are neither recorded nor reported as gaps.
 *
 * Each one is here on purpose. The route-coverage test fails for any mutating
 * admin route that is in neither list, which is what stops a new admin
 * endpoint going unlogged by default.
 */
export const NOT_AN_EVENT = [
  // Queries that use POST for their body. Several fire on every page load.
  'POST /rbac/me/permissions/bulk',
  'POST /users/get-dashboard-data',
  'POST /users/dashboard-search-vendor',

  // Signing in, registering and recovering an account. Sign-ins are already in
  // the trail from tbl_login_log; the rest happen before there is an account
  // or a company to file them under.
  'POST /users/login',
  'POST /users/social-login',
  'POST /users/refresh-token',
  'POST /users/forgot-password-otp-send',
  'POST /users/forgot-password-otp-authenticate',
  'POST /users/registration-otp-send',
  'POST /users/registration-otp-verify',
  'POST /users/user-registration',
  'POST /users/company-registration',
  'POST /users/registration-upload',
  'POST /users/verify-vendor-token',
  'POST /users/book-demo',

  // Read receipts and push subscriptions: per-person inbox state.
  'POST /users/notifications/subscribe',
  'POST /users/notifications/push-subscribe',
  'DELETE /users/notifications/push-subscribe',
  'POST /users/notifications/read-notification/:notification_id',
  'POST /users/notifications/mark-read/:id',
  'POST /users/notifications/mark-unread/:id',
  'POST /users/notifications/mark-all-read',
  'POST /users/notifications/mark-delivered',
  'POST /users/notifications/dismiss/:id',

  // File plumbing. The upload is a step inside an action (an RFQ, a quote, a
  // profile); the action is what gets recorded.
  'POST /users/upload-file',
  'POST /users/delete-file',
  'POST /users/update-profile-image',
  'POST /users/upload-payment-terms',

  // A vendor's own profile, contacts and subscription — the vendor's business,
  // not a buyer company's, and no buyer administrator's trail to file it in.
  'POST /users/add-buyer-vendor-location',
  'PUT /users/update-buyer-vendor-location',
  'DELETE /users/delete-buyer-vendor-location/:id',
  'POST /users/add-spoc',
  'PUT /users/update-spoc/:spoc_id',
  'DELETE /users/delete-spoc/:spoc_id',
  'POST /users/map-spoc-location',
  'POST /users/create-vendor-review',
  'POST /users/publish-profile-reviews',
  'POST /users/enhance-vendor-profile',
  'POST /hospitality/vendor/join-open-rfqs',
  'POST /hospitality/vendor/subscription/preview',
  'POST /hospitality/vendor/subscription/modify',
  'POST /hospitality/vendor/subscription/extend',

  // Payment-gateway callbacks and the public pay-by-link pages (no session):
  // the admin action is sending the link, which is catalogued above.
  'POST /hospitality/subscription-payment',
  'POST /hospitality/renew-subscription',
  'POST /hospitality/verify-payment',
  'POST /hospitality/hotel-payment/create-order',
  'POST /hospitality/hotel-payment/verify',
];

const NOT_AN_EVENT_SET = new Set(NOT_AN_EVENT);

export const isNotAnEvent = (method, path) => NOT_AN_EVENT_SET.has(norm(method, path));

export const REGISTRY_SIZE = EVENTS.length;
