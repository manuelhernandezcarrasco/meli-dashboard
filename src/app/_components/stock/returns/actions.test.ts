import { describe, expect, it } from "vitest";

import { allowedActions, confirmText } from "./actions";

describe("allowedActions", () => {
  it("pending offers all three", () => expect(allowedActions("pending")).toEqual(["lost", "in_repair", "restocked"]));
  it("in_repair offers restock or lost only", () => expect(allowedActions("in_repair")).toEqual(["restocked", "lost"]));
  it("final states offer nothing", () => {
    expect(allowedActions("lost")).toEqual([]);
    expect(allowedActions("restocked")).toEqual([]);
  });
  it("restock copy states the quantity", () => expect(confirmText("restocked", 3)).toContain("+3"));
});
