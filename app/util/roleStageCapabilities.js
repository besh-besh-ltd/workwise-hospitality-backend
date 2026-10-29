// System roles (tbl_roles.created_by IS NULL), matched by title, whose holders
// DO the work of a stage rather than approve it. Custom roles never match.
export const PERFORMER_ROLE_TITLES = {
  'RFQ Creator': ['RFQ'],
  'Technical Evaluator': ['TECHNICAL'],
  'Commercial Evaluator': ['NEGOTIATION', 'NEGOTIATION_QUOTE'],
  'ARC Creator': ['ARC', 'ARC_PUBLISH', 'ARC_GROUP'],
  'ARC Technical Evaluator': ['ARC_TECH', 'ARC_GROUP_TECH'],
  'ARC Commercial Evaluator': ['ARC_NEGOTIATION', 'ARC_GROUP_NEGOTIATION'],
};
