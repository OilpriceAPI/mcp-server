# Remote MCP production release

This spec belongs only to `oilpriceapi-openai-mcp`, DigitalOcean app
`4a89cb34-72a3-4daf-a893-0628699ded26`. The API and frontend use other apps.

Build `Dockerfile.remote` for `linux/amd64` from the reviewed source commit in
the spec header. Label the image with `org.opencontainers.image.revision`, run
the remote container smoke with an isolated PostgreSQL database, push it to
the existing DO registry, and pin its immutable digest. Never deploy a mutable
tag or infer the served source from a successful build alone.

The dedicated `mcp_oauth` database and role on `opa-2025-nyc-db` are prepared.
The role owns only the new database; public connection/temp privileges on that
database and public schema-creation privileges were revoked. The application
creates its own table and indexes at startup. Its pool is capped at four
connections per instance. Keep `instance_count: 1` unless capacity is reviewed.

Before applying the spec, inject `OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY` as a
`RUN_TIME` environment variable of type `SECRET`. The 32-byte key is backed up
in the Mac login Keychain under service `OilPriceAPI MCP production OAuth`,
account `OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY`; retrieve it through Keychain
Access or the macOS keyring API. Verify readback without printing the key.
Keep it out of command arguments, logs, source control and release receipts.
Retain the same key on later deployments: changing or losing it invalidates
stored connections. The versioned YAML deliberately contains no key value
and is not a complete deploy command on its own.

Reconcile against the current live app spec before every update. Preserve its
domain, allowed origins, ingress, capacity and unrelated environment settings.
The database binding supplies its URL and CA certificate. Confirm the MCP app
is a trusted source on the database cluster. A production boot without the
database/key fails closed; a bound CA is verified with hostname validation.

After activation, verify the serving deployment's image digest, `/health`
version `0.1.2`, and `oauth_store_ready` with `durable: true`. Run anonymous and
authenticated tool smokes, then obtain a synthetic OAuth grant, deploy the
same image once, and prove refresh and authenticated retrieval still work.
Reject refresh-token replay and verify revocation rejects both old and new
access tokens. Review runtime logs for new errors and failed requests.

The initial transition from the old in-memory store requires existing users
to reconnect once. Later restarts retain the registered client and unexpired
encrypted tokens. Rollback pins the prior digest recorded in the spec header,
preserving the database and key. Rolling back to the old memory-only image
also requires reconnecting; never drop the database as part of rollback.
