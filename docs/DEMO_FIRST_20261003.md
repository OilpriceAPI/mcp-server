# Demo-first replies — 2026-10-03

Customer request: include a website link, avoid repeated API-key entry for demo questions, and keep Henry Hub curves behind subscription entitlement.

Latest benchmark prices and small comparisons already use the keyless REST demo. No shared API key is introduced. Existing global and peer request velocity limits in `src/remote.ts`, comparison/result caps, one-hour demo cache, timeouts and fail-closed entitlement checks remain in place. These are transport/request limits, not verified distinct-user quotas; proxy traffic may share a peer bucket.

All seven descriptors now advertise anonymous calls plus optional OAuth in both canonical `securitySchemes` and the compatibility `_meta` mirror. Anonymous premium calls return only an entitlement boundary and handoff, without forcing the OAuth linking dialog. Paid results still require the caller's credential and upstream entitlement. Revoked/invalid credentials remain rejected. The SDK strips extension fields during ordinary serialization, so the public `tools/list` handler publishes the complete shared descriptors; wire-level tests use a permissive result schema to preserve extensions.

Successful data and structured failures include a constant credential-free `website_url`. Server instructions and the skill request one clickable OilPriceAPI source link per answer. The Henry Hub starter now asks for the demo-eligible latest benchmark, while the futures review case still requires entitlement. Package version is 0.1.1.

The OAuth store is still memory-only: deploy/restart invalidates linked sessions. This change avoids key entry for anonymous demo use; it does not claim persistent paid-account sessions or a verified ChatGPT client rendering result. Existing imported packages need their updated skill/archive refreshed.

Adversarial review: checked that optional auth does not bypass premium checks, anonymous premium calls make no upstream request, failed/revoked credentials do not silently fall back, website links are constants, secrets remain filtered, caps are unchanged, and standard MCP client schemas may discard extension fields without indicating a server serialization defect.

Verification: all 523 tests, 47 targeted facade/HTTP tests, build/package gates and capability ledger passed [CI](https://github.com/OilpriceAPI/mcp-server/actions/runs/37126610686). Production anonymous smoke passed all eight contract cases, canonical auth descriptors and source links. An additional credential-free Henry Hub latest-benchmark call returned available demo data. Post-deploy: `node scripts/smoke-remote.mjs https://oilpriceapi-openai-mcp-dafbh.ondigitalocean.app/mcp`, followed by the protected authenticated review workflow. Rollback restores the prior immutable app image; no API/frontend deployment is needed.

Release scope: user-authorized isolated MCP repair for repeated key prompts. Normal elevated release timing is Friday >=21:00 UTC; existing session merge/deploy authorization covers this reported onboarding defect. Do not redeploy shared API/frontend apps.

CI contract reconciliation: [PR #143](https://github.com/OilpriceAPI/mcp-server/pull/143) records the newly published `/v1/futures/rbob` route as deferred in capability ledger version 2. Its delayed quotes, prior-session fields and exact decimals require separate contract validation before exposure; this repair adds no RBOB tool.

Runtime source `55e7da9856c78de0c4298080600534088e8ba92d`; image `sha256:02b58d701a7f4cd74def1f8045c6529afb9f0cb616429e57ec78b5e3b000b1e2`; isolated app deployment `a3de1f3b-7490-43bf-a9c8-34a7c9e7ab39` verified ACTIVE with health version 0.1.1. Rollback restores `sha256:eb043360d1ee8db2791e84d6112da8dc7538429928d7cea9472450bc35d3f313`.

Smoke correction: SDK input validation rejects the bulk request before the handler, so that protocol error has no structured market result or website URL. The production checker failed on that overly broad link assertion, then passed with the website requirement limited to handler responses. Bulk rejection still requires `isError`. This monitor-only correction requires no runtime redeployment or OAuth reset.
