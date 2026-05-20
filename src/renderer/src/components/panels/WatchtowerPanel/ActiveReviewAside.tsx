import { useMemo } from 'react'
import { SpecialistActionIcon, SprintEngineRoleIcon } from '../../AppIcons'
import { ActionStatusChip, type ActionStatus } from '../../ui/ActionFeedback'
import { DefinitionList, GhostButton, Section, Select, SidePane, SidePaneHeader, StatusDot, type Tone } from '../../ui'
import { describeExecutionTerminal, useTerminalSessions } from '../../../hooks/useTerminalSessions'
import { getSpecialistAction } from '../../../specialists/specialistActions'
import type { SpecialistActionId } from '../../../types/workspace'
import type { SwitchboardImportResult, WatchtowerRun, WatchtowerRunAgent } from '../../../../../shared/switchboard'
import { hasAgentTab } from '../../../utils/modelRegistry'
import { formatRelativeTime } from '../../../utils/switchboardBoard'
import { hexToRgba, soulRoleToSprintEngineRole, sprintEngineRoleAccent, sprintEngineRoleLabels } from '../../../utils/sprintengine'
import type { AgentTaskOutcome } from './types'

function isTriageRun(run: WatchtowerRun): boolean {
  return run.preset === 'inbox_triage'
}

function specialistShortLabel(agent: WatchtowerRunAgent): string {
  if (!agent.specialistId) return agent.agentId
  try {
    return getSpecialistAction(agent.specialistId as SpecialistActionId).shortLabel
  } catch {
    return agent.specialistId
  }
}

function agentRowTone(agent: WatchtowerRunAgent, outcome: AgentTaskOutcome, triage: boolean): { tone: Tone; pulse: boolean; label: string } {
  const { count, total } = outcome
  if (triage) {
    const scope = total ?? agent.taskIds?.length ?? 0
    switch (agent.status) {
      case 'running': return { tone: 'warn', pulse: true, label: scope > 0 ? 'Triaging ' + count + '/' + scope : 'Triaging…' }
      case 'pending': return { tone: 'neutral', pulse: false, label: 'Queued' }
      case 'completed':
        if (scope === 0) return { tone: 'neutral', pulse: false, label: 'Nothing to triage' }
        if (count === 0) return { tone: 'warn', pulse: false, label: '0 of ' + scope + ' triaged' }
        if (count < scope) return { tone: 'good', pulse: false, label: 'Triaged ' + count + ' of ' + scope }
        return { tone: 'good', pulse: false, label: 'Triaged ' + count + ' item' + (count === 1 ? '' : 's') }
      case 'failed': return { tone: 'error', pulse: false, label: scope > 0 ? 'Failed after ' + count + '/' + scope : 'Failed' }
      case 'canceled': return { tone: 'neutral', pulse: false, label: 'Canceled' }
      default: return { tone: 'neutral', pulse: false, label: agent.status }
    }
  }
  switch (agent.status) {
    case 'running': return { tone: 'warn', pulse: true, label: count > 0 ? 'Reviewing · ' + count + ' added' : 'Reviewing…' }
    case 'pending': return { tone: 'neutral', pulse: false, label: 'Queued' }
    case 'completed': return { tone: 'good', pulse: false, label: count === 0 ? 'No findings' : count + ' added' }
    case 'failed': return { tone: 'error', pulse: false, label: 'Failed' }
    case 'canceled': return { tone: 'neutral', pulse: false, label: 'Canceled' }
    default: return { tone: 'neutral', pulse: false, label: agent.status }
  }
}

function runHistoryLabel(run: WatchtowerRun, index: number): string {
  const verb = isTriageRun(run) ? 'Triage' : 'Review'
  const when = formatRelativeTime(run.createdAt)
  return verb + ' ' + (index + 1) + ' · ' + when
}

export function WatchtowerActiveReviewAside({
  onClose,
  runs,
  selectedRun,
  onSelectRun,
  agentOutcomes,
  importResult,
  workspaceId,
  workspaceRoot,
  runStatus,
  onDismissRunStatus,
  fetchStatus,
  onDismissFetchStatus,
}: {
  onClose: () => void
  runs: WatchtowerRun[]
  selectedRun: WatchtowerRun | null
  onSelectRun: (runId: string) => void
  agentOutcomes: Map<string, AgentTaskOutcome>
  importResult: SwitchboardImportResult | null
  workspaceId: string
  workspaceRoot: string | null
  runStatus: ActionStatus | null
  onDismissRunStatus: () => void
  fetchStatus: ActionStatus | null
  onDismissFetchStatus: () => void
}) {
  const terminalSessions = useTerminalSessions()
  const triageRun = selectedRun ? isTriageRun(selectedRun) : false

  const importItems = useMemo(() => {
    if (!importResult) return []
    return importResult.ok ? importResult.items.slice(0, 8) : []
  }, [importResult])

  const runLabel = selectedRun
    ? selectedRun.status === 'running' || selectedRun.status === 'pending'
      ? triageRun ? 'Active triage' : 'Active review'
      : triageRun ? 'Last triage' : 'Last review'
    : null

  return (
    <SidePane side="right" width="sm" tone="sunken" ariaLabel="Active review">
      <SidePaneHeader
        title="Active review"
        count={selectedRun ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : undefined}
        onClose={onClose}
        closeLabel="Close active review"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runStatus ? (
          <div className="px-3 pt-3">
            <ActionStatusChip
              status={runStatus}
              onDismiss={runStatus.tone === 'error' ? onDismissRunStatus : undefined}
              wrap
            />
          </div>
        ) : null}

        {selectedRun ? (
          <Section
            title={runLabel ?? 'Active review'}
            level={4}
            action={
              runs.length > 1 ? (
                <div className="inline-flex max-w-[180px] items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                  <Select<string>
                    ariaLabel="Switch run"
                    items={runs.slice(0, 8).map((run, index) => ({
                      value: run.runId,
                      label: runHistoryLabel(run, index),
                    }))}
                    value={selectedRun.runId}
                    onChange={(value) => onSelectRun(value)}
                  />
                </div>
              ) : null
            }
          >
            <ul className="-mx-3">
              {selectedRun.agents.length === 0 ? (
                <li className="flex min-w-0 items-center gap-2.5 border-b border-[color:var(--border-default)] px-3 py-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
                    aria-hidden="true"
                  >
                    <SpecialistActionIcon icon="architecture" className="icon-md" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                    {triageRun ? 'Architect spinning up…' : 'Reviewers spinning up…'}
                  </span>
                  <StatusDot tone="warn" pulse label="Spinning up" />
                </li>
              ) : null}
              {selectedRun.agents.map((agent) => {
                const outcome = agentOutcomes.get(agent.agentId) ?? { count: 0 }
                const tone = agentRowTone(agent, outcome, triageRun)
                const terminalState = describeExecutionTerminal(
                  terminalSessions,
                  workspaceId,
                  agent.executionId
                )
                const canOpenTerminal =
                  terminalState.kind !== 'missing' && Boolean(workspaceRoot) && Boolean(agent.executionId)
                const terminalTabOpen =
                  terminalState.kind !== 'missing'
                    ? hasAgentTab(workspaceId, terminalState.agentId)
                    : false
                const terminalButtonLabel = terminalTabOpen ? 'Focus' : 'Terminal'
                const handleOpenTerminal = (): void => {
                  if (!canOpenTerminal || !agent.executionId) return
                  void import('../../../utils/modelRegistry').then(({ focusOrAddAgentSessionTab }) => {
                    void focusOrAddAgentSessionTab(workspaceId, {
                      executionId: agent.executionId!,
                      fallbackName: specialistShortLabel(agent),
                    })
                  })
                }
                const action = agent.specialistId ? getSpecialistAction(agent.specialistId as SpecialistActionId) : null
                // Watchtower runs fixed specialist actions, not Sprint Engine
                // registry roles. `soulRoleToSprintEngineRole` narrows the
                // specialist's `soulRole` to a bundled `SprintEngineRole` (or
                // null when the specialist has no bundled equivalent), so
                // indexing `sprintEngineRoleLabels`/`Accent` here is the
                // documented bundled-role compatibility path. Custom Sprint
                // Engine registry roles never reach this aside.
                const role = action ? soulRoleToSprintEngineRole(action.soulRole) : null
                const displayLabel = role ? sprintEngineRoleLabels[role] : (action?.shortLabel ?? specialistShortLabel(agent))
                const discStyle = role
                  ? {
                      backgroundColor: hexToRgba(sprintEngineRoleAccent[role], 0.18),
                      color: sprintEngineRoleAccent[role],
                    }
                  : undefined
                const hasError = Boolean(agent.errorMessage)
                return (
                  <li
                    key={agent.agentId}
                    className="border-b border-[color:var(--border-default)] last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                          role ? '' : 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]'
                        }`}
                        // design-tokens-allow: role glyph is the documented exception to the one-accent rule; see knowledge/brand/panel-design-system.md.
                        style={discStyle}
                        aria-hidden="true"
                      >
                        {role ? (
                          <SprintEngineRoleIcon role={role} className="icon-md" />
                        ) : (
                          <SpecialistActionIcon icon={action?.icon ?? 'review'} className="icon-md" />
                        )}
                      </span>
                      {hasError ? (
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <span className="block min-w-0 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                            {displayLabel}
                          </span>
                          <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                            <StatusDot tone={tone.tone} pulse={tone.pulse} />
                            <span
                              className="min-w-0 flex-1 truncate text-[color:var(--tone-error)]"
                              title={agent.errorMessage ?? undefined}
                            >
                              {agent.errorMessage}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                            {displayLabel}
                          </span>
                          <StatusDot tone={tone.tone} pulse={tone.pulse} />
                          <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">
                            {tone.label}
                          </span>
                        </>
                      )}
                      {canOpenTerminal ? (
                        <GhostButton
                          size="sm"
                          className="!h-6 shrink-0"
                          onClick={handleOpenTerminal}
                        >
                          {terminalButtonLabel}
                        </GhostButton>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Section>
        ) : (
          <Section title="No active review" level={4}>
            <div className="text-[12px] text-[color:var(--text-muted)]">
              Start a review or fetch issues to populate this drawer.
            </div>
          </Section>
        )}

        {importResult ? (
          <Section
            title={`Last import · ${importResult.provider}`}
            level={4}
            action={
              fetchStatus ? (
                <ActionStatusChip
                  status={fetchStatus}
                  onDismiss={fetchStatus.tone === 'error' ? onDismissFetchStatus : undefined}
                />
              ) : null
            }
          >
            {importResult.ok ? (
              <>
                <DefinitionList
                  layout="two-column"
                  items={[
                    { term: 'Created', description: <span className="tabular-nums">{importResult.summary.created}</span> },
                    { term: 'Updated', description: <span className="tabular-nums">{importResult.summary.updated}</span> },
                    { term: 'Skipped', description: <span className="tabular-nums">{importResult.summary.skipped}</span> },
                    { term: 'Errors', description: <span className="tabular-nums">{importResult.summary.errors}</span> },
                  ]}
                />
                {importItems.length > 0 ? (
                  <ul className="mt-2 max-h-32 overflow-auto border-t border-[color:var(--border-default)] pt-2">
                    {importItems.map((item, index) => {
                      const itemTone: Tone =
                        item.status === 'created' ? 'good' : item.status === 'error' ? 'error' : 'neutral'
                      return (
                        <li
                          key={`${item.externalKey ?? item.externalUrl ?? index}:${index}`}
                          className="flex min-w-0 items-center gap-2 py-0.5 text-[11px]"
                        >
                          <StatusDot tone={itemTone} />
                          <span className="shrink-0 text-[color:var(--text-muted)]">{item.status}</span>
                          <span className="truncate font-mono text-[color:var(--text-default)]">
                            {item.externalKey ?? item.externalUrl ?? 'unknown source'}
                          </span>
                          {item.message ? (
                            <span className="truncate text-[color:var(--text-subtle)]">{item.message}</span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </>
            ) : (
              <div className="text-[12px] text-[color:var(--tone-error)]">{importResult.message}</div>
            )}
          </Section>
        ) : null}
      </div>
    </SidePane>
  )
}
