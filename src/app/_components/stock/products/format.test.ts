import { describe, expect, it } from "vitest";

import { fmtArs, fmtNum, stockState } from "./format";

describe("stockState", () => {
  const p = (onHand: number, coverageDays: number | null, minUnits: number | null = null) => ({ onHand, coverageDays, minUnits });
  it("buckets", () => {
    expect(stockState(p(-1, null))).toBe("negative");
    expect(stockState(p(0, null))).toBe("none");
    expect(stockState(p(5, 3))).toBe("critical");
    expect(stockState(p(5, 10))).toBe("low");
    expect(stockState(p(3, null, 10))).toBe("critical");
    expect(stockState(p(10, null, 10))).toBe("low");
    expect(stockState(p(50, 40, 10))).toBe("ok");
  });
});

describe("es-AR formatting", () => {
  it("uses dot thousands and comma decimals", () => {
    expect(fmtNum(1234.5, 1)).toBe("1.234,5");
    expect(fmtArs(1500)).toMatch(/1\.500,00/);
  });
});
