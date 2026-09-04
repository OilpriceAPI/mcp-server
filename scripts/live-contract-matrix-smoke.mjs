#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { buildLiveContractMatrix, DEFAULT_CAPABILITIES_PATH } from "./generate-live-contract-matrix.mjs";
import { LIVE_CONTRACT_CATALOG } from "./live-contract-catalog.mjs";

const capabilities = JSON.parse(readFileSync(DEFAULT_CAPABILITIES_PATH, "utf8"));
const matrix = buildLiveContractMatrix(capabilities, LIVE_CONTRACT_CATALOG);
if (matrix.totals.tools !== 36 || matrix.tools.length !== capabilities.tools.length) {
  throw new Error("matrix did not cover the complete registered tool inventory");
}
for (const mode of ["network-read", "network-write", "non-network"]) {
  if (!matrix.tools.some((tool) => tool.mode === mode)) {
    throw new Error(`matrix has no ${mode} classification`);
  }
}

for (const [label, catalog] of [
  ["missing", Object.fromEntries(Object.entries(LIVE_CONTRACT_CATALOG).slice(1))],
  ["stale", { ...LIVE_CONTRACT_CATALOG, opa_stale_tool: { mode: "non-network", classification: "test", reason: "test" } }],
]) {
  let rejected = false;
  try {
    buildLiveContractMatrix(capabilities, catalog);
  } catch (error) {
    rejected = String(error.message).includes("registry drift");
  }
  if (!rejected) throw new Error(`matrix accepted a ${label} contract declaration`);
}

process.stdout.write("Live contract matrix smoke passed.\n");
