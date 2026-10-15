// Cleanup for the synthetic records scripts/live-smoke.mjs creates (#126).
//
// The smoke names every record it creates `mcp-live-contract-<epoch ms>`.
// Cleanup must not depend on reading an id out of the create response: on
// 2026-09-04 that read missed the response envelope, the `finally` skipped
// the DELETE, and watch b84b24a0 stayed active on the shared test key.

export const SYNTHETIC_NAME = /^mcp-live-contract-\d+$/;

// The record array from any list envelope the API has served for
// /v1/alerts (bare array) and /v1/subscriptions (`subscriptions` or
// `data.subscriptions`). Null when none is recognisable.
export function listedRecords(body) {
  if (Array.isArray(body)) return body;
  for (const candidate of [body?.subscriptions, body?.data?.subscriptions, body?.data]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

// Smoke-named records created more than maxAgeMs ago. A record with no
// parseable created_at is left alone: the sweep only removes what it can
// prove is an old smoke leak, never a run in flight.
export function staleSyntheticRecords(records, { now = Date.now(), maxAgeMs }) {
  return records.filter((record) => {
    if (!SYNTHETIC_NAME.test(String(record?.name ?? ""))) return false;
    const created = Date.parse(record.created_at ?? "");
    return Number.isFinite(created) && now - created > maxAgeMs;
  });
}

async function list(request, collectionPath) {
  const listed = await request(collectionPath);
  const records = listedRecords(listed.body);
  if (listed.status !== 200 || !records) {
    throw new Error(`cleanup list ${collectionPath} returned HTTP ${listed.status} without a record array`);
  }
  return records;
}

async function remove(request, collectionPath, id) {
  const deleted = await request(`${collectionPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (![200, 204].includes(deleted.status)) {
    throw new Error(`cleanup DELETE ${collectionPath}/${id} returned HTTP ${deleted.status}`);
  }
}

// Delete this run's synthetic record and verify it is gone. With an id,
// delete by id. Without one (the create succeeded but its response could not
// be read), find it by the unique generated name. Returns the deleted ids.
export async function cleanupSynthetic({ request, collectionPath, id, name }) {
  let ids;
  if (id !== undefined && id !== null && id !== "") {
    ids = [String(id)];
  } else {
    if (!SYNTHETIC_NAME.test(String(name ?? ""))) {
      throw new Error(`cleanup by name refused: ${String(name)} is not a synthetic smoke name`);
    }
    ids = (await list(request, collectionPath))
      .filter((record) => record?.name === name)
      .map((record) => String(record.id));
  }
  for (const target of ids) await remove(request, collectionPath, target);
  const remaining = await list(request, collectionPath);
  const leaked = remaining.filter(
    (record) => ids.includes(String(record?.id)) || (name !== undefined && record?.name === name),
  );
  if (leaked.length) {
    throw new Error(`synthetic record leaked after cleanup: ${leaked.map((record) => record.id).join(", ")}`);
  }
  return ids;
}

// Delete smoke records older than maxAgeMs left by earlier runs. Returns the
// deleted ids so the run can report them.
export async function sweepStaleSynthetic({ request, collectionPath, now = Date.now(), maxAgeMs }) {
  const stale = staleSyntheticRecords(await list(request, collectionPath), { now, maxAgeMs });
  for (const record of stale) await remove(request, collectionPath, String(record.id));
  return stale.map((record) => String(record.id));
}
