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
  if (tools.tools.length !== 9) throw new Error("Wrong tool inventory");
  // Anonymous account-tool calls get a 401 sign-in challenge (lazy auth).
  const boundary = await fetch(url, {
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
      params: {
        name: "energy_futures_curve",
        arguments: { instrument: "natural-gas" },
      },
    }),
  });
  if (
    boundary.status !== 401 ||
    !boundary.headers
      .get("www-authenticate")
      ?.includes("/.well-known/oauth-protected-resource/mcp")
  )
    throw new Error("Missing premium sign-in challenge");
  const metadata = await (
    await fetch(new URL("/.well-known/oauth-protected-resource/mcp", url))
  ).json();
  if (!metadata.resource.endsWith("/mcp"))
    throw new Error("Missing OAuth metadata");
  console.log(
    "Container health, initialization, nine-tool list, OAuth metadata and premium sign-in challenge passed.",
  );
} finally {
  await client.close();
}
