import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #93 — opa_get_storage must report the REAL cause of a failed facility
// fetch. /v1/storage/spr is routed but unpopulated: it answers 404 with
// {"error":{"code":"NOT_FOUND","message":"SPR storage data not available"}}.
// Verified live against production 2026-09-13.

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

/** The exact 404 body production returns for /v1/storage/spr. */
const SPR_404_BODY = JSON.stringify({
  error: {
    code: "NOT_FOUND",
    message: "SPR storage data not available",
    status: 404,
    request_id: "1a5b71f0-4770-4f1a-9631-a4e753db32d3",
    docs: "https://docs.oilpriceapi.com#NOT_FOUND",
  },
});

const CUSHING_200 = {
  status: "success",
  data: { code: "CUSHING_STORAGE", value: 24_100, unit: "thousand barrels" },
};

function response(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

/** Route the stubbed fetch by pathname so both facilities can be exercised. */
function storageFetch(spr: { status: number; body: string }) {
  return vi.fn(async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/storage/cushing")
      return response(200, JSON.stringify(CUSHING_200));
    if (path === "/v1/storage/spr") return response(spr.status, spr.body);
    throw new Error(`unexpected path ${path}`);
  });
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("opa_get_storage reports the real cause of a facility failure (#93)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("facility:'spr' — a 404 must not be blamed on the account entitlement", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = storageFetch({ status: 404, body: SPR_404_BODY });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await tools.opa_get_storage.handler({ facility: "spr" }, {});
    const body = text(result);

    expect(result.isError).toBe(true);
    // The wire call actually happened against the routed path.
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(
      "/v1/storage/spr",
    );
    // The real cause, from the API's own body.
    expect(body).toContain("SPR storage data not available");
    expect(body).toContain("404");
    // The WRONG cause must be gone: this is not an entitlement problem.
    expect(body).not.toMatch(/entitlement/i);
    expect(body).not.toMatch(/opa_get_plans/i);
  });

  it("facility:'all' — a failed SPR leg must be visible, not silently omitted", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", storageFetch({ status: 404, body: SPR_404_BODY }));

    const result = await tools.opa_get_storage.handler({ facility: "all" }, {});
    const body = text(result);

    // Cushing succeeded, so this is still a successful result...
    expect(result.isError).toBeUndefined();
    expect(body).toContain("Cushing");
    // ...but the model must be told the SPR half is missing and why.
    expect(body).toMatch(/Strategic Petroleum Reserve/i);
    expect(body).toContain("SPR storage data not available");
  });

  it("a 5xx is reported as a temporary server failure, not an entitlement gate", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(503, "upstream unavailable")),
    );

    const result = await tools.opa_get_storage.handler(
      { facility: "cushing" },
      {},
    );
    const body = text(result);

    expect(result.isError).toBe(true);
    expect(body).toContain("503");
    expect(body).not.toMatch(/entitlement/i);
  }, 30000);

  it("a 401 is reported as an authentication failure, not an entitlement gate", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "bad-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          401,
          JSON.stringify({ error: { message: "Invalid API key" } }),
        ),
      ),
    );

    const result = await tools.opa_get_storage.handler(
      { facility: "cushing" },
      {},
    );
    const body = text(result);

    expect(result.isError).toBe(true);
    expect(body).toMatch(/authenticat/i);
    expect(body).not.toMatch(/entitlement/i);
  });

  it("a real 402 entitlement gate still surfaces the upgrade path", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          402,
          JSON.stringify({
            error: { message: "Energy intelligence is not on this plan" },
          }),
        ),
      ),
    );

    await expect(
      tools.opa_get_storage.handler({ facility: "cushing" }, {}),
    ).rejects.toThrow(/Energy intelligence is not on this plan/);
  });
});
