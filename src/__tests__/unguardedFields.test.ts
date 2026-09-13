/**
 * #105 — unguarded fields rendered to an agent as though they were data.
 *
 * Every assertion here is on the RENDERED tool output an agent receives, driven
 * through the real registered handler with a stubbed `fetch`. The governing
 * rule: an incomplete answer that says it is incomplete is recoverable; a
 * confident wrong one is not. So a missing field must never be printed as
 * `undefined`, as `Invalid Date`, or silently replaced by the caller's own
 * input.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer, formatPrice } from "../index.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<ToolResult>;

const server = createSandboxServer();
const tools = (
  server as unknown as {
    _registeredTools: Record<string, { handler: Handler }>;
  }
)._registeredTools;

function stubJson(body: unknown) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    // makeApiRequest uses .json(); makeAuthRequest uses .text().
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#105.1 opa_get_subscription_events never hands back the caller's own cursor", () => {
  it("does not echo `since` as the next cursor when the API omits one", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      status: "success",
      data: {
        // no `cursor` key — the field the whole poll loop depends on
        events: [
          {
            id: "e1",
            seq: 42,
            watch_id: "w1",
            observed_at: "2026-09-13T10:00:00Z",
            snapshot: { price: 66.2 },
            deltas: {},
          },
        ],
      },
    });

    const result = await tools.opa_get_subscription_events.handler(
      { since: 41 },
      {},
    );
    const text = textOf(result);

    // The bug: "**Next cursor**: `41`" — re-polling with 41 replays event 42
    // forever and the agent reports each replay as new.
    expect(text).not.toContain("**Next cursor**: `41`");
    // The gap must be stated, not filled.
    expect(text).toMatch(/cursor/i);
    expect(text).toMatch(/not returned|unavailable|did not return/i);
    // The events themselves are still delivered.
    expect(text).toContain("seq 42");
  });

  it("does not claim a cursor of 0 when none was returned and none was sent", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({ status: "success", data: { events: [] } });

    const result = await tools.opa_get_subscription_events.handler({}, {});
    const text = textOf(result);

    expect(text).not.toMatch(/Cursor is 0\./);
    expect(text).toMatch(/not returned|unavailable|did not return/i);
  });
});

describe("#105.2 opa_get_alert_triggers does not report 'no triggers' for a triggered alert", () => {
  const triggeredButUndated = [
    {
      id: "a1",
      name: "Brent below 60",
      commodity_code: "BRENT_CRUDE_USD",
      condition_operator: "<",
      condition_value: 60,
      trigger_count: 4,
      last_triggered_at: null,
    },
  ];

  it("does not print the success text 'No price alerts have triggered since ...'", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(triggeredButUndated);

    const result = await tools.opa_get_alert_triggers.handler(
      { since: "2026-09-01" },
      {},
    );
    const text = textOf(result);

    expect(text).not.toContain("No price alerts have triggered since");
    // It must surface that something triggered but cannot be placed in the window.
    expect(text).toContain("Brent below 60");
    expect(text).toMatch(/4 trigger/);
  });

  it("never renders 'last at undefined' or 'last at null'", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson(triggeredButUndated);

    const result = await tools.opa_get_alert_triggers.handler({}, {});
    const text = textOf(result);

    expect(text).not.toMatch(/last at undefined/);
    expect(text).not.toMatch(/last at null/);
    expect(text).toMatch(/not reported/i);
  });
});

describe("#105.3 no `undefined` interpolated into data tables", () => {
  it("opa_get_marine_fuels: a price with no currency or unit is not rendered as a bare number", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      status: "success",
      data: {
        prices: [
          { port: "SINGAPORE", fuel_type: "VLSFO", price: 512.5 },
          // currency and unit absent
        ],
      },
    });

    const result = await tools.opa_get_marine_fuels.handler({}, {});
    const text = textOf(result);

    expect(text).not.toContain("undefined");
    expect(text).toMatch(/not reported/i);
  });

  it("opa_get_rig_counts: absent counts are not printed as undefined", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      status: "success",
      data: { oil: 480, date: "2026-09-12" },
    });

    const result = await tools.opa_get_rig_counts.handler({}, {});
    const text = textOf(result);

    expect(text).not.toContain("undefined");
    expect(text).toMatch(/not reported/i);
    expect(text).toContain("480");
  });

  it("opa_get_futures: a front month with no contract_month is not titled '(undefined)'", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      contracts: [{ last_price: 66.2, currency: "USD" }],
    });

    const result = await tools.opa_get_futures.handler(
      { contract: "brent" },
      {},
    );
    const text = textOf(result);

    expect(text).not.toContain("undefined");
    expect(text).toMatch(/not reported/i);
  });

  it("opa_get_well_production summary: a top state with no name or period is not '**undefined** (undefined)'", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      status: "success",
      data: {
        top_states: [{ oil_bbl: 150000000 }],
      },
    });

    const result = await tools.opa_get_well_production.handler(
      { view: "summary" },
      {},
    );
    const text = textOf(result);

    expect(text).not.toContain("undefined");
    expect(text).toMatch(/not reported/i);
  });
});

describe("#105.4 an unparseable timestamp is never rendered as 'Invalid Date'", () => {
  it("formatPrice states the gap instead of printing Invalid Date", () => {
    const text = formatPrice({
      code: "BRENT_CRUDE_USD",
      price: 66.2,
      currency: "USD",
      updated_at: "not-a-timestamp",
    } as Parameters<typeof formatPrice>[0]);

    expect(text).not.toContain("Invalid Date");
    expect(text).toMatch(/not-a-timestamp/);
  });

  it("opa_get_diesel_by_state states the gap instead of printing Invalid Date", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stubJson({
      status: "success",
      data: { price: 3.712, state: "TX", updated_at: "13/09/2026" },
    });

    const result = await tools.opa_get_diesel_by_state.handler(
      { state: "TX" },
      {},
    );
    const text = textOf(result);

    expect(text).not.toContain("Invalid Date");
  });
});
