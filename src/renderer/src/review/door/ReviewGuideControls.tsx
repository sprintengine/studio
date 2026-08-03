import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { ReviewBriefRunDepth } from '../../../../shared/electron-api'
import type { AgentCli } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { CliModelPickerButton } from '../../components/ui/CliModelPicker'
import { Drawer } from '../../components/ui/Drawer'
import { GhostButton, PrimaryButton } from '../../components/ui/Buttons'
import { KbdChord } from '../../components/ui/KbdChord'
import { SegmentedControl, type SegmentedControlItem } from '../../components/ui/SegmentedControl'
import { Spinner } from '../../components/ui/Spinner'
import { FOCUS_RING_CLASS } from '../../components/ui/tokens'
import {
  resolveAvailableAgentCli,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
} from '../../components/workspace/newWorkspace/cliRuntimeOptions'
import { RUN_PHASE_LABEL } from '../canvas/ReviewCanvas'
import type { ReviewSession } from '../canvas/useReviewSession'
import { StopGuideRunButton } from './ReviewGuideStop'
import type { GuideTerminalLink } from './useGuideTerminal'
import { useReviewGuideDefaults, writeReviewGuideDefaults } from './reviewAppState'

// The store-bound guide controls on the Reviews door (MC-1783). The canvas stays
// a pure projection of a session, so everything that needs the plugin catalog,
// the settings slice, or the layout registry lives here and reaches the canvas
// through its `guideActions` slot.

// The two preparation choices, and the controls that change them (MC-1788): how
// deep a walkthrough to build, and which agent builds it. Both are persisted in
// this module's own app-level state (reviewAppState), so the next review opens
// on the pair the reviewer used last and a freshness re-run reuses them without
// asking. That key is deliberately
// separate from `lastSelectedCli`: picking a guide agent must not change what
// "New chat" spawns. A first-time reviewer, having picked nothing, gets the agent
// CLI they use elsewhere rather than a hardcoded engine.
export interface ReviewGuideRuntime {
  depth: ReviewBriefRunDepth
  cli: AgentCli
  model?: string
  catalog: AgentCliCatalogOption[]
  setDepth: (depth: ReviewBriefRunDepth) => void
  setCli: (cli: AgentCli) => void
  setModel: (cli: AgentCli, model: string | null) => void
}

export function useReviewGuideRuntime(): ReviewGuideRuntime {
  const cliRuntimes = useWorkspaceStore((state) => state.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((state) => state.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((state) => state.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((state) => state.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((state) => state.cliAvailabilityStatus)
  const lastSelectedCli = useWorkspaceStore((state) => state.appSettings.lastSelectedCli)
  const defaults = useReviewGuideDefaults()

  // The same catalog every other spawn picker offers, filtered to the CLIs whose
  // binary is actually installed — offering the guide an engine that is not there
  // just moves the failure to the terminal.
  const catalog = useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus],
  )
  // A remembered CLI that is no longer installed falls back to the first entry the
  // catalog does offer, so the picker never opens on a runtime that cannot run.
  const cli = resolveAvailableAgentCli(defaults.cli ?? lastSelectedCli, catalog, catalog[0]?.value ?? lastSelectedCli)

  const setDepth = useCallback((depth: ReviewBriefRunDepth) => writeReviewGuideDefaults({ depth }), [])
  // A new engine drops the model picked for the previous one; a model pick keeps
  // the engine it belongs to. Both write through the same normalizing setter.
  const setCli = useCallback((next: AgentCli) => writeReviewGuideDefaults({ cli: next, model: null }), [])
  const setModel = useCallback(
    (nextCli: AgentCli, nextModel: string | null) =>
      writeReviewGuideDefaults({ cli: nextCli, model: nextModel }),
    [],
  )

  return {
    depth: defaults.depth,
    cli,
    // Model ids are only meaningful for the CLI they were picked for — a stored
    // model whose engine has since fallen out of the catalog is not offered.
    ...(defaults.model && defaults.cli === cli ? { model: defaults.model } : {}),
    catalog,
    setDepth,
    setCli,
    setModel,
  }
}

// Depth in the reviewer's words. The wire values are the ones the guide skill
// renders against (`brief` / `standard` / `thorough`); these labels and one-liners
// say what each actually produces, so the choice is legible without opening the
// skill. Kept to three so the segmented control stays scannable.
const DEPTH_SEGMENTS: SegmentedControlItem<ReviewBriefRunDepth>[] = [
  { value: 'brief', label: 'Overview' },
  { value: 'standard', label: 'Standard' },
  { value: 'thorough', label: 'Deep' },
]

const DEPTH_HINT: Record<ReviewBriefRunDepth, string> = {
  brief: 'Steps and files with the reason for each — the fastest way in.',
  standard: 'Adds notes on the lines worth pausing on, and a change map.',
  thorough: 'Adds the detail behind each note and links to project knowledge.',
}

// The action side of the guide banner: the two preparation choices and Prepare,
// or — while a guide is working — the way into the terminal where it is working
// and the way to end it. The message side (resting / working / failed) stays with
// the canvas. The choices sit here, at the moment of invoking the guide, rather
// than in a settings tab: they are per-review decisions that happen to be
// remembered, not configuration. The depth one-liner sits under the control it
// describes so the difference between the three is on screen, not in a tooltip.
export function ReviewGuideActions({
  session,
  runtime,
  terminal,
}: {
  session: ReviewSession
  runtime: ReviewGuideRuntime
  terminal: GuideTerminalLink
}): JSX.Element | null {
  // The depth line is visible copy AND the group's description, so a screen
  // reader hears what the selected depth produces, not just its one-word label.
  const depthHintId = useId()
  // While the guide works there is nothing to configure: only the terminal it is
  // working in, which is where its progress really is, and the way to end it. Stop
  // is trailing — the terminal link is the frequent action, Stop ends the row
  // because it ends the run — and it stands alone when no terminal link resolves
  // (a run seeded from the main process on remount carries no coordinates), so a
  // working guide is never an affordance with no exit.
  if (session.run.running) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        {/* What the guide is doing right now. It rode the canvas's status band
            before that band went; the phase belongs beside the controls that act
            on the run, which is here. */}
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
          <Spinner />
          {RUN_PHASE_LABEL[session.run.phase ?? 'reading'] ?? RUN_PHASE_LABEL.grouping}
        </span>
        {terminal.terminal ? (
          <GhostButton onClick={() => void terminal.open()} className="shrink-0">
            Open the guide’s terminal
          </GhostButton>
        ) : null}
        <StopGuideRunButton session={session} />
      </span>
    )
  }
  const failed = Boolean(session.run.error)
  return (
    <span className="flex shrink-0 items-center gap-2">
      <SegmentedControl
        ariaLabel="Walkthrough depth"
        ariaDescribedBy={depthHintId}
        items={DEPTH_SEGMENTS}
        value={runtime.depth}
        onChange={runtime.setDepth}
        size="sm"
      />
      <CliModelPickerButton
        ariaLabel="Guide agent"
        options={runtime.catalog}
        cli={runtime.cli}
        effectiveModelFor={(candidate) => (candidate === runtime.cli ? runtime.model : undefined)}
        onSelectCli={runtime.setCli}
        onSelectModel={(nextCli, nextModel) => {
          if (nextCli !== runtime.cli) runtime.setCli(nextCli)
          runtime.setModel(nextCli, nextModel)
        }}
      />
      <PrimaryButton onClick={session.startRun} className="shrink-0">
        {failed ? 'Try again' : 'Prepare walkthrough'}
      </PrimaryButton>
      {/* The depth one-liner is the control's accessible description only. On
          screen the three segment labels are the difference; a caption spelling
          out what "Standard" adds was a sentence explaining a control that is
          right there, and it forced the whole cluster into two rows. */}
      <span id={depthHintId} className="sr-only">
        {DEPTH_HINT[runtime.depth]}
      </span>
    </span>
  )
}

// The primary (submit) modifier named for the platform, matching the comment
// composer's chord. Safe when window is absent (static render).
const PRIMARY_KEY = typeof window !== 'undefined' && window.api?.platform === 'darwin' ? 'Cmd' : 'Ctrl'

// "Ask the guide" — one question, delivered to the guide's terminal. There is no
// thread here on purpose: the guide is an ordinary terminal agent and its answer
// belongs in its terminal, which this drawer sends the reviewer to. Nothing in
// this path can create or edit a review comment; the guide answers, the human
// writes the comments.
export function AskGuideDrawer({
  session,
  terminal,
}: {
  session: ReviewSession
  terminal: GuideTerminalLink
}): JSX.Element {
  const { askController } = session
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Seed the composer when a note card opens the drawer with a quoted anchor. The
  // nonce re-applies the same quote on a repeat click.
  useEffect(() => {
    if (!askController.prefill) return
    setDraft(askController.prefill.text)
    const node = inputRef.current
    if (node) {
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    }
  }, [askController.prefill?.nonce])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || sending) return
    setError(null)
    setSending(true)
    const result = await session.askGuide(message)
    setSending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // Delivered: close the composer and land the reviewer where the answer will
    // appear. A guide whose project is closed has no terminal to focus, and the
    // question still reached it — so this never blocks on the link.
    setDraft('')
    askController.setOpen(false)
    void terminal.open()
  }, [draft, sending, session, askController, terminal])

  return (
    <Drawer
      open={askController.open}
      onClose={() => askController.setOpen(false)}
      title="Ask the guide"
      ariaLabel="Ask the review guide about this change"
      width={380}
    >
      <Drawer.Body className="flex flex-col">
        <p className="text-meta leading-5 text-[color:var(--text-muted)]">
          Your question goes to the guide’s terminal, and it answers there. Sending opens that terminal.
        </p>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
          aria-label="Your question for the guide"
          placeholder="Ask about any line, step, or decision…"
          rows={6}
          className={`mt-3 min-h-[120px] flex-1 resize-none rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-body leading-5 text-[color:var(--text-strong)] focus:border-[color:var(--border-focus)] ${FOCUS_RING_CLASS}`}
        />
        {error ? (
          <p className="mt-2 text-micro leading-4 text-[color:var(--tone-error)]">The guide couldn’t be reached: {error}</p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-micro text-[color:var(--text-subtle)]">
            <KbdChord keys={[PRIMARY_KEY, 'Enter']} /> send
          </span>
          <PrimaryButton onClick={() => void send()} disabled={!draft.trim() || sending} className="shrink-0">
            {sending ? 'Sending…' : 'Send'}
          </PrimaryButton>
        </div>
      </Drawer.Body>
    </Drawer>
  )
}
