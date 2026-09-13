import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #104 — three tools drop part of what the caller asked for and still return
// isError:false. #94 fixed this pattern for opa_get_storage ("Not returned")
// and opa_get_market_brief. These three were not in that scope.
//
// An incomplete answer that says it is incomplete is recoverable. A confident
// partial answer is not: inside an AI conversation the caller sees the
// rendered text and nothing else, so anything dropped is dropped silently and
// forever.
//
// Every fixture below is shaped from live production, api.oilpriceapi.com,
// 2026-09-13, with the enterprise smoke key:
//
//   GET /v1/prices/latest?by_code=BRENT_CRUDE_USD -> price 104.32, currency USD,
//       unit "barrel"
//   GET /v1/prices/latest?by_code=DUTCH_TTF_EUR   -> price 79.52, currency EUR,
//       unit "mwh"
//   GET /v1/prices/latest?by_code=TOTALLY_MADE_UP_CODE -> HTTP 200 with
//       {"status":"fail","data":{"error":"invalid_code", ...}}
//   GET /v1/prices/all    -> 521 codes, 246 of them matching the tool's own
//       gas-like test; records carry NO category field
//   GET /v1/pricing       -> enterprise_v2 has 8 features, the 5th of which is
//       "🔥 Well permits (all US states)"

interface ToolHandler {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const server = createSandboxServer();
const tools = (
  server as unknown as { _registeredTools: Record<string, ToolHandler> }
)._registeredTools;

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function notFound(): Response {
  const body = JSON.stringify({
    error: {
      code: "NOT_FOUND",
      message: "No price found for that code.",
      status: 404,
    },
  });
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

const BRENT = {
  status: "success",
  data: {
    price: 104.32,
    formatted: "$104.32",
    currency: "USD",
    code: "BRENT_CRUDE_USD",
    unit: "barrel",
    type: "spot_price",
    created_at: "2026-09-13T18:41:41.524Z",
  },
};

const WTI = {
  status: "success",
  data: {
    price: 100.62,
    formatted: "$100.62",
    currency: "USD",
    code: "WTI_USD",
    unit: "barrel",
    type: "spot_price",
    created_at: "2026-09-13T18:41:41.524Z",
  },
};

const TTF = {
  status: "success",
  data: {
    price: 79.52,
    formatted: "€79.52",
    currency: "EUR",
    code: "DUTCH_TTF_EUR",
    unit: "mwh",
    type: "spot_price",
    created_at: "2026-09-13T15:58:02.411Z",
  },
};

/** Route /v1/prices/latest?by_code=X to a fixture; 404 for anything absent. */
function priceRouter(byCode: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (url: string) => {
    const code = new URL(url).searchParams.get("by_code") ?? "";
    const hit = byCode[code];
    return hit ? ok(hit) : notFound();
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#104.1 — opa_compare_prices never presents a partial comparison as complete", () => {
  it("names a requested commodity whose API call failed", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({ BRENT_CRUDE_USD: BRENT, WTI_USD: WTI }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "wti", "DUTCH_TTF_EUR"] },
      {},
    );
    const text = result.content[0].text;

    expect(
      text,
      `a three-way comparison silently became a two-way one:\n${text}`,
    ).toContain("DUTCH_TTF_EUR");
  });

  it("names a requested commodity it could not even resolve to a code", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({ BRENT_CRUDE_USD: BRENT, WTI_USD: WTI }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "wti", "what is the weather"] },
      {},
    );
    const text = result.content[0].text;

    expect(
      text,
      `an unrecognised commodity was dropped without a word:\n${text}`,
    ).toContain("what is the weather");
  });

  it("does not print a spread for a pair the caller did not ask for", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({ BRENT_CRUDE_USD: BRENT, WTI_USD: WTI }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "wti", "DUTCH_TTF_EUR"] },
      {},
    );
    const text = result.content[0].text;

    // Three were asked for, two came back. Any spread printed here is between
    // a DIFFERENT pair than the one requested — a wrong number stated as an
    // answer, and the caller cannot see which pair produced it.
    expect(
      text,
      `a spread was computed from a pair the caller never asked about:\n${text}`,
    ).not.toContain("**Spread**");
  });

  it("still prints the spread for a genuine same-currency two-way request", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({ BRENT_CRUDE_USD: BRENT, WTI_USD: WTI }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "wti"] },
      {},
    );
    const text = result.content[0].text;

    expect(text).toContain("**Spread**");
    expect(text).toContain("3.70");
  });

  it("refuses the spread when the two records report different currencies", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({ BRENT_CRUDE_USD: BRENT, DUTCH_TTF_EUR: TTF }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "DUTCH_TTF_EUR"] },
      {},
    );
    const text = result.content[0].text;

    expect(text).not.toContain("**Spread**");
    expect(text).toMatch(/USD/);
    expect(text).toMatch(/EUR/);
  });

  it("refuses the spread when either record omits its currency", async () => {
    // Two records that both OMIT currency compared equal (undefined ===
    // undefined) and produced a spread between unknown units.
    const noCurrencyA = {
      status: "success",
      data: { price: 104.32, code: "BRENT_CRUDE_USD", unit: "barrel" },
    };
    const noCurrencyB = {
      status: "success",
      data: { price: 79.52, code: "DUTCH_TTF_EUR", unit: "mwh" },
    };
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      priceRouter({
        BRENT_CRUDE_USD: noCurrencyA,
        DUTCH_TTF_EUR: noCurrencyB,
      }),
    );

    const result = await tools.opa_compare_prices.handler(
      { commodities: ["brent", "DUTCH_TTF_EUR"] },
      {},
    );

    expect(result.content[0].text).not.toContain("**Spread**");
  });
});

// A live-shaped /v1/prices/all: three curated gas codes plus many more the
// category filter never looks at. The real payload holds 521 codes.
function allPricesPayload(codes: string[]) {
  const prices: Record<string, unknown> = {};
  for (const code of codes) {
    prices[code] = {
      code,
      price: 3.21,
      currency: "USD",
      change_24h_percent: 0.5,
    };
  }
  return {
    status: "success",
    data: {
      data: { prices, timestamp: "2026-09-13T18:00:00.000Z" },
    },
  };
}

const LIVE_GAS_CODES = [
  "NATURAL_GAS_USD",
  "NATURAL_GAS_GBP",
  "DUTCH_TTF_EUR",
  "NATURAL_GAS_WAHA",
  "NATURAL_GAS_SOCAL_USD",
  "NATURAL_GAS_ALGONQUIN_USD",
  "NATURAL_GAS_CHICAGO_USD",
  "NATURAL_GAS_HOUSTON_SHIP_CHANNEL_USD",
  "NATURAL_GAS_EASTERN_GAS_SOUTH_USD",
  "NATURAL_GAS_TTF_SPOT_EUR",
];

describe("#104.2 — opa_market_overview states the coverage of its filter", () => {
  it("says how many of the account's codes the gas filter actually showed", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          ok(allPricesPayload([...LIVE_GAS_CODES, "BRENT_CRUDE_USD"])),
        ),
    );

    const result = await tools.opa_market_overview.handler(
      { category: "gas" },
      {},
    );
    const text = result.content[0].text;

    // The caller asked for an overview and got three rows out of ten gas codes
    // the account holds. Whatever the tool decides to show, it must say what
    // it did not.
    expect(
      text,
      `a 3-of-10 sample was presented as an overview:\n${text}`,
    ).toMatch(/\b3\b[^\n]*\bof\b[^\n]*\b(10|11)\b/);
    expect(text).toMatch(/opa_list_commodities|category.{0,3}all/i);
  });

  it("is an error, not a cheerful empty overview, when the filter matches nothing", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(allPricesPayload(["BRENT_CRUDE_USD"]) as never)
        .mockResolvedValue(ok(allPricesPayload(["BRENT_CRUDE_USD"]))),
    );

    const result = await tools.opa_market_overview.handler(
      { category: "gas" },
      {},
    );
    const text = result.content[0].text;

    expect(
      result.isError,
      `"the market has nothing in it" was returned as a success:\n${text}`,
    ).toBe(true);
  });
});

// The real /v1/pricing payload, quoted from production 2026-09-13.
const PRICING = {
  status: "success",
  data: {
    plans: [
      {
        id: "professional",
        name: "Professional",
        monthlyPrice: 99,
        yearlyPrice: 950.4,
        requestLimit: 100000,
        features: [
          "100,000 API requests per month",
          "Latest price updates (60+ commodities)",
          "Full historical data (where available)",
          "🔥 Futures data included",
          "🔥 WebSocket updates for supported price streams",
          "Advanced webhooks (10)",
          "Priority email support",
          "5 API keys",
        ],
      },
      {
        id: "enterprise_v2",
        name: "Scale",
        monthlyPrice: 299,
        yearlyPrice: 2870.4,
        requestLimit: 1000000,
        features: [
          "1,000,000 API requests per month",
          "🔥 All Professional features included",
          "Unlimited historical data (where available)",
          "🔥 Drilling Intelligence (rig counts, frac spreads, DUC wells)",
          "🔥 Well permits (all US states)",
          "Unlimited webhooks",
          "Priority support + Slack channel",
          "10 API keys",
        ],
      },
    ],
  },
};

describe("#104.3 — opa_get_plans does not hide the features that answer the question", () => {
  it("shows Scale's well-permit entitlement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(PRICING)));

    const result = await tools.opa_get_plans.handler({}, {});
    const text = result.content[0].text;

    // The tool's own description says to use it for "which plan unlocks a
    // gated tool". slice(0, 4) dropped exactly those lines, and #103/#94 send
    // customers here to make the upgrade decision.
    expect(
      text,
      `a customer evaluating Scale could not see a feature they would be paying for:\n${text}`,
    ).toContain("Well permits (all US states)");
    expect(text).toContain("WebSocket updates for supported price streams");
  });

  it("shows every feature the API returned for every plan", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(PRICING)));

    const result = await tools.opa_get_plans.handler({}, {});
    const text = result.content[0].text;

    for (const plan of PRICING.data.plans) {
      for (const feature of plan.features) {
        expect(text, `${plan.name}: "${feature}" was dropped`).toContain(
          feature,
        );
      }
    }
  });
});
