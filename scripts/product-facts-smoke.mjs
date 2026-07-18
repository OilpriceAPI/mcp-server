import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
delete environment.OILPRICEAPI_KEY;
delete environment.OIL_PRICE_API_KEY;
environment.OILPRICEAPI_BASE_URL = "http://127.0.0.1:9";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "build/index.js")],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "oilpriceapi-product-facts-smoke",
  version: "1.0.0",
});

function textContent(result) {
  const item = result.content.find((content) => content.type === "text");
  if (!item || typeof item.text !== "string") {
    throw new Error("MCP response did not include text content");
  }
  return item.text;
}

try {
  await client.connect(transport);

  const listedTools = await client.listTools();
  const productTool = listedTools.tools.find(
    (tool) => tool.name === "opa_get_product_facts",
  );
  if (!productTool?.annotations?.readOnlyHint) {
    throw new Error("opa_get_product_facts was not discoverable and read-only");
  }

  const listedResources = await client.listResources();
  if (
    !listedResources.resources.some(
      (resource) => resource.uri === "oilpriceapi://product-facts",
    )
  ) {
    throw new Error("product-facts resource was not discoverable");
  }

  const toolResult = await client.callTool({
    name: "opa_get_product_facts",
    arguments: {},
  });
  const toolPayload = JSON.parse(textContent(toolResult));
  if (
    toolPayload.facts?.schemaVersion !== "1.0.0" ||
    toolPayload.delivery?.source !== "pinned"
  ) {
    throw new Error("product-facts tool did not return the pinned v1 contract");
  }

  const resourceResult = await client.readResource({
    uri: "oilpriceapi://product-facts",
  });
  const resourceText = resourceResult.contents.find(
    (content) => "text" in content && typeof content.text === "string",
  )?.text;
  const resourcePayload = JSON.parse(resourceText || "{}");
  if (
    resourcePayload.facts?.contractVersion !== toolPayload.facts.contractVersion
  ) {
    throw new Error("product-facts resource and tool contracts disagree");
  }

  process.stdout.write(
    "product-facts MCP smoke passed: tool and resource discovered without an API key\n",
  );
} finally {
  await client.close();
}
