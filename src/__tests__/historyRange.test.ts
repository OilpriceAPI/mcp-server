import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #123 — date-range price history (GET /v1/prices/historical).
//
// opa_get_history only reaches the fixed past_* windows and returns summary
// statistics. A customer asking for "daily Brent and heating oil from
// 2025-01-01 to 2025-06-30" needs the rows, for more than one code, paged.
//
// Response shapes below are trimmed copies of what production returned on
// 2026-10-15 for
//   GET /v1/prices/historical?by_code=BRENT_CRUDE_USD,HEATING_OIL_USD
//       &start_date=2026-09-01&end_date=2026-09-10&interval=daily
// (X-Total 18, X-Total-Pages 1), and the 400 / 422 refusals the same
// endpoint returns for bad input.

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

const TOOL = "opa_get_history_range";
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function headers(values: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

function okFetch(body: unknown, headerValues: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: headers(headerValues),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function errorFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "",
    headers: headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function row(code: string, date: string, price: number, unit: string) {
  return {
    price,
    formatted: `$${price}`,
    currency: "USD",
    code,
    created_at: `${date}T00:00:00.000Z`,
    type: "daily_average",
    price_type: "spot_price",
    unit,
    source: "aggregated",
    // Production marks every historical row stale relative to NOW. That is
    // not a property of the observation and must never be rendered as one.
    stale: true,
    age_days: 35,
    data_status: "stale",
    stale_reason: "no_recent_data",
  };
}

function historyBody(
  prices: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "success",
    data: {
      prices,
      metadata: {
        window: "historical",
        interval: "daily",
        start_at: "2026-09-01T00:00:00Z",
        end_at: "2026-09-10T23:59:59Z",
        pagination: { page: 1, per_page: 250 },
        availability: {
          complete: true,
          requested_count: 2,
          returned_count: 2,
          missing_count: 0,
          missing_codes: [],
          missing: [],
        },
        instrument_disclosures: [
          {
            instrument: "front_month_futures",
            display_name: "NYMEX NY Harbor ULSD front-month futures",
            contract_reference: "NYMEX HO",
            spot_counterpart: "ULSD_DIESEL_USD",
            type_note: "This is an exchange futures price.",
          },
        ],
        ...extra,
      },
    },
  };
}

const TWO_CODE_ROWS = [
  row("BRENT_CRUDE_USD", "2026-09-10", 103.86, "barrel"),
  row("HEATING_OIL_USD", "2026-09-10", 4.9123, "gallon"),
  row("BRENT_CRUDE_USD", "2026-09-09", 100.25, "barrel"),
  row("HEATING_OIL_USD", "2026-09-09", 4.87, "gallon"),
];

function requestedUrl(spy: ReturnType<typeof vi.fn>): URL {
  return new URL(String(spy.mock.calls[0][0]));
}

describe("opa_get_history_range (#123)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is registered as a read tool whose description states the backend limits", () => {
    const tool = tools[TOOL];
    expect(tool, `${TOOL} must be registered`).toBeDefined();
    const description = tool.description ?? "";
    expect(description).toMatch(/up to 5 commodit/i);
    expect(description).toMatch(/500 rows per page/i);
    expect(description).toMatch(/history depth/i);
    expect(description).toMatch(/eligible account entitlement.*opa_get_plans/);
  });

  it("requests /v1/prices/historical with every resolved code, the window, interval and page", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(historyBody(TWO_CODE_ROWS), {
      "X-Total": "4",
      "X-Total-Pages": "1",
      "X-Page": "1",
    });
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler(
      {
        commodities: ["brent", "heating oil"],
        start_date: "2026-09-01",
        end_date: "2026-09-10",
        interval: "daily",
        page: 1,
        per_page: 250,
      },
      {},
    );

    expect(result.isError).toBeFalsy();
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/prices/historical");
    expect(url.searchParams.get("by_code")).toBe(
      "BRENT_CRUDE_USD,HEATING_OIL_USD",
    );
    expect(url.searchParams.get("start_date")).toBe("2026-09-01");
    expect(url.searchParams.get("end_date")).toBe("2026-09-10");
    expect(url.searchParams.get("interval")).toBe("daily");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("250");
  });

  it("renders every row per code, oldest first, with the API's own precision and unit", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(historyBody(TWO_CODE_ROWS), {
        "X-Total": "4",
        "X-Total-Pages": "1",
      }),
    );

    const body = text(
      await tools[TOOL].handler(
        {
          commodities: ["BRENT_CRUDE_USD", "HEATING_OIL_USD"],
          start_date: "2026-09-01",
          end_date: "2026-09-10",
        },
        {},
      ),
    );

    expect(body).toContain("BRENT_CRUDE_USD");
    expect(body).toContain("HEATING_OIL_USD");
    expect(body).toContain("| 2026-09-09 | 100.25 |");
    expect(body).toContain("| 2026-09-10 | 103.86 |");
    // Four decimals from the API stay four decimals.
    expect(body).toContain("| 2026-09-10 | 4.9123 |");
    expect(body).toMatch(/USD per barrel/);
    expect(body).toMatch(/USD per gallon/);
    // Oldest first inside each code's table.
    expect(body.indexOf("| 2026-09-09 | 100.25 |")).toBeLessThan(
      body.indexOf("| 2026-09-10 | 103.86 |"),
    );
    // The instrument disclosure the API attaches reaches the answer.
    expect(body).toContain("NYMEX NY Harbor ULSD front-month futures");
    // Staleness relative to today is not a property of a historical row.
    expect(body).not.toMatch(/stale/i);
    expect(body).not.toMatch(/undefined|NaN|Invalid Date|not reported/);
    expect(body).toMatch(/complete for this window|page 1 of 1/i);
  });

  it("states an explicit truncation notice when more pages exist (#113)", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(historyBody(TWO_CODE_ROWS.slice(0, 2)), {
        "X-Total": "116",
        "X-Total-Pages": "3",
        "X-Page": "1",
      }),
    );

    const result = await tools[TOOL].handler(
      {
        commodities: ["brent", "heating oil"],
        start_date: "2025-01-01",
        end_date: "2025-06-30",
        per_page: 50,
      },
      {},
    );
    const body = text(result);

    expect(result.isError).toBeFalsy();
    expect(body).toMatch(/partial/i);
    expect(body).toMatch(/page 1 of 3/i);
    expect(body).toMatch(/116 rows/);
    expect(body).toMatch(/page: 2/);
  });

  it("says a full page may continue when the API sends no page-count header", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(historyBody(TWO_CODE_ROWS.slice(0, 2))));

    const body = text(
      await tools[TOOL].handler(
        {
          commodities: ["brent"],
          start_date: "2025-01-01",
          per_page: 2,
        },
        {},
      ),
    );

    expect(body).toMatch(/may be partial/i);
    expect(body).toMatch(/page: 2/);
  });

  it("reports the plan's history-depth clamp instead of silently starting later", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        historyBody(TWO_CODE_ROWS, { start_at: "2025-10-15T17:00:00Z" }),
        { "X-Total": "4", "X-Total-Pages": "1" },
      ),
    );

    const body = text(
      await tools[TOOL].handler(
        {
          commodities: ["brent"],
          start_date: "2020-01-01",
          end_date: "2026-09-10",
        },
        {},
      ),
    );

    expect(body).toMatch(/2025-10-15/);
    expect(body).toMatch(/history depth/i);
    expect(body).toMatch(/opa_get_plans/);
  });

  it("an answered-but-empty window is a data fact naming the API's reason, not an error about the plan", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        historyBody([], {
          availability: {
            complete: false,
            requested_count: 1,
            returned_count: 0,
            missing_count: 1,
            missing_codes: ["BRENT_CRUDE_USD"],
            missing: [
              {
                code: "BRENT_CRUDE_USD",
                reason: "empty_window",
                message:
                  "BRENT_CRUDE_USD has price history, but no rows matched the requested window.",
              },
            ],
          },
        }),
        { "X-Total": "0", "X-Total-Pages": "0" },
      ),
    );

    const result = await tools[TOOL].handler(
      {
        commodities: ["brent"],
        start_date: "1950-01-01",
        end_date: "1950-02-01",
      },
      {},
    );
    const body = text(result);

    expect(body).toContain("no rows matched the requested window");
    expect(body).not.toMatch(/upgrade|plan/i);
  });

  it("names a code the API reports missing while still rendering the others", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        historyBody(
          TWO_CODE_ROWS.filter((r) => r.code === "BRENT_CRUDE_USD"),
          {
            availability: {
              complete: false,
              requested_count: 2,
              returned_count: 1,
              missing_count: 1,
              missing_codes: ["HEATING_OIL_USD"],
              missing: [
                {
                  code: "HEATING_OIL_USD",
                  reason: "empty_window",
                  message:
                    "HEATING_OIL_USD has price history, but no rows matched the requested window.",
                },
              ],
            },
          },
        ),
        { "X-Total": "2", "X-Total-Pages": "1" },
      ),
    );

    const body = text(
      await tools[TOOL].handler(
        {
          commodities: ["brent", "heating oil"],
          start_date: "2026-09-01",
          end_date: "2026-09-10",
        },
        {},
      ),
    );

    expect(body).toContain("| 2026-09-10 | 103.86 |");
    expect(body).toMatch(/HEATING_OIL_USD.*no rows matched/);
  });

  it("never repeats an API 'missing' claim for a code that has rows on the page (api#8496)", async () => {
    // Production, 2026-10-15: BRENT_CRUDE_USD 2025-01-01..2025-06-30 returned
    // 129 rows AND listed BRENT_CRUDE_USD in availability.missing.
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        historyBody(
          TWO_CODE_ROWS.filter((r) => r.code === "BRENT_CRUDE_USD"),
          {
            availability: {
              complete: false,
              requested_count: 1,
              returned_count: 0,
              missing_count: 1,
              missing_codes: ["BRENT_CRUDE_USD"],
              missing: [
                {
                  code: "BRENT_CRUDE_USD",
                  reason: "empty_window",
                  message:
                    "BRENT_CRUDE_USD has price history, but no rows matched the requested window.",
                },
              ],
            },
          },
        ),
        { "X-Total": "2", "X-Total-Pages": "1" },
      ),
    );

    const body = text(
      await tools[TOOL].handler(
        {
          commodities: ["brent"],
          start_date: "2026-09-01",
          end_date: "2026-09-10",
        },
        {},
      ),
    );

    expect(body).toContain("| 2026-09-10 | 103.86 |");
    expect(body).not.toContain("no rows matched");
  });

  describe("input is refused before any network call", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "start after end",
        {
          commodities: ["brent"],
          start_date: "2026-09-10",
          end_date: "2026-09-01",
        },
        /start_date.*after.*end_date|on or before/i,
      ],
      [
        "impossible calendar date",
        { commodities: ["brent"], start_date: "2026-02-30" },
        /not a valid calendar date/i,
      ],
      [
        "future start date",
        { commodities: ["brent"], start_date: "2999-01-01" },
        /future/i,
      ],
      [
        "unrecognised commodity",
        { commodities: ["brent", "xyzzy"], start_date: "2026-09-01" },
        /xyzzy.*not recognized/i,
      ],
    ];

    for (const [label, args, message] of cases) {
      it(label, async () => {
        vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
        const spy = okFetch(historyBody([]));
        vi.stubGlobal("fetch", spy);

        const result = await tools[TOOL].handler(args, {});

        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(message);
        expect(spy).not.toHaveBeenCalled();
      });
    }

    it("the schema bounds codes to 1-5, per_page to 500 and dates to YYYY-MM-DD", () => {
      // The SDK stores the registered input schema as a zod object.
      const schema = tools[TOOL].inputSchema as {
        safeParse: (value: unknown) => { success: boolean };
      };
      const base = { commodities: ["brent"], start_date: "2026-09-01" };
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.safeParse({ ...base, commodities: [] }).success).toBe(
        false,
      );
      expect(
        schema.safeParse({
          ...base,
          commodities: ["a", "b", "c", "d", "e", "f"],
        }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...base, per_page: 501 }).success).toBe(false);
      expect(schema.safeParse({ ...base, page: 0 }).success).toBe(false);
      expect(
        schema.safeParse({ ...base, start_date: "01/09/2026" }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...base, interval: "raw" }).success).toBe(
        false,
      );
    });
  });

  it("surfaces the API's own refusal text for a 400 (JSend fail envelope)", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(400, {
        status: "fail",
        data: {
          error: "invalid_code",
          message:
            "Code 'NOPE_USD' not found. No close match found. See /v1/commodities for all available codes.",
        },
      }),
    );

    const result = await tools[TOOL].handler(
      { commodities: ["NOPE_USD"], start_date: "2026-09-01" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Code 'NOPE_USD' not found");
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("an entitlement refusal (402) names what the API reports, with the upgrade path", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(402, {
        error: "Historical data requires paid access",
        error_code: "UPGRADE_REQUIRED",
        message:
          "Historical price data requires a paid plan. Latest prices (/v1/prices/latest) are available on the Free tier.",
      }),
    );

    let rendered = "";
    try {
      rendered = text(
        await tools[TOOL].handler(
          { commodities: ["brent"], start_date: "2026-09-01" },
          {},
        ),
      );
    } catch (error) {
      rendered = error instanceof Error ? error.message : String(error);
    }

    expect(rendered).toMatch(/402/);
    expect(rendered).toContain("Historical price data requires a paid plan");
  });

  it("a 5xx is a server failure, never a plan limit", async () => {
    // requestApi retries a 5xx with real backoff; one case is enough.
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(500, { error: { code: "INTERNAL_ERROR", message: "boom" } }),
    );
    const result = await tools[TOOL].handler(
      { commodities: ["brent"], start_date: "2026-09-01" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/500/);
    expect(text(result)).not.toMatch(/upgrade|plan/i);
  }, 30_000);

  it("keyless mode returns the teaser without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    vi.stubEnv("OIL_PRICE_API_KEY", "");
    const spy = okFetch(historyBody([]));
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler(
      { commodities: ["brent"], start_date: "2026-09-01" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires an API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});
