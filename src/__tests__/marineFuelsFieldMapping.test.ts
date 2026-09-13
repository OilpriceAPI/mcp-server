/**
 * #120 — `opa_get_marine_fuels` threw on every unfiltered live call.
 *
 * The formatter read a flat `prices[].{port, fuel_type, price, currency, unit}`
 * record. Live `GET /v1/marine-fuels/latest` (api.oilpriceapi.com, verified
 * 2026-09-13 with the enterprise smoke key) sends `prices[]` as PORTS, each
 * with a nested `fuels[]` array, so `p.price.toFixed(2)` threw a TypeError.
 *
 * The filters were broken too, and silently. Probed live the same day, every
 * one an HTTP 200 success:
 *
 *   ?port=SGSIN / ?port=sgsin          -> 1 port
 *   ?port=SINGAPORE / ?port=Singapore  -> 0 ports (names never match)
 *   ?fuel_type=VLSFO / MGO_05S / ...   -> 0 ports (only a full code matches)
 *   ?port=SGSIN&fuel_type=VLSFO        -> 0 ports
 *
 * The tool advertised port NAMES and bare fuel types, so every filtered call
 * it could make came back empty and was reported as "no marine fuel price
 * data". Backend side: OilpriceAPI/oilpriceapi-api#7774.
 *
 * Assertions are on the RENDERED text an agent receives, through the real
 * registered handler, with only `fetch` stubbed, over verbatim live payloads.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer, NOT_REPORTED } from "../index.js";
// Plain ESM script shared with scripts/live-smoke.mjs; it ships no types.
// @ts-ignore
import { checkToolFields } from "../../scripts/live-contract-fields.mjs";
import {
  LIVE_MARINE_FUELS_LATEST,
  LIVE_MARINE_FUELS_PORT_SINGAPORE,
} from "./fixtures/marineFuelsLive.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<ToolResult>;

const server = createSandboxServer();
const registered = (
  server as unknown as {
    _registeredTools: Record<
      string,
      { handler: Handler; description?: string; inputSchema?: unknown }
    >;
  }
)._registeredTools;
const marine = registered.opa_get_marine_fuels;

/** A deep, mutable copy of a fixture. */
function copy<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function stubJson(body: unknown) {
  const fetchSpy = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Table rows for a price: `| <port> | <fuel_type> | ...`. */
function priceRows(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\| .+ \| (HFO_380|MGO_05S|VLSFO|[A-Z0-9_]+) \| /.test(line))
    .filter((line) => !line.startsWith("| Port "));
}

function requestedPath(fetchSpy: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(fetchSpy.mock.calls[0][0]));
  return `${url.pathname}${url.search}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#120 opa_get_marine_fuels reads the nested shape /v1/marine-fuels/latest sends", () => {
  it("renders every port x fuel price the live response carries, without throwing", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(LIVE_MARINE_FUELS_LATEST);

    const result = await marine.handler({}, {});
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    // 8 ports x 3 fuels in the live payload.
    expect(priceRows(text)).toHaveLength(24);
    expect(text).toContain("24 prices across 8 ports");
    // Price, currency, unit and as_of exactly as the API reported them.
    expect(text).toContain(
      "| Fujairah (AEFUJ) | HFO_380 | 720 | USD | metric_ton | 2026-09-11T17:00:00.000Z | 2 | no |",
    );
    expect(text).toContain(
      "| Singapore (SGSIN) | VLSFO | 878.5 | USD | metric_ton | 2026-09-11T17:00:00.000Z | 2 | no |",
    );
    expect(text).toContain(
      "| Santos (BRSSZ) | MGO_05S | 1394.5 | USD | metric_ton | 2026-09-11T17:00:00.000Z | 2 | no |",
    );
  });

  it("states nothing as absent on a complete live response, and fabricates no symbol", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(LIVE_MARINE_FUELS_LATEST);

    const text = textOf(await marine.handler({}, {}));

    expect(text).not.toContain(NOT_REPORTED);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Invalid Date");
    // The API reports `currency: "USD"`; a `$` would be our invention.
    expect(text).not.toContain("$");
  });

  it("carries stale and age_days through, and says so above the table", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_FUELS_LATEST);
    const singapore = body.data.prices.find(
      (p: { port_code: string }) => p.port_code === "SGSIN",
    );
    const vlsfo = singapore.fuels.find(
      (f: { fuel_type: string }) => f.fuel_type === "VLSFO",
    );
    vlsfo.stale = true;
    vlsfo.age_days = 9;
    stubJson(body);

    const text = textOf(await marine.handler({}, {}));

    expect(text).toContain(
      "| Singapore (SGSIN) | VLSFO | 878.5 | USD | metric_ton | 2026-09-11T17:00:00.000Z | 9 | **yes** |",
    );
    expect(text).toMatch(/1 of 24 prices are flagged stale by the API/);
  });

  it("never prints an absent field as data", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const body = copy(LIVE_MARINE_FUELS_LATEST);
    const fujairah = body.data.prices[0];
    const hfo = fujairah.fuels[0];
    delete hfo.currency;
    delete hfo.unit;
    delete hfo.as_of;
    delete hfo.stale;
    delete hfo.age_days;
    // A port the API sent with no fuels array at all.
    delete body.data.prices[1].fuels;
    stubJson(body);

    const result = await marine.handler({}, {});
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    expect(text).toContain(
      `| Fujairah (AEFUJ) | HFO_380 | 720 | ${NOT_REPORTED} | ${NOT_REPORTED} | ${NOT_REPORTED} | ${NOT_REPORTED} | ${NOT_REPORTED} |`,
    );
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("$");
    // Rotterdam carried no fuels: said, not dropped.
    expect(text).toMatch(/Rotterdam \(NLRTM\)[^\n]*no fuel prices/);
    expect(priceRows(text)).toHaveLength(21);
  });
});

describe("#120 filters match what the response carries, not what the API filter accepts", () => {
  it.each([["Singapore"], ["SINGAPORE"], ["SGSIN"], ["sgsin"]])(
    "port %s returns Singapore's three fuels",
    async (port) => {
      vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
      const fetchSpy = stubJson(LIVE_MARINE_FUELS_LATEST);

      const result = await marine.handler({ port }, {});
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      const rows = priceRows(text);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.startsWith("| Singapore (SGSIN) |"))).toBe(
        true,
      );
      // The API's own port filter matches codes only and its fuel_type filter
      // matches nothing, so the tool never forwards either.
      expect(requestedPath(fetchSpy)).toBe("/v1/marine-fuels/latest");
    },
  );

  it.each([
    ["VLSFO", "VLSFO"],
    ["vlsfo", "VLSFO"],
    ["MGO", "MGO_05S"],
    ["MGO_05S", "MGO_05S"],
    ["IFO380", "HFO_380"],
    ["HFO_380", "HFO_380"],
  ])("fuel_type %s returns the %s price at all 8 ports", async (fuel_type, reported) => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = stubJson(LIVE_MARINE_FUELS_LATEST);

    const result = await marine.handler({ fuel_type }, {});
    const rows = priceRows(textOf(result));

    expect(result.isError).not.toBe(true);
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.includes(` | ${reported} | `))).toBe(true);
    expect(requestedPath(fetchSpy)).toBe("/v1/marine-fuels/latest");
  });

  it("port and fuel_type together narrow to one price", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(LIVE_MARINE_FUELS_LATEST);

    const text = textOf(
      await marine.handler({ port: "Rotterdam", fuel_type: "VLSFO" }, {}),
    );

    expect(priceRows(text)).toEqual([
      "| Rotterdam (NLRTM) | VLSFO | 730 | USD | metric_ton | 2026-09-11T17:00:00.000Z | 2 | no |",
    ]);
    expect(text).toContain("1 price across 1 port");
  });

  it("a filter that matches nothing names what the API did return, not 'no data'", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(LIVE_MARINE_FUELS_LATEST);

    const result = await marine.handler({ port: "Piraeus" }, {});
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Piraeus");
    expect(text).toContain("Singapore (SGSIN)");
    expect(text).toContain("VLSFO");
    expect(text).not.toMatch(/No marine fuel price data available/);
  });

  it("an empty live response is still an error, not an empty table", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(LIVE_MARINE_FUELS_PORT_SINGAPORE);

    const result = await marine.handler({}, {});

    expect(result.isError).toBe(true);
  });

  it("advertises the fuel types and port identifiers the response actually carries", () => {
    const description = marine.description ?? "";
    expect(description).toContain("VLSFO");
    expect(description).toContain("MGO_05S");
    expect(description).toContain("HFO_380");
    expect(description).toMatch(/SGSIN/);
  });
});

describe("#120 field-level live contract (#118) passes on the live payload", () => {
  it.each([[{}], [{ port: "Singapore" }], [{ fuel_type: "VLSFO" }]])(
    "args %j",
    async (args) => {
      vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
      const outcome = await checkToolFields({
        tool: "opa_get_marine_fuels",
        handler: marine.handler,
        args,
        contractPath: "/v1/marine-fuels/latest",
        contractResponse: {
          status: 200,
          text: JSON.stringify(LIVE_MARINE_FUELS_LATEST),
          headers: new Headers(),
        },
        apiBase: "https://api.oilpriceapi.com",
        fetchImpl: vi.fn().mockRejectedValue(new Error("unexpected extra request")),
        notReported: NOT_REPORTED,
      });

      expect(outcome.reason).toBeUndefined();
      expect(outcome.ok).toBe(true);
      expect(outcome.absentKeys).toEqual([]);
    },
  );
});
