# Demo-first replies — 2026-10-03

Customer request: include a website link, avoid repeated API-key entry for demo questions, and keep Henry Hub curves behind subscription entitlement.

Latest benchmark prices and small comparisons already use the keyless REST demo. No shared API key is introduced. Existing global 300 requests/minute, peer 30 requests/minute, comparison/result caps, one-hour demo cache, timeouts and fail-closed entitlement checks remain in place. These are transport/request limits, not verified distinct-user quotas; proxy traffic may share a peer bucket.

All seven descriptors now advertise anonymous calls plus optional OAuth in both canonical `securitySchemes` and the compatibility `_meta` mirror. Anonymous premium calls return only an entitlement boundary and handoff, without forcing the OAuth linking dialog. Paid results still require the caller's credential and upstream entitlement. Revoked/invalid credentials remain rejected. The SDK strips extension fields during ordinary serialization, so the public `tools/list` handler publishes the complete shared descriptors; wire-level tests use a permissive result schema to preserve extensions.

Successful data and structured failures include a constant credential-free `website_url`. Server instructions and the skill request one clickable OilPriceAPI source link per answer. The Henry Hub starter now asks for the demo-eligible latest benchmark, while the futures review case still requires entitlement. Package version is 0.1.1.

The OAuth store is still memory-only: deploy/restart invalidates linked sessions. This change avoids key entry for anonymous demo use; it does not claim persistent paid-account sessions or a verified ChatGPT client rendering result. Existing imported packages need their updated skill/archive refreshed.

Adversarial review: checked that optional auth does not bypass premium checks, anonymous premium calls make no upstream request, failed/revoked credentials do not silently fall back, website links are constants, secrets remain filtered, caps are unchanged, and standard MCP client schemas may discard extension fields without indicating a server serialization defect.

Verification: 47 targeted facade/HTTP tests, full-suite CI and production smoke required before release. Post-deploy: `node scripts/smoke-remote.mjs https://oilpriceapi-openai-mcp-dafbh.ondigitalocean.app/mcp`, followed by the protected authenticated review workflow. Rollback restores the prior immutable app image; no API/frontend deployment is needed.

Release scope: user-authorized isolated MCP repair for repeated key prompts. Normal elevated release timing is Friday >=21:00 UTC; existing session merge/deploy authorization covers this reported onboarding defect. Do not redeploy shared API/frontend apps.
