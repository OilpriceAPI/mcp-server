import { describe, it, expect } from "vitest";
import { describeRequestFailure } from "../index.js";

// #146 — a 404 is two different things on this API, and both carry
// error.code NOT_FOUND (verified live 2026-10-14):
//   GET /v1/doesnotexist -> "No route matches GET /v1/doesnotexist. ..."
//   GET /v1/storage/spr  -> "SPR storage data not available"
// Only the second is a data-availability limit. Calling the first one
// "routed but not populated" tells the model to stop instead of reporting
// a defect in this server's request path (#93 was exactly that).

describe("describeRequestFailure 404 wording (#146)", () => {
  it("a route miss is reported as a server request-path defect, not missing data", () => {
    const msg = describeRequestFailure("SPR storage", {
      data: null,
      status: 404,
      detail:
        "No route matches GET /v1/storage/sprx. Check the path and the /v1 prefix; the machine-readable contract is at https://docs.oilpriceapi.com/api-reference.",
    });
    expect(msg).not.toMatch(/not populated/i);
    expect(msg).not.toMatch(/data-availability/i);
    expect(msg).toMatch(/no route/i);
    expect(msg).toMatch(/github\.com\/OilpriceAPI\/mcp-server\/issues/);
    expect(msg).not.toMatch(/upgrade/i);
  });

  it("a routed 404 with the API's own message keeps the data-availability wording", () => {
    const msg = describeRequestFailure("SPR storage", {
      data: null,
      status: 404,
      detail: "SPR storage data not available",
    });
    expect(msg).toContain("SPR storage data not available");
    expect(msg).toMatch(/not an account or plan restriction/);
    expect(msg).not.toMatch(/no route/i);
  });

  it("a 404 with no detail does not assert the dataset is unpopulated", () => {
    const msg = describeRequestFailure("Rig counts", {
      data: null,
      status: 404,
      detail: "",
    });
    expect(msg).not.toMatch(/routed but the dataset is not populated/);
    expect(msg).toMatch(/HTTP 404/);
  });
});
