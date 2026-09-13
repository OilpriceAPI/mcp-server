import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeApiRequest,
  ApiGateError,
  classifyRateLimit,
  UPGRADE_URL,
} from "../index.js";

// #101 — DURABLE_QUOTA_PATTERN (added by #96) matched the word "quota" in a
// human-readable message and classified a transient, explicitly-retryable 429
// as durable quota exhaustion: thrown after a single fetch, with upgrade copy.
//
// Every envelope below is quoted verbatim from oilpriceapi-api origin/main:
//
//   render_enforcement_check_failure   base_controller.rb:1893-1910
//     headers  X-RateLimit-Window: enforcement_check
//              X-RateLimit-State:  unavailable
//              (Retry-After and X-RateLimit-Reset are DELETED)
//     body     error_code "RATE_LIMIT_CHECK_FAILED",
//              block_reason "enforcement_check_failed",
//              recovery.action "retry"
//     comment directly above it (base_controller.rb:1337-1339):
//       "Enforcement lookup failures are operational failures, not customer
//        exhaustion."
//
//   hourly_rate_limit_payload          base_controller.rb:1841-1866
//     headers  X-RateLimit-Window: hourly_circuit_breaker
//              X-RateLimit-State:  exhausted
//     body     error_code "HOURLY_CIRCUIT_BREAKER_EXCEEDED",
//              block_reason "hourly_circuit_breaker",
//              entitlement.sources.limit "RequestLimitPolicy(trial)" for a
//              trial account — the parenthesis gives \btrial\b a word boundary,
//              which is what made the old pattern match.
//
//   render_rate_limit_exceeded         base_controller.rb:1454-1473, :1379
//     headers  X-RateLimit-Window: monthly_counter | daily_counter
//                                | trial_counter          (Snapshot#usage_window)
//              X-RateLimit-State:  exhausted
//     body     error_code "MONTHLY_QUOTA_EXCEEDED" | "TRIAL_LIMIT_EXCEEDED" | ...
//              block_reason "request_limit_exceeded" | "trial_limit_exceeded"
//
// The node SDK already classifies off these headers and gets both cases right
// (oilpriceapi-node src/client.ts:59-113), requiring BOTH state "exhausted"
// AND a counter window, and failing OPEN when the headers are absent.

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

const ENFORCEMENT_HEADERS = {
  "X-RateLimit-Window": "enforcement_check",
  "X-RateLimit-State": "unavailable",
};
const ENFORCEMENT_BODY = JSON.stringify({
  error: "Rate limit check unavailable",
  error_code: "RATE_LIMIT_CHECK_FAILED",
  block_reason: "enforcement_check_failed",
  message:
    "We couldn't safely verify your current quota. Retry shortly and contact support if the problem continues.",
  recovery: { action: "retry", support_email: "karl@oilpriceapi.com" },
});

const HOURLY_HEADERS = {
  "X-RateLimit-Window": "hourly_circuit_breaker",
  "X-RateLimit-State": "exhausted",
};
const HOURLY_BODY = JSON.stringify({
  error: "Hourly safety limit exceeded",
  error_code: "HOURLY_CIRCUIT_BREAKER_EXCEEDED",
  block_reason: "hourly_circuit_breaker",
  message:
    "This API key exceeded the hourly safety limit. Retry after 2026-09-13T18:00:00Z.",
  entitlement: {
    state: "trial_active",
    sources: {
      limit: "RequestLimitPolicy(trial)",
      usage: "RequestCountPolicy",
    },
  },
});

const MONTHLY_HEADERS = {
  "X-RateLimit-Window": "monthly_counter",
  "X-RateLimit-State": "exhausted",
};
const MONTHLY_BODY = JSON.stringify({
  error: "Monthly request limit exceeded",
  error_code: "MONTHLY_QUOTA_EXCEEDED",
  block_reason: "request_limit_exceeded",
  message: "You've used all 200 requests for Free tier this month",
});

const TRIAL_HEADERS = {
  "X-RateLimit-Window": "trial_counter",
  "X-RateLimit-State": "exhausted",
};
const TRIAL_BODY = JSON.stringify({
  error: "Trial request limit exceeded",
  error_code: "TRIAL_LIMIT_EXCEEDED",
  block_reason: "trial_limit_exceeded",
  message: "You've hit your 1,000 trial request limit.",
});

// A plain burst 429 with nothing structured to go on.
const BURST_BODY = JSON.stringify({
  error: { message: "Too many requests in a short burst, slow down" },
});

describe("classifyRateLimit reads the structured signal, not prose (#101)", () => {
  it("enforcement_check_failed is transient, despite the word 'quota'", () => {
    expect(classifyRateLimit(ENFORCEMENT_HEADERS, ENFORCEMENT_BODY).kind).toBe(
      "transient",
    );
  });

  it("the hourly circuit breaker is transient, despite state 'exhausted'", () => {
    expect(classifyRateLimit(HOURLY_HEADERS, HOURLY_BODY).kind).toBe(
      "transient",
    );
  });

  it("a monthly counter at 'exhausted' is durable", () => {
    expect(classifyRateLimit(MONTHLY_HEADERS, MONTHLY_BODY).kind).toBe(
      "durable_quota",
    );
  });

  it("a trial counter at 'exhausted' is durable", () => {
    expect(classifyRateLimit(TRIAL_HEADERS, TRIAL_BODY).kind).toBe(
      "durable_quota",
    );
  });

  it("fails OPEN: unknown headers never turn a burst into a hard failure", () => {
    expect(classifyRateLimit({}, BURST_BODY).kind).toBe("transient");
    expect(
      classifyRateLimit({ "X-RateLimit-State": "something_new" }, "{}").kind,
    ).toBe("transient");
    expect(classifyRateLimit({}, "").kind).toBe("transient");
    expect(classifyRateLimit({}, "<html>502</html>").kind).toBe("transient");
  });

  it("falls back to the body's structured fields when headers are absent", () => {
    // base_controller.rb's degraded rescue path renders the body without the
    // header contract. block_reason / error_code still say what happened.
    expect(classifyRateLimit({}, MONTHLY_BODY).kind).toBe("durable_quota");
    expect(classifyRateLimit({}, ENFORCEMENT_BODY).kind).toBe("transient");
    expect(classifyRateLimit({}, HOURLY_BODY).kind).toBe("transient");
  });

  it("never classifies on prose alone", () => {
    // The exact shape that produced the bug: the word "quota" in a message,
    // nothing structured saying the allowance is gone.
    const prose = JSON.stringify({
      message: "We couldn't safely verify your current quota.",
    });
    expect(classifyRateLimit({}, prose).kind).toBe("transient");
  });
});

describe("a transient 429 is retried and never sells an upgrade (#101)", () => {
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

  it("enforcement_check_failed is retried, not thrown after one fetch", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, ENFORCEMENT_HEADERS, ENFORCEMENT_BODY));

    await call(mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("enforcement_check_failed recovers when the next attempt succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(res(429, ENFORCEMENT_HEADERS, ENFORCEMENT_BODY))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ status: "success", data: { price: 104.32 } }),
      });

    const result = await call(mockFetch as unknown as typeof fetch);

    expect(result).toEqual({ status: "success", data: { price: 104.32 } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("enforcement_check_failed never renders upgrade copy", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, ENFORCEMENT_HEADERS, ENFORCEMENT_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(error).toBeInstanceOf(ApiGateError);
    expect(error.message).not.toContain(UPGRADE_URL);
    expect(error.message).not.toContain("Upgrade");
    expect(error.message).not.toContain("the plan's request limit was hit");
    // The customer needs to know it was a server-side check, not their limit.
    expect(error.message).toMatch(/could not (be )?verif|check unavailable/i);
  });

  it("the hourly circuit breaker is retried and never sells an upgrade", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, HOURLY_HEADERS, HOURLY_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(error.message).not.toContain(UPGRADE_URL);
  });

  it("a plain burst 429 is retried and never sells an upgrade", async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(429, {}, BURST_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(error.message).not.toContain(UPGRADE_URL);
  });

  it("a Retry-After beyond the retry budget stops retrying WITHOUT upgrade copy", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, { "Retry-After": "31612" }, BURST_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(error.message).toMatch(/8h|hour/i);
    expect(error.message).not.toContain(UPGRADE_URL);
  });
});

describe("real quota exhaustion still stops immediately and still upgrades", () => {
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

  it("a monthly-counter 429 is requested exactly once, with the upgrade link", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, MONTHLY_HEADERS, MONTHLY_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(error.status).toBe(429);
    expect(error.message).toContain(UPGRADE_URL);
    expect(error.message).toContain(
      "You've used all 200 requests for Free tier this month",
    );
  });

  it("a trial-counter 429 is requested exactly once, with the upgrade link", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(res(429, TRIAL_HEADERS, TRIAL_BODY));

    const error = (await call(
      mockFetch as unknown as typeof fetch,
    )) as ApiGateError;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(error.message).toContain(UPGRADE_URL);
  });
});
