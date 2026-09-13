#!/usr/bin/env node

// Checks capability-ledger.json against the live OpenAPI contract, the
// registered tools (build/capabilities.json) and the REST paths src/index.ts
// calls. Exit 0 = consistent, 1 = drift, 2 = cannot check or stale.
// Requires `npm run build` first.

import { runCheck } from "./capability-ledger.mjs";

try {
  const { exitCode, lines } = await runCheck(process.argv.slice(2));
  (exitCode === 0 ? console.log : console.error)(lines.join("\n"));
  process.exitCode = exitCode;
} catch (error) {
  console.error(`CANNOT CHECK: ${error?.stack ?? error}`);
  process.exitCode = 2;
}
