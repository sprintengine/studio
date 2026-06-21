import { useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { LifecycleGlyph, Spinner } from '../ui'

// Essentials-step affordance: probe for an existing Claude Code / Codex agent
// config (T2's `detectExistingAgentConfig` IPC) and let the user pick which
// detected MCP servers / skills to bring into their first workspace.
//
// Adoption is deferred, not faked: the selection is recorded in onboarding state
// (`pendingAgentConfigAdoption`) and the REAL `adoptAgentConfig` IPC runs against
// the new workspace root when the first workspace is created
// (WorkspaceManager.handleCreate), where the success/failure is surfaced on the
// first-run overlay. Honest states only — a detection error shows the real
// message, nothing-found shows a quiet absent line, and the list is never
// fabricated. The whole step stays skippable: a user who continues without
// touching this card adopts the defaults we found, and unchecking everything
// clears the selection.
export function AdoptConfigCard() {
  const setPendingAgentConfigAdoption = useWorkspaceStore((s) => s.setPendingAgentConfigAdoption)

  const [detecting, setDetecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<AgentConfigDetectedMcpServer[]>([])
  const [skills, setSkills] = useState<AgentConfigDetectedSkill[]>([])
  const [selectedMcp, setSelectedMcp] = useState<Set<string>>(new Set())
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set())

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Detect once on mount. Default-select every detected MCP server and every
  // adoptable skill (defaults-on), and seed onboarding state with that selection
  // so a user who just clicks Continue still adopts what we found. Non-adoptable
  // skills (custom skills) are shown but never selectable through this path.
  useEffect(() => {
    let cancelled = false
    setDetecting(true)
    void window.api
      .detectExistingAgentConfig()
      .then((result) => {
        if (cancelled || !mountedRef.current) return
        if (!result.ok) {
          setError(result.message)
          setMcpServers([])
          setSkills([])
          setSelectedMcp(new Set())
          setSelectedSkills(new Set())
          setPendingAgentConfigAdoption(null)
          return
        }
        const mcpKeys = new Set(result.mcpServers.map((server) => server.key))
        const skillKeys = new Set(result.skills.filter((skill) => skill.adoptable).map((skill) => skill.key))
        setError(null)
        setMcpServers(result.mcpServers)
        setSkills(result.skills)
        setSelectedMcp(mcpKeys)
        setSelectedSkills(skillKeys)
        setPendingAgentConfigAdoption(
          mcpKeys.size > 0 || skillKeys.size > 0
            ? { mcpServerKeys: [...mcpKeys], skillKeys: [...skillKeys] }
            : null,
        )
      })
      .catch((caught) => {
        if (cancelled || !mountedRef.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setPendingAgentConfigAdoption(null)
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setDetecting(false)
      })
    return () => {
      cancelled = true
    }
  }, [setPendingAgentConfigAdoption])

  const persist = (mcp: Set<string>, sk: Set<string>) => {
    setPendingAgentConfigAdoption(
      mcp.size > 0 || sk.size > 0 ? { mcpServerKeys: [...mcp], skillKeys: [...sk] } : null,
    )
  }

  const toggleMcp = (key: string) => {
    const next = new Set(selectedMcp)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelectedMcp(next)
    persist(next, selectedSkills)
  }

  const toggleSkill = (key: string) => {
    const next = new Set(selectedSkills)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelectedSkills(next)
    persist(selectedMcp, next)
  }

  // While detecting, render nothing but a quiet probing line — no header chrome
  // before we know whether there is anything to offer.
  if (detecting) {
    return (
      <section aria-label="Existing agent configuration" className="border-t border-[color:var(--border-subtle)] py-3">
        <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner className="icon-sm shrink-0" />
          Checking for an existing Claude Code or Codex setup…
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section aria-label="Existing agent configuration" className="border-t border-[color:var(--border-subtle)] py-3">
        <div className="flex items-start gap-2">
          <LifecycleGlyph state="failed" label="Could not read existing setup" live={false} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-[12px] text-[color:var(--text-default)]">Couldn’t read your existing setup.</p>
            <p className="mt-0.5 text-[11px] leading-5 text-[color:var(--text-muted)]">{error}</p>
          </div>
        </div>
      </section>
    )
  }

  const totalDetected = mcpServers.length + skills.length
  if (totalDetected === 0) {
    // Honest absent state — nothing found, nothing fabricated.
    return (
      <section aria-label="Existing agent configuration" className="border-t border-[color:var(--border-subtle)] py-3">
        <p className="text-[12px] text-[color:var(--text-muted)]">
          No existing Claude Code or Codex setup found to bring over.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="adopt-config-heading" className="border-t border-[color:var(--border-subtle)] py-3">
      <div className="flex items-start gap-2">
        <LifecycleGlyph state="done" label="Existing setup found" live={false} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h3 id="adopt-config-heading" className="text-[13px] font-semibold text-[color:var(--text-strong)]">
            Bring over your existing setup
          </h3>
          <p className="mt-0.5 text-[11px] leading-5 text-[color:var(--text-muted)]">
            Found {describeCount(mcpServers.length, 'MCP server')} and {describeCount(skills.length, 'skill')} in your
            current tools. Pick what to add to your first workspace.
          </p>
        </div>
      </div>

      <div className="mt-2.5 divide-y divide-[color:var(--border-subtle)]">
        {mcpServers.map((server) => (
          <AdoptRow
            key={server.key}
            name={server.name}
            sourceLabel={server.sourceLabel}
            kindLabel="MCP server"
            checked={selectedMcp.has(server.key)}
            onToggle={() => toggleMcp(server.key)}
          />
        ))}
        {skills.map((skill) => (
          <AdoptRow
            key={skill.key}
            name={skill.name}
            sourceLabel={skill.sourceLabel}
            kindLabel="Skill"
            checked={selectedSkills.has(skill.key)}
            onToggle={skill.adoptable ? () => toggleSkill(skill.key) : undefined}
            disabledNote={skill.adoptable ? undefined : 'Custom skill — add it later from Settings'}
          />
        ))}
      </div>
    </section>
  )
}

function AdoptRow({
  name,
  sourceLabel,
  kindLabel,
  checked,
  onToggle,
  disabledNote,
}: {
  name: string
  sourceLabel: string
  kindLabel: string
  checked: boolean
  onToggle?: () => void
  disabledNote?: string
}) {
  const disabled = onToggle === undefined
  return (
    <label
      className={`flex items-center gap-2.5 py-2 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={() => onToggle?.()}
        className="h-3.5 w-3.5 shrink-0 rounded border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--accent-primary)] focus:ring-1 focus:ring-[color:var(--border-focus)]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-[color:var(--text-default)]">{name}</span>
        {disabledNote ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-subtle)]">{disabledNote}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
        {kindLabel} · {sourceLabel}
      </span>
    </label>
  )
}

function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
