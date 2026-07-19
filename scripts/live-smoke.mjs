#!/usr/bin/env node

/**
 * Live smoke test against the real OilPriceAPI.
 *
 * Verifies the futures path fix (v2.2.1) AND the #3245 subscription +
 * market-brief tools (v2.3.0) end-to-end against PRODUCTION:
 *   - GET /v1/futures/ice-brent          (latest)  -> 200 + numeric front-month last_price
 *   - GET /v1/futures/ice-brent/curve    (curve)   -> 200 + curve data OR documented no-data state
 *   - GET /v1/market-brief?codes=BRENT_CRUDE_USD   -> 200 + a numeric price (opa_get_market_brief)
 *   - GET /v1/subscriptions               (list)   -> 200 + { data: { subscriptions: [...] } } (opa_list_subscriptions)
 *   - POST/GET/DELETE round-trip on /v1/subscriptions (opa_create_price_subscription / events / delete)
 *     — only when SMOKE_WRITE_SUBSCRIPTIONS=1; the created watch is cleaned up
 *     in the SAME run so production is never littered. Off by default so the
 *     default CI run only READS from prod.
 *
 * These are the paths the MCP tools build. The old v2.2.0 code hit
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
 * The key belongs to a dedicated synthetic smoke identity. A quota preflight
 * warns before 80% usage and refuses to start if the remaining allowance cannot
 * complete the run. Calls are spaced >=1.1s apart; any 429 is a failed gate.
 */

const API_BASE =
  process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
const KEY = process.env.OILPRICEAPI_TEST_KEY;
const SLUG = "ice-brent";
const RATE_LIMIT_MS = 1100; // > 1 req/sec
// Opt-in: exercise the WRITE round-trip (create -> events -> delete) against
// prod. Off by default so the standard CI run only reads.
const WRITE_SUBSCRIPTIONS = process.env.SMOKE_WRITE_SUBSCRIPTIONS === "1";
const EXPECTED_REQUESTS = WRITE_SUBSCRIPTIONS ? 12 : 8;
const QUOTA_WARNING_PERCENT = 80;

if (!KEY) {
  console.log(
    "SKIP: OILPRICEAPI_TEST_KEY not set — skipping live smoke test (this is OK for forks).",
  );
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
      "User-Agent": "oilpriceapi-mcp-live-smoke/3.0.0",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

async function getJson(path) {
  return request(path);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

// A dedicated smoke identity should not collide with customer or human traffic.
// Any rate limit response is therefore an actionable gate failure.
class RateLimited extends Error {
  constructor(label) {
    super(`rate-limited (HTTP 429): ${label}`);
    this.name = "RateLimited";
  }
}

// Throw RateLimited when a response is a 429 so the per-check try/catch can
// distinguish a rate-limit failure from other failures. Call this
// immediately after each live request, before asserting on the body.
function rateLimitGuard(status, label) {
  if (status === 429) {
    throw new RateLimited(label);
  }
}

// Sentinel thrown when a plan-gated endpoint answers 402/403 because the CI
// key lacks the entitlement (e.g. energy intelligence for well production /
// drilling). That is the documented paywall behavior — the MCP tools surface
// it with an upgrade link — NOT a contract regression, so callers SKIP.
class PlanGated extends Error {
  constructor(label, status) {
    super(`plan-gated (HTTP ${status}): ${label}`);
    this.name = "PlanGated";
  }
}

// Throw PlanGated when a premium endpoint answers 402/403 so the per-check
// try/catch can SKIP instead of failing. Only use on endpoints where the
// synthetic CI identity may legitimately lack the entitlement.
function planGateGuard(status, label) {
  if (status === 402 || status === 403) {
    throw new PlanGated(label, status);
  }
}

// Centralised per-check error handling. A 429 always increments failures.
// PlanGated is used only for explicitly optional premium datasets; core market
// brief and subscription-list checks do not call planGateGuard.
function handleCheckError(err, failures) {
  if (err instanceof RateLimited) {
    console.error(`FAIL: ${err.message}`);
    return failures + 1;
  }
  if (err instanceof PlanGated) {
    console.log(
      `SKIP (plan-gated, CI key lacks the entitlement — tolerated): ${err.message}`,
    );
    return failures;
  }
  return failures + 1;
}

async function quotaPreflight() {
  const { status, body } = await getJson("/v1/account");
  rateLimitGuard(status, "GET /v1/account quota preflight");
  assert(status === 200, `account preflight expected 200, got ${status}`);
  const account = body && typeof body === "object" ? body.account : null;
  assert(
    account && typeof account === "object",
    "account preflight missing account summary",
  );

  const used = Number(account.usage_this_month);
  const limit = Number(
    account.effective_request_limit ?? account.request_limit,
  );
  const remaining = Number(account.remaining_requests);
  assert(
    Number.isFinite(used) &&
      Number.isFinite(limit) &&
      Number.isFinite(remaining),
    "account preflight missing numeric quota counters",
  );
  assert(limit > 0, "account preflight returned a non-positive request limit");
  assert(
    remaining >= EXPECTED_REQUESTS,
    `quota preflight has ${remaining} requests remaining; ${EXPECTED_REQUESTS} are required`,
  );

  const percentUsed = Math.round((used / limit) * 10000) / 100;
  if (
    percentUsed >= QUOTA_WARNING_PERCENT ||
    remaining < EXPECTED_REQUESTS * 2
  ) {
    console.warn(
      `WARN: synthetic smoke quota is ${percentUsed}% used (${remaining}/${limit} remaining)`,
    );
  }
  const tier = typeof account.tier === "string" ? account.tier : "unknown";
  console.log(
    `PASS: synthetic smoke preflight -> plan ${tier}, quota ${used}/${limit}, ${remaining} remaining`,
  );
}

async function main() {
  let failures = 0;

  try {
    await quotaPreflight();
  } catch (err) {
    console.error(`FAIL (quota preflight): ${err.message}`);
    process.exit(1);
  }
  await sleep(RATE_LIMIT_MS);

  // 1. Latest — GET /v1/futures/{slug}
  // The API returns a top-level object: { front_month: { contract_month,
  // last_price, ... }, contracts: [...], ... }. The latest price the MCP tool
  // surfaces is front_month.last_price (falling back to contracts[0]). We only
  // require a numeric front-month last price in a sane range.
  try {
    const { status, body } = await getJson(`/v1/futures/${SLUG}`);
    rateLimitGuard(status, `GET /v1/futures/${SLUG}`);
    assert(status === 200, `latest expected 200, got ${status}`);
    assert(
      body && typeof body === "object" && !body.error,
      "latest returned an error or empty body",
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
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited)) {
      console.error(`FAIL (latest): ${err.message}`);
    }
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
    rateLimitGuard(status, `GET /v1/futures/${SLUG}/curve`);
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
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited)) {
      console.error(`FAIL (curve): ${err.message}`);
    }
  }

  // Space requests — API rate limit is 1 req/sec.
  await sleep(RATE_LIMIT_MS);

  // 3. Market brief — GET /v1/market-brief?codes=BRENT_CRUDE_USD
  // This is what opa_get_market_brief builds. Require 200 + a numeric price for
  // Brent in the structured `commodities` array (envelope: { status, data }).
  try {
    const { status, body } = await getJson(
      "/v1/market-brief?codes=BRENT_CRUDE_USD",
    );
    rateLimitGuard(status, "GET /v1/market-brief?codes=BRENT_CRUDE_USD");
    assert(status === 200, `market-brief expected 200, got ${status}`);
    const data = body && body.data;
    assert(
      data && Array.isArray(data.commodities) && data.commodities.length > 0,
      "market-brief missing data.commodities[]",
    );
    const brent = data.commodities.find((c) => c.code === "BRENT_CRUDE_USD");
    assert(brent, "market-brief missing BRENT_CRUDE_USD commodity");
    assert(
      typeof brent.price === "number" &&
        Number.isFinite(brent.price) &&
        brent.price > 0,
      `market-brief Brent price not a positive number: ${brent.price}`,
    );
    console.log(
      `PASS: GET /v1/market-brief -> 200, Brent @ $${brent.price} (${brent.currency})`,
    );
  } catch (err) {
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited)) {
      console.error(`FAIL (market-brief): ${err.message}`);
    }
  }

  await sleep(RATE_LIMIT_MS);

  // 4. List subscriptions — GET /v1/subscriptions
  // What opa_list_subscriptions builds. Require 200 + a subscriptions array
  // (empty or populated — both valid).
  try {
    const { status, body } = await getJson("/v1/subscriptions");
    rateLimitGuard(status, "GET /v1/subscriptions");
    assert(status === 200, `subscriptions list expected 200, got ${status}`);
    const subs = body && body.data && body.data.subscriptions;
    assert(
      Array.isArray(subs),
      "subscriptions list missing data.subscriptions[]",
    );
    console.log(
      `PASS: GET /v1/subscriptions -> 200, ${subs.length} subscription(s)`,
    );
  } catch (err) {
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited)) {
      console.error(`FAIL (subscriptions list): ${err.message}`);
    }
  }

  await sleep(RATE_LIMIT_MS);

  // 5. Well production summary — GET /v1/well-production (#31)
  // What opa_get_well_production (summary view) builds. Require 200 + a
  // non-empty top_states array with numeric production figures.
  // TOLERANT of 402/403: well production is a plan-gated dataset and the
  // shared CI key may not carry the energy-intelligence entitlement. A gate
  // response is the documented paywall behavior (the MCP tool surfaces it
  // with an upgrade link), NOT a contract regression — SKIP, don't fail.
  try {
    const { status, body } = await getJson("/v1/well-production");
    rateLimitGuard(status, "GET /v1/well-production");
    planGateGuard(status, "GET /v1/well-production");
    assert(status === 200, `well-production expected 200, got ${status}`);
    const data = body && body.data;
    assert(
      data && Array.isArray(data.top_states) && data.top_states.length > 0,
      "well-production missing data.top_states[]",
    );
    const top = data.top_states[0];
    assert(
      typeof top.state === "string" &&
        typeof top.oil_bbl === "number" &&
        Number.isFinite(top.oil_bbl),
      "well-production top state missing state/oil_bbl",
    );
    console.log(
      `PASS: GET /v1/well-production -> 200, top state ${top.state} @ ${top.oil_bbl} bbl (${top.period})`,
    );
  } catch (err) {
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited) && !(err instanceof PlanGated)) {
      console.error(`FAIL (well-production): ${err.message}`);
    }
  }

  await sleep(RATE_LIMIT_MS);

  // 6. Drilling snapshot — GET /v1/drilling/latest (#31)
  // The endpoint's CURRENT shape is { rig_counts: {...}, frac_spread_count,
  // well_permits: {...}, duc_wells_total, ... } — the old
  // total_wells/active_rigs shape is gone, and the pre-#31 formatter crashed
  // on it. This check pins the new contract.
  // Also TOLERANT of 402/403 — drilling is plan-gated like well production.
  try {
    const { status, body } = await getJson("/v1/drilling/latest");
    rateLimitGuard(status, "GET /v1/drilling/latest");
    planGateGuard(status, "GET /v1/drilling/latest");
    assert(status === 200, `drilling expected 200, got ${status}`);
    const data = body && body.data;
    assert(
      data && data.rig_counts && typeof data.rig_counts === "object",
      "drilling missing data.rig_counts",
    );
    console.log(
      `PASS: GET /v1/drilling/latest -> 200, rig_counts keys: ${Object.keys(data.rig_counts).join(", ")}`,
    );
  } catch (err) {
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited) && !(err instanceof PlanGated)) {
      console.error(`FAIL (drilling): ${err.message}`);
    }
  }

  await sleep(RATE_LIMIT_MS);

  // 6b. LTL fuel surcharge — GET /v1/fuel-surcharge (#43)
  // What opa_get_fuel_surcharge (all-carriers view) builds. The endpoint
  // ships in a parallel API sprint (oilpriceapi-api#4767/#4772), so a 404 is
  // the documented not-yet-deployed state — the MCP tool returns a clear
  // "not yet available" message for it — and is a SKIP, not a failure. Once
  // deployed, this check requires 200 + data.carriers[] with a numeric
  // surcharge_percent. Also TOLERANT of 402/403 (plan-gated dataset).
  try {
    const { status, body } = await getJson("/v1/fuel-surcharge");
    rateLimitGuard(status, "GET /v1/fuel-surcharge");
    planGateGuard(status, "GET /v1/fuel-surcharge");
    if (status === 404) {
      console.log(
        "SKIP: GET /v1/fuel-surcharge -> 404 — endpoint not yet deployed (oilpriceapi-api#4772); the MCP tool reports 'not yet available' for this state.",
      );
    } else {
      assert(status === 200, `fuel-surcharge expected 200/404, got ${status}`);
      const carriers = body && body.data && body.data.carriers;
      assert(
        Array.isArray(carriers) && carriers.length > 0,
        "fuel-surcharge missing data.carriers[]",
      );
      const first = carriers[0];
      assert(
        typeof first.carrier === "string" &&
          typeof first.surcharge_percent === "number" &&
          Number.isFinite(first.surcharge_percent),
        "fuel-surcharge first carrier missing carrier/surcharge_percent",
      );
      console.log(
        `PASS: GET /v1/fuel-surcharge -> 200, ${carriers.length} carrier(s), ${first.carrier} @ ${first.surcharge_percent}%`,
      );
    }
  } catch (err) {
    failures = handleCheckError(err, failures);
    if (!(err instanceof RateLimited) && !(err instanceof PlanGated)) {
      console.error(`FAIL (fuel-surcharge): ${err.message}`);
    }
  }

  // 7. WRITE round-trip (opt-in) — create -> poll events -> delete.
  // Guarded behind SMOKE_WRITE_SUBSCRIPTIONS=1 so the default run never writes
  // to prod. When enabled, the created watch is ALWAYS deleted in the same run
  // (even if a mid-step assertion fails) so prod is not littered.
  if (WRITE_SUBSCRIPTIONS) {
    let createdId = null;
    try {
      await sleep(RATE_LIMIT_MS);
      // Create a 1h (free-tier floor) Brent watch, stamped as MCP.
      const created = await request("/v1/subscriptions", {
        method: "POST",
        body: {
          codes: ["BRENT_CRUDE_USD"],
          interval_seconds: 3600,
          name: "live-smoke (auto-cleanup)",
        },
        headers: {
          "X-OPA-Source": "mcp",
          "X-OPA-Tool": "opa_create_price_subscription",
        },
      });
      rateLimitGuard(created.status, "POST /v1/subscriptions");
      assert(
        created.status === 200 || created.status === 201,
        `create expected 200/201, got ${created.status}: ${JSON.stringify(created.body)}`,
      );
      createdId =
        created.body &&
        created.body.subscription &&
        created.body.subscription.id;
      assert(createdId, "create did not return a subscription id");
      console.log("PASS: POST /v1/subscriptions -> created synthetic watch");

      await sleep(RATE_LIMIT_MS);
      // List should now include it.
      const list = await getJson("/v1/subscriptions");
      rateLimitGuard(list.status, "GET /v1/subscriptions (re-list)");
      assert(list.status === 200, `re-list expected 200, got ${list.status}`);
      const ids = (list.body?.data?.subscriptions ?? []).map((s) => s.id);
      assert(
        ids.includes(createdId),
        "created watch not present in subsequent list",
      );
      console.log("PASS: created watch appears in list");

      await sleep(RATE_LIMIT_MS);
      // Events poll should 200 (likely empty until the evaluator runs).
      const events = await getJson("/v1/subscriptions/events?since=0");
      rateLimitGuard(events.status, "GET /v1/subscriptions/events");
      assert(
        events.status === 200,
        `events expected 200, got ${events.status}`,
      );
      assert(
        events.body && Array.isArray(events.body?.data?.events),
        `events missing data.events[]: ${JSON.stringify(events.body)}`,
      );
      console.log(
        `PASS: GET /v1/subscriptions/events -> 200, ${events.body.data.events.length} event(s), cursor ${events.body.data.cursor}`,
      );
    } catch (err) {
      failures = handleCheckError(err, failures);
      if (!(err instanceof RateLimited)) {
        console.error(`FAIL (subscription write round-trip): ${err.message}`);
      }
    } finally {
      // Always clean up the created watch so prod is not littered.
      if (createdId) {
        await sleep(RATE_LIMIT_MS);
        try {
          const del = await request(
            `/v1/subscriptions/${encodeURIComponent(createdId)}`,
            { method: "DELETE" },
          );
          if (del.status === 204 || del.status === 200) {
            console.log("PASS: DELETE synthetic subscription -> cleaned up");
          } else if (del.status === 429) {
            failures++;
            console.error(
              "FAIL (cleanup): DELETE synthetic subscription -> 429; cleanup must be retried",
            );
          } else {
            failures++;
            console.error(
              `FAIL (cleanup): DELETE expected 200/204, got ${del.status}; cleanup must be retried`,
            );
          }
        } catch (err) {
          failures++;
          console.error(
            `FAIL (cleanup): ${err.message}; synthetic watch cleanup must be retried`,
          );
        }
      }
    }
  } else {
    console.log(
      "SKIP: subscription WRITE round-trip (set SMOKE_WRITE_SUBSCRIPTIONS=1 to exercise create/delete against prod).",
    );
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
