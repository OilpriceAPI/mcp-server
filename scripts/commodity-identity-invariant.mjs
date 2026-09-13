#!/usr/bin/env node
/**
 * Live-catalog identity invariant.
 *
 *   For every code in the LIVE catalog, resolveCommodityCode must return that
 *   code or null. Never a different commodity.
 *
 * The unit suite asserts this structurally against a fixed sample, which is
 * what runs on pull requests (PRs deliberately receive no API secret). This
 * script closes the remaining gap: it asserts the same property against the
 * catalog as it actually is today, so the check keeps working as the catalog
 * grows rather than only covering codes someone remembered to list.
 *
 * The bug this exists to prevent: a hardcoded 27-code list plus a substring
 * fall-through answered NATURAL_GAS_WAHA with NATURAL_GAS_USD — a Permian hub
 * that trades at a deep discount to Henry Hub and has settled negative — with
 * isError:false. An AI agent cannot detect that.
 *
 * Exits 2 when it cannot check, never 0: a check that silently skips is
 * indistinguishable from a check that passed.
 */
import { resolveCommodityCode } from "../build/index.js";

const KEY = process.env.OILPRICEAPI_KEY;
const BASE = process.env.OILPRICEAPI_BASE_URL ?? "https://api.oilpriceapi.com";

if (!KEY) {
  console.error("[identity-invariant] no key configured — cannot check");
  process.exit(2);
}

const res = await fetch(`${BASE}/v1/commodities`, {
  headers: { Authorization: `Token ${KEY}` },
});
if (!res.ok) {
  console.error(`[identity-invariant] catalog fetch failed: HTTP ${res.status}`);
  process.exit(2);
}

const body = await res.json();
const codes = (body?.data?.commodities ?? []).map((c) => c.code).filter(Boolean);
if (codes.length === 0) {
  console.error("[identity-invariant] catalog returned no codes — cannot check");
  process.exit(2);
}

const violations = [];
for (const code of codes) {
  const out = resolveCommodityCode(code);
  if (out !== null && out !== code) violations.push({ code, out });
}

console.log(`[identity-invariant] checked ${codes.length} live codes`);
if (violations.length > 0) {
  console.error(
    `[identity-invariant] ${violations.length} code(s) resolved to a DIFFERENT commodity:`,
  );
  for (const v of violations.slice(0, 25)) {
    console.error(`  ${v.code} -> ${v.out}`);
  }
  process.exit(1);
}
console.log("[identity-invariant] OK — no code resolves to a different commodity");
