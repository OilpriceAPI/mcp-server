import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { PluginOAuth } from "../pluginOAuth.js";
import {
  MemoryOAuthStore,
  PostgresOAuthStore,
  Sealer,
  oauthPersistenceFromEnv,
  type OAuthStore,
} from "../oauthStore.js";
import { startRemote } from "../remote.js";

const origin = "https://mcp.example";
const resource = new URL(origin + "/mcp");
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const apiKey = "caller-key-value-1234";
const sha = (v: string) => createHash("sha256").update(v).digest("base64url");
const masterKey = randomBytes(32);

const accountOk = () =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: { usage: {} } })),
    );

/** A fresh provider instance over the given store: a process restart. */
function boot(store: OAuthStore & { durable: boolean }, key = masterKey) {
  return new PluginOAuth(origin, accountOk(), {
    persistence: { store, sealer: new Sealer(key) },
  });
}

async function connect(provider: PluginOAuth, confidential = false) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const client = await provider.clientsStore.registerClient({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    ...(confidential ? { client_secret: "sdk-issued-secret-value" } : {}),
  });
  let flow = "";
  const res = {
    cookie: (_n: string, v: string) => {
      flow = v;
    },
    setHeader: vi.fn(),
    type: () => res,
    send: vi.fn(),
  };
  await provider.authorize(
    client,
    {
      resource,
      codeChallenge: challenge,
      redirectUri: client.redirect_uris[0],
      scopes: ["energy:read"],
      state: "s",
    },
    res as any,
  );
  const redirect = new URL(await provider.completeLink(flow, flow, apiKey));
  const code = redirect.searchParams.get("code")!;
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  return { client, flow, code, redirect, tokens };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OAuth state survives a restart (#155)", () => {
  it("refreshes successfully on a new provider instance over the same store", async () => {
    const store = new MemoryOAuthStore();
    const first = boot(store);
    const { client, tokens } = await connect(first);
    first.close();

    const second = boot(store);
    try {
      expect(await second.credentialForAccessToken(tokens.access_token)).toBe(
        apiKey,
      );
      const rotated = await second.exchangeRefreshToken(
        client,
        tokens.refresh_token!,
        ["energy:read"],
        resource,
      );
      expect(await second.credentialForAccessToken(rotated.access_token)).toBe(
        apiKey,
      );
      // Rotation is single-use across restarts too.
      await expect(
        second.exchangeRefreshToken(
          client,
          tokens.refresh_token!,
          ["energy:read"],
          resource,
        ),
      ).rejects.toThrow("Invalid refresh grant");
    } finally {
      second.close();
    }
  });

  it("keeps a dynamically registered client, including its secret", async () => {
    const store = new MemoryOAuthStore();
    const first = boot(store);
    const { client } = await connect(first, true);
    first.close();

    const second = boot(store);
    try {
      const found = await second.clientsStore.getClient(client.client_id);
      expect(found?.client_id).toBe(client.client_id);
      expect(found?.redirect_uris).toEqual([
        "https://claude.ai/api/mcp/auth_callback",
      ]);
      expect(found?.client_secret).toBe("sdk-issued-secret-value");
      expect(await second.clientsStore.getClient("unknown")).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it("rejects expired refresh and access tokens after a restart", async () => {
    vi.useFakeTimers();
    const store = new MemoryOAuthStore();
    const first = boot(store);
    const { client, tokens } = await connect(first);
    first.close();
    vi.advanceTimersByTime(7 * 86400000 + 1);
    const second = boot(store);
    try {
      await expect(
        second.verifyAccessToken(tokens.access_token),
      ).rejects.toThrow();
      await expect(
        second.exchangeRefreshToken(
          client,
          tokens.refresh_token!,
          ["energy:read"],
          resource,
        ),
      ).rejects.toThrow("Invalid refresh grant");
    } finally {
      second.close();
    }
  });

  it("rejects revoked tokens after a restart", async () => {
    const store = new MemoryOAuthStore();
    const first = boot(store);
    const { client, tokens } = await connect(first);
    await first.revokeToken(client, { token: tokens.access_token });
    first.close();
    const second = boot(store);
    try {
      await expect(
        second.verifyAccessToken(tokens.access_token),
      ).rejects.toThrow();
      await expect(
        second.exchangeRefreshToken(
          client,
          tokens.refresh_token!,
          ["energy:read"],
          resource,
        ),
      ).rejects.toThrow();
    } finally {
      second.close();
    }
  });

  it("rejects every stored grant when the encryption key changes", async () => {
    const store = new MemoryOAuthStore();
    const first = boot(store);
    const { client, tokens } = await connect(first);
    first.close();
    const second = boot(store, randomBytes(32));
    try {
      expect(await second.clientsStore.getClient(client.client_id)).toBe(
        undefined,
      );
      await expect(
        second.credentialForAccessToken(tokens.access_token),
      ).rejects.toThrow();
      await expect(
        second.exchangeRefreshToken(
          client,
          tokens.refresh_token!,
          ["energy:read"],
          resource,
        ),
      ).rejects.toThrow();
    } finally {
      second.close();
    }
  });

  it("lets only one of two concurrent refreshes with the same token succeed", async () => {
    const store = new MemoryOAuthStore();
    const a = boot(store);
    const b = boot(store);
    const { client, tokens } = await connect(a);
    try {
      const results = await Promise.allSettled([
        a.exchangeRefreshToken(client, tokens.refresh_token!, [], resource),
        b.exchangeRefreshToken(client, tokens.refresh_token!, [], resource),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("what sits at rest", () => {
  it("stores only hashes of bearer values and never the API key or client secret", async () => {
    const store = new MemoryOAuthStore();
    const provider = boot(store);
    try {
      const { client, flow, code, tokens } = await connect(provider, true);
      const rows = store.snapshot();
      const ids = rows.map((r) => `${r.kind}:${r.id}`);
      expect(ids).toEqual(
        expect.arrayContaining([
          `client:${sha(client.client_id)}`,
          `linked:${sha(flow)}`,
          `access:${sha(tokens.access_token)}`,
          `refresh:${sha(tokens.refresh_token!)}`,
        ]),
      );
      // The code was consumed by the exchange.
      expect(ids).not.toContain(`code:${sha(code)}`);
      const raw = JSON.stringify(rows);
      for (const secret of [
        apiKey,
        "sdk-issued-secret-value",
        flow,
        code,
        tokens.access_token,
        tokens.refresh_token!,
        verifier,
        "auth_callback",
      ])
        expect(raw).not.toContain(secret);
      // Revocation subject is a keyed HMAC, not a bare hash of the key.
      expect(raw).not.toContain(sha(apiKey));
      for (const row of rows) expect(row.data).toMatch(/^v1\./);
    } finally {
      provider.close();
    }
  });

  it("refuses a sealed payload moved onto another row", () => {
    const sealer = new Sealer(masterKey);
    const sealed = sealer.seal("access:one", { key: apiKey });
    expect(sealer.open("access:one", sealed)).toEqual({ key: apiKey });
    expect(() => sealer.open("access:two", sealed)).toThrow();
    expect(() => sealer.open("refresh:one", sealed)).toThrow();
  });
});

describe("fails closed on missing configuration", () => {
  const key = randomBytes(32).toString("base64");
  it("requires an encryption key in production", async () => {
    await expect(
      oauthPersistenceFromEnv({
        NODE_ENV: "production",
        OILPRICEAPI_MCP_OAUTH_DATABASE_URL: "postgres://x/y",
      }),
    ).rejects.toThrow("OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY");
  });
  it("requires an encryption key whenever a durable store is configured", async () => {
    const connect = vi.fn();
    await expect(
      oauthPersistenceFromEnv(
        { OILPRICEAPI_MCP_OAUTH_DATABASE_URL: "postgres://x/y" },
        connect,
      ),
    ).rejects.toThrow("OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY");
    expect(connect).not.toHaveBeenCalled();
  });
  it("requires a durable store in production", async () => {
    await expect(
      oauthPersistenceFromEnv({
        NODE_ENV: "production",
        OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY: key,
      }),
    ).rejects.toThrow("OILPRICEAPI_MCP_OAUTH_DATABASE_URL");
  });
  it("rejects a key that is not 32 bytes", async () => {
    await expect(
      oauthPersistenceFromEnv({
        OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY: "c2hvcnQ=",
      }),
    ).rejects.toThrow("32 bytes");
  });
  it("uses memory only outside production with no store configured", async () => {
    const { store } = await oauthPersistenceFromEnv({ NODE_ENV: "test" });
    expect(store.durable).toBe(false);
  });
  it("connects the durable store with the bound CA", async () => {
    const fake = Object.assign(new MemoryOAuthStore(), { durable: true });
    const connect = vi.fn().mockResolvedValue(fake);
    const { store } = await oauthPersistenceFromEnv(
      {
        NODE_ENV: "production",
        OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY: key,
        OILPRICEAPI_MCP_OAUTH_DATABASE_URL: "postgres://u:p@db/mcp",
        OILPRICEAPI_MCP_OAUTH_DATABASE_CA_CERT: "PEM",
      },
      connect,
    );
    expect(store).toBe(fake);
    expect(connect).toHaveBeenCalledWith({
      connectionString: "postgres://u:p@db/mcp",
      caCert: "PEM",
    });
  });
  it("refuses to start the remote service in production without the key", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OILPRICEAPI_KEY", "");
    vi.stubEnv("OIL_PRICE_API_KEY", "");
    vi.stubEnv("OILPRICEAPI_MCP_PUBLIC_URL", origin);
    vi.stubEnv("OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY", "");
    vi.stubEnv("OILPRICEAPI_MCP_OAUTH_DATABASE_URL", "");
    await expect(startRemote()).rejects.toThrow(
      "OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY",
    );
  });
});

// Runs against a real Postgres when MCP_OAUTH_TEST_DATABASE_URL is set,
// e.g. postgres://localhost/mcp_oauth_test. Skipped otherwise.
const pgUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL;
describe.skipIf(!pgUrl)("Postgres store", () => {
  it("survives a restart on a new connection pool and consumes refresh atomically", async () => {
    const storeA = await PostgresOAuthStore.connect({
      connectionString: pgUrl!,
    });
    await storeA.prune(Number.MAX_SAFE_INTEGER);
    const first = boot(storeA);
    const { client, tokens } = await connect(first);
    first.close();
    await storeA.close();

    const storeB = await PostgresOAuthStore.connect({
      connectionString: pgUrl!,
    });
    const second = boot(storeB);
    const third = boot(storeB);
    try {
      expect(
        (await second.clientsStore.getClient(client.client_id))?.client_id,
      ).toBe(client.client_id);
      expect(await second.credentialForAccessToken(tokens.access_token)).toBe(
        apiKey,
      );
      const results = await Promise.allSettled([
        second.exchangeRefreshToken(
          client,
          tokens.refresh_token!,
          [],
          resource,
        ),
        third.exchangeRefreshToken(client, tokens.refresh_token!, [], resource),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
      const rotated = (
        ok[0] as PromiseFulfilledResult<{ access_token: string }>
      ).value;
      expect(await second.credentialForAccessToken(rotated.access_token)).toBe(
        apiKey,
      );
      await second.revokeToken(client, { token: rotated.access_token });
      await expect(
        second.verifyAccessToken(rotated.access_token),
      ).rejects.toThrow();
      await expect(
        second.verifyAccessToken(tokens.access_token),
      ).rejects.toThrow();
    } finally {
      second.close();
      third.close();
      await storeB.prune(Number.MAX_SAFE_INTEGER);
      await storeB.close();
    }
  });
});
