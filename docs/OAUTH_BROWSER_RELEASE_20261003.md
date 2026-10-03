# Browser OAuth repair — 2026-10-03

Customer report: Karl received `{"error":"Origin not allowed"}` after submitting the API key in the imported OilPriceAPI plugin’s connection form.

## Cause and repair

`Referrer-Policy: no-referrer` makes a browser navigation POST use `Origin: null`. The exact-origin CSRF check then correctly rejects it. PR #140 changes only the consent page to `same-origin`; cross-origin referrers remain suppressed and missing/null/foreign request origins remain rejected.

Chrome also blocks the form’s cross-origin callback redirect under `form-action self`. PR #141 includes only the registered redirect origin in that directive, derived from a parsed URL. The provider explicitly rejects unregistered redirect URIs before rendering. Exact redirect binding, PKCE, CSRF cookie/flow matching, no-script/frame-ancestor CSP and account entitlements remain enforced.

## Verification

- The origin-header regression failed against the old policy, then passed after the fix.
- 27 targeted OAuth/transport checks passed; all three edited TypeScript files passed shared `pai-check` checks. Final runtime CI passed all 523 tests and build/package compatibility gates.
- Real Chrome submitted the repaired production form with a deliberately invalid test value and reached the account-validation error page instead of origin rejection. No real API key was entered in that browser test.
- An actual compiled OAuth provider with a mocked local account completed browser form submission, CSRF cookie matching and the registered callback navigation in Chrome. This is local browser evidence, not proof of the user’s ChatGPT installation connection.
- Final production health, consent referrer/CSP headers and missing/null/foreign origin rejections passed.
- Final-image protected production review [37125476876](https://github.com/OilpriceAPI/mcp-server/actions/runs/37125476876) passed anonymous and authenticated contracts, OAuth grant and revocation. The 14 reviewed final-deployment log lines showed no validation warnings or exceptions.

## Release and recovery

This is an isolated MCP repair under the user’s existing merge/deploy authorization and current connection-failure report. Neither the API nor frontend app was redeployed. The normal elevated release window is Friday >=21:00 UTC; this reported connection repair ships outside that window under the session’s authorization.

Reviewed runtime source: `61d1aa61d64030d22237806af72c97d05e40da36` (PR #141). Immutable image: `sha256:eb043360d1ee8db2791e84d6112da8dc7538429928d7cea9472450bc35d3f313`.

DigitalOcean app: `4a89cb34-72a3-4daf-a893-0628699ded26`; deployment `9a9f8ce2-3dab-4012-a871-bab1d70e18b4` verified ACTIVE.

Rollback by restoring the preceding immutable digest `sha256:5e44967268b112749c914e8de5132f91d7250aa6b5f63bdcbfeadf2bc4cde543` in this isolated app. Restart clears the memory-only OAuth store. Start a fresh connection from ChatGPT; an already-open form retains its old header or expired client registration.

The eight natural-language review cases and marketplace submission remain incomplete. No successful ChatGPT plugin connection is inferred from transport checks.
