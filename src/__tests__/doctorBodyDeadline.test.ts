/**
 * #99 — `doctor.ts boundedFetch` cleared its abort timer in `finally`, before
 * the caller read the body. An upstream that sends headers promptly and then
 * stalls mid-body held `opa_doctor` open indefinitely: exactly the failure
 * `boundedFetch` exists to prevent, moved one step later.
 *
 * Same defect class as #84, deliberately scoped out of PR #97.
 *
 * The stall is modelled the way a real one behaves: the response resolves with
 * headers, and `.json()` returns a promise that settles only when the request's
 * own AbortSignal fires. If the deadline does not span the body read, nothing
 * ever aborts it and the promise never settles — so the failing assertion here
 * is the test timing out, which is precisely the production symptom.
 */
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../doctor.js";

const BASE_OPTIONS = {
  baseUrl: "https://api.example.test",
  apiKey: "test-key-must-stay-redacted",
  entryPoint: process.execPath,
  runtimeVersion: "v22.0.0",
  timeoutMs: 50,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A response whose headers arrive immediately and whose body never does —
 * unless the request's signal aborts, which is the only escape.
 */
function stalledBodyResponse(signal: AbortSignal | null | undefined): Response {
  const hang = () =>
    new Promise<never>((_resolve, reject) => {
      if (!signal) return; // no signal at all: hangs forever, as in production
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });

  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: hang,
    text: hang,
  } as unknown as Response;
}

describe("#99 doctor keeps the deadline alive across the body read", () => {
  it("times out a /v1/account body that stalls after the headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      // 1st call: /health — fine.
      if (fetchImpl.mock.calls.length === 1) {
        return jsonResponse(200, { status: "ok" });
      }
      // 2nd call: /v1/account — headers arrive, body never does.
      return stalledBodyResponse(init?.signal as AbortSignal | undefined);
    });

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });

    const account = report.checks.find((c) => c.id === "api-reachability");
    expect(account?.status).toBe("pass");

    // The run must terminate with a reported transport failure rather than
    // hanging. Which check carries it is not the point; that it is reported is.
    const failed = report.checks.filter((c) => c.status === "fail");
    expect(failed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
    // And it is reported as a timeout, not as a mystery.
    expect(failed.some((c) => c.classification === "timeout")).toBe(true);
  }, 5000);

  it("times out a /v1/dashboard body that stalls after the headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const n = fetchImpl.mock.calls.length;
      if (n === 1) return jsonResponse(200, { status: "ok" });
      if (n === 2) {
        return jsonResponse(200, {
          status: "success",
          data: {
            plan: "professional",
            account: {
              usage_this_month: 20,
              effective_request_limit: 1000,
              remaining_requests: 980,
            },
          },
        });
      }
      // 3rd call: /v1/dashboard — headers arrive, body never does.
      return stalledBodyResponse(init?.signal as AbortSignal | undefined);
    });

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });

    expect(report.checks.some((c) => c.status === "fail")).toBe(true);
  }, 5000);

  it("still parses a well-behaved body (no regression)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "success",
          data: {
            plan: "professional",
            account: {
              usage_this_month: 20,
              effective_request_limit: 1000,
              remaining_requests: 980,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "success",
          data: {
            billing: { plan: "professional" },
            features: { webhooks: true, well_production: false },
          },
        }),
      );

    const report = await runDoctor({ ...BASE_OPTIONS, fetchImpl });

    expect(report.account?.plan).toBe("professional");
    expect(report.checks.find((c) => c.id === "feature-gates")).toBeDefined();
  }, 5000);
});
