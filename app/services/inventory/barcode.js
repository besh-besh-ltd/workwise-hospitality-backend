// Barcode aliases: how a code is stored and when two codes are the same code.
//
// One rule for both sides (E1 M-5): setup refuses a barcode that the scan
// would resolve to an alias already on file, and the scan matches exactly the
// way setup checks.
//   - A code is stored trimmed; its case is kept for display.
//   - Two codes are the same when they are equal ignoring case
//     (ux_inv_item_barcode_company_code_ci: unique per company on lower(code)),
//     or when both are numeric EAN/UPC/GTIN codes of the same product: they
//     are compared as GTIN-14, so a UPC-A matches its EAN-13 or GTIN-14 form,
//     and a UPC-E matches the UPC-A it expands to (not its zero-padded form).
//
// Pure helpers, no database access except through the SQL fragment below.

/** GS1 mod-10 check digit over every digit but the last. */
export function validGtinCheckDigit(digits) {
  if (!/^\d{8,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i -= 1, w = 4 - w) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * UPC-E (8 digits: number system 0/1, six data digits, check digit) to the
 * UPC-A it zero-suppresses, or null when the code is not a valid UPC-E.
 * The last data digit says where the zeros go.
 */
export function upcEToUpcA(code) {
  if (typeof code !== 'string' || !/^[01]\d{7}$/.test(code)) return null;
  const [a, b, c, d, e, f] = code.slice(1, 7);
  let body;
  if (f <= '2') body = `${a}${b}${f}0000${c}${d}${e}`; // manufacturer ab f00, product 00cde
  else if (f === '3') body = `${a}${b}${c}00000${d}${e}`; // abc00, 000de
  else if (f === '4') body = `${a}${b}${c}${d}00000${e}`; // abcd0, 0000e
  else body = `${a}${b}${c}${d}${e}0000${f}`; // abcde, 0000f (f 5-9)
  const upcA = `${code[0]}${body}${code[7]}`;
  return validGtinCheckDigit(upcA) ? upcA : null;
}

/** The UPC-E of a UPC-A that zero-suppresses, else null (inverse of upcEToUpcA). */
export function upcAToUpcE(upcA) {
  if (typeof upcA !== 'string' || !/^[01]\d{11}$/.test(upcA)) return null;
  const m = upcA.slice(1, 6);
  const p = upcA.slice(6, 11);
  let data = null;
  if ('012'.includes(m[2]) && m.slice(3) === '00' && p.startsWith('00')) data = `${m[0]}${m[1]}${p.slice(2)}${m[2]}`;
  else if (m.slice(3) === '00' && p.startsWith('000')) data = `${m.slice(0, 3)}${p.slice(3)}3`;
  else if (m[4] === '0' && p.startsWith('0000')) data = `${m.slice(0, 4)}${p[4]}4`;
  else if (p.startsWith('0000') && p[4] >= '5') data = `${m}${p[4]}`;
  if (!data) return null;
  const upcE = `${upcA[0]}${data}${upcA[11]}`;
  return upcEToUpcA(upcE) === upcA ? upcE : null;
}

/**
 * How one numeric code can be stored as an alias:
 *   keys  — GTIN-14 forms (EAN-8 / UPC-A / EAN-13 / GTIN-14 zero-padded; for a
 *           valid UPC-E also its UPC-A), compared with lpad(alias, 14, '0');
 *   forms — the 8-digit UPC-E of the same product, compared as text (padding
 *           a UPC-E does not give its GTIN, so it cannot be a key).
 * An 8-digit code is kept as an EAN-8 too: the digits alone do not say which.
 * Anything that is not 8 or 12-14 digits has neither.
 */
export function gtinForms(code) {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return { keys: [], forms: [] };
  const keys = new Set([code.padStart(14, '0')]);
  const upcA = code.length === 8 ? upcEToUpcA(code) : null;
  if (upcA) keys.add(upcA.padStart(14, '0'));
  const forms = new Set();
  for (const key of keys) {
    const upcE = key.startsWith('00') ? upcAToUpcE(key.slice(2)) : null;
    if (upcE) forms.add(upcE);
  }
  return { keys: [...keys], forms: [...forms] };
}

/** A barcode as stored: trimmed (case kept). Empty string when blank. */
export const normaliseBarcode = (code) => (code == null ? '' : String(code).trim());

/**
 * SQL condition: alias `b` is the same code as $code (see the header).
 * `code`, `keys` and `forms` are the 1-based parameter numbers of the code,
 * its gtinForms keys (text[]) and forms (text[]).
 */
export const SAME_BARCODE = (b, { code, keys, forms }) => `(lower(${b}.code) = lower($${code})
             OR ${b}.code = ANY($${forms}::text[])
             OR (${b}.code ~ '^([0-9]{8}|[0-9]{12,14})$' AND lpad(${b}.code, 14, '0') = ANY($${keys}::text[])))`;

export default { validGtinCheckDigit, upcEToUpcA, upcAToUpcE, gtinForms, normaliseBarcode, SAME_BARCODE };
