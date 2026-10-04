/** localStorage can be blocked or full; these never throw, so a failing store only costs persistence. */

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    console.warn(`Could not read ${key} from storage`, error)
    return null
  }
}

/** Returns whether the value was stored. */
export function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (error) {
    console.warn(`Could not write ${key} to storage`, error)
    return false
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.warn(`Could not remove ${key} from storage`, error)
  }
}

/** The parsed value, or null when it is missing, unreadable or not valid JSON. */
export function readJson<T>(key: string): T | null {
  const raw = readStorage(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn(`Could not parse ${key} from storage`, error)
    return null
  }
}

export function writeJson(key: string, value: unknown): boolean {
  return writeStorage(key, JSON.stringify(value))
}
