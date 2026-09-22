import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledSkill, InstalledSkillsResult } from '../../../../shared/installed-skills'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { PaletteAgentTarget } from './paletteOpenRequest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { bracketedPaste } from '../../utils/terminalDrop'
import { GhostButton, OutlineButton } from '../ui/Buttons'
import { Input } from '../ui/Input'
import { RowButton } from '../ui/RowButton'
import { Select } from '../ui/Select'
import { AgentWorkingDots } from '../ui/AgentWorkingDots'

type Props = {
  workspaceRoot: string | null
  workspaceId: string | null
  preferredTarget: PaletteAgentTarget | null
  onBrowse: () => void
  onBack?: () => void
  onUsed: (session: TerminalSessionSnapshot) => void
}

export function InstalledSkillsPanel({ workspaceRoot, workspaceId, preferredTarget, onBrowse, onBack, onUsed }: Props) {
  const clis = useWorkspaceStore((state) => state.pluginCatalogEntries)
  const focusedAgentId = useWorkspaceStore((state) =>
    workspaceId ? state.focusedAgentByWorkspaceId[workspaceId] : undefined,
  )
  const sessions = useTerminalSessions()
  const [chosenCli, setChosenCli] = useState<string | null>(null)
  const focused = preferredTarget
    ? sessions.find((session) => session.sessionId === preferredTarget.sessionId)
    : sessions.find(
        (session) =>
          session.workspaceId === workspaceId && session.agentId === focusedAgentId && session.kind === 'agent',
      )
  const pluginId = chosenCli ?? preferredTarget?.cli ?? focused?.cli ?? ''
  const root =
    focused && focused.cli === pluginId ? focused.worktreePath || focused.cwd || workspaceRoot : workspaceRoot
  const contextKey = JSON.stringify([root, pluginId])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<InstalledSkill | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [loaded, setLoaded] = useState<{ context: string; result: InstalledSkillsResult } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
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

  useEffect(() => {
    inputRef.current?.focus()
    setDetail(null)
    setConfirmRemove(false)
    setError(null)
    setSelected(0)
    if (!pluginId) return
    let cancelled = false
    setLoaded(null)
    void window.api
      .installedSkillsList({ workspaceRoot: root, pluginId })
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
  }, [root, pluginId, contextKey, refresh])

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
  const selectedSkill = skills[Math.min(selected, Math.max(0, skills.length - 1))]
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, query])
  useEffect(() => {
    if (detail) detailRef.current?.focus()
    else inputRef.current?.focus()
  }, [detail])

  const back = () => {
    setDetail(null)
    setConfirmRemove(false)
    setError(null)
    inputRef.current?.focus()
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
      const inventory = await window.api.installedSkillsList({ workspaceRoot: root, pluginId })
      if (!inventory.ok) throw new Error(inventory.message)
      if (!inventory.skills.some((entry) => entry.id === skill.id))
        throw new Error('This installation changed. Refresh and choose it again.')
      const live = (await window.api.terminalList()).filter(
        (session) =>
          session.kind === 'agent' &&
          session.processAlive &&
          session.workspaceId === workspaceId &&
          session.cli === pluginId,
      )
      const target = preferredTarget
        ? live.find((session) => session.sessionId === preferredTarget.sessionId)
        : (live.find((session) => session.agentId === focusedAgentId) ?? (live.length === 1 ? live[0] : undefined))
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
      const removed = await window.api.installedSkillRemove({ workspaceRoot: root, pluginId, installationId: skill.id })
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
      <div className="flex items-center gap-2 px-4 py-2">
        <Select
          ariaLabel="Skills for agent CLI"
          placeholder="Choose an agent CLI"
          value={pluginId || null}
          items={clis
            .filter((cli) => cli.skillIntegration && cli.skillIntegration.support !== 'unsupported')
            .map((cli) => ({ value: cli.id, label: cli.displayName }))}
          onChange={(value) => {
            setChosenCli(value)
            setDetail(null)
          }}
          disabled={busy}
        />
        <GhostButton size="xs" disabled={busy || !pluginId} onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </GhostButton>
        <GhostButton size="xs" onClick={onBrowse}>
          Browse skills
        </GhostButton>
      </div>
      {!detail && (
        <div className="px-4 pb-2">
          <Input
            ref={inputRef}
            aria-label="Filter installed skills"
            placeholder="Filter installed skills…"
            value={query}
            role="combobox"
            aria-expanded={skills.length > 0}
            aria-controls="installed-skills-results"
            aria-activedescendant={selectedSkill ? `installed-skill-${selectedSkill.id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((value) =>
                  Math.max(0, Math.min(skills.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))),
                )
              }
              if (event.key === 'Enter' && selectedSkill) {
                event.preventDefault()
                setDetail(selectedSkill)
              }
              if (event.key === 'Backspace' && !query && onBack) {
                event.preventDefault()
                onBack()
              }
            }}
          />
        </div>
      )}
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
        <div
          id="installed-skills-results"
          role="listbox"
          aria-label="Installed skills by scope"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {!pluginId ? (
            <p className="px-4 py-3 text-meta text-[color:var(--text-muted)]">
              Focus an agent or choose a CLI to see its installed skills.
            </p>
          ) : !result ? (
            <p role="status" className="flex items-center gap-2 px-4 py-3 text-meta">
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
              {(['project', 'global'] as const).map((scope) => {
                const rows = skills.filter((skill) => skill.scope === scope)
                return (
                  <div key={scope} role="group" aria-label={scope === 'project' ? 'Project skills' : 'Global skills'}>
                    <p className="px-4 py-2 text-meta text-[color:var(--text-muted)]">
                      {scope === 'project' ? 'Project' : 'Global'}
                    </p>
                    {rows.length === 0 && (
                      <p className="px-4 py-2 text-meta text-[color:var(--text-muted)]">
                        {query
                          ? 'No matching skills.'
                          : scope === 'project' && !root
                            ? 'Open a project to see its skills.'
                            : 'No skills installed here.'}
                      </p>
                    )}
                    {rows.map((skill) => (
                      <RowButton
                        key={skill.id}
                        ref={skill.id === selectedSkill?.id ? selectedRef : undefined}
                        id={`installed-skill-${skill.id}`}
                        role="option"
                        aria-selected={skill.id === selectedSkill?.id}
                        density="bleed"
                        selected={skill.id === selectedSkill?.id}
                        tabIndex={-1}
                        onMouseEnter={() => setSelected(skills.indexOf(skill))}
                        onClick={() => setDetail(skill)}
                      >
                        <span className="block min-w-0 px-2">
                          <span className="block truncate text-heading">{skill.name}</span>
                          <span className="block truncate text-micro text-[color:var(--text-muted)]">
                            {skill.description || skill.origin}
                          </span>
                          <span className="block truncate text-micro text-[color:var(--text-disabled)]">
                            {skill.path}
                          </span>
                        </span>
                      </RowButton>
                    ))}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
      <p className="px-4 py-2 text-micro text-[color:var(--text-muted)]">
        Installed on this machine. Running agents may need a restart to pick up changes.
      </p>
    </section>
  )
}
