// API-to-MCP capability ledger (#77).
//
// capability-ledger.json records a decision for every operation in the
// published OilPriceAPI OpenAPI contract: the MCP tool(s) that expose it, or
// an explicit not_exposed disposition with a reason. This module checks that
// record against three primary sources, never against a second hand-written
// list:
//
//   1. the live OpenAPI document the API serves (DEFAULT_SPEC_URL),
//   2. the registered tools (build/capabilities.json, generated from the same
//      server instance tools/list uses),
//   3. the REST paths the MCP source actually calls (src/index.ts).
//
// A check that cannot read a source reports CANNOT CHECK and exits 2. It never
// passes silently.

import { readFile } from "node:fs/promises";

export const DEFAULT_SPEC_URL = "https://api.oilpriceapi.com/openapi.json";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const OPERATION_STATUSES = ["exposed", "not_exposed"];
const FAMILY_STATUSES = ["exposed", "partial", "not_exposed"];
export const DISPOSITIONS = [
  "selected",
  "deferred",
  "alias",
  "unsupported",
  "internal",
];
export const SELECTION_REQUIREMENTS = [
  "input-schema",
  "entitlement-behavior",
  "unit-tests",
  "live-contract-entry",
];
// The families #77 names explicitly. Removing one needs a ledger decision,
// not a silent deletion.
export const REQUIRED_FAMILY_IDS = [
  "natural-gas-fundamentals",
  "futures-expanded",
  "gasoil-crack",
  "marine",
  "macro-calendar",
  "well-lifecycle",
  "subscription-lifecycle",
  "spreads",
  "indicators",
  "forecasts",
];

const DAY_MS = 86_400_000;
const WILDCARD = "{*}";

export class SourceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

function parseJson(text, origin) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceUnavailableError(`${origin} did not return valid JSON.`);
  }
}

export function extractOperations(spec) {
  if (
    !spec ||
    typeof spec !== "object" ||
    !spec.paths ||
    typeof spec.paths !== "object"
  ) {
    throw new SourceUnavailableError(
      "OpenAPI document has no paths object.",
    );
  }
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if (item && typeof item === "object" && item[method]) {
        operations.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  if (operations.length === 0) {
    throw new SourceUnavailableError(
      "OpenAPI document declares zero operations.",
    );
  }
  return operations.sort();
}

export async function loadSpec({
  url = DEFAULT_SPEC_URL,
  file,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  if (file) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new SourceUnavailableError(
        `Cannot read OpenAPI file ${file}: ${error.message}`,
      );
    }
    return { origin: file, spec: parseJson(text, file) };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.message ?? String(error);
    throw new SourceUnavailableError(
      `OpenAPI source ${url} is unreachable: ${cause}`,
    );
  }
  if (!response.ok) {
    throw new SourceUnavailableError(
      `OpenAPI source ${url} returned HTTP ${response.status}.`,
    );
  }
  return { origin: url, spec: parseJson(await response.text(), url) };
}

// Every "/v1/..." literal in the MCP source, normalized: interpolations become
// {*}, query strings are dropped. `${API_BASE}/v1/...` is included.
export function extractSourcePaths(sourceText) {
  const found = new Set();
  for (const match of sourceText.matchAll(/["'`}](\/v1\/[^"'`\s]*)/g)) {
    let path = match[1].replace(/\$\{[^}]*\}/g, WILDCARD);
    const unterminated = path.indexOf("${");
    if (unterminated !== -1) path = `${path.slice(0, unterminated)}${WILDCARD}`;
    const query = path.indexOf("?");
    if (query !== -1) path = path.slice(0, query);
    path = path.replace(/\/+$/, "");
    if (path.length > "/v1".length) found.add(path);
  }
  return [...found].sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Does a normalized source path reach a target path (an OpenAPI template or a
// literal `via` path)? A source path ending in a bare {*} segment is a base
// URL the code extends (`${base}/latest`), so it also reaches deeper paths.
export function sourcePathCovers(sourcePath, targetPath) {
  const source = sourcePath.split("/");
  const target = targetPath.split("/");
  const extendsBase = source.at(-1) === WILDCARD;
  if (target.length < source.length) return false;
  if (target.length > source.length && !extendsBase) return false;
  return source.every((segment, index) => {
    const candidate = target[index];
    if (/^\{[^}]+\}$/.test(candidate)) return true;
    const pattern = segment.split(WILDCARD).map(escapeRegExp).join("[^/]*");
    return new RegExp(`^${pattern}$`).test(candidate);
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateLedger({
  ledger,
  operations,
  manifest,
  sourceText,
  catalog = {},
  now = new Date(),
}) {
  const errors = [];
  const stale = [];
  const registered = new Set(manifest.tools.map((tool) => tool.name));
  const named = new Set();

  const noteTool = (tool, where) => {
    named.add(tool);
    if (!registered.has(tool)) {
      errors.push(`${where}: ${tool} is not a registered MCP tool.`);
    }
  };

  if (ledger.schemaVersion !== "1.0.0") {
    errors.push('schemaVersion must be "1.0.0".');
  }
  if (!Number.isInteger(ledger.ledgerVersion) || ledger.ledgerVersion < 1) {
    errors.push("ledgerVersion must be a positive integer.");
  }
  const lastChange = Array.isArray(ledger.changes)
    ? ledger.changes.at(-1)
    : undefined;
  if (!lastChange || lastChange.ledgerVersion !== ledger.ledgerVersion) {
    errors.push(
      `changes: the last entry must record ledgerVersion ${ledger.ledgerVersion} so release notes can link the change.`,
    );
  }

  // Families: named workflow groups, including live API families that are not
  // in canonical OpenAPI (route-policy prefixes the MCP server still calls).
  const families = Array.isArray(ledger.families) ? ledger.families : [];
  const familyIds = new Set();
  for (const family of families) {
    const where = `family ${family.id ?? "(missing id)"}`;
    if (!isNonEmptyString(family.id)) errors.push(`${where}: id is required.`);
    if (familyIds.has(family.id)) errors.push(`${where}: duplicate id.`);
    familyIds.add(family.id);
    if (!isNonEmptyString(family.title)) errors.push(`${where}: title is required.`);
    if (!isNonEmptyString(family.owner)) errors.push(`${where}: owner is required.`);
    if (!isNonEmptyString(family.reason)) errors.push(`${where}: reason is required.`);
    if (!FAMILY_STATUSES.includes(family.status)) {
      errors.push(`${where}: status must be one of ${FAMILY_STATUSES.join(", ")}.`);
    }
    const tools = family.tools ?? [];
    if (family.status !== "not_exposed" && tools.length === 0) {
      errors.push(`${where}: ${family.status} requires at least one tool.`);
    }
    if (family.status === "not_exposed" && tools.length > 0) {
      errors.push(`${where}: not_exposed families name no tools.`);
    }
    for (const tool of tools) noteTool(tool, where);
    for (const prefix of family.pathPrefixes ?? []) {
      if (!/^\/v1\/\S+$/.test(prefix.prefix ?? "") || !isNonEmptyString(prefix.audience)) {
        errors.push(`${where}: pathPrefixes entries need a /v1/ prefix and an audience.`);
      }
    }
  }
  for (const id of REQUIRED_FAMILY_IDS) {
    if (!familyIds.has(id)) {
      errors.push(`family ${id} is required by #77 and is missing.`);
    }
  }

  // Operations: exactly one row per published operation.
  const rows = new Map();
  for (const row of Array.isArray(ledger.operations) ? ledger.operations : []) {
    const label = row.operation;
    if (!/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(label ?? "")) {
      errors.push(`operation "${label}" must look like "GET /v1/path".`);
      continue;
    }
    if (rows.has(label)) errors.push(`${label}: duplicate ledger row.`);
    rows.set(label, row);
    if (!familyIds.has(row.family)) {
      errors.push(`${label}: family "${row.family}" is not defined.`);
    }
    if (!isNonEmptyString(row.owner)) errors.push(`${label}: owner is required.`);
    if (row.status === "exposed") {
      if (!row.tools?.length) errors.push(`${label}: exposed requires at least one tool.`);
      if (row.disposition) errors.push(`${label}: exposed rows carry no disposition.`);
      for (const tool of row.tools ?? []) noteTool(tool, label);
    } else if (row.status === "not_exposed") {
      if (!DISPOSITIONS.includes(row.disposition)) {
        errors.push(`${label}: not_exposed requires a disposition (${DISPOSITIONS.join(", ")}).`);
      }
      if (!isNonEmptyString(row.reason)) errors.push(`${label}: not_exposed requires a reason.`);
      if (row.tools?.length) errors.push(`${label}: not_exposed rows name no tools.`);
    } else {
      errors.push(`${label}: status must be one of ${OPERATION_STATUSES.join(", ")}.`);
    }
  }

  const published = new Set(operations);
  for (const operation of operations) {
    if (!rows.has(operation)) {
      errors.push(
        `${operation} is published by the API but has no ledger row. Decide: expose it, or add {"operation": "${operation}", "family": "…", "status": "not_exposed", "disposition": "deferred", "owner": "mcp-server", "reason": "…"}.`,
      );
    }
  }
  for (const operation of rows.keys()) {
    if (!published.has(operation)) {
      errors.push(
        `${operation} has a ledger row but is no longer published by the API; remove or re-point the row.`,
      );
    }
  }

  for (const entry of Array.isArray(ledger.mcpOnlyTools) ? ledger.mcpOnlyTools : []) {
    noteTool(entry.tool, "mcpOnlyTools");
    if (!isNonEmptyString(entry.reason)) {
      errors.push(`mcpOnlyTools ${entry.tool}: reason is required.`);
    }
  }
  for (const tool of registered) {
    if (!named.has(tool)) {
      errors.push(
        `${tool} is registered but appears in no ledger row; record the operation or family it reaches.`,
      );
    }
  }

  // Source: what the MCP server really calls.
  const sourcePaths = extractSourcePaths(sourceText);
  const exposedTargets = [...rows.values()]
    .filter((row) => row.status === "exposed")
    .map((row) => ({
      label: row.operation,
      path: row.via ?? row.operation.split(" ")[1],
      via: row.via,
    }));
  for (const target of exposedTargets) {
    if (!sourcePaths.some((path) => sourcePathCovers(path, target.path))) {
      errors.push(
        `${target.label} is marked exposed but no MCP source call reaches it${target.via ? ` (via ${target.via})` : ""}.`,
      );
    }
  }
  const reachablePrefixes = families
    .filter((family) => family.status !== "not_exposed")
    .flatMap((family) => (family.pathPrefixes ?? []).map((entry) => entry.prefix));
  for (const path of sourcePaths) {
    const covered =
      exposedTargets.some((target) => sourcePathCovers(path, target.path)) ||
      reachablePrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
    if (!covered) {
      errors.push(
        `MCP source calls ${path} but the ledger records no exposed operation or reachable family prefix for it.`,
      );
    }
  }

  // Selections: the chosen additions and what each must ship with.
  const selections = Array.isArray(ledger.selections) ? ledger.selections : [];
  if (selections.length === 0) {
    errors.push("selections must list at least one selected workflow.");
  }
  const ranks = new Set();
  for (const selection of selections) {
    const where = `selection ${selection.rank}`;
    if (!Number.isInteger(selection.rank) || ranks.has(selection.rank)) {
      errors.push(`${where}: rank must be a unique integer.`);
    }
    ranks.add(selection.rank);
    if (!isNonEmptyString(selection.workflow)) errors.push(`${where}: workflow is required.`);
    if (!/^https:\/\/github\.com\/OilpriceAPI\/mcp-server\/issues\/\d+$/.test(selection.issue ?? "")) {
      errors.push(`${where}: issue must be a GitHub issue URL.`);
    }
    for (const requirement of SELECTION_REQUIREMENTS) {
      if (!(selection.requirements ?? []).includes(requirement)) {
        errors.push(`${where}: requirements must include ${requirement}.`);
      }
    }
    if (!selection.operations?.length) errors.push(`${where}: operations are required.`);
    for (const operation of selection.operations ?? []) {
      const row = rows.get(operation);
      if (!row) {
        errors.push(`${where}: ${operation} has no ledger row.`);
        continue;
      }
      if (row.selection !== selection.rank) {
        errors.push(`${where}: ${operation} must carry "selection": ${selection.rank}.`);
      }
      if (row.status === "not_exposed" && row.disposition !== "selected") {
        errors.push(`${where}: ${operation} is not exposed, so its disposition must be selected.`);
      }
      if (row.status === "exposed") {
        for (const tool of row.tools ?? []) {
          if (!Object.hasOwn(catalog, tool)) {
            errors.push(`${where}: ${tool} has no live-contract catalog entry.`);
          }
        }
      }
    }
  }
  for (const row of rows.values()) {
    if (row.disposition === "selected" && !ranks.has(row.selection)) {
      errors.push(`${row.operation}: disposition selected needs a matching selection rank.`);
    }
  }

  // Staleness of the route-policy snapshot behind families[].pathPrefixes.
  const policy = ledger.source?.routePolicy;
  if (
    !policy ||
    !/^[0-9a-f]{40}$/.test(policy.sourceCommit ?? "") ||
    Number.isNaN(Date.parse(policy.sourceCommitDate)) ||
    !(policy.maxAgeDays > 0)
  ) {
    errors.push(
      "source.routePolicy must record sourceCommit (40 hex), sourceCommitDate and maxAgeDays.",
    );
  } else {
    const ageDays = (now.getTime() - Date.parse(policy.sourceCommitDate)) / DAY_MS;
    if (ageDays > policy.maxAgeDays) {
      stale.push(
        `route-policy snapshot ${policy.repository}@${policy.sourceCommit.slice(0, 9)} is ${ageDays.toFixed(1)} days old (threshold ${policy.maxAgeDays}). Re-verify families[].pathPrefixes against ${policy.path} on main, then update sourceCommit and sourceCommitDate.`,
      );
    }
  }

  return { errors, stale, sourcePaths };
}

async function readJsonFile(url, missingMessage) {
  let text;
  try {
    text = await readFile(url, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new SourceUnavailableError(missingMessage);
    throw error;
  }
  return parseJson(text, url.pathname);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--spec-file", "--url", "--now"].includes(flag) || !value) {
      throw new SourceUnavailableError(
        `Unknown or incomplete argument ${flag}. Usage: check-capability-ledger [--url URL | --spec-file PATH] [--now ISO-8601]`,
      );
    }
    index += 1;
    if (flag === "--spec-file") options.specFile = value;
    if (flag === "--url") options.url = value;
    if (flag === "--now") {
      options.now = new Date(value);
      if (Number.isNaN(options.now.getTime())) {
        throw new SourceUnavailableError(`--now ${value} is not a date.`);
      }
    }
  }
  return options;
}

export async function runCheck(argv = [], deps = {}) {
  const root = new URL("..", import.meta.url);
  let context;
  try {
    const options = parseArgs(argv);
    const load = deps.loadSpec ?? loadSpec;
    const { origin, spec } = await load({ url: options.url, file: options.specFile });
    const operations = extractOperations(spec);
    const manifest = await (deps.readManifest ??
      (() =>
        readJsonFile(
          new URL("build/capabilities.json", root),
          "build/capabilities.json is missing; run npm run build first.",
        )))();
    if (!Array.isArray(manifest?.tools) || manifest.tools.length === 0) {
      throw new SourceUnavailableError("build/capabilities.json lists no tools.");
    }
    const ledger = await (deps.readLedger ??
      (() =>
        readJsonFile(
          new URL("capability-ledger.json", root),
          "capability-ledger.json is missing.",
        )))();
    const sourceText = await (deps.readSource ??
      (() => readFile(new URL("src/index.ts", root), "utf8")))();
    const catalog =
      deps.catalog ??
      (await import("./live-contract-catalog.mjs")).LIVE_CONTRACT_CATALOG;
    context = {
      origin,
      operations,
      manifest,
      ledger,
      result: evaluateLedger({
        ledger,
        operations,
        manifest,
        sourceText,
        catalog,
        now: options.now ?? deps.now ?? new Date(),
      }),
    };
  } catch (error) {
    return {
      exitCode: 2,
      lines: [
        `CANNOT CHECK: ${error.message}`,
        "A ledger check that cannot read its sources is a failure, not a pass.",
      ],
    };
  }

  const { origin, operations, manifest, ledger, result } = context;
  const rows = ledger.operations ?? [];
  const exposed = rows.filter((row) => row.status === "exposed").length;
  const selected = rows.filter((row) => row.disposition === "selected").length;
  const lines = [];
  if (result.errors.length > 0) {
    lines.push(`DRIFT: ${result.errors.length} problem(s) in capability-ledger.json`);
    for (const error of result.errors) lines.push(`  - ${error}`);
  }
  if (result.stale.length > 0) {
    lines.push("STALE: the ledger cannot be trusted until re-verified");
    for (const entry of result.stale) lines.push(`  - ${entry}`);
  }
  if (lines.length === 0) {
    lines.push(
      `OK capability ledger v${ledger.ledgerVersion}: ${operations.length} published operations from ${origin} ` +
        `(${exposed} exposed, ${rows.length - exposed} not exposed, ${selected} selected); ` +
        `${manifest.tools.length} registered tools; ${result.sourcePaths.length} REST paths called by src/index.ts.`,
    );
  }
  return {
    exitCode: result.errors.length > 0 ? 1 : result.stale.length > 0 ? 2 : 0,
    lines,
  };
}
