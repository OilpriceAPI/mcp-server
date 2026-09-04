#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLiveContractMatrix } from "./generate-live-contract-matrix.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsPath = resolve(root, "artifacts/live-contract-results.json");
const apiBase = process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
const key = process.env.OILPRICEAPI_TEST_KEY;
const keyRequired = process.env.OILPRICEAPI_LIVE_REQUIRED === "1";
const writesRequired = process.env.SMOKE_WRITE_CONTRACTS === "1";
const rateLimitMs = Number(process.env.OILPRICEAPI_LIVE_RATE_LIMIT_MS || 1100);
let matrix;
const results = [];
let lastRequestAt = 0;

function record(tool, outcome, detail, extra = {}) {
  results.push({ tool, outcome, detail, ...extra });
  const stream = outcome === "failed" ? process.stderr : process.stdout;
  stream.write(`${outcome.toUpperCase()}: ${tool} — ${detail}\n`);
}

function writeResults() {
  const summary = Object.fromEntries(
    ["passed", "covered-plan-gate", "non-network", "failed"].map((outcome) => [
      outcome,
      results.filter((result) => result.outcome === outcome).length,
    ]),
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

async function request(path, { method = "GET", body, headers = {} } = {}) {
  await pace();
  const response = await fetch(`${apiBase}${path}`, {
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
  lastRequestAt = Date.now();
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
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

async function checkRead(contract) {
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
  record(contract.name, "passed", `HTTP 200 ${contract.shape}`, {
    method: contract.method,
    path: contract.path,
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
    id = created.body?.subscription?.id;
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

async function main() {
  if (!key) {
    if (keyRequired) throw new Error("OILPRICEAPI_TEST_KEY is required");
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
  const expectedRequests = reads.length + (writesRequired ? 12 : 1) + 2;
  await quotaPreflight(expectedRequests);
  for (const contract of reads) {
    try {
      await checkRead(contract);
    } catch (error) {
      record(contract.name, "failed", error.message, { method: contract.method, path: contract.path });
    }
  }

  if (!writesRequired) throw new Error("SMOKE_WRITE_CONTRACTS=1 is required to cover stateful tools");
  for (const [label, lifecycle] of [["price-alert", priceAlertLifecycle], ["subscription", subscriptionLifecycle]]) {
    try {
      await lifecycle();
    } catch (error) {
      const lifecycleTools = matrix.tools.filter((tool) => tool.lifecycle === label);
      for (const tool of lifecycleTools.filter((candidate) => !results.some((result) => result.tool === candidate.name))) {
        record(tool.name, "failed", `${label} lifecycle: ${error.message}`);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  record("__runner__", "failed", error.message);
} finally {
  let summary = writeResults();
  const expectedTools = new Set(matrix?.tools.map(({ name }) => name) ?? []);
  const reportedTools = new Set(results.filter(({ tool }) => tool !== "__runner__").map(({ tool }) => tool));
  const missing = key
    ? [...expectedTools].filter((tool) => !reportedTools.has(tool))
    : [];
  if (missing.length) record("__runner__", "failed", `tools missing results: ${missing.join(", ")}`);
  summary = writeResults();
  if (summary.failed > 0 || missing.length > 0) {
    process.stderr.write(`Live contracts FAILED: ${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Live contracts PASSED: ${JSON.stringify(summary)}\n`);
  }
}
