import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { migrate, MIGRATIONS, openMemoryDatabase } from './db'
import { ensureAdmin } from './users/store'

const tables = (db: Database) =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)

const columns = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)

/** A database as a server before multi-user left it: migrated up to 0002, with data in it. */
function databaseAt0002() {
  const db = new Database(':memory:', { strict: true })
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  for (const { name, sql } of MIGRATIONS.slice(0, 2)) {
    db.exec(sql)
    db.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)').run(name)
  }
  db.exec(`
    INSERT INTO records (kind, id, changed_at, rev, data) VALUES ('repos', 'r1', 1, 1, '{}');
    UPDATE meta SET value = 1 WHERE key = 'rev';
    INSERT INTO tokens (id, token_hash, name, kind, created_at) VALUES ('t1', 'h1', 'Laptop', 'session', 1);
    INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, grant_types, created_at)
      VALUES ('c1', 'Claude', '[]', 'none', '[]', 1);
    INSERT INTO oauth_grants (id, client_id, refresh_hash, scope, resource, created_at, refreshed_at, expires_at)
      VALUES ('g1', 'c1', 'rh', 'codeducky', 'r', 1, 1, 2);
  `)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

describe('migrations', () => {
  it('creates the multi-user schema on a fresh database', () => {
    const db = openMemoryDatabase()
    expect(tables(db)).toEqual([
      'auth_flows',
      'auth_handoffs',
      'oauth_clients',
      'oauth_codes',
      'oauth_grants',
      'push_subscriptions',
      'records',
      'schema_migrations',
      'tokens',
      'users',
    ])
    expect(columns(db, 'records')).toContain('user_id')
    expect(columns(db, 'tokens')).toContain('user_id')
    expect(columns(db, 'oauth_codes')).toContain('user_id')
    expect(columns(db, 'oauth_grants')).toContain('user_id')
    expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
    expect(migrate(db)).toEqual([])
  })

  it('starts fresh from 0002, dropping single-user data but keeping registered clients', () => {
    const db = databaseAt0002()
    expect(migrate(db)).toEqual(['0003_multi_user', '0004_push_subscriptions'])
    expect(tables(db)).not.toContain('meta')
    for (const table of ['records', 'tokens', 'oauth_codes', 'oauth_grants', 'users']) {
      expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
    }
    expect(db.query<{ id: string }, []>('SELECT id FROM oauth_clients').all()).toEqual([{ id: 'c1' }])
  })

  it('deletes a user\'s data with the user, and refuses rows for unknown users', () => {
    const db = openMemoryDatabase()
    ensureAdmin(db)
    db.exec(`
      INSERT INTO records (user_id, kind, id, changed_at, rev, data) VALUES ('admin', 'repos', 'r1', 1, 1, '{}');
      INSERT INTO tokens (id, token_hash, user_id, name, kind, created_at) VALUES ('t1', 'h1', 'admin', 'Laptop', 'session', 1);
      INSERT INTO auth_handoffs (code_hash, user_id, challenge, expires_at) VALUES ('c', 'admin', 'x', 1);
      INSERT INTO push_subscriptions (user_id, token_id, endpoint, p256dh, auth, created_at) VALUES ('admin', 't1', 'https://push.example/1', 'k', 'a', 1);
    `)
    expect(() =>
      db.exec("INSERT INTO records (user_id, kind, id, changed_at, rev) VALUES ('nobody', 'repos', 'r1', 1, 1)"),
    ).toThrow(/FOREIGN KEY/)
    db.exec("DELETE FROM users WHERE id = 'admin'")
    for (const table of ['records', 'tokens', 'auth_handoffs', 'push_subscriptions']) {
      expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
    }
  })

  it('drops a push subscription with the device session that registered it', () => {
    const db = openMemoryDatabase()
    ensureAdmin(db)
    db.exec(`
      INSERT INTO tokens (id, token_hash, user_id, name, kind, created_at) VALUES ('t1', 'h1', 'admin', 'Laptop', 'session', 1);
      INSERT INTO tokens (id, token_hash, user_id, name, kind, created_at) VALUES ('t2', 'h2', 'admin', 'Phone', 'session', 1);
      INSERT INTO push_subscriptions (user_id, token_id, endpoint, p256dh, auth, created_at) VALUES ('admin', 't1', 'https://push.example/1', 'k', 'a', 1);
      INSERT INTO push_subscriptions (user_id, token_id, endpoint, p256dh, auth, created_at) VALUES ('admin', 't2', 'https://push.example/2', 'k', 'a', 1);
    `)
    db.exec("DELETE FROM tokens WHERE id = 't1'")
    expect(db.query<{ endpoint: string }, []>('SELECT endpoint FROM push_subscriptions').all()).toEqual([{ endpoint: 'https://push.example/2' }])
  })
})
