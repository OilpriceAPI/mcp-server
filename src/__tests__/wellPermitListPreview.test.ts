import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #195 — permit operations ledger v8 deferred:
//   GET /v1/ei/well-permits          opa_list_well_permits
//   GET /v1/ei/well-permits/preview  opa_preview_well_permits
//
// Fixtures are trimmed copies of production responses on 2026-11-10
// (api.oilpriceapi.com, Scale-plan smoke key).

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
        description?: string;
        inputSchema?: unknown;
        handler: (
          args: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const UNRENDERED = /undefined|NaN|Invalid Date|\bnull\b/;

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function errorFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function requestedUrl(spy: ReturnType<typeof vi.fn>): URL {
  return new URL(String(spy.mock.calls[0][0]));
}

const TX_PERMIT = {
  api_number: "42501377100000",
  state_code: "TX",
  county: "Yoakum",
  permit_number: "0917147",
  permit_type: "new_drill",
  permit_status: "approved",
  permit_date: "2026-11-06",
  operator: {
    name: "RILEY PERMIAN OPERATING CO, LLC",
    name_normalized: "Riley Permian Operating CO, LLC",
    number: "712217",
  },
  well: { name: "LAZY HORSE 581-600 D", number: "35XH", type: "oil" },
  location: { latitude: null, longitude: null },
  target: {
    formation: null,
    formation_normalized: null,
    total_depth_proposed: 7000,
  },
  provenance: { source: "texas_rrc", fetched_at: "2026-11-09T20:03:31.765Z" },
};

// A regulator row with most fields absent, as Mississippi sends them.
const MS_PERMIT = {
  api_number: "23087201340000",
  state_code: "MS",
  county: "Lowndes",
  permit_number: null,
  permit_type: "new_drill",
  permit_status: "approved",
  permit_date: "2026-11-09",
  operator: {
    name: "BLACK SNAKE PETROLEUM, LLC",
    name_normalized: "Black Snake Petroleum, LLC",
    number: null,
  },
  well: { name: "BOWEN 2-15         1", number: null, type: null },
  location: { latitude: null, longitude: null },
  target: {
    formation: null,
    formation_normalized: null,
    total_depth_proposed: null,
  },
  provenance: {
    source: "mississippi_ogb",
    fetched_at: "2026-11-10T13:38:19.380Z",
  },
};

function listBody(
  permits: unknown[],
  meta = { total_count: 421938, page: 1, per_page: 2, total_pages: 210969 },
) {
  return { status: "success", data: { well_permits: permits, meta } };
}

describe("opa_list_well_permits (#195)", () => {
  const TOOL = "opa_list_well_permits";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("states the subscription gate and points Free keys at the preview", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/Well Permits subscription/);
    expect(description).toMatch(/HTTP 403/);
    expect(description).toMatch(/opa_preview_well_permits works on any key/);
    expect(description).toMatch(/eligible account entitlement.*opa_get_plans/);
  });

  it("resolves state names, dedupes codes and sends the API's parameters", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(listBody([TX_PERMIT]));
    vi.stubGlobal("fetch", spy);

    await tools[TOOL].handler(
      {
        states: ["Texas", "nm", "TX"],
        start_date: "2026-11-01",
        end_date: "2026-11-06",
        page: 2,
        per_page: 50,
      },
      {},
    );
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/ei/well-permits");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      states: "TX,NM",
      start_date: "2026-11-01",
      end_date: "2026-11-06",
      page: "2",
      per_page: "50",
    });
  });

  it("omits states entirely for every covered state", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(listBody([MS_PERMIT]));
    vi.stubGlobal("fetch", spy);
    const result = await tools[TOOL].handler({}, {});
    expect(requestedUrl(spy).searchParams.has("states")).toBe(false);
    expect(text(result)).toMatch(/every covered state/);
  });

  it("renders a permit table, marks absent regulator fields with '-' and offers the next page", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(listBody([TX_PERMIT, MS_PERMIT])));

    const result = await tools[TOOL].handler({ states: ["TX", "MS"] }, {});
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain(
      "**Matching permits**: 421938; page 1 of 210969 (2 on this page)",
    );
    expect(body).toContain(
      "| 2026-11-06 | TX | Yoakum | Riley Permian Operating CO, LLC | LAZY HORSE 581-600 D 35XH | oil | new_drill, approved | 42501377100000 | texas_rrc |",
    );
    expect(body).toContain(
      "| 2026-11-09 | MS | Lowndes | Black Snake Petroleum, LLC | BOWEN 2-15 1 | - | new_drill, approved | 23087201340000 | mississippi_ogb |",
    );
    expect(body).toMatch(/request page 2/);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("refuses an unknown state, a bad date and a reversed range before any request", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(listBody([]));
    vi.stubGlobal("fetch", spy);

    expect(
      text(await tools[TOOL].handler({ states: ["Atlantis"] }, {})),
    ).toMatch(/not a recognized US state/);
    expect(
      text(await tools[TOOL].handler({ start_date: "2026-02-30" }, {})),
    ).toMatch(/YYYY-MM-DD/);
    expect(
      text(
        await tools[TOOL].handler(
          { start_date: "2026-11-06", end_date: "2026-11-01" },
          {},
        ),
      ),
    ).toMatch(/on or before end_date/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("bounds per_page to 1-100", () => {
    const schema = tools[TOOL].inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ per_page: 100 }).success).toBe(true);
    expect(schema.safeParse({ per_page: 101 }).success).toBe(false);
    expect(schema.safeParse({ page: 0 }).success).toBe(false);
  });

  it("a 403 surfaces the subscription gate from the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(403, {
        error: "Well permit data requires a Well Permits subscription",
        upgrade_url: "https://www.oilpriceapi.com/pricing",
      }),
    );
    await expect(tools[TOOL].handler({}, {})).rejects.toThrow(
      /HTTP 403.*Well Permits subscription/,
    );
  });
});

function previewBody(
  permits: unknown[],
  metaOverrides: Record<string, unknown> = {},
) {
  return {
    status: "success",
    data: {
      well_permits: permits,
      preview: true,
      meta: {
        state: "TX",
        days: 30,
        count: permits.length,
        row_cap: 25,
        bounded: true,
        as_of: "2026-11-06",
        data_age_days: 4,
        stale: false,
        as_of_basis: "max(permit_date)",
        data_quality: {
          TX: {
            date_coverage: "full",
            source: "texas_rrc",
            note: "RRC API with spud dates; 100% of rows carry a permit_date (measured 2026-07-23)",
          },
        },
        upgrade: {
          message:
            "Preview is limited to 25 permits from the last 90 days for one state.",
          upgrade_url: "https://www.oilpriceapi.com/pricing",
        },
        ...metaOverrides,
      },
    },
  };
}

describe("opa_preview_well_permits (#195)", () => {
  const TOOL = "opa_preview_well_permits";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("says any key can call it, including Free, and states the bound", () => {
    const description = tools[TOOL]?.description ?? "";
    expect(description).toMatch(/at most 25 permits/);
    expect(description).toMatch(/including the Free plan/);
  });

  it("resolves the state and sends days", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    const spy = okFetch(previewBody([TX_PERMIT]));
    vi.stubGlobal("fetch", spy);
    await tools[TOOL].handler({ state: "New Mexico", days: 14 }, {});
    const url = requestedUrl(spy);
    expect(url.pathname).toBe("/v1/ei/well-permits/preview");
    expect(url.searchParams.get("state")).toBe("NM");
    expect(url.searchParams.get("days")).toBe("14");
  });

  it("renders freshness, coverage and the rows", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal("fetch", okFetch(previewBody([TX_PERMIT])));

    const result = await tools[TOOL].handler({ state: "TX", days: 30 }, {});
    const body = text(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain("# Drilling permit preview — TX, last 30 days");
    expect(body).toContain(
      "**Permits shown**: 1 (the preview returns at most 25, newest first)",
    );
    expect(body).toContain("**Data as of**: 2026-11-06 (4 days old)");
    expect(body).toMatch(/TX coverage\*\*: full date coverage from texas_rrc/);
    expect(body).toContain("| 2026-11-06 | TX | Yoakum |");
    expect(body).not.toMatch(/stale/);
    expect(body).not.toMatch(UNRENDERED);
  });

  it("warns when the API marks the state's data stale", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      okFetch(previewBody([TX_PERMIT], { stale: true, data_age_days: 40 })),
    );
    const body = text(await tools[TOOL].handler({}, {}));
    expect(body).toMatch(/40 days old; the API marks it stale/);
    expect(body).toMatch(/recent permits may be missing/);
  });

  it("relays the API's 400 for a state the preview does not cover", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
    vi.stubGlobal(
      "fetch",
      errorFetch(400, {
        status: "fail",
        data: { error: "Invalid state 'HI'. Supported: TX, OK, NM" },
      }),
    );
    const result = await tools[TOOL].handler({ state: "HI" }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/HTTP 400: Invalid state 'HI'/);
    expect(text(result)).not.toMatch(/upgrade/i);
  });

  it("keyless mode returns the teaser without calling the API", async () => {
    vi.stubEnv("OILPRICEAPI_KEY", "");
    const spy = okFetch({});
    vi.stubGlobal("fetch", spy);
    const result = await tools[TOOL].handler({}, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires an API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});
