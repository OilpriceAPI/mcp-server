#!/usr/bin/env node

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
delete environment.OILPRICEAPI_BASE_URL;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "build/index.js")],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "oilpriceapi-live-product-facts-smoke",
  version: "1.0.0",
});

function textContent(result) {
  const item = result.content.find((content) => content.type === "text");
  if (!item || typeof item.text !== "string") {
    throw new Error("MCP product-facts response did not include text content");
  }
  return item.text;
}

function assertReviewedContract(payload) {
  const { facts, delivery } = payload;
  if (
    facts?.offer?.freeRequestLimit !== 50 ||
    facts?.offer?.freeRequestWindow !== "day" ||
    "freeRequestsPerMonth" in (facts?.offer || {})
  ) {
    throw new Error(
      "canonical product facts did not normalize to the reviewed 50/day contract",
    );
  }

  const sourceMajor = Number(delivery?.sourceSchemaVersion?.split(".")[0]);
  const expectedNormalization =
    sourceMajor === 1 ? "reviewed-v1-daily-bridge" : "native-v2";
  if (
    ![1, 2].includes(sourceMajor) ||
    delivery?.normalization !== expectedNormalization ||
    !delivery?.upstreamAvailable ||
    delivery?.stale
  ) {
    throw new Error(
      "canonical product-facts source metadata was incompatible or stale",
    );
  }
}

const attempts = 3;
let lastPayload;

try {
  await client.connect(transport);

  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "opa_get_product_facts")) {
    throw new Error("live MCP server did not expose opa_get_product_facts");
  }
  const resources = await client.listResources();
  if (
    !resources.resources.some(
      (resource) => resource.uri === "oilpriceapi://product-facts",
    )
  ) {
    throw new Error("live MCP server did not expose the product-facts resource");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await client.callTool({
      name: "opa_get_product_facts",
      arguments: {},
    });
    lastPayload = JSON.parse(textContent(result));

    if (lastPayload.delivery?.source === "canonical") {
      assertReviewedContract(lastPayload);

      const resource = await client.readResource({
        uri: "oilpriceapi://product-facts",
      });
      const resourceText = resource.contents.find(
        (content) => "text" in content && typeof content.text === "string",
      )?.text;
      const resourcePayload = JSON.parse(resourceText || "{}");
      if (JSON.stringify(resourcePayload.facts) !== JSON.stringify(lastPayload.facts)) {
        throw new Error("live product-facts tool and resource disagree");
      }

      process.stdout.write(
        `live MCP product-facts smoke passed: source ${lastPayload.delivery.sourceSchemaVersion}, ${lastPayload.delivery.normalization}, 50/day\n`,
      );
      lastPayload = undefined;
      break;
    }

    if (attempt < attempts) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, attempt * 500),
      );
    }
  }
} finally {
  await client.close();
}

if (lastPayload) {
  throw new Error(
    `canonical product-facts endpoint was unavailable after ${attempts} MCP attempts: ${lastPayload.delivery?.warning ?? "unknown failure"}`,
  );
}
