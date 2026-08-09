import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const TOOL_SCOPES = ["read", "write"] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

export const TOOL_CATEGORIES = ["core", "market", "automation"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const TOOL_PROFILES = {
  all: TOOL_CATEGORIES,
  core: ["core"],
  market: ["core", "market"],
  automation: ["core", "automation"],
} as const satisfies Record<string, readonly ToolCategory[]>;
export type ToolProfile = keyof typeof TOOL_PROFILES;

export const WRITE_TOOL_NAMES = [
  "opa_create_price_alert",
  "opa_create_price_subscription",
  "opa_delete_price_alert",
  "opa_delete_subscription",
] as const;

const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);

const TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  opa_get_product_facts: "core",
  opa_get_price: "core",
  opa_market_overview: "core",
  opa_compare_prices: "core",
  opa_list_commodities: "core",
  opa_get_history: "core",
  opa_get_account_status: "core",
  opa_get_plans: "core",
  opa_get_futures: "market",
  opa_get_futures_curve: "market",
  opa_get_marine_fuels: "market",
  opa_get_natural_gas_hubs: "market",
  opa_get_rig_counts: "market",
  opa_get_drilling: "market",
  opa_get_diesel_by_state: "market",
  opa_get_fuel_surcharge: "market",
  opa_get_storage: "market",
  opa_get_opec_production: "market",
  opa_get_forecasts: "market",
  opa_get_oil_inventories: "market",
  opa_get_well_permits: "market",
  opa_search_well_permits: "market",
  opa_lookup_well: "market",
  opa_get_well_activity: "market",
  opa_get_well_production: "market",
  opa_get_spread: "market",
  opa_get_market_brief: "market",
  opa_create_price_alert: "automation",
  opa_list_price_alerts: "automation",
  opa_delete_price_alert: "automation",
  opa_get_alert_triggers: "automation",
  opa_create_price_subscription: "automation",
  opa_list_subscriptions: "automation",
  opa_delete_subscription: "automation",
  opa_get_subscription_events: "automation",
};

const KEYLESS_TOOLS = new Set([
  "opa_get_product_facts",
  "opa_get_plans",
  "opa_get_price",
  "opa_market_overview",
  "opa_compare_prices",
  "opa_list_commodities",
]);

interface RegisteredToolInternal {
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  enabled: boolean;
  enable: () => void;
  disable: () => void;
}

interface RegisteredResourceInternal {
  name: string;
  title?: string;
  metadata?: {
    description?: string;
    mimeType?: string;
  };
  enabled: boolean;
}

interface McpServerInternals {
  _registeredTools: Record<string, RegisteredToolInternal>;
  _registeredResources: Record<string, RegisteredResourceInternal>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ToolConfiguration {
  scope: ToolScope;
  profile: ToolProfile;
  categories: ToolCategory[];
  categoriesSource: "profile" | "allowlist";
}

export interface ResolveToolConfigurationOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

export interface CapabilityBuildMetadata {
  name: string;
  version: string;
  minimumNodeVersion: string;
  repository: string;
  sourceCommit: string;
  generatedAt: string;
}

function readOption(argv: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equals = argv.find((value) => value.startsWith(equalsPrefix));
  if (equals) return equals.slice(equalsPrefix.length);

  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseScope(value: string | undefined): ToolScope {
  const scope = value?.trim().toLowerCase() || "read";
  if (!TOOL_SCOPES.includes(scope as ToolScope)) {
    throw new Error(
      `Unknown MCP scope '${value}'. Expected one of: ${TOOL_SCOPES.join(", ")}.`,
    );
  }
  return scope as ToolScope;
}

function parseProfile(value: string | undefined): ToolProfile {
  const profile = value?.trim().toLowerCase() || "all";
  if (!(profile in TOOL_PROFILES)) {
    throw new Error(
      `Unknown MCP profile '${value}'. Expected one of: ${Object.keys(TOOL_PROFILES).join(", ")}.`,
    );
  }
  return profile as ToolProfile;
}

function parseCategories(value: string): ToolCategory[] {
  const requested = [
    ...new Set(value.split(",").map((item) => item.trim())),
  ].filter(Boolean);
  if (requested.length === 0) {
    throw new Error("MCP tool category allowlist cannot be empty.");
  }
  const unknown = requested.filter(
    (category) => !TOOL_CATEGORIES.includes(category as ToolCategory),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown MCP tool category: ${unknown.join(", ")}. Expected: ${TOOL_CATEGORIES.join(", ")}.`,
    );
  }
  return TOOL_CATEGORIES.filter((category) => requested.includes(category));
}

export function resolveToolConfiguration(
  options: ResolveToolConfigurationOptions = {},
): ToolConfiguration {
  const argv = options.argv ?? [];
  const env = options.env ?? process.env;
  const scope = parseScope(
    readOption(argv, "--scope") ?? env.OILPRICEAPI_MCP_SCOPE,
  );
  const profile = parseProfile(
    readOption(argv, "--profile") ?? env.OILPRICEAPI_MCP_PROFILE,
  );
  const categoryValue =
    readOption(argv, "--categories") ?? env.OILPRICEAPI_MCP_CATEGORIES;

  return {
    scope,
    profile,
    categories: categoryValue
      ? parseCategories(categoryValue)
      : [...TOOL_PROFILES[profile]],
    categoriesSource: categoryValue ? "allowlist" : "profile",
  };
}

function serverInternals(server: McpServer): McpServerInternals {
  const candidate = server as unknown as Partial<McpServerInternals>;
  if (
    !isRecord(candidate._registeredTools) ||
    !isRecord(candidate._registeredResources)
  ) {
    throw new Error(
      "Incompatible MCP SDK: expected registered tool and resource maps are unavailable.",
    );
  }
  return candidate as McpServerInternals;
}

export function getRegisteredToolEntries(
  server: McpServer,
): Array<[string, RegisteredToolInternal]> {
  const entries = Object.entries(serverInternals(server)._registeredTools).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const registeredNames = new Set(entries.map(([name]) => name));
  const missingCategories = entries
    .map(([name]) => name)
    .filter((name) => !TOOL_CATEGORY_BY_NAME[name]);
  const staleCategories = Object.keys(TOOL_CATEGORY_BY_NAME).filter(
    (name) => !registeredNames.has(name),
  );
  if (missingCategories.length > 0 || staleCategories.length > 0) {
    throw new Error(
      `Tool category registry drift. Missing: ${missingCategories.join(", ") || "none"}; stale: ${staleCategories.join(", ") || "none"}.`,
    );
  }
  return entries;
}

export function toolNamesForConfiguration(
  server: McpServer,
  configuration: ToolConfiguration,
): string[] {
  const allowedCategories = new Set(configuration.categories);
  return getRegisteredToolEntries(server)
    .filter(([name]) => allowedCategories.has(TOOL_CATEGORY_BY_NAME[name]))
    .filter(
      ([name]) => configuration.scope === "write" || !WRITE_TOOLS.has(name),
    )
    .map(([name]) => name);
}

export function applyToolConfiguration(
  server: McpServer,
  configuration: ToolConfiguration,
): string[] {
  const enabledNames = new Set(
    toolNamesForConfiguration(server, configuration),
  );
  for (const [name, tool] of getRegisteredToolEntries(server)) {
    if (enabledNames.has(name)) tool.enable();
    else tool.disable();
  }
  return [...enabledNames].sort();
}

const annotationSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

const capabilityToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(TOOL_CATEGORIES),
  access: z.enum(["read", "write"]),
  apiKey: z.enum(["none", "optional", "required"]),
  entitlement: z.enum(["none", "account-and-plan-dependent"]),
  annotations: annotationSchema,
});

export const capabilityManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  generatedAt: z.string().datetime(),
  package: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    minimumNodeVersion: z.string().min(1),
    repository: z.string().url(),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  configuration: z.object({
    recommended: z.object({
      scope: z.literal("read"),
      profile: z.literal("all"),
    }),
    client: z.object({
      command: z.literal("npx"),
      args: z.array(z.string()),
      environment: z.array(
        z.object({
          name: z.string(),
          required: z.boolean(),
          secret: z.boolean(),
          description: z.string(),
        }),
      ),
    }),
  }),
  commands: z.object({
    version: z.string(),
    listTools: z.string(),
    doctor: z.string(),
    demoDoctor: z.string(),
    capabilities: z.string(),
    config: z.string(),
  }),
  profiles: z.record(z.string(), z.array(z.enum(TOOL_CATEGORIES))),
  inventories: z.object({
    read: z.record(z.string(), z.array(z.string())),
    write: z.record(z.string(), z.array(z.string())),
  }),
  tools: z.array(capabilityToolSchema),
  resources: z.array(
    z.object({
      name: z.string(),
      uri: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  demo: z.object({
    availableWithoutKey: z.literal(true),
    endpoint: z.literal("/v1/demo/prices"),
  }),
  support: z.object({
    documentation: z.string().url(),
    issues: z.string().url(),
    signup: z.string().url(),
    pricing: z.string().url(),
  }),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

function inventoryFor(
  server: McpServer,
  scope: ToolScope,
): Record<ToolProfile, string[]> {
  return Object.fromEntries(
    Object.keys(TOOL_PROFILES).map((profile) => [
      profile,
      toolNamesForConfiguration(server, {
        scope,
        profile: profile as ToolProfile,
        categories: [...TOOL_PROFILES[profile as ToolProfile]],
        categoriesSource: "profile",
      }),
    ]),
  ) as Record<ToolProfile, string[]>;
}

export function buildCapabilityManifest(
  server: McpServer,
  metadata: CapabilityBuildMetadata,
): CapabilityManifest {
  const resources = Object.entries(serverInternals(server)._registeredResources)
    .filter(([, resource]) => resource.enabled)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uri, resource]) => ({
      name: resource.name,
      uri,
      title: resource.title,
      description: resource.metadata?.description,
      mimeType: resource.metadata?.mimeType,
    }));

  const manifest = {
    schemaVersion: "1.0.0" as const,
    generatedAt: metadata.generatedAt,
    package: metadata,
    configuration: {
      recommended: { scope: "read" as const, profile: "all" as const },
      client: {
        command: "npx" as const,
        args: ["-y", metadata.name, "--scope", "read"],
        environment: [
          {
            name: "OILPRICEAPI_KEY",
            required: false,
            secret: true,
            description:
              "Optional OilPriceAPI key. Omit it for keyless demo and product-facts access.",
          },
          {
            name: "OILPRICEAPI_MCP_SCOPE",
            required: false,
            secret: false,
            description:
              "Tool scope: read (default) or write (explicit opt-in).",
          },
          {
            name: "OILPRICEAPI_MCP_PROFILE",
            required: false,
            secret: false,
            description: "Tool profile: all, core, market, or automation.",
          },
        ],
      },
    },
    commands: {
      version: `${metadata.name} --version`,
      listTools: `${metadata.name} --list-tools --json`,
      doctor: `${metadata.name} doctor`,
      demoDoctor: `${metadata.name} doctor --demo`,
      capabilities: `${metadata.name} --capabilities --json`,
      config: `${metadata.name} --config <client>`,
    },
    profiles: Object.fromEntries(
      Object.entries(TOOL_PROFILES).map(([name, categories]) => [
        name,
        [...categories],
      ]),
    ),
    inventories: {
      read: inventoryFor(server, "read"),
      write: inventoryFor(server, "write"),
    },
    tools: getRegisteredToolEntries(server).map(([name, tool]) => ({
      name,
      title: tool.title || name,
      description: tool.description || "OilPriceAPI MCP tool",
      category: TOOL_CATEGORY_BY_NAME[name],
      access: WRITE_TOOLS.has(name) ? ("write" as const) : ("read" as const),
      apiKey:
        name === "opa_get_product_facts"
          ? ("none" as const)
          : KEYLESS_TOOLS.has(name)
            ? ("optional" as const)
            : ("required" as const),
      entitlement:
        name === "opa_get_product_facts"
          ? ("none" as const)
          : ("account-and-plan-dependent" as const),
      annotations: tool.annotations || {},
    })),
    resources,
    demo: {
      availableWithoutKey: true as const,
      endpoint: "/v1/demo/prices" as const,
    },
    support: {
      documentation: "https://github.com/OilpriceAPI/mcp-server#readme",
      issues: "https://github.com/OilpriceAPI/mcp-server/issues",
      signup: "https://www.oilpriceapi.com/auth/signup?utm_source=mcp-doctor",
      pricing: "https://www.oilpriceapi.com/pricing?utm_source=mcp-doctor",
    },
  };

  return capabilityManifestSchema.parse(manifest);
}

export function validateCapabilityManifest(value: unknown): CapabilityManifest {
  return capabilityManifestSchema.parse(value);
}
