#!/usr/bin/env node

/**
 * Live smoke test against the real OilPriceAPI.
 *
 * Verifies the futures path fix (v2.2.1) end-to-end:
 *   - GET /v1/futures/ice-brent          (latest)  -> 200 + numeric front-month last_price
 *   - GET /v1/futures/ice-brent/curve    (curve)   -> 200 + curve data OR documented no-data state
 *
 * These are the paths the MCP tools build (opa_get_futures /
 * opa_get_futures_curve). The old v2.2.0 code hit
 * /v1/futures/latest?contract=BZ and /v1/futures/curve?contract=BZ which
 * both 404 — there is no generic ?contract= futures route.
 *
 * Tolerance: the curve endpoint can legitimately return a 200 with
 *   { "error": "No futures data available for curve analysis", "date": "..." }
 * when the underlying curve has no contracts yet. That is a valid no-data
 * state, NOT a failure — the smoke passes on it. The smoke only fails on a
 * real error: non-200 HTTP, an auth failure, or a malformed/unexpected body.
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
  // The API returns a top-level object: { front_month: { contract_month,
  // last_price, ... }, contracts: [...], ... }. The latest price the MCP tool
  // surfaces is front_month.last_price (falling back to contracts[0]). We only
  // require a numeric front-month last price in a sane range.
  try {
    const { status, body } = await getJson(`/v1/futures/${SLUG}`);
    assert(status === 200, `latest expected 200, got ${status}`);
    assert(
      body && typeof body === "object" && !body.error,
      `latest returned an error/empty body: ${JSON.stringify(body)}`,
    );
    const front =
      body.front_month ??
      (Array.isArray(body.contracts) ? body.contracts[0] : undefined);
    assert(front, "latest missing front_month / contracts[0]");
    assert(
      typeof front.last_price === "number" && Number.isFinite(front.last_price),
      "latest front-month missing numeric last_price",
    );
    // Sane range: front-month energy futures are well within $0–$10,000.
    assert(
      front.last_price > 0 && front.last_price < 10000,
      `latest front-month last_price out of sane range: ${front.last_price}`,
    );
    const monthLabel =
      typeof front.contract_month === "string" ? front.contract_month : "n/a";
    console.log(
      `PASS: GET /v1/futures/${SLUG} -> 200, front ${monthLabel} @ $${front.last_price}`,
    );
  } catch (err) {
    failures++;
    console.error(`FAIL (latest): ${err.message}`);
  }

  // Space requests — API rate limit is 1 req/sec.
  await sleep(RATE_LIMIT_MS);

  // 2. Curve — GET /v1/futures/{slug}/curve
  // TOLERANT: the curve can legitimately have no data, in which case the API
  // returns 200 with { error: "No futures data available for curve analysis",
  // date: "..." }. That is a valid no-data state — we PASS on it. We only fail
  // on a real error: non-200, auth failure, or a malformed/unexpected body.
  try {
    const { status, body } = await getJson(`/v1/futures/${SLUG}/curve`);
    assert(status === 200, `curve expected 200, got ${status}`);
    assert(body && typeof body === "object", "curve returned no/invalid body");

    if (typeof body.error === "string") {
      // Documented no-data state. Accept only the known "no data" message;
      // anything else (e.g. auth/permission errors) is a real failure.
      assert(
        /no futures data available/i.test(body.error),
        `curve returned an unexpected error: ${body.error}`,
      );
      console.log(
        `PASS (no-data, tolerated): GET /v1/futures/${SLUG}/curve -> 200, "${body.error}"`,
      );
    } else {
      // Curve data present — validate its shape.
      assert(
        Array.isArray(body.contracts) && body.contracts.length > 0,
        "curve has no error but also no contracts[] — malformed",
      );
      const c = body.contracts[0];
      assert(
        typeof c.contract_month === "string",
        "curve contract missing contract_month",
      );
      assert(
        typeof c.settlement_price === "number" &&
          Number.isFinite(c.settlement_price),
        "curve contract missing numeric settlement_price",
      );
      console.log(
        `PASS: GET /v1/futures/${SLUG}/curve -> 200, ${body.contracts.length} contracts, type ${body.curve_type ?? "n/a"}`,
      );
    }
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
