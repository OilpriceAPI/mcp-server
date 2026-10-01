# OilPriceAPI OpenAI plugin V1 — readiness record

Status: implemented locally; not merged, deployed or submitted. Reviewed against official OpenAI documentation on 2026-10-01.

## Phase 0 findings

- Isolated from upstream `de6dfffa` (oilpriceapi-mcp 3.4.1). Baseline: 459 tests passed.
- Existing MCP is stdio-only, with a broad catalog including persistent alerts/watches. Those tools remain unchanged. The public facade exposes seven read tools only.
- Existing REST helpers supply deadlines, transient retries, explicit 402/403/429 semantics and cancellation. Request-local credentials override environment credentials without mutating shared process state.
- Keyless `/v1/demo/prices` already gates access and limits requests to 30/hour and 25/day per IP. It currently returns a broader catalog than the public facade; the facade exposes six approved energy benchmarks only, with no pagination. One-hour coalesced caching reduces shared-egress requests; publication/cache times remain distinct from source observation time.
- The live demo labels Brent and WTI front-month futures and supplies `updated_at`, not source observation time/cadence. The facade preserves that identity and explicitly reports missing source time.
- History uses existing `/v1/prices/past_month`, one daily-aggregate page, one benchmark, <=30 days, <=100 rows. Anonymous history is unavailable.
- Futures use existing `/v1/futures/{instrument}/curve`, <=12 returned contracts, preserving contract/trading/expiry semantics and contract-spec quote-basis fallback. No duplicate futures route.
- Marine uses the maintained MCP's full-list REST mapping because its documented server filters have returned empty successful responses; the facade returns only requested exact ports/grade, <=2 quotes. No pagination or broad export.
- Drilling uses `/v1/drilling/latest`. Its current contract is national/geographic rig counts, not Permian basin counts. It supplies a global snapshot update time, not a per-geography report period; the facade does not relabel it. Aggregate deltas are not a prior-report change for one geography.
- DigitalOcean currently hosts separate API and frontend App Platform apps. API: `4f18d37d-c9c5-4906-9850-304fb355efda`; frontend: `4cf05d8d-32ae-4cea-9e3b-2993b41bd11b`. The prepared new-app spec uses DigitalOcean’s runtime `${APP_URL}` binding for its stable HTTPS ingress. The new MCP must be a separate app; no MCP database connections or changes to either serving app.
- Website, `/support`, `/privacy`, `/terms` all return HTTPS 200. The production privacy page lacks this plugin-specific disclosure; a separate website PR prepares it.

## Transport / OAuth / controls

Run `npm run build && npm run start:remote` with `OILPRICEAPI_MCP_PUBLIC_URL=https://YOUR-HOST`. `/health`, `/mcp`, OAuth metadata, authorization, registration, token, revocation and key-link routes are provided. No shared service credential is accepted at startup.

OAuth uses SDK authorization routing, S256 PKCE, read-only scope and exact resource/client/redirect binding. The user's key is validated through REST before a one-use authorization code is issued. API keys never appear in responses, URLs or telemetry. Opaque access tokens expire in one hour; refresh tokens rotate and expire after seven days. Revocation removes all active tokens for that connected credential. The store is bounded and memory-only; **single instance required** and restart clears client registrations/tokens, requiring reconnect. Persistent account linking is a follow-up before scaling beyond this experiment.

The remote has host/origin checks, JSON-only requests, 16 KiB request cap, no batch/pagination, bounded rate-limit memory, connected-peer and global velocity controls, <=20 active MCP requests, HTTP deadlines and per-tool/upstream budgets. Forwarding headers are not trusted. A reverse proxy's peer may represent several clients; configure additional edge per-client controls before scaling. The SDK additionally limits OAuth routes.

Read annotations: read-only=true, destructive=false, idempotent=true, open-world=true. Justification: tools fetch existing public/account-permitted OilPriceAPI REST data; no market records, alerts, watches or account entitlements are written. Routine operational logging is incidental to reads.

## Experiment measurement

`plugin_tool_call` is operational telemetry only: tool enum, broad dataset category, outcome, duration, version, result count and demo/authenticated access. No prompts, responses, keys, customer emails or payment information. Do not equate calls, retries or conversations with people or logical research tasks.

The remote `/handoff/{category}` redirects only to the fixed signup destination. `plugin_handoff_visit` is emitted only for browser navigation with user activation; prefetches and probes do not qualify. It is explicitly a navigation proxy, not proof of a distinct person. Internal smoke calls use `X-OPA-Telemetry-Exclude: 1`; operational events are tagged internal/test or unclassified.

Handoffs use `utm_source=openai-plugin`, `utm_medium=plugin`, `utm_campaign=energy-markets`, and a broad `utm_content` dataset category. Existing signup attribution persists first-touch for 90 days and forwards fields to the account. Existing first-touch attribution wins; an existing visitor's original source is not overwritten. This gives a first-touch cohort, not universal causal attribution or a per-research join.

`scripts/plugin-readout.mjs` summarizes exported logs without turning calls into tasks; unmeasured funnel values remain null. `docs/openai-plugin-cohort.sql` prepares aggregate-only first-touch signup/key/recorded-first-call analysis; its live execution and Stripe receipt reconciliation remain unverified.

**Not yet verified:** production handoff visit event; signup -> key -> first successful authenticated request -> authoritative Stripe paid receipt; internal/test exclusion; reliable research-task boundaries; privacy-safe distinct-day repeats. The 30-day research conversion thresholds cannot be applied until their denominator is measured. Host `_meta["openai/session"]` identifies an anonymized conversation, not a logical job; any use must be labeled a proxy. Do not backfill tasks from raw call counts.

The requested subtitle is 31 characters; the current directory limit is 30. The packaged subtitle is "Source-aware energy data".

## Review and release gates

- Run `npm test`, `npm run build`, `npm audit --audit-level=low`, release metadata verification and shared TypeScript checks.
- Build/boot `Dockerfile.remote`; initialize -> tools/list -> demo calls through HTTP.
- Run `node scripts/smoke-remote.mjs https://YOUR-HOST/mcp`. This checks contracts, not natural-language refusal behavior. Exactly five positive and three negative prompt cases are in `openai-plugin/review-tests.json`; evaluate them in ChatGPT/Codex and record the demo before submission.
- Anonymous curve/history/marine/drilling tests prove entitlement boundaries only. Authenticated usable curve/history/marine requires an entitled test account. Permian remains unavailable until the existing service supplies an appropriate contract; do not mark that positive case as a usable basin result.
- Local live demo smoke currently receives the shared caller IP's 429 quota boundary. A successful production demo price/comparison is still required.
- Keep serving/auth changes out of production until the Friday elevated-risk window (Friday >=21:00 UTC), required review and green CI. The frontend has its own protected-main deploy workflow; do not bypass it.
- Deploy a separate, one-instance DigitalOcean app with HTTPS, `/health` checks, deployment-failure alerts and rollback to the prior source SHA/digest. Verify customer-critical calls and inspect new errors after release.
- Generate ZIP with `npm run package:openai -- https://YOUR-HOST/mcp`. ZIP has no credentials. It remains a draft until all production gates pass.
- `/.well-known/openai-apps-challenge` returns 404 until `OPENAI_APPS_CHALLENGE` is supplied. Serve the exact portal value verbatim; never invent it.
- Remaining portal steps: verified business/publisher identity, actual domain challenge, production tool scan, secure reviewer access, demo recording/upload, final submission.

## Official sources

- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/plugin-guidelines
