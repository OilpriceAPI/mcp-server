import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PRODUCT_FACTS_URI = "oilpriceapi://product-facts";
export const PRODUCT_FACTS_SCHEMA_MAJOR = 1;
export const DEFAULT_PRODUCT_FACTS_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCT_FACTS_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCT_FACTS_TIMEOUT_MS = 3_000;

export interface ProductFacts {
  schemaVersion: string;
  contractVersion: string;
  reviewedAt: string;
  reviewOwner: string;
  schemaUrl: string;
  canonicalUrl: string;
  product: {
    name: string;
    website: string;
    apiBaseUrl: string;
    documentationUrl: string;
    description: string;
  };
  offer: {
    trialScope: string;
    creditCardRequiredForTrial: boolean;
    pricingUrl: string;
    qualification: string;
    trialDays: number;
    trialRequests: number;
    freeRequestsPerMonth: number;
  };
  catalog: {
    publicWording: string;
    exactCountPublished: false;
    catalogUrl: string;
  };
  freshness: {
    publicWording: string;
    fixedSitewideCadence: null;
  };
  dataRights: {
    publicWording: string;
    policyUrl: string;
  };
  developer: {
    authenticationHeader: string;
    environmentVariable: string;
    firstRequestMethod: string;
    firstRequestPath: string;
    firstRequestUrl: string;
    demoRequestUrl: string;
  };
}

export interface ProductFactsDelivery {
  facts: ProductFacts;
  delivery: {
    source: "canonical" | "cache" | "pinned";
    fetchedAt: string;
    upstreamAvailable: boolean;
    stale: boolean;
    contractChecksum: string;
    contractEtag: string;
    warning?: string;
  };
}

type JsonRecord = Record<string, unknown>;

const SENSITIVE_KEY =
  /api[_-]?key|secret|password|customer|account[_-]?state|internal|stripe|plan[_-]?id|unpublished/i;
const SENSITIVE_VALUE =
  /sk_live_[A-Za-z0-9]+|opa_live_[A-Za-z0-9]+|price_[A-Za-z0-9]+/i;

export class ProductFactsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductFactsContractError";
  }
}

function asRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductFactsContractError(name + " must be an object");
  }
  return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductFactsContractError(key + " must be a non-empty string");
  }
  return value;
}

function requiredNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProductFactsContractError(key + " must be a positive number");
  }
  return value;
}

function requiredBoolean(record: JsonRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new ProductFactsContractError(key + " must be a boolean");
  }
  return value;
}

function assertHttps(value: string, key: string): string {
  if (!value.startsWith("https://")) {
    throw new ProductFactsContractError(key + " must use HTTPS");
  }
  return value;
}

function assertNoSensitiveData(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveData(item, path + "[" + index + "]"),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new ProductFactsContractError(
          "sensitive field is not allowed at " + path + "." + key,
        );
      }
      assertNoSensitiveData(child, path + "." + key);
    }
    return;
  }
  if (typeof value === "string" && SENSITIVE_VALUE.test(value)) {
    throw new ProductFactsContractError(
      "secret-like value is not allowed at " + path,
    );
  }
}

export function validateAndSanitizeProductFacts(input: unknown): ProductFacts {
  assertNoSensitiveData(input);
  const root = asRecord(input, "product-facts");
  const product = asRecord(root.product, "product");
  const offer = asRecord(root.offer, "offer");
  const catalog = asRecord(root.catalog, "catalog");
  const freshness = asRecord(root.freshness, "freshness");
  const dataRights = asRecord(root.dataRights, "dataRights");
  const developer = asRecord(root.developer, "developer");

  const schemaVersion = requiredString(root, "schemaVersion");
  if (
    Number.parseInt(schemaVersion.split(".")[0] || "", 10) !==
    PRODUCT_FACTS_SCHEMA_MAJOR
  ) {
    throw new ProductFactsContractError(
      "unsupported product-facts schema " + schemaVersion,
    );
  }

  const contractVersion = requiredString(root, "contractVersion");
  const reviewedAt = requiredString(root, "reviewedAt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contractVersion)) {
    throw new ProductFactsContractError("contractVersion must be an ISO date");
  }
  if (contractVersion !== reviewedAt) {
    throw new ProductFactsContractError(
      "contractVersion and reviewedAt must match",
    );
  }
  if (catalog.exactCountPublished !== false) {
    throw new ProductFactsContractError(
      "catalog exactCountPublished must be false",
    );
  }
  if (freshness.fixedSitewideCadence !== null) {
    throw new ProductFactsContractError(
      "freshness fixedSitewideCadence must be null",
    );
  }

  const facts: ProductFacts = {
    schemaVersion,
    contractVersion,
    reviewedAt,
    reviewOwner: requiredString(root, "reviewOwner"),
    schemaUrl: assertHttps(requiredString(root, "schemaUrl"), "schemaUrl"),
    canonicalUrl: assertHttps(
      requiredString(root, "canonicalUrl"),
      "canonicalUrl",
    ),
    product: {
      name: requiredString(product, "name"),
      website: assertHttps(
        requiredString(product, "website"),
        "product.website",
      ),
      apiBaseUrl: assertHttps(
        requiredString(product, "apiBaseUrl"),
        "product.apiBaseUrl",
      ),
      documentationUrl: assertHttps(
        requiredString(product, "documentationUrl"),
        "product.documentationUrl",
      ),
      description: requiredString(product, "description"),
    },
    offer: {
      trialScope: requiredString(offer, "trialScope"),
      creditCardRequiredForTrial: requiredBoolean(
        offer,
        "creditCardRequiredForTrial",
      ),
      pricingUrl: assertHttps(
        requiredString(offer, "pricingUrl"),
        "offer.pricingUrl",
      ),
      qualification: requiredString(offer, "qualification"),
      trialDays: requiredNumber(offer, "trialDays"),
      trialRequests: requiredNumber(offer, "trialRequests"),
      freeRequestsPerMonth: requiredNumber(offer, "freeRequestsPerMonth"),
    },
    catalog: {
      publicWording: requiredString(catalog, "publicWording"),
      exactCountPublished: false,
      catalogUrl: assertHttps(
        requiredString(catalog, "catalogUrl"),
        "catalog.catalogUrl",
      ),
    },
    freshness: {
      publicWording: requiredString(freshness, "publicWording"),
      fixedSitewideCadence: null,
    },
    dataRights: {
      publicWording: requiredString(dataRights, "publicWording"),
      policyUrl: assertHttps(
        requiredString(dataRights, "policyUrl"),
        "dataRights.policyUrl",
      ),
    },
    developer: {
      authenticationHeader: requiredString(developer, "authenticationHeader"),
      environmentVariable: requiredString(developer, "environmentVariable"),
      firstRequestMethod: requiredString(developer, "firstRequestMethod"),
      firstRequestPath: requiredString(developer, "firstRequestPath"),
      firstRequestUrl: assertHttps(
        requiredString(developer, "firstRequestUrl"),
        "developer.firstRequestUrl",
      ),
      demoRequestUrl: assertHttps(
        requiredString(developer, "demoRequestUrl"),
        "developer.demoRequestUrl",
      ),
    },
  };

  if (
    facts.developer.authenticationHeader !==
      "Authorization: Token YOUR_API_KEY" ||
    facts.developer.environmentVariable !== "OILPRICEAPI_KEY" ||
    facts.developer.firstRequestMethod !== "GET"
  ) {
    throw new ProductFactsContractError(
      "developer product-facts contract is incompatible",
    );
  }

  return facts;
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableFactsDigest(facts: ProductFacts): string {
  return digest(JSON.stringify(facts));
}

function loadPinnedProductFacts(): {
  facts: ProductFacts;
  checksum: string;
} {
  const artifact = readFileSync(
    new URL("./product-facts.v1.json", import.meta.url),
  );
  const expected = readFileSync(
    new URL("./product-facts.v1.sha256", import.meta.url),
    "utf8",
  ).trim();
  const actual = digest(artifact);
  if (actual !== expected) {
    throw new ProductFactsContractError(
      "pinned product-facts checksum mismatch",
    );
  }

  return {
    facts: validateAndSanitizeProductFacts(
      JSON.parse(artifact.toString("utf8")) as unknown,
    ),
    checksum: actual,
  };
}

const pinned = loadPinnedProductFacts();
export const PINNED_PRODUCT_FACTS = pinned.facts;
export const PINNED_PRODUCT_FACTS_CHECKSUM = pinned.checksum;

interface CachedProductFacts {
  facts: ProductFacts;
  fetchedAtMs: number;
  checksum: string;
  etag: string;
}

export interface ProductFactsProviderOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  freshTtlMs?: number;
  maxStaleMs?: number;
  requestHeaders?: Record<string, string>;
  pinnedFacts?: ProductFacts;
  pinnedChecksum?: string;
}

export class ProductFactsProvider {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly freshTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly requestHeaders: Record<string, string>;
  private readonly pinnedFacts: ProductFacts;
  private readonly pinnedChecksum: string;
  private cache?: CachedProductFacts;

  constructor(options: ProductFactsProviderOptions = {}) {
    this.url = options.url ?? "https://api.oilpriceapi.com/product-facts.json";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PRODUCT_FACTS_TIMEOUT_MS;
    this.freshTtlMs = options.freshTtlMs ?? DEFAULT_PRODUCT_FACTS_TTL_MS;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_PRODUCT_FACTS_MAX_STALE_MS;
    this.requestHeaders = {
      Accept: "application/json",
      ...options.requestHeaders,
    };
    this.pinnedFacts = validateAndSanitizeProductFacts(
      options.pinnedFacts ?? PINNED_PRODUCT_FACTS,
    );
    this.pinnedChecksum =
      options.pinnedChecksum ?? PINNED_PRODUCT_FACTS_CHECKSUM;
  }

  clearCache(): void {
    this.cache = undefined;
  }

  async get(): Promise<ProductFactsDelivery> {
    const now = this.now();
    if (this.cache && now - this.cache.fetchedAtMs <= this.freshTtlMs) {
      return this.deliveryFromCache(this.cache, now, false);
    }

    try {
      const remote = await this.fetchCanonical(now);
      this.cache = remote;
      return {
        facts: remote.facts,
        delivery: {
          source: "canonical",
          fetchedAt: new Date(remote.fetchedAtMs).toISOString(),
          upstreamAvailable: true,
          stale: false,
          contractChecksum: remote.checksum,
          contractEtag: remote.etag,
        },
      };
    } catch (error) {
      const warning = publicFailureMessage(error);
      if (this.cache && now - this.cache.fetchedAtMs <= this.maxStaleMs) {
        return this.deliveryFromCache(this.cache, now, true, warning);
      }

      const expiredCacheWarning = this.cache
        ? " Cached canonical product facts exceeded the maximum cache age."
        : "";
      return {
        facts: this.pinnedFacts,
        delivery: {
          source: "pinned",
          fetchedAt: new Date(now).toISOString(),
          upstreamAvailable: false,
          stale: false,
          contractChecksum: this.pinnedChecksum,
          contractEtag: "sha256:" + this.pinnedChecksum,
          warning:
            warning +
            expiredCacheWarning +
            " Serving the checksum-verified package contract reviewed " +
            this.pinnedFacts.reviewedAt +
            ".",
        },
      };
    }
  }

  private deliveryFromCache(
    cached: CachedProductFacts,
    now: number,
    stale: boolean,
    warning?: string,
  ): ProductFactsDelivery {
    return {
      facts: cached.facts,
      delivery: {
        source: "cache",
        fetchedAt: new Date(cached.fetchedAtMs).toISOString(),
        upstreamAvailable: !stale,
        stale,
        contractChecksum: cached.checksum,
        contractEtag: cached.etag,
        ...(warning
          ? {
              warning:
                warning +
                " Serving cached canonical facts from " +
                new Date(cached.fetchedAtMs).toISOString() +
                ".",
            }
          : {}),
      },
    };
  }

  private async fetchCanonical(now: number): Promise<CachedProductFacts> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        headers: this.requestHeaders,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      const facts = validateAndSanitizeProductFacts(await response.json());
      const checksum = stableFactsDigest(facts);
      const etag = response.headers?.get("etag") || "sha256:" + checksum;
      return { facts, fetchedAtMs: now, checksum, etag };
    } finally {
      clearTimeout(timer);
    }
  }
}

function publicFailureMessage(error: unknown): string {
  if (error instanceof ProductFactsContractError) {
    return "Canonical product-facts response failed contract validation.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Canonical product-facts request timed out.";
  }
  return "Canonical product-facts endpoint is unavailable.";
}
