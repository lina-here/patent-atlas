import { test, expect } from "./fixtures";
import { fixedHalfAway, fixedPercent, signedPercent } from "../../site/src/format";

// Node side: no page. Literal oracles of the methods-page rule (overview.method.rounding.mode, half away from zero)
// on the shortest decimal string of each number; binary toFixed gives "1.00" for 1.005 and "0.14" for 0.145.

for (const [value, places, expected] of [
  [1.005, 2, "1.01"],
  [0.145, 2, "0.15"],
  [-2.5, 0, "-3"],
  [2.5, 0, "3"],
  [1e-7, 2, "0.00"],
  [12.25, 1, "12.3"],
  [76.49006, 2, "76.49"],
  [9.995, 2, "10.00"],
  [1.5e21, 0, "1500000000000000000000"],
  [-0.001, 2, "0.00"],
  [-1.005, 2, "-1.01"],
  [7, 2, "7.00"],
] as [number, number, string][]) {
  test(`fixedHalfAway(${value}, ${places}) = ${expected}`, () => {
    expect(fixedHalfAway(value, places)).toBe(expected);
  });
}

for (const [ratio, places, expected] of [
  [12_345 / 100_000, 2, "12.35"],
  [0.00145, 2, "0.15"],
  [-0.0005, 1, "-0.1"],
  [0.9, 0, "90"],
  [1e-7, 4, "0.0000"], // exponent-form input
  [1.2345e-5, 3, "0.001"], // 0.0012345 %
  [1.5e21, 0, "150000000000000000000000"], // large input, exponent form
  [123_456_789.125, 2, "12345678912.50"],
] as [number, number, string][]) {
  test(`fixedPercent(${ratio}, ${places}) = ${expected}`, () => {
    expect(fixedPercent(ratio, places)).toBe(expected);
  });
}

test("fixedHalfAway: places must be a whole number from 0", () => {
  expect(() => fixedHalfAway(1, -1)).toThrow(RangeError);
  expect(() => fixedHalfAway(1, 1.5)).toThrow(RangeError);
});

for (const [ratio, places, expected] of [
  [0.005, 2, "+0.50%"],
  [-0.005, 2, "-0.50%"],
  [0.00001, 2, "0.00%"], // positive but rounds to zero: no sign, as the negative side
  [-0.00001, 2, "0.00%"],
  [0, 2, "0.00%"],
  [0.0005, 2, "+0.05%"],
] as [number, number, string][]) {
  test(`signedPercent(${ratio}, ${places}) = ${expected}`, () => {
    expect(signedPercent(ratio, places)).toBe(expected);
  });
}
