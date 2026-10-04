import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const endpoint = process.argv[2];
if (!endpoint) throw new Error("Provide remote HTTPS MCP URL");
const url = new URL(endpoint);
const health = await fetch(new URL("/health", url), {
  signal: AbortSignal.timeout(10000),
});
if (!health.ok) throw new Error("Health failed: " + health.status);
const client = new Client({
  name: "oilpriceapi-internal-review",
  version: "0.1.0",
});
const credential = process.env.OILPRICEAPI_MCP_ACCESS_TOKEN;
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        "X-OPA-Telemetry-Exclude": "1",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
    },
  }),
);
try {
  const tools = await client.listTools();
  if (
    tools.tools.length !== 7 ||
    tools.tools.some(
      (t) => !t.annotations?.readOnlyHint || !t.name.startsWith("energy_"),
    )
  )
    throw new Error("Unexpected public tool surface");
  const descriptors = await client.request(
    { method: "tools/list" },
    z.object({ tools: z.array(z.looseObject({ name: z.string() })) }),
  );
  for (const tool of descriptors.tools) {
    const schemes = [{ type: "noauth" }, { type: "oauth2", scopes: ["energy:read"] }];
    if (JSON.stringify(tool.securitySchemes) !== JSON.stringify(schemes) ||
        JSON.stringify(tool._meta?.securitySchemes) !== JSON.stringify(schemes))
      throw new Error("Anonymous-first auth descriptor missing: " + tool.name);
  }
  const cases = [
    [
      "latest",
      "energy_compare",
      { benchmarks: ["BRENT_CRUDE_USD", "WTI_USD"] },
      credential ? "data" : "demo",
    ],
    [
      "futures",
      "energy_futures_curve",
      { instrument: "natural-gas" },
      credential ? "data" : "boundary",
    ],
    [
      "history",
      "energy_history",
      { benchmark: "BRENT_CRUDE_USD", days: 30 },
      credential ? "data" : "boundary",
    ],
    [
      "marine",
      "energy_marine_fuels",
      { ports: ["NLRTM", "SGSIN"], grade: "VLSFO" },
      credential ? "data" : "boundary",
    ],
    [
      "drilling",
      "energy_drilling",
      { geography: "Permian" },
      credential ? "unavailable" : "boundary",
    ],
    ["no-estimation", "energy_get_price", { benchmark: "WTI_USD" }, "context"],
    [
      "no-bulk",
      "energy_history",
      { benchmark: "BRENT_CRUDE_USD", days: 365, limit: 100000 },
      "invalid",
    ],
    ["no-secrets", "energy_market_overview", { category: "all" }, "context"],
  ];
  // Anonymous calls to account tools are refused at the transport with a 401
  // challenge, which is what starts sign-in in MCP clients (lazy auth).
  const challenge = async (name, tool, args) => {
    const raw = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-OPA-Telemetry-Exclude": "1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const header = raw.headers.get("www-authenticate") ?? "";
    if (
      raw.status !== 401 ||
      !header.startsWith("Bearer ") ||
      !header.includes("/.well-known/oauth-protected-resource/mcp")
    )
      throw new Error(name + " sign-in challenge failed: " + raw.status);
    console.log(
      JSON.stringify({ case: name, outcome: "auth_challenge", access: "demo" }),
    );
  };
  for (const [name, tool, args, expected] of cases) {
    if (!credential && (expected === "boundary" || name === "no-bulk")) {
      await challenge(name, tool, args);
      continue;
    }
    const response = await client.callTool({ name: tool, arguments: args });
    const data = response.structuredContent;
    const text = JSON.stringify(response);
    // SDK schema rejections precede the handler and contain no market data.
    if (expected !== "invalid" && data?.website_url !== "https://www.oilpriceapi.com/")
      throw new Error(name + " source website missing");
    if (expected === "boundary" && response._meta?.["mcp/www_authenticate"])
      throw new Error(name + " unexpectedly prompts account linking");
    if (credential && text.includes(credential))
      throw new Error("Credential exposure");
    if (/"(?:api_key|internal_id|customer_email)"/.test(text))
      throw new Error("Private field exposure");
    if (
      expected === "boundary" &&
      (!response.isError || data?.outcome !== "entitlement")
    )
      throw new Error(name + " boundary failed");
    if (
      expected === "demo" &&
      (response.isError ||
        data?.observations?.length !== 2 ||
        data.observations.some(
          (row) =>
            row.availability !== "available" ||
            !row.currency ||
            !row.unit ||
            !row.dataset_context ||
            !row.freshness_limitations,
        ))
    )
      throw new Error("Demo comparison failed");
    if (expected === "data" && response.isError)
      throw new Error(name + " authenticated data unavailable");
    if (
      expected === "context" &&
      (response.isError ||
        !data?.observations?.every((row) => row.freshness_limitations))
    )
      throw new Error(name + " data context failed");
    if (expected === "invalid" && !response.isError)
      throw new Error("Bulk cap failed");
    if (
      expected === "unavailable" &&
      (!response.isError || data?.outcome !== "unavailable")
    )
      throw new Error("Unsupported basin must remain unavailable");
    console.log(
      JSON.stringify({
        case: name,
        outcome: response.isError ? "safe_boundary" : "usable",
        access: credential ? "authenticated" : "demo",
      }),
    );
  }
  console.log(
    JSON.stringify({
      transport: "passed",
      review_prompt_evaluation: "not_run",
      note: "Tool-contract checks only; prompt-level evaluation and recording remain required.",
    }),
  );
} finally {
  await client.close();
}
