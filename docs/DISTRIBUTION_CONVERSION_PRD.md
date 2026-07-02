# PRD: MCP Server Distribution & Conversion — Make the Existing Asset Earn

**Author:** Karl · **Date:** 2026-07-02 · **Status:** Draft for sprint commitment
**One-liner:** The OPA MCP server (v2.3.0, 26 tools) is built and growing (npm 212→991/mo) but leaks at every funnel stage: the official registry advertises a 3-month-old version, analytics can't see the channel, keyless users hit a hard 401 despite a working demo endpoint, and zero of its users have ever converted to paid. This PRD closes the leaks with ~2–3 days of work. **No new product is built.**

---

## 1. Problem statement (all numbers counted from production data, 2026-07-02)

| Funnel stage | State                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Discover** | Official MCP registry serves **v2.0.0 (Mar 29)**; npm is at **2.3.0 (Jun 21)**. Registry also has two entries flagged `isLatest=true` (1.0.3 + 2.0.0). Everything shipped in v2.1–2.3 (futures, price alerts, watches, market brief) is invisible to registry consumers. No `.mcpb` Claude Desktop extension. Smithery/Glama/PulseMCP listing state unverified. | `registry.modelcontextprotocol.io/v0/servers?search=oilpriceapi`                                              |
| **Try**      | Keyless MCP call → hard 401 telling the user to go sign up. Yet **`/v1/demo/prices` already exists, keyless, returning live Brent/WTI/diesel/gasoline data** — and `src/index.ts` never references it. First-value requires signup for no technical reason.                                                                                                     | `curl api.oilpriceapi.com/v1/prices/latest` → 401 with `demo_endpoint` hint; `grep demo src/index.ts` → empty |
| **Measure**  | `api_requests.client_type` has no `mcp` value. MCP traffic (UA `oilpriceapi-mcp/x.y.z`) is only findable via `data->>'user_agent'` JSON digging; the largest client_type bucket is `unknown` (885k req/30d), so MCP is likely undercounted.                                                                                                                     | 30d: 69 req / 8 users matched by UA                                                                           |
| **Convert**  | **0 paid conversions ever** from the MCP cohort (~20 users/90d, all free). Whale `1e32665b…` (gmail, signed up 4/17): 20,454 req/90d, 30/60 active days, currently ~93/wk on `/v1/prices/latest` — embedded daily usage, never nudged.                                                                                                                          | users × api_requests join                                                                                     |

**Root cause:** we built the product and stopped before distribution/conversion — the classic leak. Downloads 4.7x'd in June purely from release activity; imagine what the surfaces we're absent from would do.

## 2. Goals / non-goals

**Goals (30 days post-sprint, all machine-counted):**

- G1: Registry latest == npm latest, **enforced structurally** (CI), never stale again
- G2: MCP is a first-class analytics channel (`client_type='mcp'` + version)
- G3: A keyless agent gets real value on first tool call (demo data) and a clear upgrade path
- G4: MCP-attributed active users: **8/mo → 25/mo**
- G5: **≥1 paid conversion** from the MCP cohort (incl. whale outreach)

**Non-goals:**

- No x402/crypto payments (watch-list item; re-evaluate if agent-payments ecosystem crosses ~$5B annualized or a commodity-data resource shows real Bazaar volume)
- No new MCP tools this sprint (26 is plenty; distribution is the constraint)
- Does not displace fuel-surcharge TAM work — this sprint is deliberately ≤2–3 days total

## 3. Metrics & instrumentation (no self-reported metrics)

All counted from systems we control:

- `api_requests` where `client_type='mcp'`: requests, distinct users, active days per user (embedded-usage definition: 2+ distinct days)
- Demo-mode usage: demo endpoint hits with MCP UA (proxy for keyless trial volume)
- Demo→key conversion: users whose first MCP request is keyless and who later appear with a key (target ≥10%)
- npm weekly downloads (directional only — includes CI/bots)
- Registry version drift: `registry latest != npm latest` → alert (add to an existing daily loop)

## 4. Workstreams

### WS1 — Registry & listing refresh (Discover) — P0

1. Publish v2.3.0 to the official MCP registry (`mcp-publisher` flow already used for 2.0.0); confirm exactly one `isLatest=true` after publish.
2. Add registry publish to the release workflow (`.github/workflows`) so npm publish and registry publish are atomic. This is the structural fix — staleness cannot recur.
3. Verify/refresh third-party listings: Smithery (sandbox export exists — confirm it scans green), Glama, PulseMCP. Fix or submit where absent.
4. Build and submit a **`.mcpb` Claude Desktop extension** bundle — one-click install for non-developers, a listing surface we currently have zero presence on.

### WS2 — Attribution (Measure) — P0

5. Backend PR (oilpriceapi-api, worktree): parse `User-Agent: oilpriceapi-mcp/<semver>` → `client_type='mcp'`, `sdk_version=<semver>`, `sdk_language='mcp'` in the existing request-tracking path (same mechanism that already classifies `sdk-node`/`sdk-python`). Include tests. Backfill not required — forward-looking is fine.
6. After deploy: add MCP cohort to whatever dashboard/loop reads client_type today.
   ⚠️ Backend deploy is manual (`doctl create-deployment`) and must not collide with the pending 10x-growth deploy (#3817/#3819) — coordinate, don't stack.

### WS3 — Keyless demo mode (Try) — P0, ships as mcp-server v2.4.0

7. When `OILPRICEAPI_KEY` is unset: price-read tools call `/v1/demo/prices` instead of 401ing. Response footer: "⚠ Demo data (limited commodity set). Get a free API key for all 40+ commodities: https://oilpriceapi.com/auth/signup?utm_source=mcp-demo".
8. Tools not covered by demo data (history, futures, alerts, watches) return a _useful_ teaser error: what the tool does + one-line sample of what they'd get + signup link — never a bare 401.
9. Server startup without a key: log a friendly "running in demo mode" notice instead of failing silently later.
10. (Stretch, backend) enrich `/v1/demo/prices` coverage if trivially cheap; otherwise ship with the 5-commodity set — it's enough to demonstrate value.

### WS4 — Conversion loop (Convert) — P1

11. Rate-limit/tier-gate responses across all tools include the upgrade link + the exact limit hit (pattern already exists for watches — extend everywhere a 402/403/429 surfaces).
12. Whale + cohort outreach: draft ONE plain-text email to the whale (embedded 30/60 days, gmail — keep it human: "you're one of our heaviest users, what are you building? here's a discount if the free tier is pinching") + a light variant for the other ~19 MCP users. **Drafts only — Karl approves before any send** (per customer-facing rule).
13. MCP-specific docs/landing page on website-clean (`/mcp`): install snippets for Claude Desktop/Cursor/VS Code, tool catalog, demo-mode explanation. Target the "commodity data MCP" search intent as it emerges.

### WS5 — Watch list (explicitly deferred)

- x402/agent-payments rail (43/70 on MicroSaaS framework; trigger documented in Goals)
- New MCP tools (fuel-surcharge tool lands when the fuel-surcharge product ships — that's its natural agent-channel moment)

## 5. Sprint plan (next sprint, ~2–3 focused days)

| #   | Task                                                    | Repo            | Size   | Priority | Acceptance (verified, not claimed)                                                                          |
| --- | ------------------------------------------------------- | --------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Publish 2.3.0 to MCP registry; verify single `isLatest` | mcp-server      | 0.5h   | **P0**   | Registry API returns 2.3.0 as sole latest                                                                   |
| 2   | Registry publish in release CI                          | mcp-server      | 1–2h   | **P0**   | Dry-run of workflow on a test tag                                                                           |
| 3   | Attribution: UA→`client_type='mcp'` + version           | oilpriceapi-api | 2–3h   | **P0**   | Test + post-deploy: live MCP request rows show `client_type='mcp'`                                          |
| 4   | Keyless demo mode + teaser errors (v2.4.0)              | mcp-server      | 0.5–1d | **P0**   | Fresh Claude Desktop install with NO key returns Brent price; footer CTA present; npm + registry show 2.4.0 |
| 5   | Tier-limit upgrade nudges in all tool error paths       | mcp-server      | 2h     | P1       | Simulated 429/403 shows limit + link (ships inside v2.4.0)                                                  |
| 6   | Whale + cohort outreach drafts                          | —               | 1h     | P1       | Drafts presented to Karl; nothing sent without approval                                                     |
| 7   | `.mcpb` Claude Desktop extension + directory submission | mcp-server      | 0.5d   | P1       | Bundle installs clean locally; submission confirmed                                                         |
| 8   | Verify/refresh Smithery, Glama, PulseMCP                | —               | 1–2h   | P1       | Each listing shows v2.3.0+ or submission filed                                                              |
| 9   | `/mcp` landing page                                     | website-clean   | 0.5d   | P2       | Page live, `curl -I` 200, install snippets copy-paste correct                                               |
| 10  | MCP cohort in analytics/daily loop                      | oilpriceapi-api | 2h     | P2       | Loop report includes MCP row (needs #3 deployed first)                                                      |

**Sequencing:** Day 1 = #1 #2 #3 (+#6 drafts). Day 2 = #4 #5 → ship v2.4.0. Day 3 = #7 #8, then #9 #10 as capacity allows. Items #3/#10 ride the _next planned_ backend deploy — do not trigger a deploy solely for attribution.

**Definition of done for the sprint:** a brand-new user with no OPA account can find the server in the official registry (current version), install it, get a live Brent price with zero setup, see exactly how to unlock the rest — and we can watch every step of that in `api_requests`.

## 6. Risks

| Risk                                                           | Mitigation                                                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry publish repeats the double-`isLatest` glitch          | Verify via registry API immediately after publish; it's read-tolerant, worst case is cosmetic                                                                    |
| Demo mode cannibalizes free signups                            | Demo set is 5 commodities vs 40+; footer CTA on every response; measure demo→key conversion — if <10% after 30d, tighten demo (fewer calls/day), don't remove it |
| Backend deploy collision (manual deploys, #3817/#3819 pending) | Attribution PR waits for the already-planned deploy; never stack deploys (existing rule)                                                                         |
| Outreach reads as surveillance ("we saw your 20k requests")    | Draft framing = curiosity + gratitude, not monitoring; Karl approves every word before send                                                                      |
| v2.4.0 breaks existing keyed users                             | Demo path only activates when key is absent; live-smoke CI already covers keyed flows; `npm test` + `test:live` before publish                                   |

## 7. Decision asked

Commit the 10-item sprint above (~2–3 days). Items 1–3 are sub-hour-to-3h and could ship today without waiting on sprint ceremony.
