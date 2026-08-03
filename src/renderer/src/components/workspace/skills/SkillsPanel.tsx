import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { InboxSearchInput, GhostButton } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { focusedAgentTabInLayout } from '../../../utils/modelRegistry'
import type { BuiltinSkill } from '../../../../../shared/electron-api'
import { sendSkillToTerminal, setSkillDropData } from '../../../utils/terminalDrop'
import { SkillsPaneBody } from './SkillsPaneBody'
import {
  buildSkillsPaneView,
  readsSkills,
  type SkillUseError,
  type SkillWriteReport,
} from './skillsPaneModel'
import { useAgentCapabilities } from './useAgentCapabilities'
import { useWorkspaceAgentCapabilities } from './useWorkspaceAgentCapabilities'

// The workspace's right-docked pane: the union of what every agent in the
// workspace can reach, with its Send action aimed at the last focused agent.
//
// The header carries the pane's name and nothing else. The agent's name is on
// the tab that is already selected, its liveness belongs on that tab, and the
// invocation rule and the synced-to line were boilerplate on every render of
// every workspace. The pane's whole value is the list below.

type Props = {
  workspaceId: string
}

export function SkillsPanel({ workspaceId }: Props) {
  const workspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  // Derived from the persisted layout, which `onModelChange` rewrites on every
  // layout mutation. The previous target is retained when the user clicks the
  // aside itself; otherwise the aside would become active and the first agent
  // in document order would silently replace the real target.
  const layoutModel = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.layoutModel,
  )
  const focusedRef = useRef<ReturnType<typeof focusedAgentTabInLayout>>(null)
  const focused = useMemo(
    () => focusedAgentTabInLayout(layoutModel, focusedRef.current),
    [layoutModel],
  )
  useEffect(() => {
    focusedRef.current = focused
  }, [focused])
  const workspaceAgents = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents,
  )
  const agent = focused ? workspaceAgents?.[focused.agentId] : undefined
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)

  const pluginId = agent?.cli ?? null
  const plugin = useMemo(
    () => pluginCatalogEntries.find((entry) => entry.id === pluginId) ?? null,
    [pluginCatalogEntries, pluginId],
  )
  // Send targets one live agent, so name that agent rather than its runtime.
  // The runtime label remains a fallback for restored records without a name.
  const agentLabel = agent?.name ?? plugin?.displayName ?? pluginId ?? null

  const currentCapabilities = useAgentCapabilities(workspaceRoot, pluginId)
  const workspacePluginIds = useMemo(
    () => [
      ...new Set(
        Object.values(workspaceAgents ?? {})
          .map((entry) => entry.cli)
          .filter((id): id is string => Boolean(id)),
      ),
    ].sort(),
    [workspaceAgents],
  )
  const capabilities = useWorkspaceAgentCapabilities(workspaceRoot, workspacePluginIds)

  const [query, setQuery] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null)
  const [writeReport, setWriteReport] = useState<SkillWriteReport | null>(null)
  const [useError, setUseError] = useState<SkillUseError | null>(null)
  // Skill ids attached this session into a directory whose CLIs only pick them
  // up after a restart, keyed by the CLI that has to restart. One banner per
  // tab naming what is waiting — not a badge per row.
  const [restartPending, setRestartPending] = useState<Record<string, string[]>>({})
  const [catalogue, setCatalogue] = useState<BuiltinSkill[]>([])

  // Switching agents resets the pane's own transient state: an expanded row and
  // a write report both belong to the agent they were opened against.
  useEffect(() => {
    setExpandedKey(null)
    setWriteReport(null)
    setUseError(null)
  }, [focused?.agentId])

  useEffect(() => {
    let cancelled = false
    window.api
      .builtinSkillsList()
      .then((skills) => {
        if (!cancelled) setCatalogue(skills)
      })
      .catch(() => {
        // A catalogue that cannot be listed costs the search-only "not
        // installed" rows and nothing else; the reachable list is unaffected and
        // must not be blanked by it.
        if (!cancelled) setCatalogue([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const canWrite = Boolean(
    workspaceRoot && capabilities.snapshot && readsSkills(capabilities.snapshot.support),
  )
  // Send is contextual even though the list is workspace-wide. The target
  // agent's own capability answer decides whether it can receive an invocation.
  const canUse = Boolean(
    workspaceRoot
    && currentCapabilities.snapshot
    && readsSkills(currentCapabilities.snapshot.support),
  )

  // The tab the pane is following. `terminalWrite` is addressed by session, and
  // the layout is where a tab's session id lives; the agent record's own id is
  // the same fallback the terminal itself uses when the tab carries none.
  const focusedSessionId = focused?.sessionId ?? agent?.cliSessionId ?? null
  // Which agent the pane is on *now*, for a send that lands after the user has
  // moved on: a failure belonging to the tab they left must not be reported
  // against the tab they are looking at.
  const focusedSessionIdRef = useRef(focusedSessionId)
  focusedSessionIdRef.current = focusedSessionId

  const runUse = useCallback(
    async (skillId: string) => {
      // Both are guaranteed by canUse, and both still say so rather than
      // returning quietly: a control that does nothing is the worse failure.
      if (!workspaceRoot) {
        setUseError({ skillId, message: 'Open a project folder before sending a skill.' })
        return
      }
      if (!focusedSessionId) {
        setUseError({ skillId, message: 'Start this agent before sending it a skill.' })
        return
      }
      setUseError(null)
      const result = await sendSkillToTerminal({
        skillId,
        sessionId: focusedSessionId,
        workspaceRoot,
      }).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : 'Could not send the skill to this agent.',
      }))
      if (!result.ok && focusedSessionIdRef.current === focusedSessionId) {
        setUseError({ skillId, message: result.message })
      }
    },
    [focusedSessionId, workspaceRoot],
  )

  const runWrite = useCallback(
    async (verb: 'add' | 'remove', skillId: string) => {
      if (!workspaceRoot) return
      setPendingSkillId(skillId)
      setWriteReport(null)
      const result
        = verb === 'add'
          ? await window.api.agentSkillAttach({ workspaceRoot, skillId })
          : await window.api.agentSkillRemove({ workspaceRoot, skillId })
      setPendingSkillId(null)

      if (!result.ok) {
        setWriteReport({ verb, skillId, targets: [], message: result.message })
        return
      }
      // Per target, always: three successes and one permission error read as
      // three successes and one error, never as a bare failure.
      setWriteReport({ verb, skillId, targets: result.targets, message: null })

      // The list itself is not patched here. The write invalidates through the
      // capability watcher and the pane re-reads, so the surface can never claim
      // an install that did not land.
      if (verb === 'add') {
        const waiting = result.targets.filter(
          (target) => target.status === 'written' && target.restartRequired,
        )
        if (waiting.length > 0) {
          setRestartPending((previous) => {
            const next = { ...previous }
            for (const target of waiting) {
              for (const id of target.pluginIds) {
                const existing = next[id] ?? []
                if (!existing.includes(skillId)) next[id] = [...existing, skillId]
              }
            }
            return next
          })
        }
        return
      }
      // A skill that is gone is no longer waiting on a restart.
      setRestartPending((previous) => {
        const next: Record<string, string[]> = {}
        for (const [id, ids] of Object.entries(previous)) {
          const kept = ids.filter((pending) => pending !== skillId)
          if (kept.length > 0) next[id] = kept
        }
        return next
      })
    },
    [workspaceRoot],
  )

  const view = useMemo(
    () =>
      buildSkillsPaneView({
        snapshot: capabilities.snapshot,
        loading: capabilities.loading,
        unavailableMessage: capabilities.unavailableMessage,
        agentLabel,
        query,
        catalogue,
        restartPending: pluginId ? restartPending[pluginId] ?? [] : [],
        writeReport,
        useError,
      }),
    [
      agentLabel,
      capabilities.loading,
      capabilities.snapshot,
      capabilities.unavailableMessage,
      catalogue,
      pluginId,
      query,
      restartPending,
      useError,
      writeReport,
    ],
  )

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-surface)] text-[color:var(--text-default)]"
      aria-label="Skills and MCPs"
    >
      {/* No hairline under the title or the search field. The three of them are
          one stack and space already separates them; a rule here would be
          decoration on a pane whose only job is the list. */}
      <div className="flex shrink-0 items-baseline gap-2 px-3 pb-1 pt-3">
        <h2 className="truncate text-body font-semibold text-[color:var(--text-strong)]">
          Skills and MCPs
        </h2>
      </div>
      <div
        className="flex shrink-0 px-3 pb-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.stopPropagation()
            setQuery('')
          }
        }}
      >
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          ariaLabel="Search skills and servers"
          placeholder="Search skills and servers…"
          clearAriaLabel="Clear skills search"
        />
      </div>

      <SkillsPaneBody
        view={view}
        expandedKey={expandedKey}
        pendingSkillId={pendingSkillId}
        canWrite={canWrite}
        canUse={canUse}
        agentLabel={agentLabel ?? ''}
        implicitInvocation={Boolean(plugin?.skillIntegration?.invocation?.implicitInvocation)}
        onExpand={setExpandedKey}
        onAdd={(skillId) => void runWrite('add', skillId)}
        onRemove={(skillId) => void runWrite('remove', skillId)}
        onUse={(skillId) => void runUse(skillId)}
        onDragStart={(skillId, dataTransfer) =>
          setSkillDropData(dataTransfer, { version: 1, skillId, workspaceId })}
        onRetry={() => {
          capabilities.refetch()
          currentCapabilities.refetch()
        }}
        onOpenExtensions={() => openExtensionsSurface({ view: 'installed' })}
        onDismissWriteReport={() => setWriteReport(null)}
        onDismissUseError={() => setUseError(null)}
      />

      <div className="flex shrink-0 items-center border-t border-[color:var(--border-subtle)] px-3 py-1.5">
        <GhostButton size="xs" className="ml-auto" onClick={() => openExtensionsSurface()}>
          Extensions
        </GhostButton>
      </div>
    </section>
  )
}

export default SkillsPanel
