/**
 * #125 — marine workflows: the port directory, single-port detail and
 * marine-fuel history, plus moving opa_get_marine_fuels to the canonical path.
 *
 * Backend contract, read from oilpriceapi-api origin/main and probed live on
 * 2026-10-15 with the production smoke key:
 *
 *   GET /v1/marine-ports                 -> {ports[], count, filters}
 *   GET /v1/marine-ports/SGSIN           -> {port: {..., recent_prices[]}}
 *   GET /v1/marine-ports/XXXXX           -> 404 {"error":"Marine fuel port not found"}
 *   GET /v1/prices/marine-fuels/historical?port_code=SGSIN&fuel_type=VLSFO
 *                                        -> 200, prices: []  (bare type matches nothing,
 *                                           oilpriceapi-api#7774)
 *   ...&fuel_type=VLSFO_SGSIN_USD        -> 200, the series
 *   free account without a live trial    -> 403 {"error":"Historical marine fuel data requires a paid subscription"}
 *
 * Assertions are on the rendered text through the real registered handler,
 * with only `fetch` stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiGateError, createSandboxServer } from "../index.js";
import {
  LIVE_MARINE_HISTORY_EMPTY,
  LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D,
  LIVE_MARINE_PORT_SGSIN,
  LIVE_MARINE_PORTS,
} from "./fixtures/marineWorkflowsLive.js";
import { LIVE_MARINE_FUELS_LATEST } from "./fixtures/marineFuelsLive.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<ToolResult>;
type Registered = Record<
  string,
  {
    handler: Handler;
    description?: string;
    inputSchema?: { safeParse: (v: unknown) => { success: boolean } };
  }
>;

const tools = (
  createSandboxServer() as unknown as { _registeredTools: Registered }
)._registeredTools;

function copy<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function stubResponse(body: unknown, status = 200) {
  const fetchSpy = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function requestedPath(fetchSpy: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(fetchSpy.mock.calls[0][0]));
  return `${url.pathname}${url.search}`;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#125 opa_get_marine_fuels uses the canonical latest path", () => {
  it("requests /v1/prices/marine-fuels/latest, not the deprecated alias", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubResponse(LIVE_MARINE_FUELS_LATEST);
    const result = await tools.opa_get_marine_fuels.handler({}, {});
    expect(result.isError).not.toBe(true);
    expect(requestedPath(fetchSpy)).toBe(
      "/v1/prices/marine-fuels/latest?limit=100",
    );
  });
});

describe("#125 opa_get_marine_ports", () => {
  const ports = () => tools.opa_get_marine_ports;

  it("is registered", () => {
    expect(ports()).toBeDefined();
  });

  it("lists every port the directory returns with its fuel services", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubResponse(LIVE_MARINE_PORTS);
    const result = await ports().handler({}, {});
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    expect(requestedPath(fetchSpy)).toBe("/v1/marine-ports");
    for (const code of [
      "SGSIN",
      "NLRTM",
      "USHOU",
      "AEFUJ",
      "HKHKG",
      "USLAX",
      "BRSSZ",
      "USNYC",
    ]) {
      expect(text).toContain(`| ${code} |`);
    }
    expect(text).toContain(
      "| SGSIN | Singapore | Singapore | Asia | yes | MGO_05S, VLSFO, HFO_380, HFO_180 | 24/7 |",
    );
    expect(text).toContain("8 ports");
  });

  it("forwards region, country and major_only as query filters", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubResponse(LIVE_MARINE_PORTS);
    await ports().handler(
      {
        region: "Middle East",
        country: "United Arab Emirates",
        major_only: true,
      },
      {},
    );
    expect(requestedPath(fetchSpy)).toBe(
      "/v1/marine-ports?region=Middle+East&country=United+Arab+Emirates&major_ports=true",
    );
  });

  it("reads one port by UN/LOCODE, uppercased, with its recent prices", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubResponse(LIVE_MARINE_PORT_SGSIN);
    const result = await ports().handler({ port: "sgsin" }, {});
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    expect(requestedPath(fetchSpy)).toBe("/v1/marine-ports/SGSIN");
    expect(text).toContain("Singapore (SGSIN)");
    expect(text).toContain("Asia/Singapore");
    expect(text).toContain(
      "| VLSFO | 917 | USD | metric_ton | 2026-10-15T03:11:12.927Z |",
    );
    expect(text).toContain("| MGO_05S | 1295 | USD | metric_ton |");
  });

  it("says a port's recent prices are absent instead of rendering an empty table", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_PORT_SGSIN);
    body.data.port.recent_prices = [];
    stubResponse(body);
    const text = textOf(await ports().handler({ port: "SGSIN" }, {}));
    expect(text).toMatch(/no prices observed in the last 7 days/i);
    expect(text).not.toContain("| Fuel Type |");
  });

  it("labels weekend observations with their actual age instead of claiming a 24-hour price", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_PORT_SGSIN);
    body.data.port.recent_prices = [{
      fuel_type: "VLSFO", price: 917, currency: "USD", unit: "metric_ton",
      timestamp: "2026-10-12T03:00:00Z", collected_at: "2026-10-12T03:00:00Z",
      as_of: "2026-10-09T17:00:00Z", age_days: 3, stale: true,
    }];
    stubResponse(body);
    const text = textOf(await ports().handler({ port: "SGSIN" }, {}));
    expect(text).toContain("2026-10-09T17:00:00Z | 3 | **yes**");
    expect(text).toContain("up to 7 days old");
    expect(text).not.toContain("last 24 hours");
  });

  it("never prints an absent field as data", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_PORT_SGSIN);
    delete body.data.port.recent_prices[0].currency;
    delete body.data.port.timezone;
    stubResponse(body);
    const text = textOf(await ports().handler({ port: "SGSIN" }, {}));
    expect(text).not.toMatch(/undefined|NaN|null/);
    expect(text).toContain("| HFO_380 | 876 | not reported | metric_ton |");
    expect(text).toMatch(/Timezone: not reported/);
  });

  it("a 404 names the unknown port and points at the directory, not the plan", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse({ error: "Marine fuel port not found" }, 404);
    const result = await ports().handler({ port: "XXXXX" }, {});
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("XXXXX");
    expect(text).toContain("opa_get_marine_ports");
    expect(text).not.toMatch(/upgrade|higher plan/i);
  });

  it("an empty directory answer is an error, not an empty table", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse({
      status: "success",
      data: { ports: [], count: 0, filters: {} },
    });
    const result = await ports().handler({ region: "Antarctica" }, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Antarctica");
  });

  it("rejects path-unsafe port input before any network call", () => {
    const schema = ports().inputSchema!;
    expect(schema.safeParse({ port: "../admin" }).success).toBe(false);
    expect(schema.safeParse({ port: "SGSIN/x" }).success).toBe(false);
    expect(schema.safeParse({ port: "SGSIN" }).success).toBe(true);
    expect(schema.safeParse({ port: "Singapore" }).success).toBe(true);
  });
});

describe("#125 opa_get_marine_fuel_history", () => {
  const history = () => tools.opa_get_marine_fuel_history;

  it("is registered and states its plan boundary", () => {
    expect(history()).toBeDefined();
    expect(history().description).toMatch(
      /paid subscription or an active trial/,
    );
    expect(history().description).toMatch(/opa_get_plans/);
  });

  it("requests the full series code, because a bare fuel type returns an empty 200", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubResponse(LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D);
    await history().handler(
      { port_code: "sgsin", fuel_type: "VLSFO", days: 7 },
      {},
    );
    expect(requestedPath(fetchSpy)).toBe(
      "/v1/prices/marine-fuels/historical?port_code=SGSIN&fuel_type=VLSFO_SGSIN_USD&days=7",
    );
  });

  it("renders one row per assessment date, newest first, with currency and unit", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse(LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D);
    const result = await history().handler(
      { port_code: "SGSIN", fuel_type: "VLSFO", days: 7 },
      {},
    );
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain("Singapore (SGSIN)");
    expect(text).toContain(
      "| 2026-10-14 | 917 | USD | metric_ton | 2026-10-15T03:11:12.927Z |",
    );
    expect(text).toContain("| 2026-10-08 | 908 | USD | metric_ton |");
    expect(text).toMatch(/5 assessment dates/);
    expect(text).toMatch(/High 917.*Low 889\.5/);
  });

  it("keeps the most recently collected value when one date was collected twice", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D);
    const fuels = body.data.prices[0].fuels;
    // An earlier collection of the 10-14 assessment at a different price.
    fuels.splice(1, 0, {
      ...fuels[0],
      price: 900,
      collected_at: "2026-10-14T23:00:00.000Z",
      timestamp: "2026-10-14T23:00:00.000Z",
    });
    stubResponse(body);
    const text = textOf(
      await history().handler(
        { port_code: "SGSIN", fuel_type: "VLSFO", days: 7 },
        {},
      ),
    );
    expect(text).toContain("| 2026-10-14 | 917 |");
    expect(text).not.toContain("| 2026-10-14 | 900 |");
    expect(text).toMatch(/6 rows/);
  });

  it("says when the returned rows stop short of the requested window", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse(LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D);
    const text = textOf(
      await history().handler(
        { port_code: "SGSIN", fuel_type: "VLSFO", days: 365 },
        {},
      ),
    );
    expect(text).toMatch(/earliest assessment returned is 2026-10-08/i);
  });

  it("an empty series names the port and fuel and points at fuel_services", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse(LIVE_MARINE_HISTORY_EMPTY);
    const result = await history().handler(
      { port_code: "SGSIN", fuel_type: "HFO_180", days: 30 },
      {},
    );
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("HFO_180");
    expect(text).toContain("SGSIN");
    expect(text).toContain("opa_get_marine_ports");
    expect(text).not.toMatch(/upgrade|higher plan/i);
  });

  it("never prints an absent field as data", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_HISTORY_SGSIN_VLSFO_7D);
    delete body.data.prices[0].fuels[0].unit;
    delete body.data.prices[0].fuels[1].as_of;
    stubResponse(body);
    const text = textOf(
      await history().handler(
        { port_code: "SGSIN", fuel_type: "VLSFO", days: 7 },
        {},
      ),
    );
    expect(text).not.toMatch(/undefined|NaN|null|Invalid Date/);
    expect(text).toContain("| 2026-10-14 | 917 | USD | not reported |");
    expect(text).toContain("| not reported | 907 |");
  });

  it("a 403 surfaces the API's own entitlement text", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubResponse(
      { error: "Historical marine fuel data requires a paid subscription" },
      403,
    );
    const error = await history()
      .handler({ port_code: "SGSIN", fuel_type: "VLSFO" }, {})
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ApiGateError);
    expect((error as ApiGateError).status).toBe(403);
    expect((error as Error).message).toContain(
      "Historical marine fuel data requires a paid subscription",
    );
  });

  it("validates input before any network call", () => {
    const schema = history().inputSchema!;
    expect(
      schema.safeParse({ port_code: "SGSIN", fuel_type: "VLSFO" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ port_code: "Singapore", fuel_type: "VLSFO" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ port_code: "SG/IN", fuel_type: "VLSFO" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ port_code: "SGSIN", fuel_type: "DIESEL" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ port_code: "SGSIN", fuel_type: "VLSFO", days: 0 })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ port_code: "SGSIN", fuel_type: "VLSFO", days: 366 })
        .success,
    ).toBe(false);
  });

  it("without a key returns the keyless teaser and makes no request", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const fetchSpy = stubResponse({});
    const result = await history().handler(
      { port_code: "SGSIN", fuel_type: "VLSFO" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires an API key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
