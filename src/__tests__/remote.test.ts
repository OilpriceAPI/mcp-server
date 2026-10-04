import { createHash } from "node:crypto";
import { PluginOAuth } from "../pluginOAuth.js";
import { createServer as createProbeServer, request } from "node:http";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteServer, VelocityLimit } from "../remote.js";
async function service(
  test: (base: string) => Promise<void>,
  rateLimit?: VelocityLimit,
  oauthEnabled = false,
  writeEvent?: (event: unknown) => void,
  oauthRateLimit?: VelocityLimit,
) {
  const probe = createProbeServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const oauth = oauthEnabled
    ? new PluginOAuth(
        `https://127.0.0.1:${port}`,
        async () =>
          new Response(
            JSON.stringify({
              status: "success",
              data: { price: 90, code: "WTI_USD" },
            }),
          ),
      )
    : undefined;
  const server = createRemoteServer({
    oauth,
    writeEvent,
    publicUrl: `https://127.0.0.1:${port}`,
    rateLimit,
    oauthRateLimit,
    challenge: "verbatim-value\n",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            prices: [
              {
                code: "WTI_USD",
                name: "WTI Futures",
                price: 90,
                currency: "USD",
                updated_at: "2026-10-01",
              },
            ],
          },
        }),
      ),
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address() as { port: number };
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const headers = { Host: "plugin.example" };
describe("Streamable HTTP service", () => {
  it("challenges anonymous account-tool calls with 401 so clients can start sign-in", async () => {
    const events: any[] = [];
    await service(
      async (base) => {
        const call = (name: string, args: object) =>
          fetch(base + "/mcp", {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
        for (const [name, args] of [
          ["energy_history", { benchmark: "BRENT_CRUDE_USD", days: 7 }],
          ["energy_futures_curve", { instrument: "brent" }],
          ["energy_marine_fuels", { ports: ["SGSIN"], grade: "VLSFO" }],
          ["energy_drilling", { geography: "US" }],
        ] as const) {
          const challenged = await call(name, args);
          expect(challenged.status).toBe(401);
          const header = challenged.headers.get("www-authenticate")!;
          expect(header).toMatch(/^Bearer /);
          expect(header).toContain('resource_metadata="https://127.0.0.1:');
          expect(header).toContain("/.well-known/oauth-protected-resource/mcp");
          expect(header).toContain('scope="energy:read"');
        }
        const demo = await call("energy_get_price", {
          benchmark: "WTI_USD",
        });
        expect(demo.status).toBe(200);
        expect(demo.headers.get("www-authenticate")).toBeNull();
      },
      undefined,
      true,
      (event: unknown) => events.push(event),
    );
    expect(
      events
        .filter((e) => e.event === "plugin_auth_challenge")
        .map((e) => e.tool),
    ).toEqual([
      "energy_history",
      "energy_futures_curve",
      "energy_marine_fuels",
      "energy_drilling",
    ]);
  });
  it("keeps the in-band entitlement result when OAuth is not configured", async () =>
    service(async (base) => {
      const response = await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "energy_history",
            arguments: { benchmark: "BRENT_CRUDE_USD", days: 7 },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("entitlement");
    }));
  it("logs edge rejections so server-to-server failures are visible", async () => {
    const events: any[] = [];
    await service(
      async (base) => {
        const origin = await fetch(base + "/register", {
          method: "POST",
          headers: {
            Origin: "https://attacker.invalid",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        expect(origin.status).toBe(403);
        const missing = await fetch(base + "/nope?token=secret");
        expect(missing.status).toBe(404);
      },
      undefined,
      true,
      (event: unknown) => events.push(event),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "remote_edge_rejected",
        status: 403,
        reason: "origin",
        path: "/register",
        origin: "https://attacker.invalid",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "remote_edge_rejected",
        status: 404,
        path: "/nope",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
  });
  it("ignores untrusted forwarding headers on OAuth without logging a proxy misconfiguration", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await service(
        async (base) => {
          const response = await fetch(base + "/register", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": "192.0.2.1",
            },
            body: JSON.stringify({
              redirect_uris: ["http://127.0.0.1:8976/callback"],
              token_endpoint_auth_method: "none",
            }),
          });
          expect(response.status).toBe(201);
          expect(errors).not.toHaveBeenCalled();
        },
        undefined,
        true,
      );
    } finally {
      errors.mockRestore();
    }
  });
  it("globally caps OAuth across rotating claimed client addresses", async () =>
    service(
      async (base) => {
        for (let i = 0; i < 2; i++) {
          const response = await fetch(
            base + "/.well-known/oauth-authorization-server",
            { headers: { "X-Forwarded-For": `192.0.2.${i}` } },
          );
          expect(response.status).toBe(200);
        }
        const limited = await fetch(
          base + "/.well-known/oauth-authorization-server",
          { headers: { "X-Forwarded-For": "198.51.100.1" } },
        );
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("60");
      },
      undefined,
      true,
      undefined,
      new VelocityLimit(2),
    ));
  it("attributes only deliberate browser handoffs and prevents open redirects", async () => {
    const events: unknown[] = [];
    await service(
      async (base) => {
        const path = base + "/handoff/futures";
        const plain = await fetch(path, { redirect: "manual" });
        expect(plain.status).toBe(303);
        expect(plain.headers.get("location")).toBe(
          "https://www.oilpriceapi.com/auth/signup?utm_source=openai-plugin&utm_medium=plugin&utm_campaign=energy-markets&utm_content=futures",
        );
        expect(events).toHaveLength(0);
        const navigate = (excluded = false) =>
          new Promise<number>((resolve) =>
            request(
              path,
              {
                headers: {
                  "Sec-Fetch-Mode": "navigate",
                  "Sec-Fetch-Dest": "document",
                  "Sec-Fetch-User": "?1",
                  ...(excluded ? { "X-OPA-Telemetry-Exclude": "1" } : {}),
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode!);
              },
            ).end(),
          );
        expect(await navigate()).toBe(303);
        expect(events).toEqual([
          {
            event: "plugin_handoff_visit",
            dataset_category: "futures",
            plugin_version: "0.1.1",
            population: "browser_navigation_proxy",
          },
        ]);
        await navigate(true);
        expect(events).toHaveLength(1);
        expect(
          (
            await fetch(path + "?redirect=https://evil.example", {
              redirect: "manual",
            })
          ).status,
        ).toBe(404);
        expect(
          (await fetch(base + "/handoff/private", { redirect: "manual" }))
            .status,
        ).toBe(404);
      },
      undefined,
      false,
      (event) => events.push(event),
    );
  });

  it("initializes, lists exactly seven read tools and calls demo end to end", async () =>
    service(async (base) => {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
          requestInit: { headers },
        }),
      );
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual([
          "energy_compare",
          "energy_drilling",
          "energy_futures_curve",
          "energy_get_price",
          "energy_history",
          "energy_marine_fuels",
          "energy_market_overview",
        ]);
        expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(
          true,
        );
        // Claude's directory requires annotations.title on every tool.
        for (const tool of tools.tools) {
          expect(tool.annotations?.title).toMatch(/^[A-Z][A-Za-z ]+$/);
          expect(tool.title).toBe(tool.annotations?.title);
        }
        const wireTools = await client.request(
          { method: "tools/list" },
          z.object({
            tools: z.array(
              z.looseObject({
                name: z.string(),
                inputSchema: z.looseObject({}),
              }),
            ),
          }),
        );
        for (const tool of wireTools.tools) {
          expect(tool.securitySchemes).toEqual([
            { type: "noauth" },
            { type: "oauth2", scopes: ["energy:read"] },
          ]);
          expect(tool._meta).toEqual({ securitySchemes: tool.securitySchemes });
          expect(tool.inputSchema.additionalProperties).toBe(false);
        }
        const result = await client.callTool({
          name: "energy_get_price",
          arguments: { benchmark: "WTI_USD" },
        });
        expect(result.structuredContent).toMatchObject({
          availability: "available",
          access: "demo",
          website_url: "https://www.oilpriceapi.com/",
        });
        const premium = await client.callTool({
          name: "energy_drilling",
          arguments: { geography: "Permian" },
        });
        expect(premium.isError).toBe(true);
        expect(premium._meta).toBeUndefined();
        expect(premium.structuredContent).toMatchObject({
          outcome: "entitlement",
        });
      } finally {
        await client.close();
      }
    }));
  it("serves health and the supplied challenge verbatim", async () =>
    service(async (base) => {
      expect((await fetch(base + "/health", { headers })).status).toBe(200);
      expect(
        await (
          await fetch(base + "/.well-known/openai-apps-challenge", { headers })
        ).text(),
      ).toBe("verbatim-value\n");
    }));
  it("rejects host/origin attacks and unknown routes", async () =>
    service(async (base) => {
      const badHost = await new Promise<number>((resolve) =>
        request(base + "/mcp", { headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).end(),
      );
      expect(badHost).toBe(421);
      expect(
        (
          await fetch(base + "/mcp", {
            headers: { ...headers, Origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(base + "/unknown", { headers })).status).toBe(404);
      expect((await fetch(base + "/mcp", { headers })).status).toBe(405);
    }));
  it("rejects malformed, oversized, batch and non-JSON requests", async () =>
    service(async (base) => {
      const post = (body: string, more = {}) =>
        fetch(base + "/mcp", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", ...more },
          body,
        });
      expect((await post("{")).status).toBe(400);
      expect((await post("[]")).status).toBe(400);
      expect((await post("x".repeat(20_000))).status).toBe(413);
      expect((await post("{}", { "Content-Type": "text/plain" })).status).toBe(
        415,
      );
      expect(
        (await post("{}", { Authorization: "Bearer invalid" })).status,
      ).toBe(401);
    }));
  it("enforces 429 regardless of spoofed forwarding headers", async () =>
    service(async (base) => {
      const post = () =>
        fetch(base + "/mcp", {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "X-Forwarded-For": String(Math.random()),
          },
          body: "{}",
        });
      await post();
      const denied = await post();
      expect(denied.status).toBe(429);
      expect(denied.headers.get("Retry-After")).toBe("60");
    }, new VelocityLimit(1)));
  it("runs metadata, registration, linking, PKCE token exchange and revocation over HTTP", async () =>
    service(
      async (base) => {
        const origin = base.replace("http:", "https:");
        const resource = origin + "/mcp";
        const meta = await (
          await fetch(base + "/.well-known/oauth-authorization-server")
        ).json();
        expect(meta.issuer).toBe(origin + "/");
        const protectedMeta = await (
          await fetch(base + "/.well-known/oauth-protected-resource/mcp")
        ).json();
        expect(protectedMeta.resource).toBe(resource);
        const registration = await fetch(base + "/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [
              "https://chatgpt.com/connector_platform_oauth_redirect",
            ],
            token_endpoint_auth_method: "none",
          }),
        });
        expect(registration.status).toBe(201);
        const client = await registration.json();
        const verifier = "x".repeat(43);
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const params = new URLSearchParams({
          client_id: client.client_id,
          response_type: "code",
          redirect_uri: client.redirect_uris[0],
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource,
          scope: "energy:read",
          state: "test-state",
        });
        const consent = await fetch(base + "/authorize?" + params);
        expect(consent.status).toBe(200);
        // Browser form POSTs send Origin: null under no-referrer. Keep the
        // same-origin identity while suppressing referrers to other sites.
        expect(consent.headers.get("referrer-policy")).toBe("same-origin");
        expect(consent.headers.get("content-security-policy")).toContain(
          "form-action 'self' https://chatgpt.com;",
        );
        const cookie = consent.headers.get("set-cookie")!.split(";")[0];
        const flow = /name="flow" value="([^"]+)"/.exec(
          await consent.text(),
        )![1];
        for (const rejectedOrigin of [
          undefined,
          "null",
          "https://attacker.invalid",
        ]) {
          const denied = await fetch(base + "/link", {
            method: "POST",
            redirect: "manual",
            headers: {
              ...(rejectedOrigin ? { Origin: rejectedOrigin } : {}),
              Cookie: cookie,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ flow, key: "user-api-key-value-1234" }),
          });
          expect(denied.status).toBe(403);
          expect(denied.headers.has("location")).toBe(false);
          expect(await denied.text()).not.toContain("user-api-key-value");
        }
        const mismatchedSession = await fetch(base + "/link", {
          method: "POST",
          redirect: "manual",
          headers: {
            Origin: origin,
            Cookie: "opa_oauth_flow=wrong-session",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ flow, key: "user-api-key-value-1234" }),
        });
        expect(mismatchedSession.status).toBe(400);
        expect(mismatchedSession.headers.has("location")).toBe(false);
        const linked = await fetch(base + "/link", {
          method: "POST",
          redirect: "manual",
          headers: {
            Origin: origin,
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ flow, key: "user-api-key-value-1234" }),
        });
        expect(linked.status).toBe(302);
        const code = new URL(linked.headers.get("location")!).searchParams.get(
          "code",
        )!;
        const token = await fetch(base + "/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: client.redirect_uris[0],
            resource,
          }),
        });
        expect(token.status).toBe(200);
        const tokens = await token.json();
        expect(JSON.stringify(tokens)).not.toContain("user-api-key");
        const revoke = await fetch(base + "/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: client.client_id,
            token: tokens.access_token,
          }),
        });
        expect(revoke.status).toBe(200);
        const invalid = await fetch(base + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + tokens.access_token,
          },
          body: "{}",
        });
        expect(invalid.status).toBe(401);
        expect(invalid.headers.get("www-authenticate")).toContain(
          "oauth-protected-resource/mcp",
        );
      },
      undefined,
      true,
    ));
  it("bounds limiter memory and expires windows", () => {
    const limit = new VelocityLimit(1, 10, 1);
    expect(limit.allow("a", 0)).toBe(true);
    expect(limit.allow("a", 1)).toBe(false);
    expect(limit.allow("b", 1)).toBe(false);
    expect(limit.allow("b", 11)).toBe(true);
  });
});
