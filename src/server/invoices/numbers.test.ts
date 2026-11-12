import { describe, expect, it } from "vitest";
import { isArNumber, parseArNumber, round2, tryParseArNumber } from "./numbers";

describe("parseArNumber", () => {
  it.each([
    ["1.234,56", 1234.56],
    ["10.843.892,71", 10843892.71],
    ["0,00", 0],
    ["55.095,86", 55095.86],
    ["500", 500],
    ["1.000", 1000],
    ["-1.234,5", -1234.5],
    ["  650.633,56 ", 650633.56],
    ["$ 2.277.217,47", 2277217.47],
    ["6,5", 6.5],
  ])("%s -> %s", (raw, expected) => {
    expect(parseArNumber(raw)).toBe(expected);
  });

  it.each(["", "abc", "1,234.56", "1.23.456", "12,", ",5", "1 234,56"])("rejects %j", (raw) => {
    expect(isArNumber(raw)).toBe(false);
    expect(tryParseArNumber(raw)).toBeNull();
    expect(() => parseArNumber(raw)).toThrow();
  });

  it("round2 removes float noise", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
