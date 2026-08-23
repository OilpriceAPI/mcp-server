import { describe, expect, it, vi } from "vitest";
import {
  PINNED_PRODUCT_FACTS,
  PINNED_PRODUCT_FACTS_CHECKSUM,
  PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM,
  ProductFactsContractError,
  ProductFactsProvider,
  validateAndSanitizeProductFacts,
} from "../productFacts.js";

function cloneFacts(): Record<string, unknown> {
  return structuredClone(PINNED_PRODUCT_FACTS) as unknown as Record<
    string,
    unknown
  >;
}

function legacyV1Facts(): Record<string, unknown> {
  const facts = cloneFacts();
  const offer = facts.offer as Record<string, unknown>;
  delete offer.freeRequestLimit;
  delete offer.freeRequestWindow;
  offer.freeRequestsPerMonth = 50;
  offer.freeRequestsWindow = "day";
  facts.schemaVersion = "1.0.0";
  facts.contractVersion = "2026-08-21";
  facts.reviewedAt = "2026-08-21";
  facts.schemaUrl =
    "https://api.oilpriceapi.com/schemas/product-facts-v1.schema.json";
  return facts;
}

function nativeV2Facts(): Record<string, unknown> {
  return cloneFacts();
}

function jsonResponse(
  body: unknown,
  options: { status?: number; etag?: string } = {},
): Response {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(options.etag ? { etag: options.etag } : undefined),
    json: async () => body,
  } as Response;
}

describe("pinned product-facts contract", () => {
  it("loads only after verifying the reviewed artifact checksum", () => {
    expect(PINNED_PRODUCT_FACTS_CHECKSUM).toBe(
      "62a30d5645a6b50ef81800806af4885169abc2e124d00ada2ca469e8aa71015d",
    );
    expect(PINNED_PRODUCT_FACTS.schemaVersion).toBe("2.0.0");
    expect(PINNED_PRODUCT_FACTS.contractVersion).toBe("2026-08-21");
    expect(PINNED_PRODUCT_FACTS.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(PINNED_PRODUCT_FACTS.offer).not.toHaveProperty(
      "freeRequestsPerMonth",
    );
    expect(Object.isFrozen(PINNED_PRODUCT_FACTS)).toBe(true);
    expect(Object.isFrozen(PINNED_PRODUCT_FACTS.offer)).toBe(true);
  });

  it("accepts native v2 and normalizes the exact reviewed legacy v1 bridge", () => {
    const native = validateAndSanitizeProductFacts(nativeV2Facts());
    const legacy = validateAndSanitizeProductFacts(legacyV1Facts());

    expect(native.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(legacy.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(legacy).toMatchObject({
      schemaVersion: "2.0.0",
      schemaUrl:
        "https://api.oilpriceapi.com/schemas/product-facts-v2.schema.json",
    });
    expect(legacy.offer).not.toHaveProperty("freeRequestsPerMonth");
  });

  it("rejects changed legacy provenance and malformed schema versions", () => {
    const staleLimit = legacyV1Facts();
    (staleLimit.offer as Record<string, unknown>).freeRequestsPerMonth = 200;
    const changedReview = legacyV1Facts();
    changedReview.contractVersion = "2026-08-22";
    changedReview.reviewedAt = "2026-08-22";
    const changedWording = legacyV1Facts();
    (changedWording.catalog as Record<string, unknown>).publicWording =
      "Changed without a new reviewed v2 contract.";
    const unknownRoot = legacyV1Facts();
    unknownRoot.publicExtension = "not part of the reviewed bridge";
    const unknownNested = legacyV1Facts();
    (unknownNested.offer as Record<string, unknown>).resetTimezone = "UTC";
    const missingWindow = legacyV1Facts();
    delete (missingWindow.offer as Record<string, unknown>).freeRequestsWindow;
    const mismatchedWindow = legacyV1Facts();
    (mismatchedWindow.offer as Record<string, unknown>).freeRequestsWindow =
      "month";

    for (const body of [
      staleLimit,
      changedReview,
      changedWording,
      unknownRoot,
      unknownNested,
      missingWindow,
      mismatchedWindow,
      { ...legacyV1Facts(), schemaVersion: "1foo" },
      { ...legacyV1Facts(), schemaVersion: "01.0.0" },
      { ...nativeV2Facts(), schemaVersion: "2foo" },
      { ...nativeV2Facts(), schemaVersion: "02.0.0" },
      { ...nativeV2Facts(), schemaVersion: "3.0.0" },
    ]) {
      expect(() => validateAndSanitizeProductFacts(body)).toThrow(
        ProductFactsContractError,
      );
    }
  });

  it("requires exact native schema identity and rejects unknown v2 fields", () => {
    const wrongSchema = nativeV2Facts();
    wrongSchema.schemaUrl = "https://example.com/product-facts-v2.schema.json";
    const wrongCanonical = nativeV2Facts();
    wrongCanonical.canonicalUrl = "https://example.com/product-facts.json";
    const wrongApiIdentity = nativeV2Facts();
    (wrongApiIdentity.product as Record<string, unknown>).apiBaseUrl =
      "https://example.com";
    const unknownRoot = nativeV2Facts();
    unknownRoot.publicExtension = "not in schema v2";
    const unknownNested = nativeV2Facts();
    (unknownNested.catalog as Record<string, unknown>).marketingCount = 174;

    for (const body of [
      wrongSchema,
      wrongCanonical,
      wrongApiIdentity,
      unknownRoot,
      unknownNested,
    ]) {
      expect(() => validateAndSanitizeProductFacts(body)).toThrow(
        ProductFactsContractError,
      );
    }
  });

  it("rejects mixed legacy and typed allowance fields", () => {
    const mixedV1 = legacyV1Facts();
    (mixedV1.offer as Record<string, unknown>).freeRequestLimit = 50;
    const mixedV2 = nativeV2Facts();
    (mixedV2.offer as Record<string, unknown>).freeRequestsPerMonth = 50;

    for (const body of [mixedV1, mixedV2]) {
      expect(() => validateAndSanitizeProductFacts(body)).toThrow(
        ProductFactsContractError,
      );
    }
  });

  it("rejects a custom pinned contract with a mismatched checksum", () => {
    expect(
      () =>
        new ProductFactsProvider({
          pinnedFacts: PINNED_PRODUCT_FACTS,
          pinnedChecksum: "0".repeat(64),
        }),
    ).toThrow(/do not match the supplied checksum/i);
    expect(
      () =>
        new ProductFactsProvider({
          pinnedFacts: PINNED_PRODUCT_FACTS,
          pinnedChecksum: "",
        }),
    ).toThrow(/lowercase SHA-256 digest/i);
  });

  it("rejects malformed typed allowance values", () => {
    for (const [key, value] of [
      ["freeRequestLimit", 0],
      ["freeRequestLimit", 1.5],
      ["freeRequestWindow", "week"],
      ["freeRequestWindow", ""],
    ] as const) {
      const body = nativeV2Facts();
      (body.offer as Record<string, unknown>)[key] = value;
      expect(() => validateAndSanitizeProductFacts(body)).toThrow(
        ProductFactsContractError,
      );
    }
  });

  it("rejects incomplete contracts", () => {
    expect(() =>
      validateAndSanitizeProductFacts({ schemaVersion: "1.0.0" }),
    ).toThrow(ProductFactsContractError);
  });

  it("rejects secret-like, customer, internal, and unpublished fields", () => {
    for (const unsafe of [
      { apiKey: "do-not-publish" },
      { customerId: "cus_123" },
      { internalPlanId: "price_123" },
      { unpublishedDatasets: ["private-feed"] },
      { note: "opa_live_do_not_publish" },
    ]) {
      expect(() =>
        validateAndSanitizeProductFacts({
          ...cloneFacts(),
          ...unsafe,
        }),
      ).toThrow(ProductFactsContractError);
    }
  });
});

describe("ProductFactsProvider", () => {
  it("keeps checksum-bound facts immutable across cached deliveries", async () => {
    const provider = new ProductFactsProvider({
      fetchImpl: vi.fn(async () =>
        jsonResponse(nativeV2Facts()),
      ) as unknown as typeof fetch,
      now: () => Date.parse("2026-08-21T20:00:00Z"),
    });

    const canonical = await provider.get();
    expect(() => {
      canonical.facts.offer.freeRequestLimit = 999;
    }).toThrow(TypeError);

    const cached = await provider.get();
    expect(cached.facts.offer.freeRequestLimit).toBe(50);
    expect(cached.delivery.contractChecksum).toBe(
      canonical.delivery.contractChecksum,
    );
  });

  it("uses one canonical checksum for identical remote and pinned facts", async () => {
    const canonical = await new ProductFactsProvider({
      fetchImpl: vi.fn(async () =>
        jsonResponse(nativeV2Facts()),
      ) as unknown as typeof fetch,
      now: () => Date.parse("2026-08-21T20:00:00Z"),
    }).get();
    const fallback = await new ProductFactsProvider({
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }).get();

    expect(canonical.delivery.contractChecksum).toBe(
      PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM,
    );
    expect(fallback.delivery.contractChecksum).toBe(
      PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM,
    );
    expect(PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM).not.toBe(
      PINNED_PRODUCT_FACTS_CHECKSUM,
    );
  });

  it("normalizes the legacy built-in artifact checksum option", async () => {
    const fallback = await new ProductFactsProvider({
      pinnedChecksum: PINNED_PRODUCT_FACTS_CHECKSUM,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }).get();

    expect(fallback.delivery.contractChecksum).toBe(
      PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM,
    );
    expect(fallback.delivery.contractEtag).toBe(
      `sha256:${PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM}`,
    );
  });

  it("rejects future remote review dates using the injected clock", async () => {
    const provider = new ProductFactsProvider({
      fetchImpl: vi.fn(async () =>
        jsonResponse(nativeV2Facts()),
      ) as unknown as typeof fetch,
      now: () => Date.parse("2020-01-01T20:00:00Z"),
    });

    const result = await provider.get();

    expect(result.delivery.source).toBe("pinned");
    expect(result.delivery.warning).toContain("failed contract validation");
  });

  it("returns a valid canonical response with version, ETag, and no auth", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      expect(headers.Authorization).toBeUndefined();
      return jsonResponse(nativeV2Facts(), { etag: '"facts-v2"' });
    }) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => Date.parse("2026-08-21T20:00:00Z"),
    });

    const result = await provider.get();

    expect(result.delivery).toMatchObject({
      source: "canonical",
      upstreamAvailable: true,
      stale: false,
      contractEtag: '"facts-v2"',
      sourceSchemaVersion: "2.0.0",
      normalization: "native-v2",
    });
    expect(result.facts.contractVersion).toBe("2026-08-21");
    expect(result.facts.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(result.facts.developer.authenticationHeader).toBe(
      "Authorization: Token YOUR_API_KEY",
    );
  });

  it("labels checksum-bound legacy v1 normalization", async () => {
    const provider = new ProductFactsProvider({
      fetchImpl: vi.fn(async () =>
        jsonResponse(legacyV1Facts()),
      ) as unknown as typeof fetch,
    });

    const result = await provider.get();

    expect(result.delivery).toMatchObject({
      source: "canonical",
      sourceSchemaVersion: "1.0.0",
      normalization: "reviewed-v1-daily-bridge",
    });
    expect(result.facts.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(result.facts.schemaVersion).toBe("2.0.0");
    expect(JSON.stringify(result)).not.toContain("freeRequestsPerMonth");
  });

  it("uses a fresh cache without another upstream request", async () => {
    const base = Date.parse("2026-08-21T20:00:00Z");
    let now = base + 1_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(nativeV2Facts()),
    ) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => now,
      freshTtlMs: 5_000,
    });

    expect((await provider.get()).delivery.source).toBe("canonical");
    now = base + 2_000;
    const cached = await provider.get();

    expect(cached.delivery).toMatchObject({
      source: "cache",
      stale: false,
      upstreamAvailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("labels a bounded stale cache and rejects an expired cache", async () => {
    const base = Date.parse("2026-08-21T20:00:00Z");
    let now = base;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("upstream unavailable");
      return jsonResponse(nativeV2Facts());
    }) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => now,
      freshTtlMs: 1_000,
      maxStaleMs: 5_000,
    });

    expect((await provider.get()).delivery.source).toBe("canonical");
    fail = true;
    now = base + 2_000;
    const stale = await provider.get();
    expect(stale.delivery).toMatchObject({
      source: "cache",
      stale: true,
      upstreamAvailable: false,
    });
    expect(stale.delivery.warning).toContain("cached canonical facts");

    now = base + 6_000;
    const expired = await provider.get();
    expect(expired.delivery).toMatchObject({
      source: "pinned",
      stale: false,
      upstreamAvailable: false,
    });
    expect(expired.delivery.warning).toContain(
      "exceeded the maximum cache age",
    );
    expect(expired.delivery.warning).toContain(
      "checksum-verified package contract",
    );
  });

  it("preserves reviewed v1 bridge provenance only inside the stale bound", async () => {
    const base = Date.parse("2026-08-21T20:00:00Z");
    let now = base;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("upstream unavailable");
      return jsonResponse(legacyV1Facts());
    }) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => now,
      freshTtlMs: 1_000,
      maxStaleMs: 5_000,
    });

    const canonical = await provider.get();
    expect(canonical.delivery).toMatchObject({
      source: "canonical",
      sourceSchemaVersion: "1.0.0",
      normalization: "reviewed-v1-daily-bridge",
    });

    fail = true;
    now = base + 2_000;
    const stale = await provider.get();
    expect(stale.delivery).toMatchObject({
      source: "cache",
      stale: true,
      sourceSchemaVersion: "1.0.0",
      normalization: "reviewed-v1-daily-bridge",
    });
    expect(stale.facts.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });

    now = base + 6_000;
    const expired = await provider.get();
    expect(expired.delivery).toMatchObject({
      source: "pinned",
      stale: false,
      sourceSchemaVersion: "2.0.0",
      normalization: "native-v2",
    });
  });

  it("returns the explicit pinned fallback on timeout", async () => {
    const timeout = Object.assign(new Error("request aborted"), {
      name: "AbortError",
    });
    const provider = new ProductFactsProvider({
      fetchImpl: vi.fn(async () => {
        throw timeout;
      }) as unknown as typeof fetch,
    });

    const result = await provider.get();

    expect(result.delivery.source).toBe("pinned");
    expect(result.delivery.warning).toContain("request timed out");
    expect(result.delivery.contractChecksum).toBe(
      PINNED_PRODUCT_FACTS_CONTRACT_CHECKSUM,
    );
  });

  it("does not expose malformed or sensitive upstream contracts", async () => {
    for (const body of [
      { schemaVersion: "1.0.0" },
      { ...nativeV2Facts(), schemaVersion: "9.0.0" },
      { ...nativeV2Facts(), schemaUrl: "https://example.com/schema.json" },
      { ...nativeV2Facts(), ignoredPublicExtension: "not projected" },
      { ...nativeV2Facts(), internalPlanId: "price_do_not_publish" },
    ]) {
      const provider = new ProductFactsProvider({
        fetchImpl: vi.fn(async () =>
          jsonResponse(body),
        ) as unknown as typeof fetch,
      });

      const result = await provider.get();
      const serialized = JSON.stringify(result);

      expect(result.delivery.source).toBe("pinned");
      expect(result.delivery.warning).toContain("failed contract validation");
      expect(serialized).not.toContain("price_do_not_publish");
      expect(serialized).not.toMatch(/apiKey|customerId|internalPlanId/);
    }
  });
});
