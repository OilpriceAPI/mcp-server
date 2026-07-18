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
      "311a5f0b0b51526605302dc5c2127b8dfb8718aeff4f1b349f62d61bfbff4323",
    );
    expect(PINNED_PRODUCT_FACTS.schemaVersion).toBe("1.0.0");
    expect(PINNED_PRODUCT_FACTS.contractVersion).toBe("2026-07-18");
  });

  it("rejects incompatible schemas and malformed contracts", () => {
    expect(() =>
      validateAndSanitizeProductFacts({
        ...cloneFacts(),
        schemaVersion: "2.0.0",
      }),
    ).toThrow(ProductFactsContractError);
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
      return jsonResponse(
        { ...cloneFacts(), ignoredPublicExtension: "not projected" },
        { etag: '"facts-v1"' },
      );
    }) as unknown as typeof fetch;
    const provider = new ProductFactsProvider({
      fetchImpl,
      now: () => Date.parse("2026-07-18T20:00:00Z"),
    });

    const result = await provider.get();

    expect(result.delivery).toMatchObject({
      source: "canonical",
      upstreamAvailable: true,
      stale: false,
      contractEtag: '"facts-v1"',
    });
    expect(result.facts.contractVersion).toBe("2026-07-18");
    expect(result.facts.developer.authenticationHeader).toBe(
      "Authorization: Token YOUR_API_KEY",
    );
    expect(result.facts).not.toHaveProperty("ignoredPublicExtension");
  });

  it("uses a fresh cache without another upstream request", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(cloneFacts()),
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
      return jsonResponse(cloneFacts());
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
      { ...cloneFacts(), schemaVersion: "9.0.0" },
      { ...cloneFacts(), internalPlanId: "price_do_not_publish" },
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
