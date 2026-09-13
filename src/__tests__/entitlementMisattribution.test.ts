import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer, SIGNUP_URL } from "../index.js";

// #103 — 14 tools blame the account's entitlement for failures that have
// nothing to do with it.
//
// `makeApiRequest` returns null for a 401, a 404, a 5xx and a transport
// failure. 402/403 throw ApiGateError long before they can reach that branch,
// and a durable-quota 429 throws its own gate error (#101). So BY CONSTRUCTION
// nothing that reaches these handlers' `!response` branch can be an
// entitlement problem — which is exactly what describeRequestFailure's doc
// comment, added by #94, already says.
//
// Every envelope below is quoted verbatim from live production,
// api.oilpriceapi.com, 2026-09-13:
//
//   GET /v1/rig-counts/latest   Authorization: Bearer <invalid>   -> HTTP 401
//     {"error":{"code":"UNAUTHORIZED","message":"Missing or invalid API key.
//       Include header: Authorization: Token YOUR_API_KEY","status":401,...}}
//
//   GET /v1/rig-counts/definitely-not-a-real-path  <valid key>    -> HTTP 404
//     {"error":{"code":"NOT_FOUND","message":"No route matches GET
//       /v1/rig-counts/definitely-not-a-real-path. ...","status":404,...}}
//
// A customer with a typo'd or revoked key is the single most common failure a
// new MCP user hits. Inside an AI conversation they see neither the request
// nor the status code, so the upgrade pitch is the whole answer they get.

function errorResponse(
  status: number,
  body: string,
  statusText = "err",
): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  } as unknown as Response;
}

const UNAUTHORIZED_BODY = JSON.stringify({
  error: {
    code: "UNAUTHORIZED",
    message:
      "Missing or invalid API key. Include header: Authorization: Token YOUR_API_KEY",
    status: 401,
    request_id: "5f1ad423-ae8a-4252-be2a-2f5680e8e492",
    docs: "https://docs.oilpriceapi.com#UNAUTHORIZED",
    signup_url: "https://www.oilpriceapi.com/auth/signup",
    demo_endpoint: "/v1/demo/prices",
  },
});

const NOT_FOUND_BODY = JSON.stringify({
  error: {
    code: "NOT_FOUND",
    message:
      "No route matches GET /v1/rig-counts/definitely-not-a-real-path. Check the path and the /v1 prefix; the machine-readable contract is at https://docs.oilpriceapi.com/api-reference.",
    status: 404,
    request_id: "a3c7dd1a-d301-4a79-a7b8-4a82330fdbd1",
    docs: "https://docs.oilpriceapi.com#NOT_FOUND",
  },
});

const SERVER_ERROR_BODY = JSON.stringify({
  error: {
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    status: 503,
  },
});

interface ToolHandler {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const server = createSandboxServer();
const tools = (
  server as unknown as { _registeredTools: Record<string, ToolHandler> }
)._registeredTools;

// The exact prose #103 is about. Matching on either half keeps the test honest
// if a future edit only renames one of them.
const UPGRADE_PITCH = /entitlement|Check opa_get_plans|opa_get_plans for/i;

// Every site listed in #103, addressed by the tool call that reaches it.
// `label` is the site, not the tool: three of these tools reach the same
// message from more than one branch.
const SITES: Array<{
  label: string;
  tool: string;
  args: Record<string, unknown>;
}> = [
  {
    label: "opa_get_futures",
    tool: "opa_get_futures",
    args: { contract: "brent" },
  },
  {
    label: "opa_get_futures_curve",
    tool: "opa_get_futures_curve",
    args: { contract: "brent" },
  },
  {
    label: "opa_get_natural_gas_hubs (single hub)",
    tool: "opa_get_natural_gas_hubs",
    args: { hub: "waha" },
  },
  {
    label: "opa_get_natural_gas_hubs (index)",
    tool: "opa_get_natural_gas_hubs",
    args: {},
  },
  { label: "opa_get_marine_fuels", tool: "opa_get_marine_fuels", args: {} },
  { label: "opa_get_rig_counts", tool: "opa_get_rig_counts", args: {} },
  { label: "opa_get_drilling", tool: "opa_get_drilling", args: {} },
  {
    label: "opa_get_opec_production",
    tool: "opa_get_opec_production",
    args: {},
  },
  { label: "opa_get_forecasts", tool: "opa_get_forecasts", args: {} },
  {
    label: "opa_get_oil_inventories",
    tool: "opa_get_oil_inventories",
    args: { view: "latest" },
  },
  {
    label: "opa_get_well_permits",
    tool: "opa_get_well_permits",
    args: { view: "latest" },
  },
  {
    label: "opa_get_well_production (state)",
    tool: "opa_get_well_production",
    args: { view: "state", state: "TX" },
  },
  {
    label: "opa_get_well_production (well)",
    tool: "opa_get_well_production",
    args: { view: "well", api_number: "42329447130000" },
  },
  {
    label: "opa_get_well_production (summary)",
    tool: "opa_get_well_production",
    args: { view: "summary" },
  },
  { label: "opa_get_spread", tool: "opa_get_spread", args: { type: "crack" } },
  {
    label: "opa_get_data_quality",
    tool: "opa_get_data_quality",
    args: { commodity: "brent" },
  },
  // Same defect, same mechanism, not enumerated in #103's table.
  {
    label: "opa_get_history",
    tool: "opa_get_history",
    args: { commodity: "brent", period: "month" },
  },
];

describe("#103 — a failed request never blames the account's entitlement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stub(status: number, body: string) {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(status, body)),
    );
  }

  describe("HTTP 401 — the key is wrong, not the plan", () => {
    for (const site of SITES) {
      it(`${site.label} names authentication, not entitlement`, async () => {
        stub(401, UNAUTHORIZED_BODY);
        const result = await tools[site.tool].handler(site.args, {});
        const text = result.content[0].text;

        expect(
          text,
          `${site.label} told a customer with a bad API key that their PLAN is the problem:\n  ${text}`,
        ).not.toMatch(UPGRADE_PITCH);
        expect(text).toMatch(/authentication|401/i);
        expect(text).toContain(SIGNUP_URL);
        expect(result.isError).toBe(true);
      });
    }
  });

  describe("HTTP 404 — the dataset or path is wrong, not the plan", () => {
    for (const site of SITES) {
      it(`${site.label} names the 404, not entitlement`, async () => {
        stub(404, NOT_FOUND_BODY);
        const result = await tools[site.tool].handler(site.args, {});
        const text = result.content[0].text;

        expect(
          text,
          `${site.label} answered a 404 with an upgrade pitch:\n  ${text}`,
        ).not.toMatch(UPGRADE_PITCH);
        expect(text).toMatch(/404/);
        expect(result.isError).toBe(true);
      });
    }
  });

  it("HTTP 503 — names a server-side failure, not entitlement", async () => {
    // One representative tool: a 5xx costs three real backoff sleeps inside
    // requestApi, so this is not worth running 17 times.
    stub(503, SERVER_ERROR_BODY);
    const result = await tools.opa_get_rig_counts.handler({}, {});
    const text = result.content[0].text;

    expect(
      text,
      `a 503 was reported as an entitlement problem:\n  ${text}`,
    ).not.toMatch(UPGRADE_PITCH);
    expect(text).toMatch(/503/);
    expect(text).toMatch(/temporary server-side failure/i);
  }, 30_000);

  it("a transport failure names the transport, not entitlement", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const result = await tools.opa_get_drilling.handler({}, {});
    const text = result.content[0].text;

    expect(text).not.toMatch(UPGRADE_PITCH);
    expect(text).toMatch(/fetch failed|network or transport/i);
  }, 30_000);

  it("opa_search_well_permits reports the search failure, not entitlement", async () => {
    // The health gate must pass first, so only the SECOND call fails — this is
    // the one site reached through two requests.
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => null },
            json: async () => ({
              status: "success",
              data: {
                state: {
                  state_code: "TX",
                  status: "healthy",
                  permit_date_coverage_pct: 99,
                  record_count: 1000,
                  recommended_use: "Safe for date-filtered search.",
                },
              },
            }),
            text: async () => "",
          } as unknown as Response;
        }
        return errorResponse(404, NOT_FOUND_BODY);
      }),
    );

    const result = await tools.opa_search_well_permits.handler(
      { state: "TX", page: 1, per_page: 25 },
      {},
    );
    const text = result.content[0].text;

    expect(
      text,
      `opa_search_well_permits blamed entitlement for a 404:\n  ${text}`,
    ).not.toMatch(UPGRADE_PITCH);
    expect(text).toMatch(/404/);
  });
});
