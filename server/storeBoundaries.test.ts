import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Per-user tables and the one module allowed to query each, so every query goes through a user-scoped API. */
const OWNERS: Record<string, string> = {
  records: 'records/store.ts',
  tokens: 'auth/tokens.ts',
  oauth_codes: 'auth/oauth/store.ts',
  oauth_grants: 'auth/oauth/store.ts',
  push_subscriptions: 'push/store.ts',
}

const QUERY = new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN)\\s+(${Object.keys(OWNERS).join('|')})\\b`, 'g')

describe('store boundaries', () => {
  it('queries per-user tables only inside their store modules', () => {
    const offenders: string[] = []
    for (const path of new Bun.Glob('**/*.ts').scanSync(import.meta.dirname)) {
      if (path.endsWith('.test.ts')) continue
      const source = readFileSync(join(import.meta.dirname, path), 'utf8')
      for (const [, table] of source.matchAll(QUERY)) if (OWNERS[table!] !== path) offenders.push(`${path}: ${table}`)
    }
    expect(offenders).toEqual([])
  })

  it('finds the queries it guards against', () => {
    expect('SELECT id FROM records WHERE kind = ?'.match(QUERY)).toEqual(['FROM records'])
    expect('DELETE FROM oauth_grants'.match(QUERY)).toEqual(['FROM oauth_grants'])
    expect('SELECT t.id FROM sessions s JOIN tokens t'.match(QUERY)).toEqual(['JOIN tokens'])
  })
})
