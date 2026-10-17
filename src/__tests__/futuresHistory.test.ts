import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #124 — futures settlement history (GET /v1/futures/{brent,wti,natural-gas}/historical).
//
// opa_get_futures and opa_get_futures_curve return only today's front month and
// curve. Shapes below are trimmed copies of what production returned on
// 2026-10-15 (Futures::HistoricalDataService on oilpriceapi-api origin/main):
//   - a top-level object (no {status, data} envelope) with date_range,
//     interval ("1d" | "1w" | "1m"), total_records and contracts[];
//   - daily rows carry string OHLC values, a numeric volume and a
//     `settlement` that is null on most daily rows;
//   - weekly/monthly rows carry period_start/period_end/trading_days;
//   - an empty window is HTTP 200 {error, available_dates};
//   - bad input is HTTP 400 {"error":{"code":"INVALID_PARAMETER","message":...}}.

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

const TOOL = "opa_get_futures_history";
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

function dailyRow(
  date: string,
  close: string,
  settlement: string | null = null,
): Record<string, unknown> {
  return {
    code: "BRENT_FUTURES_2026_12",
    trading_date: date,
    open: "88.58",
    close,
    high: "92.12",
    low: "88.46",
    volume: 32857,
    open_interest: null,
    change_percent: "3.7706",
    settlement,
    open_captured_at: `${date}T00:00:12Z`,
    close_captured_at: `${date}T22:51:05Z`,
  };
}

function dailyBody(
  contracts: Array<{ month: string; rows: Record<string, unknown>[] }>,
): Record<string, unknown> {
  return {
    commodity: "BRENT_FUTURES",
    date_range: { from: "2026-09-01", to: "2026-09-05" },
    interval: "1d",
    trading_days_only: true,
    total_records: contracts.reduce((n, c) => n + c.rows.length, 0),
    contracts: contracts.map(({ month, rows }) => ({
      contract_month: month,
      contract_code: `BRENT_FUTURES_${month.replace("-", "_")}`,
      total_days: rows.length,
      daily_data: rows,
    })),
  };
}

function requestedUrl(spy: ReturnType<typeof vi.fn>): URL {
  return new URL(String(spy.mock.calls[0][0]));
}

describe("opa_get_futures_history (#124)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is registered with a description that states the backend limits honestly", () => {
    const tool = tools[TOOL];
    expect(tool, `${TOOL} must be registered`).toBeDefined();
    const description = tool.description ?? "";
    expect(description).toMatch(/730 days/);
    expect(description).toMatch(/brent.*wti.*natural-gas/i);
    expect(description).toMatch(/settlement/i);
    expect(description).toMatch(/eligible account entitlement.*opa_get_plans/);
  });

  it("requests the canonical per-instrument history path with from/to/contract_month/interval", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(
      dailyBody([
        { month: "2026-12", rows: [dailyRow("2026-09-01", "91.92")] },
      ]),
    );
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler(
      {
        contract: "natural-gas",
        from: "2026-09-01",
        to: "2026-09-05",
        contract_month: "2026-12",
        interval: "weekly",
      },
      {},
    );

    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/futures/natural-gas/historical");
    expect(url.searchParams.get("from")).toBe("2026-09-01");
    expect(url.searchParams.get("to")).toBe("2026-09-05");
    expect(url.searchParams.get("contract_month")).toBe("2026-12");
    expect(url.searchParams.get("interval")).toBe("weekly");
  });

  it("renders daily OHLC per contract at the API's precision, with the instrument's quote basis", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        dailyBody([
          {
            month: "2026-12",
            rows: [
              dailyRow("2026-09-01", "91.92"),
              dailyRow("2026-09-02", "91.7345"),
            ],
          },
        ]),
      ),
    );

    const result = await tools[TOOL].handler(
      { contract: "brent", from: "2026-09-01", to: "2026-09-05" },
      {},
    );
    const body = text(result);

    expect(result.isError).toBeFalsy();
    expect(body).toContain("2026-12");
    expect(body).toContain("| 2026-09-01 | 88.58 | 92.12 | 88.46 | 91.92 |");
    expect(body).toContain("91.7345");
    expect(body).toMatch(/USD per bbl/);
    // Every daily settlement in this window is null: no settlement column,
    // and the answer says close is the last captured price, not settlement.
    expect(body).not.toMatch(/\| Settlement \|/);
    expect(body).toMatch(/close.*last captured/i);
    expect(body).not.toMatch(/undefined|NaN|Invalid Date|null/);
  });

  it("shows settlement when the API reports one, and marks the rows where it is absent", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        dailyBody([
          {
            month: "2026-12",
            rows: [
              dailyRow("2026-09-01", "91.92", "91.90"),
              dailyRow("2026-09-02", "91.73", null),
            ],
          },
        ]),
      ),
    );

    const body = text(
      await tools[TOOL].handler(
        { contract: "brent", from: "2026-09-01", to: "2026-09-05" },
        {},
      ),
    );

    expect(body).toMatch(/\| Settlement \|/);
    expect(body).toContain("| 91.92 | 91.90 |");
    expect(body).toMatch(/\| 91\.73 \| not reported \|/);
  });

  it("renders weekly bars by period", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({
        commodity: "WTI_FUTURES",
        date_range: { from: "2026-08-01", to: "2026-09-30" },
        interval: "1w",
        trading_days_only: true,
        total_records: 41,
        contracts: [
          {
            contract_month: "2026-12",
            contract_code: "WTI_FUTURES_2026_12",
            total_days: 1,
            daily_data: [
              {
                period_start: "2026-08-03",
                period_end: "2026-08-07",
                open: "74.47",
                high: "75.56",
                low: "71.16",
                close: "73.76",
                avg_close: "72.98",
                volume: 0,
                settlement: "73.76",
                open_interest: null,
                trading_days: 5,
              },
            ],
          },
        ],
      }),
    );

    const body = text(
      await tools[TOOL].handler(
        {
          contract: "wti",
          from: "2026-08-01",
          to: "2026-09-30",
          contract_month: "2026-12",
          interval: "weekly",
        },
        {},
      ),
    );

    expect(body).toContain("2026-08-03 to 2026-08-07");
    expect(body).toContain("73.76");
    expect(body).toMatch(/5 trading days|\| 5 \|/);
  });

  it("caps rendered rows with an explicit truncation notice (#113)", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const months = Array.from(
      { length: 12 },
      (_, i) => `2027-${String(i + 1).padStart(2, "0")}`,
    );
    const rows = Array.from({ length: 60 }, (_, d) =>
      dailyRow(
        `2026-0${7 + Math.floor(d / 30)}-${String((d % 28) + 1).padStart(2, "0")}`,
        "90.00",
      ),
    );
    vi.stubGlobal(
      "fetch",
      okFetch(dailyBody(months.map((month) => ({ month, rows })))),
    );

    const result = await tools[TOOL].handler(
      { contract: "brent", from: "2026-07-01", to: "2026-08-31" },
      {},
    );
    const body = text(result);

    expect(result.isError).toBeFalsy();
    expect(body).toMatch(/partial/i);
    expect(body).toMatch(/720 rows/);
    expect(body).toMatch(/contract_month/);
    // The cap is honoured: far fewer table rows than the API returned.
    const tableRows = body.split("\n").filter((l) => /^\| 2026-/.test(l));
    expect(tableRows.length).toBeLessThanOrEqual(400);
  });

  it("an empty window is a data fact that names the available range", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch({
        error: "No data available for the specified date range",
        available_dates: {
          earliest: "2023-11-13",
          latest: "2026-10-14",
          total_days: 1067,
        },
      }),
    );

    const result = await tools[TOOL].handler(
      { contract: "brent", from: "2020-01-01", to: "2020-02-01" },
      {},
    );
    const body = text(result);

    expect(body).toContain("2023-11-13");
    expect(body).toContain("2026-10-14");
    expect(body).not.toMatch(/upgrade|plan/i);
  });

  describe("input is refused before any network call", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "range over 730 days",
        { contract: "brent", from: "2023-01-01", to: "2025-01-05" },
        /730 days/,
      ],
      [
        "from after to",
        { contract: "brent", from: "2026-09-10", to: "2026-09-01" },
        /from.*after.*to|on or before/i,
      ],
      [
        "future date",
        { contract: "brent", from: "2026-09-01", to: "2999-01-01" },
        /future/i,
      ],
      [
        "impossible calendar date",
        { contract: "brent", from: "2026-02-30" },
        /not a valid calendar date/i,
      ],
    ];

    for (const [label, args, message] of cases) {
      it(label, async () => {
        vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
        const spy = okFetch({});
        vi.stubGlobal("fetch", spy);

        const result = await tools[TOOL].handler(args, {});

        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(message);
        expect(spy).not.toHaveBeenCalled();
      });
    }

    it("the schema allows only the three canonical instruments and YYYY-MM months", () => {
      const schema = tools[TOOL].inputSchema as {
        safeParse: (value: unknown) => { success: boolean };
      };
      const base = { contract: "brent", from: "2026-09-01" };
      expect(schema.safeParse(base).success).toBe(true);
      for (const contract of ["wti", "natural-gas"]) {
        expect(schema.safeParse({ ...base, contract }).success).toBe(true);
      }
      for (const contract of ["gasoil", "ttf-gas", "../prices", "BRENT"]) {
        expect(schema.safeParse({ ...base, contract }).success).toBe(false);
      }
      expect(
        schema.safeParse({ ...base, contract_month: "26-12" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...base, contract_month: "2026-13" }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...base, interval: "hourly" }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...base, from: "09/01/2026" }).success).toBe(
        false,
      );
    });
  });

  it("surfaces the API's INVALID_PARAMETER message on a 400", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(400, {
        error: {
          code: "INVALID_PARAMETER",
          message: "Cannot request future dates",
          status: 400,
        },
      }),
    );

    const result = await tools[TOOL].handler(
      { contract: "wti", from: "2026-09-01", to: "2026-09-03" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Cannot request future dates");
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("a futures entitlement refusal (403) carries the API's own add-on message", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(403, {
        error: "Futures data requires the Futures add-on",
        message:
          "Futures data requires the Futures add-on or a plan that includes it.",
        required_feature: "futures_data",
      }),
    );

    let rendered = "";
    try {
      rendered = text(
        await tools[TOOL].handler(
          { contract: "brent", from: "2026-09-01", to: "2026-09-03" },
          {},
        ),
      );
    } catch (error) {
      rendered = error instanceof Error ? error.message : String(error);
    }

    expect(rendered).toMatch(/403/);
    expect(rendered).toContain("Futures add-on");
  });

  it("keyless mode returns the teaser without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    vi.stubEnv("OIL_PRICE_API_KEY", "");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);

    const result = await tools[TOOL].handler(
      { contract: "brent", from: "2026-09-01" },
      {},
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires an API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});
