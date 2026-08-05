import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readRepositoryFile = (path: string) =>
  readFileSync(new URL(path, `file://${repositoryRoot}/`), "utf8");

describe("directory-facing source metadata", () => {
  const readme = readRepositoryFile("README.md");
  const server = JSON.parse(readRepositoryFile("server.json"));

  it("links the canonical product contract and official MCP Registry record", () => {
    expect(readme).toContain("https://api.oilpriceapi.com/product-facts.json");
    expect(readme).toContain(
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.OilpriceAPI%2Fmcp-server/versions/latest",
    );
  });

  it("uses the direct account-creation route on directory-facing surfaces", () => {
    expect(readme).not.toMatch(/oilpriceapi\.com\/signup(?:\?|\b)/i);

    const apiKeyDescription = server.packages[0].environmentVariables.find(
      (entry: { name: string }) => entry.name === "OILPRICEAPI_KEY",
    ).description;
    expect(apiKeyDescription).toContain("oilpriceapi.com/auth/signup");
    expect(apiKeyDescription).not.toMatch(
      /oilpriceapi\.com\/signup(?:\?|\b)/i,
    );
  });
});
