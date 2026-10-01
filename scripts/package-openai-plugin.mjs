import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const endpoint = process.argv[2];
if (!endpoint) throw new Error("Provide the public HTTPS MCP endpoint");
const url = new URL(endpoint);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/mcp" ||
  url.search ||
  url.hash
)
  throw new Error("A stable credential-free HTTPS /mcp endpoint is required");
const destination = new URL("../artifacts/openai-plugin/", import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(
  new URL("../openai-plugin/plugin.json", import.meta.url),
  new URL("plugin.json", destination),
);
await cp(
  new URL("../openai-plugin/assets/", import.meta.url),
  new URL("assets/", destination),
  { recursive: true },
);
await cp(
  new URL("../skills/", import.meta.url),
  new URL("skills/", destination),
  { recursive: true },
);
await writeFile(
  new URL("mcp.json", destination),
  JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { oilpriceapi: { type: "streamable-http", url: endpoint } },
    },
    null,
    2,
  ) + "\n",
);
const manifest = JSON.parse(
  await readFile(new URL("plugin.json", destination), "utf8"),
);
const tests = manifest.extensions["com.openai"].review.test_cases;
if (tests.positive.length !== 5 || tests.negative.length !== 3)
  throw new Error("Exactly 5 positive and 3 negative review cases required");
const skill = await readFile(
  new URL("skills/energy-markets/SKILL.md", destination),
  "utf8",
);
if (!skill.startsWith("---\nname: energy-markets\ndescription:"))
  throw new Error("Skill frontmatter is invalid");
const zip = new URL(
  "../artifacts/oilpriceapi-openai-plugin-0.1.0.zip",
  import.meta.url,
);
await rm(zip, { force: true });
execFileSync("zip", ["-qr", zip.pathname, "."], { cwd: destination });
console.log(
  JSON.stringify({
    zip: zip.pathname,
    endpoint,
    positive: tests.positive.length,
    negative: tests.negative.length,
    submission_ready: false,
  }),
);
