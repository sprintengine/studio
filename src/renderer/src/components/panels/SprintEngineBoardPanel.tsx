import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  selectSprintEngineView,
  useSprintEngineViewStore,
  type SprintEngineView,
} from '../../store/sprintEngineViewStore'
import {
 CliModelPickerButton,
 CloseIconButton,
 OverflowMenu,
 GhostButton,
 LifecycleGlyph,
 Popover,
 SidePane,
 Spinner,
 StatusDot,
 Section,
 Select,
 Tabs,
 TruncatedText,
 DefinitionList,
 type LifecycleState,
 type OverflowMenuItem,
 type TabItem,
 type Tone,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'

// Lazy so the run-summary report (+ its charts) only loads with the Summary tab.
const SprintEngineRunSummaryPanel = React.lazy(() => import('./SprintEngineRunSummaryPanel'))
import {
 buildRunSummary,
} from '../../utils/sprintengineRunSummary'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import type {
 AgentCli,
 NotificationNavigationTarget,
 SprintEngineArtifact,
 SprintEngineAutomationMode,
 SprintEngineAutomationRuntimeState,
 SprintEngineCliPermissionPreset,
 SprintEngineRole,
 SprintEngineRoleId,
 SprintEngineRoleRegistry,
 SprintEngineState,
 SprintEngineTask,
 SprintEngineTaskBoardColumn,
 Workspace,
} from '../../types/workspace'
import { consumePendingRevealTarget, subscribeRevealTarget } from '../../utils/revealTarget'
import { SprintEngineRoleIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { selectAgentCliCatalog } from '../workspace/newWorkspace/cliRuntimeOptions'
import type { PluginModelCatalog } from '../../../../shared/plugin-manifest'
import { useSprintEngineTokenUsage } from '../../hooks/useSprintEngineTokenUsage'
import {
 bracketedTerminalPaste,
 buildSprintEngineRoleRegistry,
 formatSprintEngineLockAge,
 deriveSprintEngineRepoMergeRollup,
 deriveSprintEngineRunGlyph,
 getNextSprintEngineAgentId,
 getSprintEngineBoardRunPhase,
 getSprintEngineTaskBoardColumn,
 getSprintEngineTaskOwnerLabel,
 getSprintEngineRoleAccent,
 getUserDisabledSprintEngineRoleIds,
 getSprintEngineRoleLabel,
 isCanceledSprintEngineRun,
 isCompletedSprintEngineRun,
 isNewSprintEngineRoleForRun,
} from '../../utils/sprintengine'
import { canLaunchSprintEngineInitialSpawn } from '../../utils/sprintengineInitialSpawns'
import {
 deriveSprintEngineAutomationMode,
 sprintEngineAutomationModeOptions,
} from '../../utils/sprintengineAutomation'
import { normalizeSprintEngineAutomationRuntimeState } from '../../utils/sprintengineAutomationLifecycle'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import {
 publishSprintEngineAutomationModeNotification,
} from '../../utils/sprintengineNotifications'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { findFirstUncoveredSprintEngineRole } from '../../utils/sprintengineRoleOptions'
import {
 buildSprintEnginePlanRevisionForNewMemberPrompt,
} from '../../utils/sprintenginePlanReviewPrompts'
import { normalizeAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnostic, publishDiagnosticSync } from '../../utils/diagnostics'
import {
 getEffectiveKeybindingLabel,
 platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'
import { isEditableTarget } from '../../utils/keyboard'
import {
 artifactTimestampMs,
 type ArtifactActionState,
 type TaskInputActionState,
 type TaskCommentActionState,
 type SprintEngineInspectorSelection,
} from './sprintEngineInspector'
import { SprintEngineInspectorPanel } from './SprintEngineInspectorPanel'
import { SprintEngineTaskGraphView } from './SprintEngineTaskGraphView'
import {
 SprintEngineInboxIcon,
 SprintEngineRosterNavIcon,
 SprintEngineSummaryNavIcon,
 SprintEngineTasksNavIcon,
} from './sprintEngineBoard/SprintEngineBoardIcons'
import { SprintEngineInboxView } from './sprintEngineBoard/SprintEngineInboxView'
import { SprintEngineRosterView } from './sprintEngineBoard/SprintEngineRosterView'
import { SprintEngineTasksKanbanView } from './sprintEngineBoard/SprintEngineTasksKanbanView'
import { RunCompletePullRequestAction, RunPullRequestViewChip, useRunPullRequestMergePoll } from './runPullRequest'
import { isRunPullRequestWatchable } from '../workspace/SprintEnginePullRequestPollSupervisor'
import { useSprintEngineBoardModel } from './sprintEngineBoard/useSprintEngineBoardModel'
import {
  useSprintEngineBoardArtifactActions,
  type SprintEnginePreviewedArtifact,
} from './sprintEngineBoard/useSprintEngineBoardArtifactActions'
import { useSprintEngineBoardTerminalActions } from './sprintEngineBoard/useSprintEngineBoardTerminalActions'
import { sprintAnnotationFeedback } from '../workspace/guidedBrief/annotate/serialize'
import type { MockupAnnotation } from '../workspace/guidedBrief/annotate/types'
import {
  clampInspectorPaneWidth,
  loadInspectorPaneWidth,
  saveInspectorPaneWidth,
} from './sprintEngineBoard/inspectorPaneWidth'



const sprintEngineCliPermissionOptions: Array<{
 value: SprintEngineCliPermissionPreset
 label: string
 title: string
 tone?: Tone
}> = [
 {
 value: 'default',
 label: 'Default permissions',
 title: 'Use the CLI default permission behavior.',
 },
 {
 value: 'auto_workspace',
 label: 'Auto in workspace',
 title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
 },
 {
 value: 'bypass_all',
 label: 'Bypass permissions',
 title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
 // Warn tone mirrors the Agent Picker's Bypass chip so the risky preset reads
 // the same in both surfaces.
 tone: 'warn',
 },
]


interface Props {
 workspaceId: string
 fixedView?: SprintEngineView
 /** When a host pins the Tasks tab to a single layout (Graph or Kanban),
  *  this hides the inline switcher and locks the rendered layout to that
  *  choice. Used when Tasks is mounted as a standalone flex tab that
  *  should not expose the switcher. */
 fixedTasksLayout?: SprintEngineTasksLayout
}

type SyncState = {
 status: 'idle' | 'syncing' | 'live' | 'error'
 message: string
}

// Local spawn intent for an operator-added worker, keyed by the id the board
// mints for it (MC-1591 leases: the engine binds the worker at claim, so there
// is no roster op to register it first). The confirm effect applies the chosen
// runtime and (optionally) starts the terminal on the minted id. This is launch
// intent, not roster state — the worker becomes canonical once it claims.
type PendingRosterMemberSpawn = {
 agentId: string
 role: SprintEngineRoleId
 name?: string
 cli?: AgentCli
 // string = explicit model id, null = explicit CLI default, undefined = keep
 // whatever the reconciled agent record already has.
 model?: string | null
 spawnNow?: boolean
}

type SprintEngineTasksLayout = 'graph' | 'kanban'

// Model field for the spawn/recovery dialogs. Rendered only when the selected
// CLI's plugin declares modelSelection; "Default" means the CLI's own default
// (no flag passed at launch).
function SprintEngineModelField({
 cliOption,
 model,
 onChange,
}: {
 cliOption: { label: string; modelSelection?: PluginModelCatalog } | undefined
 model: string | undefined
 onChange: (model: string | undefined) => void
}) {
 const [open, setOpen] = useState(false)
 const [customModel, setCustomModel] = useState('')
 const catalog = cliOption?.modelSelection
 if (!cliOption || !catalog) return null
 const knownLabel = model ? catalog.options.find((option) => option.id === model)?.label : undefined
 const currentLabel = model ? knownLabel ?? model : 'Default'
 return (
 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Model
 </div>
 <Popover
 open={open}
 onOpenChange={(next) => {
 setOpen(next)
 if (!next) setCustomModel('')
 }}
 ariaLabel={`Model options for ${cliOption.label}`}
 popupRole="listbox"
 placement="bottom-start"
 className="block w-full"
 surfaceClassName="min-w-[var(--popover-trigger-width)] p-1"
 renderTrigger={({ ref, triggerProps, togglePopover }) => (
 <button
 ref={ref}
 type="button"
 onClick={togglePopover}
 className="flex h-10 w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-sm text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
 {...triggerProps}
 >
 <TruncatedText
 as="span"
 text={currentLabel}
 className={`min-w-0 flex-1 ${model && !knownLabel ? 'font-mono text-[13px]' : ''}`}
 />
 <svg
 className={`icon-md shrink-0 text-[color:var(--text-disabled)] transition-transform ${open ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )}
 >
 {[
 { id: undefined as string | undefined, label: 'Default' },
 ...catalog.options.map((option) => ({ id: option.id as string | undefined, label: option.label ?? option.id })),
 ].map((option) => {
 const selected = option.id === model
 return (
 <button
 key={option.id ?? '__default__'}
 type="button"
 role="option"
 aria-selected={selected}
 onClick={() => {
 onChange(option.id)
 setOpen(false)
 }}
 className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm interactive transition-colors ${
 selected
 ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
 }`}
 >
 <TruncatedText as="span" text={option.label} className="min-w-0 flex-1" />
 {selected ? (
 <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 {model && !catalog.options.some((option) => option.id === model) ? (
 <button
 type="button"
 role="option"
 aria-selected
 onClick={() => setOpen(false)}
 className="flex w-full items-center gap-3 rounded-md bg-[color:var(--bg-hover)] px-3 py-2 text-left font-mono text-[13px] text-[color:var(--text-strong)]"
 >
 <TruncatedText as="span" text={model} className="min-w-0 flex-1" />
 <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 ) : null}
 {catalog.allowCustomId ? (
 <input
 type="text"
 value={customModel}
 placeholder="Custom model id"
 aria-label={`Custom model id for ${cliOption.label}`}
 onChange={(event) => setCustomModel(event.target.value)}
 onKeyDown={(event) => {
 event.stopPropagation()
 if (event.key === 'Enter') {
 const next = customModel.trim()
 if (next) {
 onChange(next)
 setOpen(false)
 }
 }
 }}
 className="mt-1 w-full rounded-md border border-[color:var(--border-subtle)] bg-transparent px-3 py-2 font-mono text-[13px] text-[color:var(--text-default)] placeholder:font-sans placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] focus:outline-none"
 />
 ) : null}
 </Popover>
 </div>
 )
}

type RecoveryDialogState = {
 cli: AgentCli
 model?: string
}

const sprintEngineAutomationRuntimeLabels: Record<SprintEngineAutomationRuntimeState, string> = {
 idle: 'Idle',
 running: 'Running',
 paused: 'Paused',
 blocked: 'Blocked',
 failed: 'Failed',
 complete: 'Complete',
 canceled: 'Canceled',
}

// Automation status reads by shape, not a colored dot: only the exceptional
// lifecycle states earn a glyph. `running` shows the Spinner instead, and
// idle/complete render no mark at all.
const sprintEngineAutomationRuntimeGlyphs: Partial<Record<SprintEngineAutomationRuntimeState, LifecycleState>> = {
 paused: 'paused',
 blocked: 'needs_input',
 failed: 'failed',
}

function sprintEngineAutomationRuntimeActionLabel(
 runtimeState: SprintEngineAutomationRuntimeState,
): string | null {
 if (runtimeState === 'failed') return 'Retry'
 if (runtimeState === 'paused' || runtimeState === 'blocked') return 'Resume'
 return null
}

export function SprintEngineSettingsPopover({
 automationMode,
 runtimeState,
 runtimeReason,
 runtimeTask,
 cliPermissionPreset,
 onChangeAutomationMode,
 onResumeAutomation,
 onOpenRuntimeTask,
 onUpdateCliPreset,
 onClose,
}: {
 automationMode: SprintEngineAutomationMode
 runtimeState: SprintEngineAutomationRuntimeState
 runtimeReason?: string
 runtimeTask: SprintEngineTask | null
 cliPermissionPreset: SprintEngineCliPermissionPreset
 onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
 onResumeAutomation: (() => void) | null
 onOpenRuntimeTask: ((taskId: string) => void) | null
 onUpdateCliPreset: (preset: SprintEngineCliPermissionPreset) => void
 onClose: () => void
}) {
 const containerRef = useRef<HTMLDivElement>(null)
 const restoreFocusElementRef = useRef<HTMLElement | null>(null)
 useEffect(() => {
 restoreFocusElementRef.current = document.activeElement instanceof HTMLElement
 ? document.activeElement
 : null
 const frame = window.requestAnimationFrame(() => {
 const first = containerRef.current?.querySelector<HTMLElement>(
 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
 )
 ;(first ?? containerRef.current)?.focus()
 })
 return () => {
 window.cancelAnimationFrame(frame)
 const trigger = document.querySelector<HTMLElement>('[aria-label^="Run configuration"]')
 ;(trigger ?? restoreFocusElementRef.current)?.focus()
 }
 }, [])
 const onPanelKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (event.key !== 'Tab') return
 const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
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
 const runtimeActionLabel = sprintEngineAutomationRuntimeActionLabel(runtimeState)
 const runtimeGlyph = sprintEngineAutomationRuntimeGlyphs[runtimeState]
 // Blocked reasons arrive as "Waiting on <taskId>: <question>". When the task
 // row below already names the id, keep only the question so the id isn't
 // stated twice in four lines.
 const runtimeTaskPrefix = runtimeTask ? `Waiting on ${runtimeTask.id}: ` : null
 const runtimeReasonDisplay = runtimeTaskPrefix && runtimeReason?.startsWith(runtimeTaskPrefix)
 ? runtimeReason.slice(runtimeTaskPrefix.length)
 : runtimeReason
 const currentPresetHint =
 sprintEngineCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.title
 return (
 <div
 ref={containerRef}
 aria-label="Sprint run configuration"
 tabIndex={-1}
 onKeyDown={onPanelKey}
 className="w-[300px] overflow-hidden py-1"
 >
 <Section title="Automation" level={3} inset={true}>
 <div className="flex flex-col" role="radiogroup" aria-label="Automation mode">
 {sprintEngineAutomationModeOptions.map((option) => {
 const checked = option.value === automationMode
 return (
 <button
 key={option.value}
 type="button"
 role="radio"
 aria-checked={checked}
 onClick={() => onChangeAutomationMode(option.value)}
 className="interactive flex w-full items-start gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
 >
 <span className="min-w-0 flex-1">
 <span className={`block text-[12px] ${checked ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
 {option.label}
 </span>
 <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">{option.hint}</span>
 </span>
 <svg
 className={`icon-sm mt-0.5 shrink-0 text-[color:var(--accent-primary)] ${checked ? '' : 'invisible'}`}
 viewBox="0 0 16 16"
 fill="none"
 aria-hidden="true"
 >
 <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )
 })}
 </div>
 {runtimeGlyph ? (
 <div className="mt-2 px-2">
 <div className="flex items-center gap-2">
 <LifecycleGlyph state={runtimeGlyph} />
 <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--text-strong)]">
 {sprintEngineAutomationRuntimeLabels[runtimeState]}
 </span>
 {runtimeActionLabel && onResumeAutomation ? (
 <GhostButton
 onClick={() => {
 onResumeAutomation()
 onClose()
 }}
 >
 {runtimeActionLabel}
 </GhostButton>
 ) : null}
 </div>
 {runtimeReasonDisplay ? (
 <p className="mt-1 text-[11px] leading-4 text-[color:var(--text-muted)]">{runtimeReasonDisplay}</p>
 ) : null}
 {runtimeTask && onOpenRuntimeTask ? (
 <button
 type="button"
 onClick={() => {
 onOpenRuntimeTask(runtimeTask.id)
 onClose()
 }}
 aria-label={`Open task ${runtimeTask.id} ${runtimeTask.title}`}
 className="interactive -mx-1 mt-1 flex w-[calc(100%+0.5rem)] items-baseline gap-2 rounded-[5px] px-1 py-1 text-left transition-colors hover:bg-[color:var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
 >
 <span className="shrink-0 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">
 {runtimeTask.id}
 </span>
 <TruncatedText
 as="span"
 text={runtimeTask.title}
 className="min-w-0 flex-1 text-[12px] text-[color:var(--text-strong)]"
 />
 </button>
 ) : null}
 </div>
 ) : null}
 </Section>
 <Section title="CLI permissions" level={3} inset={true}>
 <Select<SprintEngineCliPermissionPreset>
 ariaLabel="CLI permission preset"
 items={sprintEngineCliPermissionOptions.map(({ value, label, tone }) => ({ value, label, tone }))}
 value={cliPermissionPreset}
 onChange={onUpdateCliPreset}
 className="w-full"
 />
 {currentPresetHint ? (
 <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--text-muted)]">{currentPresetHint}</p>
 ) : null}
 </Section>
 </div>
 )
}

export default function SprintEngineBoardPanel(props: Props) {
 const workspace = useWorkspaceStore(
 (s) => s.workspaces.find((w) => w.id === props.workspaceId) ?? null
 )

 if (!workspace?.sprintEngineState) {
 return (
 <div className="flex h-full items-center justify-center bg-[color:var(--bg-surface)] text-sm text-[color:var(--text-disabled)]">
 Sprint workspace data is missing.
 </div>
 )
 }

 return (
 <SprintEngineBoardPanelContent
 {...props}
 workspace={workspace}
 sprintEngineState={workspace.sprintEngineState}
 />
 )
}

function SprintEngineBoardPanelContent({
 workspaceId,
 fixedView,
 fixedTasksLayout,
 workspace,
 sprintEngineState,
}: Props & {
 workspace: Workspace
 sprintEngineState: SprintEngineState
}) {
  const setSprintEngineState = useWorkspaceStore((s) => s.setSprintEngineState)
  const setSprintEngineAutomationMode = useWorkspaceStore((s) => s.setSprintEngineAutomationMode)
  const applySprintEngineAutomationEvent = useWorkspaceStore((s) => s.applySprintEngineAutomationEvent)
  const setSprintEngineCliPermissionPreset = useWorkspaceStore((s) => s.setSprintEngineCliPermissionPreset)
 const addSprintEngineMember = useWorkspaceStore((s) => s.addSprintEngineMember)
 const setSprintEngineMaxConcurrentAgents = useWorkspaceStore((s) => s.setSprintEngineMaxConcurrentAgents)
 const consumeSprintEngineInitialSpawns = useWorkspaceStore((s) => s.consumeSprintEngineInitialSpawns)
 const updateAgent = useWorkspaceStore((s) => s.updateAgent)
 const openFile = useWorkspaceStore((s) => s.openFile)
 const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
 const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
 const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
 const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
 const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
 const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
 const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
 const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
 const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
 const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
 const shortcutFor = useCallback((commandId: string): string | undefined => (
 getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
 ), [keybindingPlatform, keybindingSettings])
 // Select the stable notifications array and derive the run-activity list +
 // unread count with useMemo. Returning the filtered array straight from the
 // selector hands Zustand v5's useSyncExternalStore a fresh reference every
 // render, which trips its "getSnapshot should be cached" invariant and throws
 // inside the panel — see the perf follow-up plan. (countUnread returns a
 // primitive, so it never tripped this on its own, but it shares the source.)
 const disabledRoleIds = useMemo<ReadonlySet<SprintEngineRoleId>>(
   () => getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings),
   [sprintEngineRoleSettings],
 )
 const dialog = useConfirmDialog()
 const {
 folderPath: savedFolderPath,
 folderReadyPath,
 folderMissing,
 message: folderStatusMessage,
 checkedPath: folderCheckedPath,
 recheckFolder,
 } = useWorkspaceFolderStatus(workspaceId)
 const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
 // Drag-resized inspector width; null keeps SidePane's responsive preset.
 // Persisted app-wide (not per workspace): pane width is a reading preference.
 const [inspectorWidthPx, setInspectorWidthPx] = useState<number | null>(() => loadInspectorPaneWidth())
 const inspectorWidthSaveTimer = useRef<number | null>(null)
 const [previewedArtifact, setPreviewedArtifact] = useState<SprintEnginePreviewedArtifact | null>(null)
 // The inbox row → inspector binding. Set by SprintEngineProjectView when
 // the user clicks an inbox artifact. Cleared whenever task/agent
 // selection changes so the inspector lights up the most recent intent.
 const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
 // Switching tasks clears the artifact preview so the aside returns to
 // task detail. Opening an artifact does not change selectedTaskId, so
 // this only fires on a real navigation.
 useEffect(() => {
 setPreviewedArtifact(null)
 }, [selectedTaskId])
 useEffect(() => {
 if (selectedTaskId !== null) setSelectedArtifactId(null)
 }, [selectedTaskId])
 // Selecting a different inbox artifact clears any open document preview
 // so the inspector switches to the newly-selected artifact instead of
 // sticking on the previously-opened document.
 useEffect(() => {
 setPreviewedArtifact((current) =>
 current && current.id !== selectedArtifactId ? null : current,
 )
 }, [selectedArtifactId])
 // Active SE view is shared with the workspace top-bar segmented nav, so it
 // lives in a small persisted store keyed by workspace id rather than local
 // state. The `fixedView` prop still wins when WorkspaceLayout pins a view
 // through the defensive legacy renderers.
 const activeView = useSprintEngineViewStore((state) => selectSprintEngineView(state, workspaceId))
 const setSprintEngineView = useSprintEngineViewStore((state) => state.setView)
 const setActiveView = useCallback(
 (view: SprintEngineView) => setSprintEngineView(workspaceId, view),
 [setSprintEngineView, workspaceId],
 )
 // The Tasks tab carries an inline layout switcher (Graph / Kanban). The
 // selection is persisted across tab switches so jumping away and back
 // returns to the same layout. When the host pins a layout via
 // `fixedTasksLayout` the switcher is hidden and the pinned value wins.
 const [activeTasksLayout, setActiveTasksLayout] = useState<SprintEngineTasksLayout>('kanban')
 const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
 const [inspectorExpanded, setInspectorExpanded] = useState(false)
 const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
 const [requestChangesDialog, setRequestChangesDialog] = useState<{
 artifact: SprintEngineArtifact
 feedback: string
 submitting: boolean
 error: string | null
 } | null>(null)
 const [cliPickerOpen, setCliPickerOpen] = useState(false)
 const [settingsOpen, setSettingsOpen] = useState(false)
 const [addMemberOpen, setAddMemberOpen] = useState(false)
 const [addMemberRole, setAddMemberRole] = useState<SprintEngineRole>('developer')
 // Runtime selections for the Add Member dialog. `addMemberCli === null`
 // means "use the role's CLI default"; model semantics match the spawn
 // dialog (undefined = the CLI's own default, no flag passed).
 const [addMemberName, setAddMemberName] = useState('')
 const [addMemberCli, setAddMemberCli] = useState<AgentCli | null>(null)
 const [addMemberModel, setAddMemberModel] = useState<string | undefined>(undefined)
 const [addMemberSpawnNow, setAddMemberSpawnNow] = useState(true)
 const [addMemberBusy, setAddMemberBusy] = useState(false)
 const [addMemberError, setAddMemberError] = useState<string | null>(null)
 const [pendingRosterMemberSpawns, setPendingRosterMemberSpawns] = useState<PendingRosterMemberSpawn[]>([])
 const pendingRosterMemberSpawnInFlightRef = useRef<Set<string>>(new Set())
 const [manualRefreshBusy, setManualRefreshBusy] = useState(false)
 const [confirmCancelSprint, setConfirmCancelSprint] = useState(false)
 const [cancelSprintBusy, setCancelSprintBusy] = useState(false)
 const [pendingAutomationMode, setPendingAutomationMode] = useState<SprintEngineAutomationMode | null>(null)
 const [artifactActions, setArtifactActions] = useState<Record<string, ArtifactActionState>>({})
 const [taskInputActions, setTaskInputActions] = useState<Record<string, TaskInputActionState>>({})
 const [taskCommentActions, setTaskCommentActions] = useState<Record<string, TaskCommentActionState>>({})
 const [syncState, setSyncState] = useState<SyncState>({
 status: 'idle',
 message: 'Waiting for a sprint workspace folder.',
 })

 const sprintEngineContext = workspace?.sprintEngineContext ?? null
 // The Summary view only exists once the run is complete; coerce a stale
 // persisted `summary` back to Tasks for incomplete runs so it can't strand.
 const runComplete = Boolean(
 sprintEngineState && isCompletedSprintEngineRun(sprintEngineState)
 )
 const requestedView = fixedView ?? activeView
 const effectiveView: SprintEngineView =
 requestedView === 'summary' && !runComplete ? 'tasks' : requestedView
 const effectiveTasksLayout: SprintEngineTasksLayout = fixedTasksLayout ?? activeTasksLayout
 const folderPath = folderReadyPath
 const agents = workspace?.agents ?? {}
 const terminalSessions = useTerminalSessions()
  const projectedAutomationMode = deriveSprintEngineAutomationMode(workspace?.sprintEngineAutoState, sprintEngineState?.runner)
  const automationMode = pendingAutomationMode ?? projectedAutomationMode
  const automationRuntimeState = normalizeSprintEngineAutomationRuntimeState(
  workspace?.sprintEngineAutoState?.runtimeState,
  projectedAutomationMode,
  )
  const automationRuntimeReason = workspace?.sprintEngineAutoState?.reasonMessage
  const automationRuntimeGlyph = sprintEngineAutomationRuntimeGlyphs[automationRuntimeState]
  const cliPermissionPreset = workspace?.sprintEngineAutoState?.cliPermissionPreset ?? 'default'

 // Sprint Engine role registry for the workspace. Loaded once per folder so
 // the Add Member options and uncovered-role detection surface custom enabled
 // registry roles alongside the bundled board roles. The list silently falls
 // back to the bundled set when the IPC bridge or the registry payload is
 // unavailable.
 const [roleRegistry, setRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
 useEffect(() => {
   let cancelled = false
   if (!folderPath || typeof window.api.readSprintEngineRegistryRoles !== 'function') {
     setRoleRegistry(null)
     return undefined
   }
   void window.api.readSprintEngineRegistryRoles({ workspaceRoot: folderPath, includeShadowed: true })
     .then((result) => {
       if (cancelled) return
       if (result.ok) {
         setRoleRegistry(buildSprintEngineRoleRegistry(result.data))
       } else {
         setRoleRegistry(null)
       }
     })
     .catch(() => {
       if (cancelled) return
       setRoleRegistry(null)
     })
   return () => {
     cancelled = true
   }
 }, [folderPath])

 useEffect(() => {
 setPendingAutomationMode(null)
 setPendingRosterMemberSpawns([])
 pendingRosterMemberSpawnInFlightRef.current.clear()
 }, [sprintEngineContext?.statePath])

 const sprintEngineTasks = sprintEngineState?.tasks ?? []
 const {
 roster,
 rosterById,
 runtimeAgents,
 runtimeAgentById,
 readyTasks,
 boardColumns,
 reviewArtifacts,
 artifactsByTaskId,
 artifactBlockersByTaskId,
 tasksById,
 inboxArtifactCount,
 addMemberOptions,
 } = useSprintEngineBoardModel({ sprintEngineState, agents, roleRegistry, disabledRoleIds })

 // The runtime stop reason (blocked / paused / failed) usually names the task
 // it stopped on; resolve it so the run-configuration popover can deep-link
 // into the task inspector instead of dead-ending on the reason sentence.
 const automationRuntimeTaskId = workspace?.sprintEngineAutoState?.reasonTaskId
 const automationRuntimeTask = automationRuntimeTaskId
 ? tasksById[automationRuntimeTaskId] ?? null
 : null

 const getLiveAgentTerminalSession = useCallback(
 (agentId: string) => {
 const agentSessionId = agents[agentId]?.cliSessionId
 return terminalSessions.find((session) =>
 session.processAlive
 && session.kind === 'agent'
 && session.workspaceId === workspaceId
 && (
 session.agentId === agentId
 || (agentSessionId ? session.sessionId === agentSessionId : false)
 )
 && (!sprintEngineContext || session.sprintEngineStatePath === sprintEngineContext.statePath)
 )
 },
 [agents, sprintEngineContext, terminalSessions, workspaceId]
 )

 const isAgentTerminalLive = useCallback(
 (agentId: string): boolean => Boolean(getLiveAgentTerminalSession(agentId)),
 [getLiveAgentTerminalSession]
 )

 useEffect(() => {
 if (!savedFolderPath) {
 setSyncState({
 status: 'idle',
 message: MULTICODE_DISABLE_SPRINTENGINE_SYNC
 ? 'Auto-sync off (debug). Choose a workspace folder, then refresh the board.'
 : 'Choose a workspace folder to watch agent-managed sprint state.',
 })
 return
 }
 if (!folderPath) {
 setSyncState({
 status: folderMissing ? 'error' : 'idle',
 message: folderMissing
 ? `Saved workspace folder is missing: ${savedFolderPath}`
 : 'Checking workspace folder before reading sprint state.',
 })
 return
 }
 if (!sprintEngineContext?.statePath) {
 setSyncState({
 status: 'idle',
 message: 'Waiting for agent-managed state.',
 })
 return
 }

 // Debug escape: projection polling is disabled, so the board is not watching
 // live agent-managed state. It only updates on manual refresh or agent
 // mutations, and the operator signal must say so rather than claim "live".
 if (MULTICODE_DISABLE_SPRINTENGINE_SYNC) {
 setSyncState({
 status: 'idle',
 message: 'Auto-sync off (debug). Refresh board to read the latest projection.',
 })
 return
 }

 setSyncState({
 status: 'live',
 message: `Watching agent-managed state at ${sprintEngineContext.statePath}`,
 })
 }, [folderMissing, folderPath, savedFolderPath, sprintEngineContext?.statePath])

 // startAgentTerminal / ensureWorkspaceFolderReadyForLaunch / startAgentTerminalWhenReady
 // moved to useSprintEngineBoardTerminalActions hook (initialized below).

 const previousColumnByTaskRef = useRef<Map<string, SprintEngineTaskBoardColumn>>(new Map())
 const [recentlyMovedTaskIds, setRecentlyMovedTaskIds] = useState<Set<string>>(new Set())

 useEffect(() => {
 if (!sprintEngineState) {
 previousColumnByTaskRef.current = new Map()
 return
 }
 const nextMap = new Map<string, SprintEngineTaskBoardColumn>()
 for (const task of sprintEngineState.tasks) {
 nextMap.set(task.id, getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks))
 }
 const moved: string[] = []
 for (const [taskId, column] of nextMap) {
 const previousColumn = previousColumnByTaskRef.current.get(taskId)
 if (previousColumn && previousColumn !== column) moved.push(taskId)
 }
 previousColumnByTaskRef.current = nextMap
 if (moved.length > 0) {
 setRecentlyMovedTaskIds(new Set(moved))
 }
 }, [sprintEngineState])

 useEffect(() => {
 if (recentlyMovedTaskIds.size === 0) return
 const handle = window.setTimeout(() => setRecentlyMovedTaskIds(new Set()), 700)
 return () => window.clearTimeout(handle)
 }, [recentlyMovedTaskIds])

 // Close the docked task-detail inspector with Escape from non-kanban
 // surfaces. The Kanban layout owns its own Escape handler scoped to the
 // board grid; everywhere else this global listener restores focus.
 // Two-stage: collapse an expanded inspector first, close on a second press.
 const tasksKanbanActive = effectiveView === 'tasks' && effectiveTasksLayout === 'kanban'
 useEffect(() => {
 if (!selectedTaskId || tasksKanbanActive) return
 const onKeyDown = (event: KeyboardEvent) => {
 if (event.key !== 'Escape') return
 if (isEditableTarget(event.target)) return
 event.preventDefault()
 if (inspectorExpanded) {
 setInspectorExpanded(false)
 return
 }
 setSelectedTaskId(null)
 }
 window.addEventListener('keydown', onKeyDown)
 return () => window.removeEventListener('keydown', onKeyDown)
 }, [selectedTaskId, tasksKanbanActive, inspectorExpanded])

 const handleKanbanKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (!tasksKanbanActive) return
 if (isEditableTarget(event.target)) return
 if (event.metaKey || event.ctrlKey || event.altKey) return

 if (event.key === 'Escape') {
 if (inspectorExpanded) {
 event.preventDefault()
 setInspectorExpanded(false)
 return
 }
 if (selectedTaskId !== null) {
 event.preventDefault()
 setSelectedTaskId(null)
 }
 return
 }

 const navKeys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'j', 'k', 'h', 'l']
 if (!navKeys.includes(event.key)) return
 event.preventDefault()
 if (boardColumns.length === 0) return

 const currentColumnIdx = selectedTaskId
 ? boardColumns.findIndex((column) => column.cards.some((card) => card.id === selectedTaskId))
 : -1
 const currentCards = currentColumnIdx >= 0 ? boardColumns[currentColumnIdx].cards : []
 const currentCardIdx = selectedTaskId
 ? currentCards.findIndex((card) => card.id === selectedTaskId)
 : -1

 const goVertical = (delta: number) => {
 if (currentColumnIdx < 0 || currentCards.length === 0) {
 for (const column of boardColumns) {
 if (column.cards.length > 0) {
 setSelectedTaskId(column.cards[0].id)
 return
 }
 }
 return
 }
 const next = currentCardIdx + delta
 if (next >= 0 && next < currentCards.length) {
 setSelectedTaskId(currentCards[next].id)
 }
 }

 const goHorizontal = (delta: number) => {
 const startColumn = currentColumnIdx >= 0 ? currentColumnIdx : 0
 for (let i = startColumn + delta; i >= 0 && i < boardColumns.length; i += delta) {
 const cards = boardColumns[i].cards
 if (cards.length > 0) {
 const fallbackIdx = currentCardIdx >= 0 ? currentCardIdx : 0
 const targetIdx = Math.min(Math.max(fallbackIdx, 0), cards.length - 1)
 setSelectedTaskId(cards[targetIdx].id)
 return
 }
 }
 }

 if (event.key === 'ArrowDown' || event.key === 'j') goVertical(1)
 else if (event.key === 'ArrowUp' || event.key === 'k') goVertical(-1)
 else if (event.key === 'ArrowRight' || event.key === 'l') goHorizontal(1)
 else if (event.key === 'ArrowLeft' || event.key === 'h') goHorizontal(-1)
 },
 [boardColumns, tasksKanbanActive, selectedTaskId, inspectorExpanded]
 )

 const selectedTask = sprintEngineState?.tasks.find((task) => task.id === selectedTaskId) ?? null

 // Per-task token usage for the inspector's details list, computed main-side
 // from the run's durable token ledger + projection. Fetched only while a task
 // is actually inspected (the shared hook clears across run switches and the
 // main process caches, so projection ticks stay cheap); a failed read renders
 // no figure.
 const tokenUsageReport = useSprintEngineTokenUsage(
   sprintEngineContext?.statePath ?? null,
   sprintEngineState?.updatedAt ?? null,
   Boolean(selectedTaskId),
 )
 const selectedTaskTokenUsage = selectedTask
   ? tokenUsageReport?.perTask[selectedTask.id] ?? null
   : null

 const doneCount = sprintEngineState.tasks.filter((task) => task.status === 'done').length
 const runPhase = getSprintEngineBoardRunPhase(sprintEngineState, runtimeAgents)
 const allTasksDone = sprintEngineState.tasks.length > 0 && doneCount === sprintEngineState.tasks.length
 const runSummary = buildRunSummary(sprintEngineState.tasks)
 const totalTasks = sprintEngineState.tasks.length
 const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0
 // Keep the header PR chip's merge state fresh while the run is open on any tab.
 // Probe the RUN, not its primary project: one `vcs pr-status` refreshes every
 // project, so the run is worth a probe while ANY project's pull request is still
 // non-terminal — the same question the background supervisor asks. Reading the
 // primary's state here stopped the on-open probe the moment the desktop pull
 // request merged, so a sibling project's chip stayed stale until the supervisor's
 // next backoff tick (up to 32 min) even though the user just opened the board.
 useRunPullRequestMergePoll({
   workspaceId,
   statePath: sprintEngineContext?.statePath ?? null,
   hasVcs: !!sprintEngineState.vcs,
   prState: isRunPullRequestWatchable(sprintEngineState.vcs) ? 'open' : 'merged',
   shouldPoll: allTasksDone || (sprintEngineState.vcs?.repos ?? []).some((repo) => !!repo.pullRequestUrl),
 })
 // The run's lifecycle as the shared shape-coded glyph — the same rollup the
 // Backlog rows and workspace sidebar render, so the board hero speaks one
 // run-status vocabulary with the rest of the app (Ready for review, Changes
 // requested, In progress, Complete…). The 6 px dot is the "live right now"
 // idiom and reads wrong for a finished run; this glyph carries the lifecycle,
 // animating only when a runner is genuinely live.
 const runGlyph = deriveSprintEngineRunGlyph({
   sprintEngineState,
   autoState: workspace?.sprintEngineAutoState,
 })
 // The run-config chip's label tracks the run's real end-state once complete: a
 // merged worktree run reads "Merged", a done-but-unmerged one "Ready for review";
 // otherwise it shows the automation runtime state (Running / Paused / Complete…).
 // A run spanning projects is "Merged" only once EVERY project's pull request has
 // landed, so this reads the same rollup the run glyph does rather than the primary
 // project's state alone.
 const mergeRollup = deriveSprintEngineRepoMergeRollup(sprintEngineState.vcs)
 const runConfigLabel =
   automationRuntimeState === 'complete'
     ? mergeRollup?.allMerged
       ? 'Merged'
       : mergeRollup
         ? 'Ready for review'
         : 'Complete'
     : sprintEngineAutomationRuntimeLabels[automationRuntimeState]
 const projectionUnavailable = sprintEngineState.projection?.source === 'unavailable'
 const projectionErrorMessage = sprintEngineState.projection?.errorMessage
 const lockWarnings = sprintEngineState.locks?.warnings ?? []
 const hasProjectionBanner = projectionUnavailable || Boolean(projectionErrorMessage) || lockWarnings.length > 0
 const architectAgentId = roster.find((agent) => agent.role === 'architect')?.id ?? null
 // Bundled worker roles ship dedicated role-task launch buttons. Custom
 // registry roles do not yet, so they always defer to the generic focus
 // agent action below.
 const workerRoles: SprintEngineRole[] = ['developer', 'frontend', 'product', 'performance', 'production_readiness_reviewer', 'cross_platform', 'tester', 'security']
 const roleTaskLaunches = workerRoles.flatMap((role) => {
 const activeTask = sprintEngineState.tasks.find((task) =>
 task.role === role && (task.status === 'in_progress' || task.status === 'review' || task.status === 'needs_input')
 )
 const readyTask = readyTasks.find((task) => task.role === role && !task.ownerAgentId)
 const task = activeTask ?? readyTask
 if (!task) return []

 const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
 const agent = ownerAgent ?? roster.find((candidate) =>
 candidate.role === role && runtimeAgentById[candidate.id]?.status !== 'done'
 )
 return [{ role, task, agent }]
 })
 const roleTaskLaunchSet = new Set<SprintEngineRoleId>(roleTaskLaunches.map(({ role }) => role))
 const specialistReviewAgents = roster.filter((agent) => agent.role !== 'architect')
 // Installed agent CLI catalog (bundled + user plugins), replacing the old
 // hardcoded Codex/Claude pair so user-installed CLIs are spawnable here too.
 const cliOptions = useMemo(() => {
   const catalog = selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
     map: cliAvailability,
     status: cliAvailabilityStatus,
   })
   return catalog.map((option) => ({
     ...option,
     description: option.source === 'user' ? 'User-installed agent CLI' : 'Agent CLI plugin',
   }))
 }, [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus])
 const selectedRecoveryCliOption =
 cliOptions.find((option) => option.value === recoveryDialog?.cli) ?? cliOptions[0]
 const hasPlannedTasks = sprintEngineState.tasks.length > 0
 const relinkFolder = async () => {
 const dir = await window.api.openDir()
 if (dir) setFolderPath(workspaceId, dir)
 }
 const refreshSprintEngineState = async () => {
 if (!folderPath || manualRefreshBusy) return

 setManualRefreshBusy(true)
 setSyncState({ status: 'syncing', message: 'Refreshing sprint state...' })
 try {
 const result = await refreshSprintEngineWorkspaceProjection({
 workspace,
 tokens: new Map(),
 cause: 'manual',
 force: true,
 })
 if (result.status === 'skipped') throw new Error('No workspace folder is ready.')
 if (result.status === 'error') throw new Error(result.message)
 const parsed = result.state
 if (!parsed) throw new Error('Sprint projection was unavailable.')
 setSyncState({
 status: 'live',
 message: `Refreshed ${parsed.tasks.length} tasks from projection.json`,
 })
 } catch (error) {
 setSyncState({
 status: 'error',
 message: error instanceof Error ? error.message : 'Failed to refresh sprint state.',
 })
 } finally {
 setManualRefreshBusy(false)
 }
 }

 // A run can be canceled while it is live — not once it has reached a terminal
 // state. Cancellation is a lifecycle decision distinct from completion.
 const sprintRunCanceled = isCanceledSprintEngineRun(sprintEngineState)
 const canCancelSprint =
 !sprintRunCanceled && !isCompletedSprintEngineRun(sprintEngineState)

 // Cancel the sprint: run the engine cancel op (run/tasks → canceled, agents
 // torn down) then force a refresh so the board, glyph, and backlog link settle
 // on the canceled state. The op owns the state write; a failure surfaces in the
 // sync banner rather than silently leaving a half-canceled run.
 const cancelSprint = async () => {
 const statePath = sprintEngineContext?.statePath
 if (!statePath || cancelSprintBusy) return
 setCancelSprintBusy(true)
 setSyncState({ status: 'syncing', message: 'Canceling sprint...' })
 try {
 const result = await window.api.cancelSprintEngineRun({ statePath })
 if (!result.ok) throw new Error(result.message ?? 'Canceling the sprint failed.')
 await refreshSprintEngineState()
 } catch (error) {
 setSyncState({
 status: 'error',
 message: error instanceof Error ? error.message : 'Failed to cancel the sprint.',
 })
 } finally {
 setCancelSprintBusy(false)
 }
 }

 const {
 openArtifact,
 popOutPreviewedArtifact,
 approveArtifact,
 requestArtifactChanges,
 cancelRequestArtifactChangesDialog,
 submitRequestArtifactChanges,
 resolveTaskInput,
 postTaskComment,
 } = useSprintEngineBoardArtifactActions({
 workspaceId,
 statePath: sprintEngineContext?.statePath,
 teamName: sprintEngineContext?.teamName,
 setArtifactActions,
 setTaskInputActions,
 setTaskCommentActions,
 setPreviewedArtifact,
 previewedArtifact,
 setRequestChangesDialog,
 requestChangesDialog,
 setSyncState,
 setSprintEngineState,
 openFile,
 refreshSprintEngineState,
 api: window.api,
 })

 // Artifact-preview annotate sink (MC-1468 T11, Sink A): a pin batch submitted
 // from the preview frame pre-fills the request-changes dialog with structured
 // blocks — never bypassing it, so the reviewer can still add overall framing —
 // and the feedback lands on the sprint record through the existing flow. The
 // batch counts as "sent" only when the dialog actually lands the change
 // request: cancelling settles the pending send as a failure, which hands the
 // notes back to the preview tray instead of dropping them.
 const previewAnnotationSendRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null)
 const settlePreviewAnnotationSend = (outcome: 'sent' | Error) => {
 const pending = previewAnnotationSendRef.current
 previewAnnotationSendRef.current = null
 if (!pending) return
 if (outcome === 'sent') pending.resolve()
 else pending.reject(outcome)
 }
 const cancelRequestChangesDialog = () => {
 if (requestChangesDialog?.submitting) return
 cancelRequestArtifactChangesDialog()
 settlePreviewAnnotationSend(new Error('The change request was cancelled.'))
 }
 const submitRequestChangesDialog = async () => {
 if (await submitRequestArtifactChanges()) settlePreviewAnnotationSend('sent')
 }
 const previewedReviewArtifact = previewedArtifact
 ? reviewArtifacts.find((artifact) => artifact.id === previewedArtifact.id) ?? null
 : null
 // Annotate is offered only while a change request can actually be filed —
 // the batch's one destination is the request-changes channel on the record.
 const submitPreviewAnnotations =
 previewedArtifact && previewedReviewArtifact?.status === 'ready_for_review'
 ? (annotations: MockupAnnotation[]) =>
 new Promise<void>((resolve, reject) => {
 const opened = requestArtifactChanges(
 previewedReviewArtifact,
 sprintAnnotationFeedback(previewedArtifact.relativePath, annotations),
 )
 if (!opened) {
 reject(new Error('This sprint workspace is missing its selected team context.'))
 return
 }
 previewAnnotationSendRef.current = { resolve, reject }
 })
 : undefined

 // Only the actionable "folder missing" state earns a banner. The transient
 // on-disk check that precedes it stays silent — the board area below renders
 // its normal idle state during the brief verification rather than flashing a
 // "Checking workspace folder…" message on every refresh.
 const folderStatusBanner = folderMissing && savedFolderPath ? (
 <div className="border-b border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-4 py-2 text-[12px] text-[color:var(--text-muted)]">
 <div className="flex flex-wrap items-center justify-between gap-3">
 <TruncatedText
 as="span"
 text={`Saved folder is missing: ${savedFolderPath}`}
 className="min-w-0"
 />
 <span className="flex shrink-0 items-center gap-2">
 <button
 onClick={() => void recheckFolder()}
 className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
 >
 Retry
 </button>
 <button
 onClick={() => void relinkFolder()}
 className="rounded-md bg-[color:var(--accent-primary-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--accent-primary)] interactive transition-colors hover:bg-[color:var(--accent-primary-soft)]"
 >
 Relink
 </button>
 </span>
 </div>
 </div>
 ) : null
 const showPlanningActions = !hasPlannedTasks
 const needsInputAgent = runtimeAgents.find((agent) => agent.status === 'needs_input')
 const runningAgent = runtimeAgents.find((agent) => agent.status === 'running')
 const focusAgent = needsInputAgent ?? runningAgent
 const focusAgentRoster = focusAgent ? rosterById[focusAgent.agentId] : undefined
 const focusAgentHasLiveTerminal = focusAgent ? isAgentTerminalLive(focusAgent.agentId) : false
 const focusAgentRole = focusAgentRoster?.role ?? focusAgent?.role ?? null
 const showFocusAgentAction = Boolean(focusAgent)
 && (!focusAgentRole || focusAgentRole === 'architect' || !roleTaskLaunchSet.has(focusAgentRole))
 const focusAgentLabel = focusAgent
 ? focusAgentHasLiveTerminal
 ? `Focus ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : ''
 const runFocusAgentAction = () => {
 if (!focusAgent || !showFocusAgentAction) return false
 if (focusAgentHasLiveTerminal) openAgentTerminal(focusAgent.agentId)
 else void spawnAgent(focusAgent.agentId)
 return true
 }
 const selectedTaskBoardColumn = selectedTask
 ? getSprintEngineTaskBoardColumn(selectedTask, sprintEngineState.tasks)
 : null
 const selectedTaskOwnerLabel = selectedTask ? getSprintEngineTaskOwnerLabel(selectedTask, rosterById) : ''
 const selectedTaskNeedsInputNote = selectedTask?.status === 'needs_input'
 ? 'This agent is waiting for input.'
 : null
 const selectedTaskArtifacts = selectedTask
 ? [...(artifactsByTaskId[selectedTask.id] ?? [])].sort((a, b) => {
 const timestampDelta = artifactTimestampMs(b) - artifactTimestampMs(a)
 if (timestampDelta !== 0) return timestampDelta
 return a.title.localeCompare(b.title)
 })
 : []
 const selectedTaskArtifactBlockers = selectedTask ? artifactBlockersByTaskId[selectedTask.id] ?? [] : []
 const inspectorSelectedAgent = selectedAgentId
 ? roster.find((entry) => entry.id === selectedAgentId) ?? null
 : null
 const inspectorSelectedArtifact = selectedArtifactId
 ? reviewArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null
 : null
 // Selection-to-inspector mapping is scoped by the active tab so a row
 // selected on one tab does not light up the right pane of another. The
 // artifact preview is the one exception: it's an in-place file preview the
 // inbox/tasks tab launches itself and always takes precedence over a stale
 // sibling selection.
 const inspectorSelection: SprintEngineInspectorSelection | null = (() => {
 if (previewedArtifact) {
 return { kind: 'artifact-preview', artifact: previewedArtifact }
 }
 if (effectiveView === 'inbox') {
 if (inspectorSelectedArtifact) return { kind: 'artifact', artifact: inspectorSelectedArtifact }
 if (selectedTask) return { kind: 'task', task: selectedTask }
 return null
 }
 if (effectiveView === 'roster') {
 if (inspectorSelectedAgent) return { kind: 'agent', agent: inspectorSelectedAgent }
 return null
 }
 // tasks (graph + kanban) and the summary drill-down all drive task detail.
 if (selectedTask) return { kind: 'task', task: selectedTask }
 return null
 })()
 const closeInspector = () => {
 setSelectedTaskId(null)
 setSelectedAgentId(null)
 setSelectedArtifactId(null)
 setPreviewedArtifact(null)
 setInspectorExpanded(false)
 }
 const toggleInspectorExpanded = () => {
 setInspectorExpanded((prev) => !prev)
 }
 // Expand state is meaningless when nothing is selected; reset it so a
 // future selection starts in the default (split) layout.
 useEffect(() => {
 if (!inspectorSelection && inspectorExpanded) setInspectorExpanded(false)
 }, [inspectorSelection, inspectorExpanded])
 // Inspector body, sans wrapper chrome. The project view embeds this in
 // the focal center slot when something is selected; task-graph and kanban
 // views keep the right-side aside via renderInspectorAside().
 const renderInspectorPanel = () => inspectorSelection ? (
 <SprintEngineInspectorPanel
 selection={inspectorSelection}
 sprintEngineState={sprintEngineState}
 runtimeAgents={runtimeAgents}
 agents={agents}
 tasksById={tasksById}
 selectedTaskBoardColumn={selectedTaskBoardColumn}
 selectedTaskOwnerLabel={selectedTaskOwnerLabel}
 selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
 selectedTaskTokenUsage={selectedTaskTokenUsage}
 selectedTaskArtifacts={selectedTaskArtifacts}
 selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
 artifactActions={artifactActions}
 taskInputActions={taskInputActions}
 taskCommentActions={taskCommentActions}
 onClose={closeInspector}
 onSelectTask={setSelectedTaskId}
 onOpenArtifact={openArtifact}
 onApproveArtifact={approveArtifact}
 onRequestArtifactChanges={requestArtifactChanges}
 onSubmitPreviewAnnotations={submitPreviewAnnotations}
 onResolveTaskInput={resolveTaskInput}
 onPostTaskComment={postTaskComment}
 onBackFromArtifact={() => setPreviewedArtifact(null)}
 onPopOutArtifact={popOutPreviewedArtifact}
 onSpawnAgent={spawnAgent}
 onOpenAgentTerminal={openAgentTerminal}
 isAgentTerminalLive={isAgentTerminalLive}
 isExpanded={inspectorExpanded}
 onToggleExpand={toggleInspectorExpanded}
 />
 ) : null
 const renderInspectorAside = () => {
 const panel = renderInspectorPanel()
 if (!panel) return null
 return (
 <SidePane
 side="right"
 width="md"
 expanded={inspectorExpanded}
 ariaLabel="Sprint inspector"
 widthPx={inspectorWidthPx}
 onResizeWidth={(px) => {
 const next = clampInspectorPaneWidth(px)
 setInspectorWidthPx(next)
 // Persist debounced: onResizeWidth fires per animation frame during a
 // drag, and a synchronous localStorage write per frame stutters it.
 if (inspectorWidthSaveTimer.current !== null) window.clearTimeout(inspectorWidthSaveTimer.current)
 inspectorWidthSaveTimer.current = window.setTimeout(() => saveInspectorPaneWidth(next), 250)
 }}
 onResizeReset={() => {
 if (inspectorWidthSaveTimer.current !== null) window.clearTimeout(inspectorWidthSaveTimer.current)
 setInspectorWidthPx(null)
 saveInspectorPaneWidth(null)
 }}
 resizeLabel="Resize inspector"
 >
 {panel}
 </SidePane>
 )
 }
  const updateAutomationMode = (nextMode: SprintEngineAutomationMode) => {
  if (nextMode === automationMode) return
  const previousMode = automationMode
 setPendingAutomationMode(nextMode)
 if (nextMode === 'manual') {
  applySprintEngineAutomationStopReason(workspaceId, 'user_manual_toggle')
 } else {
  setSprintEngineAutomationMode(workspaceId, nextMode)
 }
 if (!sprintEngineContext?.statePath) {
 if (nextMode !== 'manual') {
 setSprintEngineAutomationMode(workspaceId, previousMode)
 }
 setPendingAutomationMode(null)
 return
 }
 void (async () => {
 const stateFileExists = await window.api.pathExists(sprintEngineContext.statePath).catch(() => false)
 if (!stateFileExists) {
 if (nextMode !== 'manual') {
 setSprintEngineAutomationMode(workspaceId, previousMode)
 }
 setPendingAutomationMode(null)
 return
 }
 if (nextMode !== 'manual') {
 publishSprintEngineAutomationModeNotification({
 workspaceId,
 workspaceName: workspace?.name,
 mode: nextMode,
 })
 }
 // The cliWatchPolling bridge to run.yaml is main's job now: the store
 // action pushed the mode through `sprintengine:automation:set-mode`
 // (MC-1567), and that one write path persists the intent and syncs the
 // headless-CLI hint. Nothing left to await here.
 setPendingAutomationMode(null)
 })().catch(() => {
 setPendingAutomationMode(null)
 })
  }

  // Deep-link from the run-configuration popover to the task the runtime
 // stopped on. The roster view is the only board view whose inspector cannot
 // show a task, so it hops to Tasks first; a pinned roster layout passes a
 // null handler instead so the popover renders no dead link.
 const showAutomationRuntimeTask = (taskId: string) => {
 if (!fixedView && effectiveView === 'roster') setActiveView('tasks')
 setPreviewedArtifact(null)
 setSelectedArtifactId(null)
 setSelectedTaskId(taskId)
 }

 // Deep-link from a notification's Open action (see the Sprint Engine
 // notification-action provider). The shell reveals the workspace; this board
 // focuses the task. A target may arrive before this board mounted/subscribed,
 // so we drain the pending latch on mount AND handle the live event — refreshed
 // through a ref so re-renders don't churn the window listener. A target naming
 // a task that isn't in this run is ignored rather than clearing the selection.
 const revealTargetHandlerRef = useRef<(target: NotificationNavigationTarget) => void>(() => {})
 revealTargetHandlerRef.current = (target) => {
 if (target.kind !== 'task') return
 if (!sprintEngineState.tasks.some((task) => task.id === target.ref)) return
 showAutomationRuntimeTask(target.ref)
 }
 useEffect(() => {
 const pending = consumePendingRevealTarget(workspaceId)
 if (pending) revealTargetHandlerRef.current(pending)
 return subscribeRevealTarget((detail) => {
 if (detail.workspaceId !== workspaceId) return
 // Clear the latch so the mount-drain path can't re-fire the same target.
 consumePendingRevealTarget(workspaceId)
 revealTargetHandlerRef.current(detail.target)
 })
 }, [workspaceId])

 const resumeAutomation = automationRuntimeState === 'paused'
  || automationRuntimeState === 'blocked'
  || automationRuntimeState === 'failed'
  ? () => {
  applySprintEngineAutomationEvent(workspaceId, { type: 'runner_started' })
  // Same-mode recovery must also reach the main scheduler — a runtime-state
  // resume is not a mode change, so neither the intent service nor the
  // stop-reason push carries it. Without this the scheduler stays
  // paused/blocked forever while the UI shows "running".
  if (sprintEngineContext?.statePath) {
  void window.api.resumeSprintRuntimeRun?.({ statePath: sprintEngineContext.statePath })
  }
  }
  : null

  const updateCliPermissionPreset = async (preset: SprintEngineCliPermissionPreset) => {
 if (preset === 'bypass_all') {
 const confirmed = await dialog.confirm({
 title: 'Bypass CLI permissions?',
 body: 'Spawned sprint agents will run without CLI approval prompts. Use this only in repositories and environments you trust.',
 confirmLabel: 'Bypass permissions',
 tone: 'danger',
 })
 if (!confirmed) return
 }

 setSprintEngineCliPermissionPreset(workspaceId, preset)
 }

 const getAgentName = (agentId: string, fallback: string) => agents[agentId]?.name ?? fallback

 const getCustomAgentName = (agentId: string, fallback: string) => {
 const name = agents[agentId]?.name
 return name && name !== fallback ? name : ''
 }

 const enqueuePendingRosterMemberSpawn = (pending: PendingRosterMemberSpawn) => {
 setPendingRosterMemberSpawns((current) => {
 if (current.some((candidate) => candidate.agentId === pending.agentId)) return current
 return [...current, pending]
 })
 }

 const addMemberRoleDefaultCli = (role: SprintEngineRole): AgentCli =>
 workspace?.sprintEngineRoleCliDefaults?.[role] ?? lastSelectedCli

 const selectAddMemberRole = (role: SprintEngineRole) => {
 setAddMemberRole(role)
 setAddMemberCli(null)
 setAddMemberModel(undefined)
 }

 const openAddMemberDialog = () => {
 const uncoveredRole = findFirstUncoveredSprintEngineRole({
 registry: roleRegistry,
 disabledRoleIds,
 roster,
 tasks: sprintEngineTasks,
 })
 const initialRole = (uncoveredRole ?? 'developer') as SprintEngineRole
 setAddMemberName('')
 setAddMemberSpawnNow(true)
 setAddMemberBusy(false)
 setAddMemberError(null)
 selectAddMemberRole(initialRole)
 setAddMemberOpen(true)
 }

 // Plan-revision notification for a member that is already canonical: paste
 // into the live architect terminal, or start the architect with the prompt.
 // The architect only revises the plan — the roster mutation already happened.
 const notifyArchitectPlanRevision = async (agentId: string, role: SprintEngineRole) => {
 if (!architectAgentId || !sprintEngineContext) return
 const prompt = buildSprintEnginePlanRevisionForNewMemberPrompt({
 role,
 agentId,
 teamSlug: sprintEngineContext.teamSlug,
 registry: roleRegistry,
 })
 const liveArchitectSession = getLiveAgentTerminalSession(architectAgentId)
 if (liveArchitectSession) {
 await window.api.terminalWrite(liveArchitectSession.sessionId, bracketedTerminalPaste(prompt))
 return
 }
 const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
 const label = getAgentName(architectAgentId, fallbackLabel)
 await startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli, {
 freshSession: true,
 agentName: getCustomAgentName(architectAgentId, fallbackLabel),
 startupPrompt: prompt,
 })
 }

 const confirmAddMember = async (role = addMemberRole) => {
 const memberName = normalizeAgentIdentifier(addMemberName)
 const memberCli = addMemberCli ?? addMemberRoleDefaultCli(role)

 if (sprintEngineState.rosterConfigured) {
 if (!sprintEngineContext) return
 // Mint the display id against the canonical workers view when present
 // (MC-1593a), falling back to the bridge; there is no engine registration —
 // the engine binds the worker to a task at claim.
 const agentId = getNextSprintEngineAgentId(
 role,
 sprintEngineState.workers ?? sprintEngineState.sprintEngineAgents,
 )
 setAddMemberBusy(true)
 setAddMemberError(null)
 try {
 // A role the run does not yet configure must be enabled in the engine
 // first: configuredRoles is the run's whole legal role set, and join /
 // plan.add_task / roster runtime all hard-reject a non-configured role.
 // The user's own board action is the sanctioned writer (`roster enable`,
 // additive, --actor ui) — agents never grow the set themselves.
 const configuredRoles = sprintEngineState.configuredRoles ?? []
 const roleNeedsEnable = configuredRoles.length > 0 && !configuredRoles.includes(role)
 if (roleNeedsEnable) {
 const enabled = await window.api.enableSprintEngineRole({
 statePath: sprintEngineContext.statePath,
 role,
 cli: memberCli,
 model: addMemberModel ?? null,
 })
 if (!enabled.ok) {
 setAddMemberError(enabled.message || `The ${role} role could not be enabled for this run.`)
 return
 }
 }
 // MC-1591 leases: there is no roster to register into — the engine binds
 // the worker to its task at claim. Spawn on the minted id directly; the
 // pending-spawn effect starts the terminal without waiting for a
 // projection roster entry that only appears once the worker has claimed.
 enqueuePendingRosterMemberSpawn({
 agentId,
 role,
 name: memberName || undefined,
 cli: memberCli,
 model: addMemberModel ?? null,
 spawnNow: addMemberSpawnNow,
 })
 if (workspace) {
 void refreshSprintEngineWorkspaceProjection({
 workspace,
 tokens: new Map(),
 cause: 'manual',
 force: true,
 })
 }
 // Only ask the architect to revisit the plan when a genuinely new role
 // joins the run. Adding more members of a role the team already has is
 // reinforcement for existing task cards — it does not change the plan or
 // task graph, so it must not interrupt the architect.
 const roleIsNewToRun = isNewSprintEngineRoleForRun({
 role,
 roster,
 pendingRoles: pendingRosterMemberSpawns.map((pending) => pending.role),
 })
 if (hasPlannedTasks && roleIsNewToRun) {
 void notifyArchitectPlanRevision(agentId, role)
 }
 setAddMemberOpen(false)
 } finally {
 setAddMemberBusy(false)
 }
 return
 }

 const addedAgent = addSprintEngineMember(workspaceId, role)
 if (!addedAgent) return

 updateAgent(workspaceId, addedAgent.id, {
 ...(memberName ? { name: memberName } : {}),
 cli: memberCli,
 cliModel: addMemberModel,
 kind: 'sprintengine',
 })
 if (addMemberSpawnNow) {
 void startAgentTerminalWhenReady(addedAgent.id, memberName || addedAgent.label, memberCli, {
 agentName: memberName,
 cliModel: addMemberModel ?? null,
 })
 }
 setSelectedAgentId(addedAgent.id)
 setAddMemberOpen(false)
 }

 // "Add an agent" from the Agents header: raise the run's concurrent-agent
 // count (so the pool keeps this puller running) and mint + spawn one agent of
 // the chosen configured role now. Minting is local (no engine registration);
 // the engine binds the worker to a task at claim (MC-1591 leases).
 const addSprintEngineAgentForRole = (role: SprintEngineRole) => {
 // 3 is the store's canonical default (normalizeSprintEngineAutoState); the
 // ?? only fires before auto-state is first written for this workspace.
 const currentMax = workspace?.sprintEngineAutoState?.maxConcurrentAgents ?? 3
 setSprintEngineMaxConcurrentAgents(workspaceId, currentMax + 1)
 void confirmAddMember(role)
 }

 const {
 startAgentTerminalWhenReady,
 openAgentTerminal,
 stopAgentTerminal,
 restartAgentTerminal,
 spawnAgent,
 willResumeAgent,
 openRecoveryDialog,
 confirmRecoveryAudit,
 requestPlanReviews,
 addressPlanReviews,
 } = useSprintEngineBoardTerminalActions({
 workspaceId,
 workspace,
 agents,
 sprintEngineState,
 pluginCatalogEntries,
 rosterById,
 architectAgentId,
 specialistReviewAgents,
 savedFolderPath,
 folderPath,
 folderStatusMessage,
 folderCheckedPath,
 lastSelectedCli,
 recoveryDialog,
 updateAgent,
 recheckFolder,
 setSelectedAgentId,
 setCliPickerOpen,
 setRecoveryDialog,
 getAgentName,
 getCustomAgentName,
 getLiveAgentTerminalSession,
 })

 // The CLI a member is configured to launch with: its own saved CLI, else the
 // role's default, else the last-used CLI. Drives the roster row's right-click
 // runtime picker, which shares the spawn dialog's CLI/model semantics.
 const agentRuntimeCli = (agentId: string): AgentCli => {
   const agent = agents[agentId]
   if (agent?.cli) return agent.cli
   // Roster roles are the open SprintEngineRoleId space; the default lookup
   // keys on bundled roles and falls back for anything unknown.
   const role = rosterById[agentId]?.role as SprintEngineRole | undefined
   return role ? addMemberRoleDefaultCli(role) : lastSelectedCli
 }

 // Current model for a given CLI in the picker: the member's configured model
 // only when the CLI matches its runtime. Otherwise there is no model flag.
 const effectiveModelForAgent = (agentId: string, cli: AgentCli): string | undefined =>
   cli === agentRuntimeCli(agentId) ? agents[agentId]?.cliModel : undefined

 // Persist a runtime choice onto the member record (applied on next launch,
 // and immediately reflected in the row's CLI summary). Picking a bare CLI
 // clears any explicit model so the CLI's own default is used. The choice is
 // also recorded as an explicit `cliRuntimeOverride` so the per-role
 // `roleRuntimes` reconcile (MC-1450) honors it instead of reverting it on
 // the next projection tick — `model: null` pins the CLI default even for a
 // role whose config names a model.
 const selectAgentCli = (agentId: string, cli: AgentCli) => {
   updateAgent(workspaceId, agentId, { cli, cliModel: undefined, cliRuntimeOverride: { cli, model: null } })
 }
 const selectAgentModel = (agentId: string, cli: AgentCli, model: string | null) => {
   updateAgent(workspaceId, agentId, { cli, cliModel: model ?? undefined, cliRuntimeOverride: { cli, model } })
 }

 // Role-level runtime, read from the run's canonical roleRuntimes projection.
 // A role with no configured entry reads as its default CLI on that CLI's own
 // default model (no --model flag), matching what a spawn would launch.
 const roleRuntimeCli = (role: SprintEngineRoleId): AgentCli => {
   const configured = sprintEngineState.roleRuntimes?.[role]?.cli
   if (typeof configured === 'string' && configured.trim()) return configured.trim() as AgentCli
   return addMemberRoleDefaultCli(role as SprintEngineRole)
 }
 const roleRuntimeModel = (role: SprintEngineRoleId, cli: AgentCli): string | undefined => {
   if (cli !== roleRuntimeCli(role)) return undefined
   const model = sprintEngineState.roleRuntimes?.[role]?.model
   return typeof model === 'string' && model.trim() ? model.trim() : undefined
 }

 // Mid-run role runtime edit (MC-1516): one canonical mutation through the
 // operator-actor engine verb (roster runtime --actor ui). Role edit wins —
 // on success this role's per-agent overrides are cleared and the new runtime
 // is stamped locally so rows update ahead of the projection tick; running
 // sessions keep their launched runtime until they next start (rows surface
 // the divergence and an idle restart offer). Legacy runs without a canonical
 // state path keep the per-agent picker only.
 const applyRoleRuntimeEdit = async (role: SprintEngineRoleId, cli: AgentCli, model: string | null) => {
   if (!sprintEngineContext) return
   const result = await window.api.setSprintEngineRoleRuntime({
     statePath: sprintEngineContext.statePath,
     role,
     cli,
     model,
   })
   if (!result.ok) {
     void publishDiagnostic({
       level: 'error',
       source: 'terminal',
       title: 'Role model was not changed',
       message: result.message,
       details: [
         `Workspace ID: ${workspaceId}`,
         `Role: ${role}`,
         `Runtime: ${cli}${model ? ` · ${model}` : ''}`,
       ].join('\n'),
       workspaceId,
       workspaceName: workspace?.name,
     })
     return
   }
   for (const item of roster) {
     if (item.role !== role) continue
     updateAgent(workspaceId, item.id, { cli, cliModel: model ?? undefined, cliRuntimeOverride: undefined })
   }
   if (workspace) {
     void refreshSprintEngineWorkspaceProjection({
       workspace,
       tokens: new Map(),
       cause: 'manual',
       force: true,
     })
   }
 }
 const selectRoleCli = (role: SprintEngineRoleId, cli: AgentCli) => {
   void applyRoleRuntimeEdit(role, cli, null)
 }
 const selectRoleModel = (role: SprintEngineRoleId, cli: AgentCli, model: string | null) => {
   void applyRoleRuntimeEdit(role, cli, model)
 }

 // Kill = stop the app-owned terminal process and release Sprint Engine
 // claims (main-process teardown sends agent.leave). The role stays configured
 // on the run, and says so.
 const killAgentTerminal = async (agentId: string) => {
 const fallbackLabel = rosterById[agentId]?.label ?? agentId
 const label = getAgentName(agentId, fallbackLabel)
 const runtime = runtimeAgents.find((entry) => entry.agentId === agentId)
 const ownedTask = runtime?.currentTaskId
 ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
 : null
 const confirmed = await dialog.confirm({
 title: `Kill ${label}'s terminal?`,
 body: ownedTask
 ? `${label} is working on ${ownedTask.id} · ${ownedTask.title}. Killing the terminal releases the claim so the work can be picked up again. The role stays on the team.`
 : `${label}'s terminal process will be stopped and its sprint claims released. The role stays on the team.`,
 confirmLabel: 'Kill terminal',
 tone: 'danger',
 })
 if (!confirmed) return
 await stopAgentTerminal(agentId)
 }

 useEffect(() => {
 if (pendingRosterMemberSpawns.length === 0) return

 for (const pending of pendingRosterMemberSpawns) {
 // MC-1591 leases: a minted worker only appears in the projection roster
 // once it has claimed, so we can no longer wait for a canonical roster entry
 // before starting it. The pending record is the source of truth for the
 // member's role and runtime; spawn on the minted id and let the engine bind
 // it to a task at claim. `rosterAgent`, when present, only supplies a label.
 const rosterAgent = rosterById[pending.agentId]

 if (!pending.spawnNow) {
 // Member confirmed but the user did not ask for an immediate start:
 // record the chosen runtime on the reconciled agent and finish.
 updateAgent(workspaceId, pending.agentId, {
 ...(pending.name ? { name: pending.name } : {}),
 ...(pending.cli ? { cli: pending.cli } : {}),
 ...(pending.model !== undefined ? { cliModel: pending.model ?? undefined } : {}),
 kind: 'sprintengine',
 })
 setSelectedAgentId(pending.agentId)
 setPendingRosterMemberSpawns((current) => current.filter((candidate) => candidate.agentId !== pending.agentId))
 continue
 }
 if (getLiveAgentTerminalSession(pending.agentId)) {
 setPendingRosterMemberSpawns((current) => current.filter((candidate) => candidate.agentId !== pending.agentId))
 continue
 }
 if (pendingRosterMemberSpawnInFlightRef.current.has(pending.agentId)) continue

 pendingRosterMemberSpawnInFlightRef.current.add(pending.agentId)
 const label = pending.name || getAgentName(pending.agentId, rosterAgent?.label ?? pending.agentId)
 void startAgentTerminalWhenReady(
 pending.agentId,
 label,
 pending.cli ?? agents[pending.agentId]?.cli,
 {
 ...(pending.name ? { agentName: pending.name } : {}),
 ...(pending.model !== undefined ? { cliModel: pending.model } : {}),
 // Automatic respawn: dock the tab without stealing focus from the board.
 reveal: 'background',
 },
 ).then((started) => {
 if (!started) return
 setSelectedAgentId(pending.agentId)
 setPendingRosterMemberSpawns((current) => current.filter((candidate) => candidate.agentId !== pending.agentId))
 }).finally(() => {
 pendingRosterMemberSpawnInFlightRef.current.delete(pending.agentId)
 })
 }
 }, [
 agents,
 getAgentName,
 getLiveAgentTerminalSession,
 pendingRosterMemberSpawns,
 rosterById,
 startAgentTerminalWhenReady,
 updateAgent,
 workspaceId,
 ])

 // New-workspace "Start now" intent: launch only agents that can safely enter
 // the initialized run. The architect may start as the bootstrap/orchestration
 // role; other roles wait until the real projection has claimable work for
 // that role, so an eager roster selection cannot join an empty/uninitialized
 // store and fail before planning has created tasks.
 const hasInitialSpawnIntent = Boolean(workspace.sprintEngineInitialSpawnAgentIds?.length)
 useEffect(() => {
 if (!hasInitialSpawnIntent) return
 const readyAgentIds = (workspace.sprintEngineInitialSpawnAgentIds ?? []).filter((agentId) => {
 const rosterAgent = rosterById[agentId]
 if (getLiveAgentTerminalSession(agentId)) return true
 if (!rosterAgent) return false
 if (rosterAgent.role === 'architect') return true
 return canLaunchSprintEngineInitialSpawn(rosterAgent.role, sprintEngineState)
 })
 if (readyAgentIds.length === 0) return
 const agentIds = consumeSprintEngineInitialSpawns(workspaceId, readyAgentIds)
 for (const agentId of agentIds) {
 if (getLiveAgentTerminalSession(agentId)) continue
 const label = getAgentName(agentId, rosterById[agentId]?.label ?? agentId)
 // Initial spawn on Sprint Engine start: dock each tab in the background so a
 // multi-agent launch never pulls focus off the board.
 void startAgentTerminalWhenReady(agentId, label, agents[agentId]?.cli, { reveal: 'background' })
 }
 }, [
 agents,
 consumeSprintEngineInitialSpawns,
 getAgentName,
 getLiveAgentTerminalSession,
 hasInitialSpawnIntent,
 rosterById,
 startAgentTerminalWhenReady,
 sprintEngineState,
 workspace.sprintEngineInitialSpawnAgentIds,
 workspaceId,
 ])

 const chromeOverflowItems: OverflowMenuItem[] = (() => {
 const items: OverflowMenuItem[] = []
 items.push({
 id: 'refresh',
 label: 'Refresh board',
 onSelect: () => void refreshSprintEngineState(),
 shortcut: shortcutFor('sprintengine.refresh.board'),
 disabled: !folderPath || manualRefreshBusy,
 })
 if (focusAgent && showFocusAgentAction) {
 items.push({
 id: 'focus-agent',
 label: focusAgentLabel,
 onSelect: runFocusAgentAction,
 })
 }
 items.push({ kind: 'separator', id: 'sep-1' })
 if (architectAgentId) {
 items.push({
 id: 'verify-progress',
 label: 'Verify progress',
 onSelect: openRecoveryDialog,
 })
 }
 items.push({
 id: 'more-roles',
 label: 'More roles',
 onSelect: openAddMemberDialog,
 })
 if (showPlanningActions) {
 items.push({
 id: 'request-plan-reviews',
 label: 'Request plan reviews',
 onSelect: requestPlanReviews,
 disabled: !folderPath || specialistReviewAgents.length === 0,
 })
 if (architectAgentId) {
 items.push({
 id: 'address-feedback',
 label: 'Address feedback',
 onSelect: addressPlanReviews,
 disabled: !folderPath,
 })
 }
 }
 items.push({ kind: 'separator', id: 'sep-2' })
 items.push({
 id: 'read-plan',
 label: 'Read plan',
 onSelect: () => focusOrAddComponentTab(workspaceId, 'sprintengine-plan-reader', 'Architect Plan'),
 })
 if (canCancelSprint) {
 items.push({ kind: 'separator', id: 'sep-3' })
 items.push({
 id: 'cancel-sprint',
 label: 'Cancel sprint…',
 destructive: true,
 onSelect: () => setConfirmCancelSprint(true),
 disabled: !folderPath || cancelSprintBusy,
 })
 }
 return items
 })()

 const chromeTabItems: TabItem<SprintEngineView>[] = [
 {
 id: 'inbox',
 label: 'Inbox',
 icon: SprintEngineInboxIcon,
 // A canceled run has no actionable review queue — mirror completion by
 // dropping the badge so it never disagrees with the suppressed inbox list.
 count: !sprintRunCanceled && inboxArtifactCount > 0 ? inboxArtifactCount : undefined,
 },
 {
 id: 'roster',
 label: 'Agents',
 icon: SprintEngineRosterNavIcon,
 count: roster.length > 0 ? roster.length : undefined,
 },
 {
 id: 'tasks',
 label: 'Tasks',
 icon: SprintEngineTasksNavIcon,
 count: sprintEngineState.tasks.length > 0 ? sprintEngineState.tasks.length : undefined,
 },
 // The run summary lives as a view that only appears once the run is complete.
 ...(allTasksDone
 ? [{ id: 'summary' as const, label: 'Summary', icon: SprintEngineSummaryNavIcon }]
 : []),
 ]
 const activateView = (view: SprintEngineView) => {
 if (fixedView) return
 setActiveView(view)
 }

 // Listen for CommandPalette dispatches and the cross-cutting ⌘ , chord so the
 // palette and the panel-local overflow/settings popover route through the
 // same handlers. Listeners are registered once with a latest-handler ref so
 // normal re-renders don't churn global window listeners; the ref is refreshed
 // synchronously each render with the live closures it needs to dispatch.
 const commandHandlerRef = useRef<(detail: { id: unknown }) => void>(() => {})
 commandHandlerRef.current = (detail) => {
 if (!detail || typeof detail.id !== 'string') return
 switch (detail.id) {
 case 'sprintengine.verify.progress':
 if (architectAgentId) {
 openRecoveryDialog()
 } else {
 publishDiagnosticSync({
 level: 'info',
 source: 'sprintengine',
 title: 'Verify progress is unavailable',
 message: 'No architect agent is running yet. Spawn the architect to verify progress.',
 workspaceId,
 workspaceName: workspace?.name,
 })
 }
 break
 case 'sprintengine.add.role':
 openAddMemberDialog()
 break
 case 'sprintengine.request.plan-reviews':
 requestPlanReviews()
 break
 case 'sprintengine.address.feedback':
 addressPlanReviews()
 break
 case 'sprintengine.read.plan':
 focusOrAddComponentTab(workspaceId, 'sprintengine-plan-reader', 'Architect Plan')
 break
 case 'sprintengine.focus.agent':
 if (!runFocusAgentAction()) {
 publishDiagnosticSync({
 level: 'info',
 source: 'sprintengine',
 title: 'Focus active agent is unavailable',
 message: focusAgent
 ? `The ${getSprintEngineRoleLabel(focusAgent.role)} agent already has a role-task launch on the panel; use that instead.`
 : 'No agent is currently running or waiting for input.',
 workspaceId,
 workspaceName: workspace?.name,
 agentId: focusAgent?.agentId,
 })
 }
 break
 case 'sprintengine.refresh.board':
 if (folderPath && !manualRefreshBusy) void refreshSprintEngineState()
 break
 case 'sprintengine.goto.inbox':
 if (!fixedView) setActiveView('inbox')
 break
 case 'sprintengine.goto.roster':
 if (!fixedView) setActiveView('roster')
 break
 case 'sprintengine.goto.tasks':
 if (!fixedView) setActiveView('tasks')
 break
 case 'sprintengine.goto.graph':
 if (!fixedView) setActiveView('tasks')
 if (!fixedTasksLayout) setActiveTasksLayout('graph')
 break
 case 'sprintengine.goto.kanban':
 if (!fixedView) setActiveView('tasks')
 if (!fixedTasksLayout) setActiveTasksLayout('kanban')
 break
 case 'sprintengine.open.settings':
 case 'open.settings':
 setSettingsOpen(true)
 break
 }
 }
 useEffect(() => {
 const onCommand = (event: Event) => {
 commandHandlerRef.current((event as CustomEvent).detail)
 }
 window.addEventListener('multicode:panel-command', onCommand)
 return () => {
 window.removeEventListener('multicode:panel-command', onCommand)
 }
 }, [])

 const tasksLayoutToggle = effectiveView === 'tasks' && !fixedTasksLayout ? (
 <div
 role="group"
 aria-label="Tasks layout"
 className="inline-flex shrink-0 items-center gap-0.5 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-0.5"
 >
 {(['graph', 'kanban'] as SprintEngineTasksLayout[]).map((layout) => {
 const active = effectiveTasksLayout === layout
 const label = layout === 'graph' ? 'Graph' : 'Board'
 return (
 <button
 key={layout}
 type="button"
 aria-pressed={active}
 onClick={() => setActiveTasksLayout(layout)}
 className={`interactive rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
 active
 ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]'
 }`}
 >
 {label}
 </button>
 )
 })}
 </div>
 ) : null

 // Unified board chrome: the app shell already names the workspace immediately
 // above this panel, so this row only carries view navigation, task layout,
 // compact run state, and the shared overflow/settings menu.
 const runHero = (
 <header className="relative shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
 <div className="flex min-h-10 items-center justify-between gap-2 pr-3">
 {/* Left: view tabs + the Tasks layout switcher. Keeping the switcher here
     (rather than in the right cluster) holds the run-state cluster — count,
     automation, overflow — in a fixed position across tabs, so switching to
     Tasks no longer shoves those controls sideways. `flex-1 min-w-0` plus
     horizontal scroll gives the tab strip a bounded box, so on a narrow window
     it scrolls within its lane instead of spilling over the run-state cluster. */}
 <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
 {!fixedView ? (
 <Tabs<SprintEngineView>
 ariaLabel="Sprint view"
 items={chromeTabItems}
 value={effectiveView}
 onChange={activateView}
 idPrefix="sprintengine-view"
 className="px-3"
 borderless
 />
 ) : (
 <span className="sr-only">{sprintEngineState.name}</span>
 )}
 {tasksLayoutToggle}
 </div>
 <div className="flex min-w-0 shrink-0 items-center gap-2">
 {runGlyph ? (
 <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={`Run: ${runGlyph.label}`} />
 ) : null}
  <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
  {doneCount}/{totalTasks}
  </span>
  <RunPullRequestViewChip vcs={sprintEngineState.vcs} folderPath={folderPath} />
  <Popover
 open={settingsOpen}
 onOpenChange={setSettingsOpen}
 ariaLabel="Sprint run configuration"
 popupRole="dialog"
 placement="bottom-end"
 renderTrigger={({ ref, triggerProps, togglePopover }) => (
 <button
 ref={ref}
 type="button"
 aria-label={`Run configuration: ${runConfigLabel}`}
 aria-haspopup="dialog"
 aria-expanded={triggerProps['aria-expanded']}
 aria-controls={triggerProps['aria-controls']}
 onClick={togglePopover}
 className={`interactive flex h-6 max-w-[200px] shrink-0 items-center gap-1.5 rounded-[5px] px-1.5 text-[11px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
 settingsOpen
 ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
 }`}
 >
 {automationRuntimeState === 'running' ? (
 <Spinner size={14} />
 ) : automationRuntimeGlyph ? (
 <LifecycleGlyph state={automationRuntimeGlyph} />
 ) : null}
 <span className="truncate">{runConfigLabel}</span>
 <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 12 12" fill="none" aria-hidden="true">
 <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )}
 >
  <SprintEngineSettingsPopover
  automationMode={automationMode}
  runtimeState={automationRuntimeState}
  runtimeReason={automationRuntimeReason}
  runtimeTask={automationRuntimeTask}
  cliPermissionPreset={cliPermissionPreset}
  onChangeAutomationMode={updateAutomationMode}
  onResumeAutomation={resumeAutomation}
  onOpenRuntimeTask={fixedView === 'roster' ? null : showAutomationRuntimeTask}
  onUpdateCliPreset={updateCliPermissionPreset}
 onClose={() => setSettingsOpen(false)}
 />
 </Popover>
 <OverflowMenu ariaLabel="Sprint overflow" items={chromeOverflowItems} />
 </div>
 </div>
 <div
 className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px]"
 role="progressbar"
 aria-valuemin={0}
 aria-valuemax={totalTasks}
 aria-valuenow={doneCount}
 aria-label={`${doneCount} of ${totalTasks} tasks done`}
 >
 <div
 className="absolute inset-y-0 left-0 bg-[color:var(--accent-primary)] transition-[width]"
 style={{ width: `${progressPct}%` }}
 />
 </div>
 </header>
 )

 const projectionBanner = hasProjectionBanner ? (
 <div
 role="status"
 className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12px] leading-5"
 >
 <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
 <span className="inline-flex items-center gap-1.5">
 <StatusDot tone={projectionUnavailable ? 'error' : 'warn'} />
 <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
 {projectionUnavailable ? 'Projection unavailable' : 'Projection warning'}
 </span>
 </span>
 {projectionErrorMessage ? (
 <span className="text-[color:var(--tone-error)] [overflow-wrap:anywhere]">
 {projectionErrorMessage}
 </span>
 ) : null}
 {lockWarnings.map((warning) => (
 <span key={warning.name} className="text-[color:var(--tone-warn)]">
 <span className="font-mono">{warning.name}</span>{' '}
 stale {formatSprintEngineLockAge(warning.ageSeconds)}
 </span>
 ))}
 </div>
 </div>
 ) : null

 // Visible freshness signal for the manual refresh lifecycle and the debug
 // auto-sync escape. The sr-only region above is the single screen-reader
 // channel, so this banner is decorative (`aria-hidden`) to avoid a duplicate
 // announcement. It stays quiet during the normal live/idle steady state.
 const boardFreshnessBanner = (() => {
 const isSyncing = syncState.status === 'syncing'
 const isError = syncState.status === 'error'
 if (!isSyncing && !isError && !MULTICODE_DISABLE_SPRINTENGINE_SYNC) return null
 const tone: Tone = isError ? 'error' : isSyncing ? 'accent' : 'warn'
 const heading = isError ? 'Refresh failed' : isSyncing ? 'Refreshing board' : 'Auto-sync off · debug'
 const detail = isError
 ? syncState.message
 : isSyncing
 ? null
 : 'Board updates only on manual refresh or agent actions.'
 return (
 <div
 aria-hidden="true"
 className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12px] leading-5"
 >
 <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
 <span className="inline-flex items-center gap-1.5">
 <StatusDot tone={tone} pulse={isSyncing} />
 <span className="text-[11px] text-[color:var(--text-muted)]">{heading}</span>
 </span>
 {detail ? (
 <span
 className={
 isError
 ? 'text-[color:var(--tone-error)] [overflow-wrap:anywhere]'
 : 'text-[color:var(--text-muted)]'
 }
 >
 {detail}
 </span>
 ) : null}
 </div>
 </div>
 )
 })()

 const runCompleteBanner = allTasksDone ? (
 <Section
 title="Run complete"
 level={3}
 className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
 >
 <div className="flex items-start justify-between gap-4">
 <div className="min-w-0">
 <div className="text-[12px] text-[color:var(--text-default)]">
 Review uncommitted workspace changes and manually test the feature.
 </div>
 <div className="mt-1 text-[11px] text-[color:var(--text-muted)]">
 {runSummary.touchedFiles.length} files touched · {runSummary.commandsRan.length} commands recorded · {runSummary.results.length} validation results
 </div>
 </div>
 <RunCompletePullRequestAction
 workspaceId={workspaceId}
 statePath={sprintEngineContext?.statePath ?? null}
 vcs={sprintEngineState.vcs}
 />
 </div>
 </Section>
 ) : null

 return (
 <div className="relative flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-strong)]">
 {runHero}

 <div className="sr-only" role="status" aria-live="polite">
 {syncState.message}
 </div>

 {boardFreshnessBanner}
 {projectionBanner}
 {runCompleteBanner}
 {folderStatusBanner}

 {/* Board content area (columns / inspector / summary view). */}
 <div className="relative flex min-h-0 flex-1 flex-col">
 {effectiveView === 'summary' ? (
 <div
 id="sprintengine-view-panel-summary"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-summary"
 className="flex min-h-0 flex-1"
 >
 <div className="min-w-0 min-h-0 flex-1">
 <React.Suspense fallback={<SuspenseFallback label="Loading run summary" />}>
 <SprintEngineRunSummaryPanel
 workspaceId={workspaceId}
 embedded
 // Open task detail as an aside inside the Summary view — select the
 // task, don't navigate away to the Kanban.
 onOpenTask={(taskId) => setSelectedTaskId(taskId)}
 />
 </React.Suspense>
 </div>
 {renderInspectorAside()}
 </div>
 ) : null}

 {effectiveView === 'inbox' ? (
 <div
 id="sprintengine-view-panel-inbox"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-inbox"
 className="flex min-h-0 flex-1"
 >
 <SprintEngineInboxView
 sprintEngineState={sprintEngineState}
 reviewArtifacts={sprintRunCanceled ? [] : reviewArtifacts}
 runPhase={runPhase}
 workspaceId={workspaceId}
 folderPath={folderPath}
 selectedArtifactId={selectedArtifactId}
 onSelectArtifact={setSelectedArtifactId}
 onSelectTask={setSelectedTaskId}
 inspectorContent={renderInspectorPanel()}
 inspectorExpanded={inspectorExpanded}
 />
 </div>
 ) : null}

 {effectiveView === 'roster' ? (
 <div
 id="sprintengine-view-panel-roster"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-roster"
 className="flex min-h-0 flex-1"
 >
 <SprintEngineRosterView
 sprintEngineState={sprintEngineState}
 roster={roster}
 agents={agents}
 runtimeAgents={runtimeAgents}
 onEnableRole={(role) => {
 // Enabling a not-yet-configured role writes configuredRoles/roleRuntimes
 // through the sanctioned run-config path: a genuinely new role prompts the
 // architect to revise the plan (roster.configure is architect-only), and a
 // display agent is minted locally so the role's band appears immediately.
 void confirmAddMember(role)
 }}
 onAddAgent={addSprintEngineAgentForRole}
 addMemberOptions={addMemberOptions}
 isAgentTerminalLive={isAgentTerminalLive}
 cliOptions={cliOptions}
 roleRuntimeCli={roleRuntimeCli}
 roleRuntimeModel={roleRuntimeModel}
 onSelectRoleCli={selectRoleCli}
 onSelectRoleModel={selectRoleModel}
 agentRuntimeCli={agentRuntimeCli}
 effectiveModelForAgent={effectiveModelForAgent}
 onSelectAgentCli={selectAgentCli}
 onSelectAgentModel={selectAgentModel}
 onOpenAgent={openAgentTerminal}
 onSpawnAgent={spawnAgent}
 willResumeAgent={willResumeAgent}
 onRestartAgent={(agentId) => {
 void restartAgentTerminal(agentId)
 }}
 onKillAgent={(agentId) => {
 void killAgentTerminal(agentId)
 }}
 />
 </div>
 ) : null}

 {effectiveView === 'tasks' ? (
 <div
 id="sprintengine-view-panel-tasks"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-tasks"
 className={`flex min-h-0 flex-1 flex-col bg-[color:var(--bg-surface)] ${effectiveTasksLayout === 'kanban' ? 'focus:outline-none' : ''}`}
 tabIndex={effectiveTasksLayout === 'kanban' ? 0 : -1}
 onKeyDown={effectiveTasksLayout === 'kanban' ? handleKanbanKeyDown : undefined}
 aria-label={effectiveTasksLayout === 'kanban' ? 'Sprint kanban' : undefined}
 >
 {/* Tasks layout (Graph / Kanban) toggle lives beside the view tabs on the */}
 {/* leading edge of the sub-nav row above so we don't stack a second bar. */}

 <div className="flex min-h-0 flex-1">
 {inspectorExpanded ? null : effectiveTasksLayout === 'graph' ? (
 <SprintEngineTaskGraphView
 sprintEngineState={sprintEngineState}
 rosterById={rosterById}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 />
 ) : (
 <SprintEngineTasksKanbanView
 sprintEngineState={sprintEngineState}
 boardColumns={boardColumns}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 recentlyMovedTaskIds={recentlyMovedTaskIds}
 />
 )}

 {renderInspectorAside()}
 </div>
 </div>
 ) : null}
 </div>

 {recoveryDialog ? (
 <Modal
 open
 contained
 width={520}
 labelledBy="recovery-dialog-title"
 onClose={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="min-w-0">
 <div className="mb-1 text-[10px] font-semibold text-[color:var(--text-disabled)]">
 Verify Progress
 </div>
 <h3 id="recovery-dialog-title" className="truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
 Architect Audit
 </h3>
 <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
 The Architect will inspect the run store, check each task in order, and update task status through the sprintengine Python tool.
 </p>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 />
 </div>

 <ModalBody className="space-y-4">
 <DefinitionList
 layout="compact-grid"
 className="gap-x-8"
 items={[
 { term: 'Tasks', description: `${sprintEngineState.tasks.length} to check` },
 { term: 'Backup', description: 'state-timestamp.yaml' },
 ]}
 />

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Architect CLI
 </div>
 <Popover
 open={cliPickerOpen}
 onOpenChange={setCliPickerOpen}
 ariaLabel="Architect CLI options"
 popupRole="listbox"
 placement="bottom-start"
 className="block w-full"
 surfaceClassName="min-w-[var(--popover-trigger-width)] p-1"
 renderTrigger={({ ref, triggerProps, togglePopover }) => (
 <button
 ref={ref}
 type="button"
 onClick={togglePopover}
 className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
 {...triggerProps}
 >
 <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)]">
 <CliIcon cli={selectedRecoveryCliOption.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold text-[color:var(--text-strong)]">
 {selectedRecoveryCliOption.label}
 </span>
 <TruncatedText
 as="span"
 text={selectedRecoveryCliOption.description}
 className="mt-0.5 block text-[12px] text-[color:var(--text-disabled)]"
 />
 </span>
 <svg
 className={`icon-md shrink-0 text-[color:var(--text-disabled)] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 xmlns="http://www.w3.org/2000/svg"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )}
 >
 {cliOptions.map((option) => {
 const selected = recoveryDialog.cli === option.value
 return (
 <button
 key={option.value}
 type="button"
 role="option"
 aria-selected={selected}
 onClick={() => {
 setRecoveryDialog((current) =>
 current ? { ...current, cli: option.value, model: undefined } : current
 )
 setCliPickerOpen(false)
 }}
 className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left interactive transition-colors ${
 selected
 ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
 }`}
 >
 <span
 className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
 selected
 ? 'text-[color:var(--text-muted)]'
 : 'text-[color:var(--text-disabled)]'
 }`}
 >
 <CliIcon cli={option.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold">{option.label}</span>
 <TruncatedText
 as="span"
 text={option.description}
 className="mt-0.5 block text-[12px] text-[color:var(--text-disabled)]"
 />
 </span>
 {selected ? (
 <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 </Popover>
 </div>

 <SprintEngineModelField
 cliOption={selectedRecoveryCliOption}
 model={recoveryDialog.model}
 onChange={(model) => {
 setRecoveryDialog((current) => (current ? { ...current, model } : current))
 }}
 />

 <p className="border-l border-[color:var(--border-strong)] pl-3 text-sm leading-6 text-[color:var(--text-muted)]">
 The Architect runs the audit in a terminal and writes updates to the watched state file.
 </p>
 </ModalBody>

 <ModalFooter>
 <ModalButton
 onClick={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 >
 Cancel
 </ModalButton>
 <ModalButton
 variant="primary"
 onClick={confirmRecoveryAudit}
 disabled={!folderPath || !architectAgentId}
 >
 Start Audit
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {requestChangesDialog ? (
 <Modal
 open
 contained
 width={520}
 labelledBy="request-changes-dialog-title"
 onClose={cancelRequestChangesDialog}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="min-w-0">
 <div className="mb-1 text-[10px] font-semibold text-[color:var(--text-disabled)]">
 Request Changes
 </div>
 <h3
 id="request-changes-dialog-title"
 className="truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]"
 >
 {requestChangesDialog.artifact.title}
 </h3>
 <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
 The sprint records this feedback on the artifact and reopens the owning task for rework.
 </p>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={cancelRequestChangesDialog}
 />
 </div>

 <ModalBody className="space-y-3">
 <label className="block">
 <span className="mb-2 block text-[10px] font-bold text-[color:var(--text-disabled)]">
 Feedback
 </span>
 <textarea
 value={requestChangesDialog.feedback}
 onChange={(event) => {
 const value = event.target.value
 setRequestChangesDialog((current) =>
 current ? { ...current, feedback: value, error: null } : current,
 )
 }}
 disabled={requestChangesDialog.submitting}
 placeholder="Describe what needs to change before this artifact can be approved."
 rows={5}
 className="block w-full resize-y rounded-md bg-[color:var(--bg-surface-raised)] px-3 py-2 text-sm leading-5 text-[color:var(--text-strong)] outline-none interactive transition-colors placeholder:text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-60"
 />
 </label>
 {requestChangesDialog.error ? (
 <p className="text-[12px] leading-5 text-[color:var(--tone-error)]">
 {requestChangesDialog.error}
 </p>
 ) : null}
 </ModalBody>

 <ModalFooter>
 <ModalButton
 onClick={cancelRequestChangesDialog}
 disabled={requestChangesDialog.submitting}
 >
 Cancel
 </ModalButton>
 <ModalButton
 variant="primary"
 onClick={() => void submitRequestChangesDialog()}
 disabled={requestChangesDialog.submitting || requestChangesDialog.feedback.trim().length === 0}
 >
 {requestChangesDialog.submitting ? 'Requesting changes…' : 'Request changes'}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {confirmCancelSprint ? (
 <Modal
 open
 contained
 width={440}
 labelledBy="cancel-sprint-dialog-title"
 onClose={() => setConfirmCancelSprint(false)}
 >
 <ModalHeader
 titleId="cancel-sprint-dialog-title"
 title="Cancel this sprint?"
 subtitle="Running agents stop and every unfinished task is marked canceled. Finished work and the run branch are kept. This cannot be undone."
 onClose={() => setConfirmCancelSprint(false)}
 />
 <ModalFooter>
 <ModalButton onClick={() => setConfirmCancelSprint(false)} disabled={cancelSprintBusy}>
 Keep running
 </ModalButton>
 <ModalButton
 variant="danger"
 disabled={cancelSprintBusy}
 onClick={() => {
 setConfirmCancelSprint(false)
 void cancelSprint()
 }}
 >
 Cancel sprint
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {addMemberOpen ? (
 <Modal
 open
 contained
 width={760}
 labelledBy="add-member-dialog-title"
 onClose={() => setAddMemberOpen(false)}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div>
 <div className="mb-1 text-[10px] font-bold text-[color:var(--text-disabled)]">
 SprintEngine agents
 </div>
 <h3 id="add-member-dialog-title" className="text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
 {sprintEngineState.rosterConfigured ? 'Add an agent' : 'Spawn a team agent'}
 </h3>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={() => setAddMemberOpen(false)}
 />
 </div>

 <ModalBody className="space-y-1">
 {addMemberOptions.map((option) => {
 const role = option.role
 const selected = role === addMemberRole

 return (
 <button
 key={role}
 onClick={() => selectAddMemberRole(role as SprintEngineRole)}
 aria-pressed={selected}
 className={`w-full rounded-md border-l-2 px-3 py-3 text-left interactive transition-colors ${
 selected
 ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
 : 'border-l-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
 }`}
 >
 <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
 <span
 className="hidden h-8 w-8 shrink-0 items-center justify-center rounded border bg-[color:var(--bg-surface-raised)] sm:flex"
 style={{
 borderColor: selected ? getSprintEngineRoleAccent(role) : 'var(--border-strong)',
 color: 'var(--text-muted)',
 }}
 >
 <SprintEngineRoleIcon role={role} className="icon-md" />
 </span>
 <div className="min-w-0 flex-1">
 <TruncatedText as="div" text={option.label} className="text-sm font-semibold" />
 <p className={`mt-1 text-[12px] leading-5 ${selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-muted)]'}`}>
 {option.summary}
 </p>
 </div>
 <span className={`shrink-0 pt-0.5 text-right text-[11px] font-semibold ${
 selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-disabled)]'
 }`}>
 {option.activeForRole} active / {option.openTasksForRole} open
 </span>
 </div>
 </button>
 )
 })}

 <div className="space-y-4 pt-4">
 <label className="block">
 <span className="mb-2 block text-[10px] font-bold text-[color:var(--text-disabled)]">
 Name (optional)
 </span>
 <input
 type="text"
 value={addMemberName}
 onChange={(event) => setAddMemberName(event.target.value)}
 placeholder={getSprintEngineRoleLabel(addMemberRole)}
 className="h-10 w-full rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-sm text-[color:var(--text-strong)] outline-none interactive transition-colors placeholder:text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--accent-primary-soft)]"
 />
 </label>

 <div className="flex items-center justify-between gap-3">
 <span className="text-[10px] font-bold text-[color:var(--text-disabled)]">
 Agent runtime
 </span>
 <CliModelPickerButton
 ariaLabel={`${getSprintEngineRoleLabel(addMemberRole)} agent runtime`}
 options={cliOptions}
 cli={addMemberCli ?? addMemberRoleDefaultCli(addMemberRole)}
 effectiveModelFor={(cli) =>
 cli === (addMemberCli ?? addMemberRoleDefaultCli(addMemberRole))
 ? addMemberModel
 : undefined
 }
 onSelectCli={(cli) => {
 setAddMemberCli(cli)
 setAddMemberModel(undefined)
 }}
 onSelectModel={(cli, model) => {
 setAddMemberCli(cli)
 setAddMemberModel(model ?? undefined)
 }}
 />
 </div>

 <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[color:var(--text-default)]">
 <input
 type="checkbox"
 checked={addMemberSpawnNow}
 onChange={(event) => setAddMemberSpawnNow(event.target.checked)}
 className="h-3.5 w-3.5 accent-[color:var(--accent-primary)]"
 />
 Spawn the agent terminal now
 </label>

 {sprintEngineState.rosterConfigured ? (
 <p className="border-l border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
 The new agent joins the run first.
 {hasPlannedTasks
 ? ' The architect will be asked to review whether the plan needs revision for this new specialist.'
 : ' No tasks are planned yet, so no architect revision is requested.'}
 </p>
 ) : null}

 {addMemberError ? (
 <p role="alert" className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
 {addMemberError}
 </p>
 ) : null}
 </div>
 </ModalBody>

 <ModalFooter>
 <ModalButton onClick={() => setAddMemberOpen(false)}>Cancel</ModalButton>
 <ModalButton
 variant="primary"
 disabled={addMemberBusy}
 onClick={() => void confirmAddMember()}
 >
 {addMemberBusy ? 'Adding…' : `Add ${getSprintEngineRoleLabel(addMemberRole)}`}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 </div>
 )
}
