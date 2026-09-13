/**
 * #109 — `alertHttpError` sold an upgrade on every 429, including the two the
 * API itself labels as operational.
 *
 * #101 (PR #108) fixed this inside `makeApiRequest` by reading the API's own
 * `X-RateLimit-*` headers and the structured `block_reason` / `error` enums
 * rather than matching prose. `alertHttpError` — the error renderer for the
 * alert and subscription tools — was out of that scope and kept the blanket
 * nudge. This file holds it to the same contract.
 *
 * Assertions are on the rendered tool output an agent receives, driven through
 * the real registered handlers with a stubbed `fetch`, plus direct assertions
 * on the renderer for the envelopes quoted in the issue.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createSandboxServer,
  alertHttpError,
  makeAuthRequest,
  UPGRADE_URL,
} from "../index.js";

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

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/** A 429 response with the headers and body the API actually sends. */
function stub429(headers: Record<string, string>, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: false,
    status: 429,
    headers: {
      get: (name: string) =>
        Object.entries(headers).find(
          ([k]) => k.toLowerCase() === name.toLowerCase(),
        )?.[1] ?? null,
    },
    json: async () => (typeof body === "string" ? {} : body),
    text: async () => text,
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

// Envelopes quoted verbatim from oilpriceapi-api base_controller.rb in #109.
const ENFORCEMENT_CHECK_FAILED = {
  headers: {
    "X-RateLimit-Window": "enforcement_check",
    "X-RateLimit-State": "unavailable",
  },
  body: {
    error: "enforcement_check_failed",
    block_reason: "enforcement_check_failed",
    message: "Rate limit check temporarily unavailable.",
    recovery: { action: "retry" },
  },
};

const HOURLY_CIRCUIT_BREAKER = {
  headers: {
    "X-RateLimit-Window": "hourly_circuit_breaker",
    "X-RateLimit-State": "exhausted",
  },
  body: {
    error: "hourly_circuit_breaker",
    block_reason: "hourly_circuit_breaker",
    message: "Hourly request ceiling reached.",
  },
};

// Durable exhaustion uses the API's real enum values: the window is
// "monthly_counter" (DURABLE_QUOTA_WINDOWS) and block_reason is
// "request_limit_exceeded" (DURABLE_BLOCK_REASONS).
const DURABLE_MONTHLY_QUOTA = {
  headers: {
    "X-RateLimit-Window": "monthly_counter",
    "X-RateLimit-State": "exhausted",
  },
  body: {
    error: "MONTHLY_QUOTA_EXCEEDED",
    block_reason: "request_limit_exceeded",
    message: "Rate limit exceeded: 200 requests/month",
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#109 alertHttpError does not sell an upgrade on an operational 429", () => {
  it("enforcement_check_failed carries no upgrade copy", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub429(ENFORCEMENT_CHECK_FAILED.headers, ENFORCEMENT_CHECK_FAILED.body);
    const result = await makeAuthRequest("/v1/alerts");

    const msg = alertHttpError(result, "fetch alert triggers");
    expect(msg).not.toContain(UPGRADE_URL);
    expect(msg).not.toMatch(/compare plans/i);
    // It must say what it actually is.
    expect(msg).toMatch(/not a plan limit|check failure|retry/i);
  });

  it("hourly_circuit_breaker carries no upgrade copy", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub429(HOURLY_CIRCUIT_BREAKER.headers, HOURLY_CIRCUIT_BREAKER.body);
    const result = await makeAuthRequest("/v1/alerts");

    const msg = alertHttpError(result, "create the price subscription");
    expect(msg).not.toContain(UPGRADE_URL);
    expect(msg).toMatch(/burst|short-window|not a plan quota/i);
  });

  it("genuine durable quota exhaustion KEEPS the upgrade nudge", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub429(DURABLE_MONTHLY_QUOTA.headers, DURABLE_MONTHLY_QUOTA.body);
    const result = await makeAuthRequest("/v1/alerts");

    const msg = alertHttpError(result, "fetch alert triggers");
    expect(msg).toContain(UPGRADE_URL);
    expect(msg).toContain("Rate limit exceeded: 200 requests/month");
  });

  it("402 and 403 keep the nudge — those are genuine plan gates", () => {
    expect(
      alertHttpError(
        { ok: false, status: 403, body: { error: "plan_gate" } },
        "x",
      ),
    ).toContain(UPGRADE_URL);
    expect(
      alertHttpError(
        { ok: false, status: 402, body: { error: "payment" } },
        "x",
      ),
    ).toContain(UPGRADE_URL);
  });

  it("a 429 with no rate-limit contract at all fails open to transient", () => {
    // An unknown signal must never be escalated into an upgrade pitch (#108's
    // fail-open rule).
    const msg = alertHttpError(
      { ok: false, status: 429, body: { message: "Slow down." } },
      "fetch alert triggers",
    );
    expect(msg).not.toContain(UPGRADE_URL);
  });
});

describe("#109 end-to-end through a registered alert tool", () => {
  it("opa_get_alert_triggers renders no upgrade pitch for enforcement_check_failed", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub429(ENFORCEMENT_CHECK_FAILED.headers, ENFORCEMENT_CHECK_FAILED.body);

    const result = await tools.opa_get_alert_triggers.handler({}, {});
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).not.toContain(UPGRADE_URL);
    expect(text).not.toMatch(/compare plans/i);
  });

  it("opa_list_price_alerts renders no upgrade pitch for hourly_circuit_breaker", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub429(HOURLY_CIRCUIT_BREAKER.headers, HOURLY_CIRCUIT_BREAKER.body);

    const result = await tools.opa_list_price_alerts.handler({}, {});
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).not.toContain(UPGRADE_URL);
  });
});
