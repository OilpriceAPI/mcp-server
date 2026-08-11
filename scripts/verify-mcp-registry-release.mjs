#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.OilpriceAPI%2Fmcp-server/versions/latest";

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function assertOnlyKeys(record, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${name} returned unsupported fields (${unexpected.length}): ${unexpected.sort().join(", ")}`,
    );
  }
}

function normalizeEnvironmentVariable(value, name) {
  const entry = requireRecord(value, name);
  assertOnlyKeys(
    entry,
    ["description", "format", "isRequired", "isSecret", "name"],
    name,
  );
  for (const booleanKey of ["isRequired", "isSecret"]) {
    if (booleanKey in entry && typeof entry[booleanKey] !== "boolean") {
      throw new Error(`${name}.${booleanKey} must be a boolean when present`);
    }
  }
  return {
    description: entry.description,
    format: entry.format,
    isRequired: entry.isRequired === true,
    isSecret: entry.isSecret === true,
    name: entry.name,
  };
}

function normalizePackage(value, index) {
  const entry = requireRecord(value, `server.packages[${index}]`);
  assertOnlyKeys(
    entry,
    [
      "registryType",
      "identifier",
      "version",
      "transport",
      "environmentVariables",
    ],
    `server.packages[${index}]`,
  );
  const transport = requireRecord(
    entry.transport,
    `server.packages[${index}].transport`,
  );
  assertOnlyKeys(
    transport,
    ["type"],
    `server.packages[${index}].transport`,
  );
  const environmentVariables = Array.isArray(entry.environmentVariables)
    ? entry.environmentVariables
        .map((item, envIndex) =>
          normalizeEnvironmentVariable(
            item,
            `server.packages[${index}].environmentVariables[${envIndex}]`,
          ),
        )
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  return {
    registryType: entry.registryType,
    identifier: entry.identifier,
    version: entry.version,
    transport: { type: transport.type },
    environmentVariables,
  };
}

export function canonicalServerProjection(value) {
  const server = requireRecord(value, "server");
  assertOnlyKeys(
    server,
    ["$schema", "name", "description", "repository", "version", "packages"],
    "server",
  );
  const repository = requireRecord(server.repository, "server.repository");
  assertOnlyKeys(repository, ["url", "source"], "server.repository");
  if (!Array.isArray(server.packages)) {
    throw new Error("server.packages must be an array");
  }
  const packages = server.packages
    .map(normalizePackage)
    .sort((left, right) =>
      `${left.registryType}:${left.identifier}`.localeCompare(
        `${right.registryType}:${right.identifier}`,
      ),
    );
  return {
    $schema: server.$schema,
    name: server.name,
    description: server.description,
    repository: { url: repository.url, source: repository.source },
    version: server.version,
    packages,
  };
}

export function validateRegistryPayload(payload, expectedServer) {
  const actual = canonicalServerProjection(payload?.server);
  const expected = canonicalServerProjection(expectedServer);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("registry readback did not exactly match server.json");
  }
  const official = payload?._meta?.["io.modelcontextprotocol.registry/official"];
  if (official?.status !== "active" || official?.isLatest !== true) {
    throw new Error("registry readback was not active and latest");
  }
}

export async function verifyRegistryRelease({
  expectedServer,
  url = DEFAULT_URL,
  attempts = 12,
  delayMs = 5_000,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  const expectedVersion = canonicalServerProjection(expectedServer).version;
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
      validateRegistryPayload(payload, expectedServer);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
  }
  throw new Error(
    `MCP registry did not converge to ${expectedVersion}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const invokedPath = realpathSync(fileURLToPath(import.meta.url));
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === invokedPath
) {
  const expectedServer = JSON.parse(
    await readFile(new URL("../server.json", import.meta.url), "utf8"),
  );
  const expectedVersion = expectedServer.version;
  const configuredVersion = process.env.MCP_REGISTRY_EXPECTED_VERSION;
  if (configuredVersion && configuredVersion !== expectedVersion) {
    throw new Error(
      `MCP_REGISTRY_EXPECTED_VERSION=${configuredVersion} did not match server.json=${expectedVersion}`,
    );
  }
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
  await verifyRegistryRelease({
    expectedServer,
    attempts,
    delayMs,
    timeoutMs,
  });
  process.stdout.write(
    `MCP registry readback verified at ${expectedVersion}.\n`,
  );
}
