import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../doctor.js";

const BASE_OPTIONS = {
  baseUrl: "https://api.example.test",
  apiKey: "test-key-must-stay-redacted",
  entryPoint: process.execPath,
  runtimeVersion: "v22.0.0",
  timeoutMs: 50,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("oilpriceapi-mcp doctor", () => {
  it("checks runtime, launchability, API health, key validity, plan, and features", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "success",
          data: {
            plan: "professional",
            account: {
              usage_this_month: 20,
              effective_request_limit: 1000,
              remaining_requests: 980,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "success",
          data: {
            billing: { plan: "professional" },
            features: { webhooks: true, well_production: false },
          },
        }),
      );

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });

    expect(report.ok).toBe(true);
    expect(report.account).toEqual({
      plan: "professional",
      features: { webhooks: true, well_production: false },
      quota: {
        used: 20,
        limit: 1000,
        remaining: 980,
        percentUsed: 2,
      },
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      "runtime",
      "package-launch",
      "api-reachability",
      "api-key",
      "account",
      "feature-gates",
    ]);
    expect(JSON.stringify(report)).not.toContain(BASE_OPTIONS.apiKey);
  });

  it("warns before quota exhaustion without exposing account identity", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          account: {
            email: "must-not-appear@example.test",
            tier: "synthetic-smoke",
            usage_this_month: 850,
            effective_request_limit: 1000,
            remaining_requests: 150,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { features: { subscriptions: true } },
        }),
      );

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "account")).toMatchObject(
      {
        id: "account",
        status: "warn",
      },
    );
    expect(report.account?.quota?.percentUsed).toBe(85);
    expect(JSON.stringify(report)).not.toContain(
      "must-not-appear@example.test",
    );
  });

  it("reports a locked dashboard feature with an exact access path", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { account: { tier: "developer" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { features: { webhooks: false, subscriptions: true } },
        }),
      );

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.checks.at(-1)).toMatchObject({
      id: "feature-gates",
      status: "warn",
      message: expect.stringContaining("pricing"),
    });
    expect(report.account?.features).toEqual({
      subscriptions: true,
      webhooks: false,
    });
  });

  it("runs a bounded keyless demo check without requiring a key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "success",
          data: { prices: [{ code: "BRENT_CRUDE_USD", price: 80 }] },
        }),
      );

    const report = await runDoctor({
      ...BASE_OPTIONS,
      apiKey: undefined,
      demo: true,
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.at(-1)).toMatchObject({ id: "demo", status: "pass" });
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty(
      "Authorization",
    );
  });

  it("reports missing configuration with a working recovery action", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { status: "ok" }));
    const report = await runDoctor({
      ...BASE_OPTIONS,
      apiKey: undefined,
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({
      id: "api-key",
      status: "fail",
      recovery: expect.stringContaining("OILPRICEAPI_KEY"),
    });
  });

  it.each([
    [401, "authentication", "invalid"],
    [402, "entitlement", "pricing"],
    [403, "entitlement", "access"],
    [429, "rate-limit", "retry"],
    [503, "server", "service"],
  ])(
    "classifies HTTP %i account failures as %s",
    async (status, classification, recoveryText) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
        .mockResolvedValueOnce(jsonResponse(status, { error: "redacted" }));

      const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });
      const account = report.checks.find((check) => check.id === "account");

      expect(report.ok).toBe(false);
      expect(account).toMatchObject({ classification, status: "fail" });
      expect(account?.recovery?.toLowerCase()).toContain(recoveryText);
      expect(JSON.stringify(report)).not.toContain(BASE_OPTIONS.apiKey);
    },
  );

  it("distinguishes timeouts from DNS/TLS transport failures", async () => {
    const health = jsonResponse(200, { status: "ok" });
    const timeoutFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(health)
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"));
    const timeout = await runDoctor({
      ...BASE_OPTIONS,
      fetchImpl: timeoutFetch,
    });
    expect(timeout.checks.at(-1)).toMatchObject({
      classification: "timeout",
      status: "fail",
    });

    const dnsError = new TypeError("fetch failed") as TypeError & {
      cause?: { code: string };
    };
    dnsError.cause = { code: "ENOTFOUND" };
    const dnsFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockRejectedValueOnce(dnsError);
    const dns = await runDoctor({ ...BASE_OPTIONS, fetchImpl: dnsFetch });
    expect(dns.checks.at(-1)).toMatchObject({
      classification: "dns-tls",
      status: "fail",
    });
  });
});
