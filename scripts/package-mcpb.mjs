#!/usr/bin/env node
// Build the Claude Desktop extension bundle (.mcpb) from an already-built tree.
// Every release must ship one: v2.4.2 was the last release with a bundle, and
// Desktop/Connectors installs stayed pinned to it for three months (#145).

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = resolve(new URL("..", import.meta.url).pathname);
const out = resolve(process.argv[2] ?? join(root, "dist-mcpb"));
const stage = join(out, "stage");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(
    `manifest.json=${manifest.version} must match package.json=${pkg.version}`,
  );
}
statSync(join(root, "build", "index.js"));

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of [
  "build",
  "manifest.json",
  "icon.png",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "README.md",
]) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: stage, stdio: "inherit" });
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
run("npx", ["-y", MCPB_CLI, "validate", "manifest.json"]);

const bundle = join(out, `oilpriceapi-${pkg.version}.mcpb`);
run("npx", ["-y", MCPB_CLI, "pack", ".", bundle]);
console.log(`Packed ${bundle} (${statSync(bundle).size} bytes)`);
