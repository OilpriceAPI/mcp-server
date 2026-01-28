# OilPriceAPI MCP Server

Real-time oil, gas, and commodity prices for Claude Desktop and Claude Code via the Model Context Protocol.

## Features

- **Real-time prices** for 40+ commodities (oil, gas, coal, refined products)
- **Natural language queries** - ask for "brent oil" or "natural gas", not codes
- **Market overviews** - get all prices at once
- **Price comparisons** - compare Brent vs WTI, US vs European gas

## Installation

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "oilpriceapi": {
      "command": "npx",
      "args": ["oilpriceapi-mcp"],
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
      "args": ["oilpriceapi-mcp"],
      "env": {
        "OILPRICEAPI_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or install globally:

```bash
npm install -g oilpriceapi-mcp
```

## Getting an API Key

1. Sign up at [oilpriceapi.com](https://oilpriceapi.com)
2. Get your API key from the dashboard
3. Add it to your MCP config as shown above

## Available Tools

### `get_commodity_price`

Get the current price of a specific commodity.

**Examples:**
- "What's the current Brent oil price?"
- "Get the price of natural gas"
- "How much is WTI crude?"

### `get_market_overview`

Get prices for all commodities, optionally filtered by category.

**Categories:** `oil`, `gas`, `coal`, `refined`, `all`

**Examples:**
- "Give me a market overview"
- "Show all oil prices"
- "What are the current gas prices?"

### `compare_prices`

Compare prices between 2-5 commodities.

**Examples:**
- "Compare Brent and WTI prices"
- "What's the spread between US and European gas?"

### `list_commodities`

List all available commodities and their codes.

## Supported Commodities

### Crude Oil
- Brent Crude (global benchmark)
- WTI (US benchmark)
- Urals (Russian)
- Dubai (Middle East)

### Natural Gas
- US Henry Hub ($/MMBtu)
- UK NBP (pence/therm)
- European TTF (€/MWh)

### Coal
- Thermal Coal
- Newcastle Coal (Asia-Pacific)

### Refined Products
- Diesel
- Gasoline
- RBOB Gasoline
- Jet Fuel
- Heating Oil

### Other
- Gold
- EU Carbon Allowances
- EUR/USD, GBP/USD exchange rates

## Natural Language Support

You don't need to know the exact commodity codes. Just ask naturally:

| You say | We understand |
|---------|---------------|
| "brent oil", "brent crude" | BRENT_CRUDE_USD |
| "wti", "us oil", "american oil" | WTI_USD |
| "natural gas", "gas", "henry hub" | NATURAL_GAS_USD |
| "european gas", "ttf" | DUTCH_TTF_EUR |
| "diesel", "diesel fuel" | DIESEL_USD |
| "gold" | GOLD_USD |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
OILPRICEAPI_KEY=your-key node build/index.js
```

## License

MIT

## Links

- [OilPriceAPI Website](https://oilpriceapi.com)
- [API Documentation](https://docs.oilpriceapi.com)
- [MCP Protocol](https://modelcontextprotocol.io)
