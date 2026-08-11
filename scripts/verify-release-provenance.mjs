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

if (refType !== "tag" || refName !== expectedTag) {
  throw new Error(
    `release provenance requires tag ${expectedTag}; received ${refType ?? "missing"} ${refName ?? "missing"}`,
  );
}
if (!/^[0-9a-f]{40}$/.test(eventSha || "")) {
  throw new Error("release provenance requires the exact 40-character GITHUB_SHA");
}

const headSha = git("rev-parse", "HEAD");
const tagSha = git("rev-parse", `${expectedTag}^{commit}`);
if (headSha !== eventSha || tagSha !== eventSha) {
  throw new Error(
    `release tag, event, and checkout must resolve to one commit: tag=${tagSha} event=${eventSha} head=${headSha}`,
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

process.stdout.write(
  `Release provenance verified: ${expectedTag} -> ${eventSha} on origin/main.\n`,
);
