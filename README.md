# OilPriceAPI MCP Server

**The energy commodity MCP server.** Real-time oil, gas, and commodity prices for Claude, Cursor, VS Code, and any MCP-compatible client.

[![npm](https://img.shields.io/npm/v/oilpriceapi-mcp)](https://www.npmjs.com/package/oilpriceapi-mcp)
[![license](https://img.shields.io/npm/l/oilpriceapi-mcp)](LICENSE)

<a href="https://glama.ai/mcp/servers/OilpriceAPI/oil-price-api">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/OilpriceAPI/oil-price-api/badge" alt="OilPriceAPI MCP server" />
</a>

## Features

- **4 Tools** — get prices, market overviews, price comparisons, commodity listings
- **4 Resources** — subscribable price snapshots for Brent, WTI, Natural Gas, and all commodities
- **4 Prompts** — pre-built analyst templates (daily briefing, spread analysis, gas market, commodity report)
- **Natural language** — ask for "brent oil" or "natural gas", not codes
- **40+ commodities** — oil, gas, coal, refined products, metals, forex

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

### Cody (VS Code)

Add to `.vscode/cody.json` in your project root:

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

## Getting an API Key

1. Sign up at [oilpriceapi.com/signup](https://www.oilpriceapi.com/signup?utm_source=npm&utm_medium=mcp&utm_campaign=readme)
2. Get your API key from the dashboard
3. Add it to your MCP config as shown above

## Tools

### `get_commodity_price`

Get the current price of a specific commodity.

```
"What's the current Brent oil price?"
"Get the price of natural gas"
```

### `get_market_overview`

Get prices for all commodities, optionally filtered by category (`oil`, `gas`, `coal`, `refined`, `all`).

```
"Give me a market overview"
"Show all oil prices"
```

### `compare_prices`

Compare prices between 2-5 commodities.

```
"Compare Brent and WTI prices"
"What's the spread between US and European gas?"
```

### `list_commodities`

List all available commodities and their codes.

## Resources

Subscribable price data (JSON):

| Resource    | URI                   | Description                      |
| ----------- | --------------------- | -------------------------------- |
| Brent Crude | `price://brent`       | Global benchmark crude oil price |
| WTI Crude   | `price://wti`         | US benchmark crude oil price     |
| Natural Gas | `price://natural-gas` | US Henry Hub natural gas price   |
| All Prices  | `price://all`         | All tracked commodity prices     |

## Prompts

Pre-built analyst templates:

| Prompt                | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `daily-briefing`      | Energy market daily briefing with key prices and movers |
| `brent-wti-spread`    | Analyze the Brent-WTI crude oil spread                  |
| `gas-market-analysis` | Compare US vs European natural gas markets              |
| `commodity-report`    | Detailed report on a specific commodity (parameterized) |

## Supported Commodities

### Crude Oil

- Brent Crude (global benchmark)
- WTI (US benchmark)
- Urals (Russian)
- Dubai (Middle East)

### Natural Gas

- US Henry Hub ($/MMBtu)
- UK NBP (pence/therm)
- European TTF (EUR/MWh)

### Coal

- Thermal Coal
- Newcastle Coal (Asia-Pacific)

### Refined Products

- Diesel, Gasoline, RBOB Gasoline, Jet Fuel, Heating Oil

### Other

- Gold, EU Carbon Allowances, UK Carbon Allowances, EUR/USD, GBP/USD

## Natural Language Support

| You say                    | We understand   |
| -------------------------- | --------------- |
| "brent oil", "brent crude" | BRENT_CRUDE_USD |
| "wti", "us oil"            | WTI_USD         |
| "natural gas", "henry hub" | NATURAL_GAS_USD |
| "european gas", "ttf"      | DUTCH_TTF_EUR   |
| "diesel"                   | DIESEL_USD      |
| "gold"                     | GOLD_USD        |
| "lbma gold am fix"         | GOLD_AM_USD     |
| "lbma gold pm fix"         | GOLD_PM_USD     |
| "lbma silver fix"          | SILVER_FIX_USD  |

## Development

```bash
npm install
npm run build
OILPRICEAPI_KEY=your-key node build/index.js
```

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