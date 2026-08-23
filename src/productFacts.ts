import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PRODUCT_FACTS_URI = "oilpriceapi://product-facts";
export const PRODUCT_FACTS_SCHEMA_MAJOR = 2;
export const SUPPORTED_PRODUCT_FACTS_SCHEMA_MAJORS = [1, 2] as const;
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
    freeRequestLimit: number;
    freeRequestWindow: "day" | "month";
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
    sourceSchemaVersion: string;
    normalization: "native-v2" | "reviewed-v1-daily-bridge";
    warning?: string;
  };
}

type JsonRecord = Record<string, unknown>;
type ProductFactsNormalization = ProductFactsDelivery["delivery"]["normalization"];

interface LegacyV1ProductFacts extends Omit<ProductFacts, "offer"> {
  offer: Omit<
    ProductFacts["offer"],
    "freeRequestLimit" | "freeRequestWindow"
  > & {
    freeRequestsPerMonth: number;
    freeRequestsWindow: "day" | "month";
  };
}

interface ValidatedProductFacts {
  facts: ProductFacts;
  contractChecksum: string;
  sourceSchemaVersion: string;
  normalization: ProductFactsNormalization;
}

const LEGACY_V1_DAILY_BRIDGE_CHECKSUM =
  "f9c67acc4c3ebb44aabff2e6c66fed012c4d551987a1e62f88e43a3aa1ebcf66";

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

function requiredPositiveInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ProductFactsContractError(key + " must be a positive integer");
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

function assertExactKeys(
  record: JsonRecord,
  expectedKeys: readonly string[],
  name: string,
): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(record)
    .filter((key) => !expected.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new ProductFactsContractError(
      `${name} contains unsupported fields (${unexpected.length})`,
    );
  }
}

function assertHttps(value: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductFactsContractError(key + " must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new ProductFactsContractError(key + " must use HTTPS");
  }

  return value;
}

function requiredIsoDate(
  record: JsonRecord,
  key: string,
  maximumDate?: string,
): string {
  const value = requiredString(record, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ProductFactsContractError(key + " must be an ISO date");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ProductFactsContractError(key + " must be a valid ISO date");
  }
  if (maximumDate !== undefined && value > maximumDate) {
    throw new ProductFactsContractError(key + " cannot be in the future");
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

function validateProductFacts(
  input: unknown,
  maximumDate?: string,
): ValidatedProductFacts {
  assertNoSensitiveData(input);
  const root = asRecord(input, "product-facts");
  const product = asRecord(root.product, "product");
  const offer = asRecord(root.offer, "offer");
  const catalog = asRecord(root.catalog, "catalog");
  const freshness = asRecord(root.freshness, "freshness");
  const dataRights = asRecord(root.dataRights, "dataRights");
  const developer = asRecord(root.developer, "developer");

  const schemaVersion = requiredString(root, "schemaVersion");
  const schemaMatch =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(schemaVersion);
  const schemaMajor = schemaMatch ? Number(schemaMatch[1]) : Number.NaN;
  if (
    !SUPPORTED_PRODUCT_FACTS_SCHEMA_MAJORS.includes(
      schemaMajor as (typeof SUPPORTED_PRODUCT_FACTS_SCHEMA_MAJORS)[number],
    )
  ) {
    throw new ProductFactsContractError(
      "unsupported product-facts schema " + schemaVersion,
    );
  }

  assertExactKeys(
    root,
    [
      "schemaVersion",
      "contractVersion",
      "reviewedAt",
      "reviewOwner",
      "schemaUrl",
      "canonicalUrl",
      "product",
      "offer",
      "catalog",
      "freshness",
      "dataRights",
      "developer",
    ],
    "product-facts",
  );
  assertExactKeys(
    product,
    [
      "name",
      "website",
      "apiBaseUrl",
      "documentationUrl",
      "description",
    ],
    "product",
  );
  assertExactKeys(
    offer,
    schemaMajor === 2
      ? [
          "trialScope",
          "creditCardRequiredForTrial",
          "pricingUrl",
          "qualification",
          "trialDays",
          "trialRequests",
          "freeRequestLimit",
          "freeRequestWindow",
        ]
      : [
          "trialScope",
          "creditCardRequiredForTrial",
          "pricingUrl",
          "qualification",
          "trialDays",
          "trialRequests",
          "freeRequestsPerMonth",
          "freeRequestsWindow",
        ],
    "offer",
  );
  assertExactKeys(
    catalog,
    ["publicWording", "exactCountPublished", "catalogUrl"],
    "catalog",
  );
  assertExactKeys(
    freshness,
    ["publicWording", "fixedSitewideCadence"],
    "freshness",
  );
  assertExactKeys(dataRights, ["publicWording", "policyUrl"], "dataRights");
  assertExactKeys(
    developer,
    [
      "authenticationHeader",
      "environmentVariable",
      "firstRequestMethod",
      "firstRequestPath",
      "firstRequestUrl",
      "demoRequestUrl",
    ],
    "developer",
  );

  const contractVersion = requiredIsoDate(
    root,
    "contractVersion",
    maximumDate,
  );
  const reviewedAt = requiredIsoDate(root, "reviewedAt", maximumDate);
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

  const commonFacts = {
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
  } satisfies Omit<ProductFacts, "offer">;

  const expectedSchemaUrl = `https://api.oilpriceapi.com/schemas/product-facts-v${schemaMajor}.schema.json`;
  if (commonFacts.schemaUrl !== expectedSchemaUrl) {
    throw new ProductFactsContractError(
      `schemaUrl must match reviewed schema major ${schemaMajor}`,
    );
  }
  if (
    commonFacts.canonicalUrl !==
      "https://api.oilpriceapi.com/product-facts.json" ||
    commonFacts.product.name !== "OilPriceAPI" ||
    commonFacts.product.apiBaseUrl !== "https://api.oilpriceapi.com"
  ) {
    throw new ProductFactsContractError(
      "product-facts canonical identity is incompatible",
    );
  }

  const commonOffer = {
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
    trialDays: requiredPositiveInteger(offer, "trialDays"),
    trialRequests: requiredPositiveInteger(offer, "trialRequests"),
  };

  let facts: ProductFacts;
  let normalization: ProductFactsNormalization;

  if (schemaMajor === 2) {
    if ("freeRequestsPerMonth" in offer) {
      throw new ProductFactsContractError(
        "native v2 offer cannot include freeRequestsPerMonth",
      );
    }
    const freeRequestWindow = requiredString(offer, "freeRequestWindow");
    if (freeRequestWindow !== "day" && freeRequestWindow !== "month") {
      throw new ProductFactsContractError(
        "freeRequestWindow must be day or month",
      );
    }
    facts = {
      ...commonFacts,
      offer: {
        ...commonOffer,
        freeRequestLimit: requiredPositiveInteger(offer, "freeRequestLimit"),
        freeRequestWindow,
      },
    };
    normalization = "native-v2";
  } else {
    if ("freeRequestLimit" in offer || "freeRequestWindow" in offer) {
      throw new ProductFactsContractError(
        "legacy v1 offer cannot include typed v2 allowance fields",
      );
    }
    const freeRequestsWindow = requiredString(offer, "freeRequestsWindow");
    if (freeRequestsWindow !== "day" && freeRequestsWindow !== "month") {
      throw new ProductFactsContractError(
        "freeRequestsWindow must be day or month",
      );
    }
    const legacyFacts: LegacyV1ProductFacts = {
      ...commonFacts,
      offer: {
        ...commonOffer,
        freeRequestsPerMonth: requiredPositiveInteger(
          offer,
          "freeRequestsPerMonth",
        ),
        freeRequestsWindow,
      },
    };
    const sourceFactsChecksum = stableFactsDigest(legacyFacts);
    if (sourceFactsChecksum !== LEGACY_V1_DAILY_BRIDGE_CHECKSUM) {
      throw new ProductFactsContractError(
        "legacy v1 product-facts contract is not the reviewed daily bridge",
      );
    }
    facts = {
      ...commonFacts,
      schemaVersion: "2.0.0",
      schemaUrl:
        "https://api.oilpriceapi.com/schemas/product-facts-v2.schema.json",
      offer: {
        ...commonOffer,
        freeRequestLimit: 50,
        freeRequestWindow: freeRequestsWindow,
      },
    };
    normalization = "reviewed-v1-daily-bridge";
  }

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

  return {
    facts,
    contractChecksum: stableFactsDigest(facts),
    sourceSchemaVersion: schemaVersion,
    normalization,
  };
}

export function validateAndSanitizeProductFacts(input: unknown): ProductFacts {
  return validateProductFacts(
    input,
    new Date().toISOString().slice(0, 10),
  ).facts;
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableFactsDigest(facts: ProductFacts | LegacyV1ProductFacts): string {
  return digest(JSON.stringify(canonicalize(facts)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function loadPinnedProductFacts(): {
  facts: ProductFacts;
  checksum: string;
  sourceSchemaVersion: string;
  normalization: ProductFactsNormalization;
} {
  const artifact = readFileSync(
    new URL("./product-facts.v2.json", import.meta.url),
  );
  const expected = readFileSync(
    new URL("./product-facts.v2.sha256", import.meta.url),
    "utf8",
  ).trim();
  const actual = digest(artifact);
  if (actual !== expected) {
    throw new ProductFactsContractError(
      "pinned product-facts checksum mismatch",
    );
  }

  const validated = validateProductFacts(
    JSON.parse(artifact.toString("utf8")) as unknown,
  );
  if (validated.normalization !== "native-v2") {
    throw new ProductFactsContractError("pinned product-facts must be native v2");
  }

  return {
    facts: validated.facts,
    checksum: actual,
    sourceSchemaVersion: validated.sourceSchemaVersion,
    normalization: validated.normalization,
  };
}

const pinned = loadPinnedProductFacts();
export const PINNED_PRODUCT_FACTS = deepFreeze(pinned.facts);
export const PINNED_PRODUCT_FACTS_CHECKSUM = pinned.checksum;
export const PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM = stableFactsDigest(
  pinned.facts,
);

interface CachedProductFacts {
  facts: ProductFacts;
  fetchedAtMs: number;
  checksum: string;
  etag: string;
  sourceSchemaVersion: string;
  normalization: ProductFactsNormalization;
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
  private readonly pinnedSourceSchemaVersion: string;
  private readonly pinnedNormalization: ProductFactsNormalization;
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
    const pinnedValidation = validateProductFacts(
      options.pinnedFacts ?? PINNED_PRODUCT_FACTS,
    );
    if (pinnedValidation.normalization !== "native-v2") {
      throw new ProductFactsContractError(
        "provider pinned product-facts must be native v2",
      );
    }
    this.pinnedFacts = deepFreeze(pinnedValidation.facts);
    if (
      options.pinnedChecksum !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.pinnedChecksum)
    ) {
      throw new ProductFactsContractError(
        "provider pinned checksum must be a lowercase SHA-256 digest",
      );
    }
    const projectedChecksum = stableFactsDigest(pinnedValidation.facts);
    const matchesVerifiedBuiltInArtifact =
      options.pinnedFacts === undefined &&
      options.pinnedChecksum === PINNED_PRODUCT_FACTS_CHECKSUM;
    if (
      options.pinnedChecksum !== undefined &&
      options.pinnedChecksum !== projectedChecksum &&
      !matchesVerifiedBuiltInArtifact
    ) {
      throw new ProductFactsContractError(
        "provider pinned facts do not match the supplied checksum",
      );
    }
    this.pinnedChecksum = projectedChecksum;
    this.pinnedSourceSchemaVersion = pinnedValidation.sourceSchemaVersion;
    this.pinnedNormalization = pinnedValidation.normalization;
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
          sourceSchemaVersion: remote.sourceSchemaVersion,
          normalization: remote.normalization,
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
          sourceSchemaVersion: this.pinnedSourceSchemaVersion,
          normalization: this.pinnedNormalization,
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
        sourceSchemaVersion: cached.sourceSchemaVersion,
        normalization: cached.normalization,
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
      const maximumDate = new Date(now).toISOString().slice(0, 10);
      const validated = validateProductFacts(
        await response.json(),
        maximumDate,
      );
      const checksum = validated.contractChecksum;
      const etag = response.headers?.get("etag") || "sha256:" + checksum;
      return {
        facts: deepFreeze(validated.facts),
        fetchedAtMs: now,
        checksum,
        etag,
        sourceSchemaVersion: validated.sourceSchemaVersion,
        normalization: validated.normalization,
      };
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
