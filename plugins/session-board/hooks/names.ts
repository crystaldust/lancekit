/** Session names kept on this machine, one store key per session id, so a reopened conversation gets its name back. */
export type NameEntry = { name: string; at: number }

export const NAME_KEY_PREFIX = 'name:'
export const NAME_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
export const NAME_MAX_ENTRIES = 200
/** A name in use is stamped anew once its entry is older than this, so pruning never takes it. */
export const NAME_REFRESH_MS = 24 * 60 * 60 * 1000

export const nameKey = (id: string): string => `${NAME_KEY_PREFIX}${id}`

/** The entry a stored value is, or null when it is not one. */
export function parseEntry(raw: unknown): NameEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { name, at } = raw as Record<string, unknown>
  return typeof name === 'string' && typeof at === 'number' && Number.isFinite(at) ? { name, at } : null
}

export function needsRefresh(entry: NameEntry, now: number): boolean {
  return now - entry.at > NAME_REFRESH_MS
}

/** The keys to delete from `[key, stored value]` pairs: malformed, older than 90 days, or beyond the newest 200. */
export function staleNames(entries: readonly (readonly [string, unknown])[], now: number): string[] {
  const valid: { key: string; at: number }[] = []
  const stale: string[] = []
  for (const [key, raw] of entries) {
    const entry = parseEntry(raw)
    if (entry === null || entry.at < now - NAME_MAX_AGE_MS) stale.push(key)
    else valid.push({ key, at: entry.at })
  }
  const over = valid.sort((a, b) => b.at - a.at).slice(NAME_MAX_ENTRIES)
  return [...stale, ...over.map(item => item.key)]
}
