import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJson, readStorage, removeStorage, writeJson, writeStorage } from '../../src/app/storage'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

function failingStorage(): Storage {
  const fail = () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
  }
  return { ...memoryStorage(), getItem: fail, setItem: fail, removeItem: fail }
}

describe('storage', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads, writes and removes when storage works', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(readStorage('k')).toBeNull()
    expect(writeStorage('k', 'v')).toBe(true)
    expect(readStorage('k')).toBe('v')
    removeStorage('k')
    expect(readStorage('k')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('round-trips JSON', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(writeJson('k', { a: [1, 2] })).toBe(true)
    expect(readJson('k')).toEqual({ a: [1, 2] })
  })

  it('returns null and warns when getItem throws', () => {
    vi.stubGlobal('localStorage', failingStorage())
    expect(readStorage('k')).toBeNull()
    expect(readJson('k')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('returns false and warns when setItem throws', () => {
    vi.stubGlobal('localStorage', failingStorage())
    expect(writeStorage('k', 'v')).toBe(false)
    expect(writeJson('k', {})).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('warns instead of throwing when removeItem throws', () => {
    vi.stubGlobal('localStorage', failingStorage())
    expect(() => removeStorage('k')).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('treats a missing localStorage as unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readStorage('k')).toBeNull()
    expect(writeStorage('k', 'v')).toBe(false)
  })

  it('returns null and warns on bad JSON', () => {
    const storage = memoryStorage()
    storage.setItem('k', '{not json')
    vi.stubGlobal('localStorage', storage)
    expect(readJson('k')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})
