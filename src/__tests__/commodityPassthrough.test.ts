import { describe, it, expect } from "vitest";
import { resolveCommodityCode, COMMODITY_CODES } from "../index.js";

// The MCP server resolved commodity codes against a hardcoded 27-entry list and
// then fell through to a SUBSTRING fuzzy loop over its alias table. The live
// catalog is ~604 codes, so the overwhelming majority of real codes either were
// refused locally or — far worse — matched some unrelated alias by substring and
// returned the WRONG commodity with isError:false.
//
// An AI agent cannot detect that. It asks for RBOB gasoline, gets Henry Hub
// natural gas, and reports it as fact.
//
// The fix: unknown-but-code-shaped input passes through to the API, which owns
// the real catalog and a good alias/suggestion table. The MCP must not shadow it.
describe("commodity code passthrough (no silent substitution)", () => {
  // Real catalog codes absent from the hardcoded 27. Each previously resolved to
  // something unrelated or to null; none may resolve to a DIFFERENT code.
  const REAL_CODES_NOT_IN_HARDCODED_LIST = [
    "RBOB_GASOLINE_USD",
    "NATURAL_GAS_TTF_SPOT_EUR",
    "GASOLINE_RBOB_USD",
    "BALTIC_DRY_INDEX",
    "EU_CARBON_EUR",
    "PROPANE_MONT_BELVIEU_USD",
    "SINGAPORE_GASOIL_USD",
    "NATURAL_GAS_WAHA",
  ];

  for (const code of REAL_CODES_NOT_IN_HARDCODED_LIST) {
    it(`${code} is never silently rewritten to a different commodity`, () => {
      const resolved = resolveCommodityCode(code);
      expect(
        resolved === null || resolved === code,
        `${code} resolved to ${resolved} — a different commodity. ` +
          `Returning the wrong series with isError:false is the worst failure mode here.`,
      ).toBe(true);
    });
  }

  it("passes a code-shaped input through instead of refusing it locally", () => {
    // COPPER_USD is live in the catalog and absent from the hardcoded list.
    expect(resolveCommodityCode("COPPER_USD")).toBe("COPPER_USD");
  });

  it("still resolves natural-language aliases", () => {
    expect(resolveCommodityCode("brent")).toBe("BRENT_CRUDE_USD");
    expect(resolveCommodityCode("natural gas")).toBe("NATURAL_GAS_USD");
    expect(resolveCommodityCode("wti")).toBe("WTI_USD");
  });

  it("still returns null for input that is not a code and not an alias", () => {
    expect(resolveCommodityCode("what is the weather")).toBeNull();
  });

  // THE INVARIANT, stated once and checked structurally.
  //
  //   For any code-shaped input, resolveCommodityCode returns that code or
  //   null. Never a different commodity.
  //
  // This needs no catalog and no network, so it runs on every PR — pull
  // requests deliberately do not receive API secrets. It is also the exact
  // property that was violated: a substring fall-through that always returned
  // *something* turned "I do not know" into a confidently wrong answer.
  //
  // Guard this test. If a future change makes it fail, the change is wrong.
  describe("identity invariant", () => {
    const CODE_SHAPED = [
      // real catalog codes spanning every category
      "NATURAL_GAS_WAHA",
      "NATURAL_GAS_TTF_SPOT_EUR",
      "NATURAL_GAS_ALGONQUIN_USD",
      "RBOB_GASOLINE_USD",
      "GASOLINE_RBOB_USD",
      "SINGAPORE_GASOIL_USD",
      "PROPANE_MONT_BELVIEU_USD",
      "BALTIC_CAPESIZE_INDEX",
      "EU_CARBON_EUR",
      "CONTAINER_FREIGHT_COMPOSITE_USD",
      "US_RIG_COUNT",
      "DIESEL_RETAIL_STATE_WA_USD",
      "MGO_05S_USD",
      "AZERI_LIGHT_USD",
      "URALS_CRUDE_USD",
      // synthetic code-shaped input the catalog does not contain
      "TOTALLY_MADE_UP_CODE",
      "A_B",
      "X1_Y2_Z3",
    ];

    for (const input of CODE_SHAPED) {
      it(`${input} -> itself or null, never another commodity`, () => {
        const out = resolveCommodityCode(input);
        expect(
          out === null || out === input.toUpperCase(),
          `resolveCommodityCode(${input}) returned ${out}. ` +
            `A code-shaped input must resolve to itself or to nothing — ` +
            `handing back a different instrument is undetectable downstream.`,
        ).toBe(true);
      });
    }
  });

  it("hardcoded list is far smaller than the live catalog (documents the gap)", () => {
    expect(COMMODITY_CODES.length).toBeLessThan(100);
  });
});
