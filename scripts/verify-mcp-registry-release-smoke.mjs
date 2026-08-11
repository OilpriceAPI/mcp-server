#!/usr/bin/env node

import {
  validateRegistryPayload,
  verifyRegistryRelease,
} from "./verify-mcp-registry-release.mjs";

const version = "3.2.1";
const valid = {
  server: {
    name: "io.github.OilpriceAPI/mcp-server",
    version,
    packages: [
      {
        registryType: "npm",
        identifier: "oilpriceapi-mcp",
        version,
      },
    ],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      isLatest: true,
    },
  },
};

validateRegistryPayload(valid, version);
for (const payload of [
  { ...valid, server: { ...valid.server, name: "wrong/server" } },
  { ...valid, server: { ...valid.server, version: "3.2.0" } },
  {
    ...valid,
    server: {
      ...valid.server,
      packages: [{ ...valid.server.packages[0], version: "3.2.0" }],
    },
  },
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
    validateRegistryPayload(payload, version);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("registry verifier accepted drifted metadata");
}

let calls = 0;
await verifyRegistryRelease({
  expectedVersion: version,
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
          ? { ...valid, server: { ...valid.server, version: "3.2.0" } }
          : valid,
    };
  },
});
if (calls !== 2) throw new Error("registry verifier did not retry drift");

process.stdout.write("MCP registry verifier smoke passed.\n");
