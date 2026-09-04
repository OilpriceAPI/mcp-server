#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_CONTRACT_CATALOG } from "./live-contract-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CAPABILITIES_PATH = resolve(root, "build/capabilities.json");
export const DEFAULT_MATRIX_PATH = resolve(root, "artifacts/live-contract-matrix.json");

export function buildLiveContractMatrix(capabilities, catalog) {
  const registered = capabilities?.tools?.map(({ name }) => name).sort();
  if (!registered || registered.length === 0) {
    throw new Error("capability artifact has no registered tools");
  }
  const declared = Object.keys(catalog).sort();
  const missing = registered.filter((name) => !declared.includes(name));
  const stale = declared.filter((name) => !registered.includes(name));
  if (missing.length || stale.length) {
    throw new Error(
      `live contract registry drift; missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}`,
    );
  }

  const tools = capabilities.tools.map((tool) => {
    const contract = catalog[tool.name];
    if (contract.mode === "non-network" && (!contract.classification || !contract.reason)) {
      throw new Error(`${tool.name} has an undocumented non-network exception`);
    }
    if (contract.mode === "network-read" && !["ungated", "conditional"].includes(contract.entitlement)) {
      throw new Error(`${tool.name} has no explicit entitlement classification`);
    }
    if (contract.mode === "network-write" && (!contract.lifecycle || !contract.cleanup)) {
      throw new Error(`${tool.name} has no isolated lifecycle cleanup declaration`);
    }
    return {
      name: tool.name,
      access: tool.access,
      category: tool.category,
      apiKey: tool.apiKey,
      ...contract,
    };
  });

  return {
    schemaVersion: "1.0.0",
    generatedAt: capabilities.generatedAt,
    source: {
      package: capabilities.package.name,
      version: capabilities.package.version,
      commit: capabilities.package.sourceCommit,
      capabilitySchemaVersion: capabilities.schemaVersion,
    },
    policy: {
      http404: "fail",
      http401: "fail",
      http402Or403:
        "record as covered-plan-gate only for tools explicitly classified conditional; otherwise fail",
      writes:
        "create, verify by read, delete in finally, then verify the synthetic record no longer exists",
    },
    totals: {
      tools: tools.length,
      networkRead: tools.filter(({ mode }) => mode === "network-read").length,
      networkWrite: tools.filter(({ mode }) => mode === "network-write").length,
      nonNetwork: tools.filter(({ mode }) => mode === "non-network").length,
    },
    tools,
  };
}

export function generateLiveContractMatrix({
  capabilitiesPath = DEFAULT_CAPABILITIES_PATH,
  outputPath = DEFAULT_MATRIX_PATH,
} = {}) {
  const capabilities = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
  const matrix = buildLiveContractMatrix(capabilities, LIVE_CONTRACT_CATALOG);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`);
  return matrix;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = generateLiveContractMatrix();
  process.stdout.write(
    `Generated live contract matrix for ${matrix.totals.tools} registered tools (${matrix.totals.networkRead} reads, ${matrix.totals.networkWrite} writes, ${matrix.totals.nonNetwork} non-network).\n`,
  );
}
