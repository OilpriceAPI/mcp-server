#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url);

async function git(...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

const environmentSha = process.env.GITHUB_SHA?.trim().toLowerCase();
const sourceCommit = /^[0-9a-f]{40}$/.test(environmentSha || "")
  ? environmentSha
  : (await git("rev-parse", "HEAD")).toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("Could not resolve a 40-character source commit.");
}

let generatedAt;
if (process.env.SOURCE_DATE_EPOCH) {
  generatedAt = new Date(
    Number(process.env.SOURCE_DATE_EPOCH) * 1000,
  ).toISOString();
} else {
  generatedAt = new Date(
    await git("show", "-s", "--format=%cI", sourceCommit),
  ).toISOString();
}

const output = new URL("../build/build-metadata.json", import.meta.url);
await mkdir(new URL("../build", import.meta.url), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify({ sourceCommit, generatedAt }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Generated deterministic build metadata for ${sourceCommit.slice(0, 8)}.\n`,
);
