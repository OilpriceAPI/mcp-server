import { describe, it, expect } from "vitest";
// Plain ESM script shared with scripts/live-smoke.mjs; it ships no types.
// @ts-ignore
import { cleanupSynthetic, listedRecords, staleSyntheticRecords, sweepStaleSynthetic } from "../../scripts/synthetic-cleanup.mjs";

// #126 — the live smoke leaked watch b84b24a0 on 2026-09-04 because cleanup
// only ran `if (id)`: the create succeeded, the id read missed the envelope,
// and the `finally` skipped the DELETE. Cleanup must not depend on parsing
// the create response, and past leaks must self-heal.

type Row = { id: string; name: string; created_at?: string };

function fakeApi(initial: Row[], { envelope = "data" }: { envelope?: "data" | "array" } = {}) {
  let rows = [...initial];
  const calls: string[] = [];
  const request = async (path: string, { method = "GET" }: { method?: string } = {}) => {
    calls.push(`${method} ${path}`);
    if (method === "DELETE") {
      const id = decodeURIComponent(path.split("/").pop() ?? "");
      const before = rows.length;
      rows = rows.filter((row) => row.id !== id);
      return { status: rows.length < before ? 204 : 404, body: null };
    }
    const body =
      envelope === "array" ? [...rows] : { status: "success", data: { subscriptions: [...rows] } };
    return { status: 200, body };
  };
  return { request, calls, rows: () => rows };
}

const NOW = Date.parse("2026-10-15T18:00:00Z");

describe("#126 synthetic smoke cleanup", () => {
  it("deletes by name when the create response never yielded an id", async () => {
    const api = fakeApi([
      { id: "leak-1", name: "mcp-live-contract-1760550000000" },
      { id: "keep-1", name: "customer watch" },
    ]);
    const deleted = await cleanupSynthetic({
      request: api.request,
      collectionPath: "/v1/subscriptions",
      id: undefined,
      name: "mcp-live-contract-1760550000000",
    });
    expect(deleted).toEqual(["leak-1"]);
    expect(api.rows().map((row) => row.id)).toEqual(["keep-1"]);
  });

  it("deletes by id when the id is known, and verifies absence", async () => {
    const api = fakeApi([{ id: "a1", name: "mcp-live-contract-1" }], { envelope: "array" });
    const deleted = await cleanupSynthetic({
      request: api.request,
      collectionPath: "/v1/alerts",
      id: "a1",
      name: "mcp-live-contract-1",
    });
    expect(deleted).toEqual(["a1"]);
    expect(api.calls).toEqual(["DELETE /v1/alerts/a1", "GET /v1/alerts"]);
  });

  it("throws when the record is still listed after cleanup", async () => {
    const api = fakeApi([{ id: "x", name: "mcp-live-contract-9" }]);
    const stubborn = async (path: string, init: { method?: string } = {}) =>
      init.method === "DELETE" ? { status: 204, body: null } : api.request(path, init);
    await expect(
      cleanupSynthetic({ request: stubborn, collectionPath: "/v1/subscriptions", id: "x", name: "mcp-live-contract-9" }),
    ).rejects.toThrow(/leaked/);
  });

  it("selects only smoke-named records older than the threshold", () => {
    const rows: Row[] = [
      { id: "old", name: "mcp-live-contract-1788524538194", created_at: "2026-09-04T12:22:19Z" },
      { id: "fresh", name: "mcp-live-contract-1760547000000", created_at: "2026-10-15T17:30:00Z" },
      { id: "customer", name: "Brent watch", created_at: "2026-01-01T00:00:00Z" },
      { id: "lookalike", name: "mcp-live-contract-notes", created_at: "2026-01-01T00:00:00Z" },
      { id: "undated", name: "mcp-live-contract-1" },
    ];
    expect(staleSyntheticRecords(rows, { now: NOW, maxAgeMs: 60 * 60 * 1000 }).map((r: Row) => r.id)).toEqual(["old"]);
  });

  it("sweeps a past leak and leaves customer and in-flight records alone", async () => {
    const api = fakeApi([
      { id: "b84b24a0", name: "mcp-live-contract-1788524538194", created_at: "2026-09-04T12:22:19Z" },
      { id: "inflight", name: "mcp-live-contract-1760549000000", created_at: "2026-10-15T17:55:00Z" },
      { id: "customer", name: "Brent watch", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const swept = await sweepStaleSynthetic({
      request: api.request,
      collectionPath: "/v1/subscriptions",
      now: NOW,
      maxAgeMs: 60 * 60 * 1000,
    });
    expect(swept).toEqual(["b84b24a0"]);
    expect(api.rows().map((row) => row.id)).toEqual(["inflight", "customer"]);
  });

  it("reads every list envelope the API has served", () => {
    const row = { id: "1", name: "n" };
    expect(listedRecords([row])).toEqual([row]);
    expect(listedRecords({ subscriptions: [row] })).toEqual([row]);
    expect(listedRecords({ data: { subscriptions: [row] } })).toEqual([row]);
    expect(listedRecords({ data: [row] })).toEqual([row]);
    expect(listedRecords(null)).toBeNull();
  });
});
