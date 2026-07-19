#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url);
const entryPoint = new URL("../build/index.js", import.meta.url);
const output = new URL("../build/capabilities.json", import.meta.url);

const { stdout, stderr } = await execFileAsync(
  process.execPath,
  [entryPoint.pathname, "--capabilities", "--json"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  },
);
if (stderr.trim()) {
  throw new Error(`Capability generation wrote to stderr: ${stderr.trim()}`);
}
const manifest = JSON.parse(stdout);
if (
  manifest.schemaVersion !== "1.0.0" ||
  !Array.isArray(manifest.tools) ||
  manifest.tools.length === 0
) {
  throw new Error(
    "Generated capability output does not match the v1 contract.",
  );
}

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const roundTrip = JSON.parse(await readFile(output, "utf8"));
if (JSON.stringify(roundTrip) !== JSON.stringify(manifest)) {
  throw new Error("Capability artifact changed during serialization.");
}
process.stdout.write(
  `Generated capability manifest with ${manifest.tools.length} tools.\n`,
);
