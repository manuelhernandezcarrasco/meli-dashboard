import { describe, expect, it } from "vitest";
import { daysIn, monthLabel, prevYm, toArgParts } from "./dates";

describe("dates", () => {
  it("daysIn", () => {
    expect(daysIn(2026, 2)).toBe(28);
    expect(daysIn(2028, 2)).toBe(29);
    expect(daysIn(2026, 12)).toBe(31);
  });
  it("prevYm", () => {
    expect(prevYm(2026, 1)).toEqual([2025, 12]);
    expect(prevYm(2026, 10)).toEqual([2026, 9]);
  });
  it("toArgParts", () => {
    const p = toArgParts("2026-10-01T02:30:00.000Z");
    expect(p.date).toBe("2026-09-30");
    expect(p.time).toBe("23:30");
    expect(toArgParts("2026-10-05T12:00:00.000-03:00").time).toBe("12:00");
  });
  it("monthLabel", () => {
    expect(monthLabel(2026, 10)).toBe("Octubre 2026");
  });
});
