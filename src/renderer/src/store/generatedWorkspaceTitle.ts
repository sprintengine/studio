/**
 * Titling a chat from its first prompt, both halves in one place: the local
 * heuristic lands at once, and — when the person has it on and a supported
 * agent CLI is installed — a model-written title replaces it when it arrives.
 *
 * The order matters. The heuristic is the fallback for every failure mode
 * (off, no CLI, timeout, guardrail, a bad answer), so it goes first and the
 * model's answer is an upgrade on top, never a wait. Both land through the
 * store, which owns the one rule that keeps a late answer honest: it replaces
 * exactly the name it was asked to replace, so a hand rename in the meantime
 * stands (`applyGeneratedWorkspaceTitle`).
 *
 * Failure is silence. No toast, no log line at warning level: an absent title
 * is the heuristic title, which is what the app showed before this existed.
 */

import type { ChatTitleRequest, TextGenerationResult } from '../../../shared/text-generation/contract'
import { resolveTextGenerationEngine } from '../../../shared/text-generation/contract'
import type { AgentCli, WorkspaceId } from '../types/workspace'
import { useWorkspaceStore } from './workspaceStore'

export type GeneratedTitleRequesterDeps = {
  /** The heuristic half. Returns the title it applied, or null. */
  autoTitle: (id: WorkspaceId, prompt: string) => string | null
  /** The late half. Returns whether the title landed. */
  applyGenerated: (id: WorkspaceId, title: string, replacing: string | null) => boolean
  /** Whether the workspace's name is still the app's to change. */
  isTitleOpen: (id: WorkspaceId) => boolean
  /** The engine to use right now, or null when no call should be made. */
  resolveEngine: () => ChatTitleRequest['engine'] | null
  cliRuntimes: () => ChatTitleRequest['cliRuntimes']
  generate: (request: ChatTitleRequest) => Promise<TextGenerationResult>
}

export type GeneratedTitleRequester = {
  /**
   * Title `id` from `prompt`. Returns the heuristic outcome synchronously; the
   * generated title, if any, lands later through `applyGenerated`. Never
   * rejects.
   */
  titleFromPrompt: (id: WorkspaceId, prompt: string) => string | null
}

/**
 * One more try after a failure that was about the transport — a killed
 * process, a non-zero exit, a deadline — and never after one that was about
 * the answer (guardrail) or the machine (no CLI). One retry is enough for a
 * title nobody is waiting on.
 */
export const GENERATED_TITLE_RETRY_DELAY_MS = 2_000

export function createGeneratedTitleRequester(
  deps: GeneratedTitleRequesterDeps,
  options: { retryDelayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): GeneratedTitleRequester {
  const retryDelayMs = options.retryDelayMs ?? GENERATED_TITLE_RETRY_DELAY_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const generateWithRetry = async (request: ChatTitleRequest): Promise<TextGenerationResult> => {
    const first = await deps.generate(request)
    if (first.ok || (first.code !== 'transport' && first.code !== 'timeout')) return first
    await wait(retryDelayMs)
    return deps.generate(request)
  }

  return {
    titleFromPrompt: (id, prompt) => {
      const interim = deps.autoTitle(id, prompt)
      // The heuristic applied nothing AND the name is not ours to change: a
      // locked workspace, or one that no longer exists. No call is made — a
      // second agent's first prompt in an already-titled chat must not spend
      // a title on a name that could never land.
      if (interim === null && !deps.isTitleOpen(id)) return null
      const engine = deps.resolveEngine()
      if (!engine) return interim
      void generateWithRetry({ prompt, engine, cliRuntimes: deps.cliRuntimes() })
        .then((result) => {
          if (result.ok) deps.applyGenerated(id, result.value, interim)
        })
        .catch(() => undefined)
      return interim
    },
  }
}

/**
 * The engine for a call made now, read straight off the store: the setting,
 * the installed-plugin catalog in its own order, and the availability probe's
 * verdict per CLI. Only an explicit `installed: false` excludes a CLI, the
 * same trust rule the deployment pickers apply.
 */
export function resolveStoreTextGenerationEngine(): ChatTitleRequest['engine'] | null {
  const state = useWorkspaceStore.getState()
  const candidates = (state.pluginCatalogEntries ?? []).map((entry) => entry.id)
  const availability = state.cliAvailability
  return resolveTextGenerationEngine(state.appSettings.textGeneration, candidates, (cli: AgentCli) => {
    const entry = availability?.[cli]
    return entry ? entry.installed : undefined
  })
}

let defaultRequester: GeneratedTitleRequester | null = null

/** The app's requester, bound to the store and the preload bridge. */
export function generatedWorkspaceTitleRequester(): GeneratedTitleRequester {
  if (!defaultRequester) {
    defaultRequester = createGeneratedTitleRequester({
      autoTitle: (id, prompt) => useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(id, prompt),
      applyGenerated: (id, title, replacing) =>
        useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(id, title, replacing),
      isTitleOpen: (id) => {
        const ws = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === id)
        return Boolean(ws) && !ws?.titleLocked
      },
      resolveEngine: resolveStoreTextGenerationEngine,
      cliRuntimes: () => useWorkspaceStore.getState().appSettings.cliRuntimes,
      generate: (request) => {
        const api = typeof window !== 'undefined' ? window.api : undefined
        if (!api?.generateChatTitle) {
          return Promise.resolve({ ok: false, code: 'unavailable', message: 'Text generation bridge is unavailable.' })
        }
        return api.generateChatTitle(request)
      },
    })
  }
  return defaultRequester
}
