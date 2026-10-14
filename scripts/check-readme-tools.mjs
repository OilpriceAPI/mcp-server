#!/usr/bin/env node

// Fails when the README's tool tables and the registered tools differ (#146).
// Source of truth: build/capabilities.json (every tool, all scopes), written
// by `npm run build`. Exit 0 = match, 1 = drift, 2 = cannot check.

import { readFileSync } from "node:fs";

try {
  const manifest = JSON.parse(readFileSync("build/capabilities.json", "utf8"));
  const registered = new Set(manifest.tools.map((t) => t.name));
  if (registered.size === 0) throw new Error("capabilities.json lists no tools");

  // A documented tool is the first cell of a markdown table row.
  const readme = readFileSync("README.md", "utf8");
  const documented = new Set(
    [...readme.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)]
      .map((m) => m[1])
      .filter((name) => name.startsWith("opa_")),
  );

  const missing = [...registered].filter((n) => !documented.has(n)).sort();
  const unknown = [...documented].filter((n) => !registered.has(n)).sort();
  if (missing.length || unknown.length) {
    console.error("DRIFT: README tool tables do not match registered tools");
    for (const n of missing) console.error(`  - registered but not in README: ${n}`);
    for (const n of unknown) console.error(`  - in README but not registered: ${n}`);
    process.exitCode = 1;
  } else {
    console.log(`OK README documents all ${registered.size} registered tools.`);
  }
} catch (error) {
  console.error(`CANNOT CHECK: ${error?.message ?? error}`);
  process.exitCode = 2;
}
