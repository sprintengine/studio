import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { getRendererHost } from '../../modules'
import type { AgentCli } from '../../types/workspace'
import type { ReviewBriefRunDepth } from '../../../../shared/electron-api'

// Review's app-level state (MC-2090). These two values belong to the module, not
// to any workspace and not to core's settings: the reviewer's last guide
// preparation choices, and the review the Reviews door should reopen on. They
// used to live in `appSettings.reviewGuideDefaults` / `appSettings.lastSelectedReview`,
// which meant core's settings slice carried review's shape and normalizers.
//
// They read through `RendererHost.getModuleAppState`, which is store-backed and
// synchronous — that is why the surface exists rather than routing these through
// the main-process `ModuleStorageService`: both are read inside render, and an
// async hydration would flash a default before the remembered value arrived.

/** A remembered Reviews-door selection: a review id scoped to its project root. */
export type LastSelectedReview = {
  reviewId: string
  workspaceRoot: string
}

/**
 * Last-used review-guide preparation choices. `cli: null` means the reviewer has
 * never picked one for the guide, which resolves to the agent CLI they last used
 * elsewhere rather than a hardcoded engine — and keeps this key independent of
 * `lastSelectedCli`, so picking a guide agent never changes what "New chat"
 * spawns. `model` is only meaningful for the `cli` it was picked for.
 */
export type ReviewGuideDefaults = {
  depth: ReviewBriefRunDepth
  cli: AgentCli | null
  model: string | null
}

export const REVIEW_GUIDE_DEFAULTS_KEY = 'guide-defaults'
export const LAST_SELECTED_REVIEW_KEY = 'last-selected-review'

const REVIEW_GUIDE_DEPTHS: ReviewGuideDefaults['depth'][] = ['brief', 'standard', 'thorough']

// Persisted values are untrusted the same way they were in the settings slice:
// an unknown depth falls back to `standard` rather than riding a value the guide
// skill cannot render, and a model is dropped without the CLI it was picked for.
export function normalizeReviewGuideDefaults(input: unknown): ReviewGuideDefaults {
  const source = (input && typeof input === 'object' ? input : {}) as Partial<ReviewGuideDefaults>
  const depth = REVIEW_GUIDE_DEPTHS.includes(source.depth as ReviewGuideDefaults['depth'])
    ? (source.depth as ReviewGuideDefaults['depth'])
    : 'standard'
  const cli = typeof source.cli === 'string' && source.cli.trim() ? (source.cli.trim() as AgentCli) : null
  const model = cli && typeof source.model === 'string' && source.model.trim() ? source.model.trim() : null
  return { depth, cli, model }
}

export function normalizeLastSelectedReview(input: unknown): LastSelectedReview | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Partial<LastSelectedReview>
  const reviewId = typeof source.reviewId === 'string' ? source.reviewId.trim() : ''
  const workspaceRoot = typeof source.workspaceRoot === 'string' ? source.workspaceRoot.trim() : ''
  if (!reviewId || !workspaceRoot) return null
  return { reviewId, workspaceRoot }
}

const host = (): ReturnType<ReturnType<typeof getRendererHost>['hostFor']> =>
  getRendererHost().hostFor('review')

export function readReviewGuideDefaults(): ReviewGuideDefaults {
  return normalizeReviewGuideDefaults(host().getModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY))
}

export function writeReviewGuideDefaults(patch: Partial<ReviewGuideDefaults>): void {
  const next = normalizeReviewGuideDefaults({ ...readReviewGuideDefaults(), ...patch })
  host().setModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY, next)
}

export function writeLastSelectedReview(selection: LastSelectedReview | null): void {
  host().setModuleAppState(LAST_SELECTED_REVIEW_KEY, normalizeLastSelectedReview(selection))
}

// The raw entry, not a normalized one: `useSyncExternalStore` compares snapshots
// by identity, so normalizing here (which builds a fresh object every call)
// would re-render forever. Callers normalize the raw value under a `useMemo`.
function useRawModuleAppState(key: string): unknown {
  const subscribe = useCallback((onChange: () => void) => host().watchModuleAppState(onChange), [])
  const getSnapshot = useCallback(() => host().getModuleAppState(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useReviewGuideDefaults(): ReviewGuideDefaults {
  const raw = useRawModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY)
  return useMemo(() => normalizeReviewGuideDefaults(raw), [raw])
}

export function useLastSelectedReview(): LastSelectedReview | null {
  const raw = useRawModuleAppState(LAST_SELECTED_REVIEW_KEY)
  return useMemo(() => normalizeLastSelectedReview(raw), [raw])
}
