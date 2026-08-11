#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REGISTRY_BASE = "https://registry.npmjs.org";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const GITHUB_ACTIONS_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const SOURCE_REPOSITORY = "https://github.com/OilpriceAPI/mcp-server";
const SOURCE_WORKFLOW = ".github/workflows/publish.yml";
const SIGSTORE_BUNDLE_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json";
const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function expectedAttestationUrl(expectedName, expectedVersion) {
  return `${REGISTRY_BASE}/-/npm/v1/attestations/${expectedName}@${expectedVersion}`;
}

function integrityHex(expectedIntegrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(expectedIntegrity);
  if (!match) throw new Error("expected npm integrity must be sha512 SRI");
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64) {
    throw new Error("expected npm integrity must contain a SHA-512 digest");
  }
  return digest.toString("hex");
}

export function validateNpmVersionDocument(
  value,
  { expectedName, expectedVersion, expectedIntegrity },
) {
  const document = requireRecord(value, "npm version document");
  const dist = requireRecord(document.dist, "npm version dist metadata");
  const attestations = requireRecord(
    dist.attestations,
    "npm version attestations",
  );
  const provenance = requireRecord(
    attestations.provenance,
    "npm version provenance",
  );
  if (
    document.name !== expectedName ||
    document.version !== expectedVersion ||
    dist.integrity !== expectedIntegrity
  ) {
    throw new Error("npm version metadata did not match the verified tarball");
  }
  if (
    provenance.predicateType !== SLSA_PROVENANCE ||
    attestations.url !== expectedAttestationUrl(expectedName, expectedVersion)
  ) {
    throw new Error("npm version metadata did not expose exact SLSA provenance");
  }
}

export function validateNpmAttestationsDocument(
  value,
  {
    expectedName,
    expectedVersion,
    expectedIntegrity,
    expectedSourceCommit,
  },
) {
  const document = requireRecord(value, "npm attestations document");
  if (!Array.isArray(document.attestations)) {
    throw new Error("npm attestations document must contain an array");
  }
  const provenanceEntry = document.attestations.find(
    (entry) => entry?.predicateType === SLSA_PROVENANCE,
  );
  const bundle = requireRecord(provenanceEntry?.bundle, "npm SLSA bundle");
  const envelope = requireRecord(bundle.dsseEnvelope, "npm SLSA envelope");
  const verificationMaterial = requireRecord(
    bundle.verificationMaterial,
    "npm SLSA verification material",
  );
  const certificate = requireRecord(
    verificationMaterial.certificate,
    "npm SLSA certificate",
  );
  const signatures = Array.isArray(envelope.signatures)
    ? envelope.signatures
    : [];
  const transparencyEntries = Array.isArray(verificationMaterial.tlogEntries)
    ? verificationMaterial.tlogEntries
    : [];
  if (
    bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE ||
    envelope.payloadType !== INTOTO_PAYLOAD_TYPE ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length === 0 ||
    !signatures.some(
      (signature) =>
        typeof signature?.sig === "string" && signature.sig.length > 0,
    ) ||
    typeof certificate.rawBytes !== "string" ||
    certificate.rawBytes.length === 0 ||
    transparencyEntries.length === 0
  ) {
    throw new Error(
      "npm SLSA bundle must include its DSSE signature, certificate, and transparency-log material",
    );
  }
  let statement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
  } catch {
    throw new Error("npm SLSA envelope payload was not valid JSON");
  }
  const predicate = requireRecord(statement.predicate, "npm SLSA predicate");
  const buildDefinition = requireRecord(
    predicate.buildDefinition,
    "npm SLSA build definition",
  );
  const externalParameters = requireRecord(
    buildDefinition.externalParameters,
    "npm SLSA external parameters",
  );
  const workflow = requireRecord(
    externalParameters.workflow,
    "npm SLSA workflow",
  );
  const runDetails = requireRecord(
    predicate.runDetails,
    "npm SLSA run details",
  );
  const builder = requireRecord(runDetails.builder, "npm SLSA builder");
  const expectedTag = `v${expectedVersion}`;
  const expectedSubject = `pkg:npm/${expectedName}@${expectedVersion}`;
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const matchingSubject = subjects.find(
    (subject) =>
      subject?.name === expectedSubject &&
      subject?.digest?.sha512 === integrityHex(expectedIntegrity),
  );
  const resolvedDependencies = Array.isArray(
    buildDefinition.resolvedDependencies,
  )
    ? buildDefinition.resolvedDependencies
    : [];
  const expectedDependency = resolvedDependencies.find(
    (dependency) =>
      dependency?.uri ===
        `git+${SOURCE_REPOSITORY}@refs/tags/${expectedTag}` &&
      dependency?.digest?.gitCommit === expectedSourceCommit,
  );

  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== SLSA_PROVENANCE ||
    !matchingSubject ||
    buildDefinition.buildType !== GITHUB_ACTIONS_BUILD_TYPE ||
    workflow.repository !== SOURCE_REPOSITORY ||
    workflow.path !== SOURCE_WORKFLOW ||
    workflow.ref !== `refs/tags/${expectedTag}` ||
    !expectedDependency ||
    builder.id !== "https://github.com/actions/runner/github-hosted" ||
    typeof runDetails.metadata?.invocationId !== "string" ||
    !runDetails.metadata.invocationId.startsWith(
      `${SOURCE_REPOSITORY}/actions/runs/`,
    )
  ) {
    throw new Error(
      "npm SLSA provenance did not match the package, source, tag, workflow, and commit",
    );
  }
}

export async function verifyNpmRelease({
  expectedName,
  expectedVersion,
  expectedIntegrity,
  expectedSourceCommit,
  attempts = 12,
  delayMs = 5_000,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  const encodedName = encodeURIComponent(expectedName);
  const encodedVersion = encodeURIComponent(expectedVersion);
  const expectedUrl = `${REGISTRY_BASE}/${encodedName}/${encodedVersion}`;
  const latestUrl = `${REGISTRY_BASE}/${encodedName}/latest`;
  const attestationsUrl = expectedAttestationUrl(expectedName, expectedVersion);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      for (const [name, url] of [
        ["version", expectedUrl],
        ["latest", latestUrl],
      ]) {
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `npm ${name} readback returned HTTP ${response.status}`,
          );
        }
        validateNpmVersionDocument(await response.json(), {
          expectedName,
          expectedVersion,
          expectedIntegrity,
        });
      }

      const attestationsResponse = await fetchImpl(attestationsUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!attestationsResponse.ok) {
        throw new Error(
          `npm attestations readback returned HTTP ${attestationsResponse.status}`,
        );
      }
      validateNpmAttestationsDocument(await attestationsResponse.json(), {
        expectedName,
        expectedVersion,
        expectedIntegrity,
        expectedSourceCommit,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
  }

  throw new Error(
    `npm did not converge to verified latest ${expectedName}@${expectedVersion}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === invokedPath) {
  const expectedName = process.env.NPM_RELEASE_EXPECTED_NAME;
  const expectedVersion = process.env.NPM_RELEASE_EXPECTED_VERSION;
  const expectedIntegrity = process.env.NPM_RELEASE_EXPECTED_INTEGRITY;
  const expectedSourceCommit = process.env.NPM_RELEASE_EXPECTED_SOURCE_COMMIT;
  if (
    !expectedName ||
    !expectedVersion ||
    !expectedIntegrity ||
    !/^[0-9a-f]{40}$/.test(expectedSourceCommit || "")
  ) {
    throw new Error(
      "NPM_RELEASE_EXPECTED_NAME, NPM_RELEASE_EXPECTED_VERSION, NPM_RELEASE_EXPECTED_INTEGRITY, and a 40-character NPM_RELEASE_EXPECTED_SOURCE_COMMIT are required",
    );
  }
  const attempts = Number(process.env.NPM_RELEASE_ATTEMPTS || 12);
  const delayMs = Number(process.env.NPM_RELEASE_DELAY_MS || 5_000);
  const timeoutMs = Number(process.env.NPM_RELEASE_TIMEOUT_MS || 10_000);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("NPM_RELEASE_ATTEMPTS must be a positive integer");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("NPM_RELEASE_DELAY_MS must be a non-negative integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("NPM_RELEASE_TIMEOUT_MS must be a positive integer");
  }
  await verifyNpmRelease({
    expectedName,
    expectedVersion,
    expectedIntegrity,
    expectedSourceCommit,
    attempts,
    delayMs,
    timeoutMs,
  });
  process.stdout.write(
    `npm latest integrity and source-bound SLSA provenance verified for ${expectedName}@${expectedVersion}.\n`,
  );
}
