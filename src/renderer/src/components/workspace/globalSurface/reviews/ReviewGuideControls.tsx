import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentCli } from '../../../../types/workspace'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { CliModelPickerButton } from '../../../ui/CliModelListbox'
import { Drawer } from '../../../ui/Drawer'
import { GhostButton, PrimaryButton } from '../../../ui/Buttons'
import { KbdChord } from '../../../ui/KbdChord'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import {
  resolveAvailableAgentCli,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
} from '../../newWorkspace/cliRuntimeOptions'
import type { ReviewSession } from '../../../panels/review/useReviewSession'
import type { GuideTerminalLink } from './useGuideTerminal'

// The store-bound guide controls on the Reviews door (MC-1783). The canvas stays
// a pure projection of a session, so everything that needs the plugin catalog,
// the settings slice, or the layout registry lives here and reaches the canvas
// through its `guideActions` slot.

// Which runtime the guide runs under, plus the picker that changes it. The default
// is the agent CLI the reviewer used last (`lastSelectedCli`), so it is the engine
// they actually work with rather than a hardcoded one; an explicit pick overrides
// it for as long as the door is open. T11 turns that pick into a persisted
// review-guide default (with depth), which is why nothing here writes settings —
// changing the guide's agent must not silently change what "New chat" spawns.
export interface ReviewGuideRuntime {
  cli: AgentCli
  model?: string
  catalog: AgentCliCatalogOption[]
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
  const [picked, setPicked] = useState<{ cli: AgentCli; model?: string } | null>(null)

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
  const cli = resolveAvailableAgentCli(picked?.cli ?? lastSelectedCli, catalog, catalog[0]?.value ?? lastSelectedCli)

  const setCli = useCallback((next: AgentCli) => setPicked({ cli: next }), [])
  const setModel = useCallback(
    (nextCli: AgentCli, nextModel: string | null) =>
      setPicked(nextModel ? { cli: nextCli, model: nextModel } : { cli: nextCli }),
    [],
  )

  return {
    cli,
    // Model ids are only meaningful for the CLI they were picked for.
    ...(picked?.model && picked.cli === cli ? { model: picked.model } : {}),
    catalog,
    setCli,
    setModel,
  }
}

// The action side of the guide banner: pick the runtime and prepare, or — while a
// guide is working — the one link that matters, into the terminal where it is
// working. The message side (resting / working / failed) stays with the canvas.
export function ReviewGuideActions({
  session,
  runtime,
  terminal,
}: {
  session: ReviewSession
  runtime: ReviewGuideRuntime
  terminal: GuideTerminalLink
}): JSX.Element | null {
  // While the guide works there is nothing to configure and nothing to press —
  // only the terminal it is working in, which is where its progress really is.
  if (session.run.running) {
    if (!terminal.terminal) return null
    return (
      <GhostButton onClick={terminal.open} className="shrink-0">
        Open the guide’s terminal
      </GhostButton>
    )
  }
  const failed = Boolean(session.run.error)
  return (
    <>
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
    </>
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
    terminal.open()
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
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
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
          className={`mt-3 min-h-[120px] flex-1 resize-none rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12.5px] leading-5 text-[color:var(--text-strong)] focus:border-[color:var(--border-focus)] ${FOCUS_RING_CLASS}`}
        />
        {error ? (
          <p className="mt-2 text-[11px] leading-4 text-[color:var(--tone-error)]">The guide couldn’t be reached: {error}</p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[11px] text-[color:var(--text-subtle)]">
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
