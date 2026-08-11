#!/usr/bin/env node

/**
 * OilPriceAPI MCP Server v3.0.0
 *
 * Source-timestamped oil, gas, and related energy data for Claude, Cursor,
 * VS Code, and any MCP-compatible client.
 *
 * KEYLESS DEMO MODE (#16): when no OILPRICEAPI_KEY is configured, the four
 * price-read tools (opa_get_price, opa_compare_prices, opa_list_commodities,
 * opa_market_overview) serve live data from the keyless /v1/demo/prices
 * endpoint (limited commodity set) with a signup footer. All other tools
 * return a helpful teaser (what the tool does + illustrative response shape +
 * signup link) instead of a raw 401.
 *
 * TIER-LIMIT NUDGES (#17): every 402/403/429 error path surfaces the exact
 * limit/feature gate hit by the API plus an upgrade link (see ApiGateError in
 * makeApiRequest and alertHttpError for the authenticated tools).
 *
 * 32 tools total (opa_ prefixed):
 *
 * 23 read-only tools: reviewed product facts, prices, history, futures, marine
 * fuels, rig counts, drilling, diesel-by-state, LTL and parcel fuel
 * surcharges, storage, OPEC production, forecasts, EIA oil inventories, well
 * permits, well production, and refining spreads.
 *
 * 4 authenticated price-alert tools (opa_*_price_alert / opa_get_alert_triggers):
 * create/list/delete persistent price alerts tied to the user's account and read
 * recent trigger activity. These wrap the existing /v1/alerts engine and REQUIRE
 * an API key (OILPRICEAPI_KEY).
 *
 * 5 authenticated agent-subscription + market-brief tools (#3245 Phase 2):
 * opa_get_market_brief (multi-commodity structured + narrative summary) and
 * opa_create_price_subscription / opa_list_subscriptions /
 * opa_delete_subscription / opa_get_subscription_events. Subscriptions
 * ("watches") are PERSISTENT, account-tied, recurring snapshots polled via a
 * per-user cursor — they REQUIRE an API key. These wrap /v1/market-brief and
 * /v1/subscriptions.
 *
 * @see https://oilpriceapi.com
 * @see https://modelcontextprotocol.io
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  CLIENT_CONFIG_TARGETS,
  generateClientConfig,
  isClientConfigTarget,
} from "./clientConfig.js";
import { PRODUCT_FACTS_URI, ProductFactsProvider } from "./productFacts.js";
import {
  currentToolAttributionHeaders,
  withToolTelemetry,
} from "./telemetry.js";
import {
  applyToolConfiguration,
  buildCapabilityManifest,
  resolveToolConfiguration,
  type CapabilityBuildMetadata,
  type ToolConfiguration,
} from "./toolRegistry.js";

export {
  PINNED_PRODUCT_FACTS,
  PINNED_PRODUCT_FACTS_CHECKSUM,
  PRODUCT_FACTS_URI,
  ProductFactsContractError,
  ProductFactsProvider,
  validateAndSanitizeProductFacts,
} from "./productFacts.js";

// API Configuration
const API_BASE =
  process.env.OILPRICEAPI_BASE_URL || "https://api.oilpriceapi.com";
export const MCP_VERSION = "3.2.1";
export const CLIENT_MARKER = `oilpriceapi-mcp/${MCP_VERSION}`;
export const USER_AGENT = CLIENT_MARKER;

function configuredClientMarker(): string {
  const marker = process.env.OILPRICEAPI_CLIENT_MARKER?.trim();
  return marker || CLIENT_MARKER;
}

function configuredClientVersion(marker: string): string {
  const version = process.env.OILPRICEAPI_CLIENT_VERSION?.trim();
  if (version) return version;

  const match = marker.match(/\/v?([^/]+)$/);
  return match?.[1] || MCP_VERSION;
}

export function clientAttributionHeaders(): Record<string, string> {
  const marker = configuredClientMarker();

  return {
    "User-Agent": USER_AGENT,
    "X-Api-Client": marker,
    "X-Client-Version": configuredClientVersion(marker),
  };
}

/**
 * Get the API key from the environment. Read dynamically (not captured at
 * module load) so demo-mode behavior is testable and reflects the live env.
 */
export function getApiKey(): string | undefined {
  return process.env.OILPRICEAPI_KEY || process.env.OIL_PRICE_API_KEY;
}

// Conversion links (#16/#17). utm_source distinguishes demo-mode signups from
// tier-limit upgrade nudges.
export const SIGNUP_URL =
  "https://oilpriceapi.com/auth/signup?utm_source=mcp-demo";
export const UPGRADE_URL =
  "https://oilpriceapi.com/pricing?utm_source=mcp-limit";

// Footer appended to EVERY demo-mode (keyless) response.
export const DEMO_FOOTER = `⚠ Demo data (limited commodity set). Get a free API key for the broader account-enabled catalog: ${SIGNUP_URL}`;

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

// Latest futures response (GET /v1/futures/{slug}). The API returns the object
// at the top level (no { status, data } envelope) with each contract carrying
// `contract_month` + `last_price` (see V1::FuturesController#format_response).
interface FuturesLatestData {
  commodity?: string;
  source?: string;
  updated_at?: string;
  settlement_date?: string;
  front_month?: FuturesLatestContract;
  contracts: FuturesLatestContract[];
}

interface FuturesLatestContract {
  code?: string;
  contract_month: string;
  last_price: number;
  currency?: string;
  change_percent?: number;
  volume?: number;
  is_front_month?: boolean;
}

// Curve response (GET /v1/futures/{slug}/curve). Top-level object with each
// contract carrying `contract_month` + `settlement_price`
// (see Futures::SpreadsCalculationService#futures_curve_analysis).
interface FuturesCurveData {
  analysis_date?: string;
  curve_type?: string;
  total_contracts?: number;
  front_month?: FuturesCurveContract;
  back_month?: FuturesCurveContract;
  contracts: FuturesCurveContract[];
}

interface FuturesCurveContract {
  contract_month: string;
  contract_code?: string;
  settlement_price: number;
  trading_date?: string;
  months_to_expiry?: number;
}

// Supported futures contracts (used by opa_get_futures + opa_get_futures_curve).
// Accepts both legacy codes (BZ/CL) and friendly API slug names. Each maps to a
// canonical API slug used to build /v1/futures/{slug} and /v1/futures/{slug}/curve.
// There is NO generic ?contract= route — paths are per-commodity slugs.
export const FUTURES_CONTRACTS = [
  // Crude
  "BZ",
  "CL",
  "ice-brent",
  "ice-wti",
  // Gasoil
  "G",
  "QS",
  "ice-gasoil",
  // Natural gas
  "NG",
  "natural-gas",
  // TTF gas
  "TTF",
  "ttf-gas",
  // LNG JKM
  "JKM",
  "lng-jkm",
  // Carbon
  "EUA",
  "eua-carbon",
  "UKA",
  "uk-carbon",
] as const;

// Map every accepted contract code/alias to its canonical API slug.
export const FUTURES_CONTRACT_SLUGS: Record<
  (typeof FUTURES_CONTRACTS)[number],
  string
> = {
  BZ: "ice-brent",
  CL: "ice-wti",
  "ice-brent": "ice-brent",
  "ice-wti": "ice-wti",
  G: "ice-gasoil",
  QS: "ice-gasoil",
  "ice-gasoil": "ice-gasoil",
  NG: "natural-gas",
  "natural-gas": "natural-gas",
  TTF: "ttf-gas",
  "ttf-gas": "ttf-gas",
  JKM: "lng-jkm",
  "lng-jkm": "lng-jkm",
  EUA: "eua-carbon",
  "eua-carbon": "eua-carbon",
  UKA: "uk-carbon",
  "uk-carbon": "uk-carbon",
};

export const FUTURES_CONTRACT_NAMES: Record<
  (typeof FUTURES_CONTRACTS)[number],
  string
> = {
  BZ: "Brent Crude",
  CL: "WTI Crude",
  "ice-brent": "ICE Brent Crude",
  "ice-wti": "ICE WTI Crude",
  G: "ICE Gasoil",
  QS: "ICE Gasoil",
  "ice-gasoil": "ICE Gasoil",
  NG: "Natural Gas",
  "natural-gas": "Natural Gas",
  TTF: "European TTF Natural Gas",
  "ttf-gas": "European TTF Natural Gas",
  JKM: "LNG JKM (Asia)",
  "lng-jkm": "LNG JKM (Asia)",
  EUA: "EU Carbon Allowance (EUA)",
  "eua-carbon": "EU Carbon Allowance (EUA)",
  UKA: "UK Carbon Allowance (UKA)",
  "uk-carbon": "UK Carbon Allowance (UKA)",
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

// Shape of GET /v1/drilling/latest as served by the current API (verified
// live 2026-07-13). The pre-#31 shape (total_wells/active_rigs/
// region_breakdown/date) is no longer what the endpoint returns.
interface DrillingData {
  rig_counts?: Record<string, number>;
  frac_spread_count?: number;
  well_permits?: {
    last_30d?: number;
    by_state?: Record<string, number>;
  };
  duc_wells_total?: number;
  deltas?: Record<string, number>;
  last_updated?: string;
}

export const FUEL_SURCHARGE_MODES = ["auto", "ltl", "parcel"] as const;
export type FuelSurchargeMode = (typeof FUEL_SURCHARGE_MODES)[number];
type ResolvedFuelSurchargeMode = Exclude<FuelSurchargeMode, "auto">;

const PARCEL_FUEL_SURCHARGE_SLUGS = new Set(["ups", "fedex", "dhl"]);

export const FUEL_SURCHARGE_CARRIER_ALIASES: Record<string, string> = {
  odfl: "odfl",
  "old dominion": "odfl",
  "old dominion freight": "odfl",
  "old dominion freight line": "odfl",
  od: "odfl",
  saia: "saia",
  "saia ltl freight": "saia",
  estes: "estes",
  "estes express": "estes",
  "estes express lines": "estes",
  sefl: "southeastern-freight",
  southeastern: "southeastern-freight",
  "southeastern freight": "southeastern-freight",
  "southeastern freight lines": "southeastern-freight",
  "fedex freight": "fedex-freight",
  "federal express freight": "fedex-freight",
  "r+l": "rl-carriers",
  "r+l carriers": "rl-carriers",
  rl: "rl-carriers",
  "rl carriers": "rl-carriers",
  "abf freight": "abf",
  arcbest: "abf",
  "t force": "tforce",
  "t-force": "tforce",
  "tforce freight": "tforce",
  "xpo logistics": "xpo",
  "averitt express": "averitt",
  "dhl express": "dhl",
  "fed ex": "fedex",
  "federal express": "fedex",
};

interface FuelSurchargeEndpointOptions {
  carrier?: string;
  mode?: FuelSurchargeMode;
  service_level?: string;
  history?: boolean;
  per_page?: number;
}

interface FuelSurchargeEndpointResult {
  endpoint: string;
  resolvedMode: ResolvedFuelSurchargeMode;
  carrier?: string;
  serviceLevel?: string;
}

interface FuelSurchargeRate {
  carrier?: string;
  carrier_name?: string;
  mode?: string;
  service_level?: string;
  surcharge_percent?: number | string | null;
  effective_date?: string;
  doe_diesel_price?: number | string | null;
  diesel_band?: {
    min?: number | string | null;
    max?: number | string | null;
  } | null;
  source?: string;
  retrieved_at?: string;
}

interface FuelSurchargeCarrier extends FuelSurchargeRate {
  service_levels?: FuelSurchargeRate[];
}

interface FuelSurchargeData extends FuelSurchargeCarrier {
  carriers?: FuelSurchargeCarrier[];
  history?: FuelSurchargeRate[];
  meta?: {
    page?: number;
    per_page?: number;
    total_count?: number;
    total_pages?: number;
    [key: string]: unknown;
  };
}

function normalizeFuelSurchargeSlug(input?: string): string | undefined {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) return undefined;

  const alias = FUEL_SURCHARGE_CARRIER_ALIASES[normalized];
  if (alias) return alias;

  return normalized
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveCarrierSlug(input: string): string {
  return normalizeFuelSurchargeSlug(input) ?? "";
}

function normalizeFuelSurchargeServiceLevel(
  input?: string,
): string | undefined {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) return undefined;

  return normalized
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function boundedFuelSurchargePerPage(perPage?: number): number {
  if (!Number.isFinite(perPage)) return 12;
  return Math.min(Math.max(Math.trunc(perPage as number), 1), 100);
}

/**
 * Map MCP fuel-surcharge args to the public API contract (#4790).
 * Auto mode treats UPS/FedEx/DHL as parcel carriers and all other slugs as LTL.
 */
export function fuelSurchargeEndpoint(
  opts: FuelSurchargeEndpointOptions = {},
): FuelSurchargeEndpointResult | { error: string } {
  const requestedMode = opts.mode ?? "auto";
  const carrier = normalizeFuelSurchargeSlug(opts.carrier);

  if (!carrier) {
    return requestedMode === "parcel"
      ? { endpoint: "/v1/fuel-surcharge/parcel", resolvedMode: "parcel" }
      : { endpoint: "/v1/fuel-surcharge", resolvedMode: "ltl" };
  }

  const resolvedMode: ResolvedFuelSurchargeMode =
    requestedMode === "auto"
      ? PARCEL_FUEL_SURCHARGE_SLUGS.has(carrier)
        ? "parcel"
        : "ltl"
      : requestedMode;

  const perPage = boundedFuelSurchargePerPage(opts.per_page);

  if (resolvedMode === "parcel") {
    const serviceLevel = normalizeFuelSurchargeServiceLevel(opts.service_level);
    const base = `/v1/fuel-surcharge/parcel/${encodeURIComponent(carrier)}`;

    if (opts.history) {
      if (!serviceLevel) {
        return {
          error:
            "Parcel fuel-surcharge history requires service_level (for example: ground, air, international_air_export). Call latest without service_level to list available service levels.",
        };
      }

      const params = new URLSearchParams({
        service_level: serviceLevel,
        per_page: String(perPage),
      });
      return {
        endpoint: `${base}/history?${params.toString()}`,
        resolvedMode,
        carrier,
        serviceLevel,
      };
    }

    if (serviceLevel) {
      const params = new URLSearchParams({ service_level: serviceLevel });
      return {
        endpoint: `${base}/latest?${params.toString()}`,
        resolvedMode,
        carrier,
        serviceLevel,
      };
    }

    return { endpoint: `${base}/latest`, resolvedMode, carrier };
  }

  const base = `/v1/fuel-surcharge/${encodeURIComponent(carrier)}`;
  return opts.history
    ? {
        endpoint: `${base}/history?per_page=${perPage}`,
        resolvedMode,
        carrier,
      }
    : { endpoint: `${base}/latest`, resolvedMode, carrier };
}

function fuelSurchargeCarrierLabel(rate: FuelSurchargeRate): string {
  if (rate.carrier_name && rate.carrier) {
    return `${rate.carrier_name} (${rate.carrier})`;
  }
  return rate.carrier_name || rate.carrier || "Carrier";
}

function fuelSurchargeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatFuelSurchargePercent(value: unknown): string {
  const percent = fuelSurchargeNumber(value);
  return percent === null ? "n/a" : `${percent.toFixed(2)}%`;
}

function formatFuelSurchargeMoney(value: unknown): string | null {
  const amount = fuelSurchargeNumber(value);
  return amount === null ? null : `$${amount.toFixed(3)}/gal`;
}

function formatFuelSurchargeBand(
  band: FuelSurchargeRate["diesel_band"],
): string | null {
  if (!band) return null;

  const min = fuelSurchargeNumber(band.min);
  const max = fuelSurchargeNumber(band.max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null)
    return `$${min.toFixed(2)}-$${max.toFixed(2)} DOE band`;
  if (min !== null) return `$${min.toFixed(2)}+ DOE band`;
  return `up to $${max!.toFixed(2)} DOE band`;
}

function formatFuelSurchargeLine(rate: FuelSurchargeRate): string {
  const label = rate.service_level
    ? `${rate.service_level}`
    : fuelSurchargeCarrierLabel(rate);
  const parts = [
    `**${label}**: ${formatFuelSurchargePercent(rate.surcharge_percent)}`,
  ];

  if (rate.effective_date) parts.push(`effective ${rate.effective_date}`);

  const dieselPrice = formatFuelSurchargeMoney(rate.doe_diesel_price);
  if (dieselPrice) parts.push(`DOE diesel ${dieselPrice}`);

  const band = formatFuelSurchargeBand(rate.diesel_band);
  if (band) parts.push(band);

  if (rate.source) parts.push(`source ${rate.source}`);
  if (rate.retrieved_at) parts.push(`retrieved ${rate.retrieved_at}`);

  return `- ${parts.join(" · ")}`;
}

function formatFuelSurchargeCarrier(carrier: FuelSurchargeCarrier): string {
  if (carrier.service_levels?.length) {
    const lines = [`## ${fuelSurchargeCarrierLabel(carrier)}`];
    for (const rate of carrier.service_levels) {
      lines.push(
        formatFuelSurchargeLine({
          ...rate,
          carrier: rate.carrier ?? carrier.carrier,
          carrier_name: rate.carrier_name ?? carrier.carrier_name,
          mode: rate.mode ?? carrier.mode,
        }),
      );
    }
    return lines.join("\n");
  }

  return formatFuelSurchargeLine(carrier);
}

/**
 * Format fuel-surcharge API payloads for agent-readable output.
 * The output preserves effective/retrieved dates and source so staleness is
 * visible instead of implying the carrier schedule was updated today.
 */
export function formatFuelSurchargeData(
  data: FuelSurchargeData,
  opts: { mode?: ResolvedFuelSurchargeMode; history?: boolean } = {},
): string {
  const modeLabel = opts.mode === "parcel" ? "Parcel" : "LTL";

  if (data.carriers?.length) {
    const sections = [`# ${modeLabel} Fuel Surcharges\n`];
    for (const carrier of data.carriers) {
      sections.push(formatFuelSurchargeCarrier(carrier), "");
    }
    sections.push("_Data from [OilPriceAPI](https://oilpriceapi.com)_");
    return sections.join("\n");
  }

  if (data.history?.length) {
    const first = data.history[0];
    const sections = [
      `# ${modeLabel} Fuel Surcharge History - ${fuelSurchargeCarrierLabel(first)}\n`,
    ];
    for (const rate of data.history) {
      sections.push(formatFuelSurchargeLine(rate));
    }
    if (data.meta) {
      const total =
        typeof data.meta.total_count === "number"
          ? ` of ${data.meta.total_count}`
          : "";
      sections.push(
        "",
        `_Page ${data.meta.page ?? 1}${data.meta.total_pages ? ` of ${data.meta.total_pages}` : ""}; showing ${data.history.length}${total} rows._`,
      );
    }
    sections.push("", "_Data from [OilPriceAPI](https://oilpriceapi.com)_");
    return sections.join("\n");
  }

  if (data.service_levels?.length) {
    return [
      `# ${modeLabel} Fuel Surcharge - ${fuelSurchargeCarrierLabel(data)}\n`,
      formatFuelSurchargeCarrier(data),
      "",
      "_Data from [OilPriceAPI](https://oilpriceapi.com)_",
    ].join("\n");
  }

  return [
    `# ${modeLabel} Fuel Surcharge - ${fuelSurchargeCarrierLabel(data)}\n`,
    formatFuelSurchargeLine(data),
    "",
    "_Data from [OilPriceAPI](https://oilpriceapi.com)_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Create server instance
// ---------------------------------------------------------------------------

export const SERVER_INSTRUCTIONS =
  "Use opa_get_product_facts or the oilpriceapi://product-facts resource " +
  "for questions about OilPriceAPI product scope, offers, pricing links, " +
  "freshness, catalog access, authentication, installation, or data rights. " +
  "Do not infer a universal refresh cadence, catalog count, entitlement, " +
  "redistribution right, or execution-feed latency.";

const server = new McpServer(
  {
    name: "oilpriceapi",
    version: MCP_VERSION,
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

// Instrument every registered tool in one place so new tools cannot silently
// bypass attribution or privacy-safe hit/miss telemetry.
const rawRegisterTool = server.registerTool.bind(server);
server.registerTool = ((
  name: string,
  config: unknown,
  callback: (args: unknown, extra: unknown) => unknown,
) =>
  rawRegisterTool(
    name,
    config as never,
    ((args: unknown, extra: unknown) =>
      withToolTelemetry(name, args, () => callback(args, extra))) as never,
  )) as typeof server.registerTool;

export const productFactsProvider = new ProductFactsProvider({
  url: API_BASE + "/product-facts.json",
  fetchImpl: (input, init) => fetch(input, init),
  requestHeaders: clientAttributionHeaders(),
});

// ---------------------------------------------------------------------------
// Tool annotation presets (MCP ToolAnnotations behavior hints).
//
// - Read tools only fetch data from the external OilPriceAPI service:
//   readOnlyHint (no environment changes) + openWorldHint (external API).
// - Create tools add an alert/subscription on the user's account: not
//   read-only, not destructive, not idempotent (repeat calls create
//   duplicates).
// - Delete tools remove an alert/subscription: destructive, but idempotent
//   (deleting the same id again has no further effect).
// ---------------------------------------------------------------------------

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

export const CREATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const DELETE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

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

// ---------------------------------------------------------------------------
// Tier-limit gate errors (#17)
//
// When the API answers 402/403 (immediately) or 429 (after retries are
// exhausted), we throw an ApiGateError whose message contains the API's own
// limit/feature-gate detail plus an upgrade link. The MCP SDK converts a
// thrown error from a tool handler into an isError tool result carrying
// error.message, so centralizing here gives EVERY read tool the nudge without
// per-tool edits.
// ---------------------------------------------------------------------------

export class ApiGateError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiGateError";
    this.status = status;
  }
}

/** Extract the API's own error/limit message from a response body, if any. */
async function extractErrorDetail(response: Response): Promise<string> {
  try {
    if (typeof response.text !== "function") return "";
    const text = await response.text();
    if (!text) return "";
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.error === "string") return obj.error;
      if (obj.errors) return JSON.stringify(obj.errors);
      return "";
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "";
  }
}

/** Build the standard 402/403/429 gate error with the upgrade nudge. */
async function buildGateError(response: Response): Promise<ApiGateError> {
  const detail = await extractErrorDetail(response);
  const label =
    response.status === 402
      ? "Payment required (HTTP 402) — this data is not included in the current plan"
      : response.status === 403
        ? "Access denied (HTTP 403) — this feature is gated to a higher plan"
        : "Rate limit exceeded (HTTP 429) — the plan's request limit was hit";
  return new ApiGateError(
    response.status,
    `${label}${detail ? `: ${detail}` : "."} Upgrade: ${UPGRADE_URL} — compare plans with the opa_get_plans tool; check current usage with opa_get_account_status.`,
  );
}

/**
 * Make API request to OilPriceAPI with retry and exponential backoff.
 *
 * Throws ApiGateError on 402/403 (immediately) and 429 (after retries are
 * exhausted) so tier-limit gates surface the exact limit + upgrade link (#17).
 * Returns null on other failures (401, 404, 5xx exhausted, network).
 */
export async function makeApiRequest<T>(
  endpoint: string,
  fetchFn: typeof fetch = fetch,
): Promise<T | null> {
  const headers: Record<string, string> = {
    ...clientAttributionHeaders(),
    ...currentToolAttributionHeaders(),
    Accept: "application/json",
  };

  const apiKey = getApiKey();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
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

      // Tier/feature gate — surface the exact limit + upgrade link (#17).
      if (response.status === 402 || response.status === 403) {
        throw await buildGateError(response);
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

      // 429 with retries exhausted — surface the rate limit + upgrade link.
      if (response.status === 429) {
        throw await buildGateError(response);
      }

      console.error(
        `HTTP ${response.status}: ${response.statusText} for ${endpoint}`,
      );
      return null;
    } catch (error) {
      if (error instanceof ApiGateError) throw error;
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
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
  fetchFn: typeof fetch = fetch,
): Promise<AuthRequestResult> {
  const { method = "GET", body, headers: extraHeaders } = options;

  const headers: Record<string, string> = {
    ...clientAttributionHeaders(),
    ...currentToolAttributionHeaders(),
    Accept: "application/json",
    // The API accepts the customer API key as a bearer token.
    Authorization: `Bearer ${getApiKey()}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  // Caller-supplied headers (e.g. MCP attribution: X-OPA-Source / X-OPA-Tool).
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
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
 * Standard keyless guard for authenticated tools: returns the teaser result
 * (what the tool does + illustrative shape + signup link) when no API key is
 * configured, otherwise null. See keylessTeaserResult below (#16).
 */
function requireApiKey(
  toolName: string,
): ReturnType<typeof errorResult> | null {
  if (!getApiKey()) {
    return keylessTeaserResult(toolName);
  }
  return null;
}

/**
 * Map an authenticated-request failure to a clear, agent-readable error.
 * 402/403/429 gate errors carry the API's exact limit plus the upgrade link (#17).
 */
export function alertHttpError(
  result: AuthRequestResult,
  action: string,
): string {
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
  let msg = `Could not ${action} (HTTP ${result.status})${detail ? `: ${detail}` : "."}`;
  // Tier/feature gate or rate limit — add the upgrade nudge (#17).
  if (result.status === 402 || result.status === 403 || result.status === 429) {
    msg += ` Upgrade: ${UPGRADE_URL} — compare plans with the opa_get_plans tool; check current usage with opa_get_account_status.`;
  }
  return msg;
}

// Operators accepted by the /v1/alerts engine (PriceAlert::VALID_OPERATORS).
export const ALERT_OPERATORS = [
  "greater_than",
  "less_than",
  "equals",
  "greater_than_or_equal",
  "less_than_or_equal",
] as const;

// ---------------------------------------------------------------------------
// Subscription ("watch") interval mapping (#3245 Phase 2)
//
// The /v1/subscriptions API stores the snapshot cadence as `interval_seconds`
// (an integer), and enforces a per-tier interval FLOOR server-side
// (free 3600s/1h → developer 1800s/30m → starter 900s/15m → professional
// 300s/5m → scale 60s/1m). We let agents pass a friendly `interval` like "5m",
// "1h", or "daily" and translate it to seconds here. A bare integer string is
// treated as seconds. If the chosen interval is below the caller's tier floor,
// the API returns a 422 with the exact minimum — we surface that message.
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_INTERVAL_PRESETS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  hourly: 3600,
  "6h": 21600,
  "12h": 43200,
  daily: 86400,
  "1d": 86400,
};

/**
 * Translate a friendly interval ("5m" / "1h" / "daily") or a bare seconds
 * value ("300") into interval_seconds for POST /v1/subscriptions. Returns null
 * for anything unrecognized so the caller can return an actionable error.
 */
export function resolveIntervalSeconds(input: string): number | null {
  const normalized = input.toLowerCase().trim();

  const preset = SUBSCRIPTION_INTERVAL_PRESETS[normalized];
  if (preset) return preset;

  // Bare integer (seconds), e.g. "300".
  if (/^\d+$/.test(normalized)) {
    const seconds = parseInt(normalized, 10);
    return seconds > 0 ? seconds : null;
  }

  // "<n><unit>" shorthand, e.g. "10m", "2h", "3d".
  const match = normalized.match(/^(\d+)\s*(s|m|h|d)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n <= 0) return null;
    const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
    return unitSeconds ? n * unitSeconds : null;
  }

  return null;
}

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
// KEYLESS DEMO MODE (#16)
//
// The production API exposes GET /v1/demo/prices — a keyless endpoint with a
// small live commodity set (Brent, WTI, diesel, gasoline, natural gas, gold,
// heating oil, EUR/USD, GBP/USD). When no OILPRICEAPI_KEY is configured:
//   - the four price-read tools serve from this endpoint (with DEMO_FOOTER),
//   - every other tool returns a teaser (keylessTeaserResult) instead of a
//     raw 401.
// =========================================================================

interface DemoPrice {
  code: string;
  name?: string;
  price: number;
  currency?: string;
  updated_at?: string;
  // NOTE: the demo endpoint's change_24h is a PERCENTAGE (e.g. EUR_USD at
  // 1.1428 with change_24h 0.44 can only be 0.44%), unlike /v1/prices/latest
  // where change_24h is absolute and change_24h_percent carries the percent.
  change_24h?: number;
  source?: string;
}

/**
 * Fetch the keyless demo price set. Returns null if unreachable/malformed.
 */
export async function fetchDemoPrices(
  fetchFn: typeof fetch = fetch,
): Promise<DemoPrice[] | null> {
  try {
    const response = await fetchFn(`${API_BASE}/v1/demo/prices`, {
      headers: {
        ...clientAttributionHeaders(),
        ...currentToolAttributionHeaders(),
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as ApiResponse<{
      prices: DemoPrice[];
    }> | null;
    if (payload?.status !== "success" || !Array.isArray(payload.data?.prices)) {
      return null;
    }
    return payload.data.prices;
  } catch {
    return null;
  }
}

/** Append the mandatory demo footer to a tool result's text. */
function withDemoFooter(text: string) {
  return textResult(`${text}\n\n${DEMO_FOOTER}`);
}

function demoErrorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `${message}\n\n${DEMO_FOOTER}` }],
    isError: true,
  };
}

function formatDemoPrice(p: DemoPrice): string {
  const info = COMMODITY_INFO[p.code] || {
    name: p.name || p.code,
    unit: "unit",
  };
  const currencySymbol =
    p.currency === "EUR" ? "€" : p.currency === "GBP" ? "£" : "$";
  let result = `**${info.name}**: ${currencySymbol}${p.price.toFixed(2)}/${info.unit}`;
  if (typeof p.change_24h === "number") {
    const sign = p.change_24h >= 0 ? "+" : "";
    result += `\n- 24h Change: ${sign}${p.change_24h.toFixed(2)}%`;
  }
  if (p.updated_at) {
    result += `\n- Updated: ${new Date(p.updated_at).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    })} UTC`;
  }
  return result;
}

function demoUnreachableResult() {
  return demoErrorResult(
    "Could not reach the keyless demo endpoint. The API may be temporarily unavailable — try again in a moment.",
  );
}

function listDemoCodes(prices: DemoPrice[]): string {
  return prices.map((p) => `\`${p.code}\``).join(", ");
}

/** Keyless opa_get_price: serve a single price from the demo set. */
export async function demoPriceResult(
  commodity: string,
  fetchFn: typeof fetch = fetch,
) {
  const resolved = resolveOrError(commodity);
  if ("error" in resolved) return resolved.error;

  const prices = await fetchDemoPrices(fetchFn);
  if (!prices) return demoUnreachableResult();

  const match = prices.find((p) => p.code === resolved.code);
  if (!match) {
    return demoErrorResult(
      `'${commodity}' (${resolved.code}) is not in the keyless demo commodity set. ` +
        `Demo commodities available without an API key: ${listDemoCodes(prices)}.`,
    );
  }

  return withDemoFooter(formatDemoPrice(match));
}

/** Keyless opa_compare_prices: compare commodities within the demo set. */
export async function demoComparePricesResult(
  commodities: string[],
  fetchFn: typeof fetch = fetch,
) {
  const prices = await fetchDemoPrices(fetchFn);
  if (!prices) return demoUnreachableResult();

  const found: DemoPrice[] = [];
  const missing: string[] = [];
  for (const commodity of commodities) {
    const code = resolveCommodityCode(commodity);
    const match = code ? prices.find((p) => p.code === code) : undefined;
    if (match) found.push(match);
    else missing.push(commodity);
  }

  if (found.length < 2) {
    return demoErrorResult(
      `Could not compare — fewer than 2 of the requested commodities are in the keyless demo set` +
        `${missing.length ? ` (not available in demo: ${missing.join(", ")})` : ""}. ` +
        `Demo commodities available without an API key: ${listDemoCodes(prices)}.`,
    );
  }

  const sections = ["# Price Comparison\n"];
  for (const p of found) {
    sections.push(formatDemoPrice(p));
    sections.push("");
  }

  if (
    found.length === 2 &&
    (found[0].currency || "USD") === (found[1].currency || "USD")
  ) {
    const spread = Math.abs(found[0].price - found[1].price);
    const name0 = COMMODITY_INFO[found[0].code]?.name || found[0].code;
    const name1 = COMMODITY_INFO[found[1].code]?.name || found[1].code;
    const sym =
      found[0].currency === "EUR"
        ? "€"
        : found[0].currency === "GBP"
          ? "£"
          : "$";
    sections.push(
      `**Spread**: ${sym}${spread.toFixed(2)} (${name0} vs ${name1})`,
    );
  }

  if (missing.length > 0) {
    sections.push(
      `\n_Not in the demo set (needs an API key): ${missing.join(", ")}._`,
    );
  }

  return withDemoFooter(sections.join("\n"));
}

/** Keyless opa_list_commodities: list the demo commodity set. */
export async function demoListCommoditiesResult(fetchFn: typeof fetch = fetch) {
  const prices = await fetchDemoPrices(fetchFn);
  if (!prices) return demoUnreachableResult();

  const sections = [
    `# Available Commodities — Demo Mode (${prices.length})\n`,
    "No API key is configured, so only the keyless demo commodity set is available:\n",
  ];
  for (const p of prices) {
    const name = COMMODITY_INFO[p.code]?.name || p.name || p.code;
    sections.push(`- \`${p.code}\` — ${name}`);
  }
  sections.push(
    "\n_You can use natural language like 'brent oil' or 'natural gas' — the server translates it to the right code._",
  );

  return withDemoFooter(sections.join("\n"));
}

/** Keyless opa_market_overview: build the overview from the demo set. */
export async function demoMarketOverviewResult(
  category: string = "all",
  fetchFn: typeof fetch = fetch,
) {
  const prices = await fetchDemoPrices(fetchFn);
  if (!prices) return demoUnreachableResult();

  const groups: Record<string, DemoPrice[]> = {
    "Crude Oil": [],
    "Natural Gas": [],
    "Refined Products": [],
    "Precious Metals": [],
    Forex: [],
    Other: [],
  };
  const groupByCategory: Record<string, string> = {
    oil: "Crude Oil",
    gas: "Natural Gas",
    refined: "Refined Products",
    metals: "Precious Metals",
    forex: "Forex",
  };

  for (const p of prices) {
    const code = p.code;
    if (code.includes("CRUDE") || code === "WTI_USD") {
      groups["Crude Oil"].push(p);
    } else if (code.includes("GAS") && code !== "GASOLINE_USD") {
      groups["Natural Gas"].push(p);
    } else if (
      [
        "DIESEL_USD",
        "GASOLINE_USD",
        "HEATING_OIL_USD",
        "JET_FUEL_USD",
      ].includes(code)
    ) {
      groups["Refined Products"].push(p);
    } else if (code.includes("GOLD") || code.includes("SILVER")) {
      groups["Precious Metals"].push(p);
    } else if (code === "EUR_USD" || code === "GBP_USD") {
      groups["Forex"].push(p);
    } else {
      groups["Other"].push(p);
    }
  }

  const wantedGroup = groupByCategory[category];
  const sections = ["# Energy Market Overview (Demo)\n"];
  let shown = 0;

  for (const [group, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    if (wantedGroup && group !== wantedGroup) continue;

    sections.push(`## ${group}\n`);
    for (const p of items) {
      const name = COMMODITY_INFO[p.code]?.name || p.name || p.code;
      const sym = p.currency === "EUR" ? "€" : p.currency === "GBP" ? "£" : "$";
      let line = `- **${name}**: ${sym}${p.price.toFixed(2)}`;
      if (typeof p.change_24h === "number") {
        const sign = p.change_24h >= 0 ? "+" : "";
        line += ` (${sign}${p.change_24h.toFixed(1)}%)`;
      }
      sections.push(line);
      shown++;
    }
    sections.push("");
  }

  if (shown === 0) {
    return demoErrorResult(
      `No demo commodities match the '${category}' category. ` +
        `Demo commodities available without an API key: ${listDemoCodes(prices)}.`,
    );
  }

  return withDemoFooter(sections.join("\n"));
}

// ---------------------------------------------------------------------------
// Keyless teasers for tools with no demo coverage (#16)
//
// One sentence on what the tool does + a one-line ILLUSTRATIVE example of the
// response shape ($XX.XX placeholders — never fabricated prices) + signup
// link. Never a raw "Authentication failed".
// ---------------------------------------------------------------------------

const KEYLESS_TOOL_TEASERS: Record<string, { does: string; example: string }> =
  {
    opa_get_history: {
      does: "Returns historical price statistics (latest, high, low, average, change) for a commodity over a day, week, month, or year.",
      example:
        "Brent Crude Oil — Past Month: Latest $XX.XX · High $XX.XX · Low $XX.XX · Average $XX.XX · Change +X.X% (NN data points)",
    },
    opa_get_futures: {
      does: "Returns the latest front-month futures contract price for crude, gasoil, natural gas, TTF, LNG JKM, and carbon contracts.",
      example:
        "Brent Crude Futures (BZ) — Front Month (MMM-YY): $XX.XX (+X.XX%)",
    },
    opa_get_futures_curve: {
      does: "Returns the full futures forward curve across contract months with contango/backwardation analysis.",
      example:
        "Month: MMM-YY → Settlement $XX.XX (× NN contracts) | Market Structure: contango/backwardation",
    },
    opa_get_marine_fuels: {
      does: "Returns marine bunker fuel prices (VLSFO, MGO, IFO380) across major shipping ports like Singapore and Rotterdam.",
      example: "SINGAPORE | VLSFO | $XXX.XX | USD | metric ton",
    },
    opa_get_rig_counts: {
      does: "Returns the latest Baker Hughes US oil & gas rig counts with week-over-week change.",
      example: "Oil Rigs: NNN · Gas Rigs: NNN · Total: NNN (±N vs prior week)",
    },
    opa_get_drilling: {
      does: "Returns a drilling activity snapshot: US/Canada/international rig counts, frac spread count, well permits (last 30 days, by state), and DUC well totals.",
      example:
        "US Rigs: NNN · Frac Spreads: NNN · Permits (30d): N,NNN · DUC Wells: N,NNN",
    },
    opa_get_diesel_by_state: {
      does: "Returns the AAA average retail diesel price for any US state.",
      example: "Diesel Price — TX: $X.XXX/gallon (24h change ±$0.0XX)",
    },
    opa_get_storage: {
      does: "Returns oil storage/inventory levels for Cushing, Oklahoma and the US Strategic Petroleum Reserve.",
      example:
        "Cushing: NN.N million barrels (±N.N wk/wk) · SPR: NNN.N million barrels",
    },
    opa_get_opec_production: {
      does: "Returns the latest OPEC country-level oil production figures.",
      example:
        "Saudi Arabia: N.NN mb/d · Iraq: N.NN mb/d · ... (per-country output)",
    },
    opa_get_forecasts: {
      does: "Returns energy price forecasts from the EIA Short-Term Energy Outlook.",
      example:
        "Brent 2027 forecast: $XX.XX avg · WTI: $XX.XX · Henry Hub: $X.XX",
    },
    opa_get_oil_inventories: {
      does: "Returns EIA weekly petroleum inventory (stocks) data with builds/draws, optionally summarized or by product.",
      example:
        "Crude stocks: NNN.N million barrels (build/draw ±N.N wk/wk) per product",
    },
    opa_get_well_permits: {
      does: "Returns US oil & gas well drilling permit data, filterable by state or operator.",
      example:
        "TX: NNN permits · NM: NNN permits · ... (latest week, by state/operator)",
    },
    opa_search_well_permits: {
      does: "Searches one state's well permits by county or operator and date range, with measured state freshness and completeness shown before the records.",
      example:
        "State health: available · date coverage NN.N% · N matching permits with source and fetched-at provenance",
    },
    opa_lookup_well: {
      does: "Dereferences a 10-, 12-, or 14-digit API well number into a promoted lifecycle summary and monthly production when exact well-level production is available.",
      example:
        "API NN-NNN-NNNNN-NN-NN · operator · county · permit/spud/production dates · cumulative and monthly production evidence",
    },
    opa_get_well_activity: {
      does: "Returns recent permit activity, top operators/formations, weekly trend, and explicit state-level freshness warnings.",
      example:
        "Last NN days: N,NNN permits · top operators · weekly trend · stale/degraded/attention state warnings",
    },
    opa_get_well_production: {
      does: "Returns US oil & gas well production data (beta coverage): national/state monthly summaries, per-state history, per-well history by API number, top producers, and drill-to-production cycle times.",
      example:
        "TX (YYYY-MM): NNN,NNN,NNN bbl oil · N,NNN,NNN,NNN mcf gas · NNN,NNN,NNN boe",
    },
    opa_get_spread: {
      does: "Returns refining and trading spreads: crack spreads, basis differentials, and blending/transport margins.",
      example: "3-2-1 crack spread: $XX.XX/bbl (as of YYYY-MM-DD)",
    },
    opa_get_fuel_surcharge: {
      does: "Returns carrier-published LTL and parcel fuel surcharge percentages with effective dates, retrieval timestamps, diesel bands where applicable, and source provenance.",
      example:
        "UPS ground fuel surcharge: XX.XX% · effective YYYY-MM-DD · source carrier_schedule · retrieved YYYY-MM-DDTHH:MM:SSZ",
    },
    opa_create_price_alert: {
      does: "Creates a persistent price alert on your account that emails (and optionally webhooks) you when a commodity crosses a threshold.",
      example:
        "Price Alert Created — BRENT_CRUDE_USD < XX.XX (id: `uuid`) [enabled]",
    },
    opa_list_price_alerts: {
      does: "Lists all persistent price alerts on your OilPriceAPI account.",
      example:
        "Price Alerts (N): **Brent < XX** (id: `uuid`) — [enabled, N triggers]",
    },
    opa_delete_price_alert: {
      does: "Permanently deletes a price alert from your OilPriceAPI account by id.",
      example:
        "Price alert `uuid` was permanently deleted from the user's account.",
    },
    opa_get_alert_triggers: {
      does: "Shows which of your price alerts have fired recently, how many times, and when.",
      example:
        "Recent Alert Triggers (N): **Brent < XX** — N trigger(s), last at YYYY-MM-DDTHH:MM:SSZ",
    },
    opa_get_market_brief: {
      does: "Returns a multi-commodity market brief in one call: spot prices, 24h changes, 1-month forecasts, and notable spreads, with an optional narrative summary.",
      example:
        "**Brent Crude Oil**: $XX.XX (+X.XX% 24h) — 1m forecast ~$XX.XX · Spreads: Brent-WTI $X.XX",
    },
    opa_create_price_subscription: {
      does: "Creates a persistent recurring watch on your account that snapshots chosen commodities every interval so agents can poll for changes.",
      example:
        "Price Subscription Created — BRENT_CRUDE_USD, WTI_USD, every 1h, active (id: `uuid`)",
    },
    opa_list_subscriptions: {
      does: "Lists all persistent price subscriptions (watches) on your OilPriceAPI account.",
      example:
        "Price Subscriptions (N): **Crude desk hourly** (id: `uuid`) — BRENT_CRUDE_USD, every 1h, active",
    },
    opa_delete_subscription: {
      does: "Permanently deletes a price subscription (watch) from your OilPriceAPI account by id.",
      example:
        "Price subscription `uuid` was permanently deleted from the user's account.",
    },
    opa_get_subscription_events: {
      does: "Polls for new subscription events — the recurring price snapshots and deltas recorded by your watches since the last cursor.",
      example:
        "Event seq NN — YYYY-MM-DDTHH:MM:SSZ (watch `uuid`): { snapshot: {...}, deltas: {...} } · Next cursor: NN",
    },
  };

/**
 * Teaser returned by keyless calls to tools that cannot work without a key:
 * one sentence on what the tool does, a one-line illustrative response shape
 * (clearly marked as NOT real data), and the signup link (#16).
 */
export function keylessTeaserResult(toolName: string) {
  const teaser = KEYLESS_TOOL_TEASERS[toolName];
  const lines = [
    `\`${toolName}\` requires an API key — no OILPRICEAPI_KEY is configured, so this MCP server is running in keyless demo mode.`,
  ];
  if (teaser) {
    lines.push("", teaser.does);
    lines.push("", "Illustrative response shape (NOT real data):");
    lines.push("```", teaser.example, "```");
  }
  lines.push(
    "",
    `Get a free API key for the broader account-enabled catalog; dataset access varies by plan and entitlement: ${SIGNUP_URL}`,
  );
  return errorResult(lines.join("\n"));
}

// =========================================================================
// READ TOOLS (opa_ prefixed to avoid collisions)
// =========================================================================

server.registerTool(
  "opa_get_product_facts",
  {
    title: "Get OilPriceAPI Product Facts",
    description:
      "Get the reviewed, versioned OilPriceAPI product contract for product scope, evaluation offer, pricing URL, freshness policy, catalog and entitlement wording, authentication, canonical first request, keyless demo, and data-rights boundaries. Use this instead of model memory or package prose for questions about OilPriceAPI itself. No API key or paid-data entitlement is required.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    try {
      return textResult(
        JSON.stringify(await productFactsProvider.get(), null, 2),
      );
    } catch {
      return errorResult(
        "OilPriceAPI product facts are unavailable. Check the canonical contract at https://api.oilpriceapi.com/product-facts.json.",
      );
    }
  },
);

server.registerTool(
  "opa_get_price",
  {
    title: "Get Commodity Price",
    description:
      "Get the latest available, source-timestamped value for an energy commodity. Use when the user asks about a single commodity's latest price. Accepts natural language ('brent oil', 'diesel') or API codes ('WTI_USD'). Returns price, currency, available change fields, and timestamp. For multiple commodities at once, use opa_market_overview. For price trends, use opa_get_history.",
    inputSchema: {
      commodity: z
        .string()
        .describe(
          "Commodity name or code (e.g., 'brent oil', 'natural gas', 'WTI_USD', 'diesel')",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ commodity }) => {
    // Keyless demo mode (#16): serve from /v1/demo/prices.
    if (!getApiKey()) return demoPriceResult(commodity);

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

server.registerTool(
  "opa_market_overview",
  {
    title: "Energy Market Overview",
    description:
      "Get current prices for all tracked energy commodities in one call. Use when the user wants a broad market snapshot or asks about overall energy prices. Returns prices grouped by category (oil, gas, coal, refined products, metals, forex) with 24h changes. Supports filtering by category. For a single commodity, use opa_get_price instead.",
    inputSchema: {
      category: z
        .enum(["all", "oil", "gas", "coal", "refined", "metals", "forex"])
        .optional()
        .describe(
          "Filter by commodity category (default: all). Options: oil, gas, coal, refined, metals, forex.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ category = "all" }) => {
    // Keyless demo mode (#16): serve from /v1/demo/prices.
    if (!getApiKey()) return demoMarketOverviewResult(category);

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

server.registerTool(
  "opa_compare_prices",
  {
    title: "Compare Commodity Prices",
    description:
      "Compare current prices between 2-5 commodities side by side. Use when the user asks to compare commodities (e.g., 'Brent vs WTI', 'US gas vs EU gas'). Returns each commodity's price with 24h changes, plus the spread if comparing two same-currency commodities. Accepts natural language or codes.",
    inputSchema: {
      commodities: z
        .array(z.string())
        .min(2)
        .max(5)
        .describe(
          "List of 2-5 commodity names or codes to compare (e.g., ['brent', 'wti'] or ['NATURAL_GAS_USD', 'DUTCH_TTF_EUR'])",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ commodities }) => {
    // Keyless demo mode (#16): compare within the demo set.
    if (!getApiKey()) return demoComparePricesResult(commodities);

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

server.registerTool(
  "opa_list_commodities",
  {
    title: "List Available Commodities",
    description:
      "List all available commodities that can be queried for prices. Use when the user asks what commodities are available, what codes to use, or when another tool returns a 'commodity not recognized' error. Returns the full catalog fetched live from the API, grouped by category. No parameters needed.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    // Keyless demo mode (#16): list the demo commodity set.
    if (!getApiKey()) return demoListCommoditiesResult();

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
      "_Note: This is a partial list because the catalog endpoint was unreachable. Dataset access varies by plan and account entitlement; try again for the account-enabled list._",
    );

    return textResult(sections.join("\n"));
  },
);

server.registerTool(
  "opa_get_history",
  {
    title: "Get Price History",
    description:
      "Get historical price data for a commodity over a time period. Use when the user asks about price trends, historical prices, or how a commodity has performed over time. Returns high, low, average, change, and data point count. Periods: day (24h), week (7d), month (30d), year (365d). Supports point-in-time (vintage) queries via as_of: the series as it was knowable at that instant — later-collected rows absent, later revisions rolled back (no lookahead bias; built for backtests). Requires a paid plan (Developer, $19/mo, and up) — the free tier serves latest prices only.",
    inputSchema: {
      commodity: z
        .string()
        .describe("Commodity name or code (e.g., 'brent', 'WTI_USD')"),
      period: z
        .enum(["day", "week", "month", "year"])
        .default("month")
        .describe("Time period: day, week, month, or year (default: month)"),
      as_of: z
        .string()
        .optional()
        .describe(
          "Optional ISO8601 date/datetime for a point-in-time (vintage) view, e.g. '2026-06-02'. Returns the series as it was knowable then: rows collected later are absent and values revised later are rolled back. Must not be in the future. Revision-correction coverage since 2026-07-28.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ commodity, period, as_of }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_history");

    const resolved = resolveOrError(commodity);
    if ("error" in resolved) return resolved.error;

    const asOfQuery = as_of ? `&as_of=${encodeURIComponent(as_of)}` : "";
    const response = await makeApiRequest<ApiResponse<HistoricalPriceData>>(
      `/v1/prices/past_${period}?by_code=${resolved.code}${asOfQuery}`,
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

server.registerTool(
  "opa_get_futures",
  {
    title: "Get Futures Price",
    description:
      "Get the latest front-month futures contract price for energy commodities. Use when the user asks about futures, forward prices, or contract prices. Supports crude oil (BZ/ice-brent = Brent, CL/ice-wti = WTI), ICE Gasoil (ice-gasoil), natural gas (natural-gas), European TTF gas (ttf-gas), LNG JKM (lng-jkm), EUA carbon (eua-carbon), and UK carbon (uk-carbon). For the full forward curve across all contract months, use opa_get_futures_curve instead. Requires the Professional plan ($99/mo) or higher.",
    inputSchema: {
      contract: z
        .enum(FUTURES_CONTRACTS)
        .default("BZ")
        .describe(
          "Futures contract code or slug: BZ/ice-brent = Brent crude, CL/ice-wti = WTI crude, ice-gasoil (G/QS) = ICE Gasoil, natural-gas (NG) = Natural Gas, ttf-gas (TTF) = European TTF natural gas, lng-jkm (JKM) = LNG JKM (Asia), eua-carbon (EUA) = EU carbon allowance, uk-carbon (UKA) = UK carbon allowance (default: BZ)",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ contract }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_futures");

    const slug = FUTURES_CONTRACT_SLUGS[contract];
    // Latest = GET /v1/futures/{slug} (no /latest, no ?contract= query param).
    const response = await makeApiRequest<FuturesLatestData>(
      `/v1/futures/${slug}`,
    );

    if (!response || !response.contracts?.length) {
      return errorResult(
        `No futures data available for ${FUTURES_CONTRACT_NAMES[contract]} (${contract}). Futures data requires a paid plan.`,
      );
    }

    const contractName = FUTURES_CONTRACT_NAMES[contract];
    const front = response.front_month ?? response.contracts[0];

    let text = `# ${contractName} Futures (${contract})\n\n`;
    text += `**Front Month (${front.contract_month})**: $${front.last_price.toFixed(2)}`;
    if (front.change_percent !== undefined && front.change_percent !== null) {
      text += ` (${front.change_percent >= 0 ? "+" : ""}${front.change_percent.toFixed(2)}%)`;
    }
    if (response.source) {
      text += `\n\n_Source: ${response.source}_`;
    }
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);

server.registerTool(
  "opa_get_futures_curve",
  {
    title: "Get Futures Curve",
    description:
      "Get the full futures forward curve showing prices across all contract months. Use when the user asks about the forward curve, contango/backwardation, or term structure. Supports crude oil (BZ/ice-brent = Brent, CL/ice-wti = WTI), ICE Gasoil (ice-gasoil), natural gas (natural-gas), European TTF gas (ttf-gas), LNG JKM (lng-jkm), EUA carbon (eua-carbon), and UK carbon (uk-carbon). Returns a table of contract months with settlement prices, plus market structure analysis. Requires the Professional plan ($99/mo) or higher.",
    inputSchema: {
      contract: z
        .enum(FUTURES_CONTRACTS)
        .default("BZ")
        .describe(
          "Futures contract code or slug: BZ/ice-brent = Brent crude, CL/ice-wti = WTI crude, ice-gasoil (G/QS) = ICE Gasoil, natural-gas (NG) = Natural Gas, ttf-gas (TTF) = European TTF natural gas, lng-jkm (JKM) = LNG JKM (Asia), eua-carbon (EUA) = EU carbon allowance, uk-carbon (UKA) = UK carbon allowance (default: BZ)",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ contract }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_futures_curve");

    const slug = FUTURES_CONTRACT_SLUGS[contract];
    // Curve = GET /v1/futures/{slug}/curve (no generic ?contract= route).
    const response = await makeApiRequest<FuturesCurveData>(
      `/v1/futures/${slug}/curve`,
    );

    if (!response || !response.contracts?.length) {
      return errorResult(
        `No futures curve data available for ${FUTURES_CONTRACT_NAMES[contract]} (${contract}). Futures data requires a paid plan.`,
      );
    }

    const contractName = FUTURES_CONTRACT_NAMES[contract];
    const contracts = response.contracts;

    let text = `# ${contractName} Futures Curve (${contract})\n\n`;
    text += `| Month | Settlement |\n|-------|------------|\n`;

    for (const c of contracts) {
      text += `| ${c.contract_month} | $${c.settlement_price.toFixed(2)} |\n`;
    }

    const front = contracts[0].settlement_price;
    const back = contracts[contracts.length - 1].settlement_price;
    // Prefer the API's own curve classification when present.
    const structure =
      response.curve_type ?? (front > back ? "backwardation" : "contango");
    text += `\n**Market Structure**: ${structure} (front $${front.toFixed(2)} vs back $${back.toFixed(2)})`;
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;

    return textResult(text);
  },
);


// ---------------------------------------------------------------------------
// US physical natural gas hubs (#64) — wraps /v1/natural-gas/hubs (api#1294).
// The API endpoint exists precisely because customers searched for hub codes
// (Waha, SoCal Citygate, Algonquin...) and 404'd; this tool closes the same
// discoverability gap on the MCP surface.
// ---------------------------------------------------------------------------

interface HubQuote {
  hub: string;
  name: string;
  code: string;
  region?: string;
  price: number | null;
  currency?: string;
  unit?: string;
  as_of?: string;
  history_since?: string;
  history_days?: number;
  basis_to_henry?: number | null;
  benchmark_price?: number | null;
  basis_history?: Array<Record<string, unknown>>;
}

interface HubsIndexData {
  benchmark: { code: string; name: string; price: number | null; as_of?: string };
  hubs: HubQuote[];
  meta?: Record<string, unknown>;
}

server.registerTool(
  "opa_get_natural_gas_hubs",
  {
    title: "Get US Natural Gas Hub Prices",
    description:
      "Get US physical natural gas hub prices as basis to Henry Hub (USD/MMBtu). Use when the user asks about regional gas prices or hub basis — Waha (West Texas/Permian), SoCal Citygate, Chicago Citygate, Algonquin Citygate, Eastern Gas South (formerly Dominion South), Houston Ship Channel. Without a hub, returns every live hub plus its basis; with a hub, returns that hub's latest price, basis, and basis history. Hub series differ in depth — check history_days before requesting a long window. Requires a paid plan (Developer, $19/mo, and up).",
    inputSchema: {
      hub: z
        .string()
        .optional()
        .describe(
          "Optional hub slug: waha, socal, chicago, algonquin, eastern-gas-south, houston-ship-channel. Omit to list all live hubs with their basis to Henry Hub.",
        ),
      past: z
        .string()
        .optional()
        .describe(
          "Optional basis-history window for a single hub, e.g. 30d, 6m, 1y (only used when hub is given).",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ hub, past }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_natural_gas_hubs");

    if (hub) {
      const query = past ? `?past=${encodeURIComponent(past)}` : "";
      const response = await makeApiRequest<ApiResponse<HubQuote>>(
        `/v1/natural-gas/hubs/${encodeURIComponent(hub.toLowerCase())}${query}`,
      );
      if (!response || response.status !== "success") {
        return errorResult(
          `No data for natural gas hub '${hub}'. Valid slugs: waha, socal, chicago, algonquin, eastern-gas-south, houston-ship-channel. Requires a paid plan (Developer $19/mo and up).`,
        );
      }
      const q = response.data;
      let text = `# ${q.name ?? hub} Natural Gas\n\n`;
      text += "```json\n" + JSON.stringify(q, null, 2) + "\n```\n";
      text +=
        "\n_basis_to_henry = hub price − Henry Hub price on the same gas day (USD/MMBtu) | Data from [OilPriceAPI](https://oilpriceapi.com)_";
      return textResult(text);
    }

    const response = await makeApiRequest<ApiResponse<HubsIndexData>>(
      "/v1/natural-gas/hubs",
    );
    if (!response || response.status !== "success") {
      return errorResult(
        "Natural gas hub data not available. Requires a paid plan (Developer $19/mo and up).",
      );
    }
    const { benchmark, hubs } = response.data;
    let text = "# US Natural Gas Hubs — Basis to Henry Hub\n\n";
    if (benchmark) {
      text += `Benchmark: **${benchmark.name}** ${benchmark.price != null ? `$${benchmark.price}` : "n/a"}${benchmark.as_of ? ` (as of ${benchmark.as_of})` : ""}\n\n`;
    }
    text += "| Hub | Price | Basis | History since |\n|---|---|---|---|\n";
    for (const h of hubs ?? []) {
      const price = h.price != null ? `$${h.price}` : "n/a";
      const basis =
        h.basis_to_henry != null
          ? `${h.basis_to_henry >= 0 ? "+" : ""}${h.basis_to_henry}`
          : "n/a";
      text += `| ${h.name} (${h.hub}) | ${price} | ${basis} | ${h.history_since ?? "?"} (${h.history_days ?? "?"}d) |\n`;
    }
    text +=
      "\n_USD/MMBtu; basis = hub − Henry Hub, same gas day. Hub histories differ in depth — check history_days. | Data from [OilPriceAPI](https://oilpriceapi.com)_";
    return textResult(text);
  },
);

server.registerTool(
  "opa_get_marine_fuels",
  {
    title: "Get Marine Fuel Prices",
    description:
      "Get latest marine fuel (bunker) prices across major shipping ports. Use when the user asks about bunker fuel, marine fuel, VLSFO, MGO, IFO380, or shipping fuel costs. Can filter by port (e.g., SINGAPORE, ROTTERDAM, HOUSTON) and/or fuel type (VLSFO, MGO, IFO380). Returns a table of port prices. Requires the Professional plan ($99/mo) or higher.",
    inputSchema: {
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
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ port, fuel_type }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_marine_fuels");

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

server.registerTool(
  "opa_get_rig_counts",
  {
    title: "Get US Rig Counts",
    description:
      "Get the latest US oil and gas rig count data (Baker Hughes). Use when the user asks about drilling activity, rig counts, or oil field operations. Returns oil rigs, gas rigs, total count, and week-over-week change. No parameters needed. Requires the Reservoir Mastery premium tier.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_rig_counts");

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

/**
 * Format the CURRENT live /v1/drilling/latest payload (#31). The old
 * formatter assumed a total_wells/active_rigs/region_breakdown shape the API
 * no longer serves, so every keyed call crashed on
 * `data.total_wells.toLocaleString()`. Exported for tests.
 */
export function formatDrillingData(data: DrillingData): string {
  let text = `# Drilling Activity Snapshot\n\n`;

  if (data.rig_counts && Object.keys(data.rig_counts).length > 0) {
    text += `## Rig Counts\n`;
    for (const [key, value] of Object.entries(data.rig_counts)) {
      const label = key
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/^Us /, "US ");
      text += `- **${label}**: ${value.toLocaleString()}\n`;
    }
    text += `\n`;
  }

  if (data.frac_spread_count !== undefined) {
    text += `- **Frac Spread Count**: ${data.frac_spread_count.toLocaleString()}\n`;
  }
  if (data.duc_wells_total !== undefined) {
    text += `- **DUC Wells (drilled, uncompleted)**: ${data.duc_wells_total.toLocaleString()}\n`;
  }

  const permits = data.well_permits;
  if (permits?.last_30d !== undefined) {
    text += `- **Well Permits (last 30 days)**: ${permits.last_30d.toLocaleString()}\n`;
  }
  if (permits?.by_state && Object.keys(permits.by_state).length > 0) {
    text += `\n## Permits by State (last 30 days)\n`;
    for (const [state, count] of Object.entries(permits.by_state)) {
      text += `- **${state}**: ${count.toLocaleString()}\n`;
    }
  }

  if (data.deltas && Object.keys(data.deltas).length > 0) {
    text += `\n## Week-over-Week Changes\n`;
    for (const [key, value] of Object.entries(data.deltas)) {
      const sign = value >= 0 ? "+" : "";
      text += `- **${key.replace(/_/g, " ")}**: ${sign}${value.toLocaleString()}\n`;
    }
  }

  if (data.last_updated) {
    text += `\n- **Last Updated**: ${data.last_updated}\n`;
  }

  text += `\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;
  return text;
}

server.registerTool(
  "opa_get_drilling",
  {
    title: "Get Drilling Activity",
    description:
      "Get a drilling activity snapshot: US, Canada, and international rig counts, frac spread count, well permits issued in the last 30 days (with a by-state breakdown), and DUC (drilled-uncompleted) well totals. Use when the user asks about drilling activity, rigs vs frac spreads, or upstream operations. Requires the Scale plan ($299/mo) or a drilling data plan.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_drilling");

    const response = await makeApiRequest<ApiResponse<DrillingData>>(
      "/v1/drilling/latest",
    );

    if (!response || response.status !== "success") {
      return errorResult(
        "Drilling activity data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    return textResult(formatDrillingData(response.data));
  },
);

// ---------------------------------------------------------------------------
// NEW TOOLS — Sprint 3
// ---------------------------------------------------------------------------

server.registerTool(
  "opa_get_diesel_by_state",
  {
    title: "Get Diesel Price by State",
    description:
      "Get the current average retail diesel price for a US state. Use when the user asks about diesel prices in a specific state, diesel fuel costs by state, or state-level fuel prices. Accepts state names ('California') or 2-letter codes ('CA'). Returns the AAA-sourced state average diesel price. Covers all 50 states plus DC.",
    inputSchema: {
      state: z
        .string()
        .describe(
          "US state name or 2-letter code (e.g., 'California', 'CA', 'Texas', 'TX')",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ state }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_diesel_by_state");

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

server.registerTool(
  "opa_get_fuel_surcharge",
  {
    title: "Get Fuel Surcharge",
    description:
      "Get carrier-published fuel surcharge percentages for LTL freight and parcel carriers. Use when the user asks about current or historical fuel surcharge rates for carriers like ODFL, Saia, Estes, XPO, ABF, TForce, Averitt, Southeastern Freight, UPS, FedEx, or DHL. Auto mode treats UPS/FedEx/DHL as parcel carriers and other carrier slugs as LTL. Parcel history requires a service_level such as ground, air, or international_air_export.",
    inputSchema: {
      carrier: z
        .string()
        .optional()
        .describe(
          "Optional carrier slug or common name. Examples: odfl, saia, estes, xpo, abf, tforce, averitt, southeastern-freight, ups, fedex, dhl. Omit to list current carriers.",
        ),
      mode: z
        .enum(FUEL_SURCHARGE_MODES)
        .default("auto")
        .describe(
          "Carrier mode: auto (UPS/FedEx/DHL route to parcel; others route to LTL), ltl, or parcel. Default: auto.",
        ),
      service_level: z
        .string()
        .optional()
        .describe(
          "Parcel service level such as ground, air, international_air_export, international_air_import, or international_ground. Optional for latest; required for parcel history.",
        ),
      history: z
        .boolean()
        .default(false)
        .describe(
          "When true, return historical surcharge rows instead of the latest rate. Parcel history requires service_level.",
        ),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(12)
        .describe("History rows to return, from 1 to 100. Default: 12."),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ carrier, mode, service_level, history, per_page }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_fuel_surcharge");

    const mapped = fuelSurchargeEndpoint({
      carrier,
      mode,
      service_level,
      history,
      per_page,
    });
    if ("error" in mapped) return errorResult(mapped.error);

    const response = await makeApiRequest<ApiResponse<FuelSurchargeData>>(
      mapped.endpoint,
    );

    if (!response || response.status !== "success") {
      const target = mapped.carrier
        ? `${mapped.resolvedMode} carrier '${mapped.carrier}'`
        : `${mapped.resolvedMode} carriers`;
      return errorResult(
        `Fuel surcharge data not available for ${target}. Use covered carrier slugs, and include service_level for parcel history. LTL carriers include odfl, saia, estes, xpo, abf, tforce, averitt, and southeastern-freight. Parcel carriers include ups, fedex, and dhl.`,
      );
    }

    return textResult(
      formatFuelSurchargeData(response.data, {
        mode: mapped.resolvedMode,
        history: Boolean(history),
      }),
    );
  },
);

server.registerTool(
  "opa_get_storage",
  {
    title: "Get Oil Storage Levels",
    description:
      "Get oil storage and inventory levels for Cushing, Oklahoma (WTI delivery hub) and/or the US Strategic Petroleum Reserve (SPR). Use when the user asks about oil inventories, storage levels, Cushing stocks, or the SPR. Returns current inventory levels with changes. Requires the Reservoir Mastery premium tier.",
    inputSchema: {
      facility: z
        .enum(["cushing", "spr", "all"])
        .default("all")
        .describe(
          "Storage facility: cushing (WTI delivery hub), spr (Strategic Petroleum Reserve), or all (default: all)",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ facility }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_storage");

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

server.registerTool(
  "opa_get_opec_production",
  {
    title: "Get OPEC Production",
    description:
      "Get the latest OPEC oil production data. Use when the user asks about OPEC output, production quotas, supply cuts, or OPEC+ compliance. Returns country-level production figures. Requires the Reservoir Mastery premium tier.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_opec_production");

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

server.registerTool(
  "opa_get_forecasts",
  {
    title: "Get Price Forecasts",
    description:
      "Get energy price forecasts from EIA Short-Term Energy Outlook (STEO) and other sources. Use when the user asks about price predictions, outlooks, or where oil/gas prices are heading. Returns forecast data for key commodities. Requires the Reservoir Mastery premium tier.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_forecasts");

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

server.registerTool(
  "opa_get_oil_inventories",
  {
    title: "Get EIA Oil Inventories",
    description:
      "Get the latest EIA weekly petroleum inventory (stocks) data. Use when the user asks about oil inventories, crude stocks, weekly EIA stocks, inventory builds/draws, or product-level inventory levels. Returns the latest weekly figures; optionally a summary view or a breakdown by petroleum product. Requires the Reservoir Mastery premium tier.",
    inputSchema: {
      view: z
        .enum(["latest", "summary", "by_product"])
        .default("latest")
        .describe(
          "Which view to return: latest (most recent weekly snapshot), summary (headline totals + week-over-week change), or by_product (breakdown per petroleum product). Default: latest.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ view }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_oil_inventories");

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

server.registerTool(
  "opa_get_well_permits",
  {
    title: "Get Well Permits",
    description:
      "Get the latest US oil & gas well drilling permit data. Use when the user asks about well permits, new drilling permits, permitting activity, or upstream permit trends. Returns the latest permits; optionally filtered/aggregated by state or by operator. Requires the well-permits add-on or an enterprise plan.",
    inputSchema: {
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
      operator: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Operator name for the by_operator view. For richer filters and explicit freshness metadata, use opa_search_well_permits.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ view, state, operator }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_well_permits");

    const pathByView: Record<string, string> = {
      latest: "/v1/ei/well-permits/latest",
      by_state: "/v1/ei/well-permits/by-state",
      by_operator: "/v1/ei/well-permits/by-operator",
    };

    let endpoint = pathByView[view];
    const query = new URLSearchParams();

    if (state) {
      const stateCode = resolveStateCode(state);
      if (!stateCode) {
        return errorResult(
          `'${state}' is not a recognized US state. Use a full state name (e.g., 'Texas') or 2-letter code (e.g., 'TX').`,
        );
      }
      if (view === "by_state") query.set("state", stateCode);
      else query.set("states", stateCode);
    }

    if (view === "by_operator") {
      if (!operator) {
        return errorResult(
          "The by_operator view requires an operator parameter. Use opa_search_well_permits for operator search with explicit state-health metadata.",
        );
      }
      query.set("operator", operator);
    }

    const queryString = query.toString();
    if (queryString) endpoint += `?${queryString}`;

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

export interface WellPermitSearchOptions {
  state: string;
  county?: string;
  operator?: string;
  start_date?: string;
  end_date?: string;
  page?: number;
  per_page?: number;
}

function validIsoDate(value: string | undefined): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

/**
 * Map a bounded permit search onto the existing core routes. Operator and
 * county are intentionally exclusive because the core exposes them through
 * separate query paths; silently dropping either filter would be misleading.
 */
export function wellPermitSearchEndpoint(
  options: WellPermitSearchOptions,
): { endpoint: string; stateCode: string } | { error: string } {
  const stateCode = resolveStateCode(options.state);
  if (!stateCode) {
    return {
      error:
        "state must be a recognized US state name or 2-letter code (for example, Texas or TX).",
    };
  }
  if (options.operator && options.county) {
    return {
      error:
        "operator and county cannot be combined yet because the core API exposes them on separate search routes. Run one search for each filter.",
    };
  }
  if (!validIsoDate(options.start_date) || !validIsoDate(options.end_date)) {
    return { error: "start_date and end_date must use YYYY-MM-DD." };
  }
  if (
    options.start_date &&
    options.end_date &&
    options.start_date > options.end_date
  ) {
    return { error: "start_date must be on or before end_date." };
  }

  const query = new URLSearchParams();
  query.set("states", stateCode);
  if (options.start_date) query.set("start_date", options.start_date);
  if (options.end_date) query.set("end_date", options.end_date);
  query.set("page", String(options.page ?? 1));
  query.set("per_page", String(options.per_page ?? 25));

  if (options.operator) {
    query.set("operator", options.operator);
    return {
      endpoint: `/v1/ei/well-permits/by-operator?${query.toString()}`,
      stateCode,
    };
  }
  if (options.county) query.set("county", options.county);
  return {
    endpoint: `/v1/ei/well-permits/search?${query.toString()}`,
    stateCode,
  };
}

interface WellPermitStateHealth {
  state_code?: string;
  status?: string;
  recommended_use?: string;
  record_count?: number;
  permit_date_coverage_pct?: number;
  latest_permit_date?: string | null;
  latest_fetched_at?: string | null;
  future_permit_date_count?: number;
  note?: string;
}

function permitHealthFromResponse(
  response: ApiResponse<Record<string, unknown>>,
): WellPermitStateHealth | null {
  const value = response.data?.state;
  return value && typeof value === "object"
    ? (value as WellPermitStateHealth)
    : null;
}

function formatPermitHealth(health: WellPermitStateHealth): string {
  return [
    `- Status: **${health.status ?? "unknown"}**`,
    `- Recommended use: ${health.recommended_use ?? "No recommendation supplied."}`,
    `- Records: ${health.record_count ?? "unknown"}`,
    `- Permit-date coverage: ${health.permit_date_coverage_pct ?? "unknown"}%`,
    `- Latest permit date: ${health.latest_permit_date ?? "unknown"}`,
    `- Latest fetched at: ${health.latest_fetched_at ?? "unknown"}`,
    `- Future-dated records: ${health.future_permit_date_count ?? "unknown"}`,
  ].join("\n");
}

server.registerTool(
  "opa_search_well_permits",
  {
    title: "Search Well Permits",
    description:
      "Search well permits in one US state by county or operator and optional permit-date range. The tool checks the core API's measured state-health gate first, fails closed for unavailable/attention states, and always returns freshness, date coverage, source provenance, and any staleness/degradation caveat with the records. Operator and county filters currently require separate searches.",
    inputSchema: {
      state: z
        .string()
        .describe("Required US state name or 2-letter code, e.g. Texas or TX."),
      county: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Optional county-name search. Cannot be combined with operator."),
      operator: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Optional operator-name search. Cannot be combined with county."),
      start_date: z
        .string()
        .optional()
        .describe("Optional inclusive permit-date lower bound (YYYY-MM-DD)."),
      end_date: z
        .string()
        .optional()
        .describe("Optional inclusive permit-date upper bound (YYYY-MM-DD)."),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(25),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async (options) => {
    if (!getApiKey()) return keylessTeaserResult("opa_search_well_permits");

    const mapped = wellPermitSearchEndpoint(options);
    if ("error" in mapped) return errorResult(mapped.error);

    const healthResponse = await makeApiRequest<
      ApiResponse<Record<string, unknown>>
    >(`/v1/ei/well-permits/states/${mapped.stateCode}`);
    if (!healthResponse || healthResponse.status !== "success") {
      return errorResult(
        `State health for ${mapped.stateCode} is unavailable, so the permit search was not run. This tool fails closed rather than returning records without a freshness gate.`,
      );
    }

    const health = permitHealthFromResponse(healthResponse);
    if (!health) {
      return errorResult(
        `State health for ${mapped.stateCode} was malformed, so the permit search was not run.`,
      );
    }
    if (health.status === "unavailable" || health.status === "attention") {
      return errorResult(
        `Permit search blocked by the ${mapped.stateCode} state-health gate (${health.status}). ${health.recommended_use ?? "Use the state-health endpoint for recovery guidance."}`,
      );
    }
    if (
      (options.start_date || options.end_date) &&
      typeof health.permit_date_coverage_pct === "number" &&
      health.permit_date_coverage_pct < 50
    ) {
      return errorResult(
        `Date-based permit search blocked for ${mapped.stateCode}: only ${health.permit_date_coverage_pct}% of records have a permit date. ${health.recommended_use ?? ""}`.trim(),
      );
    }

    const response = await makeApiRequest<
      ApiResponse<Record<string, unknown>>
    >(mapped.endpoint);
    if (!response || response.status !== "success") {
      return errorResult(
        `No safe well-permit search result is available for ${mapped.stateCode}. Check account entitlement and retry.`,
      );
    }

    return textResult(
      [
        `# Well Permit Search — ${mapped.stateCode}`,
        "",
        "## Measured state health",
        formatPermitHealth(health),
        "",
        health.status === "available"
          ? "_Health gate passed._"
          : `_Caveat: state status is ${health.status}; treat these records according to the recommendation above._`,
        "",
        "## Results",
        "```json",
        JSON.stringify(response.data, null, 2),
        "```",
        "",
        "_Data and state-health measurement from [OilPriceAPI](https://oilpriceapi.com)_",
      ].join("\n"),
    );
  },
);

export function wellLookupEndpoint(
  apiNumber: string,
  state?: string,
): { endpoint: string; normalizedApi: string } | { error: string } {
  const normalizedApi = apiNumber.replace(/\D/g, "");
  if (![10, 12, 14].includes(normalizedApi.length)) {
    return {
      error:
        "api_number must contain a valid 10-, 12-, or 14-digit API well number.",
    };
  }
  const query = new URLSearchParams();
  if (state) {
    const stateCode = resolveStateCode(state);
    if (!stateCode) {
      return { error: "state must be a recognized US state name or code." };
    }
    query.set("state", stateCode);
  }
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : "";
  return {
    endpoint: `/v1/well-lifecycle/wells/${normalizedApi}${suffix}`,
    normalizedApi,
  };
}

server.registerTool(
  "opa_lookup_well",
  {
    title: "Look Up Well by API Number",
    description:
      "Look up a well by 10-, 12-, or 14-digit API number using the core API's promoted lifecycle summaries. Returns operator, county, lifecycle dates, cumulative production and evidence; for a 14-digit API number it also includes exact monthly well-production history when available. Optional state disambiguates API numbers that occur across source contexts. Unpromoted or ambiguous records fail closed.",
    inputSchema: {
      api_number: z
        .string()
        .min(1)
        .describe("10-, 12-, or 14-digit API well number; punctuation is allowed."),
      state: z
        .string()
        .optional()
        .describe("Optional state name/code used to disambiguate source records."),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ api_number, state }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_lookup_well");

    const mapped = wellLookupEndpoint(api_number, state);
    if ("error" in mapped) return errorResult(mapped.error);

    const lifecycle = await makeApiRequest<
      ApiResponse<Record<string, unknown>>
    >(mapped.endpoint);
    if (
      !lifecycle ||
      lifecycle.status !== "success" ||
      !lifecycle.data ||
      typeof lifecycle.data !== "object"
    ) {
      return errorResult(
        `No promoted lifecycle summary is available for API number ${mapped.normalizedApi}. The record may be outside current coverage, unpromoted, or require a state/source disambiguator. Use opa_search_well_permits to discover verified records.`,
      );
    }

    let monthlyProduction: Record<string, unknown> | null = null;
    let productionNote =
      "Exact monthly well production was not requested because this is not a 14-digit API number.";
    if (mapped.normalizedApi.length === 14) {
      try {
        const production = await makeApiRequest<
          ApiResponse<Record<string, unknown>>
        >(`/v1/well-production/wells/${mapped.normalizedApi}`);
        if (
          production?.status === "success" &&
          production.data &&
          typeof production.data === "object"
        ) {
          monthlyProduction = production.data;
          productionNote =
            "Exact monthly well-level production is included below.";
        } else {
          productionNote =
            "No exact monthly well-level production history is currently available; the promoted lifecycle production evidence remains authoritative for this response.";
        }
      } catch (error) {
        if (!(error instanceof ApiGateError)) throw error;
        productionNote = `Monthly well production is separately plan-gated (HTTP ${error.status}); lifecycle evidence is included.`;
      }
    }

    return textResult(
      [
        `# Well Lookup — API ${mapped.normalizedApi}`,
        "",
        productionNote,
        "",
        "```json",
        JSON.stringify(
          {
            lifecycle: lifecycle.data,
            monthly_production: monthlyProduction,
          },
          null,
          2,
        ),
        "```",
        "",
        "_Only promoted lifecycle summaries are returned. Data from [OilPriceAPI](https://oilpriceapi.com)._",
      ].join("\n"),
    );
  },
);

server.registerTool(
  "opa_get_well_activity",
  {
    title: "Get Recent Well Activity",
    description:
      "Get recent US well-permit activity including counts by state, top operators and formations, permit types, and weekly trend. The response also includes every non-available state-health record so stale, degraded, unavailable, or attention states are explicit; rankings must not be treated as complete national coverage when warnings exist.",
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe("Recent activity window in days (1-365)."),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ days }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_well_activity");

    const [activity, healthResponse] = await Promise.all([
      makeApiRequest<ApiResponse<Record<string, unknown>>>(
        `/v1/ei/well-permits/summary?days=${days}`,
      ),
      makeApiRequest<ApiResponse<Record<string, unknown>>>(
        "/v1/ei/well-permits/states",
      ),
    ]);
    if (
      !activity ||
      activity.status !== "success" ||
      !activity.data ||
      typeof activity.data !== "object" ||
      !healthResponse ||
      healthResponse.status !== "success" ||
      !healthResponse.data ||
      typeof healthResponse.data !== "object"
    ) {
      return errorResult(
        "Recent well activity is unavailable because either the activity summary or its state-health gate could not be loaded.",
      );
    }

    const states =
      healthResponse.data?.states &&
      typeof healthResponse.data.states === "object"
        ? (healthResponse.data.states as Record<
            string,
            WellPermitStateHealth
          >)
        : {};
    const warnings = Object.values(states).filter(
      (stateHealth) => stateHealth.status !== "available",
    );

    return textResult(
      [
        `# Recent US Well Activity — ${days} days`,
        "",
        warnings.length === 0
          ? "_All reported state-health gates are currently available._"
          : `_Coverage warning: ${warnings.length} state(s) are stale, degraded, unavailable, or need attention. Rankings below are directional, not a complete national league table._`,
        "",
        "```json",
        JSON.stringify(
          {
            activity: activity.data,
            state_health_warnings: warnings,
            state_health_as_of: healthResponse.data.meta,
          },
          null,
          2,
        ),
        "```",
        "",
        "_Data and health gates from [OilPriceAPI](https://oilpriceapi.com)._",
      ].join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------
// Well production (#31) — /v1/well-production*
//
// BETA COVERAGE: monthly state-level production (EIA + selected state
// regulators) plus well-level histories for selected states only. This is
// NOT complete US well-level production — descriptions and output say so.
// ---------------------------------------------------------------------------

export const WELL_PRODUCTION_VIEWS = [
  "summary",
  "states",
  "state",
  "well",
  "top_producers",
  "cycle_time",
  "cohorts",
] as const;

export type WellProductionView = (typeof WELL_PRODUCTION_VIEWS)[number];

export const WELL_PRODUCTION_BETA_NOTE =
  "_Beta coverage: monthly state-level production (EIA + selected state regulators) and well-level histories for selected states only — NOT complete US well-level production. Data from [OilPriceAPI](https://oilpriceapi.com)_";

interface WellProductionMonth {
  period?: string;
  oil_bbl?: number | null;
  oil_bpd?: number | null;
  gas_mcf?: number | null;
  water_bbl?: number | null;
  boe?: number | null;
  days_producing?: number | null;
  source?: string;
  state?: string;
}

interface WellProductionSummaryData {
  national?: WellProductionMonth;
  top_states?: WellProductionMonth[];
}

interface WellProductionStatesData {
  period?: string;
  count?: number;
  states?: WellProductionMonth[];
}

interface WellProductionSeriesData {
  state?: string;
  api_number?: string;
  operator?: string;
  well_name?: string;
  period?: { start?: string; end?: string };
  count?: number;
  data?: WellProductionMonth[];
}

interface WellProductionTopProducersData {
  state?: string;
  period?: { start?: string; end?: string };
  count?: number;
  producers?: Array<{
    api_number?: string;
    operator?: string;
    well_name?: string;
    total_oil_bbl?: number;
    total_gas_mcf?: number;
    months_producing?: number;
  }>;
}

/**
 * Map a well-production view + options to the API endpoint (#31).
 * Returns { endpoint } or { error } with an actionable message.
 * Exported for tests.
 */
export function wellProductionEndpoint(
  view: WellProductionView,
  opts: { state?: string; api_number?: string } = {},
): { endpoint: string } | { error: string } {
  const resolveState = (): { code: string } | { error: string } => {
    const code = resolveStateCode(opts.state!);
    if (!code) {
      return {
        error: `'${opts.state}' is not a recognized US state. Use a full state name (e.g., 'Texas') or 2-letter code (e.g., 'TX').`,
      };
    }
    return { code };
  };

  switch (view) {
    case "summary":
      return { endpoint: "/v1/well-production" };
    case "states":
      return { endpoint: "/v1/well-production/states" };
    case "state": {
      if (!opts.state) {
        return {
          error:
            "The 'state' view requires a state parameter (e.g., state: 'TX').",
        };
      }
      const resolved = resolveState();
      if ("error" in resolved) return resolved;
      return { endpoint: `/v1/well-production/states/${resolved.code}` };
    }
    case "well": {
      const api = (opts.api_number ?? "").replace(/[^0-9]/g, "");
      if (api.length !== 14) {
        return {
          error:
            "The 'well' view requires a 14-digit API well number (api_number), e.g. '42329447130000'. Use the top_producers or cycle_time views to discover API numbers.",
        };
      }
      return { endpoint: `/v1/well-production/wells/${api}` };
    }
    case "top_producers":
    case "cycle_time": {
      const base =
        view === "top_producers"
          ? "/v1/well-production/top-producers"
          : "/v1/well-production/cycle-time";
      if (opts.state) {
        const resolved = resolveState();
        if ("error" in resolved) return resolved;
        return { endpoint: `${base}?state=${resolved.code}` };
      }
      return { endpoint: base };
    }
    case "cohorts":
      return { endpoint: "/v1/well-production/cycle-time/cohorts" };
  }
}

function formatProductionMonthLine(m: WellProductionMonth): string {
  const parts: string[] = [];
  if (typeof m.oil_bbl === "number")
    parts.push(`oil ${m.oil_bbl.toLocaleString()} bbl`);
  if (typeof m.oil_bpd === "number")
    parts.push(`(${m.oil_bpd.toLocaleString()} b/d)`);
  if (typeof m.gas_mcf === "number")
    parts.push(`gas ${m.gas_mcf.toLocaleString()} mcf`);
  if (typeof m.water_bbl === "number")
    parts.push(`water ${m.water_bbl.toLocaleString()} bbl`);
  if (typeof m.boe === "number") parts.push(`${m.boe.toLocaleString()} boe`);
  if (typeof m.days_producing === "number")
    parts.push(`${m.days_producing} days`);
  if (m.source) parts.push(`[${m.source}]`);
  return parts.join(" · ") || "(no data)";
}

/**
 * Format a well-production API payload for the given view (#31).
 * Always ends with the beta coverage note. Exported for tests.
 */
export function formatWellProduction(
  view: WellProductionView,
  data: Record<string, unknown>,
): string {
  let text = `# US Well Production (${view})\n\n`;

  if (view === "summary") {
    const d = data as WellProductionSummaryData;
    if (d.national) {
      const n = d.national;
      const reported =
        (typeof n.oil_bbl === "number" && n.oil_bbl > 0) ||
        (typeof n.gas_mcf === "number" && n.gas_mcf > 0);
      text += `## National (${n.period ?? "latest"})\n`;
      text += reported
        ? `- ${formatProductionMonthLine(n)}\n`
        : `- Not yet reported for ${n.period ?? "the current period"} (national figures lag; see top states below).\n`;
      text += `\n`;
    }
    if (d.top_states?.length) {
      text += `## Top Producing States\n`;
      for (const s of d.top_states) {
        text += `- **${s.state}** (${s.period}): ${formatProductionMonthLine(s)}\n`;
      }
    }
  } else if (view === "states") {
    const d = data as WellProductionStatesData;
    text += `Period ${d.period ?? "latest"} — ${d.count ?? d.states?.length ?? 0} states reporting.\n\n`;
    for (const s of d.states ?? []) {
      text += `- **${s.state}**: ${formatProductionMonthLine(s)}\n`;
    }
  } else if (view === "state" || view === "well") {
    const d = data as WellProductionSeriesData;
    if (view === "well") {
      text += `**Well**: ${d.well_name ?? "n/a"} · **Operator**: ${d.operator ?? "n/a"} · **API #**: ${d.api_number ?? "n/a"} · **State**: ${d.state ?? "n/a"}\n\n`;
    } else {
      text += `**State**: ${d.state ?? "n/a"}`;
      if (d.period?.start || d.period?.end) {
        text += ` · **Window**: ${d.period?.start ?? "?"} → ${d.period?.end ?? "?"}`;
      }
      text += `\n\n`;
    }
    text += `## Monthly Production (${d.count ?? d.data?.length ?? 0} months)\n`;
    for (const m of d.data ?? []) {
      text += `- **${m.period}**: ${formatProductionMonthLine(m)}\n`;
    }
  } else if (view === "top_producers") {
    const d = data as WellProductionTopProducersData;
    if (d.state) text += `**State**: ${d.state}\n`;
    if (d.period?.start || d.period?.end) {
      text += `**Window**: ${d.period?.start ?? "?"} → ${d.period?.end ?? "?"}\n`;
    }
    text += `\n## Top Producers (${d.count ?? d.producers?.length ?? 0})\n`;
    for (const p of d.producers ?? []) {
      const parts: string[] = [];
      if (typeof p.total_oil_bbl === "number")
        parts.push(`oil ${p.total_oil_bbl.toLocaleString()} bbl`);
      if (typeof p.total_gas_mcf === "number")
        parts.push(`gas ${p.total_gas_mcf.toLocaleString()} mcf`);
      if (typeof p.months_producing === "number")
        parts.push(`${p.months_producing} months`);
      text += `- **${p.well_name ?? p.api_number}** — ${p.operator ?? "unknown operator"} (API ${p.api_number}): ${parts.join(" · ")}\n`;
    }
  } else {
    // cycle_time / cohorts — nested stats objects; render as JSON.
    text += "```json\n" + JSON.stringify(data, null, 2) + "\n```\n";
  }

  text += `\n${WELL_PRODUCTION_BETA_NOTE}`;
  return text;
}

server.registerTool(
  "opa_get_well_production",
  {
    title: "Get Well Production",
    description:
      "Get US oil & gas well production data (BETA coverage: monthly state-level production from EIA + selected state regulators, and well-level histories for selected states only — NOT complete US well-level production). Views: summary (national + top states), states (all reporting states, latest month), state (monthly history for one state), well (monthly history for one well by 14-digit API number), top_producers (highest-output wells, optionally by state), cycle_time (permit-to-production cycle time stats, optionally by state), cohorts (cycle times by spud quarter). Use when the user asks about oil/gas production volumes by state or well, top producing wells, or drill-to-production cycle times. Requires the well-permits add-on or an enterprise plan.",
    inputSchema: {
      view: z
        .enum(WELL_PRODUCTION_VIEWS)
        .default("summary")
        .describe(
          "Which view to return: summary (national + top states), states (all reporting states), state (one state's monthly history — requires 'state'), well (one well's monthly history — requires 'api_number'), top_producers, cycle_time, or cohorts. Default: summary.",
        ),
      state: z
        .string()
        .optional()
        .describe(
          "US state name or 2-letter code (e.g., 'Texas', 'TX'). Required for the state view; optional filter for top_producers and cycle_time.",
        ),
      api_number: z
        .string()
        .optional()
        .describe(
          "14-digit API well number (e.g., '42329447130000'). Required for the well view.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ view, state, api_number }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_well_production");

    const mapped = wellProductionEndpoint(view, { state, api_number });
    if ("error" in mapped) return errorResult(mapped.error);

    const response = await makeApiRequest<ApiResponse<Record<string, unknown>>>(
      mapped.endpoint,
    );

    if (!response || response.status !== "success") {
      if (view === "state") {
        return errorResult(
          `No well production data available for '${state}'. Beta coverage is limited to states reporting via EIA or selected state regulators — try the states view to see which states currently report. This also requires a paid plan with energy intelligence access.`,
        );
      }
      if (view === "well") {
        return errorResult(
          `No production history found for API number '${api_number}'. Well-level coverage is beta and limited to selected states — the number may be valid but outside current coverage. This also requires a paid plan with energy intelligence access.`,
        );
      }
      return errorResult(
        "Well production data not available. This requires a paid plan with energy intelligence access.",
      );
    }

    return textResult(formatWellProduction(view, response.data));
  },
);

server.registerTool(
  "opa_get_spread",
  {
    title: "Get Refining & Trading Spreads",
    description:
      "Get refining and trading spreads: crack spreads (refining margin proxy), basis spreads (regional price differentials), and blending/transport margins. Use when the user asks about crack spreads, 3-2-1 crack, refining margins, basis differentials, or blend/transport margins. Requires the Professional plan ($99/mo) or higher.",
    inputSchema: {
      type: z
        .enum(["crack", "basis", "margin"])
        .describe(
          "Spread type: crack (refining crack spread, e.g. 3-2-1), basis (regional/grade price differential), or margin (blending/transport margin).",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ type }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_spread");

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
// API key. The alert engine evaluates eligible source updates against the
// user's conditions and notifies them when conditions are met.
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


// ---------------------------------------------------------------------------
// Agent self-service (#63 follow-through): let an agent answer "what plan am I
// on, what is left, and what would an upgrade cost" WITHOUT probing gated
// tools. Status reads the authenticated /v1/dashboard; plans reads the public
// /v1/pricing (live source of truth — prices are never hardcoded here).
// ---------------------------------------------------------------------------

interface DashboardUsage {
  current_month?: {
    used?: number;
    limit?: number;
    effective_limit?: number;
    remaining?: number;
    percentage_used?: number;
    reset_at?: string;
    usage_window?: string;
  };
  subscription_tier?: string;
}

interface DashboardData {
  usage?: DashboardUsage;
  user?: { email?: string; created_at?: string };
  feature_access?: Record<string, unknown> | null;
}

server.registerTool(
  "opa_get_account_status",
  {
    title: "Get Account Status",
    description:
      "Get the current API account's plan tier, request usage, remaining quota, and reset date. Use before calling gated tools, when the user asks about their plan/limits/usage, or after any 402/403/429 to explain what the current plan covers. Works on every plan including free.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_account_status");

    const response =
      await makeApiRequest<ApiResponse<DashboardData>>("/v1/dashboard");
    if (!response || response.status !== "success") {
      return errorResult(
        "Could not read account status. If this persists, verify the OILPRICEAPI_KEY is valid.",
      );
    }
    const usage = response.data.usage ?? {};
    const month = usage.current_month ?? {};
    const tier = usage.subscription_tier ?? "free";
    let text = "# OilPriceAPI Account Status\n\n";
    text += `- **Plan tier:** ${tier}\n`;
    if (month.limit != null) {
      text += `- **Requests this period:** ${month.used ?? 0} of ${month.effective_limit ?? month.limit} (${month.percentage_used ?? 0}% used, ${month.remaining ?? "?"} remaining)\n`;
    }
    if (month.reset_at) text += `- **Quota resets:** ${month.reset_at}\n`;
    text +=
      "\nTo see what higher plans include, call opa_get_plans. Gated tools state their required plan in their descriptions.";
    return textResult(text);
  },
);

interface PricingPlan {
  id?: string;
  name?: string;
  monthlyPrice?: number;
  yearlyPrice?: number;
  requestLimit?: number;
  features?: string[];
  popular?: boolean;
}

server.registerTool(
  "opa_get_plans",
  {
    title: "Get Plans & Pricing",
    description:
      "Get OilPriceAPI's current subscription plans: monthly/yearly price, request limits, and included features for each tier. Use when the user asks what an upgrade costs, which plan unlocks a gated tool (history, futures, natural gas hubs...), or how the tiers compare. Live pricing from the API — no key required.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    const response = await makeApiRequest<
      ApiResponse<{ plans?: PricingPlan[] }>
    >("/v1/pricing");
    const plans = response?.data?.plans;
    if (!response || response.status !== "success" || !plans?.length) {
      return errorResult(
        `Could not load live plan data. Current plans are listed at ${UPGRADE_URL}`,
      );
    }
    let text = "# OilPriceAPI Plans\n\n";
    text += "| Plan | Monthly | Yearly | Requests/mo | Key features |\n";
    text += "|---|---|---|---|---|\n";
    for (const p of plans) {
      const feats = (p.features ?? []).slice(0, 4).join("; ");
      text += `| ${p.name}${p.popular ? " ★" : ""} | $${p.monthlyPrice} | $${p.yearlyPrice} | ${p.requestLimit?.toLocaleString?.() ?? p.requestLimit} | ${feats} |\n`;
    }
    const productFacts = await productFactsProvider.get();
    const freeLimit = productFacts.facts.offer.freeRequestLimit;
    const freeWindow = productFacts.facts.offer.freeRequestWindow;
    text += `\nFree tier: ${freeLimit.toLocaleString()} requests/${freeWindow}, latest prices only.\n`;
    text += `\nTo subscribe or upgrade, open: ${UPGRADE_URL} (checkout takes ~1 minute). Check the current plan with opa_get_account_status.`;
    return textResult(text);
  },
);


// ---------------------------------------------------------------------------
// Data-quality reports — wraps /v1/data-quality/{summary,reports/:code}.
// Provenance surface: per-series grades and dimension scores, so an agent can
// answer "how reliable is the series I am about to depend on" from the API
// itself. Catalogue summary is available on any key; per-commodity reports are
// paid (require_paid_subscription in data_quality_reports_controller).
// ---------------------------------------------------------------------------

server.registerTool(
  "opa_get_data_quality",
  {
    title: "Get Data Quality Report",
    description:
      "Get OilPriceAPI's own data-quality grades. With a commodity code: that series' quality report — overall grade/score plus dimension scores (completeness, freshness, and more) for the current period. Without a code: the catalogue-wide summary (grade distribution by category). Use when the user asks how reliable/complete a series is, or which series carry the highest quality grades. Per-commodity reports require a paid plan (Developer, $19/mo, and up); the summary works on any key.",
    inputSchema: {
      commodity: z
        .string()
        .optional()
        .describe(
          "Optional commodity name or code (e.g., 'brent', 'NATURAL_GAS_USD') for a per-series report. Omit for the catalogue-wide summary.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ commodity }) => {
    if (!getApiKey()) return keylessTeaserResult("opa_get_data_quality");

    if (commodity) {
      const resolved = resolveOrError(commodity);
      if ("error" in resolved) return resolved.error;
      const response = await makeApiRequest<
        ApiResponse<{ report?: Record<string, unknown> }>
      >(`/v1/data-quality/reports/${encodeURIComponent(resolved.code)}`);
      if (!response || response.status !== "success" || !response.data.report) {
        return errorResult(
          `No data-quality report for '${commodity}' (code: ${resolved.code}). Per-commodity reports require a paid plan (Developer $19/mo and up).`,
        );
      }
      let text = `# Data Quality — ${resolved.code}\n\n`;
      text += "```json\n" + JSON.stringify(response.data.report, null, 2) + "\n```\n";
      text +=
        "\n_Grades are computed per period from measured completeness/freshness — not marketing copy. | [OilPriceAPI](https://oilpriceapi.com)_";
      return textResult(text);
    }

    const response = await makeApiRequest<
      ApiResponse<{ summary?: Record<string, unknown> }>
    >("/v1/data-quality/summary");
    if (!response || response.status !== "success" || !response.data.summary) {
      return errorResult("Data-quality summary not available right now.");
    }
    let text = "# OilPriceAPI Data Quality — Catalogue Summary\n\n";
    text += "```json\n" + JSON.stringify(response.data.summary, null, 2) + "\n```\n";
    text +=
      "\n_Per-commodity reports: call this tool with a commodity code (paid plans). | [OilPriceAPI](https://oilpriceapi.com)_";
    return textResult(text);
  },
);

server.registerTool(
  "opa_create_price_alert",
  {
    title: "Create Price Alert",
    description:
      "Create a PERSISTENT price alert tied to the user's OilPriceAPI account. " +
      "The alert engine evaluates eligible source updates and notifies the user (by " +
      "email, plus webhook if a URL is given) when the commodity price crosses the " +
      "threshold. Use when the user asks to be alerted/notified when a price goes " +
      "above or below a level (e.g. 'tell me when Brent drops below $70'). " +
      "REQUIRES an API key (OILPRICEAPI_KEY) — this writes to the user's account. " +
      "Alerts persist until deleted; manage them with opa_list_price_alerts and " +
      "opa_delete_price_alert.",
    inputSchema: {
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
    annotations: CREATE_TOOL_ANNOTATIONS,
  },
  async ({ commodity, operator, threshold, name, notify }) => {
    const keyErr = requireApiKey("opa_create_price_alert");
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

server.registerTool(
  "opa_list_price_alerts",
  {
    title: "List Price Alerts",
    description:
      "List all PERSISTENT price alerts on the user's OilPriceAPI account. Use when " +
      "the user asks what alerts they have set up, or to find an alert's id before " +
      "deleting it. REQUIRES an API key (OILPRICEAPI_KEY) — alerts are account-scoped. " +
      "No parameters needed.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    const keyErr = requireApiKey("opa_list_price_alerts");
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

server.registerTool(
  "opa_delete_price_alert",
  {
    title: "Delete Price Alert",
    description:
      "Permanently delete a price alert from the user's OilPriceAPI account by id. " +
      "Use when the user wants to remove/cancel/stop an existing alert. Get the id " +
      "from opa_list_price_alerts first. This permanently removes the alert from the " +
      "user's account. REQUIRES an API key (OILPRICEAPI_KEY).",
    inputSchema: {
      id: z
        .string()
        .describe(
          "The id of the alert to delete (a UUID, as returned by opa_list_price_alerts or opa_create_price_alert).",
        ),
    },
    annotations: DELETE_TOOL_ANNOTATIONS,
  },
  async ({ id }) => {
    const keyErr = requireApiKey("opa_delete_price_alert");
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

server.registerTool(
  "opa_get_alert_triggers",
  {
    title: "Get Alert Triggers",
    description:
      "Get recent trigger activity for the user's price alerts — which alerts have " +
      "fired, how many times, and when they last triggered. Use when the user asks " +
      "whether any alerts have gone off or about recent alert activity. REQUIRES an " +
      "API key (OILPRICEAPI_KEY). Note: the API tracks trigger history as per-alert " +
      "counters (trigger_count / last_triggered_at) rather than a separate event " +
      "feed, so this returns alerts that have triggered.",
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe(
          "Optional ISO 8601 date/time (e.g., '2026-06-01' or '2026-06-01T00:00:00Z'). Only alerts last triggered on or after this time are shown.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ since }) => {
    const keyErr = requireApiKey("opa_get_alert_triggers");
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
// AGENT SUBSCRIPTION + MARKET BRIEF TOOLS (#3245 Phase 2)
//
// These activate the agent loop: a multi-commodity market brief plus
// PERSISTENT, recurring "watches" (subscriptions) that the API snapshots every
// interval. Agents POLL for new events via a per-user cursor — there is NO
// always-on connection; nothing is pushed to the agent.
//
//   - opa_get_market_brief         GET    /v1/market-brief
//   - opa_create_price_subscription POST  /v1/subscriptions
//   - opa_list_subscriptions       GET    /v1/subscriptions
//   - opa_delete_subscription      DELETE /v1/subscriptions/:id
//   - opa_get_subscription_events  GET    /v1/subscriptions/events?since=<seq>
//
// Subscriptions are account-scoped and REQUIRE an API key. Per-tier limits
// (max active watches, interval floor, codes per watch) are enforced
// server-side; the API returns a 422 with the exact limit/minimum, which we
// surface verbatim.
// =========================================================================

interface BriefCommodity {
  code?: string;
  name?: string;
  price?: number;
  currency?: string;
  unit?: string;
  change_24h_pct?: number | null;
  change_24h_abs?: number | null;
  as_of?: string;
  stale?: boolean;
  forecast_1m?: {
    point?: number;
    low?: number;
    high?: number;
    confidence?: number;
  };
}

interface BriefData {
  as_of?: string;
  codes?: string[];
  commodities?: BriefCommodity[];
  spreads?: Array<{
    pair?: string;
    label?: string;
    value?: number;
    currency?: string;
  }>;
  summary?: string;
  context?: {
    disruptions?: Array<{ title?: string; severity?: string; region?: string }>;
    top_indicators?: Array<{
      code?: string;
      value?: number;
      change_pct?: number | null;
    }>;
  };
}

interface WatchRecord {
  id?: string;
  name?: string | null;
  codes?: string[];
  interval_seconds?: number;
  status?: string;
  deliver_webhook?: boolean;
  source?: string;
  tool_name?: string | null;
  last_evaluated_at?: string | null;
  next_run_at?: string | null;
  created_at?: string | null;
}

function describeInterval(seconds?: number): string {
  if (!seconds || seconds <= 0) return "n/a";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function formatWatchLine(w: WatchRecord): string {
  const codes = Array.isArray(w.codes) ? w.codes.join(", ") : "—";
  const every = describeInterval(w.interval_seconds);
  const status = w.status || "active";
  return (
    `- **${w.name || codes}** (id: \`${w.id}\`) — ${codes}, every ${every}, ${status}` +
    (w.next_run_at ? `, next run ${w.next_run_at}` : "")
  );
}

server.registerTool(
  "opa_get_market_brief",
  {
    title: "Multi-Commodity Market Brief",
    description:
      "Get a multi-commodity market brief: latest spot prices, 24h changes, " +
      "1-month forecasts (for Brent/WTI/Natural Gas), and notable spreads — for " +
      "several commodities in ONE call. Use when the user wants a market snapshot, " +
      "morning brief, or an at-a-glance read across multiple commodities. Set " +
      "`narrative: true` to also get a plain-English summary plus market context " +
      "(active supply disruptions, key economic indicators). Accepts natural " +
      "language ('brent', 'us gas') or API codes. REQUIRES an API key " +
      "(OILPRICEAPI_KEY); counts as 1 request. Per-tier code limits apply (free: 3 " +
      "codes). For a single price use opa_get_price; for ongoing recurring " +
      "monitoring use opa_create_price_subscription.",
    inputSchema: {
      codes: z
        .array(z.string())
        .min(1)
        .describe(
          "Commodity names or codes to include (e.g., ['brent', 'wti'] or " +
            "['BRENT_CRUDE_USD', 'NATURAL_GAS_USD']). Free tier allows up to 3.",
        ),
      narrative: z
        .boolean()
        .optional()
        .describe(
          "If true, also include a plain-English summary + market context " +
            "(disruptions, indicators). Default: false (structured data only).",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ codes, narrative }) => {
    const keyErr = requireApiKey("opa_get_market_brief");
    if (keyErr) return keyErr;

    const resolvedCodes: string[] = [];
    const unresolved: string[] = [];
    for (const c of codes) {
      const r = resolveCommodityCode(c);
      if (r) resolvedCodes.push(r);
      else unresolved.push(c);
    }

    if (resolvedCodes.length === 0) {
      return errorResult(
        `None of the requested commodities were recognized: ${unresolved.join(", ")}. ` +
          "Use opa_list_commodities to see valid codes.",
      );
    }

    const params = new URLSearchParams();
    params.set("codes", resolvedCodes.join(","));
    if (narrative) params.set("narrative", "true");

    const result = await makeAuthRequest(
      `/v1/market-brief?${params.toString()}`,
    );
    if (!result.ok) {
      return errorResult(alertHttpError(result, "get the market brief"));
    }

    const envelope = result.body as ApiResponse<BriefData> | null;
    const data = envelope?.data;
    if (!data || !Array.isArray(data.commodities)) {
      return errorResult(
        "The market brief returned no data. Try again in a moment.",
      );
    }

    const sections = ["# Market Brief\n"];
    if (data.as_of) sections.push(`_As of ${data.as_of}_\n`);

    for (const c of data.commodities) {
      const sym =
        c.currency === "EUR"
          ? "€"
          : c.currency === "GBP" || c.currency === "GBp"
            ? "£"
            : "$";
      const price =
        typeof c.price === "number" ? `${sym}${c.price.toFixed(2)}` : "n/a";
      let line = `- **${c.name || c.code}**: ${price}`;
      if (typeof c.change_24h_pct === "number") {
        const sign = c.change_24h_pct >= 0 ? "+" : "";
        line += ` (${sign}${c.change_24h_pct.toFixed(2)}% 24h)`;
      }
      if (c.stale) line += " ⚠️ stale";
      if (c.forecast_1m && typeof c.forecast_1m.point === "number") {
        line += ` — 1m forecast ~${sym}${c.forecast_1m.point.toFixed(2)}`;
      }
      sections.push(line);
    }

    if (Array.isArray(data.spreads) && data.spreads.length > 0) {
      sections.push("\n## Spreads");
      for (const s of data.spreads) {
        const sym =
          s.currency === "EUR" ? "€" : s.currency === "GBP" ? "£" : "$";
        sections.push(
          `- **${s.label || s.pair}**: ${sym}${typeof s.value === "number" ? s.value.toFixed(2) : "n/a"}`,
        );
      }
    }

    if (data.summary) {
      sections.push(`\n## Summary\n${data.summary}`);
    }

    if (data.context) {
      const disruptions = data.context.disruptions ?? [];
      if (disruptions.length > 0) {
        sections.push("\n## Active Disruptions");
        for (const d of disruptions) {
          sections.push(
            `- ${d.title}${d.severity ? ` (${d.severity})` : ""}${d.region ? ` — ${d.region}` : ""}`,
          );
        }
      }
    }

    if (unresolved.length > 0) {
      sections.push(
        `\n_Note: skipped unrecognized commodities: ${unresolved.join(", ")}._`,
      );
    }

    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);
    return textResult(sections.join("\n"));
  },
);

server.registerTool(
  "opa_create_price_subscription",
  {
    title: "Create Price Subscription",
    description:
      "Create a PERSISTENT, recurring price subscription (a 'watch') tied to the " +
      "user's OilPriceAPI account. The API snapshots the watched commodities every " +
      "`interval` and records an event each time — so the agent can come back later " +
      "and poll for what changed via opa_get_subscription_events. Use when the user " +
      "wants ONGOING monitoring of one or more commodities (e.g. 'keep watching " +
      "Brent and WTI every hour'). This is different from a price alert: a watch " +
      "ALWAYS emits an event every interval (a running log), whereas an alert only " +
      "fires when a threshold is crossed. REQUIRES an API key (OILPRICEAPI_KEY) — " +
      "this writes to the user's account. Events are POLLED, not pushed: there is " +
      "no always-on connection. Manage watches with opa_list_subscriptions and " +
      "opa_delete_subscription. Per-tier limits apply (free: 1 watch, 3 codes, 1h " +
      "minimum interval); the API returns the exact limit if exceeded.",
    inputSchema: {
      codes: z
        .array(z.string())
        .min(1)
        .describe(
          "Commodity names or codes to watch (e.g., ['brent', 'wti'] or " +
            "['BRENT_CRUDE_USD']). Free tier allows up to 3 codes per watch.",
        ),
      interval: z
        .string()
        .describe(
          "How often to snapshot: a friendly interval like '5m', '1h', '6h', " +
            "'daily', or a bare number of seconds ('3600'). The minimum allowed " +
            "interval depends on the plan (free: 1h). If below the floor the API " +
            "returns the exact minimum.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Optional human-readable label for the watch (e.g., 'Crude desk hourly').",
        ),
    },
    annotations: CREATE_TOOL_ANNOTATIONS,
  },
  async ({ codes, interval, name }) => {
    const keyErr = requireApiKey("opa_create_price_subscription");
    if (keyErr) return keyErr;

    const intervalSeconds = resolveIntervalSeconds(interval);
    if (intervalSeconds === null) {
      return errorResult(
        `'${interval}' is not a valid interval. Use a friendly value like '5m', ` +
          "'1h', '6h', 'daily', or a number of seconds (e.g. '3600').",
      );
    }

    const resolvedCodes: string[] = [];
    const unresolved: string[] = [];
    for (const c of codes) {
      const r = resolveCommodityCode(c);
      if (r) resolvedCodes.push(r);
      else unresolved.push(c);
    }
    if (resolvedCodes.length === 0) {
      return errorResult(
        `None of the requested commodities were recognized: ${unresolved.join(", ")}. ` +
          "Use opa_list_commodities to see valid codes.",
      );
    }

    const subscription: Record<string, unknown> = {
      codes: resolvedCodes,
      interval_seconds: intervalSeconds,
    };
    if (name) subscription.name = name;

    // Attribution: stamp this as an MCP-created watch via the dedicated headers
    // the API reads (X-OPA-Source / X-OPA-Tool) for MCP funnel analytics.
    const result = await makeAuthRequest("/v1/subscriptions", {
      method: "POST",
      body: subscription,
      headers: {
        "X-OPA-Source": "mcp",
        "X-OPA-Tool": "opa_create_price_subscription",
      },
    });

    if (!result.ok) {
      return errorResult(
        alertHttpError(result, "create the price subscription"),
      );
    }

    const created = (result.body as { subscription?: WatchRecord } | null)
      ?.subscription;
    let text = "# Price Subscription Created\n\n";
    text += created
      ? formatWatchLine(created)
      : `- Watching ${resolvedCodes.join(", ")} every ${describeInterval(intervalSeconds)}`;
    text +=
      "\n\nThis is a PERSISTENT, recurring watch. The API snapshots these " +
      "commodities each interval and records an event. Poll for new events with " +
      "`opa_get_subscription_events` (events are polled, not pushed — there is no " +
      "always-on connection). List or remove watches with `opa_list_subscriptions` " +
      "and `opa_delete_subscription`.";
    if (unresolved.length > 0) {
      text += `\n\n_Note: skipped unrecognized commodities: ${unresolved.join(", ")}._`;
    }
    text += `\n\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`;
    return textResult(text);
  },
);

server.registerTool(
  "opa_list_subscriptions",
  {
    title: "List Price Subscriptions",
    description:
      "List all PERSISTENT price subscriptions ('watches') on the user's " +
      "OilPriceAPI account. Use when the user asks what they're monitoring, or to " +
      "find a watch's id before deleting it. Each watch is a recurring, " +
      "account-tied snapshot job. REQUIRES an API key (OILPRICEAPI_KEY). No " +
      "parameters needed.",
    inputSchema: {},
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async () => {
    const keyErr = requireApiKey("opa_list_subscriptions");
    if (keyErr) return keyErr;

    const result = await makeAuthRequest("/v1/subscriptions");
    if (!result.ok) {
      return errorResult(alertHttpError(result, "list subscriptions"));
    }

    const watches =
      (result.body as { subscriptions?: WatchRecord[] } | null)
        ?.subscriptions ?? [];

    if (watches.length === 0) {
      return textResult(
        "No price subscriptions are set up on this account yet. Use " +
          "`opa_create_price_subscription` to create a recurring watch.",
      );
    }

    const sections = [`# Price Subscriptions (${watches.length})\n`];
    for (const w of watches) sections.push(formatWatchLine(w));
    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);
    return textResult(sections.join("\n"));
  },
);

server.registerTool(
  "opa_delete_subscription",
  {
    title: "Delete Price Subscription",
    description:
      "Permanently delete a price subscription ('watch') from the user's " +
      "OilPriceAPI account by id. Use when the user wants to stop/cancel/remove an " +
      "ongoing watch. Get the id from opa_list_subscriptions first. This " +
      "permanently removes the recurring watch (and its event history) from the " +
      "account. REQUIRES an API key (OILPRICEAPI_KEY).",
    inputSchema: {
      id: z
        .string()
        .describe(
          "The id of the subscription to delete (a UUID, as returned by " +
            "opa_list_subscriptions or opa_create_price_subscription).",
        ),
    },
    annotations: DELETE_TOOL_ANNOTATIONS,
  },
  async ({ id }) => {
    const keyErr = requireApiKey("opa_delete_subscription");
    if (keyErr) return keyErr;

    const result = await makeAuthRequest(
      `/v1/subscriptions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );

    if (result.status === 404) {
      return errorResult(
        `No subscription found with id \`${id}\` on this account. Use ` +
          "opa_list_subscriptions to see valid ids.",
      );
    }
    if (!result.ok) {
      return errorResult(alertHttpError(result, "delete the subscription"));
    }

    return textResult(
      `Price subscription \`${id}\` was permanently deleted from the user's account.`,
    );
  },
);

server.registerTool(
  "opa_get_subscription_events",
  {
    title: "Poll Subscription Events",
    description:
      "Poll for new subscription events — the recurring snapshots recorded by the " +
      "user's watches. Use this to catch up on what changed since the last poll: " +
      "pass the `since` cursor (the seq number) returned by the previous call to " +
      "get only newer events. Events are POLLED, not pushed — there is no always-on " +
      "connection, so call this periodically to stay current. Each event carries a " +
      "price snapshot plus per-code deltas vs the prior snapshot. The returned " +
      "`cursor` is what you pass as `since` next time. REQUIRES an API key " +
      "(OILPRICEAPI_KEY). This poll does NOT count against the monthly request " +
      "quota.",
    inputSchema: {
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Cursor: only return events with a seq greater than this. Use the " +
            "`cursor` from the previous call. Omit (or 0) to get the earliest " +
            "available events.",
        ),
    },
    annotations: READ_TOOL_ANNOTATIONS,
  },
  async ({ since }) => {
    const keyErr = requireApiKey("opa_get_subscription_events");
    if (keyErr) return keyErr;

    const params = new URLSearchParams();
    if (typeof since === "number") params.set("since", String(since));
    const qs = params.toString();

    const result = await makeAuthRequest(
      `/v1/subscriptions/events${qs ? `?${qs}` : ""}`,
    );
    if (!result.ok) {
      return errorResult(alertHttpError(result, "poll subscription events"));
    }

    const envelope = result.body as ApiResponse<{
      cursor?: number;
      has_more?: boolean;
      events?: Array<{
        id?: string;
        seq?: number;
        watch_id?: string;
        observed_at?: string;
        snapshot?: Record<string, unknown>;
        deltas?: Record<string, unknown>;
      }>;
    }> | null;

    const data = envelope?.data;
    const events = data?.events ?? [];
    const cursor = data?.cursor ?? since ?? 0;

    if (events.length === 0) {
      return textResult(
        `No new subscription events since cursor ${since ?? 0}. Cursor is ${cursor}. ` +
          "Poll again later for new snapshots.",
      );
    }

    const sections = [`# Subscription Events (${events.length})\n`];
    for (const e of events) {
      sections.push(
        `## Event seq ${e.seq}${e.observed_at ? ` — ${e.observed_at}` : ""} (watch \`${e.watch_id}\`)`,
      );
      sections.push("```json");
      sections.push(
        JSON.stringify({ snapshot: e.snapshot, deltas: e.deltas }, null, 2),
      );
      sections.push("```");
    }
    sections.push(
      `\n**Next cursor**: \`${cursor}\`${data?.has_more ? " (more events available — poll again)" : ""}`,
    );
    sections.push(
      "\n_Pass the next cursor as `since` on your next poll to get only newer events._",
    );
    sections.push(`\n_Data from [OilPriceAPI](https://oilpriceapi.com)_`);
    return textResult(sections.join("\n"));
  },
);

// =========================================================================
// RESOURCES — reviewed product contract + price snapshots
// =========================================================================

server.registerResource(
  "product-facts",
  PRODUCT_FACTS_URI,
  {
    title: "OilPriceAPI Reviewed Product Facts",
    description:
      "Versioned OilPriceAPI offer, freshness, catalog, authentication, integration, and data-rights contract. No API key required.",
    mimeType: "application/json",
  },
  async () => {
    try {
      const result = await productFactsProvider.get();
      return {
        contents: [
          {
            uri: PRODUCT_FACTS_URI,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch {
      return {
        contents: [
          {
            uri: PRODUCT_FACTS_URI,
            mimeType: "application/json",
            text: JSON.stringify({
              error: "OilPriceAPI product facts are unavailable.",
              canonicalUrl: "https://api.oilpriceapi.com/product-facts.json",
            }),
          },
        ],
      };
    }
  },
);

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

const DEFAULT_TOOL_CONFIGURATION = resolveToolConfiguration({
  argv: [],
  env: {},
});
applyToolConfiguration(server, DEFAULT_TOOL_CONFIGURATION);

// Smithery sandbox export for server scanning. Reset to the safe default for
// every caller unless a test/integration explicitly requests another scope.
export function createSandboxServer(configuration?: ToolConfiguration) {
  applyToolConfiguration(server, configuration ?? DEFAULT_TOOL_CONFIGURATION);
  return server;
}

interface PackageJsonMetadata {
  name: string;
  version: string;
  engines?: { node?: string };
  repository?: { url?: string };
}

interface GeneratedBuildMetadata {
  sourceCommit?: string;
  generatedAt?: string;
}

function loadCapabilityBuildMetadata(): CapabilityBuildMetadata {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJsonMetadata;
  let generated: GeneratedBuildMetadata = {};
  try {
    generated = JSON.parse(
      readFileSync(new URL("./build-metadata.json", import.meta.url), "utf8"),
    ) as GeneratedBuildMetadata;
  } catch {
    // Source imports do not have build metadata yet. The all-zero commit keeps
    // local inspection schema-valid without claiming a source revision.
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
    minimumNodeVersion: packageJson.engines?.node || ">=18.0.0",
    repository:
      packageJson.repository?.url ||
      "https://github.com/OilpriceAPI/mcp-server",
    sourceCommit:
      generated.sourceCommit || "0000000000000000000000000000000000000000",
    generatedAt: generated.generatedAt || "1970-01-01T00:00:00.000Z",
  };
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function cliOption(argv: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equals = argv.find((value) => value.startsWith(equalsPrefix));
  if (equals) return equals.slice(equalsPrefix.length);
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function formatDoctor(report: DoctorReport): string {
  const lines = [`OilPriceAPI MCP doctor (${report.mode})`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
    if (check.recovery) lines.push(`  Recovery: ${check.recovery}`);
  }
  if (report.account) {
    lines.push(`Plan: ${report.account.plan}`);
    const locked = Object.entries(report.account.features)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name)
      .sort();
    lines.push(
      locked.length > 0
        ? `Locked features: ${locked.join(", ")}`
        : "Locked features: none reported",
    );
  }
  lines.push(report.ok ? "Doctor result: PASS" : "Doctor result: FAIL");
  return lines.join("\n");
}

function directExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

function validateCliArguments(argv: string[]): void {
  const optionsWithValues = new Set([
    "--scope",
    "--profile",
    "--categories",
    "--config",
  ]);
  const standalone = new Set([
    "--version",
    "--list-tools",
    "--capabilities",
    "--json",
    "--demo",
    "doctor",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (
      standalone.has(value) ||
      [...optionsWithValues].some((name) => value.startsWith(`${name}=`))
    ) {
      continue;
    }
    if (optionsWithValues.has(value)) {
      const optionValue = argv[index + 1];
      if (!optionValue || optionValue.startsWith("--")) {
        throw new Error(`${value} requires a value.`);
      }
      index += 1;
      continue;
    }
    throw new Error(
      `Unknown argument '${value}'. Run --list-tools or doctor --demo for diagnostics.`,
    );
  }
}

// Main entry point
export async function main(argv = process.argv.slice(2)): Promise<void> {
  validateCliArguments(argv);
  const configuration = resolveToolConfiguration({ argv, env: process.env });
  const enabledTools = applyToolConfiguration(server, configuration);
  const metadata = loadCapabilityBuildMetadata();

  if (hasFlag(argv, "--version")) {
    process.stdout.write(`${metadata.name} ${metadata.version}\n`);
    return;
  }

  const configTarget = cliOption(argv, "--config");
  if (configTarget !== undefined) {
    if (!isClientConfigTarget(configTarget)) {
      throw new Error(
        `Unknown MCP client '${configTarget}'. Expected one of: ${Object.keys(CLIENT_CONFIG_TARGETS).join(", ")}.`,
      );
    }
    process.stdout.write(
      `${JSON.stringify(
        generateClientConfig({
          client: configTarget,
          scope: configuration.scope,
          profile: configuration.profile,
          ...(configuration.categoriesSource === "allowlist"
            ? { categories: configuration.categories }
            : {}),
          demo: hasFlag(argv, "--demo"),
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (hasFlag(argv, "--capabilities")) {
    const manifest = buildCapabilityManifest(server, metadata);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (hasFlag(argv, "--list-tools")) {
    const manifest = buildCapabilityManifest(server, metadata);
    const enabled = new Set(enabledTools);
    const tools = manifest.tools.filter((tool) => enabled.has(tool.name));
    if (hasFlag(argv, "--json")) {
      process.stdout.write(
        `${JSON.stringify(
          {
            scope: configuration.scope,
            profile: configuration.profile,
            categories: configuration.categories,
            tools,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        [
          `OilPriceAPI MCP tools (scope=${configuration.scope}, profile=${configuration.profile}, count=${tools.length})`,
          ...tools.map(
            (tool) =>
              `${tool.name}\t${tool.access}\t${tool.category}\t${tool.title}`,
          ),
        ].join("\n") + "\n",
      );
    }
    return;
  }

  if (argv.includes("doctor")) {
    const report = await runDoctor({
      baseUrl: API_BASE,
      apiKey: getApiKey(),
      demo: hasFlag(argv, "--demo"),
      entryPoint: fileURLToPath(import.meta.url),
    });
    process.stdout.write(
      hasFlag(argv, "--json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatDoctor(report)}\n`,
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }

  console.error(
    `OilPriceAPI MCP: scope=${configuration.scope} profile=${configuration.profile} tools=${enabledTools.length}/32`,
  );
  if (!getApiKey()) {
    // stderr only — stdout is the MCP protocol channel.
    console.error(
      "OilPriceAPI MCP: no OILPRICEAPI_KEY set — running in DEMO MODE. " +
        "Price tools serve a limited live commodity set from the keyless demo " +
        "endpoint; most other tools are limited. " +
        `Get a free API key for the broader account-enabled catalog: ${SIGNUP_URL}`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OilPriceAPI MCP Server v${MCP_VERSION} running on stdio`);
}

if (directExecution()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown failure";
    const key = getApiKey();
    const redacted = key ? message.split(key).join("[REDACTED]") : message;
    console.error(`OilPriceAPI MCP failed: ${redacted}`);
    process.exitCode = 1;
  });
}
