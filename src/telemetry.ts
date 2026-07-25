import { AsyncLocalStorage } from "node:async_hooks";

export type ToolTelemetryMissReason =
  | "missing_api_key"
  | "invalid_argument"
  | "not_found"
  | "entitlement"
  | "rate_limit"
  | "unavailable"
  | "upstream_error"
  | "unknown";

export interface ToolTelemetryEvent {
  event: "mcp_tool_call";
  schema_version: 1;
  tool: string;
  argument_shape: Record<string, string | number | boolean | string[]>;
  outcome: "hit" | "miss";
  miss_reason?: ToolTelemetryMissReason;
}

interface ToolCallContext {
  tool: string;
  argumentShape: Record<string, string | number | boolean | string[]>;
}

const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

const ENUM_ARGUMENTS = new Set([
  "action",
  "category",
  "carrier",
  "group_by",
  "interval",
  "mode",
  "period",
  "profile",
  "scope",
  "source",
  "status",
  "view",
]);

const DATE_ARGUMENTS = new Set([
  "date",
  "end_date",
  "from_date",
  "start_date",
  "to_date",
]);

const PRESENCE_ONLY_ARGUMENTS = new Set([
  "address",
  "alert_id",
  "api_number",
  "county",
  "formation",
  "name",
  "operator",
  "pru_number",
  "subscription_id",
  "well_name",
]);

const NUMERIC_SHAPE_ARGUMENTS = new Set([
  "cursor",
  "days",
  "limit",
  "months",
  "page",
  "per_page",
  "radius_miles",
]);

function safeEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized)
    ? normalized
    : undefined;
}

function safeCommodityCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_:-]{1,39}$/.test(normalized)
    ? normalized
    : undefined;
}

function safeDateShape(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (/^\d{4}-\d{2}$/.test(value)) return "month";
  return "provided";
}

function presenceShape(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? "provided" : undefined;
  return value === undefined || value === null ? undefined : "provided";
}

function numericShape(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.trunc(value), 10_000))
    : undefined;
}

/**
 * Build a deliberately lossy argument summary. Free text, IDs, API numbers,
 * coordinates, thresholds, and names are never emitted verbatim.
 */
export function sanitizeToolArguments(
  args: unknown,
): Record<string, string | number | boolean | string[]> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};

  const safe: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;

    if (key === "state") {
      const state =
        typeof value === "string" && /^[a-z]{2}$/i.test(value.trim())
          ? value.trim().toUpperCase()
          : presenceShape(value);
      if (state) safe[key] = state;
      continue;
    }

    if (key === "commodity" || key === "code") {
      safe[key] = safeCommodityCode(value) ?? "provided";
      continue;
    }

    if (key === "codes" || key === "commodities") {
      if (Array.isArray(value)) {
        safe[key] = value
          .slice(0, 25)
          .map((item) => safeCommodityCode(item) ?? "provided");
      } else {
        safe[key] = "provided";
      }
      continue;
    }

    if (ENUM_ARGUMENTS.has(key)) {
      safe[key] = safeEnum(value) ?? "provided";
      continue;
    }

    if (DATE_ARGUMENTS.has(key)) {
      safe[key] = safeDateShape(value) ?? "provided";
      continue;
    }

    if (PRESENCE_ONLY_ARGUMENTS.has(key)) {
      const shape = presenceShape(value);
      if (shape) safe[key] = shape;
      continue;
    }

    if (NUMERIC_SHAPE_ARGUMENTS.has(key)) {
      const shape = numericShape(value);
      if (shape !== undefined) safe[key] = shape;
      continue;
    }

    if (typeof value === "boolean") {
      safe[key] = value;
      continue;
    }

    safe[key] = "provided";
  }

  return safe;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item &&
      typeof item === "object" &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : "",
    )
    .join(" ")
    .slice(0, 1_000)
    .toLowerCase();
}

export function classifyToolMiss(
  resultOrError: unknown,
): ToolTelemetryMissReason {
  const status =
    resultOrError &&
    typeof resultOrError === "object" &&
    "status" in resultOrError &&
    typeof resultOrError.status === "number"
      ? resultOrError.status
      : undefined;
  const message =
    resultOrError instanceof Error
      ? resultOrError.message.toLowerCase()
      : resultText(resultOrError);

  if (
    message.includes("no oilpriceapi_key") ||
    message.includes("requires an api key")
  ) {
    return "missing_api_key";
  }
  if (
    status === 402 ||
    status === 403 ||
    message.includes("not included in the current plan")
  ) {
    return "entitlement";
  }
  if (status === 429 || message.includes("rate limit")) return "rate_limit";
  if (
    message.includes("not recognized") ||
    message.includes("requires a state") ||
    message.includes("must be") ||
    message.includes("invalid")
  ) {
    return "invalid_argument";
  }
  if (status === 404 || message.includes("not found")) return "not_found";
  if (
    message.includes("not available") ||
    message.includes("unavailable") ||
    message.includes("outside current coverage")
  ) {
    return "unavailable";
  }
  if (
    status === 0 ||
    (status !== undefined && status >= 500) ||
    message.includes("temporarily") ||
    message.includes("network")
  ) {
    return "upstream_error";
  }
  return "unknown";
}

function isErrorResult(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      "isError" in result &&
      result.isError === true,
  );
}

export async function withToolTelemetry<T>(
  tool: string,
  args: unknown,
  handler: () => Promise<T> | T,
  writer: (line: string) => void = console.error,
): Promise<T> {
  const context: ToolCallContext = {
    tool,
    argumentShape: sanitizeToolArguments(args),
  };

  return toolCallContext.run(context, async () => {
    try {
      const result = await handler();
      const miss = isErrorResult(result);
      const event: ToolTelemetryEvent = {
        event: "mcp_tool_call",
        schema_version: 1,
        tool,
        argument_shape: context.argumentShape,
        outcome: miss ? "miss" : "hit",
        ...(miss ? { miss_reason: classifyToolMiss(result) } : {}),
      };
      writer(JSON.stringify(event));
      return result;
    } catch (error) {
      const event: ToolTelemetryEvent = {
        event: "mcp_tool_call",
        schema_version: 1,
        tool,
        argument_shape: context.argumentShape,
        outcome: "miss",
        miss_reason: classifyToolMiss(error),
      };
      writer(JSON.stringify(event));
      throw error;
    }
  });
}

/**
 * Attribution that accompanies API requests. The encoded shape is bounded for
 * proxy/header safety and contains no raw free text or identifiers.
 */
export function currentToolAttributionHeaders(): Record<string, string> {
  const context = toolCallContext.getStore();
  if (!context) return {};

  const boundedShape: Record<
    string,
    string | number | boolean | string[]
  > = {};
  for (const [key, value] of Object.entries(context.argumentShape)) {
    const candidate = { ...boundedShape, [key]: value };
    if (encodeURIComponent(JSON.stringify(candidate)).length <= 400) {
      boundedShape[key] = value;
    }
  }
  const encodedShape = encodeURIComponent(JSON.stringify(boundedShape));
  return {
    "X-OPA-Source": "mcp",
    "X-OPA-Tool": context.tool.slice(0, 80),
    "X-OPA-Argument-Shape": encodedShape,
  };
}
