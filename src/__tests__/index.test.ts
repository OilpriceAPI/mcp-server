import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveCommodityCode,
  resolveStateCode,
  formatPrice,
  makeApiRequest,
  COMMODITY_ALIASES,
  COMMODITY_INFO,
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

  it("returns null on 429 after exhausting all retries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
    });

    const result = await runWithFakeTimers(
      "/v1/prices/latest",
      mockFetch as typeof fetch,
    );

    expect(result).toBeNull();
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
