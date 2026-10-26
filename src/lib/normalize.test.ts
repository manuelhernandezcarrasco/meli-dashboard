import { describe, expect, it } from "vitest";
import { normCat, normEan, normHdr, toNum, toPct } from "./normalize";

describe("normalize", () => {
  it("normEan", () => {
    expect(normEan("7.50e+12")).toBe("7500000000000");
    expect(normEan("123.0")).toBe("123");
    expect(normEan(7790001234567)).toBe("7790001234567");
    expect(normEan("ABC-1")).toBe("ABC-1");
    expect(normEan(null)).toBe("");
  });
  it("normHdr", () => {
    expect(normHdr(" CU Pond. ")).toBe("cupond");
    expect(normHdr("Descripción")).toBe("descripcion");
  });
  it("toNum", () => {
    expect(toNum("1.234,5")).toBe(1234.5);
    expect(toNum("$ 12,5")).toBe(12.5);
    expect(toNum("abc", 7)).toBe(7);
    expect(toNum(null)).toBe(0);
  });
  it("toPct", () => {
    expect(toPct("15%")).toBe(0.15);
    expect(toPct(0.15)).toBe(0.15);
    expect(toPct(15)).toBe(0.15);
    expect(toPct("")).toBeNull();
  });
  it("normCat", () => {
    expect(normCat("playstation 5")).toBe("PLAY STATION");
    expect(normCat("xbox")).toBe("XBOX");
    expect(normCat("")).toBe("OTRAS");
  });
});
