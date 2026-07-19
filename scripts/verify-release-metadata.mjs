#!/usr/bin/env node

import { readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
  );
}

const [packageJson, packageLock, server, manifest] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("server.json"),
  readJson("manifest.json"),
]);
const source = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

const expected = packageJson.version;
const versions = new Map([
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages root", packageLock.packages?.[""]?.version],
  ["server.json", server.version],
  ["server.json npm package", server.packages?.[0]?.version],
  ["manifest.json", manifest.version],
]);

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  const details = mismatches
    .map(([name, version]) => `${name}=${version ?? "missing"}`)
    .join(", ");
  throw new Error(
    `Release metadata must match package.json=${expected}: ${details}`,
  );
}

const sourceVersion = source.match(/export const MCP_VERSION = "([^"]+)"/)?.[1];
if (sourceVersion !== expected) {
  throw new Error(
    `src/index.ts MCP_VERSION=${sourceVersion ?? "missing"} must match package.json=${expected}.`,
  );
}

const registryDescriptionLength = [...server.description].length;
if (registryDescriptionLength > 100) {
  throw new Error(
    `server.json description is ${registryDescriptionLength} characters; registry maximum is 100`,
  );
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${expected}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(
      `Release tag ${process.env.GITHUB_REF_NAME ?? "missing"} must match ${expectedTag}`,
    );
  }
}

console.log(`Release metadata verified at ${expected}.`);
