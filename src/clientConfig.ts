import type {
  ToolCategory,
  ToolProfile,
  ToolScope,
} from "./toolRegistry.js";

export const CLIENT_CONFIG_TARGETS = {
  "claude-desktop": "claude_desktop_config.json",
  "claude-code": ".mcp.json",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
  cline: "cline_mcp_settings.json",
  windsurf: "~/.codeium/windsurf/mcp_config.json",
} as const;

export type ClientConfigTarget = keyof typeof CLIENT_CONFIG_TARGETS;

export interface GenerateClientConfigOptions {
  client: ClientConfigTarget;
  packageName?: string;
  scope?: ToolScope;
  profile?: ToolProfile;
  categories?: ToolCategory[];
  demo?: boolean;
}

interface StdioServerConfig {
  type?: "stdio";
  command: "npx";
  args: string[];
  env?: { OILPRICEAPI_KEY: string };
  autoApprove?: string[];
  disabled?: boolean;
  timeout?: number;
  transportType?: "stdio";
}

function stdioServer(
  options: GenerateClientConfigOptions,
  secretReference?: string,
): StdioServerConfig {
  const args = [
    "-y",
    options.packageName ?? "oilpriceapi-mcp",
    "--scope",
    options.scope ?? "read",
    "--profile",
    options.profile ?? "all",
  ];
  if (options.categories?.length) {
    args.push("--categories", options.categories.join(","));
  }
  return {
    command: "npx",
    args,
    ...(!options.demo && secretReference
      ? { env: { OILPRICEAPI_KEY: secretReference } }
      : {}),
  };
}

export function isClientConfigTarget(
  value: string,
): value is ClientConfigTarget {
  return value in CLIENT_CONFIG_TARGETS;
}

/**
 * Build a client-native JSON object without ever reading the process
 * environment. Clients with documented interpolation or secure inputs use
 * those mechanisms; clients that require literal env values receive an
 * unmistakable local replacement marker.
 */
export function generateClientConfig(
  options: GenerateClientConfigOptions,
): Record<string, unknown> {
  if (options.client === "vscode") {
    const server = {
      type: "stdio" as const,
      ...stdioServer(
        options,
        options.demo ? undefined : "${input:oilpriceapi-key}",
      ),
    };
    return {
      ...(!options.demo
        ? {
            inputs: [
              {
                type: "promptString",
                id: "oilpriceapi-key",
                description: "OilPriceAPI API key",
                password: true,
              },
            ],
          }
        : {}),
      servers: { oilpriceapi: server },
    };
  }

  const secretReference =
    options.client === "claude-code"
      ? "${OILPRICEAPI_KEY}"
      : options.client === "windsurf"
        ? "${env:OILPRICEAPI_KEY}"
        : "PASTE_OILPRICEAPI_KEY_HERE";
  const server = stdioServer(options, secretReference);

  if (options.client === "cline") {
    return {
      mcpServers: {
        oilpriceapi: {
          ...server,
          autoApprove: [],
          disabled: false,
          timeout: 60,
          transportType: "stdio",
        },
      },
    };
  }

  return { mcpServers: { oilpriceapi: server } };
}
