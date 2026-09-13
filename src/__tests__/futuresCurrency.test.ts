import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #87 — futures prices must carry their ACTUAL currency and unit.
// Both handlers prefixed every price with '$'. TTF settles in EUR/MWh and
// UKA in GBP/tCO2, so "$80.15" for TTF is a wrong answer, not a cosmetic one.
//
// Currencies below are the ones production returned on 2026-09-13 for each
// instrument (GET /v1/futures/{slug} -> front_month.currency):
//   brent USD  wti USD  gasoil USD  natural-gas USD  lng-jkm USD
//   ttf-gas EUR  eu-carbon EUR  uk-carbon GBP
// The curve endpoint (GET /v1/futures/{slug}/curve) returns NO currency field
// at any level — verified live on ttf-gas/curve the same day.

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const server = createSandboxServer();
const tools = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** Shape of GET /v1/futures/{slug} as production serves it. */
function latestBody(
  price: number,
  currency?: string,
  month = "2026-10",
): Record<string, unknown> {
  const contract: Record<string, unknown> = {
    code: `X_FUTURES_${month.replace("-", "_")}`,
    contract_month: month,
    last_price: price,
    is_front_month: true,
  };
  if (currency !== undefined) contract.currency = currency;
  return { front_month: contract, contracts: [contract] };
}

/** Shape of GET /v1/futures/{slug}/curve — note: no currency anywhere. */
function curveBody(prices: Array<[string, number]>): Record<string, unknown> {
  return {
    analysis_date: "2026-09-11",
    curve_type: "backwardation",
    contracts: prices.map(([m, p]) => ({
      contract_month: m,
      contract_code: `X_FUTURES_${m.replace("-", "_")}`,
      settlement_price: p,
    })),
  };
}

describe("opa_get_futures renders the response currency (#87)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("TTF in EUR is never rendered as dollars", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = okFetch(latestBody(80.15, "EUR"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await tools.opa_get_futures.handler(
      { contract: "ttf-gas" },
      {},
    );
    const body = text(result);

    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(
      "/v1/futures/ttf-gas",
    );
    expect(body).toContain("€80.15");
    expect(body).toContain("EUR");
    expect(body).toContain("MWh");
    expect(body).not.toContain("$80.15");
    expect(body).not.toContain("$");
  });

  it("UK carbon in GBP is never rendered as dollars", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(latestBody(61.6, "GBP")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "uk-carbon" }, {}),
    );

    expect(body).toContain("£61.60");
    expect(body).toContain("GBP");
    expect(body).not.toContain("$");
  });

  it("GBp (pence) is kept distinct from GBP and never shown as pounds", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(latestBody(6160, "GBp")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "uk-carbon" }, {}),
    );

    expect(body).toContain("GBp");
    expect(body).toContain("pence");
    expect(body).not.toContain("£6160.00");
    expect(body).not.toContain("$");
  });

  it("USD Brent still renders as dollars, with its unit", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(latestBody(104.32, "USD")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "brent" }, {}),
    );

    expect(body).toContain("$104.32");
    expect(body).toContain("USD");
    expect(body).toContain("bbl");
  });

  it("Gasoil is priced per tonne, not per barrel", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(latestBody(1478.0, "USD")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "gasoil" }, {}),
    );

    expect(body).toContain("$1478.00");
    expect(body).toContain("tonne");
    expect(body).not.toContain("bbl");
  });

  it("a currency the response reports overrides the instrument default", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    // Instrument default for brent is USD; the response says otherwise.
    vi.stubGlobal("fetch", okFetch(latestBody(90.0, "EUR")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "brent" }, {}),
    );

    expect(body).toContain("€90.00");
    expect(body).not.toContain("$90.00");
  });

  it("a zero price still carries its currency", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(latestBody(0, "EUR")));

    const body = text(
      await tools.opa_get_futures.handler({ contract: "ttf-gas" }, {}),
    );

    expect(body).toContain("€0.00");
    expect(body).not.toContain("$");
  });
});

describe("opa_get_futures_curve renders the instrument currency (#87)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a TTF curve is quoted in EUR/MWh, not dollars", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const fetchSpy = okFetch(
      curveBody([
        ["2026-10", 81.5],
        ["2026-11", 79.83],
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await tools.opa_get_futures_curve.handler(
      { contract: "ttf-gas" },
      {},
    );
    const body = text(result);

    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(
      "/v1/futures/ttf-gas/curve",
    );
    expect(body).toContain("€81.50");
    expect(body).toContain("€79.83");
    expect(body).toContain("EUR");
    expect(body).toContain("MWh");
    expect(body).not.toContain("$");
  });

  it("a UK carbon curve is quoted in GBP", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(curveBody([["2026-09", 61.6]])));

    const body = text(
      await tools.opa_get_futures_curve.handler({ contract: "uk-carbon" }, {}),
    );

    expect(body).toContain("£61.60");
    expect(body).not.toContain("$");
  });

  it("a Brent curve keeps dollars and says so", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(
        curveBody([
          ["2026-11", 104.32],
          ["2027-05", 98.1],
        ]),
      ),
    );

    const body = text(
      await tools.opa_get_futures_curve.handler({ contract: "brent" }, {}),
    );

    expect(body).toContain("$104.32");
    expect(body).toContain("USD");
    expect(body).toContain("bbl");
    // The market-structure line must use the same currency, not a bare '$'.
    expect(body).toMatch(/Market Structure.*\$104\.32.*\$98\.10/s);
  });

  it("does not invent an FX conversion — the numbers are untouched", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(curveBody([["2026-10", 81.5]])));

    const body = text(
      await tools.opa_get_futures_curve.handler({ contract: "ttf-gas" }, {}),
    );

    expect(body).toContain("81.50");
  });
});
