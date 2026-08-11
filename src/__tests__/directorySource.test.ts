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
    const normalizedReadme = readme.replace(/\s+/g, " ");
    const numericAllowance =
      /Free(?: plan| API key)?[^\n]{0,160}\d[\d,]*\s+(?:API\s+)?(?:requests?|calls?)\s*(?:\/|per\s+)(?:day|month)/i;
    expect(normalizedReadme).not.toMatch(numericAllowance);
    expect(
      "Free plan\nincludes 1,000 requests/day".replace(/\s+/g, " "),
    ).toMatch(numericAllowance);
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
      for (const match of source.matchAll(/--audit-level=(\w+)/g)) {
        expect(match[1]).toBe("low");
      }
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
      publishWorkflow.indexOf('node "$NPM_CLI" publish "$PACKAGE_FILE"'),
    );
    const publisherPublishIndex = publishWorkflow.indexOf(
      "mcp-publisher publish",
    );
    expect(publisherPublishIndex).toBeGreaterThan(-1);
    expect(publisherPublishIndex).toBeLessThan(
      publishWorkflow.lastIndexOf(
        "node scripts/verify-mcp-registry-release.mjs",
      ),
    );
    expect(packageJson.scripts).toHaveProperty("smoke:release-provenance");
    expect(liveWorkflow).toContain("npm run smoke:release-provenance");
    expect(backfillWorkflow).toContain("fetch-depth: 0");
    expect(backfillWorkflow).toContain(
      "MCP_PROVENANCE_MODE: registry-backfill",
    );
    expect(backfillWorkflow).toContain(
      "node scripts/verify-release-provenance.mjs",
    );
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
    expect(npmPublishJob).not.toMatch(
      /\b(?:npm|npx|pnpm|yarn)\s+(?:ci|exec|install)\b/,
    );
    expect(npmPublishJob).toContain("--ignore-scripts --provenance");
    expect(npmPublishJob).toContain("artifact.sha256");
    expect(npmPublishJob).toContain("EXPECTED_ARTIFACT_MANIFEST_SHA256");
    expect(npmPublishJob).toContain("npm-cli-metadata.json");
    expect(npmPublishJob).toContain('node "$NPM_CLI" publish');
    expect(npmPublishJob).toContain("NPM_RELEASE_EXPECTED_INTEGRITY");
    expect(npmPublishJob).toContain("NPM_RELEASE_EXPECTED_SOURCE_COMMIT");
    expect(npmPublishJob).toContain("node verify-npm-release.mjs");
    expect(verifyJob).toContain('npm pack "npm@$NPM_CLI_VERSION"');
    expect(verifyJob).toContain("$NPM_CLI_INTEGRITY");
    expect(verifyJob).toContain("$NPM_CLI_SHA256");
    expect(npmPublishJob).toContain("$NPM_CLI_SHA256");
    expect(verifyJob).toContain("npm run smoke:npm-verifier");
  });

  it("never exposes production API credentials to pull-request code", () => {
    const liveJobStart = liveWorkflow.indexOf("\n  live:\n");
    expect(liveJobStart).toBeGreaterThan(-1);
    const liveJob = liveWorkflow.slice(liveJobStart);
    expect(liveJob).toContain(
      "if: ${{ github.event_name != 'pull_request' }}",
    );
    expect(liveJob).not.toContain("github.event.pull_request.head.repo.full_name");
    expect(liveJob).toContain(
      "OILPRICEAPI_TEST_KEY: ${{ secrets.OILPRICEAPI_TEST_KEY }}",
    );
  });

  it("runs built-in-only registry gates directly in OIDC jobs", () => {
    const registryStart = publishWorkflow.indexOf("\n  registry:\n");
    expect(registryStart).toBeGreaterThan(-1);
    const publishRegistryJob = publishWorkflow.slice(registryStart);
    for (const workflow of [publishRegistryJob, backfillWorkflow]) {
      expect(workflow).not.toContain("npm run verify:mcp-registry-release");
      expect(workflow).not.toContain("npm run verify:release-provenance");
      expect(workflow).not.toContain("npm run verify:release-metadata");
      expect(workflow).toContain(
        "node scripts/verify-mcp-registry-release.mjs",
      );
    }
  });

  it("pins every workflow action that participates in release proof", () => {
    for (const workflow of [publishWorkflow, backfillWorkflow, liveWorkflow]) {
      for (const match of workflow.matchAll(/uses:\s+(\S+)/g)) {
        const reference = match[1];
        if (reference.startsWith("./")) continue;
        if (reference.startsWith("docker://")) {
          expect(reference).toMatch(/@sha256:[0-9a-f]{64}$/);
        } else {
          expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
        }
      }
    }
  });

  it("proves the packed engine contract on every supported Node line", () => {
    expect(liveWorkflow).toContain('node: ["18", "20", "22", "24"]');
    expect(liveWorkflow).toContain("node-version: ${{ matrix.node }}");
    expect(liveWorkflow).toContain("npm run smoke:package");
    expect(liveWorkflow).toContain("npm run smoke:product-facts");
  });
});
