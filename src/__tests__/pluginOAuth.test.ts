import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { PluginOAuth } from "../pluginOAuth.js";

const origin = "https://mcp.example";
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
function setup(status = 200) {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "success",
        data: { code: "WTI_USD", price: 90 },
      }),
      { status },
    ),
  );
  const provider = new PluginOAuth(origin, fetchImpl);
  const client = provider.clientsStore.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "none",
  });
  return { provider, client, fetchImpl };
}
async function authorize(
  provider: PluginOAuth,
  client: ReturnType<PluginOAuth["clientsStore"]["registerClient"]>,
  override = {},
) {
  let cookie = "";
  let html = "";
  const res = {
    cookie: (_n: string, v: string) => {
      cookie = v;
    },
    setHeader: vi.fn(),
    type: () => res,
    send: (s: string) => {
      html = s;
    },
  };
  await provider.authorize(
    client,
    {
      resource: new URL(origin + "/mcp"),
      codeChallenge: challenge,
      redirectUri: client.redirect_uris[0],
      scopes: ["energy:read"],
      state: "test-state",
      ...override,
    },
    res as any,
  );
  expect(html).not.toContain("caller-key-value-1234");
  return cookie;
}
async function linked() {
  const { provider, client, fetchImpl } = setup();
  const flow = await authorize(provider, client);
  const redirect = new URL(
    await provider.completeLink(flow, flow, "caller-key-value-1234"),
  );
  return {
    provider,
    client,
    fetchImpl,
    code: redirect.searchParams.get("code")!,
    redirect,
  };
}
afterEach(() => vi.useRealTimers());
describe("plugin OAuth boundary", () => {
  it("rejects unregistered redirect destinations before rendering consent", async () => {
    const { provider, client } = setup();
    try {
      await expect(authorize(provider, client, {
        redirectUri: "https://attacker.invalid/callback",
      })).rejects.toThrow("Redirect must match the registered client");
    } finally {
      provider.close();
    }
  });
  it.each([null, [], "not an account"])(
    "fails closed on malformed account envelope %s",
    async (data) => {
      const provider = new PluginOAuth(
        origin,
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ status: "success", data })),
          ),
      );
      try {
        const client = provider.clientsStore.registerClient({
          redirect_uris: [
            "https://chatgpt.com/connector_platform_oauth_redirect",
          ],
          token_endpoint_auth_method: "none",
        });
        const flow = await authorize(provider, client);
        await expect(
          provider.completeLink(flow, flow, "caller-key-value-1234"),
        ).rejects.toThrow();
      } finally {
        provider.close();
      }
    },
  );
  it("validates the account without consuming a price request or depending on benchmark availability", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/dashboard")
        ? new Response(
            JSON.stringify({ status: "success", data: { usage: {} } }),
          )
        : new Response(JSON.stringify({ error: "Price quota exhausted" }), {
            status: 429,
          }),
    );
    const provider = new PluginOAuth(origin, fetchImpl as typeof fetch);
    try {
      const client = provider.clientsStore.registerClient({
        redirect_uris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
        token_endpoint_auth_method: "none",
      });
      const flow = await authorize(provider, client);
      const redirect = await provider.completeLink(
        flow,
        flow,
        "caller-key-value-1234",
      );
      expect(new URL(redirect).searchParams.has("code")).toBe(true);
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "https://api.oilpriceapi.com/v1/dashboard",
      );
      expect(redirect).not.toContain("caller-key-value");
    } finally {
      provider.close();
    }
  });
  it("links a verified key, preserves state and binds resource, client, redirect and PKCE", async () => {
    const { provider, client, fetchImpl, code, redirect } = await linked();
    expect(redirect.searchParams.get("state")).toBe("test-state");
    expect(redirect.searchParams.get("iss")).toBe(origin + "/");
    expect(redirect.href).not.toContain("caller-key");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer caller-key-value-1234",
    );
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe(
      challenge,
    );
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      new URL(origin + "/mcp"),
    );
    expect(tokens.scope).toBe("energy:read");
    expect(tokens.access_token).not.toContain("caller-key");
    expect(await provider.credentialForAccessToken(tokens.access_token)).toBe(
      "caller-key-value-1234",
    );
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        verifier,
        client.redirect_uris[0],
        new URL(origin + "/mcp"),
      ),
    ).rejects.toThrow();
  });
  it.each([
    "http://evil.example/callback",
    "https://user:password@evil.example/callback",
    "https://evil.example/callback#fragment",
  ])("rejects unsafe callback %s", (redirect) => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient({ redirect_uris: [redirect] }),
    ).toThrow();
  });
  it.each([
    "https://claude.ai/api/mcp/auth_callback/extra",
    "https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://evil.example/api/mcp/auth_callback",
  ])("rejects look-alike Claude callback %s", (redirect) => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient({
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      }),
    ).toThrow("Use the OpenAI or Claude callback");
  });
  it("links a Claude connection, names the return host and marks the platform", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: { usage: {} } })),
    );
    const provider = new PluginOAuth(origin, fetchImpl);
    try {
      const client = provider.clientsStore.registerClient({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      });
      let html = "";
      let flow = "";
      const res = {
        cookie: (_n: string, v: string) => {
          flow = v;
        },
        setHeader: vi.fn(),
        type: () => res,
        send: (s: string) => {
          html = s;
        },
      };
      await provider.authorize(
        client,
        {
          resource: new URL(origin + "/mcp"),
          codeChallenge: challenge,
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          scopes: ["energy:read"],
          state: "claude-state",
        },
        res as any,
      );
      expect(html).toContain("Returning to <strong>claude.ai</strong>");
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Security-Policy",
        expect.stringContaining("form-action 'self' https://claude.ai;"),
      );
      const redirect = new URL(
        await provider.completeLink(flow, flow, "caller-key-value-1234"),
      );
      expect(redirect.origin + redirect.pathname).toBe(
        "https://claude.ai/api/mcp/auth_callback",
      );
      expect(redirect.searchParams.get("state")).toBe("claude-state");
      expect(redirect.searchParams.has("code")).toBe(true);
      expect(fetchImpl.mock.calls[0][1].headers["X-Api-Client"]).toBe(
        "oilpriceapi-claude-connector/0.1.0",
      );
    } finally {
      provider.close();
    }
  });
  it("keeps marking ChatGPT links as the OpenAI plugin", async () => {
    const { provider, client, fetchImpl } = setup();
    try {
      const flow = await authorize(provider, client);
      await provider.completeLink(flow, flow, "caller-key-value-1234");
      expect(fetchImpl.mock.calls[0][1].headers["X-Api-Client"]).toBe(
        "oilpriceapi-openai-plugin/0.1.0",
      );
    } finally {
      provider.close();
    }
  });
  it("requires the exact protected resource and read-only scope", async () => {
    const { provider, client } = setup();
    await expect(
      authorize(provider, client, {
        resource: new URL("https://other.example/mcp"),
      }),
    ).rejects.toThrow();
    await expect(
      authorize(provider, client, { scopes: ["energy:write"] }),
    ).rejects.toThrow();
  });
  it("rejects cross-browser linking and consumes failed forms", async () => {
    const { provider, client, fetchImpl } = setup(401);
    const flow = await authorize(provider, client);
    await expect(
      provider.completeLink(flow, "different", "caller-key-value-1234"),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      provider.completeLink(flow, flow, "caller-key-value-1234"),
    ).rejects.toThrow();
    await expect(
      provider.completeLink(flow, flow, "caller-key-value-1234"),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([403, 429, 500])(
    "fails closed when account validation returns %s",
    async (status) => {
      const { provider, client } = setup(status);
      const flow = await authorize(provider, client);
      await expect(
        provider.completeLink(flow, flow, "caller-key-value-1234"),
      ).rejects.toThrow();
    },
  );
  it("rejects wrong verifier, redirect, resource and client before issuing tokens", async () => {
    const { provider, client, code } = await linked();
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        "wrong",
        client.redirect_uris[0],
        new URL(origin + "/mcp"),
      ),
    ).rejects.toThrow();
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        verifier,
        "https://other.example",
        new URL(origin + "/mcp"),
      ),
    ).rejects.toThrow();
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        verifier,
        client.redirect_uris[0],
        new URL("https://other.example/mcp"),
      ),
    ).rejects.toThrow();
    await expect(
      provider.exchangeAuthorizationCode(
        { ...client, client_id: "other" },
        code,
        verifier,
        client.redirect_uris[0],
        new URL(origin + "/mcp"),
      ),
    ).rejects.toThrow();
  });
  it("rotates refresh grants and revokes the connected credential", async () => {
    const { provider, client, code } = await linked();
    const token = await provider.exchangeAuthorizationCode(
      client,
      code,
      verifier,
      client.redirect_uris[0],
      new URL(origin + "/mcp"),
    );
    const rotated = await provider.exchangeRefreshToken(
      client,
      token.refresh_token!,
      ["energy:read"],
      new URL(origin + "/mcp"),
    );
    await expect(
      provider.exchangeRefreshToken(
        client,
        token.refresh_token!,
        ["energy:read"],
        new URL(origin + "/mcp"),
      ),
    ).rejects.toThrow();
    await provider.revokeToken(client, { token: rotated.refresh_token! });
    await expect(
      provider.verifyAccessToken(rotated.access_token),
    ).rejects.toThrow();
    await expect(
      provider.verifyAccessToken(token.access_token),
    ).rejects.toThrow();
  });
  it("expires forms and access tokens", async () => {
    vi.useFakeTimers();
    const { provider, client } = setup();
    const flow = await authorize(provider, client);
    vi.advanceTimersByTime(300_001);
    await expect(
      provider.completeLink(flow, flow, "caller-key-value-1234"),
    ).rejects.toThrow();
    const { provider: p, client: c, code } = await linked();
    const token = await p.exchangeAuthorizationCode(
      c,
      code,
      verifier,
      c.redirect_uris[0],
      new URL(origin + "/mcp"),
    );
    vi.advanceTimersByTime(3_600_001);
    await expect(p.verifyAccessToken(token.access_token)).rejects.toThrow();
  });
});
