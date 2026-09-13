/**
 * #121 — `opa_get_well_activity` failed on every live call.
 *
 * The handler fetched `/v1/ei/well-permits/summary?days=N` and
 * `/v1/ei/well-permits/states` together and refused unless both succeeded.
 * Live on 2026-09-13 (api.oilpriceapi.com, enterprise smoke key):
 *
 *   summary?days=30  HTTP 200 in 3.2s
 *   states           HTTP 500 in 25.07s   (also 25.09s, 25.10s earlier)
 *   states/TX        HTTP 200 in 2.8s
 *
 * The 500 arrives at 25s, `requestApi` then retried it inside the 30s tool
 * deadline, and the deadline fired: a timeout error although the summary was
 * sitting there. Backend side: OilpriceAPI/oilpriceapi-api#5597.
 *
 * Required behaviour: answer with the summary, mark the answer partial with
 * the reason (the #113 completeness pattern), bound the /states wait well
 * inside the tool deadline, and never retry a 500 that took 25s to arrive.
 *
 * Driven through the REAL registered handler; only `fetch` is stubbed, with
 * verbatim live payloads.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer, NOT_REPORTED } from "../index.js";
// Plain ESM script shared with scripts/live-smoke.mjs; it ships no types.
// @ts-ignore
import { checkToolFields } from "../../scripts/live-contract-fields.mjs";
import {
  LIVE_WELL_PERMITS_SUMMARY_30D,
  LIVE_WELL_PERMITS_STATES_500,
  LIVE_WELL_PERMITS_STATE_TX,
} from "./fixtures/wellActivityLive.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<ToolResult>;

const registered = (
  createSandboxServer() as unknown as {
    _registeredTools: Record<string, { handler: Handler; description?: string }>;
  }
)._registeredTools;
const wellActivity = registered.opa_get_well_activity;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Route = (init?: { signal?: AbortSignal }) => Promise<Response>;

/** Route by path; count every /states request. */
function stubRoutes(routes: { summary: Route; states: Route }) {
  const calls = { summary: 0, states: 0 };
  const fetchSpy = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/ei/well-permits/summary") {
      calls.summary++;
      return routes.summary(init);
    }
    if (path === "/v1/ei/well-permits/states") {
      calls.states++;
      return routes.states(init);
    }
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
  vi.stubGlobal("fetch", fetchSpy);
  return calls;
}

/** Respects its abort signal, otherwise never settles. */
const stall: Route = (init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  });

const summaryOk: Route = async () => json(LIVE_WELL_PERMITS_SUMMARY_30D);
const states500: Route = async () => json(LIVE_WELL_PERMITS_STATES_500, 500);

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#121 opa_get_well_activity answers with the summary when /states fails", () => {
  it("returns the live summary, marked partial, when /states is HTTP 500", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.useFakeTimers();
    stubRoutes({ summary: summaryOk, states: states500 });

    const pending = wellActivity.handler({ days: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    // The summary the API returned reaches the agent.
    expect(text).toContain('"total_permits": 1520');
    expect(text).toContain('"TX": 924');
    // Visibly partial, with the reason.
    expect(text).toMatch(/^# Recent US Well Activity — 30 days \(partial/m);
    expect(text).toContain("## Not included");
    expect(text).toMatch(/\/v1\/ei\/well-permits\/states returned HTTP 500/);
    // It must never read as a clean bill of health.
    expect(text).not.toContain("All reported state-health gates are currently available");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain(NOT_REPORTED);
  });

  it("does not retry a /states 500", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.useFakeTimers();
    const calls = stubRoutes({ summary: summaryOk, states: states500 });

    const pending = wellActivity.handler({ days: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    expect(calls.states).toBe(1);
    expect(calls.summary).toBe(1);
  });

  it("stops waiting on a hung /states well inside the 30s tool deadline", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.useFakeTimers();
    stubRoutes({ summary: summaryOk, states: stall });

    let settled = false;
    const pending = wellActivity.handler({ days: 30 }, {}).then((r) => {
      settled = true;
      return r;
    });
    // Live, the 500 takes 25s to arrive. The summary must not wait for it.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(settled).toBe(true);

    const result = await pending;
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('"total_permits": 1520');
    expect(text).toMatch(/\/v1\/ei\/well-permits\/states did not answer within 10s/);
    expect(text).not.toContain("All reported state-health gates are currently available");
  });

  it("still flags non-available states when /states answers", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    // Constructed, not captured: the live /states index has not answered since
    // before this fix. Each record is the verbatim live /states/TX record.
    const tx = LIVE_WELL_PERMITS_STATE_TX.data.state;
    const statesOk = {
      status: "success",
      data: {
        states: { TX: tx, FL: { ...tx, state_code: "FL", status: "stale" } },
        meta: LIVE_WELL_PERMITS_STATE_TX.data.meta,
      },
    };
    stubRoutes({ summary: summaryOk, states: async () => json(statesOk) });

    const result = await wellActivity.handler({ days: 30 }, {});
    const text = textOf(result);

    expect(result.isError).not.toBe(true);
    expect(text).toMatch(/^# Recent US Well Activity — 30 days$/m);
    expect(text).toContain("Coverage warning: 1 state(s)");
    expect(text).toContain('"state_code": "FL"');
    expect(text).not.toContain("## Not included");
  });

  it("is an error when the summary itself cannot be loaded", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.useFakeTimers();
    stubRoutes({
      summary: async () => json(LIVE_WELL_PERMITS_STATES_500, 500),
      states: states500,
    });

    const pending = wellActivity.handler({ days: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500/);
  });
});

describe("#121 field-level live contract (#118) passes on the live responses", () => {
  it("summary served, /states answering its live 500", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchImpl = vi.fn(async () => json(LIVE_WELL_PERMITS_STATES_500, 500));

    const outcome = await checkToolFields({
      tool: "opa_get_well_activity",
      handler: wellActivity.handler,
      args: { days: 30 },
      contractPath: "/v1/ei/well-permits/summary?days=30",
      contractResponse: {
        status: 200,
        text: JSON.stringify(LIVE_WELL_PERMITS_SUMMARY_30D),
        headers: new Headers(),
      },
      apiBase: "https://api.oilpriceapi.com",
      fetchImpl,
      notReported: NOT_REPORTED,
    });

    expect(outcome.reason).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 20_000);
});
