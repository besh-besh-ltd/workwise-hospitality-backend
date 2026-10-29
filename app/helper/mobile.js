/**
 * One definition of a user's mobile number, shared by the request validators
 * and the controllers that write `tbl_users.mobile`.
 *
 * The canonical stored form is "<country code>-<number>", e.g. "+91-9876500001".
 * Every screen that edits a user splits on that hyphen to fill its country-code
 * picker and number field, so anything else stored here is misread on the next
 * edit.
 *
 * Production held twelve different shapes before this existed, and two of them
 * broke an admin's edit. A bulk HR import wrote bare "9876500001"; the
 * self-profile page read that as country code "9876500001" with an empty
 * number and saved "9876500001-"; the admin modal then read THAT as country
 * code "9876500001", the admin typed the number into the blank field, and the
 * form sent "9876500001-9876500001" — 21 characters into varchar(15). Postgres
 * refused the whole update and the admin saw "An internal error has occurred".
 *
 * So this accepts every legacy shape a client may still send and rewrites it
 * into the canonical form, and rejects — with a sentence a user can act on —
 * anything it cannot make sense of, before the database is ever asked.
 */

/** `tbl_users.mobile` is varchar(15) in production and in the test schema. */
export const MOBILE_MAX_LENGTH = 15;
export const DEFAULT_COUNTRY_CODE = '+91';

const MIN_DIGITS = 6;
const MAX_DIGITS = 11;

export const MOBILE_INVALID_MESSAGE =
  'Enter a valid mobile number: a country code and 6 to 11 digits, for example +91 9876543210.';

/**
 * @param {unknown} raw
 * @returns {{ value: string|null, error?: undefined } | { value?: undefined, error: string }}
 *   `value: null` means "no number" — "", whitespace, or a bare country code
 *   such as "+91-", which is what a form sends when the number field is blank.
 */
export function normalizeMobile(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: MOBILE_INVALID_MESSAGE };

  const s = String(raw).trim();
  if (s === '') return { value: null };

  let countryCode = DEFAULT_COUNTRY_CODE;
  let rest = s;

  // "+91-9876500001", "+91 98765 00001", "+91-" — a leading "+" followed by
  // 1-6 digits is the ONLY thing treated as a country code. Six, not four:
  // the country picker offers +441481, +441534, +441624 and +90392. Reading
  // "the part before the first hyphen" as a code is exactly the bug this
  // module replaces.
  const withCode = s.match(/^(\+\d{1,6})(?:[\s-]+(.*))?$/);
  if (withCode) {
    countryCode = withCode[1];
    rest = withCode[2] ?? '';
  } else if (s.startsWith('+')) {
    // "+919876500001": the boundary between code and number is not knowable.
    return { error: MOBILE_INVALID_MESSAGE };
  }

  // Separators are formatting, not content: "75077 69010", "9876500001-".
  if (!/^[\d\s-]*$/.test(rest)) return { error: MOBILE_INVALID_MESSAGE };
  // A leading 0 is the domestic trunk prefix, never part of the number.
  const digits = rest.replace(/[\s-]/g, '').replace(/^0+/, '');

  if (digits === '') return { value: null };
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return { error: MOBILE_INVALID_MESSAGE };

  const value = `${countryCode}-${digits}`;
  if (value.length > MOBILE_MAX_LENGTH) return { error: MOBILE_INVALID_MESSAGE };
  return { value };
}

/**
 * Joi rule for a mobile field. Validation only: `validateBody` stores the
 * converted body on `req.value.body` but the controllers read `req.body`, so
 * the rewrite to the canonical form happens in the controller through
 * `normalizeMobile` — the same function, so the two cannot disagree.
 */
export const mobileRule = (Joi, { required = false } = {}) => {
  const base = Joi.any()
    .custom((value, helpers) => {
      const { value: normalised, error } = normalizeMobile(value);
      if (error) return helpers.error('mobile.invalid');
      if (required && normalised === null) return helpers.error('mobile.required');
      return value;
    })
    .messages({
      'mobile.invalid': MOBILE_INVALID_MESSAGE,
      'mobile.required': 'Mobile number is required.',
    });
  return required ? base.required().messages({ 'any.required': 'Mobile number is required.' }) : base.optional();
};
