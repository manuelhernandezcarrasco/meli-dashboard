import { describe, expect, it } from "vitest";
import type { Base, BaseSku } from "~/lib/contracts";
import { createMatcher, tokenize } from "./product-match";

const sku = (ean: string, desc: string, cat: string, modelo = ""): BaseSku => ({
  ean, desc, modelo, cat, cu: 100, stock: 0, mg: 0.15, costoMlPctPrev: null, udsPrev: 0,
});

const base: Base = Object.fromEntries(
  [
    sku("1", "Xbox Control Blue", "XBOX"),
    sku("2", "Xbox Control Red", "XBOX"),
    sku("3", "PS5 Control DualSense White", "PLAY STATION"),
    sku("4", "PS4 Control DualShock Black", "PLAY STATION"),
    sku("5", "Xbox Series X 1TB", "XBOX"),
    sku("6", "Bosch Taladro Percutor 650W", "BOSCH"),
    sku("7", "Cable HDMI", "OTRAS"),
  ].map((b) => [b.ean, b]),
);

describe("tokenize", () => {
  it("normalizes accents, synonyms and X|S", () => {
    const t = tokenize("Controlador Inalámbrico Joystick Inalámbrico Xbox Serie X|s Shock Blue");
    expect([...t].sort()).toEqual(["blue", "control", "shock", "xbox", "xs"]);
  });
});

describe("createMatcher", () => {
  const m = createMatcher(base);

  it("matches the Xbox controller automatically", () => {
    const r = m.match("Controlador Inalámbrico Joystick Inalámbrico Xbox Serie X|s Shock Blue", "MLA1");
    expect(r).toMatchObject({ ean: "1", status: "auto" });
  });

  it("never mixes up colours", () => {
    expect(m.match("Joystick Xbox Series Verde", "MLA2")?.ean).not.toBe("1");
    expect(m.match("Mando Xbox Rojo Original", "MLA3")).toMatchObject({ ean: "2" });
  });

  it("asks when only part of the product is mentioned", () => {
    const r = m.match("Control Xbox One Inalámbrico", "MLA4"); // no colour in the listing
    expect(r?.status).toBe("suggest");
  });

  it("does not cross families or model numbers", () => {
    expect(m.match("Joystick PlayStation 4 Negro Dualshock", "MLA5")?.ean).toBe("4");
    expect(m.match("Control PS5 DualSense Blanco", "MLA6")?.ean).toBe("3");
    expect(m.match("Control Xbox DualSense", "MLA7")?.ean).not.toBe("3");
  });

  it("returns null for unrelated listings", () => {
    expect(m.match("Heladera Samsung No Frost 380 Litros", "MLA8")).toBeNull();
  });

  it("skips products a person rejected for that listing", () => {
    const r = createMatcher(base, { MLA1: ["1"] }).match(
      "Controlador Xbox Serie X|s Shock Blue", "MLA1",
    );
    expect(r?.ean).not.toBe("1");
  });
});
