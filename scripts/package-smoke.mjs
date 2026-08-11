#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const temporary = await mkdtemp(join(tmpdir(), "oilpriceapi-mcp-package-"));
const installRoot = join(temporary, "install");
let server;

function parsePackedPackage(output) {
  const parsed = JSON.parse(output);
  const candidates = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (candidates.length !== 1) {
    throw new Error(
      `npm pack returned ${candidates.length} package records; expected exactly one.`,
    );
  }
  const [packedPackage] = candidates;
  if (
    typeof packedPackage?.filename !== "string" ||
    !Array.isArray(packedPackage.files)
  ) {
    throw new Error("npm pack returned an unsupported JSON record shape.");
  }
  return packedPackage;
}

function run(entryPoint, args, env = {}) {
  return execFileAsync(process.execPath, [entryPoint, ...args], {
    cwd: installRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function transportEnvironment(extra = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  delete environment.OILPRICEAPI_KEY;
  delete environment.OIL_PRICE_API_KEY;
  return { ...environment, ...extra };
}

async function assertProtocolScope(entryPoint, baseUrl, scope, expectedCount) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint, "--scope", scope],
    env: transportEnvironment({ OILPRICEAPI_BASE_URL: baseUrl }),
    stderr: "pipe",
  });
  const client = new Client({
    name: `oilpriceapi-package-${scope}-smoke`,
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (listed.tools.length !== expectedCount) {
      throw new Error(
        `${scope} scope listed ${listed.tools.length} tools; expected ${expectedCount}`,
      );
    }
    const writeName = "opa_create_price_alert";
    const exposesWrite = listed.tools.some((tool) => tool.name === writeName);
    if (scope === "read") {
      if (exposesWrite) throw new Error("read scope exposed a mutation tool");
      let rejected = false;
      try {
        const result = await client.callTool({
          name: writeName,
          arguments: {
            commodity: "brent",
            operator: "greater_than",
            threshold: 100,
          },
        });
        const errorText = Array.isArray(result.content)
          ? result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join(" ")
          : "";
        rejected =
          result.isError === true && /disabled|not found/i.test(errorText);
      } catch (error) {
        rejected = /disabled|not found/i.test(String(error));
      }
      if (!rejected) {
        throw new Error("read scope did not reject direct mutation invocation");
      }
    } else if (!exposesWrite) {
      throw new Error("explicit write scope did not expose mutation tools");
    }
  } finally {
    await client.close();
  }
}

try {
  const { stdout: packOutput } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8" },
  );
  const packed = parsePackedPackage(packOutput);
  if (packed.files.some((file) => file.path.includes("/__tests__/"))) {
    throw new Error("The npm tarball contains compiled test artifacts.");
  }
  const packedPaths = new Set(packed.files.map((file) => file.path));
  if (
    packedPaths.has("build/product-facts.v1.json") ||
    packedPaths.has("build/product-facts.v1.sha256")
  ) {
    throw new Error("The npm tarball contains the retired v1 product facts.");
  }
  for (const required of [
    "build/product-facts.v2.json",
    "build/product-facts.v2.sha256",
  ]) {
    if (!packedPaths.has(required)) {
      throw new Error(`The npm tarball is missing ${required}.`);
    }
  }
  const tarball = join(temporary, packed.filename);
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--fund=false",
      tarball,
    ],
    { encoding: "utf8" },
  );

  const entryPoint = join(
    installRoot,
    "node_modules",
    packageJson.name,
    "build",
    "index.js",
  );
  const packagedCapabilities = JSON.parse(
    await readFile(
      join(
        installRoot,
        "node_modules",
        packageJson.name,
        "build",
        "capabilities.json",
      ),
      "utf8",
    ),
  );

  const version = await run(entryPoint, ["--version"]);
  if (version.stdout.trim() !== `${packageJson.name} ${packageJson.version}`) {
    throw new Error(
      `Unexpected packaged --version output: ${version.stdout.trim()}`,
    );
  }

  const readTools = JSON.parse(
    (await run(entryPoint, ["--list-tools", "--json"])).stdout,
  );
  if (
    readTools.scope !== "read" ||
    readTools.tools.length !== 32 ||
    readTools.tools.some((tool) => tool.access === "write")
  ) {
    throw new Error(
      "Packaged default tool inventory is not read-only and exact.",
    );
  }

  let invalidScopeFailedClosed = false;
  try {
    await run(entryPoint, ["--scope", "admin", "--list-tools", "--json"]);
  } catch (error) {
    invalidScopeFailedClosed =
      error.code !== 0 &&
      !error.stdout?.trim() &&
      /Unknown MCP scope/i.test(error.stderr || "");
  }
  if (!invalidScopeFailedClosed) {
    throw new Error("Packaged CLI did not fail closed on an unknown scope.");
  }

  const capabilities = JSON.parse(
    (await run(entryPoint, ["--capabilities", "--json"])).stdout,
  );
  if (JSON.stringify(capabilities) !== JSON.stringify(packagedCapabilities)) {
    throw new Error("Packaged capability command and artifact disagree.");
  }
  if (
    capabilities.package.version !== packageJson.version ||
    !/^[0-9a-f]{40}$/.test(capabilities.package.sourceCommit) ||
    capabilities.package.minimumNodeVersion !== ">=18.0.0"
  ) {
    throw new Error("Packaged capability metadata is incomplete.");
  }

  const configClients = [
    "claude-desktop",
    "claude-code",
    "cursor",
    "vscode",
    "cline",
    "windsurf",
  ];
  const configSecret = "opa_live_package_smoke_must_stay_redacted";
  for (const client of configClients) {
    const generated = await run(entryPoint, ["--config", client], {
      OILPRICEAPI_KEY: configSecret,
    });
    JSON.parse(generated.stdout);
    if (
      generated.stdout.includes(configSecret) ||
      !generated.stdout.includes(packageJson.name)
    ) {
      throw new Error(
        `Packaged ${client} config was invalid or exposed the environment key.`,
      );
    }
  }
  let missingConfigTargetFailedClosed = false;
  try {
    await run(entryPoint, ["--config"]);
  } catch (error) {
    missingConfigTargetFailedClosed =
      error.code !== 0 &&
      !error.stdout?.trim() &&
      /--config requires a value/i.test(error.stderr || "");
  }
  if (!missingConfigTargetFailedClosed) {
    throw new Error("Packaged --config command did not fail closed.");
  }

  server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/v1/demo/prices") {
      response.end(
        JSON.stringify({
          status: "success",
          data: { prices: [{ code: "BRENT_CRUDE_USD", price: 80 }] },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No smoke server port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const doctor = JSON.parse(
    (
      await run(entryPoint, ["doctor", "--demo", "--json"], {
        OILPRICEAPI_BASE_URL: baseUrl,
      })
    ).stdout,
  );
  if (!doctor.ok || doctor.checks.at(-1)?.id !== "demo") {
    throw new Error("Packaged doctor --demo did not pass.");
  }

  await assertProtocolScope(entryPoint, baseUrl, "read", 32);
  await assertProtocolScope(entryPoint, baseUrl, "write", 36);

  process.stdout.write(
    "packaged MCP smoke passed: version, configs, doctor, capabilities, scopes, and protocol blocking\n",
  );
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
