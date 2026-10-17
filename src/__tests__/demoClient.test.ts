import { describe, expect, it } from "vitest";
import { DEMO_CLIENT, withDemoClient } from "../demoClient.js";

describe("withDemoClient (oilpriceapi-api#9388)", () => {
  it("uses the allowlisted API client name", () => {
    expect(DEMO_CLIENT).toBe("mcp");
  });

  it("appends client=mcp to a bare path and an absolute URL", () => {
    expect(withDemoClient("/v1/demo/prices")).toBe(
      "/v1/demo/prices?client=mcp",
    );
    expect(
      withDemoClient(
        "https://api.oilpriceapi.com/v1/demo/prices/BRENT_CRUDE_USD",
      ),
    ).toBe(
      "https://api.oilpriceapi.com/v1/demo/prices/BRENT_CRUDE_USD?client=mcp",
    );
  });

  it("keeps existing query parameters and fragments", () => {
    const url = new URL(
      withDemoClient(
        "https://api.example/v1/demo/prices?by_code=WTI_USD&x=1#f",
      ),
    );
    expect(url.searchParams.get("by_code")).toBe("WTI_USD");
    expect(url.searchParams.get("x")).toBe("1");
    expect(url.searchParams.get("client")).toBe("mcp");
    expect(url.hash).toBe("#f");
  });

  it("does not override an explicit client or add an install id", () => {
    const url = new URL(
      withDemoClient(
        "https://api.example/v1/demo/prices?client=docs-playground",
      ),
    );
    expect(url.searchParams.getAll("client")).toEqual(["docs-playground"]);
    expect(url.searchParams.has("iid")).toBe(false);
  });
});
