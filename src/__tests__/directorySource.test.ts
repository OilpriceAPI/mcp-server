import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readRepositoryFile = (path: string) =>
  readFileSync(new URL(path, `file://${repositoryRoot}/`), "utf8");

describe("directory-facing source metadata", () => {
  const readme = readRepositoryFile("README.md");
  const server = JSON.parse(readRepositoryFile("server.json"));
  const packageJson = JSON.parse(readRepositoryFile("package.json"));
  const liveWorkflow = readRepositoryFile(".github/workflows/live-tests.yml");
  const publishWorkflow = readRepositoryFile(".github/workflows/publish.yml");
  const backfillWorkflow = readRepositoryFile(
    ".github/workflows/registry-backfill.yml",
  );

  it("links the canonical product contract and official MCP Registry record", () => {
    expect(readme).toContain("https://api.oilpriceapi.com/product-facts.json");
    expect(readme).toContain(
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.OilpriceAPI%2Fmcp-server/versions/latest",
    );
  });

  it("does not hard-code a numeric post-trial Free allowance", () => {
    expect(readme).not.toMatch(
      /Free(?: plan| API key)?[^\n]{0,160}\d[\d,]*\s+(?:API\s+)?(?:requests?|calls?)\s*(?:\/|per\s+)(?:day|month)/i,
    );
    expect(readme).toContain(
      "https://api.oilpriceapi.com/product-facts.json",
    );
    expect(readme).toContain("current Free allowance and reset window");
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

  it("requires a literal zero-vulnerability audit gate", () => {
    expect(packageJson.scripts.prepublishOnly).toContain("--audit-level=low");
    expect(liveWorkflow).toContain("npm audit --audit-level=low");
    expect(publishWorkflow).toContain("npm audit --audit-level=low");
    for (const source of [
      packageJson.scripts.prepublishOnly,
      liveWorkflow,
      publishWorkflow,
    ]) {
      expect(source).not.toContain("--audit-level=moderate");
    }
  });

  it("scans recursive source and exact packed surfaces before publish", () => {
    expect(packageJson.scripts.prepublishOnly).toContain(
      "npm run smoke:public-claims",
    );
    expect(liveWorkflow).toContain("npm run smoke:public-claims");
    expect(publishWorkflow).toContain("npm run smoke:public-claims");
  });

  it("pins and verifies the OIDC registry publisher supply chain", () => {
    const checksum =
      "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc";
    for (const workflow of [publishWorkflow, backfillWorkflow]) {
      expect(workflow).toContain("v1.8.1");
      expect(workflow).toContain(checksum);
      expect(workflow).toContain("sha256sum -c -");
      expect(workflow).not.toContain("releases/latest");
    }
  });

  it("fails closed on release ancestry and registry drift", () => {
    expect(publishWorkflow).toContain("fetch-depth: 0");
    expect(publishWorkflow).toContain("npm run verify:release-provenance");
    expect(publishWorkflow.indexOf("mcp-publisher validate")).toBeGreaterThan(
      -1,
    );
    expect(publishWorkflow.indexOf("mcp-publisher validate")).toBeLessThan(
      publishWorkflow.indexOf("npm publish \"$PACKAGE_FILE\""),
    );
    expect(publishWorkflow.indexOf("mcp-publisher publish")).toBeLessThan(
      publishWorkflow.lastIndexOf("verify:mcp-registry-release"),
    );
    expect(packageJson.scripts).toHaveProperty("smoke:release-provenance");
    expect(liveWorkflow).toContain("npm run smoke:release-provenance");
  });

  it("keeps dependency execution outside OIDC publication jobs", () => {
    const verifyStart = publishWorkflow.indexOf("\n  verify:\n");
    const publishStart = publishWorkflow.indexOf("\n  publish:\n");
    const registryStart = publishWorkflow.indexOf("\n  registry:\n");
    expect(verifyStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(verifyStart);
    expect(registryStart).toBeGreaterThan(publishStart);

    const verifyJob = publishWorkflow.slice(verifyStart, publishStart);
    const npmPublishJob = publishWorkflow.slice(publishStart, registryStart);
    expect(verifyJob).toContain("npm ci");
    expect(verifyJob).not.toContain("id-token: write");
    expect(npmPublishJob).toContain("id-token: write");
    expect(npmPublishJob).not.toContain("npm ci");
    expect(npmPublishJob).not.toContain("npm test");
    expect(npmPublishJob).toContain("--ignore-scripts --provenance");
    expect(npmPublishJob).toContain("EXPECTED_INTEGRITY");
    expect(npmPublishJob).toContain("Public npm readback verified");
  });
});
