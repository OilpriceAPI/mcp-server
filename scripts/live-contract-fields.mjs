// Field-level live contract check (#118).
//
// The envelope check (`status === "success"`, `data != null`) cannot see a
// field rename: `opa_get_rig_counts` read oil/gas/total/date while
// /v1/rig-counts/latest sent count/region/observed_at, and the live run stayed
// green (#115). A hand-written `requiredFields` list in the catalog would
// decay the same way the formatter's own field names did.
//
// So the required fields are not written down anywhere. This module runs the
// tool's REAL registered handler over the live response and records, through a
// Proxy, every response key the handler dereferences that the response does
// not carry. The formatter is the list: whatever it reads today is what gets
// checked, and a formatter change changes the check with it.
//
// A key the handler reads but the response lacks is one of two things:
//   - an optional field the formatter guards (`change_24h !== undefined`,
//     `typeof water_bbl === "number"`), whose absence changes nothing the
//     caller can see; or
//   - a field the answer depends on, whose absence the formatter states via
//     reportedValue() ("not reported", #105/#110) or fails to handle at all
//     (`undefined`, `NaN`, `Invalid Date`, a thrown TypeError, an error answer).
// The rendered answer is what separates them, so that is what is asserted: an
// absent key read on an answer that states an absence or errors FAILS, naming
// every absent key read. An explicit `null` from the API is the API's own
// answer and is never counted as absent.

const IGNORED_PROPERTIES = new Set(["then", "toJSON"]);

function traceValue(value, path, absent) {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "symbol" || IGNORED_PROPERTIES.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      const index = Array.isArray(target) && /^\d+$/.test(property);
      const childPath = index
        ? `${path}[]`
        : path
          ? `${path}.${property}`
          : property;
      // Own keys and inherited members (array methods, toString) are present.
      // Only a key the payload does not carry at all is an absence.
      if (!(property in target)) absent.add(childPath);
      return traceValue(Reflect.get(target, property, receiver), childPath, absent);
    },
  });
}

function relativeTo(apiBase, input) {
  const raw = typeof input === "string" ? input : input?.url ?? String(input);
  const url = new URL(raw);
  const base = new URL(apiBase);
  return url.origin === base.origin ? `${url.pathname}${url.search}` : url.href;
}

function answerText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((item) => item && item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function listKeys(keys) {
  const shown = keys.slice(0, 20).join(", ");
  return keys.length > 20 ? `${shown} (+${keys.length - 20} more)` : shown;
}

/**
 * Run `handler(args)` with fetch routed through a tracing shim. The request
 * for `contractPath` is answered with `contractResponse` — the live response
 * the envelope check already validated — so the field check spends no extra
 * quota on it; any other request the handler makes goes to `fetchImpl` and is
 * traced the same way.
 *
 * Resolves `{ ok, reason?, absentKeys, absenceMarkers, requested }`. Never
 * rejects: an error inside the handler or the shim is a failed check.
 */
export async function checkToolFields({
  tool,
  handler,
  args,
  contractPath,
  contractResponse,
  apiBase,
  fetchImpl,
  notReported,
  beforeRequest,
}) {
  const absent = new Set();
  const requested = [];
  let contractServed = false;

  const tracedFetch = async (input, init) => {
    const target = relativeTo(apiBase, input);
    requested.push(target);
    let status;
    let statusText = "";
    let headers;
    let text;
    if (!contractServed && target === contractPath) {
      contractServed = true;
      ({ status, headers, text } = contractResponse);
    } else {
      if (beforeRequest) await beforeRequest();
      const response = await fetchImpl(input, init);
      status = response.status;
      statusText = response.statusText;
      headers = response.headers;
      text = await response.text();
    }
    const response = new Response(status === 204 ? null : text, {
      status,
      statusText,
      headers,
    });
    Object.defineProperty(response, "json", {
      value: async () => traceValue(JSON.parse(text), "", absent),
    });
    return response;
  };

  const markers = [notReported, "undefined", "NaN", "Invalid Date"].filter(Boolean);
  const previousFetch = globalThis.fetch;
  let result;
  let thrown;
  globalThis.fetch = tracedFetch;
  try {
    result = await handler(args, {});
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = previousFetch;
  }

  const absentKeys = [...absent];
  const text = answerText(result);
  const absenceMarkers = markers.filter((marker) => text.includes(marker));
  const outcome = { ok: false, absentKeys, absenceMarkers, requested };
  const suspects = absentKeys.length
    ? `; the handler read keys the response does not carry: ${listKeys(absentKeys)}`
    : "";

  if (!contractServed) {
    return {
      ...outcome,
      reason: `${tool} never requested the catalog path ${contractPath} (requested: ${requested.join(", ") || "nothing"}); the catalog args no longer match the tool`,
    };
  }
  if (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { ...outcome, reason: `${tool} threw on the live response: ${message}${suspects}` };
  }
  if (!result || result.isError) {
    const firstLine = text.split("\n").find((line) => line.trim()) ?? "no text";
    return { ...outcome, reason: `${tool} answered with an error: ${firstLine}${suspects}` };
  }
  if (absentKeys.length && absenceMarkers.length) {
    return {
      ...outcome,
      reason: `${tool} rendered ${absenceMarkers.map((marker) => JSON.stringify(marker)).join(", ")} from the live response${suspects}`,
    };
  }
  return { ...outcome, ok: true };
}
