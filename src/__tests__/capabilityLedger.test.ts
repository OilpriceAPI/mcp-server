import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSandboxServer } from "../index.js";
import { buildCapabilityManifest } from "../toolRegistry.js";
import {
  evaluateLedger,
  extractOperations,
  extractSourcePaths,
  loadSpec,
  REQUIRED_FAMILY_IDS,
  runCheck,
  SourceUnavailableError,
} from "../../scripts/capability-ledger.mjs";
import { LIVE_CONTRACT_CATALOG } from "../../scripts/live-contract-catalog.mjs";

// #77: every REST operation in the published OpenAPI contract has an explicit
// MCP decision, and the check fails visibly when it cannot verify that.

const ledger = JSON.parse(
  readFileSync(new URL("../../capability-ledger.json", import.meta.url), "utf8"),
);
const sourceText = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

const manifest = buildCapabilityManifest(createSandboxServer(), {
  name: "oilpriceapi-mcp",
  version: "0.0.0-test",
  minimumNodeVersion: ">=18.0.0",
  repository: "https://github.com/OilpriceAPI/mcp-server",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-09-13T00:00:00.000Z",
});

const ledgerOperations: string[] = ledger.operations.map(
  (row: { operation: string }) => row.operation,
);
const freshNow = new Date(
  Date.parse(ledger.source.routePolicy.sourceCommitDate) + 86_400_000,
);

function specFor(operations: string[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const [method, path] = operation.split(" ");
    paths[path] ??= {};
    paths[path][method.toLowerCase()] = { responses: {} };
  }
  return { openapi: "3.0.3", paths };
}

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateLedger({
    ledger,
    operations: ledgerOperations,
    manifest,
    sourceText,
    catalog: LIVE_CONTRACT_CATALOG,
    now: freshNow,
    ...overrides,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("capability ledger", () => {
  it("the committed ledger agrees with the registered tools and the MCP source", () => {
    const result = evaluate();
    expect(result.errors).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("covers every registered tool from the build manifest", () => {
    const named = new Set<string>([
      ...ledger.operations.flatMap((row: { tools?: string[] }) => row.tools ?? []),
      ...ledger.families.flatMap((row: { tools?: string[] }) => row.tools ?? []),
      ...ledger.mcpOnlyTools.map((row: { tool: string }) => row.tool),
    ]);
    for (const tool of manifest.tools) expect(named).toContain(tool.name);
  });

  it("seeds every family #77 names", () => {
    const ids = ledger.families.map((family: { id: string }) => family.id);
    for (const id of REQUIRED_FAMILY_IDS) expect(ids).toContain(id);
  });

  it("fails when the API publishes an operation the ledger has no decision for", () => {
    const result = evaluate({
      operations: [...ledgerOperations, "GET /v1/brand-new-family"],
    });
    expect(result.errors.join("\n")).toContain(
      "GET /v1/brand-new-family is published by the API but has no ledger row",
    );
  });

  it("fails when a ledger row names an operation the API no longer publishes", () => {
    const result = evaluate({
      operations: ledgerOperations.filter((op) => op !== "GET /v1/prices/historical"),
    });
    expect(result.errors.join("\n")).toContain(
      "GET /v1/prices/historical has a ledger row but is no longer published",
    );
  });

  it("fails when a not_exposed row has no reason", () => {
    const broken = clone(ledger);
    const row = broken.operations.find(
      (entry: { status: string }) => entry.status === "not_exposed",
    );
    row.reason = "";
    const result = evaluate({ ledger: broken });
    expect(result.errors.join("\n")).toContain(`${row.operation}: not_exposed requires a reason`);
  });

  it("fails when an exposed row names a tool that is not registered", () => {
    const broken = clone(ledger);
    const row = broken.operations.find(
      (entry: { status: string }) => entry.status === "exposed",
    );
    row.tools = ["opa_does_not_exist"];
    const result = evaluate({ ledger: broken });
    expect(result.errors.join("\n")).toContain(
      "opa_does_not_exist is not a registered MCP tool",
    );
  });

  it("fails when a registered tool is missing from the ledger", () => {
    const extended = clone(manifest);
    extended.tools.push({ ...extended.tools[0], name: "opa_unlisted_tool" });
    const result = evaluate({ manifest: extended });
    expect(result.errors.join("\n")).toContain(
      "opa_unlisted_tool is registered but appears in no ledger row",
    );
  });

  it("fails when the MCP source calls a REST path the ledger does not record", () => {
    const result = evaluate({
      sourceText: `${sourceText}\nconst x = \`/v1/unrecorded/\${id}/thing\`;\n`,
    });
    expect(result.errors.join("\n")).toContain(
      "MCP source calls /v1/unrecorded/{*}/thing",
    );
  });

  it("fails when an exposed row is not reached by any MCP source call", () => {
    const broken = clone(ledger);
    const row = broken.operations.find(
      (entry: { operation: string }) => entry.operation === "GET /v1/prices/historical",
    );
    Object.assign(row, { status: "exposed", tools: ["opa_get_history"] });
    delete row.disposition;
    delete row.reason;
    delete row.selection;
    const result = evaluate({ ledger: broken });
    expect(result.errors.join("\n")).toContain(
      "GET /v1/prices/historical is marked exposed but no MCP source call reaches it",
    );
  });

  it("requires every selection to carry an issue and the #77 requirements", () => {
    const broken = clone(ledger);
    broken.selections[0].issue = "";
    broken.selections[1].requirements = ["unit-tests"];
    const errors = evaluate({ ledger: broken }).errors.join("\n");
    expect(errors).toContain("selection 1: issue must be a GitHub issue URL");
    expect(errors).toContain("selection 2: requirements must include input-schema");
  });

  it("reports the route-policy snapshot as stale past its age threshold", () => {
    const { maxAgeDays, sourceCommitDate } = ledger.source.routePolicy;
    const late = new Date(Date.parse(sourceCommitDate) + (maxAgeDays + 1) * 86_400_000);
    const result = evaluate({ now: late });
    expect(result.stale.join("\n")).toContain("route-policy snapshot");
  });
});

describe("OpenAPI source", () => {
  it("extracts METHOD /path operations and rejects a document without any", () => {
    expect(extractOperations(specFor(["POST /v1/a", "GET /v1/a"]))).toEqual([
      "GET /v1/a",
      "POST /v1/a",
    ]);
    expect(() => extractOperations({ openapi: "3.0.3", paths: {} })).toThrow(
      SourceUnavailableError,
    );
    expect(() => extractOperations("<html>not found</html>")).toThrow(
      SourceUnavailableError,
    );
  });

  it("treats an unreachable or non-200 source as unavailable, never as a pass", async () => {
    const refused = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(loadSpec({ url: "https://example.invalid/openapi.json", fetchImpl: refused })).rejects.toThrow(
      SourceUnavailableError,
    );
    const notFound = async () => new Response("{}", { status: 404 });
    await expect(loadSpec({ url: "https://example.invalid/openapi.json", fetchImpl: notFound })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("normalizes interpolated and query-bearing source paths", () => {
    const paths = extractSourcePaths(
      [
        "`/v1/prices/past_${period}?by_code=${code}`",
        "`/v1/subscriptions/events${qs ? `?${qs}` : \"\"}`",
        "`${API_BASE}/v1/demo/prices`",
        '"/v1/prices/latest?by_code=BRENT_CRUDE_USD"',
      ].join("\n"),
    );
    expect(paths).toEqual([
      "/v1/demo/prices",
      "/v1/prices/latest",
      "/v1/prices/past_{*}",
      "/v1/subscriptions/events{*}",
    ]);
  });
});

describe("check exit codes", () => {
  const deps = (spec: unknown) => ({
    loadSpec: async () => ({ origin: "fixture", spec }),
    readManifest: async () => manifest,
    readLedger: async () => ledger,
    readSource: async () => sourceText,
    catalog: LIVE_CONTRACT_CATALOG,
    now: freshNow,
  });

  it("exits 0 when the ledger matches the source", async () => {
    const result = await runCheck([], deps(specFor(ledgerOperations)));
    expect(result.exitCode).toBe(0);
  });

  it("exits 1 on drift", async () => {
    const result = await runCheck([], deps(specFor([...ledgerOperations, "GET /v1/new"])));
    expect(result.exitCode).toBe(1);
  });

  it("exits 2 when the source cannot be read", async () => {
    const result = await runCheck([], {
      ...deps(null),
      loadSpec: async () => {
        throw new SourceUnavailableError("OpenAPI source is unreachable");
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toContain("CANNOT CHECK");
  });

  it("exits 2 when the build manifest is missing", async () => {
    const result = await runCheck([], {
      ...deps(specFor(ledgerOperations)),
      readManifest: async () => {
        throw new SourceUnavailableError("build/capabilities.json is missing; run npm run build");
      },
    });
    expect(result.exitCode).toBe(2);
  });
});
