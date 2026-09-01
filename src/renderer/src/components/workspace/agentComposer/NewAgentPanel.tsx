import React from 'react'
import type {
  AgentCli,
  SprintEngineCliPermissionPreset,
  WorkspaceSkill,
} from '../../../../../shared/electron-api'
import { resolveSkillMentionPrefix, renderSkillMention } from '../../../../../shared/skill-invocation'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { basename } from '../../../utils/paths'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import {
  CliModelPopoverSurface,
  CloseIconButton,
  FOCUS_RING_CLASS,
  InlineSkillPicker,
  Popover,
  SkillPickerPopover,
  StarGlyph,
  Tooltip,
  TruncatedText,
  type InlineSkillPickerHandle,
} from '../../ui'
import CliIcon from '../../CliIcon'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import SprintEngineFrond from '../../brand/SprintEngineFrond'
import { CliInstallCta } from '../cliInstallRoute'
import { AGENT_SPAWN_PERMISSION_OPTIONS } from './agentSpawnShared'
import { ConnectorPickerPopover } from './ConnectorPickerPopover'
import {
  launchCommandLineKey,
  launchPreviewRequest,
  type LaunchCommandLineState,
} from './launchCommandLine'
import { drawSuggestions, newSuggestionSeed, type SuggestionEntry } from './suggestionBank'
import {
  rowMatchesSelection,
  useAgentComposer,
  type AgentComposerConfirm,
  type AgentComposerSelection,
} from './useAgentComposer'

export type NewAgentLaunch = AgentComposerConfirm & {
  /** The agent's startup prompt. Empty means "start with nothing typed". */
  prompt: string
}

/** One choosable project scope: a folder some open workspace lives in. */
export type NewAgentProjectOption = { path: string; label: string }

export type NewAgentPanelProps = {
  workspaceId: string
  conversationAvailable: boolean
  /**
   * Ask the host to load the conversation provider catalog. `conversationAvailable`
   * stays false until it has, so a surface that never asks can never offer the
   * row — which is exactly what happened while the catalog was loaded by the top
   * bar's menu alone.
   */
  onRequestConversationCatalog?: () => void
  /**
   * Where this launch lands when it is NOT the active workspace's own folder —
   * the New chat door, which creates a solo workspace in a project you pick. The
   * scope line becomes the picker when `projectOptions` come with it.
   */
  folderPath?: string | null
  projectOptions?: NewAgentProjectOption[]
  onSelectProject?: (path: string) => void
  onBrowseProject?: () => void
  initialSelection: AgentComposerSelection
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  /** Host performs the spawn and retypes this tab into the agent's terminal. */
  onLaunch: (launch: NewAgentLaunch) => void
  /** Cancel. Nothing was created, so there is nothing else to undo. */
  onClose: () => void
  /**
   * Draw a close control on the surface itself. The tab host does not need one
   * — its tab has an `×` — but the New chat door has no tab, and without this
   * the surface has no way out at all.
   */
  showCloseButton?: boolean
}

// The greeting rotates per tab open. No exclamation marks and no "we" (the copy
// voice bans both); the name is the first token of the signed-in display name,
// and every line reads correctly without it — a signed-out person gets the same
// welcome, not a prompt to sign in.
const GREETINGS: ReadonlyArray<(name: string | null) => string> = [
  (name) => (name ? `What's up, ${name}?` : "What's up?"),
  (name) => (name ? `What's next, ${name}?` : "What's next?"),
  (name) => (name ? `Ready when you are, ${name}.` : 'Ready when you are.'),
  (name) => (name ? `Where do you want to start, ${name}?` : 'Where do you want to start?'),
]

/**
 * The launch surface behind the tab strip's "+" (MC-2147, v2).
 *
 * One column: who is being greeted, what to do, how it runs, and what to start
 * with. The box sits on the terminal's own ground and carries a `❯`, because it
 * becomes that terminal in place.
 *
 * The control row shows only what a launch usually changes — engine and access —
 * plus the two attachments people reach for. Everything rarer (role, worktree,
 * reasoning, debug) lives behind `⋯` and rises onto the row as a chip once set,
 * so the row is a picture of this launch rather than a panel of every knob.
 *
 * Nothing here creates anything: `onLaunch` hands the host a confirm plus the
 * prompt, and the host retypes this tab into the agent's terminal.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationAvailable,
  onRequestConversationCatalog,
  folderPath,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onLaunch,
  onClose,
  showCloseButton = false,
}: NewAgentPanelProps) {
  const composer = useAgentComposer({
    showTerminal: true,
    conversationAvailable,
    initialSelection,
  })
  const { selection } = composer

  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  // An explicit scope wins: skills, the worktree probe and the scope line all
  // have to describe the folder the agent will actually run in.
  const workspaceRoot = folderPath !== undefined ? folderPath : activeWorkspaceRoot
  // The PROJECT, not the workspace: a solo-chat workspace is called things like
  // "new chat panel", which says nothing about where the agent will run. The
  // folder it opens in is the fact worth showing, so a wrong-project spawn is
  // visible before it happens.
  const projectLabel = React.useMemo(() => {
    const folder = workspaceRoot?.trim()
    if (!folder) return null
    return projectOptions?.find((option) => option.path === folder)?.label ?? basename(folder) ?? folder
  }, [projectOptions, workspaceRoot])
  // Can this surface change where the agent runs? True when the host gave us
  // any way to — a folder browser, or projects to switch between. Deliberately
  // NOT a function of whether a project is currently chosen: see the scope line
  // below for why that inversion is the bug this replaces.
  const canChooseProject =
    Boolean(onBrowseProject) || Boolean(onSelectProject && projectOptions && projectOptions.length > 0)
  const activeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.branch ?? null : null
  })
  // A branch belongs to the workspace's own checkout; a chat scoped to another
  // project is not on it, and printing it there would be a lie.
  const branch = folderPath !== undefined && folderPath !== activeWorkspaceRoot ? null : activeBranch
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const displayName = useWorkspaceStore((s) => s.authState.user?.displayName ?? null)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)

  const [prompt, setPrompt] = React.useState('')
  const [enginePopoverOpen, setEnginePopoverOpen] = React.useState(false)
  const [accessOpen, setAccessOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [connectorPickerOpen, setConnectorPickerOpen] = React.useState(false)
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  const [seed] = React.useState(() => newSuggestionSeed())
  const promptRef = React.useRef<HTMLTextAreaElement>(null)

  // The name is a greeting, not an identity claim: an email local-part reads
  // worse than no name at all, so only a real display name is used.
  const firstName = React.useMemo(() => {
    const token = (displayName ?? '').trim().split(/\s+/)[0] ?? ''
    return token.length > 0 ? token : null
  }, [displayName])
  // Held for the life of the tab — a re-render must not re-greet.
  const [greetingIndex] = React.useState(() => Math.floor(Math.random() * GREETINGS.length))
  const greeting = GREETINGS[greetingIndex % GREETINGS.length](firstName)

  // Neither a plain shell nor a conversation agent launches a CLI, so neither
  // may wear a CLI's chip, its flags, or its command line.
  const launchCli: AgentCli | null =
    selection.kind === 'terminal' || selection.kind === 'conversation' ? null : composer.selectionCli
  const engineNames = composer.engineNamesFor(selection)
  const model = launchCli ? composer.modelForSelection(selection, launchCli) : undefined
  const reasoning = launchCli ? composer.reasoningForSelection(selection, launchCli) : undefined

  // ── The skill trigger ────────────────────────────────────────────────────
  const skillIntegration = React.useMemo(() => {
    if (!launchCli) return undefined
    return pluginCatalogEntries.find((entry) => entry.id === launchCli)?.skillIntegration
  }, [launchCli, pluginCatalogEntries])
  const mentionPrefix = resolveSkillMentionPrefix(skillIntegration)

  const [mentionDismissed, setMentionDismissed] = React.useState(false)
  const mentionRef = React.useRef<InlineSkillPickerHandle | null>(null)
  const mentionQuery = React.useMemo(() => {
    if (!mentionPrefix || mentionDismissed) return null
    const match = new RegExp(`(?:^|\\s)\\${mentionPrefix}([^\\s]*)$`).exec(prompt)
    return match ? match[1] : null
  }, [mentionDismissed, mentionPrefix, prompt])

  const applySkillMention = (skill: WorkspaceSkill) => {
    const mention = renderSkillMention(skillIntegration, skill.id)
    if (!mention || !mentionPrefix) return
    setPrompt((current) => current.replace(new RegExp(`\\${mentionPrefix}[^\\s]*$`), `${mention} `))
    setMentionDismissed(true)
    promptRef.current?.focus()
  }

  // Switching CLIs re-renders mentions already typed in the new one's form.
  const previousPrefix = React.useRef(mentionPrefix)
  React.useEffect(() => {
    const before = previousPrefix.current
    previousPrefix.current = mentionPrefix
    if (!before || !mentionPrefix || before === mentionPrefix) return
    setPrompt((current) =>
      current.replace(new RegExp(`(^|\\s)\\${before}([A-Za-z0-9._-]+)`, 'g'), `$1${mentionPrefix}$2`),
    )
  }, [mentionPrefix])

  // Worktree is offered only inside a git repo: absent, not disabled.
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

  // ── What a launch would run, for Start's hover ───────────────────────────
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
          result.ok ? { status: 'ready', preview: result.preview } : { status: 'error', message: result.message },
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
    // previewKey is previewInput's identity; the object would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

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

  // Ask once per open, so a provider configured since last time shows up.
  React.useEffect(() => {
    onRequestConversationCatalog?.()
  }, [onRequestConversationCatalog])

  // Escape cancels from anywhere on the surface — the prompt is where focus
  // starts, but a person who has tabbed to a chip must not be trapped. The
  // `defaultPrevented` guard is the topmost-surface contract: an open popover or
  // the skill type-ahead handles its own Escape first, and only when nothing
  // did does this close.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    }
    // Escape is not handled here: the window listener above owns cancel, so it
    // works from every control on the surface rather than only this field.
  }

  // A plain shell runs nothing on its behalf: there is no prompt to give it and
  // no suggested task to start it with. Saying so beats a field that silently
  // drops what was typed.
  const isTerminalLaunch = selection.kind === 'terminal'
  const placeholder = isTerminalLaunch
    ? 'A shell opens with nothing typed'
    : mentionPrefix
      ? `Describe the task, or type ${mentionPrefix} for skills`
      : 'Describe the task, or pick one below'
  const accessLabel =
    AGENT_SPAWN_PERMISSION_OPTIONS.find((option) => option.value === permissionPreset)?.label ?? 'Permissions'
  const accessShort = accessLabel.split(' ')[0]

  if (composer.noAgentCliInstalled) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 py-10">
        <div className="mx-auto w-full max-w-[620px]">
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
    <div className="relative flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 pb-10 pt-8">
      {showCloseButton ? (
        <div className="absolute right-3 top-3">
          <CloseIconButton onClick={onClose} aria-label="Cancel" />
        </div>
      ) : null}
      <div className="@container mx-auto w-full max-w-[620px]">
        <div className="text-center">
          {/* icon-lg is the top of the icon scale and the step the system names for
            empty-state glyphs. There is no larger token, and an off-scale hero
            mark is what made this fill the pane. */}
        <SprintEngineFrond tone="current" className="icon-lg mx-auto text-[color:var(--text-strong)]" />
          <h1 className="mt-2.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
            {greeting}
          </h1>
          {/* State, not decoration: where this agent will run.
              Whether this is a PICKER is decided by what the host can do, never
              by what it currently has. Gating on `projectLabel` hid the control
              outright when no project was set, and gating on a non-empty
              `projectOptions` hid it when no other workspace happened to be
              open — so the two moments a person most needs to choose a project
              were the two moments the choice disappeared, taking the Browse
              escape hatch with it. A host that passes no project handlers (the
              tab strip's "+", which spawns into the workspace it was pressed
              in) still gets the plain line, because there its project is a fact
              rather than a choice. */}
          {canChooseProject ? (
            <ProjectScopePicker
              label={projectLabel ?? 'Choose a project'}
              branch={branch}
              options={projectOptions ?? []}
              selectedPath={workspaceRoot}
              onSelect={(path) => onSelectProject?.(path)}
              onBrowse={onBrowseProject}
            />
          ) : projectLabel ? (
            <p className="mt-1 text-meta text-[color:var(--text-subtle)]">
              {projectLabel}
              {branch ? ` · ${branch}` : ''}
            </p>
          ) : null}
        </div>

        <div className="relative mt-5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-3 pb-2 pt-2.5 focus-within:border-[color:var(--accent-primary)]">
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
            <span aria-hidden="true" className="mt-0.5 select-none font-mono text-body text-[color:var(--accent-primary)]">
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
              disabled={isTerminalLaunch}
              aria-label="What this agent should do"
              className="min-h-[44px] w-full flex-1 resize-none bg-transparent font-mono text-body leading-6 text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)]"
            />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-[color:var(--border-subtle)] pt-2">
            {/* Engine: the CLI's own mark, then the model. The mark is the
                identity — the word "claude" beside a Claude asterisk was saying
                it twice. */}
            {launchCli ? (
              <Popover
                open={enginePopoverOpen}
                onOpenChange={setEnginePopoverOpen}
                ariaLabel={`Engine: ${engineNames.cliLabel}`}
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
                    <CliIcon cli={launchCli} className="icon-xs" />
                    <TruncatedText
                      as="span"
                      text={engineNames.modelLabel ?? engineNames.cliLabel}
                      className="max-w-[150px]"
                    />
                    {reasoning ? (
                      <span className="text-[color:var(--text-subtle)]">· {reasoning}</span>
                    ) : null}
                    <ChevronGlyph />
                  </button>
                )}
              >
                {/* Reasoning effort is a property OF the model, so it lives in
                    the model's own picker (attached to the selected row, which
                    is where this surface already draws it) rather than as a
                    second control the row has to carry. */}
                <CliModelPopoverSurface
                  ariaLabel="Agent runtime"
                  options={composer.agentCliOptions}
                  currentCli={launchCli}
                  effectiveModelFor={(cli) => composer.modelForSelection(selection, cli)}
                  effectiveReasoningFor={(cli) => composer.reasoningForSelection(selection, cli)}
                  onSelectReasoning={(cli, next) => composer.setEngineReasoning(selection, cli, next)}
                  showReasoning
                  reasoningAriaLabel="Reasoning effort"
                  onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
                  onSelectModel={(cli, next) => composer.setEngineModel(selection, cli, next)}
                />
              </Popover>
            ) : null}

            {/* Access: one control carrying its value, shield-marked. Bypass is
                the only value that removes a safeguard, so it is the only one
                that changes colour. */}
            {selection.kind === 'terminal' ? null : (
              <Popover
                open={accessOpen}
                onOpenChange={setAccessOpen}
                ariaLabel={`Permissions: ${accessLabel}`}
                popupRole="menu"
                placement="bottom-start"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    className={`interactive inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-meta ${
                      permissionPreset === 'bypass'
                        ? 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn-on-tint)]'
                        : 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                    } ${FOCUS_RING_CLASS}`}
                    {...triggerProps}
                  >
                    <ShieldGlyph />
                    {accessShort}
                    <ChevronGlyph />
                  </button>
                )}
              >
                <div className="w-[264px] p-1" role="menu" aria-label="Permissions">
                  {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => (
                    <MenuRow
                      key={option.value}
                      selected={option.value === permissionPreset}
                      label={option.label}
                      hint={option.title}
                      onClick={() => {
                        onChangePermissionPreset(option.value)
                        setAccessOpen(false)
                      }}
                    />
                  ))}
                </div>
              </Popover>
            )}

            {/* Skill stays a chip only where it cannot be typed. */}
            {!mentionPrefix && selection.kind !== 'terminal' && workspaceRoot ? (
              composer.skillAttachment ? (
                <AttachmentChip
                  glyph={<StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />}
                  label={composer.skillAttachment.name}
                  removeLabel={`Remove skill ${composer.skillAttachment.name}`}
                  onRemove={() => composer.setSkillAttachment(null)}
                />
              ) : (
                <SkillAttachmentButton
                  workspaceRoot={workspaceRoot}
                  pluginId={launchCli}
                  onPick={(skill) => composer.setSkillAttachment(skill)}
                />
              )
            ) : null}

            {selection.kind === 'terminal' ? null : composer.connectorAttachment ? (
              <AttachmentChip
                glyph={
                  <McpBrandIcon
                    slug={mcpIconSlug(composer.connectorAttachment.id)}
                    name={composer.connectorAttachment.name}
                    icon={composer.connectorAttachment.icon}
                    size={13}
                  />
                }
                label={composer.connectorAttachment.name}
                removeLabel={`Remove connector ${composer.connectorAttachment.name}`}
                onRemove={() => composer.setConnectorAttachment(null)}
              />
            ) : (
              <ConnectorPickerPopover
                open={connectorPickerOpen}
                onOpenChange={setConnectorPickerOpen}
                onPick={(connector) => composer.setConnectorAttachment(connector)}
                placement="bottom-start"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button ref={ref} type="button" onClick={togglePopover} className={GHOST_CHIP_CLASS} {...triggerProps}>
                    + Connector
                  </button>
                )}
              />
            )}

            {/* Set rarities rise onto the row; unset ones live behind ⋯. */}
            {composer.worktreeName !== null ? (
              <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)]">
                <BranchGlyph />
                {/* Sized to what is typed, not a fixed field: a chip that
                    reserves 128px for a three-letter branch is what pushed this
                    row onto a second line. */}
                <input
                  value={composer.worktreeName}
                  size={Math.max(composer.worktreeName.length || 12, 3)}
                  onChange={(event) => composer.setWorktreeName(event.currentTarget.value)}
                  placeholder="branch name"
                  aria-label="Worktree name — leave empty to derive from the agent’s name"
                  className="max-w-[160px] bg-transparent text-meta outline-none placeholder:text-[color:var(--text-disabled)]"
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
            ) : null}
            {debugMode ? (
              <AttachmentChip
                glyph={<DebugGlyph />}
                label="Debug"
                removeLabel="Turn debug mode off"
                onRemove={() => onChangeDebugMode(false)}
              />
            ) : null}

            {/* Always rendered, whatever is selected: this menu is the only way
                to change WHAT is being launched, so hiding it for a terminal
                stranded the surface with no way back to an agent. */}
            {(
              <Popover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                ariaLabel="More launch options"
                popupRole="menu"
                placement="bottom-start"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button
                    ref={ref}
                    type="button"
                    aria-label="More launch options"
                    onClick={togglePopover}
                    className={`${GHOST_CHIP_CLASS} px-2`}
                    {...triggerProps}
                  >
                    ⋯
                  </button>
                )}
              >
                <MoreMenu
                  selection={selection}
                  conversationAvailable={conversationAvailable}
                  onSelectKind={(next) => {
                    composer.setSelection(next)
                    setMoreOpen(false)
                  }}
                  onOpenProviderSettings={() => {
                    setMoreOpen(false)
                    openSettingsOverlay({ initialTab: 'agents' })
                  }}
                  worktreeName={composer.worktreeName}
                  onToggleWorktree={() =>
                    composer.setWorktreeName(composer.worktreeName === null ? '' : null)
                  }
                  onChangeWorktree={composer.setWorktreeName}
                  worktreeAvailable={workspaceIsGitRepo}
                  debugMode={debugMode}
                  onToggleDebug={() => onChangeDebugMode(!debugMode)}
                />
              </Popover>
            )}

            <span className="flex-1" />

            {/* The invocation lives on Start's hover: the one moment someone
                asks "what am I about to run?", and it answers with the line
                main renders through the spawn's own argv renderer. */}
            <Tooltip
              content={
                selection.kind === 'terminal'
                  ? 'Opens a shell in this folder'
                  : selection.kind === 'conversation'
                    ? 'Starts a conversation agent — pick its model in the chat'
                    : commandLine.status === 'ready'
                      ? commandLine.preview.display
                      : commandLine.status === 'error'
                        ? commandLine.message
                        : 'Reading this agent’s launch command…'
              }
              placement="top"
              multiline
            >
              {/* The key that starts it, not the word "Start" and not a chat
                  send-arrow: this launches a command, and a circle-arrow is the
                  idiom for posting a message into a thread. The glyph names the
                  keyboard path, so the shortcut stops being invisible, and the
                  accessible name carries the verb for anyone who cannot see it. */}
              <button
                type="button"
                onClick={() => launch(prompt)}
                disabled={!canLaunch}
                aria-label="Start agent"
                aria-keyshortcuts="Enter"
                className={`interactive grid h-7 w-7 shrink-0 place-items-center rounded bg-[color:var(--accent-primary)] font-mono text-meta text-[color:var(--text-on-accent)] disabled:cursor-not-allowed disabled:bg-[color:var(--bg-active)] disabled:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
              >
                <span aria-hidden="true">⏎</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {isTerminalLaunch ? null : (
          <div className="mt-4 grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
            {suggestions.map((entry) => (
              <SuggestionCard key={entry.id} entry={entry} disabled={!canLaunch} onLaunch={() => launch(entry.prompt)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────

const GHOST_CHIP_CLASS =
  'interactive inline-flex items-center gap-1 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] focus-visible:focus-ring'

function ChevronGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--text-subtle)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6.5 4 3.5 4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ShieldGlyph() {
  return (
    <svg className="icon-xs" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.8 2.8 4v4c0 2.7 2.2 4.7 5.2 5.4 3-0.7 5.2-2.7 5.2-5.4V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
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




function DebugGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--accent-primary)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="6" height="7" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 7.5h2.5M11 7.5h2.5M2.5 11h2.5M11 11h2.5M8 2.5V5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** The scope line as a control: the projects open here, plus Browse. */
function ProjectScopePicker({
  label,
  branch,
  options,
  selectedPath,
  onSelect,
  onBrowse,
}: {
  label: string
  branch: string | null
  options: NewAgentProjectOption[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onBrowse?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Project this agent runs in"
      popupRole="menu"
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className={`interactive mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {label}
          {branch ? ` · ${branch}` : ''}
          <ChevronGlyph />
        </button>
      )}
    >
      <div className="w-[264px] p-1" role="menu" aria-label="Projects">
        {options.map((option) => (
          <MenuRow
            key={option.path}
            selected={option.path === selectedPath}
            label={option.label}
            onClick={() => {
              onSelect(option.path)
              setOpen(false)
            }}
          />
        ))}
        {onBrowse ? (
          <>
            <div className="my-1 border-t border-[color:var(--border-subtle)]" />
            <MenuRow
              selected={false}
              label="Browse…"
              onClick={() => {
                onBrowse()
                setOpen(false)
              }}
            />
          </>
        ) : null}
      </div>
    </Popover>
  )
}

/**
 * The ⋯ surface: what a launch rarely changes. Two rows now — the role picker
 * left with the specialists (a role is a way of working, which is what a skill
 * is), and reasoning effort went into the model's own picker, where it is a
 * property of the model rather than a second control the row must carry.
 */
function MoreMenu({
  selection,
  conversationAvailable,
  onSelectKind,
  onOpenProviderSettings,
  worktreeName,
  onToggleWorktree,
  onChangeWorktree,
  worktreeAvailable,
  debugMode,
  onToggleDebug,
}: {
  selection: AgentComposerSelection
  conversationAvailable: boolean
  onSelectKind: (next: AgentComposerSelection) => void
  onOpenProviderSettings: () => void
  worktreeName: string | null
  onToggleWorktree: () => void
  onChangeWorktree: (next: string | null) => void
  worktreeAvailable: boolean
  debugMode: boolean
  onToggleDebug: () => void
}) {
  const worktreeRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="w-[264px] p-1" role="menu" aria-label="More launch options">
      {/* What is being launched. An agent is the answer nearly every time, so it
          stays the default and lives here rather than on the row — but a plain
          shell and a conversation agent have to be reachable somewhere, and this
          is the surface that starts them. */}
      <MenuRow
        selected={selection.kind !== 'terminal' && selection.kind !== 'conversation'}
        label="Agent"
        hint="A CLI agent, in a terminal"
        onClick={() => onSelectKind({ kind: 'general' })}
      />
      <MenuRow
        selected={selection.kind === 'terminal'}
        label="Terminal"
        hint="A plain shell — no agent"
        onClick={() => onSelectKind({ kind: 'terminal' })}
      />
      {/* Always listed, never silently absent. Hiding it when no provider is
          configured left the option looking unimplemented rather than
          unconfigured — the same reason the roster shows an install route
          instead of dropping the CLI rows. */}
      <MenuRow
        selected={selection.kind === 'conversation'}
        disabled={!conversationAvailable}
        // "Chat", not "Conversation agent": the trio reads as what you GET —
        // an agent in a terminal, a plain shell, or an agent in a window — and
        // "conversational agent" names the mechanism instead. The app already
        // calls this door New chat and renders it through AgentChatView.
        label="Chat"
        hint={
          conversationAvailable
            ? 'An agent in a chat window — no terminal'
            : 'Needs a model provider — connect one in Settings'
        }
        onClick={() => {
          if (conversationAvailable) onSelectKind({ kind: 'conversation' })
          else onOpenProviderSettings()
        }}
      />
      <div className="my-1 border-t border-[color:var(--border-subtle)]" />

      {/* A conversation has no repo checkout of its own, so no worktree. */}
      {worktreeAvailable && selection.kind !== 'conversation' ? (
        <>
          <MenuValueRow
            label="Worktree"
            value={worktreeName === null ? 'Off' : worktreeName || 'Named on start'}
            expanded={worktreeName !== null}
            onClick={() => {
              onToggleWorktree()
              // Opening it puts the caret where the name goes — the click that
              // turns it on is the same click that starts typing.
              if (worktreeName === null) {
                window.requestAnimationFrame(() => worktreeRef.current?.focus())
              }
            }}
          />
          {/* The reveal is the app's "just changed" motion, and it collapses to
              nothing when off rather than reserving the row. */}
          <div
            className={`grid transition-[grid-template-rows,opacity] duration-[var(--motion-normal)] ease-[var(--motion-ease)] ${
              worktreeName === null ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            }`}
          >
            <div className="overflow-hidden">
              <input
                ref={worktreeRef}
                value={worktreeName ?? ''}
                onChange={(event) => onChangeWorktree(event.currentTarget.value)}
                placeholder="Branch name — blank uses the agent’s"
                aria-label="Worktree branch name"
                aria-hidden={worktreeName === null}
                tabIndex={worktreeName === null ? -1 : 0}
                className={`mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-meta text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] ${FOCUS_RING_CLASS}`}
              />
            </div>
          </div>
          <div className="my-1 border-t border-[color:var(--border-subtle)]" />
        </>
      ) : null}

      <MenuRow
        selected={debugMode}
        label="Debug mode"
        // Not about debugging the agent: it hands the agent the debug skill's
        // state machine to find a bug in YOUR software, instrumenting the code
        // and removing every tag before it finishes.
        hint="The agent instruments your code, works the debug loop, then cleans up"
        onClick={onToggleDebug}
      />
    </div>
  )
}


function MenuValueRow({
  label,
  value,
  expanded = false,
  onClick,
}: {
  label: string
  value: string
  expanded?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded || undefined}
      className={`interactive flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className="max-w-[110px] shrink-0 truncate text-[color:var(--text-subtle)]">{value}</span>
      <span aria-hidden="true" className="shrink-0 text-micro text-[color:var(--text-disabled)]">›</span>
    </button>
  )
}

function AttachmentChip({
  glyph,
  label,
  removeLabel,
  onRemove,
}: {
  glyph: React.ReactNode
  label: string
  removeLabel: string
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
      {glyph}
      <TruncatedText as="span" text={label} className="max-w-[140px]" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
      >
        ×
      </button>
    </span>
  )
}

function MenuRow({
  selected,
  disabled = false,
  label,
  hint,
  onClick,
}: {
  selected: boolean
  /** Listed but not choosable yet — the hint says what is missing. */
  disabled?: boolean
  label: string
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={`interactive flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta ${
        disabled
          ? 'text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)]'
          : selected
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
      } ${FOCUS_RING_CLASS}`}
    >
      {/* The hint WRAPS rather than truncating. A menu row is 264px and these
          sentences are the whole explanation — "connect one in S…" and "works
          the…" told nobody anything, and a tooltip to recover a sentence the
          surface had room for is a worse answer than two lines. */}
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-micro leading-snug text-[color:var(--text-subtle)]">{hint}</span>
        ) : null}
      </span>
      {selected && !disabled ? (
        <span className="shrink-0 text-[color:var(--accent-primary)]">✓</span>
      ) : null}
    </button>
  )
}

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
        <button ref={ref} type="button" onClick={togglePopover} className={GHOST_CHIP_CLASS} {...triggerProps}>
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
      <span className="mt-1.5 inline-block rounded border border-[color:var(--border-default)] px-1.5 text-micro text-[color:var(--text-subtle)]">
        {entry.outcome}
      </span>
    </button>
  )
}
