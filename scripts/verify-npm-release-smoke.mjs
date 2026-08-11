#!/usr/bin/env node

import {
  validateNpmVersionDocument,
  verifyNpmRelease,
} from "./verify-npm-release.mjs";

const expected = {
  expectedName: "oilpriceapi-mcp",
  expectedVersion: "3.2.1",
  expectedIntegrity: "sha512-reviewed",
};
const valid = {
  name: expected.expectedName,
  version: expected.expectedVersion,
  dist: {
    integrity: expected.expectedIntegrity,
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/${expected.expectedName}@${expected.expectedVersion}`,
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

validateNpmVersionDocument(valid, expected);
for (const mutate of [
  (document) => {
    document.name = "wrong-package";
  },
  (document) => {
    document.version = "3.2.0";
  },
  (document) => {
    document.dist.integrity = "sha512-wrong";
  },
  (document) => {
    delete document.dist.attestations;
  },
  (document) => {
    document.dist.attestations.provenance.predicateType =
      "https://example.com/not-slsa";
  },
]) {
  const payload = clone(valid);
  mutate(payload);
  let rejected = false;
  try {
    validateNpmVersionDocument(payload, expected);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("npm verifier accepted drifted metadata");
}

let calls = 0;
await verifyNpmRelease({
  ...expected,
  attempts: 2,
  delayMs: 0,
  fetchImpl: async (url, init) => {
    if (!(init?.signal instanceof AbortSignal)) {
      throw new Error("npm verifier did not bound its request");
    }
    calls += 1;
    const payload = clone(valid);
    if (calls === 2 && url.endsWith("/latest")) {
      payload.version = "3.2.0";
    }
    return { ok: true, status: 200, json: async () => payload };
  },
});
if (calls !== 4) throw new Error("npm verifier did not retry stale latest");

process.stdout.write("npm release verifier smoke passed.\n");
