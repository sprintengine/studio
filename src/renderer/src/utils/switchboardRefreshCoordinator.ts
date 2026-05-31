const SWITCHBOARD_VISIBLE_REFRESH_MIN_MS = 15_000
const SWITCHBOARD_HIDDEN_REFRESH_MIN_MS = 60_000

type RefreshCacheEntry<T> = {
  inFlight: Promise<SwitchboardRefreshResult<T>> | null
  lastLoadedAt: number
  value: T | undefined
  generation: number
}

export type SwitchboardRefreshOptions = {
  force?: boolean
  now?: () => number
  isHidden?: () => boolean
}

export type SwitchboardRefreshResult<T> =
  | { kind: 'loaded'; value: T; shared: boolean }
  | { kind: 'cached'; value: T }

const cache = new Map<string, RefreshCacheEntry<unknown>>()

export const SWITCHBOARD_REFRESH_POLL_INTERVAL_MS = SWITCHBOARD_VISIBLE_REFRESH_MIN_MS

export function switchboardRefreshMinIntervalMs(isHidden = isDocumentHidden()): number {
  return isHidden ? SWITCHBOARD_HIDDEN_REFRESH_MIN_MS : SWITCHBOARD_VISIBLE_REFRESH_MIN_MS
}

export function clearSwitchboardRefreshCoordinatorForTests(): void {
  cache.clear()
}

export function rememberSwitchboardRefreshValue<T>(
  key: string,
  value: T,
  options: Pick<SwitchboardRefreshOptions, 'now'> = {}
): void {
  const entry = getEntry<T>(key)
  entry.value = value
  entry.lastLoadedAt = options.now?.() ?? Date.now()
  entry.generation += 1
}

export async function runSwitchboardRefresh<T>(
  key: string,
  load: () => Promise<T>,
  options: SwitchboardRefreshOptions = {}
): Promise<SwitchboardRefreshResult<T>> {
  const entry = getEntry<T>(key)
  if (entry.inFlight) {
    const result = await entry.inFlight
    return result.kind === 'loaded'
      ? { ...result, shared: true }
      : result
  }

  const now = options.now?.() ?? Date.now()
  const isHidden = options.isHidden?.() ?? isDocumentHidden()
  const minIntervalMs = switchboardRefreshMinIntervalMs(isHidden)
  if (!options.force && entry.value !== undefined && now - entry.lastLoadedAt < minIntervalMs) {
    return { kind: 'cached', value: entry.value }
  }

  const generationAtStart = entry.generation
  const promise = load().then((value): SwitchboardRefreshResult<T> => {
    if (entry.generation !== generationAtStart && entry.value !== undefined) {
      return { kind: 'cached', value: entry.value }
    }
    entry.value = value
    entry.lastLoadedAt = options.now?.() ?? Date.now()
    entry.generation += 1
    return { kind: 'loaded', value, shared: false }
  })
  entry.inFlight = promise
  try {
    return await promise
  } finally {
    entry.inFlight = null
  }
}

function getEntry<T>(key: string): RefreshCacheEntry<T> {
  const existing = cache.get(key) as RefreshCacheEntry<T> | undefined
  if (existing) return existing
  const entry: RefreshCacheEntry<T> = {
    inFlight: null,
    lastLoadedAt: 0,
    value: undefined,
    generation: 0,
  }
  cache.set(key, entry as RefreshCacheEntry<unknown>)
  return entry
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}
