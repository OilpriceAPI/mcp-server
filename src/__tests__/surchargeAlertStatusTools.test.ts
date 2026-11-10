import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #195 — tools for operations ledger v8 deferred:
//   GET  /v1/fuel-surcharge/calculate     opa_calculate_fuel_surcharge
//   POST /v1/alerts/{alert_id}/test       opa_test_price_alert
//   GET  /v1/status                       opa_get_service_status
//
// Fixtures are trimmed copies of production responses on 2026-11-10
// (api.oilpriceapi.com, Scale-plan smoke key; /v1/status keyless).

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
        annotations?: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const UNRENDERED = /undefined|NaN|Invalid Date|\bnull\b/;

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

const SURCHARGE_WEEK = {
  week_of: "2026-11-02",
  diesel_price: 6.292,
  diesel_change: -0.06,
  retrieved_at: "2026-11-03T21:03:34Z",
  surcharge_percent: 100.0,
};

function surchargeBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      region: "national",
      commodity_code: "DIESEL_RETAIL_USD",
      index: "EIA weekly U.S. retail on-highway diesel (DOE), USD/gallon",
      as_of: "2026-11-02",
      stale: false,
      stale_reason: null,
      inputs: {
        method: "percent",
        base_price: 1.25,
        increment: 0.05,
        percent_per_increment: 1.0,
        rounding: "floor",
      },
      current: SURCHARGE_WEEK,
      weeks: [
        SURCHARGE_WEEK,
        {
          week_of: "2026-10-26",
          diesel_price: 6.352,
          diesel_change: 0.076,
          retrieved_at: "2026-10-27T21:04:26Z",
          surcharge_percent: 102.0,
        },
      ],
      ...overrides,
    },
  };
}

describe("opa_calculate_fuel_surcharge (#195)", () => {
  const TOOL = "opa_calculate_fuel_surcharge";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("describes both methods and distinguishes itself from carrier-published rates", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/EIA \(DOE\) weekly retail on-highway diesel/);
    expect(description).toMatch(/percent/);
    expect(description).toMatch(/per_mile/);
    expect(description).toMatch(
      /opa_get_fuel_surcharge returns carrier-published rates/,
    );
    expect(description).toMatch(/no plan gate/);
  });

  it("sends the percent schedule with the API's parameter names", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(surchargeBody());
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler(
      { base_price: 1.25, increment: 0.05, percent_per_increment: 1, weeks: 2 },
      {},
    );
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/fuel-surcharge/calculate");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      base_price: "1.25",
      method: "percent",
      increment: "0.05",
      percent_per_increment: "1",
      rounding: "floor",
      region: "national",
      weeks: "2",
    });
  });

  it("sends mpg (and no percent parameters) for per_mile", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(
      surchargeBody({
        region: "california",
        inputs: { method: "per_mile", base_price: 1.25, mpg: 6.5 },
        current: {
          ...SURCHARGE_WEEK,
          surcharge_percent: undefined,
          surcharge_per_mile: 1.0502,
        },
        weeks: [],
      }),
    );
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler(
      {
        base_price: 1.25,
        method: "per_mile",
        mpg: 6.5,
        region: "california",
        increment: 0.05,
      },
      {},
    );
    const url = requestedUrl(spy);
    expect(url.searchParams.get("mpg")).toBe("6.5");
    expect(url.searchParams.get("region")).toBe("california");
    expect(url.searchParams.has("increment")).toBe(false);
    expect(url.searchParams.has("rounding")).toBe(false);
    expect(text(result)).toContain("surcharge **$1.0502 per mile**");
  });

  it("renders the latest week and the weekly table", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(surchargeBody()));

    const result = await tools[TOOL].handler(
      { base_price: 1.25, increment: 0.05, percent_per_increment: 1 },
      {},
    );
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain(
      "2026-11-02: diesel $6.292/gal → surcharge **100%**",
    );
    expect(body).toContain("| 2026-11-02 | 6.292 | -0.06 | 100% |");
    expect(body).toContain("| 2026-10-26 | 6.352 | +0.076 | 102% |");
    expect(body).toContain("increment=0.05");
    expect(body).not.toMatch(/stale/i);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("warns when the API marks the diesel index stale", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        surchargeBody({
          stale: true,
          stale_reason: "latest EIA week is 12 days old",
        }),
      ),
    );
    const body = text(
      await tools[TOOL].handler(
        { base_price: 1.25, increment: 0.05, percent_per_increment: 1 },
        {},
      ),
    );
    expect(body).toMatch(
      /marks the diesel index stale: latest EIA week is 12 days old/,
    );
  });

  it("refuses a method whose required inputs are missing before any request", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(surchargeBody());
    vi.stubGlobal("fetch", spy);

    const percent = await tools[TOOL].handler({ base_price: 1.25 }, {});
    expect(percent.isError).toBe(true);
    expect(text(percent)).toMatch(/needs increment and percent_per_increment/);

    const perMile = await tools[TOOL].handler(
      { base_price: 1.25, method: "per_mile" },
      {},
    );
    expect(perMile.isError).toBe(true);
    expect(text(perMile)).toMatch(/needs mpg/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("relays the API's 400 validation text", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(400, {
        status: "fail",
        data: {
          error: "increment must be at least 0.001.",
          errors: ["increment must be at least 0.001."],
        },
      }),
    );
    const result = await tools[TOOL].handler(
      { base_price: 1.25, increment: 0.001, percent_per_increment: 1 },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/HTTP 400: increment must be at least 0.001/);
  });

  it("bounds the schema to the API's ranges and enums", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ base_price: 1.25 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ base_price: 1.25, weeks: 53 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ base_price: 1.25, mpg: 0.5 }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ base_price: 1.25, increment: 0.0001 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ base_price: 1.25, region: "texas" }).success,
    ).toBe(false);
  });
});

const ALERT_TEST_BODY = {
  alert_id: 134,
  condition: "BRENT_CRUDE_USD > 1000000.0",
  current_price: { value: 91.92, timestamp: "2026-11-10T17:31:00.000Z" },
  would_trigger: false,
  in_cooldown: false,
  result: "Alert condition not met",
};

describe("opa_test_price_alert (#195)", () => {
  const TOOL = "opa_test_price_alert";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is a read-scope dry run that says it is metered", () => {
    const tool = tools[TOOL];
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(
      /Nothing is sent and the alert is not changed/,
    );
    expect(tool.description).toMatch(
      /counts against the account's request quota/,
    );
  });

  it("POSTs to the alert's test route", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(ALERT_TEST_BODY);
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler({ id: "134" }, {});
    expect(requestedUrl(spy).pathname).toBe("/v1/alerts/134/test");
    expect(spy.mock.calls[0][1].method).toBe("POST");
  });

  it("renders the verdict, the latest price and cooldown", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(ALERT_TEST_BODY));

    const result = await tools[TOOL].handler({ id: "134" }, {});
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain("BRENT_CRUDE_USD > 1000000.0");
    expect(body).toContain(
      "**Latest price**: 91.92 at Nov 10, 2026, 5:31 PM UTC",
    );
    expect(body).toMatch(/Would not trigger now/);
    expect(body).toMatch(/Not in cooldown/);
    expect(body).toMatch(/Dry run/);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("says when an alert would trigger but is in cooldown", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({ ...ALERT_TEST_BODY, would_trigger: true, in_cooldown: true }),
    );
    const body = text(await tools[TOOL].handler({ id: "134" }, {}));
    expect(body).toMatch(/Would trigger now/);
    expect(body).toMatch(/in its cooldown window/);
  });

  it("separates an unknown id from a missing price on 404", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", errorFetch(404, { error: "Alert not found" }));
    const missing = await tools[TOOL].handler({ id: "999" }, {});
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No alert found with id `999`/);

    vi.stubGlobal("fetch", errorFetch(404, { error: "No price data found" }));
    const noPrice = await tools[TOOL].handler({ id: "134" }, {});
    expect(text(noPrice)).toMatch(/no latest price for its commodity/);
  });

  it("accepts only numeric ids", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ id: "134" }).success).toBe(true);
    expect(schema.safeParse({ id: "../prices" }).success).toBe(false);
    expect(schema.safeParse({ id: "1/test" }).success).toBe(false);
  });

  it("keyless mode returns the teaser without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    const result = await tools[TOOL].handler({ id: "134" }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires an API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      operational: true,
      status: "operational",
      score: 98.3,
      grade: "A+",
      message: "All systems operational",
      components: {
        realtime_prices: "operational",
        daily_updates: "operational",
        weekly_reports: "operational",
        monthly_data: "operational",
      },
      affected_components: [],
      last_checked: "2026-11-10T17:24:13Z",
      tiers: {
        realtime: { status: "healthy", score: 99.0, grade: "A+" },
        daily: { status: "healthy", score: 97.0, grade: "A" },
      },
      ...overrides,
    },
  };
}

describe("opa_get_service_status (#195)", () => {
  const TOOL = "opa_get_service_status";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("works without an API key and sends no Authorization header", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = okFetch(statusBody());
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler({}, {});
    expect(result.isError).toBeFalsy();
    expect(requestedUrl(spy).pathname).toBe("/v1/status");
    expect(spy.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("renders the score, components and tiers without inventing values", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(statusBody()));

    const body = text(await tools[TOOL].handler({}, {}));
    expect(body).toContain("**Status**: operational — All systems operational");
    expect(body).toContain("**Health score**: 98.3 (grade A+)");
    expect(body).toContain("**Affected components**: none");
    expect(body).toContain("| realtime_prices | operational |");
    expect(body).toContain("| daily | healthy | 97 | A |");
    expect(body).toMatch(/service health|operational health/i);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("lists only unhealthy or non-current series when include_commodities is set", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(
      statusBody({
        tiers: {
          realtime: {
            status: "healthy",
            score: 99.0,
            grade: "A+",
            commodities: [
              {
                code: "EUR_USD",
                name: "EUR/USD",
                status: "healthy",
                freshness_status: "current",
                last_updated_at: "2026-11-10T17:31:19Z",
              },
              {
                code: "USD_CNY",
                name: "USD/CNY",
                status: "degraded",
                freshness_status: "stale",
                last_updated_at: "2026-11-10T16:34:29Z",
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", spy);

    const body = text(
      await tools[TOOL].handler({ include_commodities: true }, {}),
    );
    expect(requestedUrl(spy).searchParams.get("include")).toBe("commodities");
    expect(body).toContain(
      "## realtime: 2 series, 1 not healthy or not current",
    );
    expect(body).toContain("`USD_CNY` USD/CNY: degraded, freshness stale");
    expect(body).not.toContain("`EUR_USD`");
  });

  it("reports a 503 as health unknown, without retrying or blaming the plan", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = errorFetch(503, {
      status: "error",
      data: { operational: null, status: "unknown" },
    });
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler({}, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/health is unknown right now/);
    expect(text(result)).toMatch(/not an account or plan restriction/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
