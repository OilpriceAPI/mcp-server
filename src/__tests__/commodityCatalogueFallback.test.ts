/**
 * #85 — `opa_list_commodities` fell back to a hardcoded 19-entry list whenever
 * the live catalogue call failed OR came back empty, and returned it as a
 * SUCCESS result under the heading "# Available Commodities".
 *
 * The tool's stated job is "list the account-visible commodities returned by
 * the live API". A static list is not that: it is not account-scoped, it is 19
 * of the 604 codes production actually serves (verified live 2026-09-13), and
 * on a valid-but-empty catalogue its "the catalog endpoint was unreachable"
 * footer is itself untrue. This is the fabricate-rather-than-fail class.
 *
 * Assertions are on the rendered tool output, driven through the real
 * registered handler with a stubbed `fetch`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

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

function stub(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => text,
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** Codes only the static fallback could have produced. */
const STATIC_MARKERS = [
  "Brent Crude (global benchmark)",
  "West Texas Intermediate (US benchmark)",
  "LBMA Silver Fix",
];

function containsStaticList(text: string): boolean {
  return STATIC_MARKERS.some((m) => text.includes(m));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#85 opa_list_commodities never substitutes a static catalogue", () => {
  it("401 (revoked or typo'd key) fails instead of listing 19 invented codes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "revoked-key");
    stub(401, { error: "unauthorized" });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/401|authentic/i);
  });

  it("404 fails instead of listing 19 invented codes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub(404, { error: "not_found" });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("503 fails instead of listing 19 invented codes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub(503, { error: "unavailable" });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(result.isError).toBe(true);
    // 503 and transport errors go through requestApi's retry budget, so these
    // two need more than the default 5s test timeout.
  }, 20000);

  it("a network failure fails instead of listing 19 invented codes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(result.isError).toBe(true);
  }, 20000);

  it("a malformed envelope fails instead of listing 19 invented codes", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub(200, { status: "success", data: { unexpected: true } });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("a VALID EMPTY catalogue is reported as empty, not as 19 commodities", async () => {
    // The worst case: the API answered perfectly and this account can see
    // nothing. The old code printed 19 commodities AND a footer claiming the
    // catalog endpoint was unreachable — both untrue.
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub(200, { status: "success", data: { commodities: [] } });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(containsStaticList(text)).toBe(false);
    expect(text).not.toMatch(/unreachable/i);
    expect(text).toMatch(/no commodities|empty|none/i);
  });

  it("a real account catalogue is still rendered unchanged", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    stub(200, {
      status: "success",
      data: {
        commodities: [
          {
            code: "BRENT_CRUDE_USD",
            name: "Brent Crude",
            category: "Crude Oil",
            currency: "USD",
          },
          {
            code: "DUTCH_TTF_EUR",
            name: "Dutch TTF",
            category: "Natural Gas",
            currency: "EUR",
          },
        ],
      },
    });

    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("# Available Commodities (2 total)");
    expect(text).toContain("`BRENT_CRUDE_USD` — Brent Crude");
    expect(text).toContain("## Natural Gas");
  });

  it("the deliberate keyless demo mode is untouched", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const result = await tools.opa_list_commodities.handler({}, {});
    const text = textOf(result);

    // Keyless demo is a reviewed, clearly-labelled surface — not a fallback.
    expect(text.length).toBeGreaterThan(0);
    expect(containsStaticList(text)).toBe(false);
  });
});
