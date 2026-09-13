import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer, formatPrice } from "../index.js";

// #100 / #98 — every non-USD, non-EUR, non-GBP quote was rendered with a
// fabricated '$'. The renderer special-cased three currencies and silently
// defaulted everything else to dollars, so an AI agent received a plausible
// wrong number with isError:false and no way to detect it.
//
// Every currency/unit/price triple below was captured live from production on
// 2026-09-13 (GET /v1/prices/latest?by_code=..., and GET /v1/commodities for
// the catalogue-wide currency census):
//
//   GASOLINE_RETAIL_KR_KRW  1948     KRW      litre                -> "1948.00 KRW"
//   DIESEL_RETAIL_JP_JPY     159.4   JPY      litre                -> "159.40 JPY"
//   NATURAL_GAS_GBP          203.3   GBp      therm                -> "203.30p"
//   US_10Y_YIELD               4.95  PERCENT  percent              -> "4.95%"
//   US_RIG_COUNT             591     COUNT    rigs                 -> "591.00 COUNT"
//   NATURAL_GAS_AECO_CAD       1.19  CAD      gigajoule            -> "1.19 CAD"
//   DXY_USD                  118.07  INDEX    index                -> "118.07"
//   CFTC_COT_WTI_SPEC_LONG 350118    CONTRACTS contracts           -> "350118.00 CONTRACTS"
//   NATURAL_GAS_STORAGE     3254     BCF      billion_cubic_feet   -> "3254.00 BCF"
//   USD_NOK                    9.2903 NOK     currency_pair        -> "9.29 NOK"
//
// The right-hand column is the API's own `formatted` field, i.e. the API
// already knows the correct rendering. The MCP server ignored it.

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const server = createSandboxServer();
const tools = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// A fabricated currency symbol is any symbol that does not belong to the
// currency the API reported. This is the assertion that matters: the agent
// must never be handed a number wearing the wrong symbol.
const FABRICATED = /[$€£¥₩₹]/;

describe("formatPrice renders the currency the API reported (#100)", () => {
  it("does not render Korean won as dollars", () => {
    const result = formatPrice({
      code: "GASOLINE_RETAIL_KR_KRW",
      price: 1948,
      currency: "KRW",
      unit: "litre",
    });

    expect(result).not.toContain("$1948");
    expect(result).not.toContain("$1,948");
    expect(result).toMatch(/₩1,948\.00|1948\.00 KRW/);
  });

  it("does not render Japanese yen as dollars", () => {
    const result = formatPrice({
      code: "DIESEL_RETAIL_JP_JPY",
      price: 159.4,
      currency: "JPY",
      unit: "litre",
    });

    expect(result).not.toContain("$159.40");
    expect(result).toMatch(/¥159\.40|159\.40 JPY/);
  });

  it("does not render Canadian dollars as US dollars", () => {
    const result = formatPrice({
      code: "NATURAL_GAS_AECO_CAD",
      price: 1.19,
      currency: "CAD",
      unit: "gigajoule",
    });

    expect(result).not.toMatch(/(^|[^A-Z])\$1\.19/);
    expect(result).toMatch(/CA\$1\.19|1\.19 CAD/);
  });

  it("renders an unknown currency as a bare number with its code, never a symbol", () => {
    const result = formatPrice({
      code: "SOMETHING_XTS",
      price: 12.34,
      currency: "XTS",
      unit: "barrel",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("XTS");
    expect(result).toContain("12.34");
  });

  it("renders a bare number when the API reports no currency at all", () => {
    const result = formatPrice({
      code: "NO_CURRENCY_CODE",
      price: 42.5,
      currency: undefined as unknown as string,
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("42.50");
  });
});

describe("GBp is pence, not pounds — live today on NATURAL_GAS_GBP (#98)", () => {
  it("never renders a GBp quote with the pound symbol", () => {
    const result = formatPrice({
      code: "NATURAL_GAS_GBP",
      price: 203.3,
      currency: "GBp",
      unit: "therm",
    });

    // £203.30 is a 100x overstatement of 203.30 pence.
    expect(result).not.toContain("£203.30");
    expect(result).toMatch(/203\.30p|£2\.03/);
  });

  it("keeps the 24h change in pence too", () => {
    const result = formatPrice({
      code: "NATURAL_GAS_GBP",
      price: 203.3,
      currency: "GBp",
      unit: "therm",
      change_24h: 5.04,
      change_24h_percent: 2.54,
    });

    expect(result).not.toContain("£5.04");
    expect(result).toMatch(/\+5\.04p|\+£0\.05/);
  });
});

describe("non-price quantities are not currency (#100)", () => {
  it("renders a rig count as a count, not as dollars", () => {
    const result = formatPrice({
      code: "US_RIG_COUNT",
      price: 591,
      currency: "COUNT",
      unit: "rigs",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("591 rigs");
  });

  it("renders a treasury yield as a percentage, not as dollars", () => {
    const result = formatPrice({
      code: "US_10Y_YIELD",
      price: 4.95,
      currency: "PERCENT",
      unit: "percent",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("4.95%");
  });

  it("renders an index level with no currency at all", () => {
    const result = formatPrice({
      code: "DXY_USD",
      price: 118.07,
      currency: "INDEX",
      unit: "index",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("118.07");
  });

  it("renders a COT contract count as contracts", () => {
    const result = formatPrice({
      code: "CFTC_COT_WTI_SPEC_LONG",
      price: 350118,
      currency: "CONTRACTS",
      unit: "contracts",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toContain("contracts");
  });

  it("renders natural gas storage in BCF, not dollars", () => {
    const result = formatPrice({
      code: "NATURAL_GAS_STORAGE",
      price: 3254,
      currency: "BCF",
      unit: "billion_cubic_feet",
    });

    expect(result).not.toMatch(FABRICATED);
    expect(result).toMatch(/3,254/);
    expect(result).toContain("billion cubic feet");
  });
});

describe("known currencies still render correctly", () => {
  it("USD", () => {
    expect(
      formatPrice({
        code: "BRENT_CRUDE_USD",
        price: 104.32,
        currency: "USD",
        unit: "barrel",
      }),
    ).toContain("$104.32");
  });

  it("EUR", () => {
    expect(
      formatPrice({
        code: "DUTCH_TTF_EUR",
        price: 79.52,
        currency: "EUR",
        unit: "mwh",
      }),
    ).toContain("€79.52");
  });

  it("GBP", () => {
    expect(
      formatPrice({
        code: "GOLD_AM_GBP",
        price: 3240.96,
        currency: "GBP",
        unit: "troy_ounce",
      }),
    ).toContain("£3,240.96");
  });
});

// ---------------------------------------------------------------------------
// On the wire: drive the real tool handlers with the exact envelopes
// production served on 2026-09-13, and assert on the rendered tool output.
// ---------------------------------------------------------------------------

describe("rendered tool output on the wire", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function live(body: unknown) {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(body);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("opa_get_price does not hand the agent $1948.00 for \u20a91948", async () => {
    live({
      status: "success",
      data: {
        code: "GASOLINE_RETAIL_KR_KRW",
        price: 1948,
        currency: "KRW",
        formatted: "1948.00 KRW",
        unit: "litre",
        created_at: "2026-09-13T16:09:32.072Z",
        updated_at: "2026-09-13T16:09:32.072Z",
      },
    });

    const out = text(
      await tools.opa_get_price.handler(
        { commodity: "GASOLINE_RETAIL_KR_KRW" },
        {},
      ),
    );

    expect(out).not.toContain("$1948.00");
    expect(out).not.toContain("$1,948.00");
    expect(out).toMatch(/\u20a91,948\.00|1948\.00 KRW/);
  });

  it("opa_get_price does not hand the agent \u00a3203.30 for 203.30 pence", async () => {
    live({
      status: "success",
      data: {
        code: "NATURAL_GAS_GBP",
        price: 203.3,
        currency: "GBp",
        formatted: "203.30p",
        unit: "therm",
        created_at: "2026-09-13T16:09:32.072Z",
        updated_at: "2026-09-13T16:09:32.072Z",
      },
    });

    const out = text(
      await tools.opa_get_price.handler({ commodity: "NATURAL_GAS_GBP" }, {}),
    );

    expect(out).not.toContain("\u00a3203.30");
    expect(out).toMatch(/203\.30p|\u00a32\.03/);
  });

  it("opa_get_price does not hand the agent $591.00 for a rig count", async () => {
    live({
      status: "success",
      data: {
        code: "US_RIG_COUNT",
        price: 591,
        currency: "COUNT",
        formatted: "591.00 COUNT",
        unit: "rigs",
        created_at: "2026-09-13T16:09:32.072Z",
      },
    });

    const out = text(
      await tools.opa_get_price.handler({ commodity: "US_RIG_COUNT" }, {}),
    );

    expect(out).not.toMatch(FABRICATED);
    expect(out).toContain("591 rigs");
  });

  it("opa_get_price does not hand the agent $4.95 for a 4.95% yield", async () => {
    live({
      status: "success",
      data: {
        code: "US_10Y_YIELD",
        price: 4.95,
        currency: "PERCENT",
        formatted: "4.95%",
        unit: "percent",
        created_at: "2026-09-13T16:09:32.072Z",
      },
    });

    const out = text(
      await tools.opa_get_price.handler({ commodity: "US_10Y_YIELD" }, {}),
    );

    expect(out).not.toMatch(FABRICATED);
    expect(out).toContain("4.95%");
  });

  it("opa_market_overview does not stamp '$' on every currency in the list", async () => {
    live({
      status: "success",
      data: {
        data: {
          prices: {
            GASOLINE_RETAIL_KR_KRW: {
              code: "GASOLINE_RETAIL_KR_KRW",
              price: 1948,
              currency: "KRW",
              unit: "litre",
            },
            US_RIG_COUNT: {
              code: "US_RIG_COUNT",
              price: 591,
              currency: "COUNT",
              unit: "rigs",
            },
            NATURAL_GAS_GBP: {
              code: "NATURAL_GAS_GBP",
              price: 203.3,
              currency: "GBp",
              unit: "therm",
            },
          },
          count: 3,
          timestamp: "2026-09-13T16:09:32.072Z",
        },
      },
    });

    const out = text(
      await tools.opa_market_overview.handler({ category: "all" }, {}),
    );

    expect(out).not.toContain("$1948.00");
    expect(out).not.toContain("$591.00");
    expect(out).not.toContain("\u00a3203.30");
  });

  it("opa_get_history does not render a GBp series in pounds", async () => {
    live({
      status: "success",
      data: {
        prices: [
          {
            price: 203.3,
            currency: "GBp",
            unit: "therm",
            code: "NATURAL_GAS_GBP",
            created_at: "2026-09-13T16:09:32.072Z",
          },
          {
            price: 198.26,
            currency: "GBp",
            unit: "therm",
            code: "NATURAL_GAS_GBP",
            created_at: "2026-09-12T15:39:50.000Z",
          },
        ],
      },
    });

    const out = text(
      await tools.opa_get_history.handler(
        { commodity: "NATURAL_GAS_GBP", period: "week" },
        {},
      ),
    );

    expect(out).not.toContain("\u00a3203.30");
    expect(out).not.toContain("\u00a3198.26");
  });
});
