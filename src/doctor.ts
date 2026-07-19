import { access } from "node:fs/promises";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  classification?:
    | "authentication"
    | "entitlement"
    | "rate-limit"
    | "timeout"
    | "dns-tls"
    | "server"
    | "http"
    | "configuration";
  recovery?: string;
}

export interface DoctorReport {
  schemaVersion: "1.0.0";
  ok: boolean;
  mode: "account" | "demo";
  checks: DoctorCheck[];
  account?: {
    plan: string;
    features: Record<string, boolean>;
    quota?: {
      used: number;
      limit: number;
      remaining: number;
      percentUsed: number;
    };
  };
}

export interface RunDoctorOptions {
  baseUrl: string;
  apiKey?: string;
  demo?: boolean;
  entryPoint: string;
  runtimeVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SIGNUP = "https://www.oilpriceapi.com/auth/signup?utm_source=mcp-doctor";
const PRICING = "https://www.oilpriceapi.com/pricing?utm_source=mcp-doctor";
const SUPPORT = "https://github.com/OilpriceAPI/mcp-server/issues";

function runtimeMajor(version: string): number {
  const match = version.match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function transportClassification(
  error: unknown,
): Pick<DoctorCheck, "classification" | "message" | "recovery"> {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      classification: "timeout",
      message: "The OilPriceAPI request timed out.",
      recovery:
        "Retry after checking proxy/firewall settings and upstream service status.",
    };
  }

  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code || "";
  if (/^(ENOTFOUND|EAI_AGAIN|CERT_|ERR_TLS|UNABLE_TO_VERIFY)/.test(code)) {
    return {
      classification: "dns-tls",
      message: "DNS or TLS negotiation failed before OilPriceAPI responded.",
      recovery:
        "Check DNS, HTTPS inspection, proxy certificates, and NODE_EXTRA_CA_CERTS where applicable.",
    };
  }

  return {
    classification: "dns-tls",
    message: "The OilPriceAPI service could not be reached over HTTPS.",
    recovery: `Check network, proxy, DNS, and TLS settings. Support: ${SUPPORT}`,
  };
}

function httpFailure(status: number): DoctorCheck {
  if (status === 401) {
    return {
      id: "account",
      status: "fail",
      classification: "authentication",
      message: "OilPriceAPI rejected the configured key (HTTP 401).",
      recovery: `The key is missing, invalid, stale, or revoked. Create or rotate it at ${SIGNUP}.`,
    };
  }
  if (status === 402) {
    return {
      id: "account",
      status: "fail",
      classification: "entitlement",
      message:
        "The account is authenticated but its current plan cannot run this check (HTTP 402).",
      recovery: `Review plan and entitlement requirements at ${PRICING}.`,
    };
  }
  if (status === 403) {
    return {
      id: "account",
      status: "fail",
      classification: "entitlement",
      message:
        "The account is authenticated but access is forbidden (HTTP 403).",
      recovery: `Request feature access or review the account plan at ${PRICING}.`,
    };
  }
  if (status === 429) {
    return {
      id: "account",
      status: "fail",
      classification: "rate-limit",
      message: "The account check was rate-limited (HTTP 429).",
      recovery:
        "Retry after the server-provided interval and verify account quota before running CI concurrently.",
    };
  }
  if (status >= 500) {
    return {
      id: "account",
      status: "fail",
      classification: "server",
      message: `OilPriceAPI returned a service error (HTTP ${status}).`,
      recovery:
        "Retry later and check OilPriceAPI service status before rotating a valid key.",
    };
  }
  return {
    id: "account",
    status: "fail",
    classification: "http",
    message: `The account check returned unexpected HTTP ${status}.`,
    recovery: `Review the endpoint contract or open a support issue: ${SUPPORT}`,
  };
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeAccount(body: unknown): NonNullable<DoctorReport["account"]> {
  const envelope =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : envelope;
  const billing =
    data.billing && typeof data.billing === "object"
      ? (data.billing as Record<string, unknown>)
      : {};
  const account =
    data.account && typeof data.account === "object"
      ? (data.account as Record<string, unknown>)
      : {};
  const planCandidate = data.plan ?? billing.plan ?? data.tier ?? account.tier;
  const plan =
    typeof planCandidate === "string" && planCandidate.trim()
      ? planCandidate.trim()
      : "unknown";
  const featureCandidate =
    data.features ?? billing.features ?? account.features;
  const features: Record<string, boolean> = {};
  if (featureCandidate && typeof featureCandidate === "object") {
    for (const [name, enabled] of Object.entries(
      featureCandidate as Record<string, unknown>,
    )) {
      if (typeof enabled === "boolean") features[name] = enabled;
      if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) {
        const detail = enabled as Record<string, unknown>;
        if (typeof detail.enabled === "boolean") {
          features[name] = detail.enabled;
        }
        for (const [childName, childEnabled] of Object.entries(detail)) {
          if (name === "addons" && typeof childEnabled === "boolean") {
            features[`${name}.${childName}`] = childEnabled;
          }
        }
        for (const included of Array.isArray(detail.included)
          ? detail.included
          : []) {
          if (typeof included === "string") features[included] = true;
        }
        for (const locked of Array.isArray(detail.locked)
          ? detail.locked
          : []) {
          if (typeof locked === "string") features[locked] = false;
        }
      }
    }
  }
  if (Array.isArray(featureCandidate)) {
    for (const name of featureCandidate) {
      if (typeof name === "string") features[name] = true;
    }
  }
  const used = Number(account.usage_this_month);
  const limit = Number(
    account.effective_request_limit ?? account.request_limit,
  );
  const remaining = Number(account.remaining_requests);
  const quota =
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    limit > 0 &&
    Number.isFinite(remaining)
      ? {
          used,
          limit,
          remaining,
          percentUsed: Math.round((used / limit) * 10_000) / 100,
        }
      : undefined;
  return { plan, features, ...(quota ? { quota } : {}) };
}

export async function runDoctor(
  options: RunDoctorOptions,
): Promise<DoctorReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const runtimeVersion = options.runtimeVersion ?? process.version;
  const checks: DoctorCheck[] = [];
  const major = runtimeMajor(runtimeVersion);

  checks.push(
    major >= 18
      ? {
          id: "runtime",
          status: "pass",
          message: `Node ${runtimeVersion} satisfies the >=18 runtime requirement.`,
        }
      : {
          id: "runtime",
          status: "fail",
          classification: "configuration",
          message: `Node ${runtimeVersion} is unsupported.`,
          recovery:
            "Install Node 18 or newer and clear any stale npx cache entry.",
        },
  );

  try {
    await access(options.entryPoint);
    checks.push({
      id: "package-launch",
      status: "pass",
      message:
        "The package entry point is readable; this invocation proves npx/package launchability.",
    });
  } catch {
    checks.push({
      id: "package-launch",
      status: "fail",
      classification: "configuration",
      message: "The package entry point is missing or unreadable.",
      recovery:
        "Clear the npx cache and reinstall oilpriceapi-mcp from the npm registry.",
    });
  }

  try {
    const health = await boundedFetch(
      fetchImpl,
      `${options.baseUrl.replace(/\/$/, "")}/health`,
      { headers: { Accept: "application/json" } },
      timeoutMs,
    );
    if (!health.ok) {
      checks.push({
        id: "api-reachability",
        status: "fail",
        classification: health.status >= 500 ? "server" : "http",
        message: `OilPriceAPI health returned HTTP ${health.status}.`,
        recovery: "Check service status and proxy/firewall rules, then retry.",
      });
      return finish(options.demo ? "demo" : "account", checks);
    }
    checks.push({
      id: "api-reachability",
      status: "pass",
      message: "OilPriceAPI health is reachable over HTTPS.",
    });
  } catch (error) {
    checks.push({
      id: "api-reachability",
      status: "fail",
      ...transportClassification(error),
    });
    return finish(options.demo ? "demo" : "account", checks);
  }

  if (options.demo) {
    try {
      const response = await boundedFetch(
        fetchImpl,
        `${options.baseUrl.replace(/\/$/, "")}/v1/demo/prices`,
        { headers: { Accept: "application/json" } },
        timeoutMs,
      );
      checks.push(
        response.ok
          ? {
              id: "demo",
              status: "pass",
              message: "The bounded keyless demo request succeeded.",
            }
          : {
              ...httpFailure(response.status),
              id: "demo",
            },
      );
    } catch (error) {
      checks.push({
        id: "demo",
        status: "fail",
        ...transportClassification(error),
      });
    }
    return finish("demo", checks);
  }

  if (!options.apiKey) {
    checks.push({
      id: "api-key",
      status: "fail",
      classification: "configuration",
      message: "OILPRICEAPI_KEY is not configured.",
      recovery: `Set OILPRICEAPI_KEY or use doctor --demo. Create a key at ${SIGNUP}.`,
    });
    return finish("account", checks);
  }

  checks.push({
    id: "api-key",
    status: "pass",
    message: "OILPRICEAPI_KEY is configured and remains redacted.",
  });

  try {
    const response = await boundedFetch(
      fetchImpl,
      `${options.baseUrl.replace(/\/$/, "")}/v1/account`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
      },
      timeoutMs,
    );
    if (!response.ok) {
      checks.push(httpFailure(response.status));
      return finish("account", checks);
    }
    let account = safeAccount(await response.json());
    const quotaExhausted = account.quota && account.quota.remaining <= 0;
    const quotaWarning =
      account.quota && !quotaExhausted && account.quota.percentUsed >= 80;
    checks.push({
      id: "account",
      status: quotaExhausted ? "fail" : quotaWarning ? "warn" : "pass",
      ...(quotaExhausted ? { classification: "rate-limit" as const } : {}),
      message: quotaExhausted
        ? `Account key is valid, but its monthly quota is exhausted on plan ${account.plan}.`
        : quotaWarning
          ? `Account key is valid on plan ${account.plan}; quota is ${account.quota?.percentUsed}% used with ${account.quota?.remaining} requests remaining.`
          : `Account key is valid; current plan is ${account.plan}.`,
      ...(quotaExhausted
        ? {
            recovery:
              "Rotate to the dedicated synthetic smoke identity or raise its quota before running CI.",
          }
        : {}),
    });
    if (quotaExhausted) return finish("account", checks, account);

    const dashboardResponse = await boundedFetch(
      fetchImpl,
      `${options.baseUrl.replace(/\/$/, "")}/v1/dashboard`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
      },
      timeoutMs,
    );
    if (!dashboardResponse.ok) {
      const failure = httpFailure(dashboardResponse.status);
      checks.push({
        ...failure,
        id: "feature-gates",
        message: `Feature-gate discovery failed. ${failure.message}`,
      });
      return finish("account", checks, account);
    }

    const dashboard = safeAccount(await dashboardResponse.json());
    account = {
      plan: dashboard.plan === "unknown" ? account.plan : dashboard.plan,
      features: dashboard.features,
      ...(account.quota ? { quota: account.quota } : {}),
    };
    const locked = Object.entries(account.features)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name)
      .sort();
    checks.push({
      id: "feature-gates",
      status: locked.length > 0 ? "warn" : "pass",
      message:
        locked.length > 0
          ? `Locked features: ${locked.join(", ")}. Example recovery: request feature access or review ${PRICING}.`
          : "Dashboard feature gates are readable; no disabled boolean gates were reported.",
    });
    return finish("account", checks, account);
  } catch (error) {
    checks.push({
      id: "account",
      status: "fail",
      ...transportClassification(error),
    });
    return finish("account", checks);
  }
}

function finish(
  mode: DoctorReport["mode"],
  checks: DoctorCheck[],
  account?: DoctorReport["account"],
): DoctorReport {
  return {
    schemaVersion: "1.0.0",
    ok: !checks.some((check) => check.status === "fail"),
    mode,
    checks,
    ...(account ? { account } : {}),
  };
}
