import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiTimeoutError,
  makeApiRequest,
  makeAuthRequest,
  fetchDemoPrices,
  REQUEST_DEADLINE_MS,
  createSandboxServer,
} from "../index.js";

// #84 — every outbound API request must be bounded and cancellable.
//
// On origin/main d1a23a5 makeApiRequest, makeAuthRequest and fetchDemoPrices
// call fetch() with no AbortSignal and no timeout. A stalled upstream holds
// the tool call open forever from the application's side, which inside an MCP
// session hangs the agent with no way out. src/doctor.ts and
// src/productFacts.ts already bound their requests; the tool path did not.
//
// Everything here asserts on the wire: the init object actually handed to
// fetch, and whether that signal actually aborted.

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
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const okBody = { status: "success", data: { price: 80 } };

function okResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => okBody,
    text: async () => JSON.stringify(okBody),
  };
}

/** A fetch that respects its signal but otherwise never settles. */
function stallingFetch() {
  return vi.fn(
    (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("This operation was aborted"), {
              name: "AbortError",
            }),
          ),
        );
      }),
  );
}

/** Responds immediately, but the BODY read never settles. */
function stallingBodyFetch() {
  return vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("This operation was aborted"), {
              name: "AbortError",
            }),
          ),
        );
      }),
    text: () =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("This operation was aborted"), {
              name: "AbortError",
            }),
          ),
        );
      }),
  }));
}

describe("every request carries an AbortSignal (#84)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("REQUEST_DEADLINE_MS is a finite, sane bound", () => {
    expect(Number.isFinite(REQUEST_DEADLINE_MS)).toBe(true);
    expect(REQUEST_DEADLINE_MS).toBeGreaterThan(0);
    expect(REQUEST_DEADLINE_MS).toBeLessThanOrEqual(120_000);
  });

  it("makeApiRequest passes a signal to fetch", async () => {
    const spy = vi.fn().mockResolvedValue(okResponse());
    await makeApiRequest("/v1/prices/latest", spy as unknown as typeof fetch);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("makeAuthRequest passes a signal to fetch", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = vi.fn().mockResolvedValue(okResponse());
    await makeAuthRequest("/v1/alerts", {}, spy as unknown as typeof fetch);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchDemoPrices passes a signal to fetch", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ status: "success", data: { prices: [] } }),
    });
    await fetchDemoPrices(spy as unknown as typeof fetch);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("a stalled upstream is cut off at the deadline (#84)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("makeApiRequest gives up when the request never sends headers", async () => {
    const spy = stallingFetch();
    const promise = makeApiRequest(
      "/v1/prices/latest",
      spy as unknown as typeof fetch,
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 5_000);

    expect(await promise).toBeInstanceOf(ApiTimeoutError);
    expect(String(await promise)).toMatch(/timed out after 30s/);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(true);
  });

  it("makeApiRequest gives up when the BODY never arrives", async () => {
    const spy = stallingBodyFetch();
    const promise = makeApiRequest(
      "/v1/prices/latest",
      spy as unknown as typeof fetch,
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 5_000);

    expect(await promise).toBeInstanceOf(ApiTimeoutError);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(true);
  });

  it("makeAuthRequest gives up, and sends the write exactly once", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = stallingFetch();
    const promise = makeAuthRequest(
      "/v1/alerts",
      { method: "POST", body: { code: "BRENT_CRUDE_USD" } },
      spy as unknown as typeof fetch,
    );
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 5_000);

    await expect(promise).resolves.toEqual({
      ok: false,
      status: 0,
      body: null,
    });
    // An ambiguous write is never re-sent.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the whole retry loop is bounded, not each attempt separately", async () => {
    const spy = stallingFetch();
    const promise = makeApiRequest(
      "/v1/prices/latest",
      spy as unknown as typeof fetch,
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);

    expect(await promise).toBeInstanceOf(ApiTimeoutError);
    // Once the deadline passes there is no point trying again.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("host cancellation reaches the outbound request (#84)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("aborting the MCP handler signal aborts the fetch", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = stallingFetch();
    vi.stubGlobal("fetch", spy);

    const host = new AbortController();
    const call = tools.opa_get_price.handler(
      { commodity: "brent" },
      { signal: host.signal },
    );
    // Let the handler reach fetch.
    await Promise.resolve();
    await Promise.resolve();
    host.abort();

    await expect(call).rejects.toThrow(/cancelled before it completed/);
    const init = spy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(true);
  });

  it("a signal already aborted before the call never reaches the network", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = stallingFetch();
    vi.stubGlobal("fetch", spy);

    const host = new AbortController();
    host.abort();

    await expect(
      tools.opa_get_price.handler(
        { commodity: "brent" },
        { signal: host.signal },
      ),
    ).rejects.toThrow(/cancelled before it completed/);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a timed-out tool call reports a usable error (#84)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns isError with recovery guidance rather than hanging", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", stallingFetch());

    const call = tools.opa_get_price
      .handler({ commodity: "brent" }, {})
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 5_000);

    // The handler rejects; the MCP SDK converts a thrown handler error into
    // { content: [{ type: "text", text: error.message }], isError: true }
    // (node_modules/@modelcontextprotocol/sdk/.../server/mcp.js, createToolError
    // at the callTool catch), so this message is exactly what the model sees.
    expect(String(await call)).toMatch(
      /timed out after 30s.*not a plan or permission problem.*Retry in a moment/s,
    );
  });
});

// ---------------------------------------------------------------------------
// Interaction with #93/#94 (merged as PR #94).
//
// #93 made opa_get_storage report every requested facility that did not come
// back instead of silently dropping it. #84 makes a cut-off request THROW.
// Composed naively, a timeout on one facility discards a facility that already
// succeeded — half the answer gone, which is the exact failure #93 exists to
// prevent. These two tests pin the agreed behaviour.
// ---------------------------------------------------------------------------
describe("a deadline on one facility does not discard another (#84 x #93)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Cushing answers 200; SPR stalls until its signal aborts. */
  function splitFetch() {
    return vi.fn((url: unknown, init?: { signal?: AbortSignal }) => {
      if (new URL(String(url)).pathname === "/v1/storage/cushing") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            status: "success",
            data: { code: "CUSHING_STORAGE", value: 24_100 },
          }),
          text: async () => "{}",
        });
      }
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("This operation was aborted"), {
              name: "AbortError",
            }),
          ),
        ),
      );
    });
  }

  it("facility:'all' keeps the Cushing half and names the timeout", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", splitFetch());

    const call = tools.opa_get_storage
      .handler({ facility: "all" }, {})
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 5_000);
    const result = (await call) as ToolResult;

    expect(result.isError).toBeUndefined();
    const body = result.content.map((c) => c.text).join("\n");
    expect(body).toContain("CUSHING_STORAGE");
    expect(body).toContain("Not returned");
    expect(body).toMatch(/timed out after 30s/);
    // Still never the wrong cause.
    expect(body).not.toMatch(/entitlement/i);
  });

  it("host cancellation still propagates — no half answer for a caller who left", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", splitFetch());

    const host = new AbortController();
    const call = tools.opa_get_storage
      .handler({ facility: "all" }, { signal: host.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1);
    host.abort();
    await vi.advanceTimersByTimeAsync(1);

    expect(String(await call)).toMatch(/cancelled before it completed/);
  });
});
