import { describe, expect, it, vi } from "vitest";
import {
  PINNED_PRODUCT_FACTS,
  PINNED_PRODUCT_FACTS_CHECKSUM,
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
  facts.schemaVersion = "1.0.0";
  facts.contractVersion = "2026-07-18";
  facts.reviewedAt = "2026-07-18";
  facts.schemaUrl =
    "https://api.oilpriceapi.com/schemas/product-facts-v1.schema.json";
  return facts;
}

function nativeV2Facts(): Record<string, unknown> {
  const facts = legacyV1Facts();
  const offer = facts.offer as Record<string, unknown>;
  delete offer.freeRequestsPerMonth;
  offer.freeRequestLimit = 50;
  offer.freeRequestWindow = "day";
  facts.schemaVersion = "2.0.0";
  facts.contractVersion = "2026-08-11";
  facts.reviewedAt = "2026-08-11";
  facts.schemaUrl =
    "https://api.oilpriceapi.com/schemas/product-facts-v2.schema.json";
  return facts;
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
      "2f2a3a7a0e64177485a583a2bf143dc19486821bd5c21141deae64fc7f3ad529",
    );
    expect(PINNED_PRODUCT_FACTS.schemaVersion).toBe("2.0.0");
    expect(PINNED_PRODUCT_FACTS.contractVersion).toBe("2026-08-11");
    expect(PINNED_PRODUCT_FACTS.offer).toMatchObject({
      freeRequestLimit: 50,
      freeRequestWindow: "day",
    });
    expect(PINNED_PRODUCT_FACTS.offer).not.toHaveProperty(
      "freeRequestsPerMonth",
    );
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
    expect(legacy.offer).not.toHaveProperty("freeRequestsPerMonth");
  });

  it("rejects changed legacy provenance and malformed schema versions", () => {
    const staleLimit = legacyV1Facts();
    (staleLimit.offer as Record<string, unknown>).freeRequestsPerMonth = 200;
    const changedReview = legacyV1Facts();
    changedReview.contractVersion = "2026-08-11";
    changedReview.reviewedAt = "2026-08-11";
    const changedWording = legacyV1Facts();
    (changedWording.catalog as Record<string, unknown>).publicWording =
      "Changed without a new reviewed v2 contract.";
    const unknownRoot = legacyV1Facts();
    unknownRoot.publicExtension = "not part of the reviewed bridge";
    const unknownNested = legacyV1Facts();
    (unknownNested.offer as Record<string, unknown>).resetTimezone = "UTC";

    for (const body of [
      staleLimit,
      changedReview,
      changedWording,
      unknownRoot,
      unknownNested,
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
  it("returns a valid canonical response with version, ETag, and no auth", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      expect(headers.Authorization).toBeUndefined();
      return jsonResponse(nativeV2Facts(), { etag: '"facts-v2"' });
    }) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => Date.parse("2026-08-11T20:00:00Z"),
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
    expect(result.facts.contractVersion).toBe("2026-08-11");
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
    expect(JSON.stringify(result)).not.toContain("freeRequestsPerMonth");
  });

  it("uses a fresh cache without another upstream request", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(nativeV2Facts()),
    ) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => now,
      freshTtlMs: 5_000,
    });

    expect((await provider.get()).delivery.source).toBe("canonical");
    now = 2_000;
    const cached = await provider.get();

    expect(cached.delivery).toMatchObject({
      source: "cache",
      stale: false,
      upstreamAvailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("labels a bounded stale cache and rejects an expired cache", async () => {
    let now = 0;
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
    now = 2_000;
    const stale = await provider.get();
    expect(stale.delivery).toMatchObject({
      source: "cache",
      stale: true,
      upstreamAvailable: false,
    });
    expect(stale.delivery.warning).toContain("cached canonical facts");

    now = 6_000;
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
    let now = 0;
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
    now = 2_000;
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

    now = 6_000;
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
      PINNED_PRODUCT_FACTS_CHECKSUM,
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
