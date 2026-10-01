import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = new URL(process.argv[2]);
let healthy = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    healthy = (
      await fetch(new URL("/health", url), {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {}
  if (healthy) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!healthy) throw new Error("Container health failed");
const client = new Client({ name: "internal-container-review", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { "X-OPA-Telemetry-Exclude": "1" } },
  }),
);
try {
  const tools = await client.listTools();
  if (tools.tools.length !== 7) throw new Error("Wrong tool inventory");
  const boundary = await client.callTool({
    name: "energy_futures_curve",
    arguments: { instrument: "natural-gas" },
  });
  if (
    !boundary.isError ||
    boundary.structuredContent?.outcome !== "entitlement"
  )
    throw new Error("Missing premium boundary");
  const metadata = await (
    await fetch(new URL("/.well-known/oauth-protected-resource/mcp", url))
  ).json();
  if (!metadata.resource.endsWith("/mcp"))
    throw new Error("Missing OAuth metadata");
  console.log(
    "Container health, initialization, seven-tool list, OAuth metadata and premium boundary passed.",
  );
} finally {
  await client.close();
}
