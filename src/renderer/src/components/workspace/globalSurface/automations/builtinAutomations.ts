import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import {
  AUTOMATION_DEFAULT_PERMISSION_PRESET,
  type AutomationCliPermissionPreset,
} from '../../../../../../shared/automations/contracts'
import type { BuiltinAutomation } from '../../../../../../shared/automations/builtin'
import { automationScheduleCron, automationScheduleWords } from '../../../../../../shared/automations/scheduleWords'
import type { AutomationProjectFolder } from '../../../../utils/automationsEntry'

// The "Built in" half of the Automations surface (Extensions drawer ruling,
// 2026-09-05, frame 4). The five automations that ship inside the app are cron
// lines plus a prompt, so they live here rather than on a marketplace shelf: the
// rail lists them under "Built in", below the open projects' own automations
// under "Yours"; the card states what one is; and "Add to <project>" writes it
// into that project, where it then appears under Yours.
//
// Everything a test needs to pin is a pure function in this file; the hook is the
// thin IPC wrapper over `listBuiltinAutomations` / `addBuiltinAutomation`. The
// renderer holds no copy of the definitions — main is the authority on what
// ships — which is also why a failed read has a state of its own below rather
// than collapsing to an empty group.

/** Rail row ids are one namespace across both groups, so a built-in's id is
 *  prefixed rather than risking a collision with a store-issued automation id. */
const BUILTIN_ROW_PREFIX = 'builtin:'

export function builtinRowId(builtinId: string): string {
  return `${BUILTIN_ROW_PREFIX}${builtinId}`
}

/** The built-in id a rail row addresses, or null for a project automation's row. */
export function builtinIdFromRowId(rowId: string | null): string | null {
  if (!rowId || !rowId.startsWith(BUILTIN_ROW_PREFIX)) return null
  return rowId.slice(BUILTIN_ROW_PREFIX.length) || null
}

/**
 * Which built-ins a project already holds. Matched on `sourceCatalogueId` — the
 * stable id the install stamps — never on the name: a user is free to rename
 * their copy, and a name match would then both miss the copy they have and claim
 * a match on an unrelated automation that happens to share a title. This is also
 * why the ids are the marketplace plugin ids these five shipped under: a project
 * that added one from the old Plugins shelf is recognised as already having it.
 */
export function addedBuiltinIds(
  entries: ReadonlyArray<AutomationsInstanceEntry>,
  workspaceRoot: string | null,
): Set<string> {
  const added = new Set<string>()
  if (!workspaceRoot) return added
  const key = normalizeRoot(workspaceRoot)
  for (const entry of entries) {
    if (normalizeRoot(entry.workspaceRoot) !== key) continue
    const source = entry.definition.sourceCatalogueId
    if (source) added.add(source)
  }
  return added
}

function normalizeRoot(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * The project "Add to …" writes into: the active workspace's own folder, or —
 * when the active workspace has none (a chat or scratch workspace) and exactly
 * one project is open — that project, because there is nothing to disambiguate.
 * Null when no project is open, or when several are and the active workspace
 * names none of them: the control is then inert with a reason rather than
 * picking a project on the user's behalf.
 */
export function builtinAddTarget(
  activeFolderPath: string | null | undefined,
  projectFolders: ReadonlyArray<AutomationProjectFolder>,
): AutomationProjectFolder | null {
  if (activeFolderPath) {
    const key = normalizeRoot(activeFolderPath)
    const known = projectFolders.find((folder) => normalizeRoot(folder.folderPath) === key)
    if (known) return known
    return { folderPath: activeFolderPath, displayName: folderDisplayName(activeFolderPath) }
  }
  return projectFolders.length === 1 ? (projectFolders[0] ?? null) : null
}

function folderDisplayName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

// The permission a built-in run actually launches on. None of the five pins a
// preset, and the install deliberately does not stamp one, so what a run gets is
// the app's own resolved default — read off the same constant the parse resolves
// to (`parseSpawnAgentConfig`), never a string that could quietly disagree with
// it. The wording is the shelf's, because it is the same fact said to the same
// reader; the constant is what keeps the two from drifting about WHICH preset.
const PERMISSION_LABEL: Record<AutomationCliPermissionPreset, string> = {
  none: 'CLI default — whatever the CLI does',
  manual: 'Manual — asks before acting',
  auto: 'Auto — fewer prompts, CLI-supervised',
  bypass: 'Bypass all — runs unattended',
}

export const BUILTIN_PERMISSION_LABEL = PERMISSION_LABEL[AUTOMATION_DEFAULT_PERMISSION_PRESET]

/** The definition-list rows the card states, read off the record's real fields.
 *  `code` is the machine form of the fact — the cron line — kept apart from the
 *  words so the card can set it in mono without the card parsing a string back
 *  apart to find it. */
export type BuiltinFact = { term: string; description: string; code?: string }

/**
 * What a built-in is, in four facts. Each one is READ, never assumed: the agent
 * row names the app's own resolved fallbacks because the payload pins neither a
 * CLI nor a preset (see `catalogueDraftInput`, src/main/automations/
 * definition-write.ts — pinning them at install would freeze a second source of
 * truth), and "Delivers" follows from `runInWorktree`, because a run with no
 * worktree has no branch and so nothing to open a pull request from.
 */
export function builtinFacts(entry: BuiltinAutomation, permissionLabel: string, cliLabel: string): BuiltinFact[] {
  const cron = automationScheduleCron(entry.trigger)
  const words = automationScheduleWords(entry.trigger)
  const inWorktree = builtinRunsInWorktree(entry)
  return [
    { term: 'Schedule', description: words, ...(cron ? { code: cron } : {}) },
    { term: 'Agent', description: `${cliLabel} · ${permissionLabel}` },
    {
      term: 'Runs in',
      description: inWorktree ? 'A worktree of its own, on its own branch' : 'Your checkout, on the branch you are on',
    },
    {
      term: 'Delivers',
      description: inWorktree
        ? 'A pull request per run, or nothing when it finds nothing'
        : 'Changes in your checkout — no branch, so no pull request',
    },
  ]
}

/** Absent ⇒ true, the same answer the store's read gives (AutomationDefinition). */
function builtinRunsInWorktree(entry: BuiltinAutomation): boolean {
  return entry.runInWorktree !== false
}

/** The rail's one-line state under a built-in's name — the schedule, in words. */
export function builtinStateLine(entry: BuiltinAutomation): string {
  return automationScheduleWords(entry.trigger)
}

/** Search over the built-in group, matching the rail's own query semantics. */
export function matchesBuiltinQuery(entry: BuiltinAutomation, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.category.toLowerCase().includes(needle)
  )
}

export type BuiltinAutomationsState =
  | { status: 'loading' }
  | { status: 'ready'; entries: BuiltinAutomation[] }
  /** The read failed, or this build has no channel for it. The rail says so —
   *  an empty "Built in" group would read as "this app ships none", which is a
   *  different and false statement. */
  | { status: 'error'; message: string }

const UNAVAILABLE = 'The built-in automations need a newer app build. Update and restart.'

export function useBuiltinAutomations(): BuiltinAutomationsState {
  const [state, setState] = useState<BuiltinAutomationsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (typeof window.api?.listBuiltinAutomations !== 'function') {
        if (!cancelled) setState({ status: 'error', message: UNAVAILABLE })
        return
      }
      try {
        const result = await window.api.listBuiltinAutomations()
        if (cancelled) return
        setState(result.ok ? { status: 'ready', entries: result.value } : { status: 'error', message: result.message })
      } catch (error) {
        if (cancelled) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'The built-in automations could not be read.',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

type BuiltinAddState =
  { status: 'idle' } | { status: 'adding'; builtinId: string } | { status: 'error'; message: string }

export type BuiltinAdder = {
  state: BuiltinAddState
  add: (entry: BuiltinAutomation, workspaceRoot: string) => Promise<void>
  clearError: () => void
}

/**
 * "Add to <project>". The write itself is main's — one channel onto the same
 * catalogue install the marketplace shelf's Get used — so this holds only the
 * in-flight state and the receipt. Adding one the project already has is a
 * no-op that reports the copy it has (`alreadyAdded`), never a second record.
 */
export function useAddBuiltinAutomation(onAdded: (automationId: string) => void): BuiltinAdder {
  const [state, setState] = useState<BuiltinAddState>({ status: 'idle' })

  const add = useCallback(
    async (entry: BuiltinAutomation, workspaceRoot: string) => {
      if (typeof window.api?.addBuiltinAutomation !== 'function') {
        setState({ status: 'error', message: UNAVAILABLE })
        return
      }
      setState({ status: 'adding', builtinId: entry.id })
      try {
        const result = await window.api.addBuiltinAutomation({ workspaceRoot, builtinId: entry.id })
        if (!result.ok) {
          setState({ status: 'error', message: result.message })
          return
        }
        setState({ status: 'idle' })
        onAdded(result.value.definition.id)
      } catch (error) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'The automation could not be added.',
        })
      }
    },
    [onAdded],
  )

  return useMemo(() => ({ state, add, clearError: () => setState({ status: 'idle' }) }), [state, add])
}
