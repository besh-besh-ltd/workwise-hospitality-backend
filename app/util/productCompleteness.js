/**
 * When does a product have a usable quantity and unit.
 *
 * There were five answers to this in the codebase and they disagreed, which is
 * how a buyer could be told on the Review step that everything was filled in
 * and then be rejected on submit:
 *
 *   rfqModel.checkRFQCompletion   SQL, gate on POST /rfq/create
 *   assertProductQuantityAndUnit  JS, gate on PUT /rfq/update — min 0.1, and
 *                                 Number() so '1e3' passed and 'NA' was a unit
 *   EditRFQ.handleUpdateRFQ       JS, parseFloat so '10abc' was 10
 *   CreateRFQ.isSpecFieldEmpty    JS, only checked for a blank string
 *   the Review step's display      a 3-source fallback chain
 *
 * This module is the one answer on the server. The constants below are also
 * what the SQL gate is built from — checkRFQCompletion interpolates
 * QUANTITY_PATTERN_SQL, MIN_QUANTITY and UNIT_PLACEHOLDERS_SQL into its query
 * rather than restating them, so the two cannot drift apart.
 *
 * The client mirrors it in frontend/utils/productCompleteness.js. That one has
 * to be kept in step by hand; its tests state the same cases.
 */

/**
 * Optional leading '+', then digits with an optional fraction, or a bare
 * fraction ('.5'). Written with [0-9] rather than \d so the identical source
 * is valid both as a JS RegExp and as a POSIX regex in Postgres.
 *
 * Thousands separators are deliberately excluded. parseFloat('1,000') is 1
 * everywhere downstream, so accepting it would put 1 on a purchase order when
 * the buyer meant 1000 — a validation message is the better failure.
 */
export const QUANTITY_PATTERN_SOURCE = '^\\+?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)$';

/** The same pattern as a Postgres string literal, for interpolation into SQL. */
export const QUANTITY_PATTERN_SQL = "'^\\+?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)$'";

const QUANTITY_RE = new RegExp(QUANTITY_PATTERN_SOURCE);

/**
 * Smallest quantity anyone can order. Not simply "> 0": the edit path has
 * enforced this floor for a long time and no production row sits between 0
 * and 0.1, so this is the established rule and every path now shares it.
 */
export const MIN_QUANTITY = 0.1;

/** Text people type when they have nothing to say. Not units. */
export const UNIT_PLACEHOLDERS = ['NA', 'N/A', 'NIL', 'NONE', 'NULL', '-', '--'];

/** The same list as a Postgres IN (...) list, for interpolation into SQL. */
export const UNIT_PLACEHOLDERS_SQL = UNIT_PLACEHOLDERS.map((u) => `'${u}'`).join(', ');

const asText = (value) => (value === null || value === undefined ? '' : String(value).trim());

export const isQuantityValid = (value) => {
  const text = asText(value);
  if (!QUANTITY_RE.test(text)) return false;
  return Number.parseFloat(text) >= MIN_QUANTITY;
};

export const isUnitValid = (value) => {
  const text = asText(value);
  if (text === '') return false;
  return !UNIT_PLACEHOLDERS.includes(text.toUpperCase());
};

/**
 * Why a quantity is not acceptable, phrased for the buyer. Null when it is
 * fine. Kept here so the create gate and the update gate say the same thing.
 */
export const quantityProblem = (value) => {
  const text = asText(value);
  if (text === '') return 'quantity is not set';
  if (!QUANTITY_RE.test(text)) return `quantity "${text}" is not a number`;
  if (Number.parseFloat(text) < MIN_QUANTITY) {
    return `quantity "${text}" is below the minimum of ${MIN_QUANTITY}`;
  }
  return null;
};

export const unitProblem = (value) => {
  const text = asText(value);
  if (text === '') return 'unit is not set';
  if (UNIT_PLACEHOLDERS.includes(text.toUpperCase())) return `unit "${text}" is not a valid unit`;
  return null;
};
