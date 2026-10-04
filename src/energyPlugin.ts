import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiGateError,
  COMMODITY_INFO,
  FUTURES_INSTRUMENT_QUOTE,
  requestApi,
} from "./index.js";
import { withRequestCredential } from "./requestCredential.js";
import { createHash } from "node:crypto";

export const PLUGIN_VERSION = "0.1.1";
export const WEBSITE_URL = "https://www.oilpriceapi.com/";
export const ENERGY_CODES = [
  "BRENT_CRUDE_USD",
  "WTI_USD",
  "NATURAL_GAS_USD",
  "DIESEL_USD",
  "GASOLINE_USD",
  "HEATING_OIL_USD",
] as const;
const benchmark = z.enum(ENERGY_CODES);
const schemas = {
  energy_get_price: z.object({ benchmark }).strict(),
  energy_market_overview: z
    .object({
      category: z
        .enum(["all", "crude", "natural_gas", "refined"])
        .default("all"),
    })
    .strict(),
  energy_compare: z
    .object({
      benchmarks: z
        .array(benchmark)
        .min(2)
        .max(5)
        .refine(
          (v) => new Set(v).size === v.length,
          "Benchmarks must be distinct",
        ),
    })
    .strict(),
  energy_history: z
    .object({
      benchmark,
      days: z.number().int().min(1).max(30).default(30),
      limit: z.number().int().min(1).max(100).default(31),
    })
    .strict(),
  energy_futures_curve: z
    .object({
      instrument: z.enum([
        "brent",
        "wti",
        "natural-gas",
        "gasoil",
        "ttf-gas",
        "lng-jkm",
      ]),
      limit: z.number().int().min(1).max(12).default(12),
    })
    .strict(),
  energy_marine_fuels: z
    .object({
      ports: z
        .array(z.enum(["NLRTM", "SGSIN", "USHOU"]))
        .min(1)
        .max(2)
        .refine((v) => new Set(v).size === v.length),
      grade: z.enum(["VLSFO", "MGO_05S", "HFO_380"]),
    })
    .strict(),
  energy_drilling: z
    .object({
      geography: z
        .enum(["US", "Canada", "international", "Permian"])
        .default("US"),
    })
    .strict(),
  energy_search_catalog: z
    .object({
      query: z
        .string()
        .trim()
        .min(2)
        .max(60)
        .regex(/^[\p{L}\p{N} ._\-/&()]+$/u),
      limit: z.number().int().min(1).max(10).default(10),
    })
    .strict(),
  energy_get_latest: z
    .object({ code: z.string().regex(/^[A-Z0-9_]{2,64}$/) })
    .strict(),
};
export type EnergyTool = keyof typeof schemas;
// Tools that need a linked account. Anonymous calls to these get an HTTP 401
// challenge at the transport (see remote.ts) so clients can start sign-in.
export const ACCOUNT_TOOLS: ReadonlySet<string> = new Set<EnergyTool>([
  "energy_history",
  "energy_futures_curve",
  "energy_marine_fuels",
  "energy_drilling",
  "energy_search_catalog",
  "energy_get_latest",
]);
const descriptions: Record<EnergyTool, string> = {
  energy_get_price:
    "Read one supported latest energy benchmark. Preserve dataset name, currency, unit and all available source/freshness fields. Latest benchmarks may be futures; never relabel them spot or settlement. Demo is available without signup.",
  energy_market_overview:
    "Read a grouped snapshot of at most six supported energy benchmarks. Catalog enumeration and bulk extraction are outside this plugin. Missing values remain unavailable.",
  energy_compare:
    "Compare 2–5 distinct supported energy benchmarks with separate timestamps, dataset context, units and currencies. No currency conversion or timestamp alignment is implied.",
  energy_history:
    "Read one authenticated benchmark's daily historical observations over at most 30 days and 100 rows. No pagination or anonymous history. Derive summaries only from returned observations, which may be incomplete.",
  energy_futures_curve:
    "Read an authenticated energy forward curve, at most 12 contracts. Preserve contract month, trading date and expiration semantics. Missing expiration or source dates remain unreported. Account entitlement is enforced by OilPriceAPI.",
  energy_marine_fuels:
    "Read authenticated bunker quotes for 1–2 supported ports and one exact grade: VLSFO, MGO_05S or HFO_380. Preserve port, grade and per-quote freshness. No substitution when a quote is unavailable. Account entitlement is enforced by OilPriceAPI.",
  energy_search_catalog:
    "Search the full OilPriceAPI commodity catalog (crude grades, regional natural gas hubs such as Waha, refined products, power, coal, metals, freight and more) by name or code. Returns at most 10 matching codes with name, category, unit and update frequency. Use it to find the code, then call energy_get_latest. Requires a connected OilPriceAPI account.",
  energy_get_latest:
    "Read the latest price for one exact commodity code from the catalog (find codes with energy_search_catalog). Preserve dataset name, currency, unit and all source/freshness fields; latest is not necessarily spot or settlement. Requires a connected account; access follows the account's plan.",
  energy_drilling:
    "Read authenticated drilling intelligence for a supported geography. Preserve report dates and geography. Permian basin counts and prior-report changes are unavailable unless explicitly supplied; do not substitute US totals. Account entitlement is enforced by OilPriceAPI.",
};
export function category(code: string): string {
  return code === "NATURAL_GAS_USD"
    ? "natural_gas"
    : code === "BRENT_CRUDE_USD" || code === "WTI_USD"
      ? "crude"
      : "refined";
}
const fields = new Set(
  "code name price currency unit source source_date source_timestamp source_observed_at timestamp observed_at as_of created_at updated_at collected_at type price_type dataset dataset_type stale age_days age_seconds stale_reason freshness status expected_max_age_seconds observed_via fallback fallback_from synthetic quality_grade contract_month contract_code trading_date months_to_expiry expiration_date expiry_date settlement_price last_price analysis_date curve_type total_contracts port_code port_name country region fuel_type fuel_name count report_period last_updated change_24h change_24h_percent deltas".split(
    " ",
  ),
);
// Only market semantics enter model output. Arbitrary metadata, IDs, credentials,
// upstream messages and pagination links are excluded, recursively.
export function publicFields(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4)
    return {};
  const safe: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!fields.has(key)) continue;
    if (
      val === null ||
      typeof val === "boolean" ||
      (typeof val === "number" && Number.isFinite(val))
    )
      safe[key] = val;
    else if (
      typeof val === "string" &&
      val.length <= 200 &&
      !/bearer\s|(?:api[_-]?key|secret|token)\s*[:=]|(?:sk|opa)[_-][a-z0-9]{16}/i.test(
        val,
      )
    )
      safe[key] = val;
    else if (val && typeof val === "object" && !Array.isArray(val))
      safe[key] = publicFields(val, depth + 1);
  }
  return safe;
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
export function observation(raw: unknown, code?: string, demo = false) {
  const row = record(raw);
  const safe = publicFields(row);
  const valid = typeof row.price === "number" && Number.isFinite(row.price);
  return {
    ...safe,
    code: code ?? safe.code,
    availability: valid ? "available" : "unavailable",
    price: valid ? row.price : null,
    currency: safe.currency ?? null,
    unit: safe.unit ?? (code ? COMMODITY_INFO[code]?.unit : null) ?? null,
    unit_context: safe.unit
      ? "reported_by_api"
      : "benchmark_definition_when_known",
    source_timestamp:
      safe.source_timestamp ??
      safe.source_observed_at ??
      safe.observed_at ??
      safe.as_of ??
      safe.source_date ??
      null,
    dataset_context: safe.name ?? safe.dataset ?? safe.type ?? "not reported",
    freshness_limitations: demo
      ? "Demo updated_at is a publication timestamp; source observation time and cadence are not reported. Cached up to one hour. Not an execution or settlement feed."
      : "Use reported source/freshness fields. Missing cadence or observation time is unknown; latest is not necessarily spot or settlement.",
  };
}
export interface PluginEvent {
  event: "plugin_tool_call";
  tool: EnergyTool;
  dataset_category: string;
  outcome: string;
  duration_ms: number;
  plugin_version: string;
  result_count: number;
  access: "demo" | "authenticated";
}
export interface EnergyPluginOptions {
  key?: string;
  fetchImpl?: typeof fetch;
  writeEvent?: (event: PluginEvent) => void;
  demoCache?: DemoCache;
  signal?: AbortSignal;
  resourceUrl?: string;
}
export class DemoCache {
  private cached?: { data: unknown; expires: number; fetchedAt: string };
  private pending?: Promise<{ data: unknown; fetchedAt: string }>;
  async get(
    load: () => Promise<unknown>,
  ): Promise<{ data: unknown; fetchedAt: string }> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached;
    if (this.pending) return this.pending;
    this.pending = load()
      .then((data) => {
        const entry = {
          data,
          fetchedAt: new Date().toISOString(),
          expires: Date.now() + 3_600_000,
        };
        this.cached = entry;
        return entry;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
class PluginFailure extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
  }
}
function result(body: Record<string, unknown>, error = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    ...(error ? { isError: true } : {}),
  };
}
const failureMessages: Record<string, string> = {
  entitlement:
    "This dataset requires an OilPriceAPI account with the applicable entitlement.",
  authentication:
    "The supplied OilPriceAPI credential is invalid or revoked. Reconnect with a valid credential.",
  rate_limit:
    "OilPriceAPI rate or quota limit reached. Retry later; no data was substituted.",
  unavailable:
    "The requested dataset is unavailable. No value or change was estimated.",
  upstream_error: "OilPriceAPI could not return verified data. Retry later.",
  invalid_argument:
    "The request exceeds supported inputs or caps. Use one of the listed benchmarks and a bounded request.",
};
export async function executeEnergyTool(
  tool: EnergyTool,
  args: unknown,
  options: EnergyPluginOptions = {},
) {
  const start = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15_000);
  const cancel = () => deadline.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) deadline.abort();
  let outcome = "completed";
  let count = 0;
  let datasetCategory = "crude_refined";
  const fetchImpl = options.fetchImpl ?? fetch;
  const handoff = () =>
    options.resourceUrl
      ? `${new URL(options.resourceUrl).origin}/handoff/${datasetCategory}`
      : `https://www.oilpriceapi.com/auth/signup?utm_source=openai-plugin&utm_medium=plugin&utm_campaign=energy-markets&utm_content=${datasetCategory}`;
  const respond = (body: Record<string, unknown>, error = false) => {
    const serialized = JSON.stringify(body);
    const safe = options.key
      ? JSON.parse(serialized.replaceAll(options.key, "[credential removed]"))
      : body;
    return result(safe, error);
  };
  try {
    const parsed = schemas[tool].safeParse(args);
    if (!parsed.success) throw new PluginFailure("invalid_argument");
    const input = parsed.data as Record<string, any>;
    datasetCategory =
      tool === "energy_futures_curve"
        ? "futures"
        : tool === "energy_marine_fuels"
          ? "marine"
          : tool === "energy_drilling"
            ? "drilling"
            : tool === "energy_search_catalog" || tool === "energy_get_latest"
              ? "catalog"
              : input.benchmark === "NATURAL_GAS_USD" ||
                  input.category === "natural_gas"
                ? "natural_gas"
                : "crude_refined";
    const api = async (endpoint: string): Promise<any> =>
      withRequestCredential(options.key, async () => {
        if (deadline.signal.aborted) throw new PluginFailure("upstream_error");
        const releases: Array<() => void> = [];
        try {
          const response = await requestApi<unknown>(
            endpoint,
            async (url, init) => {
              const combined = new AbortController();
              const abort = () => combined.abort();
              const signals = [deadline.signal, init?.signal].filter(
                Boolean,
              ) as AbortSignal[];
              for (const signal of signals) {
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) combined.abort();
              }
              releases.push(() => {
                for (const signal of signals)
                  signal.removeEventListener("abort", abort);
              });
              try {
                return await fetchImpl(url, {
                  ...init,
                  signal: combined.signal,
                });
              } catch {
                throw new Error("Upstream transport unavailable");
              }
            },
            { budgetMs: 12_000, retryServerErrors: false },
          );
          if (!response.data)
            throw new PluginFailure(
              response.status === 401
                ? "authentication"
                : response.status === 404
                  ? "unavailable"
                  : "upstream_error",
            );
          const payload = record(response.data);
          if (payload.status && payload.status !== "success")
            throw new PluginFailure("unavailable");
          return response.data;
        } finally {
          for (const release of releases) release();
        }
      });
    let body: Record<string, unknown>;
    if (
      ["energy_get_price", "energy_compare", "energy_market_overview"].includes(
        tool,
      )
    ) {
      const codes: string[] = input.benchmark
        ? [input.benchmark]
        : (input.benchmarks ??
          ENERGY_CODES.filter(
            (code) =>
              input.category === "all" || category(code) === input.category,
          ));
      let rows: any[] = [];
      let fetchedAt: string | undefined;
      if (!options.key) {
        const load = async () => {
          const data = await api("/v1/demo/prices");
          if (!Array.isArray(record(data.data).prices))
            throw new PluginFailure("unavailable");
          return data;
        };
        const entry = await (options.demoCache ?? new DemoCache()).get(load);
        rows = record(record(entry.data).data).prices;
        fetchedAt = entry.fetchedAt;
      } else {
        for (const code of codes) {
          const data = await api(`/v1/prices/latest?by_code=${code}`);
          const row = record(data.data);
          // Wrong-code 200 must never be accepted as this benchmark.
          rows.push(row.code === code ? row : { code });
        }
      }
      const observations = codes.map((code) => ({
        ...observation(
          rows.find((row) => row.code === code),
          code,
          !options.key,
        ),
        category: category(code),
      }));
      count = observations.filter(
        (row) => row.availability === "available",
      ).length;
      if (!count) outcome = "unavailable";
      body = {
        availability: count ? "available" : "unavailable",
        access: options.key ? "authenticated" : "demo",
        observations,
        cached_at: fetchedAt ?? null,
        catalog_scope: ENERGY_CODES,
        missing_values:
          "Unavailable is not zero. Do not estimate or substitute.",
        provider: "OilPriceAPI",
      };
    } else {
      if (!options.key) throw new PluginFailure("entitlement");
      if (tool === "energy_history") {
        const now = Date.now();
        const windowStart = new Date(now - input.days * 86400000)
          .toISOString()
          .slice(0, 10);
        const windowEnd = new Date(now).toISOString().slice(0, 10);
        const data = await api(
          `/v1/prices/past_month?by_code=${input.benchmark}&interval=1d&per_page=${input.limit}&page=1&start_date=${windowStart}&end_date=${windowEnd}`,
        );
        const rows = record(data.data).prices;
        if (!Array.isArray(rows)) throw new PluginFailure("unavailable");
        const selected = rows.slice(0, input.limit).filter((raw) => {
          const row = record(raw);
          // Historical observation dates are distinct from publication updates.
          const date =
            row.source_timestamp ??
            row.source_observed_at ??
            row.observed_at ??
            row.as_of ??
            row.source_date ??
            row.timestamp ??
            row.created_at;
          if (typeof date !== "string" || !Number.isFinite(Date.parse(date)))
            return false;
          const day = new Date(date).toISOString().slice(0, 10);
          return (
            day >= windowStart && day <= windowEnd && Date.parse(date) <= now
          );
        });
        if (
          selected.some(
            (row) => record(row).code && row.code !== input.benchmark,
          )
        )
          throw new PluginFailure("unavailable");
        const observations = selected.map((row) =>
          observation(row, input.benchmark),
        );
        count = observations.filter(
          (row) => row.availability === "available",
        ).length;
        body = {
          dataset: "historical_daily_observations",
          benchmark: input.benchmark,
          observations,
          window_days: input.days,
          window_start: windowStart,
          window_end: windowEnd,
          row_limit: input.limit,
          completeness:
            "First bounded page only; do not infer complete window coverage or zero change from missing observations.",
        };
      } else if (tool === "energy_futures_curve") {
        const data = record(await api(`/v1/futures/${input.instrument}/curve`));
        if (
          typeof data.instrument === "string" &&
          data.instrument !== input.instrument
        )
          throw new PluginFailure("unavailable");
        if (!Array.isArray(data.contracts))
          throw new PluginFailure("unavailable");
        const contracts = data.contracts
          .slice(0, input.limit)
          .map((raw: unknown) => {
            const row = publicFields(raw);
            const valid =
              typeof row.settlement_price === "number" &&
              typeof row.contract_month === "string";
            return {
              ...row,
              settlement_price: valid ? row.settlement_price : null,
              availability: valid ? "available" : "unavailable",
            };
          });
        count = contracts.filter(
          (row: { availability: string }) => row.availability === "available",
        ).length;
        body = {
          dataset: "futures_curve",
          instrument: input.instrument,
          ...publicFields(data),
          quote_basis: FUTURES_INSTRUMENT_QUOTE[input.instrument],
          quote_basis_context:
            "Contract specification fallback; reported currency takes precedence. No FX conversion.",
          contracts,
          expiration_semantics:
            "Contract month is not an exact expiration date. Use only returned expiration fields; missing dates are unreported.",
          freshness_limitations:
            "analysis_date is not necessarily a source observation timestamp. Settlement fields do not imply exchange-grade or real-time data.",
        };
      } else if (tool === "energy_marine_fuels") {
        const data = await api("/v1/marine-fuels/latest");
        const rows = record(data.data).prices;
        if (!Array.isArray(rows)) throw new PluginFailure("unavailable");
        const quotes = input.ports.map((port: string) => {
          const row = rows.find((row) => row.port_code === port);
          const fuel = Array.isArray(row?.fuels)
            ? row.fuels.find((fuel: any) => fuel.fuel_type === input.grade)
            : undefined;
          return {
            port,
            grade: input.grade,
            ...observation(fuel),
            port_context: publicFields(row),
          };
        });
        count = quotes.filter(
          (row: any) => row.availability === "available",
        ).length;
        body = { dataset: "marine_fuels", quotes };
      } else if (tool === "energy_search_catalog") {
        const catalog = await catalogCache.get(options.key, async () => {
          const data = record(await api("/v1/commodities"));
          const rows = record(data.data).commodities;
          if (!Array.isArray(rows)) throw new PluginFailure("unavailable");
          return rows;
        });
        const matches = searchCatalog(catalog, input.query, input.limit);
        count = matches.length;
        body = {
          dataset: "commodity_catalog",
          query: input.query,
          matches,
          catalog_size: catalog.length,
          next_step:
            "Call energy_get_latest with one returned code. Do not guess codes that were not returned.",
        };
      } else if (tool === "energy_get_latest") {
        const data = await api(`/v1/prices/latest?by_code=${input.code}`);
        const row = record(data.data);
        // Wrong-code 200 must never be accepted as this commodity.
        const observed = observation(
          row.code === input.code ? row : {},
          input.code,
        );
        count = observed.availability === "available" ? 1 : 0;
        body = {
          dataset: "latest_price",
          code: input.code,
          observations: [observed],
          missing_values:
            "Unavailable is not zero. Do not estimate or substitute.",
        };
      } else {
        // Current REST snapshot has no basin-level contract. Do not substitute
        // national counts for the positive review's Permian question.
        if (input.geography === "Permian")
          throw new PluginFailure("unavailable");
        const data = record(record(await api("/v1/drilling/latest")).data);
        const counts = record(data.rig_counts);
        const key =
          input.geography === "US"
            ? "US_RIG_COUNT"
            : input.geography === "Canada"
              ? "CANADA_RIG_COUNT"
              : "INTERNATIONAL_RIG_COUNT";
        const rigCount = counts[key];
        count =
          typeof rigCount === "number" && Number.isFinite(rigCount) ? 1 : 0;
        body = {
          dataset: "drilling_intelligence",
          geography: input.geography,
          count: count ? rigCount : null,
          unit: "rigs",
          report_period: publicFields(data).report_period ?? null,
          updated_at: publicFields(data).last_updated ?? null,
          prior_report_change: null,
          freshness_limitations:
            "Report period and prior-report change are unreported unless returned explicitly.",
        };
      }
      if (!count) outcome = "unavailable";
    }
    return respond(
      {
        ...body,
        website_url: WEBSITE_URL,
        handoff_url: handoff(),
      },
      outcome !== "completed",
    );
  } catch (error) {
    outcome =
      error instanceof PluginFailure
        ? error.outcome
        : error instanceof ApiGateError
          ? error.status === 429
            ? "rate_limit"
            : "entitlement"
          : "upstream_error";
    const failure = respond(
      {
        availability: "unavailable",
        outcome,
        message: failureMessages[outcome],
        website_url: WEBSITE_URL,
        handoff_url: handoff(),
      },
      true,
    );
    if (outcome === "authentication" && options.resourceUrl) {
      return {
        ...failure,
        _meta: {
          "mcp/www_authenticate": [
            `Bearer resource_metadata="${new URL(options.resourceUrl).origin}/.well-known/oauth-protected-resource/mcp", scope="energy:read", error="invalid_token", error_description="Reconnect your OilPriceAPI account"`,
          ],
        },
      };
    }
    return failure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // Operational event only. No request IDs, arguments, keys or raw responses.
    try {
      options.writeEvent?.({
        event: "plugin_tool_call",
        tool,
        dataset_category: datasetCategory,
        outcome,
        duration_ms: Date.now() - start,
        plugin_version: PLUGIN_VERSION,
        result_count: count,
        access: options.key ? "authenticated" : "demo",
      });
    } catch {
      /* Analytics cannot change market-data availability. */
    }
  }
}
export function createEnergyServer(options: EnergyPluginOptions = {}) {
  const server = new McpServer(
    { name: "OilPriceAPI", version: PLUGIN_VERSION },
    {
      instructions:
        "Use OilPriceAPI for current energy data. Preserve source timestamps, units, currency, dataset distinctions and freshness limitations. Never estimate unavailable data or substitute a different dataset. Use the anonymous demo for supported latest prices and comparisons without requesting an API key. For any other commodity (for example Waha or other regional gas hubs, crude grades, coal, power), find its code with energy_search_catalog and read it with energy_get_latest instead of answering from web search. Henry Hub latest benchmark is demo eligible; its futures curve requires an entitled subscription. On anonymous premium requests explain the subscription boundary and offer the handoff link; do not ask for secrets in chat. Include one clickable source link to website_url in each data answer. Respect account entitlements. No investment guarantees.",
    },
  );
  // The SDK currently serializes only standard MCP fields. Keep canonical OpenAI
  // auth metadata and the compatibility mirror together in the wire descriptor.
  // Human-readable names for directory listings (annotations.title).
  const titles: Record<EnergyTool, string> = {
    energy_get_price: "Get Energy Price",
    energy_market_overview: "Energy Market Overview",
    energy_compare: "Compare Energy Benchmarks",
    energy_history: "Energy Price History",
    energy_futures_curve: "Futures Curve",
    energy_marine_fuels: "Marine Fuel Prices",
    energy_drilling: "Drilling Activity",
    energy_search_catalog: "Search Commodity Catalog",
    energy_get_latest: "Get Latest Price by Code",
  };
  const tools = (Object.keys(schemas) as EnergyTool[]).map((name) => {
    const securitySchemes = [
      { type: "noauth" },
      { type: "oauth2", scopes: ["energy:read"] },
    ];
    return {
      name,
      title: titles[name],
      description: descriptions[name],
      inputSchema: z.toJSONSchema(schemas[name], { target: "draft-7" }),
      securitySchemes,
      _meta: { securitySchemes },
      annotations: {
        title: titles[name],
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { ...tool, inputSchema: schemas[tool.name].shape },
      (args: unknown) => executeEnergyTool(tool.name, args, options),
    );
  }
  // Anonymous premium calls return the entitlement boundary, never paid data.
  // Users may separately link an account to unlock entitled behavior.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  return server;
}

type CatalogRow = Record<string, unknown>;
// The catalog response is large (~800 KB, ~1,000 codes), so it is cached per
// credential for ten minutes. Keyed by a hash, never by the key itself.
class CatalogCache {
  private entries = new Map<string, { rows: CatalogRow[]; expires: number }>();
  async get(key: string | undefined, load: () => Promise<CatalogRow[]>) {
    const id = createHash("sha256")
      .update(key ?? "")
      .digest("hex");
    const now = Date.now();
    const hit = this.entries.get(id);
    if (hit && hit.expires > now) return hit.rows;
    const rows = await load();
    if (this.entries.size >= 100) {
      for (const [k, v] of this.entries)
        if (v.expires <= now) this.entries.delete(k);
      const oldest = this.entries.keys().next().value;
      if (this.entries.size >= 100 && oldest) this.entries.delete(oldest);
    }
    this.entries.set(id, { rows, expires: now + 600_000 });
    return rows;
  }
}
const catalogCache = new CatalogCache();

const text = (value: unknown, max = 120) =>
  typeof value === "string" && value.length <= 400 ? value.slice(0, max) : null;

// Every query token must appear in the code, name, category or description.
// Ranked: exact code, then code or name prefix, then name/code containing
// every token, then description-only matches.
export function searchCatalog(rows: CatalogRow[], query: string, limit = 10) {
  const lower = query.trim().toLowerCase();
  const tokens = lower.split(/[\s_/-]+/).filter(Boolean);
  const asCode = lower.replace(/\s+/g, "_");
  const scored: Array<{ score: number; row: CatalogRow }> = [];
  for (const row of rows) {
    const code = text(row.code, 64);
    if (!code) continue;
    const lc = code.toLowerCase();
    const name = (text(row.name) ?? "").toLowerCase();
    const haystack = [
      lc,
      name,
      text(row.category) ?? "",
      (text(row.description, 400) ?? "").toLowerCase(),
    ].join(" ");
    if (!tokens.every((t) => haystack.includes(t))) continue;
    const score =
      lc === asCode
        ? 0
        : lc.startsWith(asCode) || name.startsWith(lower)
          ? 1
          : tokens.every((t) => name.includes(t) || lc.includes(t))
            ? 2
            : 3;
    scored.push({ score, row });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || String(a.row.code).localeCompare(String(b.row.code)),
  );
  return scored.slice(0, limit).map(({ row }) => ({
    code: text(row.code, 64),
    name: text(row.name),
    category: text(row.category, 60),
    unit: text(row.unit, 40),
    currency: text(row.currency, 12),
    update_frequency: text(row.update_frequency, 40),
    has_data: typeof row.has_data === "boolean" ? row.has_data : null,
  }));
}
