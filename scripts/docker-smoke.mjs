#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    ...options,
  });
}

const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const sourceDateEpoch = (
  await run("git", ["show", "-s", "--format=%ct", sourceCommit])
).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^\d+$/.test(sourceDateEpoch)) {
  throw new Error("Could not resolve deterministic container provenance.");
}
const expectedGeneratedAt = new Date(
  Number(sourceDateEpoch) * 1000,
).toISOString();
const worktreeStatus = (
  await run("git", ["status", "--porcelain", "--untracked-files=all"])
).stdout.trim();
if (worktreeStatus) {
  throw new Error(
    "Container provenance smoke requires a clean worktree so HEAD identifies every image input.",
  );
}

const tag = `oilpriceapi-mcp-smoke:${sourceCommit.slice(0, 12)}-${process.pid}`;

try {
  await run("docker", [
    "build",
    "--pull",
    "--build-arg",
    `SOURCE_COMMIT=${sourceCommit}`,
    "--build-arg",
    `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
    "--tag",
    tag,
    ".",
  ]);

  const inspected = JSON.parse(
    (await run("docker", ["image", "inspect", tag])).stdout,
  )[0];
  if (inspected?.Config?.User !== "node") {
    throw new Error("Container runtime user must be node.");
  }
  if (
    inspected?.Config?.Labels?.["org.opencontainers.image.revision"] !==
    sourceCommit
  ) {
    throw new Error("Container revision label did not match the source commit.");
  }

  const version = (
    await run("docker", ["run", "--rm", tag, "--version"])
  ).stdout.trim();
  if (version !== `${packageJson.name} ${packageJson.version}`) {
    throw new Error(`Unexpected container version output: ${version}`);
  }

  const tools = JSON.parse(
    (await run("docker", ["run", "--rm", tag, "--list-tools", "--json"]))
      .stdout,
  );
  if (
    tools.scope !== "read" ||
    tools.tools.length !== 32 ||
    tools.tools.some((tool) => tool.access === "write")
  ) {
    throw new Error("Container default tool inventory was not exact/read-only.");
  }

  const runtimeCapabilities = JSON.parse(
    (
      await run("docker", [
        "run",
        "--rm",
        tag,
        "--capabilities",
        "--json",
      ])
    ).stdout,
  );

  const artifactCheck = String.raw`
    const { createHash } = require("node:crypto");
    const { existsSync, readFileSync, readdirSync } = require("node:fs");
    const { join } = require("node:path");
    const build = "/app/build";
    const metadata = JSON.parse(readFileSync(join(build, "build-metadata.json"), "utf8"));
    if (metadata.sourceCommit !== process.env.EXPECTED_SOURCE_COMMIT) throw new Error("source commit drift");
    if (metadata.generatedAt !== process.env.EXPECTED_GENERATED_AT) throw new Error("build timestamp drift");
    const factsPath = join(build, "product-facts.v2.json");
    const expectedDigest = readFileSync(join(build, "product-facts.v2.sha256"), "utf8").trim();
    const actualDigest = createHash("sha256").update(readFileSync(factsPath)).digest("hex");
    if (actualDigest !== expectedDigest) throw new Error("product-facts checksum drift");
    const facts = JSON.parse(readFileSync(factsPath, "utf8"));
    if (facts.schemaVersion !== "2.0.0") throw new Error("unexpected product-facts schema");
    const capabilities = JSON.parse(readFileSync(join(build, "capabilities.json"), "utf8"));
    if (capabilities.package.sourceCommit !== process.env.EXPECTED_SOURCE_COMMIT) throw new Error("capability provenance drift");
    if (capabilities.generatedAt !== process.env.EXPECTED_GENERATED_AT) throw new Error("capability timestamp drift");
    if (capabilities.tools.length !== 36) throw new Error("capability inventory drift");
    if (existsSync(join(build, "__tests__"))) throw new Error("test artifacts leaked into runtime image");
    for (const entry of readdirSync(build)) {
      if (/\.(?:test|spec)\./.test(entry)) throw new Error("test artifact leaked into runtime image");
    }
    process.stdout.write(JSON.stringify(capabilities));
  `;
  const artifactCapabilities = JSON.parse((await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    "--env",
    `EXPECTED_SOURCE_COMMIT=${sourceCommit}`,
    "--env",
    `EXPECTED_GENERATED_AT=${expectedGeneratedAt}`,
    tag,
    "-e",
    artifactCheck,
  ])).stdout);
  if (
    JSON.stringify(runtimeCapabilities) !== JSON.stringify(artifactCapabilities)
  ) {
    throw new Error(
      "Container runtime capabilities did not match the packaged artifact.",
    );
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  delete environment.OILPRICEAPI_KEY;
  delete environment.OIL_PRICE_API_KEY;
  delete environment.OILPRICEAPI_BASE_URL;
  const transport = new StdioClientTransport({
    command: "docker",
    args: ["run", "--rm", "-i", tag],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({
    name: "oilpriceapi-container-product-facts-smoke",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    let livePayload;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await client.callTool({
        name: "opa_get_product_facts",
        arguments: {},
      });
      const text = result.content.find(
        (item) => item.type === "text" && typeof item.text === "string",
      )?.text;
      livePayload = JSON.parse(text || "{}");
      if (livePayload.delivery?.source === "canonical") break;
      if (attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
    }
    if (
      livePayload?.facts?.offer?.freeRequestLimit !== 50 ||
      livePayload?.facts?.offer?.freeRequestWindow !== "day" ||
      livePayload?.delivery?.source !== "canonical" ||
      livePayload?.delivery?.stale ||
      !["reviewed-v1-daily-bridge", "native-v2"].includes(
        livePayload?.delivery?.normalization,
      )
    ) {
      throw new Error(
        "Container stdio did not return the live reviewed keyless product-facts contract.",
      );
    }
    const resource = await client.readResource({
      uri: "oilpriceapi://product-facts",
    });
    const resourceText = resource.contents.find(
      (item) => "text" in item && typeof item.text === "string",
    )?.text;
    const resourcePayload = JSON.parse(resourceText || "{}");
    if (
      JSON.stringify(resourcePayload.facts) !==
      JSON.stringify(livePayload.facts)
    ) {
      throw new Error("Container product-facts tool and resource disagreed.");
    }
  } finally {
    await client.close();
  }

  process.stdout.write(
    `Container smoke passed for ${tag}: non-root, exact provenance, facts, capabilities, read-only CLI, and live keyless stdio.\n`,
  );
} finally {
  await run("docker", ["image", "rm", "--force", tag]).catch(() => {});
}
