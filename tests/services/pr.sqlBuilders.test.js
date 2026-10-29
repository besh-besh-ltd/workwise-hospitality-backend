// Purchase Requisitions — the SQL fragment builders refuse anything that is not
// a `$n` placeholder where a caller binds a user (or another value).
//
// A unit test on purpose: these builders interpolate their arguments into SQL
// text, and the placeholder guard is the only thing between a careless caller
// (`prGrantRowsSql(req.query.user)`, a column name, a stray literal) and SQL
// injection or a predicate silently bound to the wrong value. No database or
// HTTP is involved, so nothing else here could be the reason a case passes.

import {
  prGrantRowsSql, IS_ELIGIBLE_REVIEWER_SQL, IS_HOTEL_BUYER_SQL, REVIEWERS_SQL, HOTEL_BUYERS_SQL,
} from "../../app/services/pr/prConstants.js";

const MALFORMED = [
  "1", "$", "$x", "$1a", " $1", "$1 ", "$1 OR TRUE", "$1; DROP TABLE tbl_users", "u.id", "", null, undefined, 1,
];

/** The MALFORMED values `build` accepts — [] when it refuses every one with the placeholder error. */
const accepted = (build) => MALFORMED.filter((bad) => {
  try {
    build(bad);
    return true;
  } catch (err) {
    return !/expected a \$n placeholder/.test(err.message);
  }
});

describe("PR SQL builders: user parameters must be $n placeholders", () => {
  it("control: well-formed placeholders build the predicate around them", () => {
    expect(prGrantRowsSql("$1", "convert")).toMatch(/_g_urs\.user_id = \$1\b/);
    expect(IS_ELIGIBLE_REVIEWER_SQL("$2", "p", "rv")).toMatch(/_rx_u\.id = \$2\)/);
    expect(IS_HOTEL_BUYER_SQL("$3", "$1", "$2")).toMatch(/_rx_u\.id = \$3::int\)/);
    expect(REVIEWERS_SQL("$1", "$2", "$3")).toContain("$3::int");
    expect(HOTEL_BUYERS_SQL("$1", "$2")).toContain("$2::int");
  });

  it("prGrantRowsSql throws on a malformed user parameter, and on an action outside [a-z]+", () => {
    expect(accepted((bad) => prGrantRowsSql(bad, "read"))).toEqual([]);
    for (const action of ["READ", "read; --", "", "pr.read", "re ad"]) {
      expect(() => prGrantRowsSql("$1", action)).toThrow(/invalid action/);
    }
  });

  it("the holderMatchSql predicates narrowed to one user throw on a malformed user parameter", () => {
    expect(accepted((bad) => IS_ELIGIBLE_REVIEWER_SQL(bad, "p", "rv"))).toEqual([]); // reviewer (pr.evaluate)
    expect(accepted((bad) => IS_HOTEL_BUYER_SQL(bad, "$1", "$2"))).toEqual([]); // hotel buyer (pr.convert)
  });

  it("the holderMatchSql lists throw on a malformed company / hotel / department parameter", () => {
    expect(accepted((bad) => IS_HOTEL_BUYER_SQL("$1", bad, "$2"))).toEqual([]);
    expect(accepted((bad) => IS_HOTEL_BUYER_SQL("$1", "$2", bad))).toEqual([]);
    expect(accepted((bad) => HOTEL_BUYERS_SQL(bad, "$2"))).toEqual([]);
    expect(accepted((bad) => REVIEWERS_SQL("$1", "$2", bad))).toEqual([]);
  });
});
