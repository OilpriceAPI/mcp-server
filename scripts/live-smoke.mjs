#!/usr/bin/env node

/**
 * Live smoke test against the real OilPriceAPI.
 *
 * Verifies the futures path fix (v2.2.1) end-to-end:
 *   - GET /v1/futures/ice-brent          (latest)  -> 200 + contracts[]
 *   - GET /v1/futures/ice-brent/curve    (curve)   -> 200 + contracts[]
 *
 * These are the paths the MCP tools build (opa_get_futures /
 * opa_get_futures_curve). The old v2.2.0 code hit
 * /v1/futures/latest?contract=BZ and /v1/futures/curve?contract=BZ which
 * both 404 — there is no generic ?contract= futures route.
 *
 * Auth: OILPRICEAPI_TEST_KEY (Bearer). SKIPS cleanly (exit 0) if absent so
 * forks / contributors without the secret are not blocked.
 *
 * Rate limit: the API allows 1 req/sec, so calls are spaced >= 1.1s apart.
 */

const API_BASE =
  process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
const KEY = process.env.OILPRICEAPI_TEST_KEY;
const SLUG = "ice-brent";
const RATE_LIMIT_MS = 1100; // > 1 req/sec

if (!KEY) {
  console.log(
    "SKIP: OILPRICEAPI_TEST_KEY not set — skipping live smoke test (this is OK for forks).",
  );
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
      "User-Agent": "oilpriceapi-mcp-live-smoke/2.2.1",
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function main() {
  let failures = 0;

  // 1. Latest — GET /v1/futures/{slug}
  try {
    const { status, body } = await getJson(`/v1/futures/${SLUG}`);
    assert(status === 200, `latest expected 200, got ${status}`);
    assert(
      Array.isArray(body?.contracts) && body.contracts.length > 0,
      "latest expected non-empty contracts[]",
    );
    const front = body.front_month ?? body.contracts[0];
    assert(
      typeof front.contract_month === "string",
      "latest contract missing contract_month",
    );
    assert(
      typeof front.last_price === "number",
      "latest contract missing numeric last_price",
    );
    console.log(
      `PASS: GET /v1/futures/${SLUG} -> 200, ${body.contracts.length} contracts, front ${front.contract_month} @ $${front.last_price}`,
    );
  } catch (err) {
    failures++;
    console.error(`FAIL (latest): ${err.message}`);
  }

  // Space requests — API rate limit is 1 req/sec.
  await sleep(RATE_LIMIT_MS);

  // 2. Curve — GET /v1/futures/{slug}/curve
  try {
    const { status, body } = await getJson(`/v1/futures/${SLUG}/curve`);
    assert(status === 200, `curve expected 200, got ${status}`);
    assert(
      Array.isArray(body?.contracts) && body.contracts.length > 0,
      "curve expected non-empty contracts[]",
    );
    const c = body.contracts[0];
    assert(
      typeof c.contract_month === "string",
      "curve contract missing contract_month",
    );
    assert(
      typeof c.settlement_price === "number",
      "curve contract missing numeric settlement_price",
    );
    console.log(
      `PASS: GET /v1/futures/${SLUG}/curve -> 200, ${body.contracts.length} contracts, type ${body.curve_type ?? "n/a"}`,
    );
  } catch (err) {
    failures++;
    console.error(`FAIL (curve): ${err.message}`);
  }

  if (failures > 0) {
    console.error(`\nLive smoke test FAILED (${failures} failure(s)).`);
    process.exit(1);
  }
  console.log("\nLive smoke test PASSED.");
}

main().catch((err) => {
  console.error(`Live smoke test crashed: ${err.message}`);
  process.exit(1);
});
