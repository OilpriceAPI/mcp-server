// Keyless demo attribution (OilpriceAPI/oilpriceapi-api#9388).
//
// The API records keyless demo traffic by the `client` query parameter
// (DemoTelemetry::KNOWN_CLIENTS includes "mcp"). Without it every MCP demo
// request is logged as client=unknown. Headers such as X-Api-Client are not
// read by the demo telemetry, so the parameter is required.
//
// No `iid` is sent: this server does not persist an anonymous install id, and
// minting one would mean new persistent storage on the user's machine.

export const DEMO_CLIENT = "mcp";

/**
 * Append `client=mcp` to a /v1/demo/* path or absolute URL, keeping any
 * existing query parameters and an existing explicit `client` value.
 */
export function withDemoClient(target: string): string {
  const hashIndex = target.indexOf("#");
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const queryIndex = base.indexOf("?");
  const path = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const params = new URLSearchParams(
    queryIndex >= 0 ? base.slice(queryIndex + 1) : "",
  );
  if (!params.has("client")) params.set("client", DEMO_CLIENT);
  return `${path}?${params.toString()}${hash}`;
}
