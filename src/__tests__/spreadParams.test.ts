import { describe, it, expect, vi, afterEach } from "vitest";
import { createSandboxServer } from "../index.js";

// #169 — opa_get_spread exposed only `type`, and the handler called
// /v1/spreads/${type} with no query string. The backend
// (oilpriceapi-api app/controllers/v1/spreads_controller.rb, origin/main
// 2026-10-15) needs:
//   basis   -> ?pair= (required; 400 MISSING_PARAMETER without it)
//              /basis/all lists every pair
//   crack   -> ?type= (jet|diesel|gasoline|3-2-1, default 3-2-1)
//              ?crude= (BRENT_CRUDE_USD|WTI_USD|BRENT_SPOT_USD|WTI_SPOT_USD)
//   margin  -> ?index= (usgc|singapore|nwe, default usgc)
//   */historical -> ?start_date=&end_date= (YYYY-MM-DD, 30-day default)
// So `type: "basis"` could never succeed from MCP: production api_requests
// shows both MCP basis calls in 30 days returned 400.

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<ToolResult>;
  description?: string;
  inputSchema?: {
    shape?: Record<string, unknown>;
    safeParse: (v: unknown) => { success: boolean };
  };
};

const server = createSandboxServer();
const tools = (
  server as unknown as { _registeredTools: Record<string, RegisteredTool> }
)._registeredTools;
const spread = tools.opa_get_spread;

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ status: "success", data: { value: 1 } }),
    text: async () => JSON.stringify({ status: "success", data: { value: 1 } }),
  });
}

async function call(args: Record<string, unknown>) {
  vi.stubEnv("OILPRICEAPI_KEY", "test-key-123");
  const fetchMock = okFetch();
  vi.stubGlobal("fetch", fetchMock);
  const result = await spread.handler(args, {});
  const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
  return { result, urls };
}

const pathAndQuery = (u: URL) => `${u.pathname}${u.search}`;

describe("opa_get_spread passes backend parameters (#169)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("schema exposes pair, crack_type, crude, index, start_date, end_date", () => {
    const shape = spread.inputSchema?.shape ?? {};
    for (const key of [
      "type",
      "pair",
      "crack_type",
      "crude",
      "index",
      "start_date",
      "end_date",
    ]) {
      expect(Object.keys(shape), key).toContain(key);
    }
  });

  it("schema accepts every backend basis pair and rejects an unknown one", () => {
    const schema = spread.inputSchema!;
    for (const pair of [
      "WAHA_HH",
      "BRENT_WTI",
      "BRENT_DUBAI",
      "JKM_HH",
      "TTF_HH",
      "BRENT_OMAN",
    ]) {
      expect(schema.safeParse({ type: "basis", pair }).success, pair).toBe(
        true,
      );
    }
    expect(schema.safeParse({ type: "basis", pair: "NOPE" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ type: "crack", crack_type: "kerosene" }).success,
    ).toBe(false);
  });

  it("basis with a pair calls /v1/spreads/basis?pair=", async () => {
    const { result, urls } = await call({ type: "basis", pair: "BRENT_WTI" });
    expect(urls.map(pathAndQuery)).toEqual([
      "/v1/spreads/basis?pair=BRENT_WTI",
    ]);
    expect(result.isError).not.toBe(true);
  });

  it("basis without a pair lists every pair via /v1/spreads/basis/all", async () => {
    const { result, urls } = await call({ type: "basis" });
    expect(urls.map(pathAndQuery)).toEqual(["/v1/spreads/basis/all"]);
    expect(result.isError).not.toBe(true);
  });

  it("crack forwards crack_type as `type` and crude", async () => {
    const { urls } = await call({
      type: "crack",
      crack_type: "jet",
      crude: "WTI_USD",
    });
    expect(urls.map(pathAndQuery)).toEqual([
      "/v1/spreads/crack?type=jet&crude=WTI_USD",
    ]);
  });

  it("crack with no options keeps the backend default call", async () => {
    const { urls } = await call({ type: "crack" });
    expect(urls.map(pathAndQuery)).toEqual(["/v1/spreads/crack"]);
  });

  it("margin forwards index", async () => {
    const { urls } = await call({ type: "margin", index: "nwe" });
    expect(urls.map(pathAndQuery)).toEqual(["/v1/spreads/margin?index=nwe"]);
  });

  it("a date range routes crack to /crack/historical", async () => {
    const { urls } = await call({
      type: "crack",
      crack_type: "gasoline",
      start_date: "2026-10-01",
      end_date: "2026-10-10",
    });
    expect(urls.map(pathAndQuery)).toEqual([
      "/v1/spreads/crack/historical?type=gasoline&start_date=2026-10-01&end_date=2026-10-10",
    ]);
  });

  it("a date range routes basis to /basis/historical with the pair", async () => {
    const { urls } = await call({
      type: "basis",
      pair: "JKM_HH",
      start_date: "2026-10-01",
    });
    expect(urls.map(pathAndQuery)).toEqual([
      "/v1/spreads/basis/historical?pair=JKM_HH&start_date=2026-10-01",
    ]);
  });

  it("basis history without a pair is refused before any request", async () => {
    const { result, urls } = await call({
      type: "basis",
      start_date: "2026-10-01",
    });
    expect(urls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/pair/);
  });

  it("a parameter that does not apply to the type is refused, not dropped", async () => {
    const { result, urls } = await call({ type: "crack", pair: "BRENT_WTI" });
    expect(urls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/pair.*basis/);
  });

  it("a malformed or reversed date range is refused before any request", async () => {
    const bad = await call({ type: "margin", start_date: "10/01/2026" });
    expect(bad.urls).toEqual([]);
    expect(bad.result.isError).toBe(true);
    const reversed = await call({
      type: "margin",
      start_date: "2026-10-10",
      end_date: "2026-10-01",
    });
    expect(reversed.urls).toEqual([]);
    expect(reversed.result.isError).toBe(true);
  });

  it("description names the valid pairs, crack types and crudes", () => {
    const d = spread.description ?? "";
    for (const token of [
      "BRENT_WTI",
      "JKM_HH",
      "BRENT_OMAN",
      "3-2-1",
      "WTI_SPOT_USD",
      "/basis/all",
    ]) {
      expect(d, token).toContain(token);
    }
  });
});
