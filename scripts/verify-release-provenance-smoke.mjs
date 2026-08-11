#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(
  new URL("./verify-release-provenance.mjs", import.meta.url),
);
const temp = mkdtempSync(join(tmpdir(), "mcp-release-provenance-"));

function git(...args) {
  return execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
}

function runVerifier(env) {
  return spawnSync("node", [join(temp, "scripts/verify-release-provenance.mjs")], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function expectFailure(env, message) {
  const result = runVerifier(env);
  const output = `${result.stderr || ""}${result.stdout || ""}${result.error?.message || ""}`;
  if (result.status !== 0 && output.includes(message)) return;
  if (result.status === 0) {
    throw new Error(`release verifier accepted invalid provenance: ${message}`);
  }
  throw new Error(`release verifier failed for the wrong reason: ${output}`);
}

try {
  mkdirSync(join(temp, "scripts"));
  copyFileSync(sourceScript, join(temp, "scripts/verify-release-provenance.mjs"));
  writeFileSync(
    join(temp, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "3.2.1", type: "module" }, null, 2)}\n`,
  );
  git("init", "-b", "main");
  git("config", "user.name", "Release Provenance Smoke");
  git("config", "user.email", "release-smoke@example.invalid");
  git("add", ".");
  git("commit", "-m", "main release candidate");
  const mainSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", mainSha);
  git("tag", "v3.2.1");

  const validEnv = {
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v3.2.1",
    GITHUB_SHA: mainSha,
  };
  const success = runVerifier(validEnv);
  if (
    success.status !== 0 ||
    !success.stdout.includes("Release provenance verified")
  ) {
    throw new Error("release verifier did not report a verified main tag");
  }
  expectFailure(
    { ...validEnv, GITHUB_REF_NAME: "v3.2.0" },
    "requires tag v3.2.1",
  );

  const validBackfill = runVerifier({
    ...validEnv,
    MCP_PROVENANCE_MODE: "registry-backfill",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: "main",
  });
  if (
    validBackfill.status !== 0 ||
    !validBackfill.stdout.includes("Release provenance verified: main")
  ) {
    throw new Error("release verifier did not accept exact protected main");
  }
  expectFailure(
    {
      ...validEnv,
      MCP_PROVENANCE_MODE: "registry-backfill",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "feature",
    },
    "requires branch main",
  );

  writeFileSync(join(temp, "unmerged.txt"), "unmerged\n");
  git("add", "unmerged.txt");
  git("commit", "-m", "unmerged release candidate");
  const unmergedSha = git("rev-parse", "HEAD");
  git("tag", "--force", "v3.2.1", unmergedSha);
  expectFailure(
    { ...validEnv, GITHUB_SHA: unmergedSha },
    "is not an ancestor of protected origin/main",
  );
  expectFailure(
    {
      ...validEnv,
      MCP_PROVENANCE_MODE: "registry-backfill",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: unmergedSha,
    },
    "release ref, event, and checkout must resolve to one commit",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("Release-provenance smoke passed.\n");
