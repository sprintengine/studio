import React from 'react'
import type {
  AgentCli,
  SprintEngineCliPermissionPreset,
  WorkspaceSkill,
} from '../../../../../shared/electron-api'
import { resolveSkillMentionPrefix, renderSkillMention } from '../../../../../shared/skill-invocation'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import {
  CliModelPopoverSurface,
  FOCUS_RING_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  InlineSkillPicker,
  Popover,
  SkillPickerPopover,
  StarGlyph,
  TruncatedText,
  type InlineSkillPickerHandle,
} from '../../ui'
import CliIcon from '../../CliIcon'
import { CliInstallCta } from '../cliInstallRoute'
import { PermissionPresetChips, SpawnDebugToggle } from './agentSpawnShared'
import { ConnectorPickerPopover } from './ConnectorPickerPopover'
import {
  launchCommandLineKey,
  launchPreviewRequest,
  type LaunchCommandLineState,
} from './launchCommandLine'
import {
  drawSuggestions,
  newSuggestionSeed,
  type SuggestionEntry,
} from './suggestionBank'
import {
  rowMatchesSelection,
  selectionForRow,
  useAgentComposer,
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'

export type NewAgentLaunch = AgentComposerConfirm & {
  /** The agent's startup prompt. Empty means "start with nothing typed". */
  prompt: string
}

export type NewAgentPanelProps = {
  workspaceId: string
  conversationAvailable: boolean
  /** The remembered agent, preselected — the same one every picker opens on. */
  initialSelection: AgentComposerSelection
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  /** Host performs the spawn and retypes this tab into the agent's terminal. */
  onLaunch: (launch: NewAgentLaunch) => void
  /** Close the tab. Nothing was created, so there is nothing else to undo. */
  onClose: () => void
}

/**
 * The launch surface behind the tab strip's "+" (MC-2147).
 *
 * It is a pre-creation surface in the shape of the thing it precedes: the box
 * sits on the terminal's own ground, the prompt line carries a `❯` and the
 * agent's own skill trigger, and the line under the arguments is the invocation
 * a launch would actually make — rendered in main, so it cannot drift.
 *
 * Nothing here creates anything. `onLaunch` hands the host a confirm plus the
 * prompt; the host spawns and retypes this tab in place, so the terminal appears
 * exactly where this surface was.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationAvailable,
  initialSelection,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onLaunch,
  onClose,
}: NewAgentPanelProps) {
  const composer = useAgentComposer({
    showTerminal: true,
    conversationAvailable,
    initialSelection,
  })
  const { selection } = composer

  const workspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  const projectLabel = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? 'this project',
  )
  const branch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.branch ?? null : null
  })
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)

  const [prompt, setPrompt] = React.useState('')
  const [rosterOpen, setRosterOpen] = React.useState(false)
  const [connectorPickerOpen, setConnectorPickerOpen] = React.useState(false)
  const [enginePopoverOpen, setEnginePopoverOpen] = React.useState(false)
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  const [seed, setSeed] = React.useState(() => newSuggestionSeed())
  const promptRef = React.useRef<HTMLTextAreaElement>(null)

  // The engine this launch will use. `selectionCli` is the agent's remembered
  // CLI; a Terminal row launches no CLI at all, so it has none.
  const launchCli: AgentCli | null = selection.kind === 'terminal' ? null : composer.selectionCli
  const engineNames = composer.engineNamesFor(selection)
  const model = launchCli ? composer.modelForSelection(selection, launchCli) : undefined
  const reasoning = launchCli ? composer.reasoningForSelection(selection, launchCli) : undefined

  // ── The skill trigger ────────────────────────────────────────────────────
  // Which character names a skill on THIS agent's CLI, read from its plugin
  // manifest: `/` on claude, `$` on codex, and nothing at all on a CLI whose
  // skills are named in a sentence. No prefix, no type-ahead — the "+ Skill"
  // chip stays instead, because a route that cannot be typed must be pickable.
  const skillIntegration = React.useMemo(() => {
    if (!launchCli) return undefined
    return pluginCatalogEntries.find((entry) => entry.id === launchCli)?.skillIntegration
  }, [launchCli, pluginCatalogEntries])
  const mentionPrefix = resolveSkillMentionPrefix(skillIntegration)

  const [mentionDismissed, setMentionDismissed] = React.useState(false)
  const mentionRef = React.useRef<InlineSkillPickerHandle | null>(null)
  // The token being typed: the prefix at the start of the prompt or after
  // whitespace, with nothing but the skill name typed since. `null` when there
  // is no live trigger, which is also how the picker stays closed.
  const mentionQuery = React.useMemo(() => {
    if (!mentionPrefix || mentionDismissed) return null
    const match = new RegExp(`(?:^|\\s)\\${mentionPrefix}([^\\s]*)$`).exec(prompt)
    return match ? match[1] : null
  }, [mentionDismissed, mentionPrefix, prompt])

  const applySkillMention = (skill: WorkspaceSkill) => {
    const mention = renderSkillMention(skillIntegration, skill.id)
    if (!mention || !mentionPrefix) return
    // Replace the token being typed, never the whole draft: the prompt is the
    // user's sentence and a skill is one word inside it.
    setPrompt((current) =>
      current.replace(new RegExp(`\\${mentionPrefix}[^\\s]*$`), `${mention} `),
    )
    setMentionDismissed(true)
    promptRef.current?.focus()
  }

  // Switching agents re-renders mentions already typed in the CLI's own form —
  // a literal `/design-review` is wrong text on codex, and asking the user to
  // fix it is asking them to know both dialects. When the new CLI declares no
  // form at all the text is left exactly as typed (rewriting a mention into a
  // sentence mid-prompt would write their sentence for them) and the note under
  // the box says so.
  const previousPrefix = React.useRef(mentionPrefix)
  React.useEffect(() => {
    const before = previousPrefix.current
    previousPrefix.current = mentionPrefix
    if (!before || !mentionPrefix || before === mentionPrefix) return
    setPrompt((current) =>
      current.replace(new RegExp(`(^|\\s)\\${before}([A-Za-z0-9._-]+)`, 'g'), `$1${mentionPrefix}$2`),
    )
  }, [mentionPrefix])

  // ── Worktree availability ────────────────────────────────────────────────
  // Offered only inside a git repo: absent, not disabled — there is nothing to
  // explain about a control that could not work here.
  React.useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) {
      setWorkspaceIsGitRepo(false)
      return
    }
    void window.api
      .getGitRepoRoot(workspaceRoot)
      .then((root) => {
        if (!cancelled) setWorkspaceIsGitRepo(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  // ── The receipt line ─────────────────────────────────────────────────────
  const [commandLine, setCommandLine] = React.useState<LaunchCommandLineState>({ status: 'idle' })
  const previewInput = React.useMemo(
    () => ({
      cli: launchCli,
      model,
      reasoning,
      permissionPreset,
      runtime: launchCli ? cliRuntimes?.[launchCli] : undefined,
    }),
    [cliRuntimes, launchCli, model, permissionPreset, reasoning],
  )
  // Keyed on the arguments alone, so typing a prompt costs no IPC and flipping
  // a chip costs exactly one round trip.
  const previewKey = launchCommandLineKey(previewInput)
  React.useEffect(() => {
    const request = launchPreviewRequest(previewInput)
    if (!request) {
      setCommandLine({ status: 'idle' })
      return
    }
    let cancelled = false
    void window.api
      .agentLaunchPreview(request)
      .then((result) => {
        if (cancelled) return
        setCommandLine(
          result.ok
            ? { status: 'ready', preview: result.preview }
            : { status: 'error', message: result.message },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setCommandLine({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not read this agent’s launch command.',
        })
      })
    return () => {
      cancelled = true
    }
    // previewKey is the identity of previewInput; depending on the object would
    // re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  // ── Launching ────────────────────────────────────────────────────────────
  const suggestions = React.useMemo(() => drawSuggestions(seed), [seed])
  const canLaunch = composer.visibleRows.some((row) => rowMatchesSelection(row, selection))

  const launch = (text: string) => {
    if (!canLaunch) return
    onLaunch({ ...composer.buildConfirm(selection), prompt: text.trim() })
  }

  React.useEffect(() => {
    const id = requestAnimationFrame(() => promptRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the skill type-ahead is up the caret stays here and the list takes
    // navigation — Enter picks a skill rather than launching an agent.
    if (mentionQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (mentionRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        if (mentionRef.current?.pickActive()) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      launch(prompt)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const placeholder = mentionPrefix
    ? `Describe the task, or type ${mentionPrefix} for skills`
    : 'Describe the task, or pick one below'

  // A mention typed for one CLI, now sitting in a prompt bound to a CLI that has
  // no typed form (opencode names skills in a sentence). The text is left
  // exactly as written — rewriting it into a sentence would write the user's
  // sentence for them — so the surface says what will happen instead.
  const strandedMention =
    !mentionPrefix && selection.kind !== 'terminal' && /(^|\s)[/$][A-Za-z0-9._-]+/.test(prompt)

  // With no agent CLI on this machine the roster withheld every row that
  // launches one. The surface says so and offers the install route rather than
  // rendering live-looking controls that fail on click.
  if (composer.noAgentCliInstalled) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 py-10">
        <div className="mx-auto w-full max-w-[660px]">
          <h1 className="text-center text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
            No agent CLI is installed on this machine.
          </h1>
          <p className="mt-1 text-center text-body text-[color:var(--text-muted)]">
            Install one to start an agent here.
          </p>
          <div className="mt-5">
            <CliInstallCta />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 pb-10 pt-8">
      <div className="@container mx-auto w-full max-w-[660px]">
        <h1 className="text-center text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
          What needs doing?
        </h1>
        {/* State, not decoration: where this agent will run, so a wrong-project
            spawn is visible before it happens rather than after. */}
        <p className="mt-1 text-center text-meta text-[color:var(--text-muted)]">
          {projectLabel}
          {branch ? <span className="text-[color:var(--text-subtle)]"> · {branch}</span> : null}
        </p>

        {/* The composer, on the terminal's own ground — this box becomes the
            terminal, so it is already shaped like one. */}
        <div
          className={[
            'relative mt-5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-3 pb-2 pt-2.5',
            // Focus is the ring, and only the ring (MC-2118). Swapping the
            // border to the accent was a second, weaker signal for the same
            // state — and spent the accent on something nobody chose.
            FOCUS_RING_WITHIN_TEXTAREA_CLASS,
          ].join(' ')}
        >
          {mentionQuery !== null ? (
            <InlineSkillPicker
              ref={mentionRef}
              workspaceRoot={workspaceRoot}
              pluginId={launchCli}
              query={mentionQuery}
              onPick={applySkillMention}
              onMatchCountChange={(count) => {
                if (count === 0 && mentionQuery.length > 0) setMentionDismissed(true)
              }}
              className="bottom-full left-0"
            />
          ) : null}

          <div className="flex items-start gap-2">
            <Popover
              open={rosterOpen}
              onOpenChange={setRosterOpen}
              ariaLabel="Choose an agent"
              popupRole="menu"
              placement="bottom-start"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <button
                  ref={ref}
                  type="button"
                  onClick={togglePopover}
                  className={`interactive mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                  {...triggerProps}
                >
                  {launchCli ? <CliIcon cli={launchCli} className="icon-xs" /> : null}
                  <TruncatedText as="span" text={agentLabel(selection, engineNames.modelLabel ?? engineNames.cliLabel, composer.visibleRows)} className="max-w-[180px]" />
                  <span aria-hidden="true" className="text-micro text-[color:var(--text-subtle)]">▾</span>
                </button>
              )}
            >
              <LaunchAgentRoster
                rows={composer.visibleRows}
                selection={selection}
                onPick={(row) => {
                  composer.setSelection(selectionForRow(row))
                  setRosterOpen(false)
                  promptRef.current?.focus()
                }}
                query={composer.query}
                onQueryChange={composer.setQuery}
                rolelessLabel={composer.engineNamesFor({ kind: 'general' }).modelLabel
                  ?? composer.engineNamesFor({ kind: 'general' }).cliLabel}
              />
            </Popover>

            {/* The caret: this is a terminal line, not a message field. An SVG
                chevron in its place would read as an affordance to click. */}
            <span aria-hidden="true" className="mt-0.5 select-none font-mono text-body text-[color:var(--accent-primary)]">
              {/* design-tokens-allow: shell prompt caret, not an icon — a mono glyph typeset with the command line it introduces */}
              ❯
            </span>

            <textarea
              ref={promptRef}
              value={prompt}
              rows={2}
              onChange={(event) => {
                setPrompt(event.currentTarget.value)
                setMentionDismissed(false)
              }}
              onKeyDown={onPromptKeyDown}
              placeholder={placeholder}
              aria-label="What this agent should do"
              className="min-h-[44px] w-full flex-1 resize-none bg-transparent font-mono text-body leading-6 text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)]"
            />
          </div>

          {/* The argument row. Pickers carry a value and a caret; attachments are
              a dashed ghost until set, then glyph + name + ×. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-[color:var(--border-subtle)] pt-2">
            {launchCli ? (
              <Popover
                open={enginePopoverOpen}
                onOpenChange={setEnginePopoverOpen}
                ariaLabel={`Engine for this agent: ${engineNames.cliLabel}`}
                popupRole="menu"
                placement="bottom-start"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    className={`interactive inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                    {...triggerProps}
                  >
                    <span className="font-mono text-micro">{engineNames.cliLabel}</span>
                    {engineNames.modelLabel ? <span>{engineNames.modelLabel}</span> : null}
                    {reasoning ? (
                      <>
                        <span aria-hidden="true" className="text-[color:var(--text-subtle)]">·</span>
                        <span>{reasoning}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true" className="text-micro text-[color:var(--text-subtle)]">▾</span>
                  </button>
                )}
              >
                <CliModelPopoverSurface
                  ariaLabel="Agent runtime"
                  options={composer.agentCliOptions}
                  currentCli={launchCli}
                  effectiveModelFor={(cli) => composer.modelForSelection(selection, cli)}
                  effectiveReasoningFor={(cli) => composer.reasoningForSelection(selection, cli)}
                  onSelectReasoning={(cli, next) => composer.setEngineReasoning(selection, cli, next)}
                  onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
                  onSelectModel={(cli, next) => composer.setEngineModel(selection, cli, next)}
                  showReasoning
                  reasoningAriaLabel="Reasoning for this agent"
                />
              </Popover>
            ) : null}

            {selection.kind === 'terminal' ? null : (
              <div className="inline-flex items-center gap-0.5">
                <PermissionPresetChips value={permissionPreset} onChange={onChangePermissionPreset} />
              </div>
            )}

            {/* Skill: only a CLI with no typed form needs a chip — everywhere
                else the skill is named in the prompt, where it actually goes. */}
            {!mentionPrefix && selection.kind !== 'terminal' && workspaceRoot ? (
              composer.skillAttachment ? (
                <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
                  <StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />
                  {composer.skillAttachment.name}
                  <button
                    type="button"
                    onClick={() => composer.setSkillAttachment(null)}
                    aria-label={`Remove skill ${composer.skillAttachment.name}`}
                    className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <SkillAttachmentButton
                  workspaceRoot={workspaceRoot}
                  pluginId={launchCli}
                  onPick={(skill) => composer.setSkillAttachment(skill)}
                />
              )
            ) : null}

            {workspaceIsGitRepo && selection.kind !== 'terminal' ? (
              composer.worktreeName !== null ? (
                <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)]">
                  <BranchGlyph />
                  <input
                    value={composer.worktreeName}
                    onChange={(event) => composer.setWorktreeName(event.currentTarget.value)}
                    placeholder="from the agent’s name"
                    aria-label="Worktree name — leave empty to derive from the agent’s name"
                    className="w-[130px] bg-transparent text-meta outline-none placeholder:text-[color:var(--text-disabled)]"
                  />
                  <button
                    type="button"
                    onClick={() => composer.setWorktreeName(null)}
                    aria-label="Remove worktree"
                    className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <GhostAttachmentButton label="+ Worktree" onClick={() => composer.setWorktreeName('')} />
              )
            ) : null}

            {selection.kind !== 'terminal' ? (
              composer.connectorAttachment ? (
                <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)]">
                  {composer.connectorAttachment.name}
                  <button
                    type="button"
                    onClick={() => composer.setConnectorAttachment(null)}
                    aria-label={`Remove connector ${composer.connectorAttachment.name}`}
                    className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <ConnectorPickerPopover
                  open={connectorPickerOpen}
                  onOpenChange={setConnectorPickerOpen}
                  onPick={(connector) => composer.setConnectorAttachment(connector)}
                  placement="bottom-start"
                  renderTrigger={({ ref, triggerProps, togglePopover }) => (
                    <button
                      ref={ref}
                      type="button"
                      onClick={togglePopover}
                      className={`interactive inline-flex items-center gap-1 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
                      {...triggerProps}
                    >
                      + Connector
                    </button>
                  )}
                />
              )
            ) : null}

            {selection.kind === 'terminal' ? null : (
              <SpawnDebugToggle active={debugMode} onChange={onChangeDebugMode} />
            )}
          </div>

          {/* The receipt: what a launch would actually run, rendered by main
              from the same manifest the spawn renders from. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
              {selection.kind === 'terminal' ? 'Opens' : 'Runs'}
            </span>
            <span className="min-w-0 flex-1 font-mono text-micro leading-5 text-[color:var(--text-disabled)] [overflow-wrap:anywhere]">
              {selection.kind === 'terminal'
                ? 'a shell in this folder'
                : commandLine.status === 'ready'
                  ? commandLine.preview.display
                  : commandLine.status === 'error'
                    ? commandLine.message
                    : '…'}
            </span>
            <button
              type="button"
              onClick={() => launch(prompt)}
              disabled={!canLaunch}
              className={`interactive inline-flex shrink-0 items-center gap-1.5 rounded bg-[color:var(--accent-primary)] px-2.5 py-1 text-meta font-semibold text-[color:var(--text-on-accent)] disabled:cursor-not-allowed disabled:bg-[color:var(--bg-active)] disabled:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
            >
              Start
              <span aria-hidden="true" className="rounded border border-current px-1 font-mono text-micro opacity-60">
                ⏎
              </span>
            </button>
          </div>
        </div>

        {strandedMention ? (
          <p className="mt-2 text-meta leading-5 text-[color:var(--text-muted)]">
            {engineNames.cliLabel} has no typed skill form, so that text is sent as written. Attach the
            skill with <span className="text-[color:var(--text-default)]">+ Skill</span> to invoke it.
          </p>
        ) : null}

        {/* Suggested starts. A card is a launch button: one click spawns the
            agent above with that prompt. */}
        <div className="mt-5 flex items-baseline gap-2">
          <span className="text-micro font-semibold text-[color:var(--text-subtle)]">
            Or start with
          </span>
          <button
            type="button"
            onClick={() => setSeed(newSuggestionSeed())}
            className={`interactive ml-auto rounded px-1 text-meta text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          >
            Shuffle
          </button>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
          {suggestions.map((entry) => (
            <SuggestionCard
              key={entry.id}
              entry={entry}
              disabled={!canLaunch}
              onLaunch={() => launch(entry.prompt)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function agentLabel(
  selection: AgentComposerSelection,
  rolelessLabel: string,
  rows: ComposerRow[],
): string {
  if (selection.kind === 'terminal') return 'Terminal'
  if (selection.kind === 'general') return rolelessLabel
  if (selection.kind === 'conversation') return 'Conversation agent'
  const row = rows.find(
    (candidate) => candidate.kind === 'specialist' && candidate.action.id === selection.specialistId,
  )
  return row && row.kind === 'specialist' ? row.action.shortLabel : 'Agent'
}

function BranchGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--accent-primary)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5M11.5 7.75c0 2-1.5 3-4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function GhostAttachmentButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`interactive inline-flex items-center gap-1 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
    >
      {label}
    </button>
  )
}

// The picker route for a CLI whose skills have no typed form — the same
// inventory the type-ahead reads, so there is one source of truth either way.
function SkillAttachmentButton({
  workspaceRoot,
  pluginId,
  onPick,
}: {
  workspaceRoot: string
  pluginId: AgentCli | null
  onPick: (skill: WorkspaceSkill) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <SkillPickerPopover
      open={open}
      onOpenChange={setOpen}
      workspaceRoot={workspaceRoot}
      pluginId={pluginId}
      onPick={onPick}
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className={`interactive inline-flex items-center gap-1 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          + Skill
        </button>
      )}
    />
  )
}

function SuggestionCard({
  entry,
  disabled,
  onLaunch,
}: {
  entry: SuggestionEntry
  disabled: boolean
  onLaunch: () => void
}) {
  return (
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled}
      className={`interactive rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2.5 text-left transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING_CLASS}`}
    >
      <div className="text-body font-medium text-[color:var(--text-strong)]">{entry.title}</div>
      <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{entry.description}</p>
      {/* The one fact a person cannot infer from the title: what the run leaves
          behind. It is why these are worth a click. */}
      <span className="mt-1.5 inline-block rounded border border-[color:var(--border-default)] px-1.5 text-micro text-[color:var(--text-subtle)]">
        {entry.outcome}
      </span>
    </button>
  )
}

function LaunchAgentRoster({
  rows,
  selection,
  onPick,
  query,
  onQueryChange,
  rolelessLabel,
}: {
  rows: ComposerRow[]
  selection: AgentComposerSelection
  onPick: (row: ComposerRow) => void
  query: string
  onQueryChange: (next: string) => void
  rolelessLabel: string
}) {
  return (
    <div className="flex max-h-[420px] w-[280px] flex-col overflow-hidden">
      <div className="border-b border-[color:var(--border-subtle)] px-2.5 py-2">
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search agents"
          aria-label="Search agents"
          className="w-full bg-transparent text-meta text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)]"
        />
      </div>
      <div role="menu" aria-label="Agents" className="min-h-0 flex-1 overflow-auto p-1">
        {rows.map((row) => {
          const selected = rowMatchesSelection(row, selection)
          const label =
            row.kind === 'terminal'
              ? 'Terminal'
              : row.kind === 'general'
                ? rolelessLabel
                : row.kind === 'conversation'
                  ? 'Conversation agent'
                  : row.action.shortLabel
          return (
            <button
              key={row.key}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => onPick(row)}
              className={`interactive flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta ${
                selected
                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
              } ${FOCUS_RING_CLASS}`}
            >
              <TruncatedText as="span" text={label} className="min-w-0 flex-1" />
            </button>
          )
        })}
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-meta text-[color:var(--text-disabled)]">No agents match.</div>
        ) : null}
      </div>
    </div>
  )
}
