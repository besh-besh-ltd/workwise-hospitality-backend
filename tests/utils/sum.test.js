import { sum } from "../../app/util/sum";

describe("Sum", () => {
  test("should return the sum of two numbers", () => {
    expect(sum(1, 2)).toBe(3);
  });
  test('works with negative numbers', () => {
    expect(sum(-2, 1)).toBe(-1);
  });
});

// npm test
// yarn test
// jest --watch
// jest --watchAll
// jest --watchAll --runInBand