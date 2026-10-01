import { createServer } from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  executeEnergyTool,
  DemoCache,
  publicFields,
  observation,
} from "../energyPlugin.js";
import { getApiKey } from "../index.js";
import { withRequestCredential } from "../requestCredential.js";

const quote = {
  code: "BRENT_CRUDE_USD",
  name: "Brent Front-Month Futures",
  price: 98.33,
  currency: "USD",
  updated_at: "2026-10-01T07:05:49Z",
  source: "OilPriceAPI",
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const body = (result: Awaited<ReturnType<typeof executeEnergyTool>>) =>
  result.structuredContent as any;
afterEach(() => vi.restoreAllMocks());
describe("public energy facade", () => {
  it("cancels an upstream that stalls after opening its response body", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"status":');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const port = (upstream.address() as { port: number }).port;
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(), 100);
    try {
      const data = body(
        await executeEnergyTool(
          "energy_get_price",
          { benchmark: quote.code },
          {
            key: "credential",
            signal: cancel.signal,
            fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${port}`, init),
          },
        ),
      );
      expect(data.outcome).toBe("upstream_error");
    } finally {
      clearTimeout(timer);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
  it("does not count malformed futures contracts as usable data", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({
          contracts: [{ contract_month: "2026-11", settlement_price: null }],
        }),
      );
    const data = await executeEnergyTool(
      "energy_futures_curve",
      { instrument: "brent" },
      { key: "credential", fetchImpl },
    );
    expect(data.isError).toBe(true);
    expect((data.structuredContent as any).contracts[0]).toMatchObject({
      availability: "unavailable",
      settlement_price: null,
    });
  });

  it("redacts a credential reflected in an otherwise allowed market field", async () => {
    const key = "caller-key-value-1234";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ status: "success", data: { ...quote, name: key } }),
      );
    const data = await executeEnergyTool(
      "energy_get_price",
      { benchmark: quote.code },
      { key, fetchImpl },
    );
    expect(JSON.stringify(data)).not.toContain(key);
  });
  it("returns only the requested geography without inventing a report period or delta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: "success",
        data: {
          rig_counts: { US_RIG_COUNT: 540, CANADA_RIG_COUNT: 123 },
          last_updated: "2026-10-01",
          deltas: { rig_counts: 25 },
        },
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_drilling",
        { geography: "US" },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data).toMatchObject({
      geography: "US",
      count: 540,
      unit: "rigs",
      report_period: null,
      updated_at: "2026-10-01",
      prior_report_change: null,
    });
  });

  it("preserves demo dataset identity without inventing observation time", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ status: "success", data: { prices: [quote] } }),
      );
    const data = body(
      await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { fetchImpl },
      ),
    );
    expect(data.observations[0]).toMatchObject({
      price: 98.33,
      currency: "USD",
      unit: "barrel",
      dataset_context: quote.name,
      source_timestamp: null,
      updated_at: quote.updated_at,
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it("marks absent comparison rows unavailable instead of zero", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ status: "success", data: { prices: [quote] } }),
      );
    const data = body(
      await executeEnergyTool(
        "energy_compare",
        { benchmarks: [quote.code, "WTI_USD"] },
        { fetchImpl },
      ),
    );
    expect(data.observations[1]).toMatchObject({
      availability: "unavailable",
      price: null,
    });
    expect(data.observations[0].price).toBe(98.33);
  });
  it.each([
    ["energy_compare", { benchmarks: Array(6).fill(quote.code) }],
    ["energy_compare", { benchmarks: [quote.code, quote.code] }],
    ["energy_history", { benchmark: quote.code, days: 31 }],
    ["energy_history", { benchmark: quote.code, limit: 101 }],
    ["energy_history", { benchmark: quote.code, page: 2 }],
    [
      "energy_marine_fuels",
      { ports: ["NLRTM", "SGSIN", "USHOU"], grade: "VLSFO" },
    ],
    ["energy_marine_fuels", { ports: ["UNKNOWN"], grade: "VLSFO" }],
    ["energy_get_price", { benchmark: "GOLD_USD" }],
  ] as const)("rejects invalid/bulk inputs %s", async (tool, args) => {
    const fetchImpl = vi.fn();
    expect(
      body(await executeEnergyTool(tool, args, { fetchImpl })).outcome,
    ).toBe("invalid_argument");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    "energy_history",
    "energy_futures_curve",
    "energy_marine_fuels",
    "energy_drilling",
  ] as const)("gates anonymous %s without calling upstream", async (tool) => {
    const args = {
      energy_history: { benchmark: quote.code },
      energy_futures_curve: { instrument: "natural-gas" },
      energy_marine_fuels: { ports: ["NLRTM"], grade: "VLSFO" },
      energy_drilling: { geography: "Permian" },
    }[tool];
    const fetchImpl = vi.fn();
    expect(
      body(await executeEnergyTool(tool, args, { fetchImpl })).outcome,
    ).toBe("entitlement");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403, 404, 500])(
    "fails closed on upstream %s without exposing messages or secrets",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          response(
            { error: "opa_abcdefghijklmnop secret=raw", internal_id: 900 },
            status,
          ),
        );
      const result = await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { key: "caller-credential-one", fetchImpl },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
      expect(JSON.stringify(result)).not.toContain("caller-credential-one");
    },
  );
  it("reports explicit upstream 429 without an upgrade claim", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"error":"slow down"}', {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { fetchImpl },
      ),
    );
    expect(data.outcome).toBe("rate_limit");
    expect(data.message).not.toContain("upgrade");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a wrong-code successful response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ status: "success", data: { ...quote, code: "WTI_USD" } }),
      );
    const data = body(
      await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data.observations[0]).toMatchObject({
      availability: "unavailable",
      price: null,
    });
  });
  it("preserves authenticated freshness and source fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: "success",
        data: {
          ...quote,
          unit: "bbl",
          as_of: "2026-09-30T18:00:00Z",
          stale: true,
          freshness: {
            status: "stale",
            source_observed_at: "2026-09-30T18:00:00Z",
          },
        },
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data.observations[0]).toMatchObject({
      source_timestamp: "2026-09-30T18:00:00Z",
      stale: true,
      unit: "bbl",
      freshness: { status: "stale" },
    });
  });
  it("caps history at one bounded daily page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: "success",
        data: { prices: Array(50).fill({ ...quote, as_of: "2026-09-20" }) },
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_history",
        { benchmark: quote.code, days: 30, limit: 3 },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data.observations).toHaveLength(3);
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "interval=1d&per_page=3&page=1",
    );
  });
  it("preserves futures contract semantics and non-USD basis", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        analysis_date: "2026-10-01",
        contracts: [
          {
            contract_month: "2026-11",
            settlement_price: 42,
            trading_date: "2026-09-30",
            months_to_expiry: 1,
          },
        ],
        internal_id: "private",
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_futures_curve",
        { instrument: "ttf-gas" },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data.quote_basis).toEqual({ currency: "EUR", unit: "MWh" });
    expect(data.contracts[0]).toMatchObject({
      contract_month: "2026-11",
      trading_date: "2026-09-30",
      months_to_expiry: 1,
    });
    expect(data.internal_id).toBeUndefined();
  });
  it("preserves exact marine port/grade and never substitutes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: "success",
        data: {
          prices: [
            {
              port_code: "NLRTM",
              port_name: "Rotterdam",
              fuels: [
                {
                  fuel_type: "VLSFO",
                  price: 612,
                  currency: "USD",
                  unit: "tonne",
                  as_of: "2026-09-30",
                  stale: true,
                },
                { fuel_type: "MGO_05S", price: 900 },
              ],
            },
          ],
        },
      }),
    );
    const data = body(
      await executeEnergyTool(
        "energy_marine_fuels",
        { ports: ["NLRTM", "SGSIN"], grade: "VLSFO" },
        { key: "credential", fetchImpl },
      ),
    );
    expect(data.quotes[0]).toMatchObject({
      port: "NLRTM",
      grade: "VLSFO",
      price: 612,
      source_timestamp: "2026-09-30",
      stale: true,
    });
    expect(data.quotes[1]).toMatchObject({
      port: "SGSIN",
      grade: "VLSFO",
      price: null,
      availability: "unavailable",
    });
  });
  it("never substitutes national counts for Permian", async () => {
    const fetchImpl = vi.fn();
    expect(
      body(
        await executeEnergyTool(
          "energy_drilling",
          { geography: "Permian" },
          { key: "credential", fetchImpl },
        ),
      ).outcome,
    ).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("isolates concurrent callers and explicit anonymous context from environment", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "server-secret");
    try {
      expect(getApiKey()).toBe("server-secret");
      const values = await Promise.all([
        withRequestCredential("one", async () => {
          await new Promise((r) => setTimeout(r, 5));
          return getApiKey();
        }),
        withRequestCredential("two", async () => {
          await Promise.resolve();
          return getApiKey();
        }),
        withRequestCredential(undefined, async () => getApiKey()),
      ]);
      expect(values).toEqual(["one", "two", undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("coalesces concurrent demo requests and caches within disclosed interval", async () => {
    const cache = new DemoCache();
    const load = vi.fn().mockResolvedValue({ prices: [quote] });
    await Promise.all([cache.get(load), cache.get(load)]);
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("does not cache upstream failure as data", async () => {
    const cache = new DemoCache();
    await expect(
      cache.get(async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow();
    const load = vi.fn().mockResolvedValue({});
    await cache.get(load);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("emits operational telemetry only and survives analytics failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ status: "success", data: { prices: [quote] } }),
      );
    const writeEvent = vi.fn().mockImplementation(() => {
      throw Error("analytics down");
    });
    const data = body(
      await executeEnergyTool(
        "energy_get_price",
        { benchmark: quote.code },
        { fetchImpl, writeEvent },
      ),
    );
    expect(data.availability).toBe("available");
    expect(writeEvent.mock.calls[0][0]).toMatchObject({
      event: "plugin_tool_call",
      tool: "energy_get_price",
      access: "demo",
      result_count: 1,
    });
    expect(JSON.stringify(writeEvent.mock.calls)).not.toContain(quote.name);
  });
  it("excludes private identifiers and treats invalid values as unavailable", () => {
    expect(
      publicFields({
        price: 5,
        api_key: "key",
        id: 123,
        metadata: { email: "private" },
        source: "secret=key",
      }),
    ).toEqual({ price: 5 });
    expect(observation({ price: null, currency: "USD" })).toMatchObject({
      price: null,
      availability: "unavailable",
    });
    expect(observation({ price: 0, currency: "USD" })).toMatchObject({
      price: 0,
      availability: "available",
    });
  });
});
