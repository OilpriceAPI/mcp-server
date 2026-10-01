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
