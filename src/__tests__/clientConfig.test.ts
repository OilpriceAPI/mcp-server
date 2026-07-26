import { describe, expect, it } from "vitest";
import {
  CLIENT_CONFIG_TARGETS,
  generateClientConfig,
  type ClientConfigTarget,
} from "../clientConfig.js";

const TARGETS = Object.keys(CLIENT_CONFIG_TARGETS) as ClientConfigTarget[];

describe("MCP client config generator", () => {
  it("covers every supported client with deterministic, copy/paste-valid JSON", () => {
    expect(TARGETS).toEqual([
      "claude-desktop",
      "claude-code",
      "cursor",
      "vscode",
      "cline",
      "windsurf",
    ]);

    for (const client of TARGETS) {
      const first = generateClientConfig({ client });
      const second = generateClientConfig({ client });
      expect(first).toEqual(second);
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);
      expect(JSON.stringify(first)).toContain("oilpriceapi-mcp");
      expect(JSON.stringify(first)).toContain("--scope");
      expect(JSON.stringify(first)).toContain("read");
    }
  });

  it("never reads or emits the configured API key", () => {
    process.env.OILPRICEAPI_KEY = "opa_live_must_never_be_printed";
    try {
      for (const client of TARGETS) {
        const serialized = JSON.stringify(generateClientConfig({ client }));
        expect(serialized).not.toContain(process.env.OILPRICEAPI_KEY);
      }
    } finally {
      delete process.env.OILPRICEAPI_KEY;
    }
  });

  it("uses client-supported secret references instead of hard-coded keys", () => {
    expect(
      JSON.stringify(generateClientConfig({ client: "claude-code" })),
    ).toContain("${OILPRICEAPI_KEY}");
    expect(
      JSON.stringify(generateClientConfig({ client: "windsurf" })),
    ).toContain("${env:OILPRICEAPI_KEY}");
    expect(
      JSON.stringify(generateClientConfig({ client: "vscode" })),
    ).toContain("${input:oilpriceapi-key}");
    expect(
      JSON.stringify(generateClientConfig({ client: "cursor" })),
    ).toContain("PASTE_OILPRICEAPI_KEY_HERE");
    expect(
      JSON.stringify(generateClientConfig({ client: "cline" })),
    ).toContain("PASTE_OILPRICEAPI_KEY_HERE");
  });

  it("omits API-key configuration in demo mode", () => {
    for (const client of TARGETS) {
      const serialized = JSON.stringify(
        generateClientConfig({ client, demo: true }),
      );
      expect(serialized).not.toContain("OILPRICEAPI_KEY");
      expect(serialized).not.toContain("oilpriceapi-key");
      expect(serialized).not.toContain("PASTE_");
    }
  });

  it("preserves explicit scope and profile selections", () => {
    const serialized = JSON.stringify(
      generateClientConfig({
        client: "cursor",
        scope: "write",
        profile: "automation",
        categories: ["core", "automation"],
      }),
    );
    expect(serialized).toContain('"--scope","write"');
    expect(serialized).toContain('"--profile","automation"');
    expect(serialized).toContain('"--categories","core,automation"');
  });
});
