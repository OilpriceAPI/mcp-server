#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const expectedTag = `v${packageJson.version}`;
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
const eventSha = process.env.GITHUB_SHA;
const mode = process.env.MCP_PROVENANCE_MODE || "release";

if (!["release", "registry-backfill"].includes(mode)) {
  throw new Error(`unsupported release provenance mode: ${mode}`);
}
if (
  (mode === "release" && (refType !== "tag" || refName !== expectedTag)) ||
  (mode === "registry-backfill" &&
    (refType !== "branch" || refName !== "main"))
) {
  const expectedRef =
    mode === "release" ? `tag ${expectedTag}` : "branch main";
  throw new Error(
    `release provenance requires ${expectedRef}; received ${refType ?? "missing"} ${refName ?? "missing"}`,
  );
}
if (!/^[0-9a-f]{40}$/.test(eventSha || "")) {
  throw new Error("release provenance requires the exact 40-character GITHUB_SHA");
}

const headSha = git("rev-parse", "HEAD");
const refSha =
  mode === "release"
    ? git("rev-parse", `${expectedTag}^{commit}`)
    : git("rev-parse", "refs/remotes/origin/main");
if (headSha !== eventSha || refSha !== eventSha) {
  throw new Error(
    `release ref, event, and checkout must resolve to one commit: ref=${refSha} event=${eventSha} head=${headSha}`,
  );
}

try {
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", eventSha, "refs/remotes/origin/main"],
    { stdio: "pipe" },
  );
} catch {
  throw new Error(
    `release commit ${eventSha} is not an ancestor of protected origin/main`,
  );
}

const verifiedRef = mode === "release" ? expectedTag : "main";
process.stdout.write(
  `Release provenance verified: ${verifiedRef} -> ${eventSha} on origin/main.\n`,
);
