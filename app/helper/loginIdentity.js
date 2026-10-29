/**
 * One answer to "which account is this person logging in to?", shared by login
 * and forgot-password.
 *
 * Production, 2026-10-15: one employee code belonged to two live rows — a
 * buyer's active account and his old, deactivated one. Login merged every
 * matching row with Object.assign, so the LAST row won; forgot-password took
 * rows[0], the FIRST. Neither query had an ORDER BY, so "first" and "last" were
 * heap order, which moves whenever a row is updated. His seven password resets
 * all landed on the active account and every login was checked against the
 * deactivated one's hash: "Password not matched", whatever he typed. The login
 * log shows the same person silently landing in one account, then the other,
 * then the first again over four months.
 *
 * So both paths ask this module, and it never merges rows: it returns one row,
 * untouched, or refuses.
 */
import { logger } from '../util/logger.js';
import userModel from '../models/userModel.js';

/** migrations/20261016100000_unique_employee_code.sql */
export const EMPLOYEE_CODE_INDEX = 'uq_users_employee_code_live';

/** Accounts a company administrator creates and deactivates: buyers and legacy company admins. */
export const COMPANY_ACCOUNT_USER_TYPES = Object.freeze([2, 7]);

export const ACCOUNT_DEACTIVATED_MESSAGE =
  'Your account has been deactivated. Please contact your administrator.';
export const LOGIN_AMBIGUOUS_MESSAGE =
  'This login is linked to more than one account. Please contact your administrator.';

export const isActiveAccount = (row) => Number(row?.status) === 1;

export const isCompanyAccount = (row) =>
  row?.user_type !== null && row?.user_type !== undefined &&
  COMPANY_ACCOUNT_USER_TYPES.includes(Number(row.user_type));

/**
 * A vendor at status 0 is pending approval or payment and has its own flows;
 * only a company account at status 0 has been switched off by its administrator.
 */
export const isDeactivatedCompanyAccount = (row) => isCompanyAccount(row) && !isActiveAccount(row);

/**
 * Codes are stored trimmed and compared trimmed and case-insensitively, the
 * same way the unique index `uq_users_employee_code_live` compares them.
 * Trimming matters on its own: a code saved as " EMP0901" could never log in,
 * because the login form trims what is typed and the lookup was exact.
 *
 * @returns {string|null} the trimmed code with its case kept, or null for "no code"
 */
export function normalizeEmployeeCode(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * @param {object[]} rows every live row matching the identifier
 * @returns {{outcome:'not_found'} | {outcome:'found', account:object} | {outcome:'ambiguous', accountIds:number[]}}
 *
 * One row is returned whatever its status: a vendor's pending-approval and
 * payment flows read it, and the caller decides what an inactive account may do.
 * Among several rows, the single active one is the person's account. Anything
 * else cannot be settled without guessing who is typing, so it is refused.
 */
export function resolveLoginAccount(rows) {
  const candidates = Array.isArray(rows) ? rows : [];
  if (candidates.length === 0) return { outcome: 'not_found' };
  if (candidates.length === 1) return { outcome: 'found', account: candidates[0] };

  const active = candidates.filter(isActiveAccount);
  if (active.length === 1) return { outcome: 'found', account: active[0] };

  return {
    outcome: 'ambiguous',
    accountIds: candidates.map((r) => Number(r.id)).sort((a, b) => a - b),
  };
}

/**
 * A person who cannot log in because of our data, not their password. Logged
 * as an error so it reaches monitoring: an administrator has to fix the
 * accounts, and the person cannot tell anyone why.
 *
 * @param {'employee_code'|'email'} lookup
 * @param {number[]} accountIds
 */
export function reportAmbiguousLogin(lookup, accountIds) {
  logger.error(
    { lookup, accountIds },
    'Login identifier matches more than one live account; refused until an administrator separates them'
  );
}

/**
 * The 409 a create or edit gets when the code belongs to another live account.
 *
 * The holder is named only inside the administrator's own company — a code is
 * unique across every tenant, because login is. A deactivated holder gets the
 * way out spelled out: in production that was always the same person's old
 * account, and the right fix is to reactivate it or free its code, not to make
 * a second account.
 *
 * No `errors` object: the frontend's axios interceptor toasts each key of one,
 * and the screen already shows the message under the field.
 */
export function employeeCodeTakenResponse(code, holder, companyId) {
  const sameCompany = holder && Number(holder.company_id) === Number(companyId);
  let message = `Employee code ${code} is already in use.`;
  if (sameCompany && isActiveAccount(holder)) {
    message = `Employee code ${code} is already used by ${holder.name}.`;
  } else if (sameCompany) {
    message =
      `Employee code ${code} is already used by ${holder.name}, whose account is deactivated. ` +
      'Reactivate that account, or change its employee code first.';
  }
  return { status: 0, code: 'EMPLOYEE_CODE_TAKEN', field: 'employee_code', message };
}

/**
 * @returns {Promise<object|null>} the 409 body when another live account holds
 *   `code`, otherwise null. `code` must already be normalised.
 */
export async function findEmployeeCodeConflict({ code, excludeUserId = null, companyId }) {
  if (!code) return null;
  const holders = await userModel.findLiveEmployeeCodeHolders(code, excludeUserId);
  if (holders.length === 0) return null;
  return employeeCodeTakenResponse(code, holders[0], companyId);
}

/**
 * A write refused by the unique index rather than by the check before it (two
 * saves racing). rfqModel.insert / updateWhere re-throw `new Error(err)`, which
 * keeps pg's message but drops `code` and `constraint`, so the index is also
 * recognised by its name in the message — a name only this index uses.
 */
export const isEmployeeCodeIndexViolation = (err) =>
  (err?.code === '23505' && err?.constraint === EMPLOYEE_CODE_INDEX) ||
  String(err?.message ?? '').includes(`"${EMPLOYEE_CODE_INDEX}"`);

/**
 * The same 409 for a write the index refused. The check ran first and saw
 * nobody, so ask again now that the other row has committed; if it has since
 * gone too, the plain sentence still tells the administrator what to do.
 */
export async function employeeCodeConflictAfterRace({ code, excludeUserId = null, companyId }) {
  return (
    (await findEmployeeCodeConflict({ code, excludeUserId, companyId })) ??
    employeeCodeTakenResponse(code, null, companyId)
  );
}
