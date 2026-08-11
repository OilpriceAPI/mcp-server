#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.OilpriceAPI%2Fmcp-server/versions/latest";

export function validateRegistryPayload(payload, expectedVersion) {
  const server = payload?.server;
  if (server?.name !== "io.github.OilpriceAPI/mcp-server") {
    throw new Error("registry readback returned the wrong server name");
  }
  if (server.version !== expectedVersion) {
    throw new Error(
      `registry readback version ${server.version ?? "missing"} did not match ${expectedVersion}`,
    );
  }
  const npmPackage = server.packages?.find(
    (entry) =>
      entry?.registryType === "npm" &&
      entry?.identifier === "oilpriceapi-mcp",
  );
  if (npmPackage?.version !== expectedVersion) {
    throw new Error("registry readback npm package version did not match");
  }
  const official = payload?._meta?.["io.modelcontextprotocol.registry/official"];
  if (official?.status !== "active" || official?.isLatest !== true) {
    throw new Error("registry readback was not active and latest");
  }
}

export async function verifyRegistryRelease({
  expectedVersion,
  url = DEFAULT_URL,
  attempts = 12,
  delayMs = 5_000,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`registry readback returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      validateRegistryPayload(payload, expectedVersion);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(
    `MCP registry did not converge to ${expectedVersion}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === invokedPath) {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const expectedVersion =
    process.env.MCP_REGISTRY_EXPECTED_VERSION || packageJson.version;
  const attempts = Number(process.env.MCP_REGISTRY_ATTEMPTS || 12);
  const delayMs = Number(process.env.MCP_REGISTRY_DELAY_MS || 5_000);
  const timeoutMs = Number(process.env.MCP_REGISTRY_TIMEOUT_MS || 10_000);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("MCP_REGISTRY_ATTEMPTS must be a positive integer");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("MCP_REGISTRY_DELAY_MS must be a non-negative integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("MCP_REGISTRY_TIMEOUT_MS must be a positive integer");
  }
  await verifyRegistryRelease({ expectedVersion, attempts, delayMs, timeoutMs });
  process.stdout.write(
    `MCP registry readback verified at ${expectedVersion}.\n`,
  );
}
