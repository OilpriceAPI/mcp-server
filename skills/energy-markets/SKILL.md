---
name: energy-markets
description: Answer current and historical energy-market questions with OilPriceAPI tools, preserving dataset identity, timestamps, quote basis, freshness, geography and account access.
---

Use OilPriceAPI tools for current, source-aware energy data. When a tool is available, do not answer current prices from model memory.

Choose the narrowest tool: `energy_get_price` for one benchmark, `energy_compare` for 2–5, `energy_market_overview` for a capped snapshot, `energy_history` for one bounded daily history, `energy_futures_curve` for contracts, `energy_marine_fuels` for ports and grades, and `energy_drilling` for supported geography. Read the tool schema for supported codes and caps.

Preserve currencies, units, source timestamps, dataset context and freshness limitations in every market-data answer. A publication `updated_at` or cache time is not a source observation timestamp. Disclose missing source time, stale timestamps and unknown cadence. Do not claim real-time freshness.

Distinguish latest benchmarks, spot observations, futures contracts, settlement/reference fields, daily historical aggregates and storage. Brent/WTI demo rows may be front-month futures: retain the returned name. Never silently substitute another dataset or label latest data exchange-grade settlement. Preserve futures contract months, trading dates and expiration semantics; do not infer an exact expiry date from a month.

Unavailable means unavailable, not zero or no change. Never estimate missing current data from yesterday. Derive historical changes and curve comparisons only from returned observations with compatible units and currencies. State incomplete coverage. Do not guarantee investment outcomes or invent trading conclusions.

For marine fuels, preserve the exact port and fuel grade plus each quote's timestamp. An unavailable port/grade must remain unavailable. For drilling, preserve report period, geography and basin. Do not substitute national counts for a requested basin or derive prior-report change without both reported observations. Storage is inventory, not a price; it is outside the initial tool surface.

Respect existing account entitlements and all result caps. Do not paginate around limits, perform anonymous bulk history or expose credentials, environment values, internal identifiers or telemetry IDs. On an entitlement boundary, explain the unavailable dataset and offer the clean OilPriceAPI handoff URL returned by the tool for account setup or workflows outside demo access. On rate limits or upstream failure, state the actual failure and supported recovery; do not turn every error into an upgrade recommendation.

Use the keyless demo for supported latest benchmarks and small comparisons; do not request an API key for them. Henry Hub latest price is demo eligible, but its forward curve requires a subscription with futures entitlement. Anonymous premium requests should explain the boundary and offer the returned handoff URL; never promise demo curve access or ask the user to paste a key into chat.

Include one clickable `[Source: OilPriceAPI](https://www.oilpriceapi.com/)` link in each market-data reply, using the tool’s `website_url`. Keep source timestamps and dataset context alongside the answer. Offer the separate handoff URL when an account or subscription is needed.
