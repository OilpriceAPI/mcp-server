import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveCommodityCode,
  resolveStateCode,
  formatPrice,
  makeApiRequest,
  makeAuthRequest,
  resolveIntervalSeconds,
  SUBSCRIPTION_INTERVAL_PRESETS,
  COMMODITY_ALIASES,
  COMMODITY_INFO,
  ApiGateError,
  alertHttpError,
  fetchDemoPrices,
  demoPriceResult,
  demoComparePricesResult,
  demoListCommoditiesResult,
  demoMarketOverviewResult,
  keylessTeaserResult,
  DEMO_FOOTER,
  SIGNUP_URL,
  UPGRADE_URL,
  createSandboxServer,
  CLIENT_MARKER,
  MCP_VERSION,
} from "../index.js";

// ---------------------------------------------------------------------------
// resolveCommodityCode
// ---------------------------------------------------------------------------

describe("resolveCommodityCode", () => {
  it("resolves 'brent' alias to BRENT_CRUDE_USD", () => {
    expect(resolveCommodityCode("brent")).toBe("BRENT_CRUDE_USD");
  });

  it("resolves 'brent crude' alias to BRENT_CRUDE_USD", () => {
    expect(resolveCommodityCode("brent crude")).toBe("BRENT_CRUDE_USD");
  });

  it("resolves 'natural gas' alias to NATURAL_GAS_USD", () => {
    expect(resolveCommodityCode("natural gas")).toBe("NATURAL_GAS_USD");
  });

  it("resolves 'wti' alias to WTI_USD", () => {
    expect(resolveCommodityCode("wti")).toBe("WTI_USD");
  });

  it("passes through a valid commodity code unchanged (WTI_USD)", () => {
    expect(resolveCommodityCode("WTI_USD")).toBe("WTI_USD");
  });

  it("passes through a valid commodity code regardless of case (wti_usd)", () => {
    expect(resolveCommodityCode("wti_usd")).toBe("WTI_USD");
  });

  it("passes through BRENT_CRUDE_USD unchanged", () => {
    expect(resolveCommodityCode("BRENT_CRUDE_USD")).toBe("BRENT_CRUDE_USD");
  });

  it("returns null for unknown input", () => {
    expect(resolveCommodityCode("unknown_commodity_xyz")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(resolveCommodityCode("!!!")).toBeNull();
  });

  it("resolves case-insensitive alias ('BRENT')", () => {
    expect(resolveCommodityCode("BRENT")).toBe("BRENT_CRUDE_USD");
  });

  it("resolves 'ttf' alias to DUTCH_TTF_EUR", () => {
    expect(resolveCommodityCode("ttf")).toBe("DUTCH_TTF_EUR");
  });

  it("resolves 'gold' alias to GOLD_USD", () => {
    expect(resolveCommodityCode("gold")).toBe("GOLD_USD");
  });

  it("resolves 'carbon' alias to EU_CARBON_EUR", () => {
    expect(resolveCommodityCode("carbon")).toBe("EU_CARBON_EUR");
  });
});

// ---------------------------------------------------------------------------
// resolveStateCode
// ---------------------------------------------------------------------------

describe("resolveStateCode", () => {
  it("resolves a 2-letter code ('CA')", () => {
    expect(resolveStateCode("CA")).toBe("CA");
  });

  it("resolves lowercase 2-letter code ('tx')", () => {
    expect(resolveStateCode("tx")).toBe("TX");
  });

  it("resolves full state name ('California')", () => {
    expect(resolveStateCode("California")).toBe("CA");
  });

  it("resolves multi-word state name ('New York')", () => {
    expect(resolveStateCode("New York")).toBe("NY");
  });

  it("resolves 'district of columbia' to DC", () => {
    expect(resolveStateCode("district of columbia")).toBe("DC");
  });

  it("returns null for invalid 2-letter code", () => {
    expect(resolveStateCode("ZZ")).toBeNull();
  });

  it("returns null for unrecognized input", () => {
    expect(resolveStateCode("Middle Earth")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatPrice
// ---------------------------------------------------------------------------

describe("formatPrice", () => {
  it("formats a USD price with all fields", () => {
    const data = {
      code: "BRENT_CRUDE_USD",
      price: 85.42,
      currency: "USD",
      change_24h: 1.23,
      change_24h_percent: 1.46,
      updated_at: "2024-01-15T10:30:00Z",
    };

    const result = formatPrice(data);

    expect(result).toContain("Brent Crude Oil");
    expect(result).toContain("$85.42");
    expect(result).toContain("barrel");
    expect(result).toContain("+$1.23");
    expect(result).toContain("+1.46%");
    expect(result).toContain("Updated:");
  });

  it("formats a price with missing change fields", () => {
    const data = {
      code: "WTI_USD",
      price: 80.0,
      currency: "USD",
    };

    const result = formatPrice(data);

    expect(result).toContain("WTI Crude Oil");
    expect(result).toContain("$80.00");
    expect(result).not.toContain("24h Change");
    expect(result).not.toContain("Updated:");
  });

  it("formats negative 24h change correctly", () => {
    const data = {
      code: "BRENT_CRUDE_USD",
      price: 83.0,
      currency: "USD",
      change_24h: -2.5,
      change_24h_percent: -2.93,
    };

    const result = formatPrice(data);

    expect(result).toContain("-$2.50");
    expect(result).toContain("-2.93%");
    expect(result).not.toMatch(/\+\$-/);
  });

  it("formats EUR currency with euro symbol", () => {
    const data = {
      code: "EU_CARBON_EUR",
      price: 62.5,
      currency: "EUR",
    };

    const result = formatPrice(data);

    expect(result).toContain("€62.50");
    expect(result).not.toContain("$62.50");
  });

  it("formats GBP currency with pound symbol", () => {
    const data = {
      code: "NATURAL_GAS_GBP",
      price: 75.3,
      currency: "GBP",
    };

    const result = formatPrice(data);

    expect(result).toContain("£75.30");
    expect(result).not.toContain("$75.30");
  });

  it("formats GBp (pence) currency with pound symbol", () => {
    const data = {
      code: "NATURAL_GAS_GBP",
      price: 80.0,
      currency: "GBp",
    };

    const result = formatPrice(data);

    expect(result).toContain("£80.00");
  });

  it("uses created_at as fallback timestamp when updated_at is absent", () => {
    const data = {
      code: "BRENT_CRUDE_USD",
      price: 85.0,
      currency: "USD",
      created_at: "2024-03-01T08:00:00Z",
    };

    const result = formatPrice(data);

    expect(result).toContain("Updated:");
  });

  it("handles unknown code gracefully (falls back to code as name)", () => {
    const data = {
      code: "SOME_UNKNOWN_CODE",
      price: 100.0,
      currency: "USD",
    };

    const result = formatPrice(data);

    expect(result).toContain("SOME_UNKNOWN_CODE");
    expect(result).toContain("$100.00");
  });
});

// ---------------------------------------------------------------------------
// makeApiRequest — basic success/failure (no retries, no delays)
// ---------------------------------------------------------------------------

describe("makeApiRequest - basic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed data on a successful 200 response", async () => {
    const mockPayload = { status: "success", data: { price: 85.42 } };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockPayload,
      headers: { get: () => null },
    });

    const result = await makeApiRequest(
      "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
      mockFetch as typeof fetch,
    );

    expect(result).toEqual(mockPayload);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null on 401 without retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
    });

    const result = await makeApiRequest(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// makeApiRequest — retry behaviour (fake timers to avoid slow waits)
// ---------------------------------------------------------------------------

describe("makeApiRequest - retry behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runWithFakeTimers<T>(
    endpoint: string,
    mockFetch: typeof fetch,
  ): Promise<T | null> {
    const promise = makeApiRequest<T>(endpoint, mockFetch);
    await vi.runAllTimersAsync();
    return promise;
  }

  // v2.4.0 (#17): an exhausted 429 now surfaces the rate limit + upgrade link
  // as an ApiGateError instead of silently returning null.
  it("throws ApiGateError with upgrade link on 429 after exhausting all retries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ message: "Monthly request limit of 200 reached" }),
    });

    const promise = makeApiRequest(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(ApiGateError);
    expect((error as ApiGateError).status).toBe(429);
    expect((error as ApiGateError).message).toContain(
      "Monthly request limit of 200 reached",
    );
    expect((error as ApiGateError).message).toContain(UPGRADE_URL);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("returns null on network error after exhausting all retries", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network connection refused"));

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("succeeds on second attempt after initial 429", async () => {
    const mockPayload = { status: "success", data: { price: 82.0 } };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPayload,
        headers: { get: () => null },
      });

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toEqual(mockPayload);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("succeeds after two 500 errors then a 200", async () => {
    const mockPayload = { status: "success", data: { price: 79.0 } };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPayload,
        headers: { get: () => null },
      });

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toEqual(mockPayload);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("respects Retry-After header on 429", async () => {
    const mockPayload = { status: "success", data: { price: 80.0 } };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          get: (name: string) => (name === "Retry-After" ? "5" : null),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockPayload,
        headers: { get: () => null },
      });

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toEqual(mockPayload);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null when all retries are exhausted on 500", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: () => null },
    });

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// COMMODITY_ALIASES and COMMODITY_INFO shape checks
// ---------------------------------------------------------------------------

describe("COMMODITY_ALIASES", () => {
  it("has entries for major crude oil aliases", () => {
    expect(COMMODITY_ALIASES["brent"]).toBe("BRENT_CRUDE_USD");
    expect(COMMODITY_ALIASES["wti"]).toBe("WTI_USD");
    expect(COMMODITY_ALIASES["urals"]).toBe("URALS_CRUDE_USD");
    expect(COMMODITY_ALIASES["dubai"]).toBe("DUBAI_CRUDE_USD");
  });

  it("has entries for gas aliases", () => {
    expect(COMMODITY_ALIASES["natural gas"]).toBe("NATURAL_GAS_USD");
    expect(COMMODITY_ALIASES["ttf"]).toBe("DUTCH_TTF_EUR");
    expect(COMMODITY_ALIASES["uk gas"]).toBe("NATURAL_GAS_GBP");
  });

  it("has entries for refined product aliases", () => {
    expect(COMMODITY_ALIASES["diesel"]).toBe("DIESEL_USD");
    expect(COMMODITY_ALIASES["gasoline"]).toBe("GASOLINE_USD");
    expect(COMMODITY_ALIASES["jet fuel"]).toBe("JET_FUEL_USD");
  });
});

describe("COMMODITY_INFO", () => {
  it("provides name and unit for BRENT_CRUDE_USD", () => {
    const info = COMMODITY_INFO["BRENT_CRUDE_USD"];
    expect(info).toBeDefined();
    expect(info.name).toBe("Brent Crude Oil");
    expect(info.unit).toBe("barrel");
  });

  it("provides name and unit for DUTCH_TTF_EUR", () => {
    const info = COMMODITY_INFO["DUTCH_TTF_EUR"];
    expect(info).toBeDefined();
    expect(info.name).toBe("European Natural Gas (TTF)");
    expect(info.unit).toBe("MWh");
  });

  it("provides name and unit for EU_CARBON_EUR", () => {
    const info = COMMODITY_INFO["EU_CARBON_EUR"];
    expect(info).toBeDefined();
    expect(info.name).toBe("EU Carbon Allowances");
    expect(info.unit).toBe("metric ton CO2");
  });

  it("provides name and unit for GOLD_USD", () => {
    const info = COMMODITY_INFO["GOLD_USD"];
    expect(info).toBeDefined();
    expect(info.name).toBe("Gold");
    expect(info.unit).toBe("troy oz");
  });
});

// ---------------------------------------------------------------------------
// resolveIntervalSeconds (#3245 subscription tools)
// ---------------------------------------------------------------------------

describe("resolveIntervalSeconds", () => {
  it("maps friendly presets to seconds", () => {
    expect(resolveIntervalSeconds("5m")).toBe(300);
    expect(resolveIntervalSeconds("1h")).toBe(3600);
    expect(resolveIntervalSeconds("hourly")).toBe(3600);
    expect(resolveIntervalSeconds("daily")).toBe(86400);
    expect(resolveIntervalSeconds("1d")).toBe(86400);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveIntervalSeconds("  5M ")).toBe(300);
    expect(resolveIntervalSeconds("DAILY")).toBe(86400);
  });

  it("treats a bare integer as seconds", () => {
    expect(resolveIntervalSeconds("3600")).toBe(3600);
    expect(resolveIntervalSeconds("90")).toBe(90);
  });

  it("parses <n><unit> shorthand", () => {
    expect(resolveIntervalSeconds("10m")).toBe(600);
    expect(resolveIntervalSeconds("2h")).toBe(7200);
    expect(resolveIntervalSeconds("3d")).toBe(259200);
    expect(resolveIntervalSeconds("45s")).toBe(45);
  });

  it("returns null for invalid or non-positive inputs", () => {
    expect(resolveIntervalSeconds("nonsense")).toBeNull();
    expect(resolveIntervalSeconds("0")).toBeNull();
    expect(resolveIntervalSeconds("0m")).toBeNull();
    expect(resolveIntervalSeconds("")).toBeNull();
  });

  it("preset table covers the documented tier floors", () => {
    // free 1h, developer 30m, starter 15m, professional 5m, scale 1m
    expect(SUBSCRIPTION_INTERVAL_PRESETS["1h"]).toBe(3600);
    expect(SUBSCRIPTION_INTERVAL_PRESETS["30m"]).toBe(1800);
    expect(SUBSCRIPTION_INTERVAL_PRESETS["15m"]).toBe(900);
    expect(SUBSCRIPTION_INTERVAL_PRESETS["5m"]).toBe(300);
    expect(SUBSCRIPTION_INTERVAL_PRESETS["1m"]).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// makeAuthRequest — POST body + custom attribution headers
// ---------------------------------------------------------------------------

describe("makeAuthRequest - request shaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs a JSON body and merges custom headers (X-OPA-Source/Tool)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ subscription: { id: "abc" } }),
    });

    const result = await makeAuthRequest(
      "/v1/subscriptions",
      {
        method: "POST",
        body: { codes: ["BRENT_CRUDE_USD"], interval_seconds: 3600 },
        headers: {
          "X-OPA-Source": "mcp",
          "X-OPA-Tool": "opa_create_price_subscription",
        },
      },
      mockFetch as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-OPA-Source"]).toBe("mcp");
    expect(init.headers["X-OPA-Tool"]).toBe("opa_create_price_subscription");
    expect(init.headers["X-Api-Client"]).toBe(CLIENT_MARKER);
    expect(init.headers["X-Client-Version"]).toBe(MCP_VERSION);
    expect(JSON.parse(init.body)).toEqual({
      codes: ["BRENT_CRUDE_USD"],
      interval_seconds: 3600,
    });
  });

  it("parses the { status, data } envelope on a GET events poll", async () => {
    const payload = {
      status: "success",
      data: { cursor: 7, has_more: false, events: [] },
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    });

    const result = await makeAuthRequest(
      "/v1/subscriptions/events?since=3",
      {},
      mockFetch as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.body).toEqual(payload);
  });

  it("surfaces a non-ok status with the parsed error body (422 limit)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          error: "WATCH_LIMIT",
          message: "Your plan allows up to 1 active watches. Upgrade for more.",
        }),
    });

    const result = await makeAuthRequest(
      "/v1/subscriptions",
      { method: "POST", body: { codes: ["WTI_USD"], interval_seconds: 3600 } },
      mockFetch as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect((result.body as { error: string }).error).toBe("WATCH_LIMIT");
  });
});

// ---------------------------------------------------------------------------
// v2.4.0 — Keyless demo mode (#16)
// ---------------------------------------------------------------------------

const DEMO_PAYLOAD = {
  status: "success",
  data: {
    prices: [
      {
        code: "BRENT_CRUDE_USD",
        name: "Brent Crude Oil",
        price: 71.59,
        currency: "USD",
        updated_at: "2026-07-02T19:51:14Z",
        change_24h: 0.53,
        source: "OilPriceAPI",
      },
      {
        code: "WTI_USD",
        name: "WTI Crude Oil",
        price: 68.47,
        currency: "USD",
        updated_at: "2026-07-02T19:45:03Z",
        change_24h: 0.53,
        source: "OilPriceAPI",
      },
      {
        code: "DIESEL_USD",
        name: "Diesel (Gulf Coast)",
        price: 3.18,
        currency: "USD",
        updated_at: "2026-07-02T18:40:14Z",
        change_24h: -0.93,
        source: "OilPriceAPI",
      },
      {
        code: "EUR_USD",
        name: "EUR/USD",
        price: 1.1428,
        currency: "USD",
        updated_at: "2026-07-02T19:52:46Z",
        change_24h: 0.44,
        source: "OilPriceAPI",
      },
    ],
  },
};

function mockDemoFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => DEMO_PAYLOAD,
  });
}

describe("demo mode (#16) - fetchDemoPrices", () => {
  it("fetches /v1/demo/prices without an Authorization header", async () => {
    const mockFetch = mockDemoFetch();
    const prices = await fetchDemoPrices(mockFetch as unknown as typeof fetch);

    expect(prices).toHaveLength(4);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/v1/demo/prices");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-Api-Client"]).toBe(CLIENT_MARKER);
    expect(init.headers["X-Client-Version"]).toBe(MCP_VERSION);
  });

  it("returns null when the demo endpoint is unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
    expect(
      await fetchDemoPrices(mockFetch as unknown as typeof fetch),
    ).toBeNull();
  });
});

describe("demo mode (#16) - demoPriceResult", () => {
  it("returns live demo data plus the demo footer for a demo commodity", async () => {
    const result = await demoPriceResult(
      "brent",
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(text).toContain("Brent Crude Oil");
    expect(text).toContain("$71.59");
    expect(text).toContain("+0.53%");
    expect(
      text.endsWith(DEMO_FOOTER),
      "demo response must END with the footer",
    ).toBe(true);
    expect(text).toContain(
      "⚠ Demo data (limited commodity set). Get a free API key for 40+ commodities: https://oilpriceapi.com/auth/signup?utm_source=mcp-demo",
    );
  });

  it("lists available demo commodities when the requested one is not in the demo set", async () => {
    const result = await demoPriceResult(
      "jet fuel",
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain("JET_FUEL_USD");
    expect(text).toContain("not in the keyless demo commodity set");
    expect(text).toContain("BRENT_CRUDE_USD");
    expect(text).toContain("WTI_USD");
    expect(text.endsWith(DEMO_FOOTER)).toBe(true);
  });

  it("still returns the commodity-not-recognized error for garbage input", async () => {
    const result = await demoPriceResult(
      "flux capacitors",
      mockDemoFetch() as unknown as typeof fetch,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0].text).toContain("not recognized");
  });
});

describe("demo mode (#16) - compare / list / overview", () => {
  it("compares two demo commodities with spread and footer", async () => {
    const result = await demoComparePricesResult(
      ["brent", "wti"],
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect(text).toContain("$71.59");
    expect(text).toContain("$68.47");
    expect(text).toContain("**Spread**: $3.12");
    expect(text.endsWith(DEMO_FOOTER)).toBe(true);
  });

  it("lists only the demo commodity set with footer", async () => {
    const result = await demoListCommoditiesResult(
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect(text).toContain("Demo Mode");
    expect(text).toContain("`BRENT_CRUDE_USD`");
    expect(text).toContain("`DIESEL_USD`");
    expect(text.endsWith(DEMO_FOOTER)).toBe(true);
  });

  it("builds a grouped market overview from demo prices with footer", async () => {
    const result = await demoMarketOverviewResult(
      "all",
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect(text).toContain("Crude Oil");
    expect(text).toContain("Refined Products");
    expect(text).toContain("Forex");
    expect(text.endsWith(DEMO_FOOTER)).toBe(true);
  });

  it("respects the category filter in demo overview", async () => {
    const result = await demoMarketOverviewResult(
      "oil",
      mockDemoFetch() as unknown as typeof fetch,
    );

    const text = result.content[0].text;
    expect(text).toContain("Brent Crude Oil");
    expect(text).not.toContain("EUR");
  });
});

// ---------------------------------------------------------------------------
// v2.4.0 — Keyless teasers for gated tools (#16)
// ---------------------------------------------------------------------------

describe("keylessTeaserResult (#16)", () => {
  it("returns a teaser (not a raw 401) for a gated read tool", () => {
    const result = keylessTeaserResult("opa_get_history");
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain("opa_get_history");
    expect(text).toContain("historical price statistics");
    expect(text).toContain("Illustrative response shape (NOT real data)");
    expect(text).toContain(SIGNUP_URL);
    expect(text).not.toContain("Authentication failed");
    // Illustrative example must use placeholders, not fabricated prices.
    expect(text).toContain("$XX.XX");
  });

  it("covers alert and subscription tools too", () => {
    for (const tool of [
      "opa_create_price_alert",
      "opa_get_market_brief",
      "opa_create_price_subscription",
      "opa_get_subscription_events",
    ]) {
      const text = keylessTeaserResult(tool).content[0].text;
      expect(text).toContain(tool);
      expect(text).toContain(SIGNUP_URL);
      expect(text).not.toContain("Authentication failed");
    }
  });

  it("still returns the signup link for an unknown tool name", () => {
    const text = keylessTeaserResult("opa_future_tool").content[0].text;
    expect(text).toContain(SIGNUP_URL);
  });
});

// ---------------------------------------------------------------------------
// v2.4.0 — Tier-limit upgrade nudges (#17)
// ---------------------------------------------------------------------------

describe("tier-limit gate errors (#17) - makeApiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws ApiGateError with the API's limit detail + upgrade link on 403", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          error: "FEATURE_GATE",
          message: "Futures data requires the Professional plan",
        }),
    });

    const error = await makeApiRequest(
      "/v1/futures/ice-brent",
      mockFetch as typeof fetch,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiGateError);
    expect((error as ApiGateError).status).toBe(403);
    expect((error as ApiGateError).message).toContain(
      "Futures data requires the Professional plan",
    );
    expect((error as ApiGateError).message).toContain(UPGRADE_URL);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry on 403
  });

  it("throws ApiGateError with upgrade link on 402", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      statusText: "Payment Required",
      headers: { get: () => null },
      text: async () => "",
    });

    const error = await makeApiRequest(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiGateError);
    expect((error as ApiGateError).message).toContain("402");
    expect((error as ApiGateError).message).toContain(UPGRADE_URL);
  });
});

describe("tier-limit gate errors (#17) - alertHttpError", () => {
  it("appends the upgrade link on 429 with the API's exact limit", () => {
    const msg = alertHttpError(
      {
        ok: false,
        status: 429,
        body: { message: "Rate limit exceeded: 200 requests/month" },
      },
      "get the market brief",
    );

    expect(msg).toContain("Rate limit exceeded: 200 requests/month");
    expect(msg).toContain(UPGRADE_URL);
  });

  it("appends the upgrade link on 403", () => {
    const msg = alertHttpError(
      { ok: false, status: 403, body: { error: "plan_gate" } },
      "create the price subscription",
    );
    expect(msg).toContain(UPGRADE_URL);
  });

  it("keeps the 422 watch-limit message verbatim (existing idiom) without the nudge", () => {
    const msg = alertHttpError(
      {
        ok: false,
        status: 422,
        body: {
          error: "WATCH_LIMIT",
          message: "Your plan allows up to 1 active watches. Upgrade for more.",
        },
      },
      "create the price subscription",
    );
    expect(msg).toContain("Your plan allows up to 1 active watches");
    expect(msg).not.toContain(UPGRADE_URL);
  });
});

// ---------------------------------------------------------------------------
// v2.4.0 — Keyed behavior unchanged
// ---------------------------------------------------------------------------

describe("keyed behavior unchanged", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the Bearer key and hits the normal endpoint when a key is set", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");

    const mockPayload = {
      status: "success",
      data: { code: "BRENT_CRUDE_USD", price: 85.0, currency: "USD" },
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockPayload,
      headers: { get: () => null },
    });

    const result = await makeApiRequest(
      "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
      mockFetch as typeof fetch,
    );

    expect(result).toEqual(mockPayload);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/v1/prices/latest?by_code=BRENT_CRUDE_USD");
    expect(String(url)).not.toContain("/v1/demo/");
    expect(init.headers.Authorization).toBe("Bearer test-key-123");
    expect(init.headers["X-Api-Client"]).toBe(CLIENT_MARKER);
    expect(init.headers["X-Client-Version"]).toBe(MCP_VERSION);
  });

  it("allows wrapper integrations to override the explicit client marker", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubEnv("OILPRICEAPI_CLIENT_MARKER", "oilpriceapi-gemini/1.0.0");

    const mockPayload = { status: "success", data: { price: 85.0 } };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockPayload,
      headers: { get: () => null },
    });

    await makeApiRequest("/v1/prices/latest", mockFetch as typeof fetch);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe(CLIENT_MARKER);
    expect(init.headers["X-Api-Client"]).toBe("oilpriceapi-gemini/1.0.0");
    expect(init.headers["X-Client-Version"]).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Tool registration metadata (Claude Connectors Directory requirements)
// ---------------------------------------------------------------------------

interface RegisteredToolInfo {
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

describe("tool registration metadata", () => {
  const server = createSandboxServer();
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, RegisteredToolInfo>;
    }
  )._registeredTools;

  const CREATE_TOOLS = [
    "opa_create_price_alert",
    "opa_create_price_subscription",
  ];
  const DELETE_TOOLS = ["opa_delete_price_alert", "opa_delete_subscription"];
  const WRITE_TOOLS = new Set([...CREATE_TOOLS, ...DELETE_TOOLS]);

  it("registers exactly 26 tools", () => {
    expect(Object.keys(tools)).toHaveLength(26);
  });

  it("registers all four write tools (creates + deletes)", () => {
    for (const name of WRITE_TOOLS) {
      expect(tools[name], name).toBeDefined();
    }
  });

  it("every tool has a human-readable title", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.title, `${name} title`).toBeTypeOf("string");
      expect(tool.title!.length, `${name} title is empty`).toBeGreaterThan(0);
      // Titles are human names ("Get Commodity Price"), not tool ids.
      expect(tool.title, `${name} title looks like a tool id`).not.toMatch(
        /^opa_|_/,
      );
    }
  });

  it("every tool has a description", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `${name} description`).toBeTypeOf("string");
      expect(
        tool.description!.length,
        `${name} description is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("every tool has annotations with openWorldHint: true (external API)", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations, `${name} annotations`).toBeDefined();
      expect(tool.annotations!.openWorldHint, `${name} openWorldHint`).toBe(
        true,
      );
    }
  });

  it("all non-write tools are read-only", () => {
    for (const [name, tool] of Object.entries(tools)) {
      if (WRITE_TOOLS.has(name)) continue;
      expect(tool.annotations, `${name} annotations`).toEqual({
        readOnlyHint: true,
        openWorldHint: true,
      });
    }
  });

  it("create tools are non-read-only, non-destructive, non-idempotent", () => {
    for (const name of CREATE_TOOLS) {
      expect(tools[name].annotations, `${name} annotations`).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it("delete tools are destructive and idempotent", () => {
    for (const name of DELETE_TOOLS) {
      expect(tools[name].annotations, `${name} annotations`).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });
});
