import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { isWslHostId } from '../../../../shared/execution-host'
import type { InstalledSkill, InstalledSkillsInput, InstalledSkillsResult } from '../../../../shared/installed-skills'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { PaletteAgentTarget } from './paletteOpenRequest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { bracketedPaste } from '../../utils/terminalDrop'
import { GhostButton, OutlineButton } from '../ui/Buttons'
import { RowButton } from '../ui/RowButton'
import { AgentWorkingDots } from '../ui/AgentWorkingDots'

/** The listbox the palette's field controls while the Skills tab is showing. */
export const INSTALLED_SKILLS_RESULTS_ID = 'installed-skills-results'
/** Rows a scope shows before its "Show more" row, and how many each press adds. */
export const INSTALLED_SKILLS_PAGE = 10

const SCOPES = ['project', 'global'] as const
type Scope = (typeof SCOPES)[number]
type Entry =
  { kind: 'skill'; id: string; skill: InstalledSkill } | { kind: 'more'; id: string; scope: Scope; remaining: number }

/**
 * The palette owns the one field; the panel owns the list under it. The
 * field's keydown is offered here first, and a key the panel did not use
 * (Backspace at an empty query, Escape) goes on to the palette's own handling.
 */
export type InstalledSkillsPanelHandle = { handleKey: (event: React.KeyboardEvent) => boolean }

type Props = {
  query: string
  fieldRef: React.RefObject<HTMLInputElement | null>
  workspaceRoot: string | null
  workspaceId: string | null
  preferredTarget: PaletteAgentTarget | null
  onBrowse: () => void
  onUsed: (session: TerminalSessionSnapshot) => void
  /** The active row's id, for the field's `aria-activedescendant`. */
  onActiveOptionChange?: (id: string | undefined) => void
}

type CliChoice = { pluginId: string; session?: TerminalSessionSnapshot }

/**
 * Whose skills to list, without asking. The agent the palette was opened for
 * or the focused agent answers it outright, even when its CLI reads no skills
 * (the list then says so). With neither, the agent most recently spoken to
 * whose CLI does read skills — this workspace's first — then the only such CLI
 * installed on this machine, then the one last chosen for a new chat.
 */
export function pickSkillsCli(input: {
  focused: TerminalSessionSnapshot | undefined
  preferredCli: string | undefined
  sessions: readonly TerminalSessionSnapshot[]
  workspaceId: string | null
  supported: readonly string[]
  installed: (pluginId: string) => boolean
  lastSelectedCli: string | undefined
}): CliChoice {
  if (input.preferredCli) return { pluginId: input.preferredCli, session: input.focused }
  if (input.focused?.cli) return { pluginId: input.focused.cli, session: input.focused }
  const recency = (session: TerminalSessionSnapshot) => session.lastInputAt ?? session.startedAt
  const recent = input.sessions
    .filter((session) => session.kind === 'agent' && session.cli && input.supported.includes(session.cli))
    .sort(
      (a, b) =>
        Number(b.workspaceId === input.workspaceId) - Number(a.workspaceId === input.workspaceId) ||
        recency(b) - recency(a),
    )[0]
  if (recent?.cli) return { pluginId: recent.cli }
  const installed = input.supported.filter(input.installed)
  if (installed.length === 1) return { pluginId: installed[0] }
  if (input.lastSelectedCli && installed.includes(input.lastSelectedCli)) return { pluginId: input.lastSelectedCli }
  return { pluginId: '' }
}

export const InstalledSkillsPanel = forwardRef<InstalledSkillsPanelHandle, Props>(function InstalledSkillsPanel(
  { query, fieldRef, workspaceRoot, workspaceId, preferredTarget, onBrowse, onUsed, onActiveOptionChange },
  ref,
) {
  const clis = useWorkspaceStore((state) => state.pluginCatalogEntries)
  const cliAvailability = useWorkspaceStore((state) => state.cliAvailability)
  const workspaceHostId = useWorkspaceStore((state) =>
    workspaceId ? (state.workspaces.find((workspace) => workspace.id === workspaceId)?.hostId ?? undefined) : undefined,
  )
  const lastSelectedCli = useWorkspaceStore((state) => state.appSettings.lastSelectedCli)
  const focusedAgentId = useWorkspaceStore((state) =>
    workspaceId ? state.focusedAgentByWorkspaceId[workspaceId] : undefined,
  )
  const sessions = useTerminalSessions()
  const focused = preferredTarget
    ? sessions.find((session) => session.sessionId === preferredTarget.sessionId)
    : sessions.find(
        (session) =>
          session.workspaceId === workspaceId && session.agentId === focusedAgentId && session.kind === 'agent',
      )
  const supported = useMemo(
    () =>
      clis.filter((cli) => cli.skillIntegration && cli.skillIntegration.support !== 'unsupported').map((cli) => cli.id),
    [clis],
  )
  const choice = pickSkillsCli({
    focused,
    preferredCli: preferredTarget?.cli,
    sessions,
    workspaceId,
    supported,
    installed: (id) => cliAvailability?.[id]?.installed === true,
    lastSelectedCli,
  })
  const pluginId = choice.pluginId
  const cliName = clis.find((cli) => cli.id === pluginId)?.displayName ?? pluginId
  const session = choice.session && choice.session.cli === pluginId ? choice.session : undefined
  const root = session ? session.worktreePath || session.cwd || workspaceRoot : workspaceRoot
  // A CLI run inside WSL keeps its user skills in the Linux home, which main
  // reads only when told. The session says where it runs; without one, the
  // workspace's machine does.
  const hostId = session ? session.hostId : workspaceHostId
  const wsl = session ? session.pathStyle === 'wsl' : window.api.platform === 'win32' && isWslHostId(workspaceHostId)
  const contextKey = JSON.stringify([root, pluginId, wsl, hostId ?? null])
  const request = (): InstalledSkillsInput => ({
    workspaceRoot: root,
    pluginId,
    ...(wsl ? { pathStyle: 'wsl', ...(isWslHostId(hostId) ? { hostId } : {}) } : {}),
  })

  const [selected, setSelected] = useState(0)
  const [limits, setLimits] = useState<Record<Scope, number>>({
    project: INSTALLED_SKILLS_PAGE,
    global: INSTALLED_SKILLS_PAGE,
  })
  const [detail, setDetail] = useState<InstalledSkill | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [loaded, setLoaded] = useState<{ context: string; result: InstalledSkillsResult } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const currentContextRef = useRef(contextKey)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  currentContextRef.current = contextKey
  const result = loaded?.context === contextKey ? loaded.result : null

  // A new query is a new list: back to the first row, every scope folded back
  // to its first page.
  useEffect(() => {
    setSelected(0)
    setLimits({ project: INSTALLED_SKILLS_PAGE, global: INSTALLED_SKILLS_PAGE })
    setDetail(null)
    setConfirmRemove(false)
  }, [query])

  useEffect(() => {
    setDetail(null)
    setConfirmRemove(false)
    setError(null)
    setSelected(0)
    setLimits({ project: INSTALLED_SKILLS_PAGE, global: INSTALLED_SKILLS_PAGE })
    if (!pluginId) return
    let cancelled = false
    setLoaded(null)
    void window.api
      .installedSkillsList(request())
      .then((next) => {
        if (!cancelled) setLoaded({ context: contextKey, result: next })
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setLoaded({
            context: contextKey,
            result: {
              ok: false,
              message: failure instanceof Error ? failure.message : 'Could not read installed skills.',
            },
          })
      })
    return () => {
      cancelled = true
    }
    // `request` reads exactly the values `contextKey` encodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, refresh])

  const skills = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return result?.ok
      ? result.skills
          .filter((skill) =>
            `${skill.name} ${skill.description} ${skill.path} ${skill.origin}`.toLowerCase().includes(needle),
          )
          .sort((a, b) => Number(a.scope === 'global') - Number(b.scope === 'global') || a.name.localeCompare(b.name))
      : []
  }, [result, query])
  // Project first, then Global; each scope shows a page and, when it holds
  // more, a "Show more" row that is an option like any other so the keyboard
  // reaches it.
  const groups = useMemo(
    () =>
      SCOPES.map((scope) => {
        const rows = skills.filter((skill) => skill.scope === scope)
        const entries: Entry[] = rows
          .slice(0, limits[scope])
          .map((skill) => ({ kind: 'skill', id: `installed-skill-${skill.id}`, skill }))
        if (rows.length > limits[scope])
          entries.push({
            kind: 'more',
            id: `installed-skills-more-${scope}`,
            scope,
            remaining: rows.length - limits[scope],
          })
        return { scope, total: rows.length, entries }
      }),
    [skills, limits],
  )
  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups])
  const activeIndex = Math.min(selected, Math.max(0, entries.length - 1))
  const active = entries[activeIndex]
  const activeId = !detail && result?.ok ? active?.id : undefined

  useEffect(() => {
    onActiveOptionChange?.(activeId)
  }, [activeId, onActiveOptionChange])
  useEffect(() => () => onActiveOptionChange?.(undefined), [onActiveOptionChange])
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, query])
  useEffect(() => {
    if (detail) detailRef.current?.focus()
    else fieldRef.current?.focus()
  }, [detail, fieldRef])

  const showMore = (scope: Scope) =>
    setLimits((current) => ({ ...current, [scope]: current[scope] + INSTALLED_SKILLS_PAGE }))
  // The cursor stays at its index, which after "Show more" is the first row
  // the press revealed.
  const activate = (entry: Entry) => (entry.kind === 'skill' ? setDetail(entry.skill) : showMore(entry.scope))

  useImperativeHandle(ref, () => ({
    handleKey: (event) => {
      if (detail) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected(Math.max(0, Math.min(entries.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1))))
        return true
      }
      if (event.key === 'Enter' && active) {
        event.preventDefault()
        activate(active)
        return true
      }
      return false
    },
  }))

  const back = () => {
    setDetail(null)
    setConfirmRemove(false)
    setError(null)
    fieldRef.current?.focus()
  }
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      if (currentContextRef.current === contextKey)
        setError(failure instanceof Error ? failure.message : 'The action failed.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const useSkill = (skill: InstalledSkill) =>
    run(async () => {
      // Recheck both the installation and the target immediately before paste.
      // Never attach: that would copy a global skill into every project harness.
      const inventory = await window.api.installedSkillsList(request())
      if (!inventory.ok) throw new Error(inventory.message)
      if (!inventory.skills.some((entry) => entry.id === skill.id))
        throw new Error('This installation changed. Refresh and choose it again.')
      const live = (await window.api.terminalList()).filter(
        (candidate) =>
          candidate.kind === 'agent' &&
          candidate.processAlive &&
          candidate.workspaceId === workspaceId &&
          candidate.cli === pluginId,
      )
      const target = preferredTarget
        ? live.find((candidate) => candidate.sessionId === preferredTarget.sessionId)
        : (live.find((candidate) => candidate.agentId === focusedAgentId) ?? (live.length === 1 ? live[0] : undefined))
      if (!target) throw new Error('Focus a running agent using this CLI, then choose the skill again.')
      if (!mountedRef.current || currentContextRef.current !== contextKey) return
      // The path identifies the selected copy even when names collide across
      // scopes. Plain prompt input works for both native and prompt-shim CLIs.
      await window.api.terminalWrite(
        target.sessionId,
        bracketedPaste(`Use the skill at ${JSON.stringify(`${skill.path}/SKILL.md`)}. `),
      )
      onUsed(target)
    })
  const removeSkill = (skill: InstalledSkill) =>
    run(async () => {
      const removed = await window.api.installedSkillRemove({ ...request(), installationId: skill.id })
      if (!removed.ok) throw new Error(removed.message)
      if (!mountedRef.current || currentContextRef.current !== contextKey) return
      back()
      setRefresh((value) => value + 1)
    })

  return (
    <section
      id="command-palette-panel-skills"
      aria-label="Installed skills"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detail) {
          event.preventDefault()
          if (!busy) {
            if (confirmRemove) setConfirmRemove(false)
            else back()
          }
        }
      }}
    >
      {error && (
        <p role="alert" className="px-4 py-2 text-meta text-[color:var(--tone-error)]">
          {error}
        </p>
      )}
      {detail ? (
        <div ref={detailRef} tabIndex={-1} className="space-y-2 px-4 py-3 outline-none">
          <GhostButton size="xs" onClick={back} disabled={busy}>
            Back to installed skills
          </GhostButton>
          <p className="text-heading text-[color:var(--text-strong)]">{detail.name}</p>
          <p className="text-meta text-[color:var(--text-muted)]">{detail.description}</p>
          <p className="text-meta text-[color:var(--text-muted)]">
            {detail.scope === 'project' ? 'Project' : 'Global'} · {detail.origin}
            {detail.linked ? ' · Linked folder' : ''}
          </p>
          <p className="break-all font-mono text-micro text-[color:var(--text-muted)]">{detail.path}</p>
          {detail.removalNote && <p className="text-meta text-[color:var(--text-muted)]">{detail.removalNote}</p>}
          {confirmRemove ? (
            <>
              <p className="text-meta text-[color:var(--text-default)]">
                {detail.linked
                  ? 'Move this link to Trash? The source folder stays in place.'
                  : `Move this ${detail.scope} installation to Trash?`}
                {detail.scope === 'global' ? ' This affects every project using this installation.' : ''} Other
                installations stay in place.
              </p>
              <div className="flex gap-2">
                <OutlineButton tone="danger" disabled={busy} busy={busy} onClick={() => void removeSkill(detail)}>
                  Move to Trash
                </OutlineButton>
                <GhostButton disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Cancel
                </GhostButton>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <OutlineButton disabled={busy} onClick={() => void useSkill(detail)}>
                Use in agent
              </OutlineButton>
              <GhostButton disabled={busy} onClick={() => void run(() => window.api.showItemInFolder(detail.path))}>
                Show folder
              </GhostButton>
              <GhostButton tone="danger" disabled={busy || !detail.removable} onClick={() => setConfirmRemove(true)}>
                Remove…
              </GhostButton>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Which CLI's skills these are is a fact about the list, said in
              the list's quiet ink; it is decided by the agent in focus, not
              by a control. The two ghost verbs trail it, off the rows. */}
          <div className="flex items-center gap-2 px-4 pt-2 text-meta text-[color:var(--text-muted)]">
            <span className="min-w-0 flex-1 truncate">
              {pluginId ? `${cliName} skills${wsl ? ' in WSL' : ''}` : 'No agent in focus'}
            </span>
            <GhostButton size="xs" disabled={busy || !pluginId} onClick={() => setRefresh((value) => value + 1)}>
              Refresh
            </GhostButton>
            <GhostButton size="xs" onClick={onBrowse}>
              Browse skills
            </GhostButton>
          </div>
          <div
            id={INSTALLED_SKILLS_RESULTS_ID}
            role="listbox"
            aria-label="Installed skills by scope"
            className="max-h-[360px] overflow-y-auto py-1"
          >
            {!pluginId ? (
              <p className="px-4 py-3 text-meta text-[color:var(--text-muted)]">
                Focus an agent to see the skills its CLI has installed.
              </p>
            ) : !result ? (
              <p role="status" className="flex items-center gap-2 px-4 py-3 text-meta text-[color:var(--text-muted)]">
                Reading installed skills <AgentWorkingDots label="Reading installed skills" />
              </p>
            ) : !result.ok ? (
              <p role="alert" className="px-4 py-3 text-meta text-[color:var(--tone-error)]">
                {result.message}
              </p>
            ) : (
              <>
                {result.diagnostics.map((diagnostic) => (
                  <p key={diagnostic} role="alert" className="px-4 py-2 text-meta text-[color:var(--tone-error)]">
                    {diagnostic}
                  </p>
                ))}
                {groups.map(({ scope, total, entries: rows }) => (
                  <div key={scope} role="group" aria-label={scope === 'project' ? 'Project skills' : 'Global skills'}>
                    <div aria-hidden="true" className="px-4 pb-1 pt-2 text-meta text-[color:var(--text-muted)]">
                      {scope === 'project' ? 'Project' : 'Global'}
                    </div>
                    {total === 0 && (
                      <p className="px-4 py-2 text-meta text-[color:var(--text-muted)]">
                        {query.trim()
                          ? 'No matching skills.'
                          : scope === 'project' && !root
                            ? 'Open a project to see its skills.'
                            : 'No skills installed here.'}
                      </p>
                    )}
                    {rows.map((entry) => {
                      const isActive = entry.id === active?.id
                      return (
                        <RowButton
                          key={entry.id}
                          ref={isActive ? selectedRef : undefined}
                          id={entry.id}
                          role="option"
                          aria-selected={isActive}
                          density="bleed"
                          selected={isActive}
                          tabIndex={-1}
                          onMouseEnter={() => setSelected(entries.indexOf(entry))}
                          onClick={() => activate(entry)}
                        >
                          {entry.kind === 'skill' ? (
                            <span className="block min-w-0 px-2">
                              <span className="block truncate text-heading">{entry.skill.name}</span>
                              <span className="block truncate text-micro text-[color:var(--text-muted)]">
                                {entry.skill.description || entry.skill.origin}
                              </span>
                              <span className="block truncate text-micro text-[color:var(--text-disabled)]">
                                {entry.skill.path}
                              </span>
                            </span>
                          ) : (
                            <span className="block min-w-0 px-2 text-meta text-[color:var(--text-muted)]">
                              Show more
                              <span className="text-[color:var(--text-disabled)]"> · {entry.remaining} more</span>
                            </span>
                          )}
                        </RowButton>
                      )
                    })}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
      <p className="px-4 py-2 text-micro text-[color:var(--text-muted)]">
        Installed on this machine. Running agents may need a restart to pick up changes.
      </p>
    </section>
  )
})
