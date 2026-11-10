import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #195 — market history tools for operations ledger v8 deferred:
//   GET /v1/futures/continuous/{brent,wti}/historical  opa_get_continuous_futures_history
//   GET /v1/futures/ice-gasoil/historical               opa_get_futures_history contract=gasoil
//   GET /v1/natural-gas/storage                         opa_get_natural_gas_storage
//   GET /v1/macro/releases                              opa_get_macro_releases
//
// Fixtures are trimmed copies of what production returned on 2026-11-10 to the
// Scale-plan smoke key (api.oilpriceapi.com).

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

const UNRENDERED = /undefined|NaN|Invalid Date|\bnull\b/;

function continuousBody(
  prices: Array<Record<string, unknown>>,
  windowOverride: Record<string, unknown> = {},
) {
  return {
    commodity: "BRENT_FUTURES_CONTINUOUS",
    source: "market_reporting",
    description: "Continuous front-month BRENT futures - auto-rolled",
    from: "2026-10-20",
    to: "2026-10-24",
    interval: "1d",
    count: prices.length,
    prices,
    metadata: {
      data_source: "market_reporting",
      ticker: "BZ=F",
      daily_price_basis: "latest_collected_daily_snapshot",
      official_settlement: false,
      history_available_from: "2016-02-01",
      history_window: {
        limit_days: null,
        requested_from: "2026-10-20",
        applied_from: "2026-10-20",
        limited: false,
        message: null,
        ...windowOverride,
      },
      is_continuous: true,
      roll_method: "auto",
      currency: "USD",
      unit: "barrel",
    },
    summary: {
      first_date: "2026-10-20",
      last_date: "2026-10-23",
      first_price: 109.27,
      last_price: 112.13,
      change: 2.86,
      change_percent: 2.62,
    },
  };
}

const BAR_1020 = {
  date: "2026-10-20",
  price: 109.27,
  open: 109.13,
  high: 111.97,
  low: 105.95,
  close: 109.27,
  volume: 47263,
};
const BAR_1023 = {
  date: "2026-10-23",
  price: 112.13,
  open: 112.76,
  high: 112.41,
  low: 108.28,
  close: 112.13,
  volume: 40450,
};

describe("opa_get_continuous_futures_history (#195)", () => {
  const TOOL = "opa_get_continuous_futures_history";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is registered with a description that says the bars are not settlements", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/continuous/i);
    expect(description).toMatch(/not official exchange settlements/);
    expect(description).toMatch(/opa_get_futures_history/);
    expect(description).toMatch(/eligible account entitlement.*opa_get_plans/);
    expect(description).not.toMatch(/real-time/i);
  });

  it("requests the canonical continuous path with from/to and the API's interval spelling", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(continuousBody([BAR_1020]));
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler(
      {
        contract: "wti",
        from: "2026-10-20",
        to: "2026-10-24",
        interval: "weekly",
      },
      {},
    );

    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/futures/continuous/wti/historical");
    expect(url.searchParams.get("from")).toBe("2026-10-20");
    expect(url.searchParams.get("to")).toBe("2026-10-24");
    expect(url.searchParams.get("interval")).toBe("1w");
  });

  it("omits from when the caller does not pass one, so the API applies its own window", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(continuousBody([BAR_1020]));
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler({ to: "2026-10-24" }, {});

    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/futures/continuous/brent/historical");
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.get("interval")).toBe("1d");
  });

  it("renders OHLC bars, the quote basis and the window change without inventing values", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(continuousBody([BAR_1020, BAR_1023])));

    const result = await tools[TOOL].handler(
      { contract: "brent", from: "2026-10-20", to: "2026-10-24" },
      {},
    );
    const body = text(result);

    expect(result.isError).toBeFalsy();
    expect(body).toContain(
      "| 2026-10-20 | 109.13 | 111.97 | 105.95 | 109.27 | 47263 |",
    );
    expect(body).toContain(
      "| 2026-10-23 | 112.76 | 112.41 | 108.28 | 112.13 | 40450 |",
    );
    expect(body).toMatch(/Quoted in USD per barrel/);
    expect(body).toMatch(/not official exchange settlements/);
    expect(body).toContain(
      "109.27 on 2026-10-20 to 112.13 on 2026-10-23: +2.86 (+2.62%)",
    );
    expect(body).not.toMatch(UNRENDERED);
  });

  it("states the entitlement start-date cap when the API applied one", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        continuousBody([BAR_1023], {
          limited: true,
          requested_from: "2020-01-01",
          applied_from: "2026-10-23",
          message: "History is limited to the last 30 days on this plan.",
        }),
      ),
    );

    const body = text(
      await tools[TOOL].handler({ from: "2020-01-01", to: "2026-10-24" }, {}),
    );
    expect(body).toMatch(
      /limited the start date: requested 2020-01-01, applied 2026-10-23/,
    );
    expect(body).toContain(
      "History is limited to the last 30 days on this plan.",
    );
  });

  it("an empty window is a data-availability answer, not an entitlement one", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(continuousBody([])));

    const result = await tools[TOOL].handler(
      { from: "2015-01-01", to: "2015-01-05" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/data-availability fact/);
    expect(text(result)).toMatch(/from 2016-02-01/);
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("caps the rendered bars at 400 and says what it left out", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const bars = Array.from({ length: 450 }, (_, i) => {
      const day = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return { ...BAR_1020, date: day };
    });
    vi.stubGlobal("fetch", okFetch(continuousBody(bars)));

    const body = text(
      await tools[TOOL].handler({ from: "2024-01-01", to: "2025-06-01" }, {}),
    );
    expect(body).toMatch(
      /the API returned 450 bars and this answer shows the first 400/,
    );
    expect(body.match(/^\| 20\d\d-/gm)).toHaveLength(400);
  });

  it("refuses a future end date and a reversed range before any network call", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(continuousBody([BAR_1020]));
    vi.stubGlobal("fetch", spy);

    const future = await tools[TOOL].handler({ to: "2999-01-01" }, {});
    expect(future.isError).toBe(true);
    expect(text(future)).toMatch(/in the future/);

    const reversed = await tools[TOOL].handler(
      { from: "2026-10-24", to: "2026-10-20" },
      {},
    );
    expect(reversed.isError).toBe(true);
    expect(text(reversed)).toMatch(/after to/);

    const invalid = await tools[TOOL].handler({ from: "2026-02-30" }, {});
    expect(invalid.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the schema allows only brent and wti", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ contract: "wti" }).success).toBe(true);
    for (const contract of ["gasoil", "natural-gas", "../prices"]) {
      expect(schema.safeParse({ contract }).success).toBe(false);
    }
    expect(schema.safeParse({ interval: "hourly" }).success).toBe(false);
  });

  it("a 403 surfaces the API's gate text, not a data-availability claim", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(403, { error: "Futures access required" }),
    );
    await expect(
      tools[TOOL].handler({ from: "2026-10-20", to: "2026-10-24" }, {}),
    ).rejects.toThrow(/HTTP 403.*Futures access required/);
  });

  it("keyless mode returns the teaser without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    const result = await tools[TOOL].handler({}, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires an API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("opa_get_futures_history contract=gasoil (#195)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requests the ICE gasoil history path and quotes USD per tonne", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch({
      commodity: "GASOIL_FUTURES",
      date_range: { from: "2026-10-20", to: "2026-10-21" },
      interval: "1d",
      trading_days_only: true,
      total_records: 1,
      contracts: [
        {
          contract_month: "2026-11",
          contract_code: "GASOIL_FUTURES_2026_11",
          total_days: 1,
          daily_data: [
            {
              code: "GASOIL_FUTURES_2026_11",
              trading_date: "2026-10-20",
              open: "1467.0",
              close: "1466.5",
              high: "1488.5",
              low: "1428.0",
              volume: 62552,
              open_interest: null,
              change_percent: "-0.0341",
              settlement: "1449.5",
              open_captured_at: "2026-10-20T00:02:25Z",
              close_captured_at: "2026-10-20T22:47:23Z",
            },
          ],
        },
      ],
    });
    vi.stubGlobal("fetch", spy);

    const result = await tools.opa_get_futures_history.handler(
      {
        contract: "gasoil",
        from: "2026-10-20",
        to: "2026-10-21",
        contract_month: "2026-11",
      },
      {},
    );
    const body = text(result);

    expect(requestedUrl(spy).pathname).toBe(
      "/v1/futures/ice-gasoil/historical",
    );
    expect(result.isError).toBeFalsy();
    expect(body).toMatch(/ICE Low Sulphur Gas Oil futures/);
    expect(body).toMatch(/USD per tonne/);
    expect(body).toContain(
      "| 2026-10-20 | 1467.0 | 1488.5 | 1428.0 | 1466.5 | 1449.5 | 62552 |",
    );
  });
});

const STORAGE_WEEK = {
  current_bcf: "3724.0",
  week_change_bcf: "80.0",
  year_ago_bcf: "3872.0",
  five_year_avg_bcf: "3675.6",
  surplus_deficit: "48.4",
  percentage_of_avg: "101.3",
  report_date: "2026-10-23",
  season: "injection",
  unusual_change: false,
  formatted_values: { working_gas: "3,724.0 Bcf", week_change: "+80.0 Bcf" },
  last_updated: "2026-11-05T15:35:40Z",
};

function storageBody(history?: Array<Record<string, unknown>>) {
  return {
    success: true,
    storage: STORAGE_WEEK,
    metadata: {
      source: "EIA Weekly Natural Gas Storage Report",
      update_schedule: "Thursday 10:30 AM EST",
      last_updated: "2026-11-05T15:35:40Z",
      next_update: "2026-11-12T10:30:00-05:00",
      data_quality: "Official government data",
      report_week_ending: "2026-10-23",
      cache_duration: "1 hour",
      api_version: "v1",
    },
    ...(history ? { historical_data: history } : {}),
  };
}

describe("opa_get_natural_gas_storage (#195)", () => {
  const TOOL = "opa_get_natural_gas_storage";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("states the plan gate and distinguishes gas storage from opa_get_storage", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/plan-gated/);
    expect(description).toMatch(/HTTP 403/);
    expect(description).toMatch(/opa_get_storage covers crude oil/);
    expect(description).toMatch(/eligible account entitlement.*opa_get_plans/);
  });

  it("requests the latest report alone by default", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(storageBody());
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler({}, {});
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/natural-gas/storage");
    expect(url.search).toBe("");
  });

  it("renders the latest week in Bcf with signed changes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(storageBody()));

    const result = await tools[TOOL].handler({}, {});
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain("**Week ending**: 2026-10-23");
    expect(body).toContain("3724.0 Bcf (+80.0 Bcf on the week)");
    expect(body).toContain("**Year ago**: 3872.0 Bcf");
    expect(body).toContain(
      "3675.6 Bcf; surplus (+) or deficit (-) against it: +48.4 Bcf (101.3% of the average)",
    );
    expect(body).not.toMatch(UNRENDERED);
  });

  it("asks for and renders weekly history when historical=true", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(
      storageBody([
        STORAGE_WEEK,
        {
          ...STORAGE_WEEK,
          report_date: "2026-10-16",
          current_bcf: "3644.0",
          week_change_bcf: "-12.0",
          surplus_deficit: "-41.6",
        },
      ]),
    );
    vi.stubGlobal("fetch", spy);

    const body = text(
      await tools[TOOL].handler({ historical: true, weeks: 2 }, {}),
    );
    const url = requestedUrl(spy);
    expect(url.searchParams.get("historical")).toBe("true");
    expect(url.searchParams.get("weeks")).toBe("2");
    expect(body).toContain("## Last 2 weekly reports (newest first)");
    expect(body).toContain(
      "| 2026-10-16 | 3644.0 | -12.0 | 3872.0 | 3675.6 | -41.6 |",
    );
  });

  it("bounds weeks to 1-52 in the schema", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ historical: true, weeks: 52 }).success).toBe(
      true,
    );
    expect(schema.safeParse({ historical: true, weeks: 53 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ historical: true, weeks: 0 }).success).toBe(
      false,
    );
  });

  it("a 404 (no report loaded) names data availability, not the plan", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(404, {
        error: { code: "NOT_FOUND", message: "No storage data available" },
      }),
    );
    const result = await tools[TOOL].handler({}, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/HTTP 404/);
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("a 403 surfaces the API's plan gate", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(403, { error: "This endpoint requires the Scale plan" }),
    );
    await expect(tools[TOOL].handler({}, {})).rejects.toThrow(
      /HTTP 403.*Scale plan/,
    );
  });
});

function releasesBody(
  releases: Array<Record<string, unknown>>,
  calendar: Record<string, unknown> = {
    status: "ok",
    coverage_start: "2026-05-29T17:00:00Z",
    coverage_end: "2027-12-15T15:30:00Z",
    forward_coverage_days: 399,
  },
) {
  return {
    status: "success",
    data: {
      releases,
      meta: {
        count: releases.length,
        period: "next_14_days",
        calendar,
        generated_at: "2026-11-10T17:28:07Z",
      },
    },
  };
}

const OPEC_RELEASE = {
  id: "0fc2273a-ad22-4df6-a1a7-84bc0572fb77",
  source: "opec",
  indicator_code: "OPEC_BASKET_USD",
  name: "OPEC Monthly Oil Market Report",
  release_date: "2026-11-11T11:00:00Z",
  importance: "high",
  released: false,
  schedule_basis: "announced",
};

describe("opa_get_macro_releases (#195)", () => {
  const TOOL = "opa_get_macro_releases";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("names the publishers and says there is no plan gate", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/BLS, EIA, the Fed, OPEC and Baker Hughes/);
    expect(description).toMatch(/no plan gate/);
    expect(description).toMatch(/calendar coverage/);
  });

  it("passes days, importance and source", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(releasesBody([OPEC_RELEASE]));
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler(
      { days: 14, importance: "high", source: "opec" },
      {},
    );
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/macro/releases");
    expect(url.searchParams.get("days")).toBe("14");
    expect(url.searchParams.get("importance")).toBe("high");
    expect(url.searchParams.get("source")).toBe("opec");
  });

  it("renders each release with its UTC time and schedule basis", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(releasesBody([OPEC_RELEASE])));

    const result = await tools[TOOL].handler({ days: 14 }, {});
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain("next 14 days");
    expect(body).toContain(
      "| Nov 11, 2026, 11:00 AM UTC | opec | OPEC Monthly Oil Market Report | OPEC_BASKET_USD | high | scheduled (announced) |",
    );
    expect(body).not.toMatch(/\| Actual \|/);
    expect(body).not.toMatch(/⚠/);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("shows actual, previous, consensus and surprise once the API reports them", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        releasesBody([
          {
            ...OPEC_RELEASE,
            released: true,
            actual: 3.1,
            previous: 2.9,
            consensus: 3.0,
            surprise: 0.1,
          },
          OPEC_RELEASE,
        ]),
      ),
    );
    const body = text(await tools[TOOL].handler({}, {}));
    expect(body).toMatch(/\| released \| 3.1 \| 2.9 \| 3 \| 0.1 \|/);
    expect(body).toMatch(/scheduled \(announced\) \| - \| - \| - \| - \|/);
  });

  it("an empty list under full coverage says nothing is scheduled", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(releasesBody([])));
    const body = text(
      await tools[TOOL].handler({ days: 1, source: "fed" }, {}),
    );
    expect(body).toMatch(/No releases are scheduled in this window/);
    expect(body).not.toMatch(/⚠/);
  });

  it("warns that a short list is incomplete when coverage ends inside the window", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        releasesBody([OPEC_RELEASE], {
          status: "gap",
          coverage_start: "2026-05-29T17:00:00Z",
          coverage_end: "2026-11-20T00:00:00Z",
          forward_coverage_days: 10,
        }),
      ),
    );
    const body = text(await tools[TOOL].handler({ days: 90 }, {}));
    expect(body).toMatch(
      /calendar ends at Nov 20, 2026.*not evidence that none are scheduled/,
    );
  });

  it("warns when no calendar is loaded", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        releasesBody([], {
          status: "not_loaded",
          coverage_start: null,
          coverage_end: null,
          forward_coverage_days: null,
        }),
      ),
    );
    const body = text(await tools[TOOL].handler({}, {}));
    expect(body).toMatch(/holds no release calendar/);
  });

  it("bounds days to 1-90 and the filters to the API's enums", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ days: 90 }).success).toBe(true);
    expect(schema.safeParse({ days: 91 }).success).toBe(false);
    expect(schema.safeParse({ source: "ecb" }).success).toBe(false);
    expect(schema.safeParse({ importance: "critical" }).success).toBe(false);
  });
});
