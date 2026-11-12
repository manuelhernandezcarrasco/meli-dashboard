import { describe, expect, it } from "vitest";

import { cutoverIso, fmtCutoverDate, todayAr } from "./logic";

describe("cutover date helpers", () => {
  it("uses Argentina time (UTC-3)", () => {
    expect(todayAr(new Date("2026-10-01T02:30:00Z"))).toBe("2026-09-30");
    expect(todayAr(new Date("2026-10-01T03:00:00Z"))).toBe("2026-10-01");
  });
  it("turns a day into 00:00 Argentina and back", () => {
    expect(cutoverIso("2026-10-01")).toBe("2026-10-01T03:00:00.000Z");
    expect(fmtCutoverDate("2026-10-01T03:00:00.000Z")).toBe("01/10/2026");
  });
  it("rejects malformed or impossible dates", () => {
    expect(cutoverIso("")).toBeNull();
    expect(cutoverIso("01/10/2026")).toBeNull();
    expect(cutoverIso("2026-13-40")).toBeNull();
  });
});
