#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MUTABLE_CLAIMS = [
  {
    label: "absolute commodity-catalog coverage",
    pattern:
      /\b(?:all|every)\s+(?:(?:tracked|available|supported|known)\s+)?(?:commodity|commodities|energy commodities)\s+(?:prices|catalog|data)\b|\b(?:full|complete|entire)\s+(?:(?:commodity|energy)\s+)?catalog\b/gi,
  },
  {
    label: "hard-coded commodity-catalog size",
    pattern:
      /\b\d+(?:,\d{3})*(?:\.\d+)?\+\s+(?:tracked\s+|available\s+|supported\s+)?(?:commodities|commodity\s+(?:codes|prices))\b|\b(?:demo|catalog|dataset|set|supports?|includes?|covers?|offers?|tracks?)\b[^\n.]{0,60}\b\d+(?:,\d{3})*(?:\.\d+)?\+?\s+(?:commodities|commodity\s+(?:codes|prices))\b|\b\d+\s+commodities\s+(?:vs\.?|versus)\s+\d+\+?/gi,
  },
  {
    label: "hard-coded tool inventory",
    pattern:
      /\b\d+(?:,\d{3})*\+?\s+(?:MCP\s+)?tools?\b|\b(?:MCP\s+)?tools?\s*[:=]\s*\d+(?:\s*\/\s*\d+)?\b|\b\d+[- ]tool\s+inventory\b|\btool[- ]count\s*[:=]\s*\d+\b/gi,
  },
  {
    label: "hard-coded Free feature entitlement",
    pattern:
      /\bfree(?:\s+tier|\s+plan|\s+users?)?\b[^\n.]{0,120}(?:\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:active\s+)?(?:watch(?:es)?|codes?|commodit(?:y|ies)|hours?|minutes?)\b|\b\d+\s*[hm]\b|\b(?:serves|allows|includes|supports|limited to|comes with)\b)/gi,
  },
  {
    label: "hard-coded paid-plan entitlement",
    pattern:
      /\b(?:Developer|Starter|Professional|Scale)\b[^\n.]{0,80}(?:\$\d+(?:\.\d+)?(?:\s*\/\s*(?:mo|month)|\s+per\s+month)?|\b(?:plan|tier)\b)|\bReservoir Mastery\b/gi,
  },
  {
    label: "hard-coded request-rate claim",
    pattern:
      /\b\d[\d,]*(?:\.\d+)?\s*(?:API\s+)?(?:requests?|calls?|queries?|hits?|credits?)\s*(?:\/\s*|per\s+|a\s+|every\s+|(?:over|within|in|during)\s+)(?:a\s+|an\s+|\d+\s*)?(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|sec|min|hr|mo|yr)\b/gi,
  },
  {
    label: "absolute as-of knowability",
    pattern:
      /\bas it was knowable\b|\blater[- ]collected rows (?:are )?absent\b|\bno[- ]lookahead\b|\blater revisions (?:are )?rolled back\b/gi,
  },
];

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walkFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

function isText(buffer) {
  return !buffer.subarray(0, 8_192).includes(0);
}

export function findMutableClaims(text) {
  const findings = [];
  for (const claim of MUTABLE_CLAIMS) {
    claim.pattern.lastIndex = 0;
    for (const match of text.matchAll(claim.pattern)) {
      const index = match.index ?? 0;
      findings.push({
        label: claim.label,
        line: text.slice(0, index).split("\n").length,
        excerpt: match[0].replace(/\s+/g, " ").trim(),
      });
    }
  }
  return findings;
}

function sourceSurfaces() {
  const publicExtensions = new Set([
    ".json",
    ".md",
    ".txt",
    ".html",
    ".yml",
    ".yaml",
  ]);
  const roots = readdirSync(repositoryRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== "package-lock.json" &&
        publicExtensions.has(extname(entry.name)),
    )
    .map((entry) => join(repositoryRoot, entry.name));
  const source = walkFiles(join(repositoryRoot, "src")).filter((path) => {
    const rel = relative(repositoryRoot, path).split(sep).join("/");
    if (rel.includes("/__tests__/") || /\.(?:test|spec)\.[^.]+$/.test(rel)) {
      return false;
    }
    const extension = extname(path);
    return (
      [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension) ||
      publicExtensions.has(extension)
    );
  });
  const docs = walkFiles(join(repositoryRoot, "docs")).filter((path) =>
    publicExtensions.has(extname(path)),
  );
  return [...new Set([...roots, ...source, ...docs])];
}

function packedSurfaces() {
  const temp = mkdtempSync(join(tmpdir(), "oilpriceapi-mcp-claims-"));
  try {
    const result = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    );
    const archive = join(temp, result[0].filename);
    execFileSync("tar", ["-xzf", archive, "-C", temp]);
    return walkFiles(join(temp, "package")).map((path) => ({
      displayPath: `npm:${relative(join(temp, "package"), path)}`,
      content: readFileSync(path),
    }));
  } finally {
    // Contents have already been loaded before cleanup.
    rmSync(temp, { recursive: true, force: true });
  }
}

function assertDetectorContract() {
  const positives = [
    "All commodity prices in one call",
    "Full commodity catalog",
    "Free tier allows 3 codes",
    "Free users can create one watch",
    "free: 1 watch, 3 codes, 1h minimum interval",
    "Developer, $19/mo",
    "Professional plan required",
    "Complete energy catalog",
    "174+ commodities",
    "26 MCP tools",
    "tools=36",
    "tools=32/36",
    "MCP tools: 36",
    "36-tool inventory",
    "tool count: 36",
    "tool-count=36",
    "100 API calls/month",
    "10,000 requests over 7 days",
    "Returns the series as it was knowable then",
    "later-collected rows are absent",
    "no lookahead bias",
  ];
  for (const value of positives) {
    if (findMutableClaims(value).length === 0) {
      throw new Error(`claim detector missed its positive fixture: ${value}`);
    }
  }
  const negatives = [
    "All tools are prefixed with opa_",
    "The API returns account-specific entitlements",
    "50 states plus DC",
    "The suite ran 174 tests",
    "Free tier: ${freeLimit} requests/${freeWindow}",
    "Dataset access varies by plan and account entitlement",
  ];
  for (const value of negatives) {
    if (findMutableClaims(value).length > 0) {
      throw new Error(`claim detector rejected its negative fixture: ${value}`);
    }
  }
}

assertDetectorContract();

const surfaces = [
  ...sourceSurfaces().map((path) => ({
    displayPath: relative(repositoryRoot, path),
    content: readFileSync(path),
  })),
  ...packedSurfaces(),
];
const failures = [];
for (const surface of surfaces) {
  if (!isText(surface.content)) continue;
  const text = surface.content.toString("utf8");
  for (const finding of findMutableClaims(text)) {
    failures.push(
      `${surface.displayPath}:${finding.line}: ${finding.label}: ${finding.excerpt}`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(
    `Mutable public claims found in source or packed surfaces:\n${[...new Set(failures)].join("\n")}`,
  );
}

process.stdout.write(
  `Public-claims smoke passed across ${surfaces.length} source and packed surfaces.\n`,
);
