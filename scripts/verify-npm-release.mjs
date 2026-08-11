#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REGISTRY_BASE = "https://registry.npmjs.org";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
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
    typeof attestations.url !== "string" ||
    !attestations.url.startsWith("https://registry.npmjs.org/")
  ) {
    throw new Error("npm version metadata did not expose SLSA provenance");
  }
}

export async function verifyNpmRelease({
  expectedName,
  expectedVersion,
  expectedIntegrity,
  attempts = 12,
  delayMs = 5_000,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}) {
  const encodedName = encodeURIComponent(expectedName);
  const encodedVersion = encodeURIComponent(expectedVersion);
  const expectedUrl = `${REGISTRY_BASE}/${encodedName}/${encodedVersion}`;
  const latestUrl = `${REGISTRY_BASE}/${encodedName}/latest`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const expectedResponse = await fetchImpl(expectedUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!expectedResponse.ok) {
        throw new Error(
          `npm version readback returned HTTP ${expectedResponse.status}`,
        );
      }
      validateNpmVersionDocument(await expectedResponse.json(), {
        expectedName,
        expectedVersion,
        expectedIntegrity,
      });

      const latestResponse = await fetchImpl(latestUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!latestResponse.ok) {
        throw new Error(
          `npm latest readback returned HTTP ${latestResponse.status}`,
        );
      }
      validateNpmVersionDocument(await latestResponse.json(), {
        expectedName,
        expectedVersion,
        expectedIntegrity,
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
  if (!expectedName || !expectedVersion || !expectedIntegrity) {
    throw new Error(
      "NPM_RELEASE_EXPECTED_NAME, NPM_RELEASE_EXPECTED_VERSION, and NPM_RELEASE_EXPECTED_INTEGRITY are required",
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
    attempts,
    delayMs,
    timeoutMs,
  });
  process.stdout.write(
    `npm latest integrity and SLSA provenance verified for ${expectedName}@${expectedVersion}.\n`,
  );
}
