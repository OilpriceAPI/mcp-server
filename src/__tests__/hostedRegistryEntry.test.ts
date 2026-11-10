import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "../energyPlugin.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) =>
  readFileSync(new URL(path, `file://${repositoryRoot}/`), "utf8");

// website-clean#2877: the hosted energy_* server at mcp.oilpriceapi.com/mcp
// gets its own official MCP Registry identity. It must never share a name
// with the npm opa_*/stdio record (#146), and its version must track the
// serverInfo version the hosted endpoint reports (energyPlugin PLUGIN_VERSION).
describe("hosted MCP registry entry", () => {
  const hosted = JSON.parse(read("server.hosted.json"));
  const stdio = JSON.parse(read("server.json"));
  const workflow = read(".github/workflows/registry-hosted.yml");

  it("is a separate identity from the npm stdio record", () => {
    expect(hosted.name).toMatch(/^io\.github\.OilpriceAPI\//);
    expect(hosted.name).not.toBe(stdio.name);
    expect(stdio).not.toHaveProperty("remotes");
  });

  it("describes only the hosted streamable-http endpoint", () => {
    expect(hosted).not.toHaveProperty("packages");
    expect(hosted.remotes).toEqual([
      { type: "streamable-http", url: "https://mcp.oilpriceapi.com/mcp" },
    ]);
  });

  it("versions with the hosted server's serverInfo", () => {
    expect(hosted.version).toBe(PLUGIN_VERSION);
  });

  it("fits the registry's 100-character description limit", () => {
    expect(hosted.description.length).toBeLessThanOrEqual(100);
    expect(hosted.$schema).toBe(stdio.$schema);
  });

  it("publishes only by manual dispatch from main, with a readback", () => {
    expect(workflow).toMatch(/on:\n\s+workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n\s+(push|release|schedule):/);
    expect(workflow).toContain("mcp-publisher validate server.hosted.json");
    expect(workflow).toContain("mcp-publisher publish server.hosted.json");
    expect(workflow).toContain("io.github.OilpriceAPI%2Fhosted-energy");
  });
});
