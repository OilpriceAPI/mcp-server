#!/usr/bin/env node

/**
 * OilPriceAPI MCP Server
 *
 * Provides real-time oil, gas, and commodity prices through the Model Context Protocol.
 * For use with Claude Desktop, Claude Code, and other MCP-compatible clients.
 *
 * @see https://oilpriceapi.com
 * @see https://modelcontextprotocol.io
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// API Configuration
const API_BASE = "https://api.oilpriceapi.com";
export const USER_AGENT = "oilpriceapi-mcp/1.2.0";

// Get API key from environment
const API_KEY = process.env.OILPRICEAPI_KEY || process.env.OIL_PRICE_API_KEY;

// Natural language to commodity code mapping
export const COMMODITY_ALIASES: Record<string, string> = {
  // Crude Oil
  brent: "BRENT_CRUDE_USD",
  "brent oil": "BRENT_CRUDE_USD",
  "brent crude": "BRENT_CRUDE_USD",
  "brent crude oil": "BRENT_CRUDE_USD",
  "north sea oil": "BRENT_CRUDE_USD",
  wti: "WTI_USD",
  "wti oil": "WTI_USD",
  "wti crude": "WTI_USD",
  "west texas": "WTI_USD",
  "us oil": "WTI_USD",
  "american oil": "WTI_USD",
  "russian oil": "URALS_CRUDE_USD",
  urals: "URALS_CRUDE_USD",
  "urals crude": "URALS_CRUDE_USD",
  dubai: "DUBAI_CRUDE_USD",
  "dubai crude": "DUBAI_CRUDE_USD",
  "dubai oil": "DUBAI_CRUDE_USD",
  "middle east oil": "DUBAI_CRUDE_USD",

  // Natural Gas
  "natural gas": "NATURAL_GAS_USD",
  gas: "NATURAL_GAS_USD",
  "nat gas": "NATURAL_GAS_USD",
  "henry hub": "NATURAL_GAS_USD",
  "us gas": "NATURAL_GAS_USD",
  "us natural gas": "NATURAL_GAS_USD",
  "uk gas": "NATURAL_GAS_GBP",
  "uk natural gas": "NATURAL_GAS_GBP",
  "british gas": "NATURAL_GAS_GBP",
  "european gas": "DUTCH_TTF_EUR",
  ttf: "DUTCH_TTF_EUR",
  "dutch ttf": "DUTCH_TTF_EUR",
  "eu gas": "DUTCH_TTF_EUR",

  // Coal
  coal: "COAL_USD",
  "thermal coal": "COAL_USD",
  "newcastle coal": "NEWCASTLE_COAL_USD",
  "australian coal": "NEWCASTLE_COAL_USD",

  // Refined Products
  diesel: "DIESEL_USD",
  "diesel fuel": "DIESEL_USD",
  gasoline: "GASOLINE_USD",
  petrol: "GASOLINE_USD",
  "gas fuel": "GASOLINE_USD",
  rbob: "GASOLINE_RBOB_USD",
  "rbob gasoline": "GASOLINE_RBOB_USD",
  "jet fuel": "JET_FUEL_USD",
  "aviation fuel": "JET_FUEL_USD",
  kerosene: "JET_FUEL_USD",
  "heating oil": "HEATING_OIL_USD",

  // Other
  gold: "GOLD_USD",
  carbon: "EU_CARBON_EUR",
  "eu carbon": "EU_CARBON_EUR",
  "carbon credits": "EU_CARBON_EUR",
  euro: "EUR_USD",
  "eur usd": "EUR_USD",
  pound: "GBP_USD",
  "gbp usd": "GBP_USD",
  sterling: "GBP_USD",
};

// Commodity metadata for formatting
export const COMMODITY_INFO: Record<string, { name: string; unit: string }> = {
  BRENT_CRUDE_USD: { name: "Brent Crude Oil", unit: "barrel" },
  WTI_USD: { name: "WTI Crude Oil", unit: "barrel" },
  URALS_CRUDE_USD: { name: "Urals Crude Oil", unit: "barrel" },
  DUBAI_CRUDE_USD: { name: "Dubai Crude Oil", unit: "barrel" },
  NATURAL_GAS_USD: { name: "US Natural Gas (Henry Hub)", unit: "MMBtu" },
  NATURAL_GAS_GBP: { name: "UK Natural Gas", unit: "therm" },
  DUTCH_TTF_EUR: { name: "European Natural Gas (TTF)", unit: "MWh" },
  COAL_USD: { name: "Coal", unit: "metric ton" },
  NEWCASTLE_COAL_USD: { name: "Newcastle Coal", unit: "metric ton" },
  DIESEL_USD: { name: "Diesel", unit: "gallon" },
  GASOLINE_USD: { name: "Gasoline", unit: "gallon" },
  GASOLINE_RBOB_USD: { name: "RBOB Gasoline", unit: "gallon" },
  JET_FUEL_USD: { name: "Jet Fuel", unit: "gallon" },
  HEATING_OIL_USD: { name: "Heating Oil", unit: "gallon" },
  GOLD_USD: { name: "Gold", unit: "troy oz" },
  EU_CARBON_EUR: { name: "EU Carbon Allowances", unit: "metric ton CO2" },
  EUR_USD: { name: "Euro to USD", unit: "rate" },
  GBP_USD: { name: "British Pound to USD", unit: "rate" },
};

// Available commodity codes
export const COMMODITY_CODES = [
  "BRENT_CRUDE_USD",
  "WTI_USD",
  "URALS_CRUDE_USD",
  "DUBAI_CRUDE_USD",
  "NATURAL_GAS_USD",
  "NATURAL_GAS_GBP",
  "DUTCH_TTF_EUR",
  "COAL_USD",
  "NEWCASTLE_COAL_USD",
  "DIESEL_USD",
  "GASOLINE_USD",
  "GASOLINE_RBOB_USD",
  "JET_FUEL_USD",
  "HEATING_OIL_USD",
  "GOLD_USD",
  "EU_CARBON_EUR",
  "EUR_USD",
  "GBP_USD",
] as const;

// Types
interface PriceData {
  code: string;
  price: number;
  currency: string;
  created_at?: string;
  updated_at?: string;
  change_24h?: number;
  change_24h_percent?: number;
}

export interface ApiResponse<T> {
  status: string;
  data: T;
}

interface AllPricesData {
  prices: Record<string, PriceData>;
  count: number;
  timestamp: string;
}

interface HistoricalPriceData {
  prices: Array<{
    price: number;
    created_at: string;
    code?: string;
  }>;
}

interface FuturesData {
  contracts: Array<{
    contract: string;
    month: string;
    price: number;
    change?: number;
    volume?: number;
  }>;
}

interface MarineFuelPrice {
  port: string;
  fuel_type: string;
  price: number;
  currency: string;
  unit: string;
  region?: string;
}

interface MarineFuelsData {
  prices: MarineFuelPrice[];
}

interface RigCountData {
  oil: number;
  gas: number;
  total: number;
  misc?: number;
  change_from_prior_week?: number;
  date: string;
  source?: string;
}

interface DrillingData {
  total_wells: number;
  active_rigs: number;
  permits_issued?: number;
  completions?: number;
  region_breakdown?: Array<{ region: string; count: number }>;
  date: string;
}

// Create server instance
const server = new McpServer({
  name: "oilpriceapi",
  version: "1.2.0",
});

/**
 * Resolve a natural language commodity name to its API code
 */
export function resolveCommodityCode(input: string): string {
  const normalized = input.toLowerCase().trim();

  // Check if it's already a valid code
  if (
    COMMODITY_CODES.includes(
      normalized.toUpperCase() as (typeof COMMODITY_CODES)[number],
    )
  ) {
    return normalized.toUpperCase();
  }

  // Try alias mapping
  const mapped = COMMODITY_ALIASES[normalized];
  if (mapped) {
    return mapped;
  }

  // Fuzzy match - check if input contains key words
  for (const [alias, code] of Object.entries(COMMODITY_ALIASES)) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return code;
    }
  }

  // Default to Brent if no match
  return "BRENT_CRUDE_USD";
}

/**
 * Format a price for display
 */
export function formatPrice(data: PriceData): string {
  const info = COMMODITY_INFO[data.code] || { name: data.code, unit: "unit" };
  const currencySymbol =
    data.currency === "EUR"
      ? "€"
      : data.currency === "GBP" || data.currency === "GBp"
        ? "£"
        : "$";

  let result = `**${info.name}**: ${currencySymbol}${data.price.toFixed(2)}/${info.unit}`;

  if (data.change_24h !== undefined && data.change_24h_percent !== undefined) {
    const sign = data.change_24h >= 0 ? "+" : "-";
    const absChange = Math.abs(data.change_24h).toFixed(2);
    const absPct = Math.abs(data.change_24h_percent).toFixed(2);
    result += `\n- 24h Change: ${sign}${currencySymbol}${absChange} (${sign}${absPct}%)`;
  }

  const timestamp = data.updated_at || data.created_at;
  if (timestamp) {
    const date = new Date(timestamp);
    result += `\n- Updated: ${date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    })} UTC`;
  }

  return result;
}

/**
 * Make API request to OilPriceAPI with retry and exponential backoff
 */
export async function makeApiRequest<T>(
  endpoint: string,
  fetchFn: typeof fetch = fetch,
): Promise<T | null> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(`${API_BASE}${endpoint}`, { headers });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 401) {
        console.error(
          "Authentication failed. Check OILPRICEAPI_KEY environment variable.",
        );
        return null;
      }

      // Retry on 429 and 5xx
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < maxRetries
      ) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10), 60) * 1000
          : Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable HTTP error (403, 404, etc.) — return null immediately
      console.error(
        `HTTP ${response.status}: ${response.statusText} for ${endpoint}`,
      );
      return null;
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(
          `API request failed after ${maxRetries + 1} attempts: ${endpoint}`,
          error,
        );
        return null;
      }
      // Network error - retry with backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}

// Register Tools

/**
 * Get current price of a specific commodity
 */
server.tool(
  "get_commodity_price",
  "Get the current real-time price of an oil, gas, or energy commodity. Use natural language like 'brent oil', 'natural gas', 'wti', or 'diesel'.",
  {
    commodity: z
      .string()
      .describe(
        "Commodity name or code (e.g., 'brent oil', 'natural gas', 'WTI_USD', 'diesel')",
      ),
  },
  async ({ commodity }) => {
    const code = resolveCommodityCode(commodity);

    const response = await makeApiRequest<ApiResponse<PriceData>>(
      `/v1/prices/latest?by_code=${code}`,
    );

    if (!response || response.status !== "success") {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve price for ${commodity}. Please try again or check if the commodity is supported.`,
          },
        ],
      };
    }

    const formatted = formatPrice(response.data);

    return {
      content: [
        {
          type: "text",
          text: `${formatted}\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`,
        },
      ],
    };
  },
);

/**
 * Get all commodity prices (market overview)
 */
server.tool(
  "get_market_overview",
  "Get current prices for all tracked commodities. Returns a market overview with oil, gas, coal, and refined product prices.",
  {
    category: z
      .enum(["all", "oil", "gas", "coal", "refined"])
      .optional()
      .describe("Filter by commodity category (default: all)"),
  },
  async ({ category = "all" }) => {
    const response =
      await makeApiRequest<ApiResponse<{ data: AllPricesData }>>(
        "/v1/prices/all",
      );

    if (!response || response.status !== "success") {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve market data. Please try again.",
          },
        ],
      };
    }

    const prices = response.data.data.prices;

    // Category filters
    const categoryFilters: Record<string, string[]> = {
      oil: ["BRENT_CRUDE_USD", "WTI_USD", "URALS_CRUDE_USD", "DUBAI_CRUDE_USD"],
      gas: ["NATURAL_GAS_USD", "NATURAL_GAS_GBP", "DUTCH_TTF_EUR"],
      coal: ["COAL_USD", "NEWCASTLE_COAL_USD"],
      refined: [
        "DIESEL_USD",
        "GASOLINE_USD",
        "GASOLINE_RBOB_USD",
        "JET_FUEL_USD",
        "HEATING_OIL_USD",
      ],
    };

    let filteredCodes: string[];
    if (category === "all") {
      filteredCodes = Object.keys(prices);
    } else {
      filteredCodes = categoryFilters[category] || [];
    }

    const sections: string[] = ["# Energy Market Overview\n"];

    // Group by category
    const groupedPrices: Record<string, PriceData[]> = {
      "Crude Oil": [],
      "Natural Gas": [],
      Coal: [],
      "Refined Products": [],
      Other: [],
    };

    for (const code of filteredCodes) {
      const data = prices[code];
      if (!data) continue;

      if (code.includes("CRUDE") || code === "WTI_USD") {
        groupedPrices["Crude Oil"].push(data);
      } else if (code.includes("GAS") || code.includes("TTF")) {
        groupedPrices["Natural Gas"].push(data);
      } else if (code.includes("COAL")) {
        groupedPrices["Coal"].push(data);
      } else if (
        [
          "DIESEL_USD",
          "GASOLINE_USD",
          "GASOLINE_RBOB_USD",
          "JET_FUEL_USD",
          "HEATING_OIL_USD",
          "ULSD_DIESEL_USD",
        ].includes(code)
      ) {
        groupedPrices["Refined Products"].push(data);
      } else {
        groupedPrices["Other"].push(data);
      }
    }

    for (const [group, items] of Object.entries(groupedPrices)) {
      if (items.length === 0) continue;

      sections.push(`## ${group}\n`);
      for (const item of items) {
        const info = COMMODITY_INFO[item.code] || {
          name: item.code,
          unit: "unit",
        };
        const currencySymbol =
          item.currency === "EUR"
            ? "€"
            : item.currency === "GBP" || item.currency === "GBp"
              ? "£"
              : "$";

        let line = `- **${info.name}**: ${currencySymbol}${item.price.toFixed(2)}`;

        if (item.change_24h_percent !== undefined) {
          const sign = item.change_24h_percent >= 0 ? "+" : "";
          line += ` (${sign}${item.change_24h_percent.toFixed(1)}%)`;
        }

        sections.push(line);
      }
      sections.push("");
    }

    sections.push(
      `_Updated: ${new Date(response.data.data.timestamp).toLocaleString(
        "en-US",
        {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        },
      )} UTC | Data from [OilPriceAPI](https://oilpriceapi.com)_`,
    );

    return {
      content: [
        {
          type: "text",
          text: sections.join("\n"),
        },
      ],
    };
  },
);

/**
 * Compare prices between commodities
 */
server.tool(
  "compare_prices",
  "Compare current prices between multiple commodities (e.g., Brent vs WTI, US gas vs European gas).",
  {
    commodities: z
      .array(z.string())
      .min(2)
      .max(5)
      .describe("List of commodities to compare (2-5 items)"),
  },
  async ({ commodities }) => {
    const codes = commodities.map(resolveCommodityCode);
    const results: PriceData[] = [];

    for (const code of codes) {
      const response = await makeApiRequest<ApiResponse<PriceData>>(
        `/v1/prices/latest?by_code=${code}`,
      );

      if (response?.status === "success") {
        results.push(response.data);
      }
    }

    if (results.length < 2) {
      return {
        content: [
          {
            type: "text",
            text: "Could not retrieve enough price data for comparison. Please check commodity names.",
          },
        ],
      };
    }

    const sections = ["# Price Comparison\n"];

    for (const data of results) {
      sections.push(formatPrice(data));
      sections.push("");
    }

    // Calculate spread if comparing similar commodities
    if (results.length === 2 && results[0].currency === results[1].currency) {
      const spread = Math.abs(results[0].price - results[1].price);
      const info0 = COMMODITY_INFO[results[0].code]?.name || results[0].code;
      const info1 = COMMODITY_INFO[results[1].code]?.name || results[1].code;
      sections.push(`**Spread**: $${spread.toFixed(2)} (${info0} vs ${info1})`);
    }

    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);

    return {
      content: [
        {
          type: "text",
          text: sections.join("\n"),
        },
      ],
    };
  },
);

/**
 * List available commodities
 */
server.tool(
  "list_commodities",
  "List all available commodities that can be queried for prices.",
  {},
  async () => {
    const sections = ["# Available Commodities\n"];

    sections.push("## Crude Oil");
    sections.push("- `BRENT_CRUDE_USD` - Brent Crude (global benchmark)");
    sections.push("- `WTI_USD` - West Texas Intermediate (US benchmark)");
    sections.push("- `URALS_CRUDE_USD` - Urals Crude (Russian)");
    sections.push("- `DUBAI_CRUDE_USD` - Dubai Crude (Middle East)");
    sections.push("");

    sections.push("## Natural Gas");
    sections.push("- `NATURAL_GAS_USD` - US Henry Hub ($/MMBtu)");
    sections.push("- `NATURAL_GAS_GBP` - UK NBP (pence/therm)");
    sections.push("- `DUTCH_TTF_EUR` - European TTF (€/MWh)");
    sections.push("");

    sections.push("## Coal");
    sections.push("- `COAL_USD` - Thermal Coal");
    sections.push("- `NEWCASTLE_COAL_USD` - Newcastle (Asia-Pacific)");
    sections.push("");

    sections.push("## Refined Products");
    sections.push("- `DIESEL_USD` - Diesel");
    sections.push("- `GASOLINE_USD` - Gasoline");
    sections.push("- `GASOLINE_RBOB_USD` - RBOB Gasoline");
    sections.push("- `JET_FUEL_USD` - Jet Fuel");
    sections.push("- `HEATING_OIL_USD` - Heating Oil");
    sections.push("");

    sections.push("## Other");
    sections.push("- `GOLD_USD` - Gold");
    sections.push("- `EU_CARBON_EUR` - EU Carbon Allowances");
    sections.push("- `EUR_USD` - Euro to USD");
    sections.push("- `GBP_USD` - British Pound to USD");
    sections.push("");

    sections.push(
      "_You can use natural language like 'brent oil' or 'natural gas' - I'll translate it to the right code._",
    );

    return {
      content: [
        {
          type: "text",
          text: sections.join("\n"),
        },
      ],
    };
  },
);

/**
 * Get historical price data for a commodity
 */
server.tool(
  "get_historical_prices",
  "Get historical price data for a commodity over a time period (past day, week, month, or year).",
  {
    commodity: z.string().describe("Commodity name or code"),
    period: z
      .enum(["day", "week", "month", "year"])
      .default("month")
      .describe("Time period"),
  },
  async ({ commodity, period }) => {
    const code = resolveCommodityCode(commodity);
    const response = await makeApiRequest<ApiResponse<HistoricalPriceData>>(
      `/v1/prices/past_${period}?by_code=${code}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.prices?.length
    ) {
      return {
        content: [
          {
            type: "text",
            text: `No historical data found for ${commodity} over the past ${period}.`,
          },
        ],
      };
    }

    const info = COMMODITY_INFO[code] || { name: code, unit: "unit" };
    // Derive currency symbol from commodity code (same logic as formatPrice)
    const currencyFromCode = code.endsWith("_EUR")
      ? "EUR"
      : code.endsWith("_GBP") || code.endsWith("_GBp")
        ? "GBP"
        : "USD";
    const historicalCurrencySymbol =
      currencyFromCode === "EUR" ? "€" : currencyFromCode === "GBP" ? "£" : "$";
    const prices = response.data.prices;
    const latest = prices[0];
    const oldest = prices[prices.length - 1];
    const high = Math.max(...prices.map((p) => p.price));
    const low = Math.min(...prices.map((p) => p.price));
    const avg = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
    const change = latest.price - oldest.price;
    const changePct = (change / oldest.price) * 100;

    const sections = [
      `# ${info.name} - Past ${period.charAt(0).toUpperCase() + period.slice(1)} Historical Data\n`,
      `- **Latest**: ${historicalCurrencySymbol}${latest.price.toFixed(2)}/${info.unit}`,
      `- **High**: ${historicalCurrencySymbol}${high.toFixed(2)}`,
      `- **Low**: ${historicalCurrencySymbol}${low.toFixed(2)}`,
      `- **Average**: ${historicalCurrencySymbol}${avg.toFixed(2)}`,
      `- **Change**: ${change >= 0 ? "+" : ""}${historicalCurrencySymbol}${change.toFixed(2)} (${change >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`,
      `- **Data Points**: ${prices.length}`,
      `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`,
    ];

    return { content: [{ type: "text", text: sections.join("\n") }] };
  },
);

/**
 * Get the latest futures contract price
 */
server.tool(
  "get_futures_price",
  "Get the latest futures contract price for a commodity (Brent BZ or WTI CL).",
  {
    contract: z
      .enum(["BZ", "CL"])
      .default("BZ")
      .describe("Futures contract (BZ=Brent, CL=WTI)"),
  },
  async ({ contract }) => {
    const response = await makeApiRequest<ApiResponse<FuturesData>>(
      `/v1/futures/latest?contract=${contract}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.contracts?.length
    ) {
      return {
        content: [
          {
            type: "text",
            text: `No futures data available for contract ${contract}.`,
          },
        ],
      };
    }

    const contractName = contract === "BZ" ? "Brent Crude" : "WTI Crude";
    const front = response.data.contracts[0];

    let text = `# ${contractName} Futures (${contract})\n\n`;
    text += `**Front Month (${front.month})**: $${front.price.toFixed(2)}`;
    if (front.change !== undefined) {
      text += ` (${front.change >= 0 ? "+" : ""}$${front.change.toFixed(2)})`;
    }
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return { content: [{ type: "text", text }] };
  },
);

/**
 * Get the full futures forward curve
 */
server.tool(
  "get_futures_curve",
  "Get the full futures forward curve showing prices across contract months.",
  {
    contract: z
      .enum(["BZ", "CL"])
      .default("BZ")
      .describe("Futures contract (BZ=Brent, CL=WTI)"),
  },
  async ({ contract }) => {
    const response = await makeApiRequest<ApiResponse<FuturesData>>(
      `/v1/futures/curve?contract=${contract}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.contracts?.length
    ) {
      return {
        content: [
          {
            type: "text",
            text: `No futures curve data available for contract ${contract}.`,
          },
        ],
      };
    }

    const contractName = contract === "BZ" ? "Brent Crude" : "WTI Crude";
    const contracts = response.data.contracts;

    let text = `# ${contractName} Futures Curve (${contract})\n\n`;
    text += `| Month | Price | Change |\n|-------|-------|--------|\n`;

    for (const c of contracts) {
      const changeStr =
        c.change !== undefined
          ? `${c.change >= 0 ? "+" : ""}$${c.change.toFixed(2)}`
          : "N/A";
      text += `| ${c.month} | $${c.price.toFixed(2)} | ${changeStr} |\n`;
    }

    const front = contracts[0].price;
    const back = contracts[contracts.length - 1].price;
    const structure = front > back ? "backwardation" : "contango";
    text += `\n**Market Structure**: ${structure} (front $${front.toFixed(2)} vs back $${back.toFixed(2)})`;
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return { content: [{ type: "text", text }] };
  },
);

/**
 * Get marine fuel (bunker) prices
 */
server.tool(
  "get_marine_fuel_prices",
  "Get latest marine fuel (bunker) prices across major ports. Includes VLSFO, MGO, and IFO380.",
  {
    port: z
      .string()
      .optional()
      .describe("Filter by port name (e.g., 'SINGAPORE', 'ROTTERDAM')"),
    fuel_type: z
      .string()
      .optional()
      .describe("Filter by fuel type (VLSFO, MGO, IFO380)"),
  },
  async ({ port, fuel_type }) => {
    let endpoint = "/v1/marine-fuels/latest";
    const params: string[] = [];
    if (port) params.push(`port=${encodeURIComponent(port)}`);
    if (fuel_type) params.push(`fuel_type=${encodeURIComponent(fuel_type)}`);
    if (params.length) endpoint += `?${params.join("&")}`;

    const response =
      await makeApiRequest<ApiResponse<MarineFuelsData>>(endpoint);

    if (
      !response ||
      response.status !== "success" ||
      !response.data.prices?.length
    ) {
      return {
        content: [
          { type: "text", text: "No marine fuel price data available." },
        ],
      };
    }

    const prices = response.data.prices;
    let text = "# Marine Fuel Prices\n\n";
    text += `| Port | Fuel Type | Price | Currency | Unit |\n`;
    text += `|------|-----------|-------|----------|------|\n`;

    for (const p of prices) {
      text += `| ${p.port} | ${p.fuel_type} | ${p.price.toFixed(2)} | ${p.currency} | ${p.unit} |\n`;
    }

    text += `\n_${prices.length} prices | Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return { content: [{ type: "text", text }] };
  },
);

/**
 * Get the latest oil and gas rig count data
 */
server.tool(
  "get_rig_counts",
  "Get the latest oil and gas rig count data (Baker Hughes).",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<RigCountData>>(
      "/v1/rig-counts/latest",
    );

    if (!response || response.status !== "success") {
      return {
        content: [{ type: "text", text: "Rig count data not available." }],
      };
    }

    const data = response.data;
    let text = `# Rig Count Data\n\n`;
    text += `- **Oil Rigs**: ${data.oil}\n`;
    text += `- **Gas Rigs**: ${data.gas}\n`;
    text += `- **Total**: ${data.total}\n`;
    if (data.change_from_prior_week !== undefined) {
      const sign = data.change_from_prior_week >= 0 ? "+" : "";
      text += `- **Change from Prior Week**: ${sign}${data.change_from_prior_week}\n`;
    }
    text += `- **Date**: ${data.date}\n`;
    text += `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return { content: [{ type: "text", text }] };
  },
);

/**
 * Get drilling intelligence data
 */
server.tool(
  "get_drilling_intelligence",
  "Get drilling intelligence data including active wells, permits, and completions.",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<DrillingData>>(
      "/v1/drilling/latest",
    );

    if (!response || response.status !== "success") {
      return {
        content: [
          {
            type: "text",
            text: "Drilling intelligence data not available.",
          },
        ],
      };
    }

    const data = response.data;
    let text = `# Drilling Intelligence\n\n`;
    text += `- **Total Wells**: ${data.total_wells.toLocaleString()}\n`;
    text += `- **Active Rigs**: ${data.active_rigs.toLocaleString()}\n`;
    if (data.permits_issued !== undefined)
      text += `- **Permits Issued**: ${data.permits_issued.toLocaleString()}\n`;
    if (data.completions !== undefined)
      text += `- **Completions**: ${data.completions.toLocaleString()}\n`;
    text += `- **Date**: ${data.date}\n`;

    if (data.region_breakdown?.length) {
      text += `\n## By Region\n`;
      for (const r of data.region_breakdown) {
        text += `- **${r.region}**: ${r.count}\n`;
      }
    }

    text += `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return { content: [{ type: "text", text }] };
  },
);

// Register Resources — subscribable price snapshots

server.resource(
  "price-brent",
  "price://brent",
  {
    description: "Current Brent Crude oil price (global benchmark)",
    mimeType: "application/json",
  },
  async () => {
    const response = await makeApiRequest<ApiResponse<PriceData>>(
      "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
    );
    return {
      contents: [
        {
          uri: "price://brent",
          mimeType: "application/json",
          text: JSON.stringify(
            response?.data ?? { error: "unavailable" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.resource(
  "price-wti",
  "price://wti",
  {
    description: "Current WTI Crude oil price (US benchmark)",
    mimeType: "application/json",
  },
  async () => {
    const response = await makeApiRequest<ApiResponse<PriceData>>(
      "/v1/prices/latest?by_code=WTI_USD",
    );
    return {
      contents: [
        {
          uri: "price://wti",
          mimeType: "application/json",
          text: JSON.stringify(
            response?.data ?? { error: "unavailable" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.resource(
  "price-natural-gas",
  "price://natural-gas",
  {
    description: "Current US Natural Gas (Henry Hub) price",
    mimeType: "application/json",
  },
  async () => {
    const response = await makeApiRequest<ApiResponse<PriceData>>(
      "/v1/prices/latest?by_code=NATURAL_GAS_USD",
    );
    return {
      contents: [
        {
          uri: "price://natural-gas",
          mimeType: "application/json",
          text: JSON.stringify(
            response?.data ?? { error: "unavailable" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.resource(
  "market-overview",
  "price://all",
  {
    description: "Current prices for all tracked energy commodities",
    mimeType: "application/json",
  },
  async () => {
    const response =
      await makeApiRequest<ApiResponse<{ data: AllPricesData }>>(
        "/v1/prices/all",
      );
    return {
      contents: [
        {
          uri: "price://all",
          mimeType: "application/json",
          text: JSON.stringify(
            response?.data?.data ?? { error: "unavailable" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Register Prompts — pre-built analyst templates

server.prompt(
  "daily-briefing",
  "Energy market daily briefing with key prices, changes, and notable movements",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Give me today's energy market briefing. Get all commodity prices and provide:\n1. Key price levels for Brent, WTI, and Natural Gas\n2. Biggest movers (largest 24h % changes)\n3. Notable spreads (Brent-WTI, US gas vs EU gas)\n4. Brief market context\nFormat as a concise analyst briefing.",
        },
      },
    ],
  }),
);

server.prompt(
  "brent-wti-spread",
  "Analyze the Brent-WTI crude oil spread",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Compare Brent and WTI crude oil prices. Calculate the spread and explain what it means for the market. Is the spread widening or narrowing based on the 24h changes?",
        },
      },
    ],
  }),
);

server.prompt(
  "gas-market-analysis",
  "Compare US vs European natural gas markets",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Get prices for US Natural Gas (Henry Hub), UK Natural Gas (NBP), and European Gas (TTF). Compare the three markets:\n1. Current price levels in their native currencies\n2. 24h changes\n3. Which market is moving most?\n4. What does the transatlantic gas price gap suggest about supply/demand dynamics?",
        },
      },
    ],
  }),
);

server.prompt(
  "commodity-report",
  "Detailed report on a specific commodity",
  {
    commodity: z
      .string()
      .describe(
        "Commodity to analyze (e.g., 'brent', 'diesel', 'natural gas')",
      ),
  },
  ({ commodity }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Get the current price for ${commodity} and provide a detailed report:\n1. Current price and currency\n2. 24h price change (absolute and percentage)\n3. Compare with related commodities in the same category\n4. Key factors that typically affect this commodity's price\n5. Who are the main consumers and producers?`,
        },
      },
    ],
  }),
);

// Smithery sandbox export for server scanning
export function createSandboxServer() {
  return server;
}

// Main entry point
async function main() {
  // Check for API key
  if (!API_KEY) {
    console.error(
      "Warning: OILPRICEAPI_KEY not set. Some features may be limited.",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OilPriceAPI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
