# One login identifier, one account — design

**Status:** approved 2026-10-16 (Option A: a code is unique across every live account, active or deactivated)

## Incident

A buyer reset his password seven times on 2026-10-15 and every
login still failed with "Password not matched". Two live rows shared the code: his active
account and his old, deactivated one.

- Login (`passport.js` `localUsr`) merged every matching row with `Object.assign({}, ...rows)`,
  so the **last** row won.
- Forgot-password (`forgot_passw_otp_send`) used `rows[0]` — the **first** row.
- The lookup has no `ORDER BY`, so "first" and "last" are heap order, which moves on any
  non-HOT UPDATE. `tbl_login_log` shows the same person landing in one account, then the
  other, then the first again over four months.

Nothing stopped the duplicate: no constraint, no create-time check (email and mobile are
checked, the code is not), no update-time check. Production held five duplicate codes (three
people locked out) and one code stored with a leading space (user 819, never able to log in,
because the login form trims what is typed and the lookup was an exact match).

## Rules

1. **A code identifies at most one live account.** "Live" is the population login searches:
   `is_deleted = 0 AND user_type <> 1`. Deactivated accounts are included — deactivation is
   reversible, so the account keeps its code and reactivating it can never collide.
2. **Codes compare trimmed and case-insensitively, everywhere**: the login lookup, the
   uniqueness checks and the index all use `upper(btrim(employee_code))`. Codes are stored
   trimmed, with case preserved for display. A blank code is stored as NULL.
3. **Every "which account is this?" question uses one resolver** and never merges rows:
   - 0 rows: not found.
   - 1 row: that account (any status — vendor pending/payment flows depend on this).
   - several rows, exactly one active: the active one.
   - several rows otherwise: refused — "This login is linked to more than one account" — and
     logged as an error. Unreachable for codes once the index exists; it covers legacy rows,
     the window before the index, and the email path (two duplicate buyer emails exist).
4. **A deactivated company account** (user_type 2 or 7, status ≠ 1):
   - login with the right password: "Your account has been deactivated. Please contact your
     administrator." (was the vendor wording "User not approved by admin");
   - forgot-password: refused, no OTP, no email;
   - an existing session: 401 on the next request (the token check read `is_deleted` only).
   Vendors are untouched: status 0 is their pending/payment state and has its own flows.
5. **Forgot-password writes the OTP to the resolved account by id**, not `WHERE email = ...`
   (which stamped every row sharing the address).

## Enforcement layers

| Layer | What |
|---|---|
| DB | `uq_users_employee_code_live` — unique on `upper(btrim(employee_code))` where live and non-blank. Catches scripts and bulk loads that bypass the API. |
| API | create and update refuse a code another live account holds: 409 `EMPLOYEE_CODE_TAKEN` with `field: 'employee_code'`. The holder is named only when in the admin's own company. Reactivating an account whose code is now held elsewhere is refused the same way. A 23505 from the index maps to the same 409. |
| Resolver | as above; never merges rows. |
| UI | the create page and edit modal put the 409 under the Employee Code field. |

## Rollout

1. Data: free the codes on inactive accounts holding a duplicate (330, 135, 144); rename our
   test account 617; trim 819. Asserted, dry-run first, separate approval.
2. Deploy code. New duplicates are impossible from the UI; legacy ones resolve safely.
3. Client supplies correct codes for the two active people sharing one code (users 324/325).
4. Migration `20261016100000_unique_employee_code` (refuses with the list of offending codes
   if any duplicate remains).

## Out of scope

- OTP verification still finds the user by the 6-digit OTP alone (tracked security item).
- A unique index on email (two duplicate buyer emails need cleaning first).
