#!/usr/bin/env node

/**
 * OilPriceAPI MCP Server v2.2.0
 *
 * The energy commodity MCP server. Real-time oil, gas, and commodity prices
 * for Claude, Cursor, VS Code, and any MCP-compatible client.
 *
 * 17 read-only tools (opa_ prefixed): prices, history, futures, marine fuels,
 * rig counts, drilling, diesel-by-state, storage, OPEC production, forecasts,
 * EIA oil inventories, well permits, refining spreads.
 *
 * 4 authenticated price-alert tools (opa_*_price_alert / opa_get_alert_triggers):
 * create/list/delete persistent price alerts tied to the user's account and read
 * recent trigger activity. These wrap the existing /v1/alerts engine and REQUIRE
 * an API key (OILPRICEAPI_KEY).
 *
 * @see https://oilpriceapi.com
 * @see https://modelcontextprotocol.io
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// API Configuration
const API_BASE =
  process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
export const USER_AGENT = "oilpriceapi-mcp/2.2.0";

// Get API key from environment
const API_KEY = process.env.OILPRICEAPI_KEY || process.env.OIL_PRICE_API_KEY;

// ---------------------------------------------------------------------------
// Natural language to commodity code mapping
// ---------------------------------------------------------------------------

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

  // Precious Metals
  gold: "GOLD_USD",
  "gold am fix": "GOLD_AM_USD",
  "lbma gold am": "GOLD_AM_USD",
  "gold am fix gbp": "GOLD_AM_GBP",
  "gold am fix eur": "GOLD_AM_EUR",
  "gold pm fix": "GOLD_PM_USD",
  "lbma gold pm": "GOLD_PM_USD",
  "gold pm fix gbp": "GOLD_PM_GBP",
  "gold pm fix eur": "GOLD_PM_EUR",
  "silver fix": "SILVER_FIX_USD",
  "lbma silver": "SILVER_FIX_USD",
  "silver fix gbp": "SILVER_FIX_GBP",
  "silver fix eur": "SILVER_FIX_EUR",
  carbon: "EU_CARBON_EUR",
  "eu carbon": "EU_CARBON_EUR",
  "carbon credits": "EU_CARBON_EUR",
  euro: "EUR_USD",
  "eur usd": "EUR_USD",
  pound: "GBP_USD",
  "gbp usd": "GBP_USD",
  sterling: "GBP_USD",
};

// ---------------------------------------------------------------------------
// Commodity metadata for formatting
// ---------------------------------------------------------------------------

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
  GOLD_AM_USD: { name: "LBMA Gold AM Fix", unit: "troy oz" },
  GOLD_AM_GBP: { name: "LBMA Gold AM Fix (GBP)", unit: "troy oz" },
  GOLD_AM_EUR: { name: "LBMA Gold AM Fix (EUR)", unit: "troy oz" },
  GOLD_PM_USD: { name: "LBMA Gold PM Fix", unit: "troy oz" },
  GOLD_PM_GBP: { name: "LBMA Gold PM Fix (GBP)", unit: "troy oz" },
  GOLD_PM_EUR: { name: "LBMA Gold PM Fix (EUR)", unit: "troy oz" },
  SILVER_FIX_USD: { name: "LBMA Silver Fix", unit: "troy oz" },
  SILVER_FIX_GBP: { name: "LBMA Silver Fix (GBP)", unit: "troy oz" },
  SILVER_FIX_EUR: { name: "LBMA Silver Fix (EUR)", unit: "troy oz" },
  EU_CARBON_EUR: { name: "EU Carbon Allowances", unit: "metric ton CO2" },
  EUR_USD: { name: "Euro to USD", unit: "rate" },
  GBP_USD: { name: "British Pound to USD", unit: "rate" },
};

// Available commodity codes (used for input validation)
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
  "GOLD_AM_USD",
  "GOLD_AM_GBP",
  "GOLD_AM_EUR",
  "GOLD_PM_USD",
  "GOLD_PM_GBP",
  "GOLD_PM_EUR",
  "SILVER_FIX_USD",
  "SILVER_FIX_GBP",
  "SILVER_FIX_EUR",
  "EU_CARBON_EUR",
  "EUR_USD",
  "GBP_USD",
] as const;

// US state abbreviation lookup for diesel tool
const US_STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// Supported futures contracts (used by opa_get_futures + opa_get_futures_curve)
export const FUTURES_CONTRACTS = [
  "BZ",
  "CL",
  "ice-gasoil",
  "ttf-gas",
  "lng-jkm",
  "eua-carbon",
] as const;

export const FUTURES_CONTRACT_NAMES: Record<
  (typeof FUTURES_CONTRACTS)[number],
  string
> = {
  BZ: "Brent Crude",
  CL: "WTI Crude",
  "ice-gasoil": "ICE Gasoil",
  "ttf-gas": "European TTF Natural Gas",
  "lng-jkm": "LNG JKM (Asia)",
  "eua-carbon": "EU Carbon Allowance (EUA)",
};

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

// ---------------------------------------------------------------------------
// Create server instance
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "oilpriceapi",
  version: "2.2.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a natural language commodity name to its API code.
 * Returns null if no match found — callers should return an actionable error.
 */
export function resolveCommodityCode(input: string): string | null {
  const normalized = input.toLowerCase().trim();

  // Check if it's already a valid code
  if (
    COMMODITY_CODES.includes(
      normalized.toUpperCase() as (typeof COMMODITY_CODES)[number],
    )
  ) {
    return normalized.toUpperCase();
  }

  // Try exact alias mapping
  const mapped = COMMODITY_ALIASES[normalized];
  if (mapped) {
    return mapped;
  }

  // Fuzzy match — check if input contains key words
  for (const [alias, code] of Object.entries(COMMODITY_ALIASES)) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return code;
    }
  }

  // No match found
  return null;
}

/**
 * Find the closest matching alias for an unrecognized input.
 */
function suggestCommodities(input: string): string[] {
  const normalized = input.toLowerCase().trim();
  const suggestions: Array<{ alias: string; code: string; score: number }> = [];

  for (const [alias, code] of Object.entries(COMMODITY_ALIASES)) {
    let score = 0;
    const words = normalized.split(/\s+/);
    for (const word of words) {
      if (alias.includes(word) || word.includes(alias)) {
        score += word.length;
      }
    }
    if (score > 0) {
      suggestions.push({ alias, code, score });
    }
  }

  // Deduplicate by code and return top 3
  const seen = new Set<string>();
  return suggestions
    .sort((a, b) => b.score - a.score)
    .filter((s) => {
      if (seen.has(s.code)) return false;
      seen.add(s.code);
      return true;
    })
    .slice(0, 3)
    .map((s) => `'${s.alias}' (${s.code})`);
}

/**
 * Build an error tool result with isError flag so LLMs can distinguish
 * errors from data.
 */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Build a success tool result.
 */
function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Handle commodity resolution with helpful error on no match.
 */
function resolveOrError(
  input: string,
): { code: string } | { error: ReturnType<typeof errorResult> } {
  const code = resolveCommodityCode(input);
  if (code) return { code };

  const suggestions = suggestCommodities(input);
  let msg = `Commodity '${input}' not recognized.`;
  if (suggestions.length > 0) {
    msg += ` Did you mean: ${suggestions.join(", ")}?`;
  }
  msg += " Use opa_list_commodities to see all available codes.";
  return { error: errorResult(msg) };
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
          "Authentication failed. Set OILPRICEAPI_KEY environment variable. Get a free key at https://oilpriceapi.com/signup",
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
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Authenticated request helper (price alerts)
//
// The /v1/alerts endpoints are authenticated and STATEFUL — they create,
// read, and delete persistent records tied to the caller's account. Unlike
// the read tools (where auth is optional and responses are wrapped in
// { status, data }), these endpoints:
//   - REQUIRE an API key (no key => 401),
//   - support POST / PATCH / DELETE,
//   - return the serialized record(s) directly (bare object/array), not an
//     { status, data } envelope.
// So we use a dedicated helper rather than makeApiRequest.
// ---------------------------------------------------------------------------

export interface AuthRequestResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Make an authenticated request to a stateful endpoint. Requires API_KEY.
 * Returns { ok, status, body }; callers decide how to render success/error.
 * Returns status 0 on a network/transport failure.
 */
export async function makeAuthRequest(
  endpoint: string,
  options: { method?: string; body?: unknown } = {},
  fetchFn: typeof fetch = fetch,
): Promise<AuthRequestResult> {
  const { method = "GET", body } = options;

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    // The API accepts the customer API key as a bearer token.
    Authorization: `Bearer ${API_KEY}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetchFn(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let parsed: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    console.error(`Authenticated request failed: ${method} ${endpoint}`, error);
    return { ok: false, status: 0, body: null };
  }
}

/**
 * Standard guard for alert tools: returns an actionable error result when no
 * API key is configured, otherwise null.
 */
function requireApiKey(): ReturnType<typeof errorResult> | null {
  if (!API_KEY) {
    return errorResult(
      "Price alerts require an OilPriceAPI key. These tools create and manage " +
        "persistent alerts tied to your account, so the server must be configured " +
        "with one. Set the OILPRICEAPI_KEY environment variable for this MCP " +
        "server (get a free key at https://oilpriceapi.com/signup), then retry.",
    );
  }
  return null;
}

/**
 * Map an authenticated-request failure to a clear, agent-readable error.
 */
function alertHttpError(result: AuthRequestResult, action: string): string {
  if (result.status === 0) {
    return `Could not ${action} — the OilPriceAPI service was unreachable. Try again in a moment.`;
  }
  if (result.status === 401) {
    return `Could not ${action}: authentication failed (401). The configured OILPRICEAPI_KEY is missing or invalid. Set a valid key (https://oilpriceapi.com/signup) and retry.`;
  }
  // Surface the API's own error/validation message when present.
  const body = result.body;
  let detail = "";
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string") detail = obj.message;
    else if (typeof obj.error === "string") detail = obj.error;
    else if (obj.errors) detail = JSON.stringify(obj.errors);
  }
  return `Could not ${action} (HTTP ${result.status})${detail ? `: ${detail}` : "."}`;
}

// Operators accepted by the /v1/alerts engine (PriceAlert::VALID_OPERATORS).
export const ALERT_OPERATORS = [
  "greater_than",
  "less_than",
  "equals",
  "greater_than_or_equal",
  "less_than_or_equal",
] as const;

/**
 * Resolve a US state name or abbreviation to a 2-letter code.
 */
export function resolveStateCode(input: string): string | null {
  const normalized = input.toLowerCase().trim();

  // Already a 2-letter code
  if (/^[a-z]{2}$/i.test(normalized)) {
    const upper = normalized.toUpperCase();
    // Verify it's a real state abbreviation
    if (Object.values(US_STATES).includes(upper) || upper === "DC") {
      return upper;
    }
    return null;
  }

  // Try full name lookup
  return US_STATES[normalized] ?? null;
}

// =========================================================================
// READ TOOLS (17 — opa_ prefixed to avoid collisions). Plus 4 authenticated
// price-alert tools further below, for 21 tools total.
// =========================================================================

server.tool(
  "opa_get_price",
  "Get the current real-time spot price of an energy commodity. Use when the user asks about a single commodity's current price. Accepts natural language ('brent oil', 'diesel') or API codes ('WTI_USD'). Returns price, currency, 24h change, and timestamp. For multiple commodities at once, use opa_market_overview. For price trends, use opa_get_history.",
  {
    commodity: z
      .string()
      .describe(
        "Commodity name or code (e.g., 'brent oil', 'natural gas', 'WTI_USD', 'diesel')",
      ),
  },
  async ({ commodity }) => {
    const resolved = resolveOrError(commodity);
    if ("error" in resolved) return resolved.error;

    const response = await makeApiRequest<ApiResponse<PriceData>>(
      `/v1/prices/latest?by_code=${resolved.code}`,
    );

    if (!response || response.status !== "success") {
      return errorResult(
        `Could not retrieve price for '${commodity}' (code: ${resolved.code}). The API may be temporarily unavailable — try again in a moment.`,
      );
    }

    return textResult(
      `${formatPrice(response.data)}\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`,
    );
  },
);

server.tool(
  "opa_market_overview",
  "Get current prices for all tracked energy commodities in one call. Use when the user wants a broad market snapshot or asks about overall energy prices. Returns prices grouped by category (oil, gas, coal, refined products, metals, forex) with 24h changes. Supports filtering by category. For a single commodity, use opa_get_price instead.",
  {
    category: z
      .enum(["all", "oil", "gas", "coal", "refined", "metals", "forex"])
      .optional()
      .describe(
        "Filter by commodity category (default: all). Options: oil, gas, coal, refined, metals, forex.",
      ),
  },
  async ({ category = "all" }) => {
    const response =
      await makeApiRequest<ApiResponse<{ data: AllPricesData }>>(
        "/v1/prices/all",
      );

    if (!response || response.status !== "success") {
      return errorResult(
        "Could not retrieve market data. The API may be temporarily unavailable — try again in a moment.",
      );
    }

    const prices = response.data.data.prices;

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
      metals: ["GOLD_USD", "GOLD_AM_USD", "GOLD_PM_USD", "SILVER_FIX_USD"],
      forex: ["EUR_USD", "GBP_USD"],
    };

    let filteredCodes: string[];
    if (category === "all") {
      filteredCodes = Object.keys(prices);
    } else {
      filteredCodes = categoryFilters[category] || [];
    }

    const sections: string[] = ["# Energy Market Overview\n"];

    const groupedPrices: Record<string, PriceData[]> = {
      "Crude Oil": [],
      "Natural Gas": [],
      Coal: [],
      "Refined Products": [],
      "Precious Metals": [],
      Forex: [],
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
      } else if (code.includes("GOLD") || code.includes("SILVER")) {
        groupedPrices["Precious Metals"].push(data);
      } else if (code === "EUR_USD" || code === "GBP_USD") {
        groupedPrices["Forex"].push(data);
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
        { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" },
      )} UTC | Data from [OilPriceAPI](https://oilpriceapi.com)_`,
    );

    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_compare_prices",
  "Compare current prices between 2-5 commodities side by side. Use when the user asks to compare commodities (e.g., 'Brent vs WTI', 'US gas vs EU gas'). Returns each commodity's price with 24h changes, plus the spread if comparing two same-currency commodities. Accepts natural language or codes.",
  {
    commodities: z
      .array(z.string())
      .min(2)
      .max(5)
      .describe(
        "List of 2-5 commodity names or codes to compare (e.g., ['brent', 'wti'] or ['NATURAL_GAS_USD', 'DUTCH_TTF_EUR'])",
      ),
  },
  async ({ commodities }) => {
    const results: PriceData[] = [];
    const errors: string[] = [];

    for (const commodity of commodities) {
      const resolved = resolveOrError(commodity);
      if ("error" in resolved) {
        errors.push(commodity);
        continue;
      }

      const response = await makeApiRequest<ApiResponse<PriceData>>(
        `/v1/prices/latest?by_code=${resolved.code}`,
      );

      if (response?.status === "success") {
        results.push(response.data);
      }
    }

    if (results.length < 2) {
      let msg =
        "Could not retrieve enough price data for comparison (need at least 2).";
      if (errors.length > 0) {
        msg += ` Unrecognized commodities: ${errors.join(", ")}. Use opa_list_commodities to see valid codes.`;
      }
      return errorResult(msg);
    }

    const sections = ["# Price Comparison\n"];

    for (const data of results) {
      sections.push(formatPrice(data));
      sections.push("");
    }

    if (results.length === 2 && results[0].currency === results[1].currency) {
      const spread = Math.abs(results[0].price - results[1].price);
      const info0 = COMMODITY_INFO[results[0].code]?.name || results[0].code;
      const info1 = COMMODITY_INFO[results[1].code]?.name || results[1].code;
      const currencySymbol =
        results[0].currency === "EUR"
          ? "€"
          : results[0].currency === "GBP"
            ? "£"
            : "$";
      sections.push(
        `**Spread**: ${currencySymbol}${spread.toFixed(2)} (${info0} vs ${info1})`,
      );
    }

    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);

    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_list_commodities",
  "List all available commodities that can be queried for prices. Use when the user asks what commodities are available, what codes to use, or when another tool returns a 'commodity not recognized' error. Returns the full catalog fetched live from the API, grouped by category. No parameters needed.",
  {},
  async () => {
    // Try to fetch the live commodity catalog from the API
    const response = await makeApiRequest<
      ApiResponse<{
        commodities: Array<{
          code: string;
          name: string;
          category: string;
          currency: string;
          unit?: string;
        }>;
      }>
    >("/v1/commodities");

    if (response?.status === "success" && response.data.commodities?.length) {
      const grouped: Record<string, Array<{ code: string; name: string }>> = {};

      for (const c of response.data.commodities) {
        const cat = c.category || "Other";
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ code: c.code, name: c.name });
      }

      const sections = [
        `# Available Commodities (${response.data.commodities.length} total)\n`,
      ];

      for (const [category, items] of Object.entries(grouped)) {
        sections.push(`## ${category}`);
        for (const item of items) {
          sections.push(`- \`${item.code}\` — ${item.name}`);
        }
        sections.push("");
      }

      sections.push(
        "_You can use natural language like 'brent oil' or 'natural gas' — the server translates it to the right code._",
      );

      return textResult(sections.join("\n"));
    }

    // Fallback to static list if API call fails
    const sections = ["# Available Commodities\n"];

    sections.push("## Crude Oil");
    sections.push("- `BRENT_CRUDE_USD` — Brent Crude (global benchmark)");
    sections.push("- `WTI_USD` — West Texas Intermediate (US benchmark)");
    sections.push("- `URALS_CRUDE_USD` — Urals Crude (Russian)");
    sections.push("- `DUBAI_CRUDE_USD` — Dubai Crude (Middle East)");
    sections.push("");

    sections.push("## Natural Gas");
    sections.push("- `NATURAL_GAS_USD` — US Henry Hub ($/MMBtu)");
    sections.push("- `NATURAL_GAS_GBP` — UK NBP (pence/therm)");
    sections.push("- `DUTCH_TTF_EUR` — European TTF (€/MWh)");
    sections.push("");

    sections.push("## Coal");
    sections.push("- `COAL_USD` — Thermal Coal");
    sections.push("- `NEWCASTLE_COAL_USD` — Newcastle (Asia-Pacific)");
    sections.push("");

    sections.push("## Refined Products");
    sections.push("- `DIESEL_USD` — Diesel");
    sections.push("- `GASOLINE_USD` — Gasoline");
    sections.push("- `GASOLINE_RBOB_USD` — RBOB Gasoline");
    sections.push("- `JET_FUEL_USD` — Jet Fuel");
    sections.push("- `HEATING_OIL_USD` — Heating Oil");
    sections.push("");

    sections.push("## Precious Metals");
    sections.push("- `GOLD_USD` — Gold");
    sections.push("- `SILVER_FIX_USD` — LBMA Silver Fix");
    sections.push("");

    sections.push("## Other");
    sections.push("- `EU_CARBON_EUR` — EU Carbon Allowances");
    sections.push("- `EUR_USD` — Euro to USD");
    sections.push("- `GBP_USD` — British Pound to USD");
    sections.push("");

    sections.push(
      "_Note: This is a partial list (API was unreachable). The full catalog has 70+ commodities. Try again later for the complete list._",
    );

    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_get_history",
  "Get historical price data for a commodity over a time period. Use when the user asks about price trends, historical prices, or how a commodity has performed over time. Returns high, low, average, change, and data point count. Periods: day (24h), week (7d), month (30d), year (365d).",
  {
    commodity: z
      .string()
      .describe("Commodity name or code (e.g., 'brent', 'WTI_USD')"),
    period: z
      .enum(["day", "week", "month", "year"])
      .default("month")
      .describe("Time period: day, week, month, or year (default: month)"),
  },
  async ({ commodity, period }) => {
    const resolved = resolveOrError(commodity);
    if ("error" in resolved) return resolved.error;

    const response = await makeApiRequest<ApiResponse<HistoricalPriceData>>(
      `/v1/prices/past_${period}?by_code=${resolved.code}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.prices?.length
    ) {
      return errorResult(
        `No historical data found for '${commodity}' (code: ${resolved.code}) over the past ${period}. This commodity may not have enough data for this period, or may require a paid plan.`,
      );
    }

    const info = COMMODITY_INFO[resolved.code] || {
      name: resolved.code,
      unit: "unit",
    };
    const currencyFromCode = resolved.code.endsWith("_EUR")
      ? "EUR"
      : resolved.code.endsWith("_GBP") || resolved.code.endsWith("_GBp")
        ? "GBP"
        : "USD";
    const sym =
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
      `# ${info.name} — Past ${period.charAt(0).toUpperCase() + period.slice(1)}\n`,
      `- **Latest**: ${sym}${latest.price.toFixed(2)}/${info.unit}`,
      `- **High**: ${sym}${high.toFixed(2)}`,
      `- **Low**: ${sym}${low.toFixed(2)}`,
      `- **Average**: ${sym}${avg.toFixed(2)}`,
      `- **Change**: ${change >= 0 ? "+" : ""}${sym}${change.toFixed(2)} (${change >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`,
      `- **Data Points**: ${prices.length}`,
      `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`,
    ];

    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_get_futures",
  "Get the latest front-month futures contract price for energy commodities. Use when the user asks about futures, forward prices, or contract prices. Supports crude oil (BZ = Brent, CL = WTI), ICE Gasoil (ice-gasoil), European TTF gas (ttf-gas), LNG JKM (lng-jkm), and EUA carbon (eua-carbon). For the full forward curve across all contract months, use opa_get_futures_curve instead.",
  {
    contract: z
      .enum(FUTURES_CONTRACTS)
      .default("BZ")
      .describe(
        "Futures contract: BZ = Brent crude, CL = WTI crude, ice-gasoil = ICE Gasoil, ttf-gas = European TTF natural gas, lng-jkm = LNG JKM (Asia), eua-carbon = EU carbon allowance (default: BZ)",
      ),
  },
  async ({ contract }) => {
    const response = await makeApiRequest<ApiResponse<FuturesData>>(
      `/v1/futures/latest?contract=${encodeURIComponent(contract)}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.contracts?.length
    ) {
      return errorResult(
        `No futures data available for ${FUTURES_CONTRACT_NAMES[contract]} (${contract}). Futures data requires a paid plan.`,
      );
    }

    const contractName = FUTURES_CONTRACT_NAMES[contract];
    const front = response.data.contracts[0];

    let text = `# ${contractName} Futures (${contract})\n\n`;
    text += `**Front Month (${front.month})**: $${front.price.toFixed(2)}`;
    if (front.change !== undefined) {
      text += ` (${front.change >= 0 ? "+" : ""}$${front.change.toFixed(2)})`;
    }
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);

server.tool(
  "opa_get_futures_curve",
  "Get the full futures forward curve showing prices across all contract months. Use when the user asks about the forward curve, contango/backwardation, or term structure. Supports crude oil (BZ = Brent, CL = WTI), ICE Gasoil (ice-gasoil), European TTF gas (ttf-gas), LNG JKM (lng-jkm), and EUA carbon (eua-carbon). Returns a table of contract months with prices and changes, plus market structure analysis.",
  {
    contract: z
      .enum(FUTURES_CONTRACTS)
      .default("BZ")
      .describe(
        "Futures contract: BZ = Brent crude, CL = WTI crude, ice-gasoil = ICE Gasoil, ttf-gas = European TTF natural gas, lng-jkm = LNG JKM (Asia), eua-carbon = EU carbon allowance (default: BZ)",
      ),
  },
  async ({ contract }) => {
    const response = await makeApiRequest<ApiResponse<FuturesData>>(
      `/v1/futures/curve?contract=${encodeURIComponent(contract)}`,
    );

    if (
      !response ||
      response.status !== "success" ||
      !response.data.contracts?.length
    ) {
      return errorResult(
        `No futures curve data available for ${FUTURES_CONTRACT_NAMES[contract]} (${contract}). Futures data requires a paid plan.`,
      );
    }

    const contractName = FUTURES_CONTRACT_NAMES[contract];
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

    return textResult(text);
  },
);

server.tool(
  "opa_get_marine_fuels",
  "Get latest marine fuel (bunker) prices across major shipping ports. Use when the user asks about bunker fuel, marine fuel, VLSFO, MGO, IFO380, or shipping fuel costs. Can filter by port (e.g., SINGAPORE, ROTTERDAM, HOUSTON) and/or fuel type (VLSFO, MGO, IFO380). Returns a table of port prices.",
  {
    port: z
      .string()
      .optional()
      .describe(
        "Filter by port name (e.g., 'SINGAPORE', 'ROTTERDAM', 'HOUSTON')",
      ),
    fuel_type: z
      .string()
      .optional()
      .describe("Filter by fuel type: VLSFO, MGO, or IFO380"),
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
      return errorResult(
        "No marine fuel price data available. Marine fuel data requires a paid plan with bunker fuel coverage.",
      );
    }

    const prices = response.data.prices;
    let text = "# Marine Fuel Prices\n\n";
    text += `| Port | Fuel Type | Price | Currency | Unit |\n`;
    text += `|------|-----------|-------|----------|------|\n`;

    for (const p of prices) {
      text += `| ${p.port} | ${p.fuel_type} | ${p.price.toFixed(2)} | ${p.currency} | ${p.unit} |\n`;
    }

    text += `\n_${prices.length} prices | Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);

server.tool(
  "opa_get_rig_counts",
  "Get the latest US oil and gas rig count data (Baker Hughes). Use when the user asks about drilling activity, rig counts, or oil field operations. Returns oil rigs, gas rigs, total count, and week-over-week change. No parameters needed.",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<RigCountData>>(
      "/v1/rig-counts/latest",
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "Rig count data not available. This may require a paid plan with energy intelligence access.",
      );
    }

    const data = response.data;
    let text = `# US Rig Count (Baker Hughes)\n\n`;
    text += `- **Oil Rigs**: ${data.oil}\n`;
    text += `- **Gas Rigs**: ${data.gas}\n`;
    text += `- **Total**: ${data.total}\n`;
    if (data.change_from_prior_week !== undefined) {
      const sign = data.change_from_prior_week >= 0 ? "+" : "";
      text += `- **Change from Prior Week**: ${sign}${data.change_from_prior_week}\n`;
    }
    text += `- **Date**: ${data.date}\n`;
    text += `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);

server.tool(
  "opa_get_drilling",
  "Get drilling intelligence data including active wells, permits issued, and completions by region. Use when the user asks about drilling activity, well permits, or upstream operations. Returns totals and regional breakdown.",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<DrillingData>>(
      "/v1/drilling/latest",
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "Drilling intelligence data not available. This requires a paid plan with energy intelligence access.",
      );
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

    return textResult(text);
  },
);

// ---------------------------------------------------------------------------
// NEW TOOLS — Sprint 3
// ---------------------------------------------------------------------------

server.tool(
  "opa_get_diesel_by_state",
  "Get the current average retail diesel price for a US state. Use when the user asks about diesel prices in a specific state, diesel fuel costs by state, or state-level fuel prices. Accepts state names ('California') or 2-letter codes ('CA'). Returns the AAA-sourced state average diesel price. Covers all 50 states plus DC.",
  {
    state: z
      .string()
      .describe(
        "US state name or 2-letter code (e.g., 'California', 'CA', 'Texas', 'TX')",
      ),
  },
  async ({ state }) => {
    const stateCode = resolveStateCode(state);
    if (!stateCode) {
      return errorResult(
        `'${state}' is not a recognized US state. Use a full state name (e.g., 'California') or 2-letter code (e.g., 'CA').`,
      );
    }

    const code = `DIESEL_RETAIL_STATE_${stateCode}_USD`;
    const response = await makeApiRequest<ApiResponse<PriceData>>(
      `/v1/prices/latest?by_code=${code}`,
    );

    if (!response || response.status !== "success") {
      return errorResult(
        `No diesel price data available for ${state} (${stateCode}). State diesel data requires a plan with AAA diesel coverage.`,
      );
    }

    const data = response.data;
    let text = `# Diesel Price — ${stateCode}\n\n`;
    text += `- **Price**: $${data.price.toFixed(3)}/gallon\n`;
    if (data.change_24h !== undefined) {
      const sign = data.change_24h >= 0 ? "+" : "";
      text += `- **24h Change**: ${sign}$${data.change_24h.toFixed(3)}\n`;
    }
    const timestamp = data.updated_at || data.created_at;
    if (timestamp) {
      text += `- **Updated**: ${new Date(timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC\n`;
    }
    text += `- **Source**: AAA\n`;
    text += `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);

server.tool(
  "opa_get_storage",
  "Get oil storage and inventory levels for Cushing, Oklahoma (WTI delivery hub) and/or the US Strategic Petroleum Reserve (SPR). Use when the user asks about oil inventories, storage levels, Cushing stocks, or the SPR. Returns current inventory levels with changes.",
  {
    facility: z
      .enum(["cushing", "spr", "all"])
      .default("all")
      .describe(
        "Storage facility: cushing (WTI delivery hub), spr (Strategic Petroleum Reserve), or all (default: all)",
      ),
  },
  async ({ facility }) => {
    const sections: string[] = ["# Oil Storage Levels\n"];
    let hasData = false;

    if (facility === "cushing" || facility === "all") {
      const response = await makeApiRequest<
        ApiResponse<Record<string, unknown>>
      >("/v1/storage/cushing");
      if (response?.status === "success") {
        hasData = true;
        sections.push("## Cushing, Oklahoma (WTI Hub)\n");
        sections.push(
          "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n",
        );
      }
    }

    if (facility === "spr" || facility === "all") {
      const response =
        await makeApiRequest<ApiResponse<Record<string, unknown>>>(
          "/v1/storage/spr",
        );
      if (response?.status === "success") {
        hasData = true;
        sections.push("## Strategic Petroleum Reserve (SPR)\n");
        sections.push(
          "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n",
        );
      }
    }

    if (!hasData) {
      return errorResult(
        "Storage data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    sections.push("_Data from [OilPriceAPI](https://oilpriceapi.com)_");
    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_get_opec_production",
  "Get the latest OPEC oil production data. Use when the user asks about OPEC output, production quotas, supply cuts, or OPEC+ compliance. Returns country-level production figures. Requires a paid plan with energy intelligence access.",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<Record<string, unknown>>>(
      "/v1/ei/opec_productions/latest",
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "OPEC production data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    let text = "# OPEC Production Data\n\n";
    text += "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n";
    text += "\n_Data from [OilPriceAPI](https://oilpriceapi.com)_";

    return textResult(text);
  },
);

server.tool(
  "opa_get_forecasts",
  "Get energy price forecasts from EIA Short-Term Energy Outlook (STEO) and other sources. Use when the user asks about price predictions, outlooks, or where oil/gas prices are heading. Returns forecast data for key commodities. Requires a paid plan with energy intelligence access.",
  {},
  async () => {
    const response = await makeApiRequest<ApiResponse<Record<string, unknown>>>(
      "/v1/ei/forecasts/latest",
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "Forecast data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    let text = "# Energy Price Forecasts\n\n";
    text += "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n";
    text +=
      "\n_Source: EIA STEO | Data from [OilPriceAPI](https://oilpriceapi.com)_";

    return textResult(text);
  },
);

// ---------------------------------------------------------------------------
// NEW TOOLS — Sprint 4 (EIA inventories, well permits, refining spreads)
// ---------------------------------------------------------------------------

server.tool(
  "opa_get_oil_inventories",
  "Get the latest EIA weekly petroleum inventory (stocks) data. Use when the user asks about oil inventories, crude stocks, weekly EIA stocks, inventory builds/draws, or product-level inventory levels. Returns the latest weekly figures; optionally a summary view or a breakdown by petroleum product. Requires a paid plan with energy intelligence access.",
  {
    view: z
      .enum(["latest", "summary", "by_product"])
      .default("latest")
      .describe(
        "Which view to return: latest (most recent weekly snapshot), summary (headline totals + week-over-week change), or by_product (breakdown per petroleum product). Default: latest.",
      ),
  },
  async ({ view }) => {
    const endpointByView: Record<string, string> = {
      latest: "/v1/ei/oil_inventories/latest",
      summary: "/v1/ei/oil_inventories/summary",
      by_product: "/v1/ei/oil_inventories/by_product",
    };

    const response = await makeApiRequest<ApiResponse<Record<string, unknown>>>(
      endpointByView[view],
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "EIA oil inventory data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    let text = `# EIA Weekly Oil Inventories (${view})\n\n`;
    text += "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n";
    text +=
      "\n_Source: EIA Weekly Petroleum Status Report | Data from [OilPriceAPI](https://oilpriceapi.com)_";

    return textResult(text);
  },
);

server.tool(
  "opa_get_well_permits",
  "Get the latest US oil & gas well drilling permit data. Use when the user asks about well permits, new drilling permits, permitting activity, or upstream permit trends. Returns the latest permits; optionally filtered/aggregated by state or by operator. Requires a paid plan with energy intelligence access.",
  {
    view: z
      .enum(["latest", "by_state", "by_operator"])
      .default("latest")
      .describe(
        "Which view to return: latest (most recent permits), by_state (counts aggregated per state), or by_operator (counts aggregated per operator). Default: latest.",
      ),
    state: z
      .string()
      .optional()
      .describe(
        "Optional US state name or 2-letter code to filter permits (e.g., 'Texas', 'TX'). Applies to the latest and by_state views.",
      ),
  },
  async ({ view, state }) => {
    const pathByView: Record<string, string> = {
      latest: "/v1/ei/well-permits/latest",
      by_state: "/v1/ei/well-permits/by-state",
      by_operator: "/v1/ei/well-permits/by-operator",
    };

    let endpoint = pathByView[view];

    if (state) {
      const stateCode = resolveStateCode(state);
      if (!stateCode) {
        return errorResult(
          `'${state}' is not a recognized US state. Use a full state name (e.g., 'Texas') or 2-letter code (e.g., 'TX').`,
        );
      }
      endpoint += `?state=${stateCode}`;
    }

    const response =
      await makeApiRequest<ApiResponse<Record<string, unknown>>>(endpoint);

    if (!response || response.status !== "success") {
      return errorResult(
        "Well permit data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    let text = `# US Well Permits (${view})\n\n`;
    text += "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n";
    text += "\n_Data from [OilPriceAPI](https://oilpriceapi.com)_";

    return textResult(text);
  },
);

server.tool(
  "opa_get_spread",
  "Get refining and trading spreads: crack spreads (refining margin proxy), basis spreads (regional price differentials), and blending/transport margins. Use when the user asks about crack spreads, 3-2-1 crack, refining margins, basis differentials, or blend/transport margins. Requires a paid plan with energy intelligence access.",
  {
    type: z
      .enum(["crack", "basis", "margin"])
      .describe(
        "Spread type: crack (refining crack spread, e.g. 3-2-1), basis (regional/grade price differential), or margin (blending/transport margin).",
      ),
  },
  async ({ type }) => {
    const response = await makeApiRequest<ApiResponse<Record<string, unknown>>>(
      `/v1/spreads/${type}`,
    );

    if (!response || response.status !== "success") {
      return errorResult(
        `${type.charAt(0).toUpperCase() + type.slice(1)} spread data not available. This requires a paid plan with energy intelligence access.`,
      );
    }

    let text = `# ${type.charAt(0).toUpperCase() + type.slice(1)} Spread\n\n`;
    text += "```json\n" + JSON.stringify(response.data, null, 2) + "\n```\n";
    text += "\n_Data from [OilPriceAPI](https://oilpriceapi.com)_";

    return textResult(text);
  },
);

// =========================================================================
// PRICE ALERT TOOLS (authenticated, stateful — require OILPRICEAPI_KEY)
//
// These wrap the existing /v1/alerts engine. They create and manage
// PERSISTENT alerts tied to the user's OilPriceAPI account, and require an
// API key. The alert engine continuously evaluates the user's alerts against
// live prices and notifies them (email and/or webhook) when conditions are met.
// =========================================================================

interface AlertRecord {
  id?: string;
  name?: string;
  commodity_code?: string;
  condition_operator?: string;
  condition_value?: number | string;
  condition?: string;
  summary?: string;
  enabled?: boolean;
  webhook_url?: string | null;
  has_webhook?: boolean;
  cooldown_minutes?: number;
  trigger_count?: number;
  last_triggered_at?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

function formatAlertLine(a: AlertRecord): string {
  const label =
    a.summary ||
    a.condition ||
    `${a.commodity_code} ${a.condition_operator} ${a.condition_value}`;
  const status = a.enabled === false ? "disabled" : "enabled";
  const triggers =
    typeof a.trigger_count === "number" ? `, ${a.trigger_count} triggers` : "";
  const last = a.last_triggered_at
    ? `, last triggered ${a.last_triggered_at}`
    : "";
  return `- **${a.name || label}** (id: \`${a.id}\`) — ${label} [${status}${triggers}${last}]`;
}

server.tool(
  "opa_create_price_alert",
  "Create a PERSISTENT price alert tied to the user's OilPriceAPI account. " +
    "The alert engine continuously watches live prices and notifies the user (by " +
    "email, plus webhook if a URL is given) when the commodity price crosses the " +
    "threshold. Use when the user asks to be alerted/notified when a price goes " +
    "above or below a level (e.g. 'tell me when Brent drops below $70'). " +
    "REQUIRES an API key (OILPRICEAPI_KEY) — this writes to the user's account. " +
    "Alerts persist until deleted; manage them with opa_list_price_alerts and " +
    "opa_delete_price_alert.",
  {
    commodity: z
      .string()
      .describe(
        "Commodity name or code to watch (e.g., 'brent', 'natural gas', 'WTI_USD').",
      ),
    operator: z
      .enum(ALERT_OPERATORS)
      .describe(
        "Threshold comparison: greater_than, less_than, equals, greater_than_or_equal, or less_than_or_equal. The alert fires when (current price) <operator> (threshold).",
      ),
    threshold: z
      .number()
      .positive()
      .describe(
        "The price threshold to compare against, in the commodity's native currency (e.g., 70 for $70/barrel).",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "Optional human-readable label for the alert. If omitted, a descriptive name is generated.",
      ),
    notify: z
      .string()
      .url()
      .optional()
      .describe(
        "Optional HTTPS webhook URL to POST to when the alert triggers (in addition to email). Must start with https://.",
      ),
  },
  async ({ commodity, operator, threshold, name, notify }) => {
    const keyErr = requireApiKey();
    if (keyErr) return keyErr;

    const resolved = resolveOrError(commodity);
    if ("error" in resolved) return resolved.error;

    const operatorText: Record<string, string> = {
      greater_than: ">",
      less_than: "<",
      equals: "=",
      greater_than_or_equal: ">=",
      less_than_or_equal: "<=",
    };
    const defaultName = `${resolved.code} ${operatorText[operator]} ${threshold}`;

    const alert: Record<string, unknown> = {
      name: name || defaultName,
      commodity_code: resolved.code,
      condition_operator: operator,
      condition_value: threshold,
      // Attribution: stamp the alert as MCP-created via the alert's metadata
      // (the API permits a free-form metadata object on price alerts).
      metadata: { source: "mcp" },
    };
    if (notify) alert.webhook_url = notify;

    const result = await makeAuthRequest("/v1/alerts", {
      method: "POST",
      body: { price_alert: alert },
    });

    if (!result.ok) {
      return errorResult(alertHttpError(result, "create the price alert"));
    }

    const created = result.body as AlertRecord;
    let text = "# Price Alert Created\n\n";
    text += formatAlertLine(created);
    text +=
      "\n\nThis alert is now active on the user's account and will notify them when the condition is met. " +
      "Use `opa_list_price_alerts` to see all alerts or `opa_delete_price_alert` to remove it.";
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;
    return textResult(text);
  },
);

server.tool(
  "opa_list_price_alerts",
  "List all PERSISTENT price alerts on the user's OilPriceAPI account. Use when " +
    "the user asks what alerts they have set up, or to find an alert's id before " +
    "deleting it. REQUIRES an API key (OILPRICEAPI_KEY) — alerts are account-scoped. " +
    "No parameters needed.",
  {},
  async () => {
    const keyErr = requireApiKey();
    if (keyErr) return keyErr;

    const result = await makeAuthRequest("/v1/alerts");
    if (!result.ok) {
      return errorResult(alertHttpError(result, "list price alerts"));
    }

    const alerts = Array.isArray(result.body)
      ? (result.body as AlertRecord[])
      : [];

    if (alerts.length === 0) {
      return textResult(
        "No price alerts are set up on this account yet. Use `opa_create_price_alert` to create one.",
      );
    }

    const sections = [`# Price Alerts (${alerts.length})\n`];
    for (const a of alerts) sections.push(formatAlertLine(a));
    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);
    return textResult(sections.join("\n"));
  },
);

server.tool(
  "opa_delete_price_alert",
  "Permanently delete a price alert from the user's OilPriceAPI account by id. " +
    "Use when the user wants to remove/cancel/stop an existing alert. Get the id " +
    "from opa_list_price_alerts first. This permanently removes the alert from the " +
    "user's account. REQUIRES an API key (OILPRICEAPI_KEY).",
  {
    id: z
      .string()
      .describe(
        "The id of the alert to delete (a UUID, as returned by opa_list_price_alerts or opa_create_price_alert).",
      ),
  },
  async ({ id }) => {
    const keyErr = requireApiKey();
    if (keyErr) return keyErr;

    const result = await makeAuthRequest(
      `/v1/alerts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );

    if (result.status === 404) {
      return errorResult(
        `No alert found with id \`${id}\` on this account. Use opa_list_price_alerts to see valid ids.`,
      );
    }
    if (!result.ok) {
      return errorResult(alertHttpError(result, "delete the price alert"));
    }

    return textResult(
      `Price alert \`${id}\` was permanently deleted from the user's account.`,
    );
  },
);

server.tool(
  "opa_get_alert_triggers",
  "Get recent trigger activity for the user's price alerts — which alerts have " +
    "fired, how many times, and when they last triggered. Use when the user asks " +
    "whether any alerts have gone off or about recent alert activity. REQUIRES an " +
    "API key (OILPRICEAPI_KEY). Note: the API tracks trigger history as per-alert " +
    "counters (trigger_count / last_triggered_at) rather than a separate event " +
    "feed, so this returns alerts that have triggered.",
  {
    since: z
      .string()
      .optional()
      .describe(
        "Optional ISO 8601 date/time (e.g., '2026-06-01' or '2026-06-01T00:00:00Z'). Only alerts last triggered on or after this time are shown.",
      ),
  },
  async ({ since }) => {
    const keyErr = requireApiKey();
    if (keyErr) return keyErr;

    let sinceTime: number | null = null;
    if (since) {
      const parsed = Date.parse(since);
      if (Number.isNaN(parsed)) {
        return errorResult(
          `'${since}' is not a valid date. Use an ISO 8601 date like '2026-06-01' or '2026-06-01T00:00:00Z'.`,
        );
      }
      sinceTime = parsed;
    }

    const result = await makeAuthRequest("/v1/alerts");
    if (!result.ok) {
      return errorResult(alertHttpError(result, "fetch alert triggers"));
    }

    const alerts = Array.isArray(result.body)
      ? (result.body as AlertRecord[])
      : [];

    let triggered = alerts.filter(
      (a) => typeof a.trigger_count === "number" && a.trigger_count > 0,
    );

    if (sinceTime !== null) {
      triggered = triggered.filter((a) => {
        if (!a.last_triggered_at) return false;
        const t = Date.parse(a.last_triggered_at);
        return !Number.isNaN(t) && t >= sinceTime!;
      });
    }

    if (triggered.length === 0) {
      return textResult(
        since
          ? `No price alerts have triggered since ${since}.`
          : "No price alerts have triggered yet.",
      );
    }

    triggered.sort((a, b) => {
      const ta = a.last_triggered_at ? Date.parse(a.last_triggered_at) : 0;
      const tb = b.last_triggered_at ? Date.parse(b.last_triggered_at) : 0;
      return tb - ta;
    });

    const sections = [`# Recent Alert Triggers (${triggered.length})\n`];
    for (const a of triggered) {
      const label =
        a.summary ||
        a.condition ||
        `${a.commodity_code} ${a.condition_operator} ${a.condition_value}`;
      sections.push(
        `- **${a.name || label}** (id: \`${a.id}\`) — ${a.trigger_count} trigger(s), last at ${a.last_triggered_at}`,
      );
    }
    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);
    return textResult(sections.join("\n"));
  },
);

// =========================================================================
// RESOURCES — subscribable price snapshots + dynamic template
// =========================================================================

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

server.resource(
  "price-diesel",
  "price://diesel",
  {
    description: "Current US national average diesel price",
    mimeType: "application/json",
  },
  async () => {
    const response = await makeApiRequest<ApiResponse<PriceData>>(
      "/v1/prices/latest?by_code=DIESEL_USD",
    );
    return {
      contents: [
        {
          uri: "price://diesel",
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

// =========================================================================
// PROMPTS — pre-built analyst templates
// =========================================================================

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
          text: "Give me today's energy market briefing. Use opa_market_overview to get all commodity prices, then provide:\n1. Key price levels for Brent, WTI, and Natural Gas\n2. Biggest movers (largest 24h % changes)\n3. Notable spreads (Brent-WTI, US gas vs EU gas)\n4. Brief market context\nFormat as a concise analyst briefing.",
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
          text: "Use opa_compare_prices with ['brent', 'wti'] to compare Brent and WTI crude oil prices. Calculate the spread and explain what it means for the market. Is the spread widening or narrowing based on the 24h changes?",
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
          text: "Use opa_compare_prices with ['natural gas', 'uk gas', 'european gas'] to compare the three gas markets:\n1. Current price levels in their native currencies\n2. 24h changes\n3. Which market is moving most?\n4. What does the transatlantic gas price gap suggest about supply/demand dynamics?",
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
          text: `Use opa_get_price for ${commodity} and opa_get_history for its past month, then provide a detailed report:\n1. Current price and currency\n2. 24h price change (absolute and percentage)\n3. Monthly trend (high, low, average)\n4. Key factors that typically affect this commodity's price\n5. Who are the main consumers and producers?`,
        },
      },
    ],
  }),
);

server.prompt(
  "diesel-cost-analysis",
  "Compare diesel prices across US states for fleet cost planning",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Use opa_get_diesel_by_state to get diesel prices for the top 5 trucking corridor states (TX, CA, FL, PA, IL). Compare prices and identify the cheapest and most expensive states. Calculate the cost difference for a 200-gallon fill-up between the cheapest and most expensive state.",
        },
      },
    ],
  }),
);

server.prompt(
  "supply-analysis",
  "Analyze oil supply fundamentals using production, rig counts, and storage data",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Use opa_get_opec_production, opa_get_rig_counts, and opa_get_storage to analyze current oil supply fundamentals:\n1. OPEC production levels and recent changes\n2. US rig count trends\n3. Cushing and SPR inventory levels\n4. Overall supply outlook — bullish or bearish for prices?",
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
  if (!API_KEY) {
    console.error(
      "Warning: OILPRICEAPI_KEY not set. Get a free key at https://oilpriceapi.com/signup",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OilPriceAPI MCP Server v2.2.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
