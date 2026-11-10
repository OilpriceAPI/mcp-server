import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #195 — the four /v1/analytics operations ledger v8 deferred.
// Fixtures are trimmed copies of production responses on 2026-11-10
// (api.oilpriceapi.com, Scale-plan smoke key). Each live body carried
// "tier": "free" for that Scale account; the tools must not render it.

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
        description?: string;
        inputSchema?: unknown;
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const UNRENDERED = /undefined|NaN|Invalid Date|\bnull\b|not reported/;
const ANALYTICS_TOOLS = [
  "opa_get_price_statistics",
  "opa_get_price_trend",
  "opa_get_price_correlation",
  "opa_get_spread_statistics",
];

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function errorFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function requestedUrl(spy: ReturnType<typeof vi.fn>): URL {
  return new URL(String(spy.mock.calls[0][0]));
}

describe("analytics tools share their contract (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("every description states the Professional/Scale gate and the 403", () => {
    for (const name of ANALYTICS_TOOLS) {
      const description = tools[name]?.description ?? "";
      expect(description, name).toMatch(/Professional and Scale plans/);
      expect(description, name).toMatch(/HTTP 403/);
      expect(description, name).not.toMatch(/real-time|forecast(?!s\b)/i);
    }
  });

  it("a 403 surfaces the API's gate text and never the sample data", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(403, {
        error: "Analytics requires the Professional or Scale plan",
        upgrade_url: "https://oilpriceapi.com/pricing",
        upgrade_required: true,
        sample_data: {
          z_score: 1.23,
          note: "This is sample data. Upgrade to access real analytics.",
        },
      }),
    );
    const message = await tools.opa_get_price_statistics
      .handler({ commodity: "WTI_USD" }, {})
      .then(
        () => "resolved",
        (error: Error) => error.message,
      );
    expect(message).toMatch(/HTTP 403.*Professional or Scale plan/);
    expect(message).not.toMatch(/1\.23|sample data/);
  });

  it("keyless mode returns teasers without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    for (const name of ANALYTICS_TOOLS) {
      const result = await tools[name].handler(
        { commodity: "wti", commodity1: "wti", commodity2: "brent" },
        {},
      );
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toMatch(/requires an API key/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unknown commodity is refused locally with suggestions", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    const result = await tools.opa_get_price_trend.handler(
      { commodity: "unobtanium" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not recognized/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("opa_get_price_statistics (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves the commodity, sends code and period, and renders each statistic", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      code: "WTI_USD",
      period: 30,
      statistics: {
        z_score: -2.02,
        z_score_interpretation:
          "Significantly below average (-2.0 std dev - unusual)",
        percentile: 3.8,
        percentile_interpretation:
          "Very low - higher than only 4% of historical prices",
        volatility: 4.14,
        volatility_interpretation: "Low",
        calculated_at: "2026-11-10T17:28:13Z",
      },
      tier: "free",
    });
    vi.stubGlobal("fetch", spy);

    const result = await tools.opa_get_price_statistics.handler(
      { commodity: "wti", period: 30 },
      {},
    );
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/analytics/statistics");
    expect(url.searchParams.get("code")).toBe("WTI_USD");
    expect(url.searchParams.get("period")).toBe("30");

    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain(
      "**Z-score of the latest price**: -2.02 — Significantly below average",
    );
    expect(body).toContain("**Percentile within the window**: 3.8");
    expect(body).toContain("**Annualized volatility**: 4.14% — Low");
    expect(body).not.toMatch(/free/i);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("a 404 for a code without data names availability, not the plan", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(404, {
        error: "No price data available for WTI_USD",
        code: "WTI_USD",
        period: 30,
      }),
    );
    const result = await tools.opa_get_price_statistics.handler(
      { commodity: "WTI_USD" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/HTTP 404: No price data available/);
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("bounds period to 1-365", () => {
    const schema = tools.opa_get_price_statistics.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ commodity: "wti", period: 365 }).success).toBe(
      true,
    );
    expect(schema.safeParse({ commodity: "wti", period: 366 }).success).toBe(
      false,
    );
  });
});

describe("opa_get_price_trend (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders the full analysis", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({
        type: "analysis",
        code: "WTI_USD",
        trend: {
          direction: "bearish",
          strength: 14.0,
          strength_interpretation: "weak",
          slope_per_day: -0.244,
          price_change_pct: -5.08,
          short_term_change_pct: -1.94,
          momentum: "steady",
          period_days: 30,
        },
        momentum: { rsi: 31.3, rsi_interpretation: "approaching_oversold" },
        moving_averages: { sma_20: 96.97, price_vs_sma: "strongly_below" },
        levels: {
          support: [81.06],
          resistance: [86.64, 94.43],
          pivot_point: 90.98,
        },
        signal: {
          value: -0.67,
          interpretation: "bearish",
          confidence: "moderate",
        },
        calculated_at: "2026-11-10T17:28:14Z",
        tier: "free",
      }),
    );
    const body = text(
      await tools.opa_get_price_trend.handler({ commodity: "WTI_USD" }, {}),
    );
    expect(body).toContain(
      "**Trend**: bearish, strength 14 (weak), slope -0.244 per day",
    );
    expect(body).toContain("**RSI**: 31.3 (approaching_oversold)");
    expect(body).toContain(
      "**Support**: 81.06; **resistance**: 86.64, 94.43; **pivot**: 90.98",
    );
    expect(body).toContain(
      "**Combined signal**: -0.67 (bearish, moderate confidence)",
    );
    expect(body).not.toMatch(UNRENDERED);
  });

  it("sends window only for indicator types and renders the series", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      type: "rsi",
      code: "WTI_USD",
      window: 14,
      values: [
        { date: "2026-08-26", rsi: 47.1, price: 81.83 },
        { date: "2026-08-27", rsi: 52.8, price: 83.52 },
      ],
    });
    vi.stubGlobal("fetch", spy);
    const body = text(
      await tools.opa_get_price_trend.handler(
        { commodity: "WTI_USD", period: 90, type: "rsi", window: 14 },
        {},
      ),
    );
    const url = requestedUrl(spy);
    expect(url.searchParams.get("type")).toBe("rsi");
    expect(url.searchParams.get("window")).toBe("14");
    expect(body).toContain("# RSI — WTI_USD, 14-day window");
    expect(body).toContain("| 2026-08-27 | 52.8 | 83.52 |");

    spy.mockClear();
    await tools.opa_get_price_trend.handler(
      { commodity: "WTI_USD", type: "levels", window: 14 },
      {},
    );
    expect(requestedUrl(spy).searchParams.has("window")).toBe(false);
  });

  it("renders levels", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({
        type: "levels",
        code: "WTI_USD",
        period: 90,
        current_price: 86.26,
        support: [81.06],
        resistance: [86.64, 94.43],
        pivot_point: 90.89,
        range: { high: 105.34, low: 81.06, spread: 24.28, spread_pct: 30.0 },
        quartiles: { q1: 88.26, median: 92.13, q3: 99.39 },
        price_position: "lower_half",
        tier: "free",
      }),
    );
    const body = text(
      await tools.opa_get_price_trend.handler(
        { commodity: "WTI_USD", type: "levels" },
        {},
      ),
    );
    expect(body).toContain(
      "**Current price**: 86.26 (lower_half of the range)",
    );
    expect(body).toContain("**Range**: low 81.06, high 105.34 (30%)");
    expect(body).toContain("**Quartiles**: Q1 88.26, median 92.13, Q3 99.39");
    expect(body).not.toMatch(UNRENDERED);
  });

  it("caps a long series at 400 rows, keeping the latest", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const values = Array.from({ length: 420 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      sma: 80 + i / 100,
      price: 81,
    }));
    vi.stubGlobal(
      "fetch",
      okFetch({ type: "sma", code: "WTI_USD", window: 20, values }),
    );
    const body = text(
      await tools.opa_get_price_trend.handler(
        { commodity: "WTI_USD", period: 365, type: "sma" },
        {},
      ),
    );
    expect(body).toMatch(
      /returned 420 rows and this answer shows the latest 400/,
    );
    expect(body).not.toContain("| 2025-01-01 |");
    expect(body).toContain(`| ${values[419].date} |`);
  });
});

describe("opa_get_price_correlation (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends both codes and renders the analysis with its rolling series", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      type: "analysis",
      code1: "WTI_USD",
      code2: "BRENT_CRUDE_USD",
      correlation: 0.964,
      correlation_interpretation:
        "Very strong positive correlation - prices highly together",
      strength: "very_strong",
      direction: "positive",
      stability: 0.206,
      stability_interpretation:
        "Variable - correlation changes noticeably over time",
      period_days: 30,
      data_points: 25,
      rolling_correlation: [
        { date: "2026-11-01", correlation: 0.233 },
        { date: "2026-11-02", correlation: 0.841 },
      ],
      calculated_at: "2026-11-10T17:28:14Z",
      tier: "free",
    });
    vi.stubGlobal("fetch", spy);

    const body = text(
      await tools.opa_get_price_correlation.handler(
        { commodity1: "wti", commodity2: "brent" },
        {},
      ),
    );
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/analytics/correlation");
    expect(url.searchParams.get("code1")).toBe("WTI_USD");
    expect(url.searchParams.get("code2")).toBe("BRENT_CRUDE_USD");
    expect(body).toContain("**Pearson correlation of daily prices**: 0.964");
    expect(body).toContain("**Data points**: 25");
    expect(body).toContain("| 2026-11-02 | 0.841 |");
    expect(body).not.toMatch(UNRENDERED);
  });

  it("builds a matrix request and renders the matrix", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      type: "matrix",
      codes: ["WTI_USD", "NATURAL_GAS_USD"],
      period: 30,
      matrix: {
        WTI_USD: { WTI_USD: 1.0, NATURAL_GAS_USD: -0.59 },
        NATURAL_GAS_USD: { WTI_USD: -0.59, NATURAL_GAS_USD: 1.0 },
      },
      tier: "free",
    });
    vi.stubGlobal("fetch", spy);

    const body = text(
      await tools.opa_get_price_correlation.handler(
        {
          commodity1: "wti",
          commodity2: "natural gas",
          type: "matrix",
          commodities: ["wti", "natural gas", "WTI_USD"],
        },
        {},
      ),
    );
    expect(requestedUrl(spy).searchParams.get("codes")).toBe(
      "WTI_USD,NATURAL_GAS_USD",
    );
    expect(body).toContain("| WTI_USD | 1 | -0.59 |");
    expect(body).toContain("| NATURAL_GAS_USD | -0.59 | 1 |");
  });

  it("refuses a matrix without commodities before any request", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    const result = await tools.opa_get_price_correlation.handler(
      { commodity1: "wti", commodity2: "brent", type: "matrix" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/needs commodities/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("opa_get_spread_statistics (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("without spread, lists the available names", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      available_spreads: [
        {
          name: "wti_brent",
          type: "basis",
          description: "WTI-Brent crude oil basis spread",
          unit: "USD/barrel",
        },
        {
          name: "321",
          type: "crack",
          description: "3-2-1 crack spread (2 gasoline + 1 heating oil)",
          unit: "USD/barrel",
        },
      ],
      usage: "GET /v1/analytics/spread?spread=wti_brent&period=30",
      tier: "free",
    });
    vi.stubGlobal("fetch", spy);
    const body = text(await tools.opa_get_spread_statistics.handler({}, {}));
    expect(requestedUrl(spy).search).toBe("");
    expect(body).toContain(
      "| `wti_brent` | basis | WTI-Brent crude oil basis spread | USD/barrel |",
    );
    expect(body).toContain("| `321` | crack |");
  });

  it("renders the current spread against its distribution", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      type: "current",
      spread_name: "WTI-Brent crude oil basis spread",
      code1: "WTI_USD",
      code2: "BRENT_CRUDE_USD",
      price1: 86.26,
      price2: 91.82,
      current_spread: -5.56,
      unit: "USD/barrel",
      historical: {
        mean: -10.51,
        std_dev: 2.39,
        min: -13.73,
        max: -6.61,
        percentile: 100.0,
        z_score: 2.08,
        data_points: 26,
      },
      interpretation:
        "Above average: Spread is 2.1 standard deviations above historical mean",
      calculated_at: "2026-11-10T17:51:24Z",
      tier: "free",
    });
    vi.stubGlobal("fetch", spy);
    const body = text(
      await tools.opa_get_spread_statistics.handler(
        { spread: "wti_brent", period: 30 },
        {},
      ),
    );
    const url = requestedUrl(spy);
    expect(url.searchParams.get("spread")).toBe("wti_brent");
    expect(url.searchParams.get("type")).toBe("current");
    expect(body).toContain(
      "**Current spread**: -5.56 USD/barrel (WTI_USD 86.26 vs BRENT_CRUDE_USD 91.82)",
    );
    expect(body).toContain(
      "mean -10.51, std dev 2.39, min -13.73, max -6.61 (26 data points)",
    );
    expect(body).toContain("**Position**: z-score 2.08, percentile 100");
    expect(body).not.toMatch(UNRENDERED);
  });

  it("renders the historical series", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({
        type: "historical",
        spread: "wti_brent",
        period: 5,
        data: [
          { date: "2026-11-06", spread: -7.72, price1: 90.88, price2: 98.6 },
        ],
        tier: "free",
      }),
    );
    const body = text(
      await tools.opa_get_spread_statistics.handler(
        { spread: "wti_brent", period: 5, type: "historical" },
        {},
      ),
    );
    expect(body).toContain("| 2026-11-06 | -7.72 | 90.88 | 98.6 |");
  });

  it("an unknown spread is a 404 that points at the list", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(404, {
        error: "No spread data available for nope",
        spread: "nope",
        period: 30,
      }),
    );
    const result = await tools.opa_get_spread_statistics.handler(
      { spread: "nope" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/HTTP 404/);
    expect(text(result)).toMatch(/without spread to list valid names/);
  });

  it("refuses a spread name outside the API's naming pattern", () => {
    const schema = tools.opa_get_spread_statistics.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ spread: "wti_brent" }).success).toBe(true);
    expect(schema.safeParse({ spread: "../prices" }).success).toBe(false);
  });
});
