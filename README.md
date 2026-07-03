# OilPriceAPI MCP Server

> **Give your AI agent real-time oil, gas, LNG, carbon and fuel prices in under 60 seconds** — works in Claude Desktop, Claude Code, Cursor, VS Code, and any MCP client. No API key needed to try it.

[![npm](https://img.shields.io/npm/v/oilpriceapi-mcp)](https://www.npmjs.com/package/oilpriceapi-mcp)
[![Downloads](https://img.shields.io/npm/dm/oilpriceapi-mcp)](https://www.npmjs.com/package/oilpriceapi-mcp)
[![license](https://img.shields.io/npm/l/oilpriceapi-mcp)](LICENSE)

**[Get a Free API Key](https://www.oilpriceapi.com/auth/signup?utm_source=mcp-readme)** · **[Documentation](https://docs.oilpriceapi.com)** · **[API Explorer](https://api.oilpriceapi.com/swagger)** · **[Pricing](https://www.oilpriceapi.com/pricing?utm_source=mcp-readme)**

Backed by [OilPriceAPI](https://oilpriceapi.com) — the commodity price API behind fintech dashboards, fleet & logistics tools, maritime compliance platforms and energy analytics products, serving **2M+ API requests every month**.

## Features

- **26 Tools** — 17 read tools (spot prices, history, futures, marine fuels, rig counts, diesel by state, storage, OPEC production, forecasts, EIA oil inventories, well permits, refining spreads) plus 4 authenticated price-alert tools (create/list/delete persistent alerts + trigger activity) and 5 agent tools (multi-commodity market briefs, persistent price watches)
- **5 Resources** — subscribable price snapshots for Brent, WTI, Natural Gas, Diesel, and all commodities
- **6 Prompts** — pre-built analyst templates (daily briefing, spread analysis, gas markets, commodity report, diesel costs, supply analysis)
- **Natural language** — ask for "brent oil" or "natural gas", not codes
- **70+ commodities** — oil, gas, coal, refined products, metals, forex, bunker fuels, state diesel
- **Smart errors** — unrecognized commodities get suggestions, not silent fallbacks

## Quick Start

```bash
npx oilpriceapi-mcp
```

## What can your agent get?

The 10 most-polled commodities across our customer base:

| Code              | What it is               | Typical agent use              |
| ----------------- | ------------------------ | ------------------------------ |
| `BRENT_CRUDE_USD` | Brent crude (global)     | market briefings, dashboards   |
| `WTI_USD`         | WTI crude (US)           | trading context, macro models  |
| `NATURAL_GAS_USD` | Henry Hub natural gas    | energy analytics               |
| `DUTCH_TTF_EUR`   | TTF gas (Europe)         | European energy, LNG analysis  |
| `JKM_LNG_USD`     | JKM LNG (Asia)           | LNG trading & shipping         |
| `EU_CARBON_EUR`   | EU ETS carbon allowances | CBAM, maritime compliance, ESG |
| `DIESEL_USD`      | Diesel (Gulf Coast)      | fleet & fuel-surcharge math    |
| `JET_FUEL_USD`    | Jet fuel                 | aviation ops                   |
| `VLSFO_USD`       | Marine bunker fuel       | voyage costing                 |
| `GOLD_USD`        | Gold                     | macro & portfolio context      |

## Installation

### Try it without an API key

The server works out of the box in **keyless demo mode** — just omit `OILPRICEAPI_KEY` from the configs below. The price tools (`opa_get_price`, `opa_compare_prices`, `opa_list_commodities`, `opa_market_overview`) serve **live prices** for a limited demo commodity set (Brent, WTI, diesel, gasoline, natural gas, gold, heating oil, EUR/USD, GBP/USD), and every other tool explains what it does and what its output looks like. Demo responses are marked with a footer. When you're ready for 40+ commodities, history, futures, and alerts, [get a free API key](https://oilpriceapi.com/auth/signup?utm_source=mcp-demo) and add it to your config.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "oilpriceapi": {
      "command": "npx",
      "args": ["-y", "oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "oilpriceapi": {
      "command": "npx",
      "args": ["-y", "oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "oilpriceapi": {
      "command": "npx",
      "args": ["-y", "oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

### VS Code + Cline

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "oilpriceapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "oilpriceapi": {
      "command": "npx",
      "args": ["-y", "oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Global Install

```bash
npm install -g oilpriceapi-mcp
```

## Environment Variables

| Variable               | Required | Description                                                                                                                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OILPRICEAPI_KEY`      | No       | API key from [oilpriceapi.com/signup](https://www.oilpriceapi.com/signup?utm_source=npm&utm_medium=mcp&utm_campaign=readme). Free tier: 200 requests/month. Without it the server runs in keyless demo mode (limited commodity set). |
| `OILPRICEAPI_BASE_URL` | No       | Override API base URL (for staging/testing). Default: `https://api.oilpriceapi.com`                                                                                                                                                  |

## Tools

All tools are prefixed with `opa_` to avoid name collisions when multiple MCP servers are loaded.

| Tool                      | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `opa_get_price`           | Current spot price for a single commodity                         |
| `opa_market_overview`     | All commodity prices in one call, grouped by category             |
| `opa_compare_prices`      | Side-by-side comparison of 2-5 commodities with spread            |
| `opa_list_commodities`    | Full commodity catalog (fetched live from API)                    |
| `opa_get_history`         | Historical prices with high/low/avg/change (day/week/month/year)  |
| `opa_get_futures`         | Front-month futures (Brent BZ, WTI CL, ICE Gasoil, TTF, JKM, EUA) |
| `opa_get_futures_curve`   | Full forward curve with contango/backwardation analysis           |
| `opa_get_marine_fuels`    | Bunker fuel prices by port and fuel type (VLSFO/MGO/IFO380)       |
| `opa_get_rig_counts`      | Baker Hughes US rig count with week-over-week change              |
| `opa_get_drilling`        | Drilling intelligence: wells, permits, completions by region      |
| `opa_get_diesel_by_state` | AAA retail diesel price for any US state (50 states + DC)         |
| `opa_get_storage`         | Cushing and SPR oil storage/inventory levels                      |
| `opa_get_opec_production` | OPEC country-level production data                                |
| `opa_get_forecasts`       | EIA STEO energy price forecasts                                   |
| `opa_get_oil_inventories` | EIA weekly petroleum stocks (latest/summary/by_product)           |
| `opa_get_well_permits`    | US well drilling permits (latest/by_state/by_operator)            |
| `opa_get_spread`          | Refining/trading spreads (crack, basis, margin)                   |

### Price Alert Tools (authenticated)

These tools create and manage **persistent** price alerts tied to your OilPriceAPI account, so they **require an API key** (`OILPRICEAPI_KEY`). The alert engine continuously watches live prices and notifies you (by email, plus webhook if you provide one) when a condition is met.

| Tool                     | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `opa_create_price_alert` | Create a persistent alert (commodity, operator, threshold, optional webhook) |
| `opa_list_price_alerts`  | List all alerts on the account                                               |
| `opa_delete_price_alert` | Permanently delete an alert by id                                            |
| `opa_get_alert_triggers` | Recent alert trigger activity (optionally filtered by `since`)               |

### Market Brief & Subscription Tools (authenticated)

The market brief gives a multi-commodity snapshot in one call. Subscriptions ("watches") are **persistent, recurring** snapshots tied to your account — the API records an event every interval, and the agent **polls** for new events via a per-user cursor (events are polled, not pushed — there is no always-on connection). These **require an API key** (`OILPRICEAPI_KEY`). A subscription differs from an alert: a watch always emits an event each interval (a running log), whereas an alert fires only on a threshold crossing. Per-tier limits apply (free: 1 watch, 3 codes, 1h minimum interval); the API returns the exact limit if exceeded.

| Tool                            | Description                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `opa_get_market_brief`          | Multi-commodity brief: prices, 24h changes, 1m forecasts, spreads, optional narrative |
| `opa_create_price_subscription` | Create a persistent recurring watch (codes, interval like `5m`/`1h`/`daily`)          |
| `opa_list_subscriptions`        | List all subscriptions on the account                                                 |
| `opa_delete_subscription`       | Permanently delete a subscription by id                                               |
| `opa_get_subscription_events`   | Poll for new watch events since a cursor (`since`); returns snapshots + deltas        |

## Example Questions

```
"What's the current Brent oil price?"
"Compare Brent and WTI crude"
"Show me oil prices for the past month"
"What's diesel cost in California vs Texas?"
"Give me a market overview of refined products"
"What's the Brent futures curve look like?"
"How many oil rigs are active in the US?"
"What are OPEC production levels?"
"What are bunker fuel prices in Singapore?"
"Show me Cushing storage levels"
"What were the latest EIA crude oil inventories?"
"How many well permits were issued in Texas?"
"What's the current 3-2-1 crack spread?"
"Show me the ICE Gasoil futures curve"
```

## Resources

Subscribable price data (JSON):

| Resource    | URI                   | Description                      |
| ----------- | --------------------- | -------------------------------- |
| Brent Crude | `price://brent`       | Global benchmark crude oil price |
| WTI Crude   | `price://wti`         | US benchmark crude oil price     |
| Natural Gas | `price://natural-gas` | US Henry Hub natural gas price   |
| Diesel      | `price://diesel`      | US national average diesel price |
| All Prices  | `price://all`         | All tracked commodity prices     |

## Prompts

Pre-built analyst templates:

| Prompt                 | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `daily-briefing`       | Energy market daily briefing with key prices and movers   |
| `brent-wti-spread`     | Analyze the Brent-WTI crude oil spread                    |
| `gas-market-analysis`  | Compare US vs European natural gas markets                |
| `commodity-report`     | Detailed report on a specific commodity (parameterized)   |
| `diesel-cost-analysis` | Compare diesel prices across US states for fleet planning |
| `supply-analysis`      | Analyze supply using OPEC production, rig counts, storage |

## Natural Language Support

| You say                     | We understand   |
| --------------------------- | --------------- |
| "brent oil", "brent crude"  | BRENT_CRUDE_USD |
| "wti", "us oil"             | WTI_USD         |
| "natural gas", "henry hub"  | NATURAL_GAS_USD |
| "european gas", "ttf"       | DUTCH_TTF_EUR   |
| "diesel"                    | DIESEL_USD      |
| "gold"                      | GOLD_USD        |
| "jet fuel", "aviation fuel" | JET_FUEL_USD    |
| "carbon", "carbon credits"  | EU_CARBON_EUR   |

## Development

```bash
npm install
npm run build
npm test
OILPRICEAPI_KEY=your-key node build/index.js
```

## Breaking Changes in v2.0.0

- All tool names now use `opa_` prefix (e.g., `get_commodity_price` -> `opa_get_price`)
- Unrecognized commodity names now return an error with suggestions instead of silently defaulting to Brent
- `list_commodities` now fetches live from the API (falls back to static list if unavailable)

## The whole OilPriceAPI toolbox

Same data, every stack:

| Tool                                                                            | Install                                        |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| [Python SDK](https://github.com/OilpriceAPI/python-sdk)                         | `pip install oilpriceapi`                      |
| [Node/TypeScript SDK](https://github.com/OilpriceAPI/oilpriceapi-node)          | `npm install oilpriceapi`                      |
| [PHP SDK](https://github.com/OilpriceAPI/oilpriceapi-php)                       | `composer require oilpriceapi/oilpriceapi`     |
| [Go SDK](https://github.com/OilpriceAPI/oilpriceapi-go)                         | `go get github.com/OilpriceAPI/oilpriceapi-go` |
| [WordPress plugin](https://github.com/OilpriceAPI/oilpriceapi-wordpress-plugin) | no-code price widgets                          |

## Explore the API

- 🧭 **Interactive explorer**: [api.oilpriceapi.com/swagger](https://api.oilpriceapi.com/swagger) — try every endpoint in the browser (demo mode, no key needed)
- 📜 **OpenAPI spec**: [swagger.json](https://api.oilpriceapi.com/swagger.json)

## Privacy Policy

This MCP server runs locally on your machine and only communicates with the OilPriceAPI service:

- **What is sent**: tool requests are translated into HTTPS calls to `api.oilpriceapi.com` (commodity codes, query parameters such as time period or state, and — for alert/subscription tools — the alert parameters you specify), authenticated with your API key. **No conversation content is transmitted** — only the structured tool inputs above.
- **API key storage**: your key is stored locally in your MCP client's configuration (or the `OILPRICEAPI_KEY` environment variable). It is sent only to `api.oilpriceapi.com` as an Authorization header.
- **Logging**: API requests are logged by OilPriceAPI as described in the [OilPriceAPI Privacy Policy](https://www.oilpriceapi.com/privacy).
- **Third parties**: no data is shared with third parties beyond what that policy describes.
- **Demo mode**: without an API key, price tools call the keyless demo endpoint on the same host; no key or account data is involved.

Questions: [support@oilpriceapi.com](mailto:support@oilpriceapi.com)

## License

MIT

## Links

- [OilPriceAPI](https://www.oilpriceapi.com)
- [API Documentation](https://docs.oilpriceapi.com)
- [Pricing](https://www.oilpriceapi.com/pricing?utm_source=npm&utm_medium=mcp&utm_campaign=pricing)
- [MCP Protocol](https://modelcontextprotocol.io)

## Also Available As

- **[Python SDK](https://pypi.org/project/oilpriceapi/)** - Python client with Pandas integration
- **[Node.js SDK](https://www.npmjs.com/package/oilpriceapi)** - TypeScript/JavaScript SDK
- **[Go SDK](https://github.com/OilpriceAPI/oilpriceapi-go)** - Idiomatic Go client
- **[OpenBB Integration](https://pypi.org/project/openbb-oilpriceapi/)** - OpenBB Platform provider
