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
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MUTABLE_CLAIMS = [
  {
    label: "absolute commodity-catalog coverage",
    pattern:
      /\b(?:all|every)\s+(?:tracked\s+|available\s+)?(?:commodity|commodities|energy commodities)\s+(?:prices|catalog)\b|\bfull\s+(?:commodity\s+)?catalog\b/gi,
  },
  {
    label: "hard-coded Free feature entitlement",
    pattern:
      /\bfree(?:\s+tier|\s+plan)?\b[^\n.]{0,120}(?:\b\d+\s*(?:active\s+)?(?:watches?|codes?|commodit(?:y|ies)|hours?|minutes?)\b|\b\d+\s*[hm]\b|\b(?:serves|allows|limited to)\b)/gi,
  },
  {
    label: "hard-coded paid-plan price",
    pattern:
      /\b(?:Developer|Starter|Professional|Scale)\b[^\n.]{0,80}\$\d+(?:\.\d+)?(?:\s*\/\s*(?:mo|month)|\s+per\s+month)?/gi,
  },
  {
    label: "absolute as-of knowability",
    pattern:
      /\bas it was knowable\b|\blater[- ]collected rows (?:are )?absent\b/gi,
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
  const roots = ["README.md", "package.json", "server.json", "manifest.json"]
    .map((path) => join(repositoryRoot, path));
  const source = walkFiles(join(repositoryRoot, "src")).filter((path) => {
    const rel = relative(repositoryRoot, path);
    return !rel.includes("/__tests__/") && [".ts", ".json"].includes(extname(path));
  });
  return [...roots, ...source];
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
    "free: 1 watch, 3 codes, 1h minimum interval",
    "Developer, $19/mo",
    "Returns the series as it was knowable then",
    "later-collected rows are absent",
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
