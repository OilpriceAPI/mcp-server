import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeApiRequest, ApiGateError } from "../index.js";

// #86 — retry policy for 429.
//
// Two defects in makeApiRequest, both verified against origin/main d1a23a5:
//
// 1. Durable quota exhaustion is retried. A 429 saying "Monthly request limit
//    of 200 reached" is sent four times. None of those can succeed — the
//    window does not reopen for days — and with backoff the tool call can sit
//    for minutes inside an MCP session before failing anyway.
//
// 2. Retry-After is parsed with parseInt() only. RFC 9110 permits the
//    HTTP-date form, which parseInt() turns into NaN; Math.min(NaN, 60) is
//    NaN, and setTimeout(fn, NaN) fires in 1ms (Node: "TimeoutNaNWarning: NaN
//    is not a number. Timeout duration was set to 1."). A negative value
//    behaves identically. Either way the backoff vanishes and the server is
//    hit four times in a row.
//
// The existing 60-second clamp on integer Retry-After is CORRECT and must be
// preserved — the uncapped-sleep defect described for the Go SDK does not
// exist here.

function res(status: number, headers: Record<string, string> = {}, body = "") {
  return {
    ok: false,
    status,
    statusText: "err",
    headers: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  };
}

// Production's actual envelope is nested under "error". Extracting the
// message out of that shape is fixed separately in #93/#94; durability is
// classified against the raw body, so it works either way.
const MONTHLY_NESTED = JSON.stringify({
  error: { message: "Monthly request limit of 200 reached" },
});
const MONTHLY_FLAT = JSON.stringify({
  message: "Monthly request limit of 200 reached",
});
const BURST = JSON.stringify({
  error: { message: "Too many requests in a short burst, slow down" },
});

describe("durable quota exhaustion is not retried (#86)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function call(mockFetch: typeof fetch) {
    const p = makeApiRequest("/v1/prices/latest", mockFetch).catch(
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    return p;
  }

  it("a monthly-quota 429 is requested exactly once", async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(429, {}, MONTHLY_NESTED));

    const error = await call(mockFetch as unknown as typeof fetch);

    expect(error).toBeInstanceOf(ApiGateError);
    expect((error as ApiGateError).status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("the API's own limit text survives the no-retry path", async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(429, {}, MONTHLY_FLAT));

    const error = await call(mockFetch as unknown as typeof fetch);

    expect((error as ApiGateError).message).toContain(
      "Monthly request limit of 200 reached",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a Retry-After longer than the retry budget is treated as durable, one call", async () => {
    // The keyless demo has been observed answering retry-after: 31612
    // (~8.8 hours). Sleeping that inside a tool call is never correct.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, { "Retry-After": "31612" }, "{}"));

    const error = await call(mockFetch as unknown as typeof fetch);

    expect(error).toBeInstanceOf(ApiGateError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The user is told when it actually resets, not just to upgrade.
    expect((error as ApiGateError).message).toMatch(/8h|8 h|hour/i);
  });

  it("a burst 429 still recovers on retry", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(res(429, { "Retry-After": "2" }, BURST))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ status: "success", data: { price: 80 } }),
      });

    const result = await call(mockFetch as unknown as typeof fetch);

    expect(result).toEqual({ status: "success", data: { price: 80 } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Retry-After parsing is bounded and never collapses to no wait (#86)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Record the delay handed to every setTimeout during the call. */
  async function delaysFor(mockFetch: typeof fetch): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      delays.push(Number(ms));
      return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(
        fn,
        ms,
        ...rest,
      );
    }) as unknown as typeof setTimeout);

    const p = makeApiRequest("/v1/prices/latest", mockFetch).catch(() => null);
    await vi.runAllTimersAsync();
    await p;
    spy.mockRestore();
    return delays;
  }

  it("an HTTP-date Retry-After produces a real wait, not a 1ms NaN timer", async () => {
    // RFC 9110 permits this form. parseInt() returns NaN for it.
    const mockFetch = vi.fn().mockResolvedValue(
      res(
        429,
        { "Retry-After": "Sun, 13 Sep 2026 12:00:05 GMT" },
        BURST, // transient, so it is allowed to retry
      ),
    );

    const delays = await delaysFor(mockFetch as unknown as typeof fetch);

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it("a negative Retry-After does not produce a negative or 1ms timer", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, { "Retry-After": "-30" }, BURST));

    const delays = await delaysFor(mockFetch as unknown as typeof fetch);

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it("a garbage Retry-After falls back to exponential backoff", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, { "Retry-After": "soon-ish" }, BURST));

    const delays = await delaysFor(mockFetch as unknown as typeof fetch);

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it("an integer Retry-After inside the budget is still honoured and still clamped", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, { "Retry-After": "5" }, BURST));

    const delays = await delaysFor(mockFetch as unknown as typeof fetch);

    expect(delays[0]).toBe(5000);
    for (const d of delays) expect(d).toBeLessThanOrEqual(60_000);
  });

  it("a 5xx with a huge Retry-After is still bounded by the retry budget", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(503, { "Retry-After": "31612" }, ""));

    const delays = await delaysFor(mockFetch as unknown as typeof fetch);

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(60_000);
  });
});
