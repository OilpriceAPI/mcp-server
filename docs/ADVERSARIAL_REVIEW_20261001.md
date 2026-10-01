# Adversarial review — OpenAI energy plugin

## Pre-merge review

Reviewed OAuth grants and redirect/resource/PKCE binding, credential isolation,
upstream error sanitization, public field filtering, demo cache and abuse caps,
dataset identity, source semantics, handoff redirects, deployment isolation and
the website privacy disclosure.

Two actionable findings were reproduced with failing regression tests and fixed:

1. History trusted upstream date filters. The facade now removes observations
   with missing/invalid observation dates, future dates or dates outside the
   requested UTC date window. Publication update timestamps are not used as
   historical observation dates. The returned window is explicit.
2. A successful curve response reporting a different instrument could be labeled
   with the requested instrument. Explicit mismatches now fail unavailable.

The existing negative-path suite covers entitlement and quota errors, malformed
input, caps, wrong benchmark codes, absent data, credential reflection, stalled
upstream response bodies, OAuth expiry/revocation, redirect attacks and transport
limits. Existing stdio clients retain their transport and tool names.

Known limits remain: single-instance memory-only OAuth; upstream shared-egress
demo quota; no Permian-specific REST contract; no reliable logical research-task
denominator; production signup/key/first-use/Stripe cohort remains unverified.
These must not be described as completed production features or measured users.

Karl explicitly authorized review, merge, a second review and deployment after
being informed of the Friday elevated-release rule. This release is authorized
outside the usual window; it does not change the standing rule.

## Post-merge review and production receipts

Record the actual merged SHA, deployed SHA, production assertions and remaining
limitations in the release handoff. Never infer a successful production price
response from container health or from unit fixtures.

The post-merge account-boundary review reproduced a third issue: validating an
OAuth connection through WTI tied account linking to price quota and benchmark
availability. Validation now uses the maintained MCP's `/v1/dashboard` account
endpoint, which bypasses data API quota. Only its success envelope is checked;
no account payload is returned to the model or logged. Market-data tools still
enforce entitlements and quotas through their existing REST endpoints.

Production authenticated review then passed price/comparison, 12 Henry Hub
curve contracts, 22 Brent daily observations and two VLSFO port quotes. Permian
remained explicitly unavailable. OAuth grant and revocation passed. The log
review found SDK proxy warnings because DigitalOcean forwards X-Forwarded-For
while this service intentionally uses connected peers. The SDK's warning-only
forwarded-header validation is explicitly disabled; trust-proxy stays false and
all SDK endpoint limits stay active. A global 60/min OAuth cap additionally
bounds rotating ingress peers. Native OAuth/handoff 429s now include Retry-After.
Regression tests reproduced the warnings and missing retry hint before the fix.
