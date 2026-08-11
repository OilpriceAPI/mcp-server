#!/usr/bin/env node

import {
  validateNpmAttestationsDocument,
  validateNpmVersionDocument,
  verifyNpmRelease,
} from "./verify-npm-release.mjs";

const expected = {
  expectedName: "oilpriceapi-mcp",
  expectedVersion: "3.2.1",
  expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  expectedSourceCommit: "a".repeat(40),
};
const attestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${expected.expectedName}@${expected.expectedVersion}`;
const validVersion = {
  name: expected.expectedName,
  version: expected.expectedVersion,
  dist: {
    integrity: expected.expectedIntegrity,
    attestations: {
      url: attestationUrl,
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validStatement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/${expected.expectedName}@${expected.expectedVersion}`,
        digest: { sha512: Buffer.alloc(64, 1).toString("hex") },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: `refs/tags/v${expected.expectedVersion}`,
            repository: "https://github.com/OilpriceAPI/mcp-server",
            path: ".github/workflows/publish.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/OilpriceAPI/mcp-server@refs/tags/v${expected.expectedVersion}`,
            digest: { gitCommit: expected.expectedSourceCommit },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId:
            "https://github.com/OilpriceAPI/mcp-server/actions/runs/123/attempts/1",
        },
      },
    },
  };
}

function attestationsDocument(statement = validStatement()) {
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            signatures: [{ keyid: "", sig: "reviewed-signature" }],
          },
          verificationMaterial: {
            certificate: { rawBytes: "reviewed-certificate" },
            tlogEntries: [{ logIndex: "1" }],
          },
        },
      },
    ],
  };
}

validateNpmVersionDocument(validVersion, expected);
validateNpmAttestationsDocument(attestationsDocument(), expected);

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
    document.dist.attestations.url = "https://registry.npmjs.org/wrong";
  },
]) {
  const payload = clone(validVersion);
  mutate(payload);
  let rejected = false;
  try {
    validateNpmVersionDocument(payload, expected);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("npm verifier accepted drifted metadata");
}

for (const mutate of [
  (document) => {
    document.attestations[0].bundle.dsseEnvelope.signatures = [];
  },
  (document) => {
    delete document.attestations[0].bundle.verificationMaterial.certificate;
  },
  (document) => {
    document.attestations[0].bundle.verificationMaterial.tlogEntries = [];
  },
]) {
  const document = attestationsDocument();
  mutate(document);
  let rejected = false;
  try {
    validateNpmAttestationsDocument(document, expected);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("npm verifier accepted unsigned provenance");
}

for (const mutate of [
  (statement) => {
    statement.subject[0].digest.sha512 = "0".repeat(128);
  },
  (statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.repository =
      "https://github.com/example/wrong";
  },
  (statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.path =
      ".github/workflows/wrong.yml";
  },
  (statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.ref =
      "refs/tags/v3.2.0";
  },
  (statement) => {
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
      "b".repeat(40);
  },
]) {
  const statement = validStatement();
  mutate(statement);
  let rejected = false;
  try {
    validateNpmAttestationsDocument(attestationsDocument(statement), expected);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("npm verifier accepted drifted provenance");
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
    if (url === attestationUrl) {
      return {
        ok: true,
        status: 200,
        json: async () => attestationsDocument(),
      };
    }
    const payload = clone(validVersion);
    if (calls === 2 && url.endsWith("/latest")) {
      payload.version = "3.2.0";
    }
    return { ok: true, status: 200, json: async () => payload };
  },
});
if (calls !== 5) throw new Error("npm verifier did not retry stale latest");

process.stdout.write("npm release verifier smoke passed.\n");
