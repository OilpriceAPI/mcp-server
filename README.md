# OilPriceAPI MCP Server

**The energy commodity MCP server.** Real-time oil, gas, and commodity prices for Claude, Cursor, VS Code, and any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/oilpriceapi-mcp)](https://www.npmjs.com/package/oilpriceapi-mcp)
[![license](https://img.shields.io/npm/l/oilpriceapi-mcp)](LICENSE)

## Features

- **18 Tools** — spot prices, history, futures, marine fuels, rig counts, diesel by state, storage, OPEC production, forecasts, EIA oil inventories, well permits, refining spreads
- **5 Resources** — subscribable price snapshots for Brent, WTI, Natural Gas, Diesel, and all commodities
- **6 Prompts** — pre-built analyst templates (daily briefing, spread analysis, gas markets, commodity report, diesel costs, supply analysis)
- **Natural language** — ask for "brent oil" or "natural gas", not codes
- **70+ commodities** — oil, gas, coal, refined products, metals, forex, bunker fuels, state diesel
- **Smart errors** — unrecognized commodities get suggestions, not silent fallbacks

## Quick Start

```bash
npx oilpriceapi-mcp
```

## Installation

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

| Variable               | Required | Description                                                                                                                                                 |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OILPRICEAPI_KEY`      | Yes      | API key from [oilpriceapi.com/signup](https://www.oilpriceapi.com/signup?utm_source=npm&utm_medium=mcp&utm_campaign=readme). Free tier: 200 requests/month. |
| `OILPRICEAPI_BASE_URL` | No       | Override API base URL (for staging/testing). Default: `https://api.oilpriceapi.com`                                                                         |

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
