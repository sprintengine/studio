import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { SpecialistActionIcon } from '../../AppIcons'
import { IconButton, Section, Select, StatusDot, Switch, Tooltip } from '../../ui'
import type { AgentState, SprintEngineCliPermissionPreset, SprintEngineState } from '../../../types/workspace'
import { getMultiloopRole, type MultiloopRole } from '../../../specialists/specialistActions'
import { getLinkedSprintEngineAgentId, isSprintEngineRole, multiloopCliPermissionOptions, TERMINAL_GROUPS, type LinkedExecutionReadState, type RoleLaunchState } from './helpers'

// ===========================================================================
// SETTINGS POPOVER — combines Run settings (auto-run + permission preset) and
// Terminals (per-role agent launchers) into one popover surface anchored to
// the panel header overflow trigger.
// ===========================================================================

export function MultiloopSettingsPopover({
  autoRunEnabled,
  runStateLabel,
  autoRunReasonLabel,
  cliPermissionPreset,
  agents,
  launchState,
  hasSprintEngineLink,
  linkedSprintEngineState,
  linkedExecutionReadState,
  onToggleAutoRun,
  onPermissionPresetChange,
  onOpenRole,
  onClose,
}: {
  autoRunEnabled: boolean
  runStateLabel: string
  autoRunReasonLabel: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  agents: Record<string, AgentState>
  launchState: RoleLaunchState
  hasSprintEngineLink: boolean
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SprintEngineCliPermissionPreset) => void
  onOpenRole: (role: MultiloopRole) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()
  const restoreFocusElementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreFocusElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      ;(first ?? panelRef.current)?.focus()
    })
    return () => {
      const trigger = document.querySelector<HTMLElement>('[aria-label="Multiloop overflow"]')
      ;(trigger ?? restoreFocusElementRef.current)?.focus()
    }
  }, [])

  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
    if (!focusable || focusable.length === 0) return
    const list = Array.from(focusable)
    const first = list[0]
    const last = list[list.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={panelRef}
      aria-labelledby={labelId}
      tabIndex={-1}
      onKeyDown={onPanelKey}
      className="w-80"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
        <h3 id={labelId} className="text-[13px] font-semibold text-[color:var(--text-strong)]">
          Multiloop settings
        </h3>
        <IconButton aria-label="Close settings" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>

      <Section title="Run" level={4}>
        <div className="flex items-center justify-between gap-3 text-[12px] text-[color:var(--text-default)]">
          <span id="multiloop-settings-auto-label">Autonomous loop</span>
          <Switch
            checked={autoRunEnabled}
            onChange={onToggleAutoRun}
            ariaLabelledBy="multiloop-settings-auto-label"
          />
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.5] text-[color:var(--text-muted)]">
          When on, Multiloop spawns the next role agent as soon as a sprint task is ready.
          Current: {runStateLabel}. Engine reason: {autoRunReasonLabel}.
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] text-[color:var(--text-muted)]">CLI permission preset</span>
          <Select<SprintEngineCliPermissionPreset>
            ariaLabel="CLI permission preset"
            items={multiloopCliPermissionOptions.map(({ value, label }) => ({ value, label }))}
            value={cliPermissionPreset}
            onChange={onPermissionPresetChange}
            className="w-full"
          />
        </div>
      </Section>

      <Section title="Terminals" level={4}>
        <div className="flex flex-col gap-3">
          {TERMINAL_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 text-[11px] text-[color:var(--text-muted)]">{group.label}</div>
              <div className="flex flex-col">
                {group.roles.map((role) => {
                  const soul = getMultiloopRole(role)
                  const isLinkedWorker = hasSprintEngineLink && isSprintEngineRole(role)
                  const agentId = isLinkedWorker && linkedSprintEngineState
                    ? getLinkedSprintEngineAgentId(role, linkedSprintEngineState)
                    : `multiloop-${role}`
                  const exists = Boolean(agents[agentId])
                  const loading = launchState.status === 'loading' && launchState.role === role
                  const disabledReason = isLinkedWorker && !linkedSprintEngineState
                    ? linkedExecutionReadState.status === 'error'
                      ? 'Sprint Engine state is unreadable.'
                      : 'Sprint Engine state is still loading.'
                    : null
                  const terminalKind = isLinkedWorker ? 'Sprint Engine' : 'Multiloop'
                  const tooltipContent = disabledReason ?? `${exists ? 'Focus' : 'Create'} ${terminalKind} ${soul.label} role terminal`
                  return (
                    <Tooltip key={role} content={tooltipContent}>
                      <button
                        type="button"
                        onClick={() => {
                          if (disabledReason) return
                          onOpenRole(role)
                        }}
                        disabled={loading || Boolean(disabledReason)}
                        className="interactive flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <SpecialistActionIcon icon={soul.icon} className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
                        <span className="min-w-0 flex-1 truncate">
                          {loading ? 'Opening…' : `${soul.label} (${terminalKind})`}
                        </span>
                        {exists ? <StatusDot tone="accent" label="Created" /> : null}
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

