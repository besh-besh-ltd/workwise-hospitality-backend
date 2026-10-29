/**
 * Which account is somebody logging in to? — the rule, on its own.
 *
 * Production, 2026-10-15: two live rows shared one employee code, the
 * person's active account and his old, deactivated one. Login merged every
 * matching row with Object.assign (so the LAST row won) while forgot-password
 * took rows[0] (the FIRST). Heap order put the deactivated row last, so seven
 * password resets landed on the active account and every login was checked
 * against the deactivated one's hash.
 *
 * These are the rules both paths now share. The HTTP behaviour that depends on
 * them is in security.employeeCodeLogin.test.js.
 */
import {
  resolveLoginAccount,
  normalizeEmployeeCode,
  isCompanyAccount,
  isDeactivatedCompanyAccount,
  isEmployeeCodeIndexViolation,
  employeeCodeTakenResponse,
} from "../../app/helper/loginIdentity.js";

const row = (id, status, user_type = 2) => ({ id, status, user_type, password: `hash-${id}` });

describe("resolveLoginAccount", () => {
  it("finds nobody in no rows", () => {
    expect(resolveLoginAccount([])).toEqual({ outcome: "not_found" });
    expect(resolveLoginAccount(undefined)).toEqual({ outcome: "not_found" });
  });

  it("returns a single row whatever its status — vendor pending and payment flows read it", () => {
    expect(resolveLoginAccount([row(1, 1)])).toEqual({ outcome: "found", account: row(1, 1) });
    expect(resolveLoginAccount([row(2, 0, 3)])).toEqual({ outcome: "found", account: row(2, 0, 3) });
    expect(resolveLoginAccount([row(3, 2, 3)])).toEqual({ outcome: "found", account: row(3, 2, 3) });
  });

  // The incident, in both orders: the answer must not depend on which row the
  // database happens to return first.
  it.each([
    ["active first", [row(360, 1), row(330, 0)]],
    ["active last", [row(330, 0), row(360, 1)]],
  ])("prefers the one active account over deactivated ones (%s)", (_label, rows) => {
    expect(resolveLoginAccount(rows)).toEqual({ outcome: "found", account: row(360, 1) });
  });

  it("never merges rows: the account returned is exactly one of the rows, untouched", () => {
    const active = row(360, 1);
    const result = resolveLoginAccount([active, row(330, 0)]);
    expect(result.account).toBe(active);
  });

  it("prefers the active account among several deactivated ones", () => {
    const rows = [row(1, 0), row(2, 1), row(3, 0)];
    expect(resolveLoginAccount(rows)).toEqual({ outcome: "found", account: row(2, 1) });
  });

  it("refuses two active accounts — it cannot know which person is typing", () => {
    expect(resolveLoginAccount([row(324, 1), row(325, 1)])).toEqual({
      outcome: "ambiguous",
      accountIds: [324, 325],
    });
  });

  it("refuses several accounts none of which is active", () => {
    expect(resolveLoginAccount([row(5, 0), row(4, 0)])).toEqual({
      outcome: "ambiguous",
      accountIds: [4, 5],
    });
  });

  it("reads status the way Postgres and legacy code hand it over: 1 and '1' are both active", () => {
    expect(resolveLoginAccount([row(1, "1"), row(2, "0")])).toEqual({ outcome: "found", account: row(1, "1") });
  });
});

describe("normalizeEmployeeCode", () => {
  it.each([
    ["EMP0417", "EMP0417"],
    [" EMP0901", "EMP0901"],
    ["emp0417  ", "emp0417"],
    ["\tEMP0135\n", "EMP0135"],
  ])("trims %j to %j and keeps the case for display", (raw, expected) => {
    expect(normalizeEmployeeCode(raw)).toBe(expected);
  });

  it.each([[""], ["   "], [null], [undefined]])("treats %j as no code", (raw) => {
    expect(normalizeEmployeeCode(raw)).toBeNull();
  });

  it("accepts a numeric code as a string", () => {
    expect(normalizeEmployeeCode(60217)).toBe("60217");
  });
});

describe("company accounts", () => {
  it("are buyer (2) and company-admin (7) accounts — never vendors or network members", () => {
    expect(isCompanyAccount({ user_type: 2 })).toBe(true);
    expect(isCompanyAccount({ user_type: "7" })).toBe(true);
    expect(isCompanyAccount({ user_type: 3 })).toBe(false);
    expect(isCompanyAccount({ user_type: 11 })).toBe(false);
    expect(isCompanyAccount({ user_type: null })).toBe(false);
  });

  it("are deactivated when their status is anything but 1", () => {
    expect(isDeactivatedCompanyAccount({ user_type: 2, status: 0 })).toBe(true);
    expect(isDeactivatedCompanyAccount({ user_type: 7, status: "0" })).toBe(true);
    expect(isDeactivatedCompanyAccount({ user_type: 2, status: 1 })).toBe(false);
    // A vendor at status 0 is pending approval or payment, not deactivated.
    expect(isDeactivatedCompanyAccount({ user_type: 3, status: 0 })).toBe(false);
  });
});

describe("recognising the unique index's refusal", () => {
  const PG_MESSAGE = 'duplicate key value violates unique constraint "uq_users_employee_code_live"';

  it("from a raw pg error", () => {
    expect(isEmployeeCodeIndexViolation({ code: "23505", constraint: "uq_users_employee_code_live", message: PG_MESSAGE })).toBe(true);
  });

  // rfqModel.insert / updateWhere re-throw `new Error(err)`, keeping only the message.
  it("from the model layer's re-wrapped error", () => {
    expect(isEmployeeCodeIndexViolation(new Error(`error: ${PG_MESSAGE}`))).toBe(true);
  });

  it("but not from any other unique violation", () => {
    expect(isEmployeeCodeIndexViolation({ code: "23505", constraint: "tbl_users_pkey", message: 'duplicate key value violates unique constraint "tbl_users_pkey"' })).toBe(false);
    expect(isEmployeeCodeIndexViolation(new Error("something else"))).toBe(false);
    expect(isEmployeeCodeIndexViolation(undefined)).toBe(false);
  });
});

describe("the 'code taken' answer", () => {
  it("names nobody when the holder is unknown", () => {
    expect(employeeCodeTakenResponse("EC-1", null, 13)).toEqual({
      status: 0,
      code: "EMPLOYEE_CODE_TAKEN",
      field: "employee_code",
      message: "Employee code EC-1 is already in use.",
    });
  });
});
