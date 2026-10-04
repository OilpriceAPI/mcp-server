import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const endpoint = "https://mcp.oilpriceapi.com/mcp";
const origin = new URL(endpoint).origin;
const key = process.env.OILPRICEAPI_TEST_KEY;
const verifier = randomBytes(32).toString("base64url");
const redirectUri = "http://127.0.0.1:8976/callback";
let client;
let tokens;
async function form(path, body) {
  return fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
}
async function review() {
  if (!key || key.length < 16) throw new Error("Missing synthetic test key");
  const registration = await fetch(origin + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_name: "OilPriceAPI internal production review",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (registration.status !== 201) throw new Error("Registration failed");
  client = await registration.json();
  const authorize = new URL(origin + "/authorize");
  for (const [name, value] of Object.entries({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "energy:read",
    resource: endpoint,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }))
    authorize.searchParams.set(name, value);
  const page = await fetch(authorize, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!page.ok) throw new Error("Authorization failed");
  const cookie = page.headers.get("set-cookie")?.split(";")[0];
  const flow = (await page.text()).match(
    /name="flow" value="([A-Za-z0-9_-]+)"/,
  )?.[1];
  if (!cookie || !flow) throw new Error("Missing secure authorization form");
  const link = await fetch(origin + "/link", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Cookie: cookie,
    },
    body: new URLSearchParams({ flow, key }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (link.status !== 302) throw new Error("Account link failed");
  const callback = new URL(link.headers.get("location"));
  if (
    callback.origin !== new URL(redirectUri).origin ||
    callback.pathname !== "/callback" ||
    callback.searchParams.get("iss") !== origin + "/"
  )
    throw new Error("Unexpected callback");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  const exchange = await form("/token", {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: endpoint,
  });
  if (!exchange.ok) throw new Error("Token exchange failed");
  tokens = await exchange.json();
  if (!tokens.access_token || !tokens.refresh_token)
    throw new Error("Missing tokens");
  const childEnv = {
    ...process.env,
    OILPRICEAPI_MCP_ACCESS_TOKEN: tokens.access_token,
  };
  delete childEnv.OILPRICEAPI_TEST_KEY;
  const smoke = spawnSync(
    process.execPath,
    ["scripts/smoke-remote.mjs", endpoint],
    {
      env: childEnv,
      stdio: "inherit",
      timeout: 180000,
    },
  );
  if (smoke.status !== 0)
    throw new Error("Authenticated tool contracts failed");
}
try {
  await review();
} catch {
  // Never print upstream bodies, OAuth identifiers, tokens or the API key.
  console.error(
    "Authenticated production review failed; no secret details logged.",
  );
  process.exitCode = 1;
} finally {
  if (client && tokens) {
    try {
      const revoked = await form("/revoke", {
        client_id: client.client_id,
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
      });
      if (!revoked.ok) throw new Error("Revocation failed");
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      if (rejected.status !== 401)
        throw new Error("Revoked token still usable");
      console.log("Production OAuth grant and revocation verified.");
    } catch {
      console.error("Production OAuth cleanup could not be verified.");
      process.exitCode = 1;
    }
  }
}
