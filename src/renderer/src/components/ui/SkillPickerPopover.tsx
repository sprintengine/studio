import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { WorkspaceSkill, WorkspaceSkillSource } from '../../../../shared/electron-api'
import { ensureSkillForAgent } from '../../utils/skillInvocation'
import { Popover, type PopoverPlacement, type PopoverProps } from './Popover'
import { Spinner } from './Spinner'
import { StarGlyph } from './StarGlyph'
import { Tooltip } from './Tooltip'
import { TruncatedText } from './TruncatedText'

// One inventory, every door: the searchable workspace-skill list behind the
// composer Skills chip, the slash trigger, the terminal panel-header action and
// the agent composer's "+ Skill" attachment. Rows show the real SKILL.md
// name/description with a source label, grouped installed-first; catalog
// entries not yet installed install inline on pick, then behave identically.
// Picking NEVER auto-sends — callers prefill their input and keep the caret.

const SOURCE_LABEL: Record<WorkspaceSkillSource, string> = {
  builtin: 'Built-in',
  pack: 'Skill pack',
  custom: 'Custom',
  plugin: 'Plugin',
}

type SkillInventoryState = {
  skills: WorkspaceSkill[]
  loading: boolean
  error: string | null
}

// Loads the unified inventory when `active` flips true (each open refetches —
// installs/removals elsewhere must show up on the next open).
function useWorkspaceSkills(workspaceRoot: string | null, active: boolean): SkillInventoryState {
  const [state, setState] = useState<SkillInventoryState>({ skills: [], loading: false, error: null })
  useEffect(() => {
    if (!active) return
    if (!workspaceRoot) {
      setState({ skills: [], loading: false, error: 'Open a project folder to use skills.' })
      return
    }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    window.api
      .workspaceSkillsList({ workspaceRoot })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setState({ skills: result.skills, loading: false, error: null })
        else setState({ skills: [], loading: false, error: result.message })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          skills: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Unable to list workspace skills.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [active, workspaceRoot])
  return state
}

function matchesQuery(skill: WorkspaceSkill, normalized: string): boolean {
  if (!normalized) return true
  return (
    skill.id.toLowerCase().includes(normalized)
    || skill.name.toLowerCase().includes(normalized)
    || (skill.description?.toLowerCase().includes(normalized) ?? false)
  )
}

type SkillGroups = {
  installed: WorkspaceSkill[]
  available: WorkspaceSkill[]
  flat: WorkspaceSkill[]
}

function groupSkills(skills: WorkspaceSkill[], query: string): SkillGroups {
  const normalized = query.trim().toLowerCase()
  const matched = skills.filter((skill) => matchesQuery(skill, normalized))
  const installed = matched.filter((skill) => skill.installState !== 'available')
  const available = matched.filter((skill) => skill.installState === 'available')
  return { installed, available, flat: [...installed, ...available] }
}

function SkillGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 2.5h8.5A1.5 1.5 0 0 1 13 4v9.5H4.5A1.5 1.5 0 0 1 3 12V2.5z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M3 11.5A1.5 1.5 0 0 1 4.5 10H13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function SkillRow({
  skill,
  active,
  installing,
  onPick,
  onHover,
}: {
  skill: WorkspaceSkill
  active: boolean
  installing: boolean
  onPick: (skill: WorkspaceSkill) => void
  onHover: () => void
}) {
  const notInstalled = skill.installState === 'available'
  // The row clamps the description to one line; hover restores it in full
  // (same pattern as the agent composer's roster rows).
  const row = (
    <button
      type="button"
      role="menuitem"
      data-skill-row={skill.id}
      onClick={() => onPick(skill)}
      onMouseMove={onHover}
      disabled={installing}
      className={`flex w-full items-start gap-2 rounded px-2.5 py-1.5 text-left transition-colors disabled:cursor-wait ${
        active
          ? 'bg-[color:var(--bg-active)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <SkillGlyph
        className={`icon-sm mt-0.5 shrink-0 ${active ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-subtle)]'}`}
      />
      <span className="min-w-0 flex-1">
        <TruncatedText as="span" text={skill.name} className="block text-[12.5px] font-medium text-[color:var(--text-strong)]" />
        {skill.description ? (
          <TruncatedText as="span" text={skill.description} className="block text-[11.5px] text-[color:var(--text-muted)]" />
        ) : null}
      </span>
      {installing ? (
        <Spinner className="mt-0.5 shrink-0" />
      ) : notInstalled ? (
        <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[color:var(--accent-primary)]">Install</span>
      ) : (
        <span className="mt-0.5 shrink-0 text-[10.5px] text-[color:var(--text-subtle)]">
          {SOURCE_LABEL[skill.source]}
        </span>
      )}
    </button>
  )
  if (!skill.description) return row
  return (
    <Tooltip
      // The tooltip surface is nowrap by design; the inner span opts this one
      // back into wrapping so a multi-sentence SKILL.md description reads as a
      // paragraph, not a viewport-wide line.
      content={<span className="block max-w-[300px] whitespace-normal">{skill.description}</span>}
      placement="left"
      wrapperClassName="block"
    >
      {row}
    </Tooltip>
  )
}

// The grouped list core shared by every anchor mode. Selection is index-based
// over the flattened installed→available order; the parent owns query state.
function SkillList({
  groups,
  loading,
  error,
  query,
  activeIndex,
  installingId,
  onPick,
  onActiveIndexChange,
}: {
  groups: SkillGroups
  loading: boolean
  error: string | null
  query: string
  activeIndex: number
  installingId: string | null
  onPick: (skill: WorkspaceSkill) => void
  onActiveIndexChange: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the active row visible under keyboard navigation.
  useEffect(() => {
    const activeSkill = groups.flat[activeIndex]
    if (!activeSkill) return
    listRef.current
      ?.querySelector(`[data-skill-row="${CSS.escape(activeSkill.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, groups.flat])

  if (loading && groups.flat.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-[color:var(--text-muted)]" role="status">
        <Spinner />
        Loading skills…
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-2.5 py-3 text-[12px] text-[color:var(--tone-error)]" role="status">
        {error}
      </div>
    )
  }
  if (groups.flat.length === 0) {
    return (
      <div className="px-2.5 py-3 text-[12px] text-[color:var(--text-muted)]" role="status">
        {query.trim() ? `No skills match “${query.trim()}”` : 'No skills in this workspace yet'}
      </div>
    )
  }

  const renderGroup = (label: string, skills: WorkspaceSkill[], offset: number) =>
    skills.length > 0 ? (
      <div className="py-0.5">
        <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">
          {label}
        </div>
        {skills.map((skill, index) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            active={offset + index === activeIndex}
            installing={installingId === skill.id}
            onPick={onPick}
            onHover={() => onActiveIndexChange(offset + index)}
          />
        ))}
      </div>
    ) : null

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
      {renderGroup('In this workspace', groups.installed, 0)}
      {renderGroup('Available to install', groups.available, groups.installed.length)}
    </div>
  )
}

// Shared pick pipeline: available entries ensure-install first (busy row),
// then hand the skill — flipped to installed — to the caller.
function usePickWithInstall(
  workspaceRoot: string | null,
  onPick: (skill: WorkspaceSkill) => void,
  onError: (message: string) => void,
) {
  const [installingId, setInstallingId] = useState<string | null>(null)
  const pick = useCallback(
    async (skill: WorkspaceSkill) => {
      if (skill.installState !== 'available') {
        onPick(skill)
        return
      }
      if (!workspaceRoot) {
        onError('Open a project folder to install skills.')
        return
      }
      setInstallingId(skill.id)
      const result = await ensureSkillForAgent({ workspaceRoot, skill })
      setInstallingId(null)
      if (!result.ok) {
        onError(result.message)
        return
      }
      onPick({ ...skill, installState: 'installed' })
    },
    [onError, onPick, workspaceRoot],
  )
  return { installingId, pick }
}

export type SkillPickerPopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceRoot: string | null
  onPick: (skill: WorkspaceSkill) => void
  // "Manage skills →" footer; omit to hide (e.g. surfaces with no route to
  // Connectors → Installed).
  onManageSkills?: () => void
  placement?: PopoverPlacement
  // Custom trigger (e.g. a panel-header icon button). Defaults to the quiet
  // composer "Skills" chip.
  renderTrigger?: PopoverProps['renderTrigger']
  // Opt-in inventory filter (default: show every skill). A surface that can only
  // honor a subset — e.g. a scheduled automation, which installs into a per-run
  // worktree and so only supports built-in skills — narrows the list here rather
  // than offering skills it cannot attach.
  filterSkill?: (skill: WorkspaceSkill) => boolean
}

// Chip-anchored mode: a trigger opens the popover with its own search input;
// search, arrows and Enter all work from the input (keyboard-only operable).
export function SkillPickerPopover({
  open,
  onOpenChange,
  workspaceRoot,
  onPick,
  onManageSkills,
  placement = 'top-start',
  renderTrigger,
  filterSkill,
}: SkillPickerPopoverProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const inventory = useWorkspaceSkills(workspaceRoot, open)
  const visibleSkills = useMemo(
    () => (filterSkill ? inventory.skills.filter(filterSkill) : inventory.skills),
    [inventory.skills, filterSkill],
  )
  const groups = useMemo(() => groupSkills(visibleSkills, query), [visibleSkills, query])

  const { installingId, pick } = usePickWithInstall(
    workspaceRoot,
    (skill) => {
      onOpenChange(false)
      onPick(skill)
    },
    setActionError,
  )

  const clampedActive = Math.min(activeIndex, Math.max(0, groups.flat.length - 1))

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(Math.min(clampedActive + 1, groups.flat.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(clampedActive - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const skill = groups.flat[clampedActive]
      if (skill) void pick(skill)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          setActiveIndex(0)
          setActionError(null)
        }
        onOpenChange(next)
      }}
      ariaLabel="Use a skill"
      popupRole="menu"
      placement={placement}
      renderTrigger={
        renderTrigger
        ?? (({ ref, triggerProps, togglePopover }) => (
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
            {...triggerProps}
          >
            <StarGlyph filled={false} stroked className="icon-sm" />
            Skills
          </button>
        ))
      }
    >
      <div className="flex max-h-[400px] w-[340px] flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
          <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="min-w-0 flex-1 bg-transparent px-1 py-1 text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] focus:outline-none"
          />
        </div>
        <SkillList
          groups={groups}
          loading={inventory.loading}
          error={actionError ?? inventory.error}
          query={query}
          activeIndex={clampedActive}
          installingId={installingId}
          onPick={(skill) => void pick(skill)}
          onActiveIndexChange={setActiveIndex}
        />
        {onManageSkills ? (
          <div className="flex items-center border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
            <span className="flex-1 text-[11px] text-[color:var(--text-subtle)]">↑↓ choose · ⏎ use</span>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onManageSkills()
              }}
              className="text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-default)]"
            >
              Manage skills →
            </button>
          </div>
        ) : null}
      </div>
    </Popover>
  )
}

export type InlineSkillPickerHandle = {
  // Returns true when the event was consumed (matches existed).
  moveSelection: (delta: 1 | -1) => boolean
  pickActive: () => boolean
  matchCount: () => number
}

// Slash-trigger mode: the same list anchored above the caller's input. Focus
// stays in the caller's textarea; it forwards ↑↓/⏎ through the ref handle and
// drives `query` from the draft text after the slash. Rendered only while
// open, inside a `relative` ancestor.
export const InlineSkillPicker = forwardRef<
  InlineSkillPickerHandle,
  {
    workspaceRoot: string | null
    query: string
    onPick: (skill: WorkspaceSkill) => void
    // Fires when the settled (not loading, not errored) match count changes,
    // so the caller can dismiss on non-matching text per the slash contract.
    onMatchCountChange?: (count: number) => void
    className?: string
  }
>(function InlineSkillPicker({ workspaceRoot, query, onPick, onMatchCountChange, className }, ref) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const inventory = useWorkspaceSkills(workspaceRoot, true)
  const groups = useMemo(() => groupSkills(inventory.skills, query), [inventory.skills, query])
  const clampedActive = Math.min(activeIndex, Math.max(0, groups.flat.length - 1))

  const { installingId, pick } = usePickWithInstall(workspaceRoot, onPick, setActionError)

  // Reset the highlight whenever typing changes the filter.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (inventory.loading || inventory.error) return
    onMatchCountChange?.(groups.flat.length)
  }, [groups.flat.length, inventory.error, inventory.loading, onMatchCountChange])

  useImperativeHandle(
    ref,
    () => ({
      moveSelection: (delta) => {
        if (groups.flat.length === 0) return false
        setActiveIndex((prev) => {
          const clamped = Math.min(prev, groups.flat.length - 1)
          return Math.max(0, Math.min(clamped + delta, groups.flat.length - 1))
        })
        return true
      },
      pickActive: () => {
        const skill = groups.flat[clampedActive]
        if (!skill) return false
        void pick(skill)
        return true
      },
      matchCount: () => groups.flat.length,
    }),
    [clampedActive, groups.flat, pick],
  )

  return (
    <div
      role="menu"
      aria-label="Use a skill"
      className={[
        // Positioning (bottom-full / left offset) belongs to the caller's anchor.
        'absolute z-30 mb-2 flex max-h-[340px] w-[380px] flex-col overflow-hidden',
        'rounded-[7px] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)]',
        'shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]', // design-tokens-allow: mirrors the shared Popover elevation for an input-anchored surface
        className ?? '',
      ].join(' ')}
    >
      <SkillList
        groups={groups}
        loading={inventory.loading}
        error={actionError ?? inventory.error}
        query={query}
        activeIndex={clampedActive}
        installingId={installingId}
        onPick={(skill) => void pick(skill)}
        onActiveIndexChange={setActiveIndex}
      />
      <div className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] px-2.5 py-1.5 text-[11px] text-[color:var(--text-subtle)]">
        <span>↑↓ choose · ⏎ use · esc dismiss</span>
        <span className="ml-auto tabular-nums">
          {groups.flat.length} of {inventory.skills.length} skills
        </span>
      </div>
    </div>
  )
})
