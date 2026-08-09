import { describe, expect, it } from "vitest";
import { createSandboxServer } from "../index.js";
import {
  applyToolConfiguration,
  buildCapabilityManifest,
  getRegisteredToolEntries,
  resolveToolConfiguration,
  validateCapabilityManifest,
  WRITE_TOOL_NAMES,
} from "../toolRegistry.js";

const BUILD_METADATA = {
  name: "oilpriceapi-mcp",
  version: "3.0.0",
  minimumNodeVersion: ">=18.0.0",
  repository: "https://github.com/OilpriceAPI/mcp-server",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  generatedAt: "2026-07-19T12:00:00.000Z",
};

describe("MCP tool scope and profiles", () => {
  it("defaults to a read-only inventory and keeps all definitions registered", () => {
    const server = createSandboxServer();
    const configuration = resolveToolConfiguration({ argv: [], env: {} });
    const enabled = applyToolConfiguration(server, configuration);
    const registered = getRegisteredToolEntries(server);

    expect(configuration).toMatchObject({ scope: "read", profile: "all" });
    expect(registered).toHaveLength(35);
    expect(enabled).toHaveLength(31);
    expect(enabled).toContain("opa_list_price_alerts");
    expect(enabled).toContain("opa_get_subscription_events");
    for (const name of WRITE_TOOL_NAMES) {
      expect(enabled).not.toContain(name);
      expect(
        registered.find(([toolName]) => toolName === name)?.[1].enabled,
      ).toBe(false);
    }
  });

  it("requires explicit write scope before mutation tools are enabled", () => {
    const server = createSandboxServer();
    const configuration = resolveToolConfiguration({
      argv: ["--scope", "write"],
      env: {},
    });
    const enabled = applyToolConfiguration(server, configuration);

    expect(enabled).toHaveLength(35);
    for (const name of WRITE_TOOL_NAMES) expect(enabled).toContain(name);
  });

  it("supports stable profiles and explicit category allowlists", () => {
    const server = createSandboxServer();
    const core = applyToolConfiguration(
      server,
      resolveToolConfiguration({ argv: ["--profile", "core"], env: {} }),
    );
    expect(core).toEqual([
      "opa_compare_prices",
      "opa_get_account_status",
      "opa_get_history",
      "opa_get_plans",
      "opa_get_price",
      "opa_get_product_facts",
      "opa_list_commodities",
      "opa_market_overview",
    ]);

    const categories = applyToolConfiguration(
      server,
      resolveToolConfiguration({
        argv: ["--scope", "write", "--categories", "automation"],
        env: {},
      }),
    );
    expect(categories).toContain("opa_create_price_alert");
    expect(categories).toContain("opa_get_subscription_events");
    expect(categories).not.toContain("opa_get_price");
  });

  it("fails closed on unknown scope, profile, or category values", () => {
    expect(() =>
      resolveToolConfiguration({ argv: ["--scope", "admin"], env: {} }),
    ).toThrow(/Unknown MCP scope/i);
    expect(() =>
      resolveToolConfiguration({ argv: ["--profile", "everything"], env: {} }),
    ).toThrow(/Unknown MCP profile/i);
    expect(() =>
      resolveToolConfiguration({
        argv: ["--categories", "core,secrets"],
        env: {},
      }),
    ).toThrow(/Unknown MCP tool category/i);
  });

  it("fails fast when MCP SDK registration internals are incompatible", () => {
    expect(() => getRegisteredToolEntries({} as never)).toThrow(
      /Incompatible MCP SDK/i,
    );
  });
});

describe("generated MCP capability manifest", () => {
  it("is deterministic, schema-valid, and agrees with every registered tool", () => {
    const server = createSandboxServer();
    const first = buildCapabilityManifest(server, BUILD_METADATA);
    const second = buildCapabilityManifest(server, BUILD_METADATA);

    expect(first).toEqual(second);
    expect(validateCapabilityManifest(first)).toEqual(first);
    expect(first.package).toMatchObject({
      name: "oilpriceapi-mcp",
      version: "3.0.0",
      sourceCommit: BUILD_METADATA.sourceCommit,
    });
    expect(first.configuration.recommended).toEqual({
      scope: "read",
      profile: "all",
    });
    expect(first.tools).toHaveLength(35);
    expect(first.tools.map((tool) => tool.name).sort()).toEqual(
      getRegisteredToolEntries(server)
        .map(([name]) => name)
        .sort(),
    );
    expect(first.resources).toContainEqual(
      expect.objectContaining({ uri: "oilpriceapi://product-facts" }),
    );
    expect(first.inventories.read.all).toHaveLength(31);
    expect(first.inventories.write.all).toHaveLength(35);
  });

  it("contains no credential, account, prompt, or customer response data", () => {
    process.env.OILPRICEAPI_KEY = "opa_live_never_include_this";
    const manifest = buildCapabilityManifest(
      createSandboxServer(),
      BUILD_METADATA,
    );
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain(process.env.OILPRICEAPI_KEY);
    expect(serialized).not.toMatch(
      /customerId|accountState|rawResponse|promptText/,
    );
    expect(serialized).toContain("OILPRICEAPI_KEY");
    delete process.env.OILPRICEAPI_KEY;
  });

  it("accepts omitted optional metadata and preserves it as absent", () => {
    const manifest = buildCapabilityManifest(
      createSandboxServer(),
      BUILD_METADATA,
    );
    const sparse = structuredClone(manifest);
    sparse.tools[0].annotations = {};
    delete sparse.resources[0].title;
    delete sparse.resources[0].description;
    delete sparse.resources[0].mimeType;

    expect(validateCapabilityManifest(sparse)).toEqual(sparse);
  });

  it("reports a structured issue for invalid capability metadata", () => {
    const manifest = buildCapabilityManifest(
      createSandboxServer(),
      BUILD_METADATA,
    );
    const invalid = structuredClone(manifest);
    invalid.package.repository = "not-a-url";

    try {
      validateCapabilityManifest(invalid);
      throw new Error("expected manifest validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ name: "ZodError" });
      expect((error as { issues: unknown[] }).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["package", "repository"] }),
        ]),
      );
    }
  });
});
