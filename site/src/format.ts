// Fixed-decimal text by the methods-page rule (overview.method.rounding.mode: half away from zero) for figures the
// site computes. Works on the shortest round-trip decimal string of the number (String(value)), never on its binary
// value: toFixed rounds the binary double, so 1.005 -> "1.00". No imports: the e2e tests import this module in Node.

/** `value` rounded half away from zero to `places` decimals; a result of zero carries no minus sign. Non-finite ->
 * String(value), as toFixed. */
export function fixedHalfAway(value: number, places: number): string {
  return roundDecimal(value, places, 0);
}

/** `ratio` as a percentage (ratio x 100, by moving the decimal point of its string: exact), rounded as
 * fixedHalfAway; no "%" sign. Compute the ratio as one division (part / whole). */
export function fixedPercent(ratio: number, places: number): string {
  return roundDecimal(ratio, places, 2);
}

/** `ratio` as a signed percentage with "%" ("+0.50%", "-0.50%"); "+" only when the rounded text is non-zero, so a gap
 * too small to show reads "0.00%" on both sides of zero. */
export function signedPercent(ratio: number, places: number): string {
  const text = fixedPercent(ratio, places);
  return `${ratio > 0 && /[1-9]/.test(text) ? "+" : ""}${text}%`;
}

function roundDecimal(value: number, places: number, shift: number): string {
  if (!Number.isInteger(places) || places < 0) throw new RangeError(`places must be a whole number from 0: ${places}`);
  if (!Number.isFinite(value)) return String(value);
  const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  let digits = whole + fraction;
  let point = whole.length + Number(exponent) + shift; // digits before the decimal point
  if (point < 1) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  }
  digits = digits.padEnd(point + places + 1, "0");
  let kept = digits.slice(0, point + places);
  if (digits[point + places] >= "5") kept = increment(kept);
  const integer = kept.slice(0, kept.length - places).replace(/^0+(?=\d)/, "");
  const text = places === 0 ? integer : `${integer}.${kept.slice(kept.length - places)}`;
  return value < 0 && /[1-9]/.test(text) ? `-${text}` : text;
}

/** Decimal digit string + 1 (a carry past the first digit adds one). */
function increment(digits: string): string {
  const chars = digits.split("");
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] !== "9") {
      chars[index] = String(Number(chars[index]) + 1);
      return chars.join("");
    }
    chars[index] = "0";
  }
  return `1${chars.join("")}`;
}
