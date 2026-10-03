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
