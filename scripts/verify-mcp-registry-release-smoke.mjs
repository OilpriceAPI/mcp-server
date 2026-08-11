#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  validateRegistryPayload,
  verifyRegistryRelease,
} from "./verify-mcp-registry-release.mjs";

const expectedServer = JSON.parse(
  await readFile(new URL("../server.json", import.meta.url), "utf8"),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registryNormalizedServer() {
  const server = clone(expectedServer);
  for (const packageEntry of server.packages) {
    for (const environmentVariable of packageEntry.environmentVariables ?? []) {
      if (environmentVariable.isRequired === false) {
        delete environmentVariable.isRequired;
      }
      if (environmentVariable.isSecret === false) {
        delete environmentVariable.isSecret;
      }
    }
  }
  return server;
}

const valid = {
  server: registryNormalizedServer(),
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      isLatest: true,
    },
  },
};

validateRegistryPayload(valid, expectedServer);

function withServerMutation(mutator) {
  const payload = clone(valid);
  mutator(payload.server);
  return payload;
}

for (const payload of [
  withServerMutation((server) => {
    server.name = "wrong/server";
  }),
  withServerMutation((server) => {
    server.version = "3.2.0";
  }),
  withServerMutation((server) => {
    server.description = "Drifted description";
  }),
  withServerMutation((server) => {
    server.repository.url = "https://example.com/wrong";
  }),
  withServerMutation((server) => {
    server.packages[0].version = "3.2.0";
  }),
  withServerMutation((server) => {
    server.packages[0].transport.type = "streamable-http";
  }),
  withServerMutation((server) => {
    server.packages[0].environmentVariables[0].description = "Drifted";
  }),
  withServerMutation((server) => {
    server.packages[0].environmentVariables[1].isRequired = "false";
  }),
  withServerMutation((server) => {
    server.packages[0].environmentVariables[1].isSecret = "true";
  }),
  withServerMutation((server) => {
    server.packages[0].environmentVariables[1].isRequired = 0;
  }),
  withServerMutation((server) => {
    server.unreviewedField = true;
  }),
  {
    ...valid,
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        isLatest: false,
      },
    },
  },
]) {
  let rejected = false;
  try {
    validateRegistryPayload(payload, expectedServer);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("registry verifier accepted drifted metadata");
}

let calls = 0;
await verifyRegistryRelease({
  expectedServer,
  attempts: 2,
  delayMs: 0,
  fetchImpl: async (_url, init) => {
    if (!(init?.signal instanceof AbortSignal)) {
      throw new Error("registry verifier did not bound its request");
    }
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () =>
        calls === 1
          ? withServerMutation((server) => {
              server.description = "Drifted description";
            })
          : valid,
    };
  },
});
if (calls !== 2) throw new Error("registry verifier did not retry drift");

process.stdout.write("MCP registry verifier smoke passed.\n");
