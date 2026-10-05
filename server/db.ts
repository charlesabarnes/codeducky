import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Applied in order; each runs once and is recorded in schema_migrations. Append only. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '0001_init',
    sql: `
      CREATE TABLE records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL,
        data TEXT,
        PRIMARY KEY (kind, id)
      );
      CREATE UNIQUE INDEX records_rev ON records (rev);

      CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO meta (key, value) VALUES ('rev', 0);

      CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('session', 'api', 'oauth')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        client_id TEXT,
        scope TEXT
      );
    `,
  },
  {
    name: '0002_oauth',
    sql: `
      CREATE TABLE oauth_clients (
        id TEXT PRIMARY KEY,
        secret_hash TEXT,
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        grant_types TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE oauth_grants (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        refresh_hash TEXT NOT NULL UNIQUE,
        previous_refresh_hash TEXT,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        refreshed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX oauth_grants_previous ON oauth_grants (previous_refresh_hash);

      ALTER TABLE tokens ADD COLUMN grant_id TEXT;
      CREATE INDEX tokens_grant ON tokens (grant_id);
    `,
  },
  {
    name: '0003_multi_user',
    sql: `
      DROP TABLE records;
      DROP TABLE meta;
      DROP TABLE tokens;
      DROP TABLE oauth_codes;
      DROP TABLE oauth_grants;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        github_id INTEGER UNIQUE,
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        rev INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        data_bytes INTEGER NOT NULL DEFAULT 0,
        quota_records INTEGER,
        quota_bytes INTEGER,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        last_seen_at INTEGER
      );

      CREATE TABLE records (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL,
        data TEXT,
        PRIMARY KEY (user_id, kind, id)
      );
      CREATE UNIQUE INDEX records_user_rev ON records (user_id, rev);

      CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('session', 'api', 'oauth')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        client_id TEXT,
        scope TEXT,
        grant_id TEXT
      );
      CREATE INDEX tokens_user ON tokens (user_id);
      CREATE INDEX tokens_grant ON tokens (grant_id);

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE oauth_grants (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        refresh_hash TEXT NOT NULL UNIQUE,
        previous_refresh_hash TEXT,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        refreshed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX oauth_grants_previous ON oauth_grants (previous_refresh_hash);
      CREATE INDEX oauth_grants_user ON oauth_grants (user_id);

      CREATE TABLE auth_flows (
        id_hash TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('pwa', 'oauth')),
        github_verifier TEXT NOT NULL,
        pwa_challenge TEXT,
        oauth_request TEXT,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        consent_hash TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE auth_handoffs (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: '0004_push_subscriptions',
    sql: `
      CREATE TABLE push_subscriptions (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        notify_tasks INTEGER NOT NULL DEFAULT 1,
        notify_requests INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
      CREATE INDEX push_subscriptions_token ON push_subscriptions (token_id);
    `,
  },
]

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  return prepare(new Database(path, { create: true, strict: true }))
}

export function openMemoryDatabase(): Database {
  return prepare(new Database(':memory:', { strict: true }))
}

function prepare(db: Database): Database {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  // Per connection, and a no-op inside a transaction, so it is set here rather than in a migration.
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Database): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    db
      .query<{ name: string }, []>('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  )
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.name))
  for (const { name, sql } of pending) {
    db.transaction(() => {
      db.exec(sql)
      db.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
    })()
  }
  return pending.map((migration) => migration.name)
}
