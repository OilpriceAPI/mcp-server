#!/usr/bin/env node

// Live contract run against production for every published tool.
//
// Exit codes follow scripts/commodity-identity-invariant.mjs:
//   0  every contract checked and passed
//   1  a contract failed (wrong status, wrong envelope, a field the formatter
//      reads is missing, a tool answered with an error)
//   2  the run could not check (no key, network error, preflight failure).
//      Never 0: a check that silently skips is indistinguishable from a pass.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateLiveContractMatrix } from "./generate-live-contract-matrix.mjs";
import { checkToolFields } from "./live-contract-fields.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsPath = resolve(root, "artifacts/live-contract-results.json");
const apiBase = process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
const key = process.env.OILPRICEAPI_TEST_KEY;
const keyRequired = process.env.OILPRICEAPI_LIVE_REQUIRED === "1";
const writesRequired = process.env.SMOKE_WRITE_CONTRACTS === "1";
const rateLimitMs = Number(process.env.OILPRICEAPI_LIVE_RATE_LIMIT_MS || 1100);
// Captured before any handler runs: the field check swaps globalThis.fetch for
// a tracing shim while a handler executes, and pass-through requests must not
// loop back into it.
const networkFetch = globalThis.fetch;
const OUTCOMES = ["passed", "covered-plan-gate", "non-network", "failed", "cannot-check"];
let matrix;
let registeredTools;
const results = [];
let lastRequestAt = 0;

class CannotCheckError extends Error {}

function record(tool, outcome, detail, extra = {}) {
  results.push({ tool, outcome, detail, ...extra });
  const stream = ["failed", "cannot-check"].includes(outcome) ? process.stderr : process.stdout;
  stream.write(`${outcome.toUpperCase()}: ${tool} — ${detail}\n`);
}

function writeResults() {
  const summary = Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, results.filter((result) => result.outcome === outcome).length]),
  );
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(
    resultsPath,
    `${JSON.stringify({ schemaVersion: "1.0.0", source: matrix?.source ?? null, summary, results }, null, 2)}\n`,
  );
  return summary;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pace() {
  const remaining = rateLimitMs - (Date.now() - lastRequestAt);
  if (remaining > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
}

async function pacedNetworkFetch(input, init) {
  try {
    return await networkFetch(input, init);
  } finally {
    lastRequestAt = Date.now();
  }
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  await pace();
  let response;
  let text;
  try {
    response = await networkFetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "oilpriceapi-mcp-live-contracts/3.2.4",
        "X-OPA-Source": "mcp-live-contracts",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await response.text();
  } catch (error) {
    throw new CannotCheckError(`network error on ${method} ${path}: ${error.message}`);
  } finally {
    lastRequestAt = Date.now();
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

function validateShape(shape, body) {
  assert(body !== null && typeof body === "object", "response body is not JSON object/array");
  if (shape === "array") {
    assert(Array.isArray(body), "expected a top-level array");
    return;
  }
  if (shape === "success-envelope") {
    assert(!Array.isArray(body), "expected an object envelope");
    assert(body.status === "success", `expected status=success, received ${String(body.status)}`);
    assert(body.data !== undefined && body.data !== null, "success envelope is missing data");
    return;
  }
  if (shape === "data-envelope") {
    assert(!Array.isArray(body), "expected an object envelope");
    assert(body.data !== undefined && body.data !== null, "data envelope is missing data");
    return;
  }
  if (shape === "futures-latest") {
    const front = body.front_month ?? body.contracts?.[0];
    assert(front && Number.isFinite(front.last_price), "futures response has no numeric front-month last_price");
    return;
  }
  if (shape === "futures-curve") {
    if (typeof body.error === "string") {
      assert(/no futures data available/i.test(body.error), `unexpected curve error: ${body.error}`);
    } else {
      assert(Array.isArray(body.contracts) && body.contracts.length > 0, "curve response has no contracts");
    }
    return;
  }
  if (shape === "subscriptions") {
    const subscriptions = body.subscriptions ?? body.data?.subscriptions;
    assert(Array.isArray(subscriptions), "subscription response has no subscriptions array");
    return;
  }
  if (shape === "events") {
    assert(Array.isArray(body.data?.events), "events response has no data.events array");
    return;
  }
  throw new Error(`unknown response shape ${shape}`);
}

async function quotaPreflight(expectedRequests) {
  const response = await request("/v1/account");
  assert(response.status === 200, `quota preflight returned HTTP ${response.status}`);
  const account = response.body?.account;
  assert(account && typeof account === "object", "quota preflight has no account object");
  const remaining = Number(account.remaining_requests);
  assert(Number.isFinite(remaining), "quota preflight has no numeric remaining_requests");
  assert(remaining >= expectedRequests, `quota has ${remaining} requests left; ${expectedRequests} required`);
  process.stdout.write(
    `PREFLIGHT: ${account.tier ?? "unknown"} plan, ${account.usage_this_month}/${account.effective_request_limit ?? account.request_limit} used, ${remaining} remaining.\n`,
  );
}

async function loadRegisteredTools() {
  if (registeredTools) return registeredTools;
  // The built server reads its key and base URL from the environment. Point
  // it at the same key and API the envelope check used.
  process.env.OILPRICEAPI_KEY = key;
  process.env.OILPRICEAPI_BASE_URL = apiBase;
  const built = await import(pathToFileURL(resolve(root, "build/index.js")).href);
  registeredTools = {
    tools: built.createSandboxServer()._registeredTools,
    notReported: built.NOT_REPORTED,
  };
  return registeredTools;
}

// #118: the envelope says nothing about the fields the formatter reads. Run the
// tool's real handler over the live response and fail on any field it read
// that the response lacks, when the answer shows that absence.
async function checkFormatterFields(contract, response) {
  const { tools, notReported } = await loadRegisteredTools();
  const registered = tools[contract.name];
  assert(registered && typeof registered.handler === "function", `${contract.name} is not a registered tool`);
  const fields = await checkToolFields({
    tool: contract.name,
    handler: registered.handler,
    args: contract.args,
    contractPath: contract.path,
    contractResponse: { status: response.status, text: response.text, headers: response.headers },
    apiBase,
    fetchImpl: pacedNetworkFetch,
    notReported,
    beforeRequest: pace,
  });
  if (!fields.ok) throw new Error(`field contract: ${fields.reason}`);
  return fields;
}

async function checkRead(contract) {
  if (contract.shape === "well-lifecycle-lookup") {
    const discovery = await request(
      "/v1/well-lifecycle/states/TX?api_limit=1000&sample_limit=10",
      { headers: { "X-OPA-Tool": contract.name } },
    );
    assert(discovery.status === 200, `fixture discovery returned HTTP ${discovery.status}`);
    const apiNumber = discovery.body?.data?.samples?.lifecycle_smoke_candidates?.[0]?.api_number;
    assert(apiNumber, "fixture discovery returned no lifecycle_smoke_candidates API number");
    const path = `/v1/well-lifecycle/wells/${encodeURIComponent(apiNumber)}?state=TX`;
    const response = await request(path, { headers: { "X-OPA-Tool": contract.name } });
    if ([401, 404].includes(response.status)) throw new Error(`HTTP ${response.status} is never skippable`);
    if ([402, 403].includes(response.status)) {
      if (contract.entitlement !== "conditional") throw new Error(`unexpected HTTP ${response.status}`);
      record(contract.name, "covered-plan-gate", `HTTP ${response.status}`, { method: "GET", path });
      return;
    }
    assert(response.status === 200, `expected HTTP 200, received ${response.status}`);
    validateShape("data-envelope", response.body);
    record(contract.name, "passed", "discovered promoted sample returned HTTP 200 data-envelope", {
      method: "GET",
      path: contract.path,
    });
    return;
  }
  const response = await request(contract.path, {
    headers: { "X-OPA-Tool": contract.name },
  });
  if ([401, 404].includes(response.status)) throw new Error(`HTTP ${response.status} is never skippable`);
  if ([402, 403].includes(response.status)) {
    if (contract.entitlement !== "conditional") {
      throw new Error(`unexpected HTTP ${response.status} for ungated contract`);
    }
    record(contract.name, "covered-plan-gate", `HTTP ${response.status}`, {
      method: contract.method,
      path: contract.path,
    });
    return;
  }
  assert(response.status === 200, `expected HTTP 200, received ${response.status}`);
  validateShape(contract.shape, response.body);
  if (contract.shape !== "success-envelope") {
    record(contract.name, "passed", `HTTP 200 ${contract.shape}`, {
      method: contract.method,
      path: contract.path,
    });
    return;
  }
  const fields = await checkFormatterFields(contract, response);
  const tolerated = fields.absentKeys.length
    ? `; optional keys absent and not rendered as missing: ${fields.absentKeys.slice(0, 10).join(", ")}${fields.absentKeys.length > 10 ? ` (+${fields.absentKeys.length - 10} more)` : ""}`
    : "";
  record(contract.name, "passed", `HTTP 200 ${contract.shape}; formatter fields present${tolerated}`, {
    method: contract.method,
    path: contract.path,
    requested: fields.requested,
    toleratedAbsentKeys: fields.absentKeys,
  });
}

async function deleteAndVerify({ tool, collectionPath, id }) {
  const deleted = await request(`${collectionPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
  assert([200, 204].includes(deleted.status), `cleanup DELETE returned HTTP ${deleted.status}`);
  const listed = await request(collectionPath);
  assert(listed.status === 200, `cleanup verification returned HTTP ${listed.status}`);
  const records = Array.isArray(listed.body)
    ? listed.body
    : listed.body?.subscriptions ?? listed.body?.data?.subscriptions ?? [];
  assert(!records.some((recordItem) => String(recordItem.id) === String(id)), "synthetic record leaked after cleanup");
  record(tool, "passed", "DELETE cleanup verified record absent", {
    method: "DELETE",
    path: `${collectionPath}/:id`,
  });
}

async function priceAlertLifecycle() {
  let id;
  try {
    const created = await request("/v1/alerts", {
      method: "POST",
      headers: { "X-OPA-Tool": "opa_create_price_alert" },
      body: {
        price_alert: {
          name: `mcp-live-contract-${Date.now()}`,
          commodity_code: "BRENT_CRUDE_USD",
          condition_operator: "greater_than",
          condition_value: 1000000,
          metadata: { source: "mcp-live-contracts", synthetic: true },
        },
      },
    });
    assert([200, 201].includes(created.status), `create alert returned HTTP ${created.status}`);
    id = created.body?.id;
    assert(id, "create alert did not return id");
    record("opa_create_price_alert", "passed", "synthetic alert created", { method: "POST", path: "/v1/alerts" });

    const listed = await request("/v1/alerts");
    assert(listed.status === 200 && Array.isArray(listed.body), "list alerts did not return HTTP 200 array");
    assert(listed.body.some((alert) => String(alert.id) === String(id)), "synthetic alert missing from list");
    for (const tool of ["opa_list_price_alerts", "opa_get_alert_triggers"]) {
      record(tool, "passed", "synthetic alert visible in account-scoped list", { method: "GET", path: "/v1/alerts" });
    }
  } finally {
    if (id) await deleteAndVerify({ tool: "opa_delete_price_alert", collectionPath: "/v1/alerts", id });
  }
}

async function subscriptionLifecycle() {
  let id;
  try {
    const created = await request("/v1/subscriptions", {
      method: "POST",
      headers: { "X-OPA-Tool": "opa_create_price_subscription" },
      body: { codes: ["BRENT_CRUDE_USD"], interval_seconds: 3600, name: `mcp-live-contract-${Date.now()}` },
    });
    assert([200, 201].includes(created.status), `create subscription returned HTTP ${created.status}`);
    id = created.body?.subscription?.id ?? created.body?.data?.subscription?.id;
    assert(id, "create subscription did not return subscription.id");
    record("opa_create_price_subscription", "passed", "synthetic subscription created", { method: "POST", path: "/v1/subscriptions" });

    const listed = await request("/v1/subscriptions");
    const subscriptions = listed.body?.subscriptions ?? listed.body?.data?.subscriptions;
    assert(listed.status === 200 && Array.isArray(subscriptions), "list subscriptions did not return an array");
    assert(subscriptions.some((subscription) => String(subscription.id) === String(id)), "synthetic subscription missing from list");
    record("opa_list_subscriptions", "passed", "synthetic subscription visible in account-scoped list", { method: "GET", path: "/v1/subscriptions" });

    const events = await request("/v1/subscriptions/events?since=0");
    assert(events.status === 200, `subscription events returned HTTP ${events.status}`);
    validateShape("events", events.body);
    record("opa_get_subscription_events", "passed", "event envelope validated", { method: "GET", path: "/v1/subscriptions/events?since=0" });
  } finally {
    if (id) await deleteAndVerify({ tool: "opa_delete_subscription", collectionPath: "/v1/subscriptions", id });
  }
}

function outcomeFor(error) {
  return error instanceof CannotCheckError ? "cannot-check" : "failed";
}

async function main() {
  if (!key) {
    // Protected main sets OILPRICEAPI_LIVE_REQUIRED=1: no key there is a run
    // that checked nothing, so it exits 2. Local and pull-request runs, which
    // deliberately receive no secret, keep the explicit SKIP.
    if (keyRequired) throw new CannotCheckError("OILPRICEAPI_TEST_KEY is required; no contract was checked");
    process.stdout.write("SKIP: OILPRICEAPI_TEST_KEY not set.\n");
    return;
  }

  matrix = generateLiveContractMatrix();
  for (const contract of matrix.tools.filter(({ mode }) => mode === "non-network")) {
    record(contract.name, "non-network", `${contract.classification}: ${contract.reason}`);
  }

  const reads = matrix.tools.filter(
    ({ mode, lifecycle }) => mode === "network-read" && !["price-alert", "subscription"].includes(lifecycle),
  );
  // Field checks reuse each contract response; the handlers' secondary calls
  // (a comparison leg, a state-health gate) are budgeted at one per read.
  const expectedRequests = reads.length * 2 + (writesRequired ? 12 : 1) + 2;
  try {
    await quotaPreflight(expectedRequests);
  } catch (error) {
    throw new CannotCheckError(`preflight: ${error.message}`);
  }
  for (const contract of reads) {
    try {
      await checkRead(contract);
    } catch (error) {
      record(contract.name, outcomeFor(error), error.message, { method: contract.method, path: contract.path });
    }
  }

  if (!writesRequired) throw new Error("SMOKE_WRITE_CONTRACTS=1 is required to cover stateful tools");
  for (const [label, lifecycle] of [["price-alert", priceAlertLifecycle], ["subscription", subscriptionLifecycle]]) {
    try {
      await lifecycle();
    } catch (error) {
      const lifecycleTools = matrix.tools.filter((tool) => tool.lifecycle === label);
      for (const tool of lifecycleTools.filter((candidate) => !results.some((result) => result.tool === candidate.name))) {
        record(tool.name, outcomeFor(error), `${label} lifecycle: ${error.message}`);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  record("__runner__", outcomeFor(error), error.message);
} finally {
  let summary = writeResults();
  const expectedTools = new Set(matrix?.tools.map(({ name }) => name) ?? []);
  const reportedTools = new Set(results.filter(({ tool }) => tool !== "__runner__").map(({ tool }) => tool));
  const missing = [...expectedTools].filter((tool) => !reportedTools.has(tool));
  if (missing.length) {
    // Tools left unchecked because the runner could not check are a
    // cannot-check, not a contract failure; anything else is a failure.
    const runnerCannotCheck = results.some(({ tool, outcome }) => tool === "__runner__" && outcome === "cannot-check");
    record("__runner__", runnerCannotCheck ? "cannot-check" : "failed", `tools missing results: ${missing.join(", ")}`);
  }
  summary = writeResults();
  if (summary.failed > 0) {
    process.stderr.write(`Live contracts FAILED: ${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  } else if (summary["cannot-check"] > 0) {
    process.stderr.write(`Live contracts COULD NOT CHECK (exit 2, not a pass): ${JSON.stringify(summary)}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`Live contracts PASSED: ${JSON.stringify(summary)}\n`);
  }
}
