#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PluginOAuth, createOAuthApp } from "./pluginOAuth.js";
import {
  createEnergyServer,
  DemoCache,
  PLUGIN_VERSION,
} from "./energyPlugin.js";

export class VelocityLimit {
  private buckets = new Map<string, { count: number; end: number }>();
  constructor(
    private maximum = 30,
    private windowMs = 60_000,
    private maxBuckets = 10_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    for (const [id, bucket] of this.buckets)
      if (bucket.end <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) return false;
      bucket = { count: 0, end: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    return ++bucket.count <= this.maximum;
  }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
export interface RemoteOptions {
  publicUrl: string;
  allowedOrigins?: string[];
  challenge?: string;
  fetchImpl?: typeof fetch;
  writeEvent?: (event: unknown) => void;
  rateLimit?: VelocityLimit;
  oauthRateLimit?: VelocityLimit;
  oauth?: PluginOAuth;
}
export function createRemoteServer(options: RemoteOptions) {
  const publicUrl = new URL(options.publicUrl);
  const cache = new DemoCache();
  const oauthApp = options.oauth ? createOAuthApp(options.oauth) : undefined;
  const authLimit = new VelocityLimit(60);
  const authGlobalLimit =
    options.oauthRateLimit ?? new VelocityLimit(60, 60_000, 1);
  const limiter = options.rateLimit ?? new VelocityLimit();
  const globalLimiter = new VelocityLimit(300, 60_000, 1);
  const hashKey = randomBytes(32);
  let active = 0;
  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "GET" && req.url === "/health")
        return json(res, 200, { status: "ok", version: PLUGIN_VERSION });
      if (req.headers.host !== publicUrl.host)
        return json(res, 421, { error: "Invalid host" });
      if (
        req.headers.origin &&
        req.headers.origin !== publicUrl.origin &&
        !(options.allowedOrigins ?? []).includes(req.headers.origin)
      )
        return json(res, 403, { error: "Origin not allowed" });
      if (
        req.method === "GET" &&
        req.url === "/.well-known/openai-apps-challenge"
      ) {
        if (!options.challenge)
          return json(res, 404, {
            error: "Verification challenge not configured",
          });
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        });
        return res.end(options.challenge);
      }
      const handoff =
        /^\/handoff\/(crude_refined|natural_gas|futures|marine|drilling)$/.exec(
          req.url ?? "",
        );
      if (req.method === "GET" && handoff) {
        if (!authLimit.allow(req.socket.remoteAddress ?? "unknown")) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "Handoff velocity limit reached" });
        }
        // A navigation signal is not proof of a distinct person. Prefetches,
        // scanners and internal probes must not become handoff conversions.
        if (
          req.headers["sec-fetch-mode"] === "navigate" &&
          req.headers["sec-fetch-dest"] === "document" &&
          req.headers["sec-fetch-user"] === "?1" &&
          req.headers["x-opa-telemetry-exclude"] !== "1"
        ) {
          try {
            options.writeEvent?.({
              event: "plugin_handoff_visit",
              dataset_category: handoff[1],
              plugin_version: PLUGIN_VERSION,
              population: "browser_navigation_proxy",
            });
          } catch {
            /* Navigation survives analytics failure. */
          }
        }
        res.writeHead(303, {
          Location: `https://www.oilpriceapi.com/auth/signup?utm_source=openai-plugin&utm_medium=plugin&utm_campaign=energy-markets&utm_content=${handoff[1]}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        return res.end();
      }
      if (req.url !== "/mcp") {
        if (
          oauthApp &&
          /^(?:\/authorize|\/token|\/register|\/revoke|\/link|\/.well-known\/oauth-)/.test(
            req.url ?? "",
          )
        ) {
          if (
            !authGlobalLimit.allow("oauth") ||
            !authLimit.allow(req.socket.remoteAddress ?? "unknown")
          ) {
            res.setHeader("Retry-After", "60");
            return json(res, 429, {
              error: "Authorization velocity limit reached",
            });
          }
          oauthApp(req, res);
          return;
        }
        return json(res, 404, { error: "Not found" });
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "Use Streamable HTTP POST" });
      }
      // Forwarding headers are untrusted. The edge can add stricter per-client
      // limits, but this process always bounds the connected peer and total load.
      const peer = createHmac("sha256", hashKey)
        .update(req.socket.remoteAddress ?? "unknown")
        .digest("hex");
      if (
        !globalLimiter.allow("global") ||
        !limiter.allow(peer) ||
        active >= 20
      ) {
        res.setHeader("Retry-After", "60");
        return json(res, 429, { error: "Request velocity limit reached" });
      }
      const authorization = req.headers.authorization;
      if (
        authorization &&
        !/^Bearer [A-Za-z0-9_.-]{16,256}$/.test(authorization)
      )
        return json(res, 401, { error: "Invalid bearer credential" });
      let key = authorization?.slice(7);
      if (key && options.oauth) {
        try {
          key = await options.oauth.credentialForAccessToken(key);
        } catch {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp"`,
          );
          return json(res, 401, {
            error: "Invalid or expired connection. Reconnect OilPriceAPI.",
          });
        }
      }
      if (
        !req.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      )
        return json(res, 415, { error: "JSON required" });
      if (Number(req.headers["content-length"] ?? 0) > 16_384)
        return json(res, 413, { error: "Request too large" });
      active++;
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
        if (!res.writableEnded)
          json(res, 408, { error: "Request deadline exceeded" });
      }, 20_000);
      let server: ReturnType<typeof createEnergyServer> | undefined;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          if (abort.signal.aborted) return;
          size += chunk.length;
          if (size > 16_384)
            return json(res, 413, { error: "Request too large" });
          chunks.push(Buffer.from(chunk));
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { error: "Malformed JSON" });
        }
        if (Array.isArray(body))
          return json(res, 400, { error: "Batch requests are unsupported" });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        server = createEnergyServer({
          key,
          fetchImpl: options.fetchImpl,
          demoCache: cache,
          signal: abort.signal,
          resourceUrl: publicUrl.origin + "/mcp",
          writeEvent: (event) =>
            options.writeEvent?.({
              ...event,
              population:
                req.headers["x-opa-telemetry-exclude"] === "1"
                  ? "internal_test"
                  : "unclassified",
            }),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) json(res, 500, { error: "Request failed" });
      } finally {
        clearTimeout(timer);
        await server?.close();
        active--;
      }
    },
  );
  httpServer.on("close", () => options.oauth?.close());
  httpServer.requestTimeout = 20_000;
  httpServer.headersTimeout = 10_000;
  httpServer.maxHeadersCount = 40;
  return httpServer;
}
export function startRemote() {
  if (process.env.OILPRICEAPI_KEY || process.env.OIL_PRICE_API_KEY)
    throw new Error(
      "Remote service must not have a shared OilPriceAPI credential",
    );
  const publicUrl = process.env.OILPRICEAPI_MCP_PUBLIC_URL;
  if (!publicUrl || new URL(publicUrl).protocol !== "https:")
    throw new Error("OILPRICEAPI_MCP_PUBLIC_URL must be stable HTTPS");
  const oauth = new PluginOAuth(publicUrl);
  const server = createRemoteServer({
    publicUrl,
    oauth,
    challenge: process.env.OPENAI_APPS_CHALLENGE,
    allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .filter(Boolean),
    writeEvent: (event) => console.log(JSON.stringify(event)),
  });
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startRemote();
