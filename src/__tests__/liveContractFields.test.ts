/**
 * #118 — the live contract run asserted the envelope, never the fields a
 * formatter reads, so a field rename stayed green.
 *
 * `opa_get_rig_counts` read `oil`/`gas`/`total`/`date` while
 * `/v1/rig-counts/latest` sent `count`/`region`/`observed_at` (#115), and the
 * `success-envelope` check (`status === "success"`, `data != null`) passed the
 * whole time.
 *
 * `checkToolFields` closes that gap without a second, hand-written field list:
 * it runs the tool's REAL registered handler over the live response, records
 * every response key the handler dereferences that the response does not
 * carry, and fails — naming those keys — when the answer the handler produced
 * states an absence (`not reported`, `undefined`, `NaN`, `Invalid Date`), is an
 * error, or throws. The required fields are therefore whatever the formatter
 * reads today; there is nothing to keep in sync.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSandboxServer, NOT_REPORTED } from "../index.js";
// Plain ESM script shared with scripts/live-smoke.mjs; it ships no types.
// @ts-ignore
import { checkToolFields } from "../../scripts/live-contract-fields.mjs";

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<unknown>;

const tools = (
  createSandboxServer() as unknown as {
    _registeredTools: Record<string, { handler: Handler }>;
  }
)._registeredTools;

const API_BASE = "https://api.oilpriceapi.com";

/** Verbatim live payload, api.oilpriceapi.com/v1/rig-counts/latest, 2026-09-13. */
const LIVE_RIG_COUNT = {
  status: "success",
  data: {
    code: "US_RIG_COUNT",
    region: "United States",
    count: 588,
    currency: "COUNT",
    unit: "rigs",
    source: "market_reporting",
    created_at: "2026-08-28T18:31:33.015Z",
    collected_at: "2026-08-28T18:31:33.015Z",
    observed_at: "2026-08-28T12:00:00.000Z",
    source_date: "2026-08-28",
    formatted_date: "2026-08-28 12:00:00 UTC",
  },
};

/** Live /v1/prices/latest shape, 2026-09-13: no change_24h fields are sent. */
const LIVE_BRENT = {
  status: "success",
  data: {
    code: "BRENT_CRUDE_USD",
    price: 104.32,
    formatted: "$104.32",
    currency: "USD",
    unit: "barrel",
    type: "spot_price",
    created_at: "2026-09-13T19:21:02.000Z",
    updated_at: "2026-09-13T19:21:02.000Z",
  },
};

function served(body: unknown) {
  return { status: 200, text: JSON.stringify(body), headers: new Headers() };
}

function run(
  tool: string,
  args: Record<string, unknown>,
  contractPath: string,
  body: unknown,
  fetchImpl: typeof fetch = vi.fn().mockRejectedValue(
    new Error("unexpected extra request"),
  ),
) {
  return checkToolFields({
    tool,
    handler: tools[tool].handler,
    args,
    contractPath,
    contractResponse: served(body),
    apiBase: API_BASE,
    fetchImpl,
    notReported: NOT_REPORTED,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#118 live contract asserts the fields the formatter reads", () => {
  it("passes the live rig-count payload and reads no absent key", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const outcome = await run(
      "opa_get_rig_counts",
      {},
      "/v1/rig-counts/latest",
      LIVE_RIG_COUNT,
    );

    expect(outcome.reason).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.absentKeys).toEqual([]);
  });

  it("fails a rename, naming the key the formatter read and did not get", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const { count, ...rest } = LIVE_RIG_COUNT.data;
    const renamed = { status: "success", data: { ...rest, rig_count: count } };

    const outcome = await run(
      "opa_get_rig_counts",
      {},
      "/v1/rig-counts/latest",
      renamed,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.absentKeys).toContain("data.count");
    expect(outcome.reason).toContain("data.count");
    // The success envelope alone would have passed this response.
    expect(renamed.status).toBe("success");
  });

  it("tolerates an optional key the formatter guards and the answer never misses", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const outcome = await run(
      "opa_get_price",
      { commodity: "BRENT_CRUDE_USD" },
      "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
      LIVE_BRENT,
    );

    expect(outcome.reason).toBeUndefined();
    expect(outcome.ok).toBe(true);
    // Still visible in the results artifact, just not a failure.
    expect(outcome.absentKeys).toContain("data.change_24h");
  });

  it("does not fail a key the API sends as an explicit null", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const outcome = await run(
      "opa_get_rig_counts",
      {},
      "/v1/rig-counts/latest",
      { status: "success", data: { ...LIVE_RIG_COUNT.data, region: null } },
    );

    // "Region: not reported" is the API's own answer, not a rename.
    expect(outcome.reason).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.absentKeys).toEqual([]);
  });

  it("fails when the formatter throws on a payload missing the fields it reads", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const outcome = await run(
      "opa_get_marine_fuels",
      {},
      "/v1/marine-fuels/latest",
      { status: "success", data: { prices: [{ port_code: "AEFUJ" }] } },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/data\.prices\[\]\.\w+/);
  });

  it("fails when the handler never requests the catalog path", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(LIVE_BRENT), { status: 200 }),
      );
    const outcome = await run(
      "opa_get_price",
      { commodity: "BRENT_CRUDE_USD" },
      "/v1/prices/latest?by_code=WTI_USD",
      LIVE_BRENT,
      fetchImpl as unknown as typeof fetch,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("/v1/prices/latest?by_code=WTI_USD");
    expect(outcome.requested).toContain(
      "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
    );
  });

  it("traces secondary requests through the real fetch too", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const wti = { ...LIVE_BRENT, data: { ...LIVE_BRENT.data, code: "WTI_USD", price: 99.99 } };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "success", data: { code: "BRENT_CRUDE_USD" } }),
        { status: 200 },
      ),
    );
    const outcome = await run(
      "opa_compare_prices",
      { commodities: ["WTI_USD", "BRENT_CRUDE_USD"] },
      "/v1/prices/latest?by_code=WTI_USD",
      wti,
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The Brent record lacks price/currency: the answer degrades and the
    // secondary response's missing keys are named.
    expect(outcome.ok).toBe(false);
    expect(outcome.absentKeys).toContain("data.price");
  });

  it("fails, never passes, when a secondary request is refused", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    // A 404 is not retried, so the handler's answer is immediate: an error.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }),
      );
    const outcome = await run(
      "opa_compare_prices",
      { commodities: ["WTI_USD", "BRENT_CRUDE_USD"] },
      "/v1/prices/latest?by_code=WTI_USD",
      LIVE_BRENT,
      fetchImpl as unknown as typeof fetch,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBeTruthy();
  });
});
