#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const symlinkRoot = mkdtempSync(join(tmpdir(), "mcp-registry-verifier-link-"));
try {
  const link = join(symlinkRoot, "registry-verifier.mjs");
  symlinkSync(
    fileURLToPath(new URL("./verify-mcp-registry-release.mjs", import.meta.url)),
    link,
  );
  const linked = spawnSync(process.execPath, [link], {
    encoding: "utf8",
    env: { ...process.env, MCP_REGISTRY_ATTEMPTS: "0" },
  });
  if (
    linked.status === 0 ||
    !`${linked.stderr}${linked.stdout}`.includes(
      "MCP_REGISTRY_ATTEMPTS must be a positive integer",
    )
  ) {
    throw new Error("registry verifier silently skipped symlink invocation");
  }
} finally {
  rmSync(symlinkRoot, { recursive: true, force: true });
}

process.stdout.write("MCP registry verifier smoke passed.\n");
