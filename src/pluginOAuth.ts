import express, { type Response } from "express";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  InvalidRequestError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const opaque = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Grant {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
  key?: string;
}
interface Token {
  clientId: string;
  key: string;
  expires: number;
  resource: string;
}
export class PluginOAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private forms = new Map<string, Grant>();
  private codes = new Map<string, Grant>();
  private tokens = new Map<string, Token>();
  private refreshTokens = new Map<string, Token>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  readonly resource: string;
  readonly origin: string;
  constructor(
    publicUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.origin = new URL(publicUrl).origin;
    this.resource = this.origin + "/mcp";
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    this.cleanupTimer.unref();
  }
  close() {
    clearInterval(this.cleanupTimer);
    for (const map of [
      this.forms,
      this.codes,
      this.tokens,
      this.refreshTokens,
      this.clients,
    ])
      map.clear();
  }
  private prune() {
    const now = Date.now();
    for (const [key, client] of this.clients)
      if ((client.client_id_issued_at ?? 0) * 1000 + 30 * 86400000 <= now)
        this.clients.delete(key);
    for (const map of [this.forms, this.codes, this.tokens, this.refreshTokens])
      for (const [key, value] of map) if (value.expires <= now) map.delete(key);
  }
  private capacity(map: Map<string, unknown>) {
    this.prune();
    if (map.size >= 1000)
      throw new TemporarilyUnavailableError(
        "Authorization capacity reached. Retry later.",
      );
  }
  get clientsStore() {
    return {
      getClient: (id: string) => this.clients.get(id),
      registerClient: (
        input: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >,
      ) => {
        this.capacity(this.clients);
        const reject = (reason: string): never => {
          logRegistration("oauth_registration_rejected", input, reason);
          throw new InvalidClientMetadataError(reason);
        };
        // client_secret_post is accepted because the SDK issues the secret and
        // verifies it at /token; PKCE is still required at /authorize.
        const confidential =
          input.token_endpoint_auth_method === "client_secret_post";
        if (
          input.token_endpoint_auth_method &&
          input.token_endpoint_auth_method !== "none" &&
          !confidential
        )
          reject("Use public-client PKCE or client_secret_post authentication");
        if (!input.redirect_uris.length || input.redirect_uris.length > 5)
          reject("Invalid redirect count");
        for (const redirect of input.redirect_uris) {
          let url: URL;
          try {
            url = new URL(redirect);
          } catch {
            return reject("Invalid redirect URI");
          }
          const openai =
            url.protocol === "https:" &&
            url.hostname === "chatgpt.com" &&
            (url.pathname === "/connector_platform_oauth_redirect" ||
              /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
          // Hosted Claude apps (web, Desktop, mobile, Cowork) use one fixed
          // callback: https://claude.com/docs/connectors/building/authentication
          const claude =
            url.protocol === "https:" &&
            url.hostname === "claude.ai" &&
            url.pathname === "/api/mcp/auth_callback" &&
            !url.search;
          const loopback =
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
          if (
            url.username ||
            url.password ||
            url.hash ||
            !(openai || claude || loopback)
          )
            reject(
              "Use the OpenAI or Claude callback, or a native loopback callback",
            );
        }
        const client: OAuthClientInformationFull = {
          ...input,
          client_id: opaque(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: confidential
            ? "client_secret_post"
            : "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        // Public clients never receive or require a client secret.
        if (!confidential) {
          delete client.client_secret;
          delete client.client_secret_expires_at;
        } else if (!client.client_secret) reject("Client secret unavailable");
        this.clients.set(client.client_id, client);
        logRegistration("oauth_client_registered", input);
        return client;
      },
    };
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    if (!client.redirect_uris.includes(params.redirectUri))
      throw new InvalidRequestError(
        "Redirect must match the registered client",
      );
    if (params.resource?.href !== this.resource)
      throw new InvalidRequestError("Resource must match this MCP endpoint");
    if (params.scopes?.some((scope) => scope !== "energy:read"))
      throw new InvalidScopeError("Only energy:read is supported");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("S256 PKCE is required");
    this.capacity(this.forms);
    const flow = opaque();
    this.forms.set(hash(flow), {
      clientId: client.client_id,
      params,
      expires: Date.now() + 300_000,
    });
    res.cookie("opa_oauth_flow", flow, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 300_000,
      path: "/link",
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    // no-referrer turns a browser form POST's Origin into null, defeating
    // our exact-origin CSRF check. Cross-origin referrers stay suppressed.
    res.setHeader("Referrer-Policy", "same-origin");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect OilPriceAPI</title><style>body{font:16px system-ui;max-width:34rem;margin:8vh auto;padding:24px;color:#15263b}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:8px 0}button{background:#153e63;color:white;border:0;border-radius:6px}a{color:#153e63}</style><h1>Connect OilPriceAPI</h1><p>Returning to <strong>${escapeHtml(new URL(params.redirectUri).host)}</strong> after you connect.</p><p>Allow this connection to read supported energy datasets using your account's existing entitlements. No write access is requested.</p><p>Paste your OilPriceAPI API key. It stays on the server and is never returned to the model. Connections expire and may require reconnecting after a service restart.</p><form method="post" action="/link"><input type="hidden" name="flow" value="${flow}"><label for="key">OilPriceAPI API key</label><input id="key" name="key" type="password" autocomplete="off" required maxlength="256"><button type="submit">Connect read access</button></form><p><a href="https://www.oilpriceapi.com/dashboard">Find your API key</a> · <a href="https://www.oilpriceapi.com/privacy">Privacy</a> · <a href="https://www.oilpriceapi.com/support">Support</a></p></html>`,
      );
  }
  async completeLink(
    flow: string,
    cookieFlow: string | undefined,
    key: string,
  ) {
    if (!cookieFlow || !equal(flow, cookieFlow))
      throw new InvalidRequestError("Authorization session mismatch");
    this.prune();
    const grant = this.forms.get(hash(flow));
    if (!grant)
      throw new InvalidGrantError("Authorization session expired. Reconnect.");
    this.forms.delete(hash(flow));
    if (!/^[A-Za-z0-9_.-]{16,256}$/.test(key))
      throw new InvalidGrantError(
        "Invalid OilPriceAPI key. Reconnect with a valid key.",
      );
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await this.fetchImpl(
        (process.env.OILPRICEAPI_BASE_URL ?? "https://api.oilpriceapi.com") +
          "/v1/dashboard",
        {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "X-Api-Client": linkClient(grant.params.redirectUri),
          },
          signal: abort.signal,
        },
      );
      if (response.status === 401)
        throw new InvalidGrantError(
          "Invalid or revoked OilPriceAPI key. Reconnect with a valid key.",
        );
      if (!response.ok)
        throw new TemporarilyUnavailableError(
          "OilPriceAPI could not validate the account. Retry later.",
        );
      const payload = await response.json();
      if (
        payload?.status !== "success" ||
        !payload.data ||
        typeof payload.data !== "object" ||
        Array.isArray(payload.data)
      )
        throw new InvalidGrantError("OilPriceAPI did not verify this account.");
    } finally {
      clearTimeout(timer);
    }
    this.capacity(this.codes);
    const code = opaque();
    this.codes.set(hash(code), { ...grant, key, expires: Date.now() + 60_000 });
    const redirect = new URL(grant.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (grant.params.state)
      redirect.searchParams.set("state", grant.params.state);
    redirect.searchParams.set("iss", this.origin + "/");
    return redirect.href;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    this.prune();
    const grant = this.codes.get(hash(code));
    if (!grant || grant.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid authorization code");
    return grant.params.codeChallenge;
  }
  private issue(clientId: string, key: string): OAuthTokens {
    this.capacity(this.tokens);
    this.capacity(this.refreshTokens);
    const access = opaque();
    const refresh = opaque();
    this.tokens.set(hash(access), {
      clientId,
      key,
      resource: this.resource,
      expires: Date.now() + 3_600_000,
    });
    this.refreshTokens.set(hash(refresh), {
      clientId,
      key,
      resource: this.resource,
      expires: Date.now() + 7 * 86400000,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: "energy:read",
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirect?: string,
    resource?: URL,
  ) {
    this.prune();
    const grant = this.codes.get(hash(code));
    if (
      !grant ||
      !grant.key ||
      grant.clientId !== client.client_id ||
      resource?.href !== this.resource ||
      redirect !== grant.params.redirectUri ||
      (verifier !== undefined &&
        !equal(hash(verifier), grant.params.codeChallenge))
    )
      throw new InvalidGrantError("Invalid authorization grant");
    this.codes.delete(hash(code));
    return this.issue(client.client_id, grant.key);
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.prune();
    const token = this.refreshTokens.get(hash(refresh));
    if (
      !token ||
      token.clientId !== client.client_id ||
      resource?.href !== this.resource ||
      scopes?.some((scope) => scope !== "energy:read")
    )
      throw new InvalidGrantError("Invalid refresh grant. Reconnect.");
    this.refreshTokens.delete(hash(refresh));
    return this.issue(client.client_id, token.key);
  }
  async verifyAccessToken(access: string) {
    this.prune();
    const token = this.tokens.get(hash(access));
    if (!token)
      throw new InvalidTokenError("Invalid or expired connection. Reconnect.");
    return {
      token: access,
      clientId: token.clientId,
      scopes: ["energy:read"],
      expiresAt: Math.floor(token.expires / 1000),
      resource: new URL(token.resource),
    };
  }
  async credentialForAccessToken(access: string) {
    await this.verifyAccessToken(access);
    return this.tokens.get(hash(access))!.key;
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    const key = hash(request.token);
    // Disconnect removes the associated credential from all active grants.
    const entry = this.tokens.get(key) ?? this.refreshTokens.get(key);
    if (entry?.clientId !== client.client_id) return;
    for (const [id, grant] of this.codes)
      if (grant.clientId === entry.clientId && grant.key === entry.key)
        this.codes.delete(id);
    for (const map of [this.tokens, this.refreshTokens])
      for (const [id, token] of map)
        if (token.clientId === entry.clientId && token.key === entry.key)
          map.delete(id);
  }
}
export function createOAuthApp(provider: PluginOAuth) {
  const app = express();
  app.disable("x-powered-by");
  // Connected-peer limits are intentional. Caller forwarding headers never
  // become trusted client identities; the native service also caps OAuth globally.
  const rateLimit = { validate: { xForwardedForHeader: false } };
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(provider.origin),
      resourceServerUrl: new URL(provider.resource),
      resourceName: "OilPriceAPI",
      scopesSupported: ["energy:read"],
      authorizationOptions: { rateLimit },
      clientRegistrationOptions: { rateLimit },
      revocationOptions: { rateLimit },
      tokenOptions: { rateLimit },
      serviceDocumentationUrl: new URL("https://www.oilpriceapi.com/support"),
    }),
  );
  app.post(
    "/link",
    express.urlencoded({ extended: false, limit: "2kb", parameterLimit: 3 }),
    async (req, res) => {
      if (req.headers.origin !== provider.origin)
        return res.status(403).json({ error: "Origin not allowed" });
      const cookie = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("opa_oauth_flow="))
        ?.slice("opa_oauth_flow=".length);
      try {
        const redirect = await provider.completeLink(
          typeof req.body.flow === "string" ? req.body.flow : "",
          cookie,
          typeof req.body.key === "string" ? req.body.key : "",
        );
        res.clearCookie("opa_oauth_flow", {
          path: "/link",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        });
        res.setHeader("Cache-Control", "no-store");
        res.redirect(redirect);
      } catch {
        res
          .status(400)
          .type("html")
          .send(
            '<p>Could not connect this account. Check your API key and start the connection again. If OilPriceAPI is unavailable or rate limited, retry later.</p><a href="https://www.oilpriceapi.com/support">Support</a>',
          );
      }
    },
  );
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: "Invalid authorization request" });
    },
  );
  return app;
}

// One validation call per connection, so this marks which platform linked.
function linkClient(redirectUri: string) {
  return new URL(redirectUri).hostname === "claude.ai"
    ? "oilpriceapi-claude-connector/0.1.0"
    : "oilpriceapi-openai-plugin/0.1.0";
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

// Registration happens server-to-server, so a rejection is invisible unless we
// log it. Metadata only: no client secret, no redirect path or query.
function logRegistration(
  event: string,
  input: {
    redirect_uris?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    scope?: unknown;
    client_name?: unknown;
  },
  reason?: string,
) {
  const hosts = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.map((uri) => {
        try {
          return new URL(String(uri)).host;
        } catch {
          return "invalid";
        }
      })
    : [];
  console.log(
    JSON.stringify({
      event,
      reason,
      redirect_hosts: hosts,
      token_endpoint_auth_method: input.token_endpoint_auth_method ?? null,
      grant_types: input.grant_types ?? null,
      scope: typeof input.scope === "string" ? input.scope.slice(0, 100) : null,
      client_name:
        typeof input.client_name === "string"
          ? input.client_name.slice(0, 60)
          : null,
    }),
  );
}
