import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Durable state for the remote MCP OAuth provider (issue #155).
 *
 * Rows are keyed by `kind` and a SHA-256 hash of the bearer value (flow,
 * code, access token, refresh token) or of the client_id. The raw bearer value
 * is never stored. Everything else about a row (PKCE parameters, redirect,
 * client metadata and secret, the customer's OilPriceAPI key) lives in `data`,
 * which the provider seals with AES-256-GCM before it reaches the store.
 */
export type RecordKind =
  "client" | "form" | "code" | "linked" | "access" | "refresh";

export interface StoredRecord {
  clientId: string;
  /** HMAC of the customer's API key; lets revocation find sibling grants. */
  subject?: string;
  /** Sealed payload. Opaque to the store. */
  data: string;
  /** Epoch milliseconds. Rows at or past this instant are never returned. */
  expires: number;
}

export interface OAuthStore {
  get(
    kind: RecordKind,
    id: string,
    now: number,
  ): Promise<StoredRecord | undefined>;
  put(kind: RecordKind, id: string, record: StoredRecord): Promise<void>;
  /** Atomic read-and-delete, so a code or refresh token is single-use even across instances. */
  take(
    kind: RecordKind,
    id: string,
    now: number,
  ): Promise<StoredRecord | undefined>;
  delete(kind: RecordKind, id: string): Promise<void>;
  count(kind: RecordKind, now: number): Promise<number>;
  revokeSubject(
    clientId: string,
    subject: string,
    kinds: RecordKind[],
  ): Promise<void>;
  prune(now: number): Promise<void>;
  close(): Promise<void>;
}

/** Process-local store for tests and local development. Lost on restart. */
export class MemoryOAuthStore implements OAuthStore {
  readonly durable = false;
  private rows = new Map<string, StoredRecord>();
  private key = (kind: RecordKind, id: string) => `${kind}\u0000${id}`;
  async get(kind: RecordKind, id: string, now: number) {
    const row = this.rows.get(this.key(kind, id));
    return row && row.expires > now ? { ...row } : undefined;
  }
  async put(kind: RecordKind, id: string, record: StoredRecord) {
    this.rows.set(this.key(kind, id), { ...record });
  }
  async take(kind: RecordKind, id: string, now: number) {
    // No await between read and delete: the take is atomic on the event loop.
    const key = this.key(kind, id);
    const row = this.rows.get(key);
    this.rows.delete(key);
    return row && row.expires > now ? { ...row } : undefined;
  }
  async delete(kind: RecordKind, id: string) {
    this.rows.delete(this.key(kind, id));
  }
  async count(kind: RecordKind, now: number) {
    let n = 0;
    for (const [key, row] of this.rows)
      if (key.startsWith(kind + "\u0000") && row.expires > now) n++;
    return n;
  }
  async revokeSubject(clientId: string, subject: string, kinds: RecordKind[]) {
    for (const [key, row] of this.rows)
      if (
        row.clientId === clientId &&
        row.subject === subject &&
        kinds.some((kind) => key.startsWith(kind + "\u0000"))
      )
        this.rows.delete(key);
  }
  async prune(now: number) {
    for (const [key, row] of this.rows)
      if (row.expires <= now) this.rows.delete(key);
  }
  async close() {}
  /** Test helper: raw rows as they sit at rest. */
  snapshot() {
    return [...this.rows.entries()].map(([key, row]) => ({
      kind: key.split("\u0000")[0] as RecordKind,
      id: key.split("\u0000")[1],
      ...row,
    }));
  }
}

interface PgPoolLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

const TABLE = "mcp_oauth_records";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    kind text NOT NULL,
    id text NOT NULL,
    client_id text NOT NULL,
    subject text,
    data text NOT NULL,
    expires_at bigint NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_subject_idx ON ${TABLE} (client_id, subject)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at)`,
];

const toRecord = (row: Record<string, unknown>): StoredRecord => ({
  clientId: String(row.client_id),
  subject: row.subject == null ? undefined : String(row.subject),
  data: String(row.data),
  expires: Number(row.expires_at),
});

/** Postgres-backed store. One table, created on first start. */
export class PostgresOAuthStore implements OAuthStore {
  readonly durable = true;
  private constructor(private pool: PgPoolLike) {}
  static async connect(options: {
    connectionString: string;
    caCert?: string;
    pool?: PgPoolLike;
  }) {
    let pool = options.pool;
    if (!pool) {
      const { default: pg } = await import("pg");
      let connectionString = options.connectionString;
      let ssl: { ca: string; rejectUnauthorized: true } | undefined;
      if (options.caCert) {
        // pg lets sslmode in the URL override an explicit ssl object, which
        // would drop the CA. Verify against the bound cluster CA instead.
        const url = new URL(connectionString);
        url.searchParams.delete("sslmode");
        connectionString = url.href;
        ssl = { ca: options.caCert, rejectUnauthorized: true };
      }
      pool = new pg.Pool({
        connectionString,
        ssl,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
      }) as unknown as PgPoolLike;
    }
    for (const statement of SCHEMA) await pool.query(statement);
    return new PostgresOAuthStore(pool);
  }
  async get(kind: RecordKind, id: string, now: number) {
    const { rows } = await this.pool.query(
      `SELECT client_id, subject, data, expires_at FROM ${TABLE}
       WHERE kind = $1 AND id = $2 AND expires_at > $3`,
      [kind, id, now],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }
  async put(kind: RecordKind, id: string, record: StoredRecord) {
    await this.pool.query(
      `INSERT INTO ${TABLE} (kind, id, client_id, subject, data, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (kind, id) DO UPDATE SET client_id = EXCLUDED.client_id,
         subject = EXCLUDED.subject, data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [
        kind,
        id,
        record.clientId,
        record.subject ?? null,
        record.data,
        record.expires,
      ],
    );
  }
  async take(kind: RecordKind, id: string, now: number) {
    const { rows } = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE kind = $1 AND id = $2
       RETURNING client_id, subject, data, expires_at`,
      [kind, id],
    );
    const row = rows[0] ? toRecord(rows[0]) : undefined;
    return row && row.expires > now ? row : undefined;
  }
  async delete(kind: RecordKind, id: string) {
    await this.pool.query(`DELETE FROM ${TABLE} WHERE kind = $1 AND id = $2`, [
      kind,
      id,
    ]);
  }
  async count(kind: RecordKind, now: number) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE kind = $1 AND expires_at > $2`,
      [kind, now],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async revokeSubject(clientId: string, subject: string, kinds: RecordKind[]) {
    await this.pool.query(
      `DELETE FROM ${TABLE} WHERE client_id = $1 AND subject = $2 AND kind = ANY($3::text[])`,
      [clientId, subject, kinds],
    );
  }
  async prune(now: number) {
    await this.pool.query(`DELETE FROM ${TABLE} WHERE expires_at <= $1`, [now]);
  }
  async close() {
    await this.pool.end();
  }
}

/**
 * Seals record payloads with AES-256-GCM and derives revocation subjects with
 * HMAC-SHA256. Both keys are HKDF subkeys of one 32-byte master key. The row's
 * kind and id are bound as associated data, so a sealed payload cannot be
 * moved onto another row.
 */
export class Sealer {
  private sealKey: Buffer;
  private subjectKey: Buffer;
  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32)
      throw new Error("OAuth encryption key must be 32 bytes");
    const derive = (info: string) =>
      Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), info, 32));
    this.sealKey = derive("opa-mcp-oauth/seal/v1");
    this.subjectKey = derive("opa-mcp-oauth/subject/v1");
  }
  static fromEnv(value: string | undefined) {
    if (!value) return undefined;
    const trimmed = value.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
    if (key.length !== 32)
      throw new Error(
        "OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY must be 32 bytes, base64 or hex encoded",
      );
    return new Sealer(key);
  }
  static ephemeral() {
    return new Sealer(randomBytes(32));
  }
  seal(aad: string, payload: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      body.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  }
  open<T>(aad: string, sealed: string): T {
    const [version, iv, body, tag] = sealed.split(".");
    if (version !== "v1" || !iv || body === undefined || !tag)
      throw new Error("Unsupported sealed record");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.sealKey,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  }
  subject(apiKey: string) {
    return createHmac("sha256", this.subjectKey)
      .update(apiKey)
      .digest("base64url");
  }
}

export interface OAuthPersistence {
  store: OAuthStore & { durable: boolean };
  sealer: Sealer;
}

/**
 * Chooses the store from the environment. Fails closed: production requires
 * both a durable store and an encryption key, and a durable store always
 * requires the key, so a misconfigured deploy refuses to start instead of
 * silently falling back to memory or plaintext.
 */
export async function oauthPersistenceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof PostgresOAuthStore.connect = (o) =>
    PostgresOAuthStore.connect(o),
): Promise<OAuthPersistence> {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.OILPRICEAPI_MCP_OAUTH_DATABASE_URL;
  const sealer = Sealer.fromEnv(env.OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY);
  if (!sealer && (production || databaseUrl))
    throw new Error(
      "OILPRICEAPI_MCP_OAUTH_ENCRYPTION_KEY is required to store OAuth connections",
    );
  if (!databaseUrl) {
    if (production)
      throw new Error(
        "OILPRICEAPI_MCP_OAUTH_DATABASE_URL is required in production; in-memory OAuth state is lost on every restart",
      );
    return {
      store: new MemoryOAuthStore(),
      sealer: sealer ?? Sealer.ephemeral(),
    };
  }
  const store = await connect({
    connectionString: databaseUrl,
    caCert: env.OILPRICEAPI_MCP_OAUTH_DATABASE_CA_CERT || undefined,
  });
  return { store, sealer: sealer! };
}
