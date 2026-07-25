import { describe, expect, it, vi } from "vitest";
import {
  classifyToolMiss,
  currentToolAttributionHeaders,
  sanitizeToolArguments,
  withToolTelemetry,
} from "../telemetry.js";

describe("privacy-safe MCP tool telemetry", () => {
  it("keeps structured dimensions while redacting free text and identifiers", () => {
    const shape = sanitizeToolArguments({
      commodity: "WTI_USD",
      interval: "1h",
      state: "tx",
      operator: "Private Operator LLC",
      county: "Lea",
      api_number: "42329447130000",
      alert_id: "b4c57f1d-5a77-489b-a816-4439eb9e0136",
      threshold: 72.45,
      notes: "customer prompt content",
    });

    expect(shape).toEqual({
      commodity: "WTI_USD",
      interval: "1h",
      state: "TX",
      operator: "provided",
      county: "provided",
      api_number: "provided",
      alert_id: "provided",
      threshold: "provided",
      notes: "provided",
    });
    expect(JSON.stringify(shape)).not.toContain("Private Operator");
    expect(JSON.stringify(shape)).not.toContain("42329447130000");
    expect(JSON.stringify(shape)).not.toContain("customer prompt");
    expect(JSON.stringify(shape)).not.toContain("72.45");
  });

  it("emits one hit event and exposes bounded attribution inside the call", async () => {
    const lines: string[] = [];
    let headers: Record<string, string> = {};

    const result = await withToolTelemetry(
      "opa_get_price",
      { commodity: "BRENT_CRUDE_USD" },
      () => {
        headers = currentToolAttributionHeaders();
        return { content: [{ type: "text", text: "ok" }] };
      },
      (line) => lines.push(line),
    );

    expect(result.content[0].text).toBe("ok");
    expect(headers["X-OPA-Source"]).toBe("mcp");
    expect(headers["X-OPA-Tool"]).toBe("opa_get_price");
    expect(decodeURIComponent(headers["X-OPA-Argument-Shape"])).toBe(
      '{"commodity":"BRENT_CRUDE_USD"}',
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "mcp_tool_call",
      schema_version: 1,
      tool: "opa_get_price",
      argument_shape: { commodity: "BRENT_CRUDE_USD" },
      outcome: "hit",
    });
  });

  it("classifies local misses without logging their raw argument", async () => {
    const writer = vi.fn();

    await withToolTelemetry(
      "opa_get_price",
      { commodity: "please price my secret contract" },
      () => ({
        content: [{ type: "text", text: "Commodity not recognized" }],
        isError: true,
      }),
      writer,
    );

    const event = JSON.parse(writer.mock.calls[0][0]);
    expect(event).toMatchObject({
      tool: "opa_get_price",
      argument_shape: { commodity: "provided" },
      outcome: "miss",
      miss_reason: "invalid_argument",
    });
    expect(writer.mock.calls[0][0]).not.toContain("secret contract");
  });

  it("keeps large attribution headers bounded and valid JSON", async () => {
    let header = "";
    await withToolTelemetry(
      "opa_get_market_brief",
      {
        codes: Array.from({ length: 25 }, (_, index) =>
          `VERY_LONG_COMMODITY_CODE_${String(index).padStart(2, "0")}`,
        ),
        interval: "1h",
      },
      () => {
        header = currentToolAttributionHeaders()["X-OPA-Argument-Shape"];
        return { content: [{ type: "text", text: "ok" }] };
      },
      () => undefined,
    );

    expect(header.length).toBeLessThanOrEqual(400);
    expect(() => JSON.parse(decodeURIComponent(header))).not.toThrow();
  });

  it("classifies API gate and transport failures into bounded reasons", () => {
    expect(
      classifyToolMiss(Object.assign(new Error("payment required"), { status: 402 })),
    ).toBe("entitlement");
    expect(
      classifyToolMiss(Object.assign(new Error("too many requests"), { status: 429 })),
    ).toBe("rate_limit");
    expect(classifyToolMiss(new Error("network unavailable"))).toBe(
      "unavailable",
    );
  });
});
