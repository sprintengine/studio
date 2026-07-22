import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type {
  ChangeSetFile,
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
} from '../../../../../shared/review'
import { Drawer } from '../../ui/Drawer'
import { KbdChord } from '../../ui/KbdChord'
import { TopBar } from './TopBar'
import { StepRail } from './StepRail'
import { StepPane } from './StepPane'
import { OverviewPane } from './OverviewPane'
import { ChangeMapView } from './ChangeMapView'
import { AnnotationsPanel } from './AnnotationsPanel'
import { ReviewTray, type ReviewPostPhase } from './ReviewTray'
import { pendingCommentCount } from './commentModel'
import { anchorRangeLabel } from './anchorLabel'
import {
  OVERVIEW_PANE_ID,
  buildRailModel,
  orderedSteps,
  sourceIdentity,
  statsChip,
} from './reviewSelectors'

// The chat pane pulls the shared conversation projection (and its dependency
// tree); keep it out of the eager walkthrough chunk and the pure fixture harness,
// mirroring how the Monaco diff editor is lazily loaded.
const AskGuidePane = lazy(() => import('./AskGuidePane'))

export interface ReviewWalkthroughProps {
  changeset: ReviewChangeSet
  brief: ReviewBrief
  // Controlled reviewer state — the container owns persistence.
  readFiles: ReadonlySet<string>
  diffView: DiffView
  activePaneId: string
  monacoTheme: 'vs' | 'vs-dark'
  rerunning: boolean
  onSetActivePane: (id: string) => void
  onSetDiffView: (view: DiffView) => void
  onToggleRead: (path: string) => void
  onRequestComment: (path: string, line: number) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
  onRerun: () => void
  // MC-1682 fills this reserved slot under the top bar with the freshness banner.
  bannerSlot?: ReactNode
  // The human's review (MC-1681). Present together: the comments plus the CRUD
  // handlers wire the inline composer/threads and the "Your review" tray. Absent
  // (the pure T7 harness) leaves the surface read-only.
  comments?: ReviewComment[]
  onCreateComment?: (path: string, anchor: ReviewAnchor, body: string) => void
  onEditComment?: (id: string, body: string) => void
  onDeleteComment?: (id: string) => void
  // Posting the pending review to the pull request (MC-1683). Present only for
  // pull-request sources the container can post; absent leaves the tray with
  // Copy-as-markdown alone. `postState` renders the in-flight / failed batch.
  onPostReview?: () => void
  postState?: ReviewPostPhase
  // Identity of the guide companion to chat with (MC-1681/MC-1684). Present
  // together: with both the "Ask the guide" chat opens; absent it stays hidden.
  workspaceId?: string
  workspaceRoot?: string
  // Chrome ownership (MC-1708 T6). On the full-page Reviews door the surface bar
  // folds in the walkthrough's own top-bar actions, so the walkthrough drops its
  // TopBar and lets the surface drive the tray/chat drawers. Omitted (the pure
  // harness and any standalone mount) the walkthrough keeps its TopBar and owns the
  // drawer state itself — the controllers below stay internal.
  hideTopBar?: boolean
  trayController?: ReviewDrawerController
  chatController?: ReviewChatController
}

// The container drives the "Your review" tray open/closed so its trigger can live
// in the folded surface bar instead of the walkthrough's own top bar.
export interface ReviewDrawerController {
  open: boolean
  setOpen: (open: boolean) => void
}

// Same for the guide chat, plus the "Ask the guide" from a note/summary card:
// `askFromCard` opens the chat pre-quoted at that annotation. The prefill (with
// its re-apply nonce) lives with the container so the surface-bar "Ask the guide"
// button can open a clean composer.
export interface ReviewChatController extends ReviewDrawerController {
  prefill?: { text: string; nonce: number }
  askFromCard: (annotation: ReviewAnnotation) => void
}

// The guided walkthrough — a pure projection of a validated changeset + brief +
// reviewer state. It renders no judgments and takes no action on the code: three
// columns (step rail, active pane, the step's notes) under a source-identity top
// bar. All mutation flows up through callbacks the container wires to state.
export function ReviewWalkthrough({
  changeset,
  brief,
  readFiles,
  diffView,
  activePaneId,
  monacoTheme,
  rerunning,
  onSetActivePane,
  onSetDiffView,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onRerun,
  bannerSlot,
  comments = [],
  onCreateComment,
  onEditComment,
  onDeleteComment,
  onPostReview,
  postState,
  workspaceId,
  workspaceRoot,
  hideTopBar = false,
  trayController,
  chatController,
}: ReviewWalkthroughProps) {
  const commentsEnabled = Boolean(onCreateComment)
  const chatEnabled = Boolean(workspaceId && workspaceRoot)
  // Drawer open state: controlled by the surface when it owns the folded bar
  // (Reviews door), internal otherwise (harness / standalone). Resolving both here
  // keeps every drawer trigger below agnostic to who owns the chrome.
  const [internalTrayOpen, setInternalTrayOpen] = useState(false)
  const [internalChatOpen, setInternalChatOpen] = useState(false)
  // A prefill quote for the chat composer; the nonce re-applies the same quote on
  // a repeat "Ask the guide" click without needing to clear it first.
  const [internalChatPrefill, setInternalChatPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined)
  const prefillNonce = useRef(0)

  const trayOpen = trayController ? trayController.open : internalTrayOpen
  const setTrayOpen = trayController ? trayController.setOpen : setInternalTrayOpen
  const chatOpen = chatController ? chatController.open : internalChatOpen
  const setChatOpen = chatController ? chatController.setOpen : setInternalChatOpen
  const chatPrefill = chatController ? chatController.prefill : internalChatPrefill
  const changedPaths = useMemo(() => changeset.files.map((file) => file.path), [changeset])

  const steps = useMemo(() => orderedSteps(brief), [brief])
  // The change map is a projection of the same steps + nav the rail uses; build
  // it here where both are in scope, and hand it to the Overview's reserved slot.
  const changeMapSlot = brief.changeMap ? (
    <ChangeMapView
      changeMap={brief.changeMap}
      orderedStepIds={steps.map((step) => step.id)}
      onNavigate={onSetActivePane}
    />
  ) : null
  const rail = useMemo(() => buildRailModel(changeset, brief, readFiles), [changeset, brief, readFiles])
  const fileByPath = useMemo(
    () => new Map<string, ChangeSetFile>(changeset.files.map((file) => [file.path, file])),
    [changeset],
  )
  const paneOrder = useMemo(() => [OVERVIEW_PANE_ID, ...steps.map((step) => step.id)], [steps])
  const activeStep = steps.find((step) => step.id === activePaneId) ?? null

  const revealMapRef = useRef<Map<string, (line: number) => void>>(new Map())
  const centerRef = useRef<HTMLDivElement | null>(null)

  const registerReveal = useCallback((path: string, reveal: ((line: number) => void) | null) => {
    if (reveal) revealMapRef.current.set(path, reveal)
    else revealMapRef.current.delete(path)
  }, [])

  // Orphaned annotations already show in the side panel (which lists every step
  // annotation); this hook is the reporting sink so the surface stays quiet.
  const handleOrphans = useCallback(() => {}, [])

  // Scroll a file card into view and reveal a real new-side line inside its diff.
  // The center pane is the only scroll container, so a card jump plus the editor's
  // registered reveal fn lands the reader on the exact line.
  const jumpToLine = useCallback((path: string, line: number) => {
    const card = centerRef.current?.querySelector<HTMLElement>(`[data-review-file="${path}"]`)
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    revealMapRef.current.get(path)?.(line)
  }, [])

  const handleJumpTo = useCallback(
    (annotation: ReviewAnnotation) => jumpToLine(annotation.path, annotation.anchor.startLine),
    [jumpToLine],
  )

  // "Ask the guide" from a note or summary card: open the chat with the anchor
  // pre-quoted so the question arrives grounded. Falls back to the caller's
  // handler when the chat is not wired (the pure harness).
  const handleAskGuide = useCallback(
    (annotation: ReviewAnnotation) => {
      if (!chatEnabled) {
        onAskGuide(annotation)
        return
      }
      // When the surface owns the chat, hand the annotation up so its prefill +
      // nonce live with the folded bar's "Ask the guide" control.
      if (chatController) {
        chatController.askFromCard(annotation)
        return
      }
      prefillNonce.current += 1
      setInternalChatPrefill({
        text: `> ${annotation.path} ${anchorRangeLabel(annotation.anchor)}\n\n`,
        nonce: prefillNonce.current,
      })
      setInternalChatOpen(true)
    },
    [chatEnabled, onAskGuide, chatController],
  )

  // Jump from a chat citation into the walkthrough: close the chat so the lines
  // are visible, then reveal them.
  const handleChatJump = useCallback(
    (path: string, line: number) => {
      setChatOpen(false)
      // Let the drawer begin closing before scrolling the pane underneath.
      window.requestAnimationFrame(() => jumpToLine(path, line))
    },
    [jumpToLine],
  )

  // [ and ] step through the panes (Overview + steps), skipping when focus is in a
  // text field or code editor so the keys insert the character while the reviewer
  // is typing (comment composer, guide chat, Monaco) instead of switching panes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '[' && event.key !== ']') return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || target.closest('input, textarea, select, .monaco-editor'))
      )
        return
      const current = paneOrder.indexOf(activePaneId)
      if (current === -1) return
      const next = event.key === ']' ? current + 1 : current - 1
      if (next < 0 || next >= paneOrder.length) return
      event.preventDefault()
      onSetActivePane(paneOrder[next])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paneOrder, activePaneId, onSetActivePane])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[color:var(--bg-surface)]">
      {/* The folded Reviews-door surface bar carries these actions instead, so it
          suppresses this bar to keep a single bar (MC-1708 T6). */}
      {hideTopBar ? null : (
        <TopBar
          title={changeset.title}
          source={sourceIdentity(changeset)}
          stats={statsChip(changeset)}
          complexity={brief.overview.complexity}
          diffView={diffView}
          onSetDiffView={onSetDiffView}
          onRerun={onRerun}
          rerunning={rerunning}
          reviewCount={pendingCommentCount(comments)}
          onOpenReview={commentsEnabled ? () => setTrayOpen(true) : undefined}
          onOpenChat={
            chatEnabled
              ? () => {
                  // Open a clean composer; drop any quote left from a prior "Ask the
                  // guide" so the drawer does not remount with a stale prefill. This
                  // bar renders only when the walkthrough owns its own chrome, so the
                  // drawer state is always the internal one here.
                  setInternalChatPrefill(undefined)
                  setInternalChatOpen(true)
                }
              : undefined
          }
        />
      )}
      {bannerSlot}
      {/* Container query, not a window media query: the walkthrough opens in split
          and narrow panes, so the collapse keys off THIS panel's width. Below
          940px the rail narrows (244→210px) and the right "In this step" column
          drops so the diff — the primary content — keeps its width. Mirrors the
          mockup's ≤940px breakpoint. The container sits under the root so it never
          captures the fixed-position drawers below. */}
      <div className="@container min-h-0 flex-1">
        <div className="grid h-full grid-cols-[210px_minmax(0,1fr)] @[940px]:grid-cols-[244px_minmax(0,1fr)_276px]">
          <StepRail rail={rail} activePaneId={activePaneId} onSelectPane={onSetActivePane} />
          <div ref={centerRef} className="min-w-0 overflow-y-auto px-6 py-5">
            <ShortcutHints inStep={Boolean(activeStep)} commentsEnabled={commentsEnabled} />
            <div key={activePaneId} className="review-pane-enter">
              {activeStep ? (
                <StepPane
                  step={activeStep}
                  fileByPath={fileByPath}
                  readFiles={readFiles}
                  diffView={diffView}
                  monacoTheme={monacoTheme}
                  onToggleRead={onToggleRead}
                  onRequestComment={onRequestComment}
                  onAskGuide={handleAskGuide}
                  onOrphans={handleOrphans}
                  registerReveal={registerReveal}
                  comments={comments}
                  onCreateComment={onCreateComment}
                  onEditComment={onEditComment}
                  onDeleteComment={onDeleteComment}
                />
              ) : (
                <OverviewPane
                  overview={brief.overview}
                  knowledgeRefs={brief.knowledgeRefs}
                  unassignedPaths={brief.coverage.unassignedPaths}
                  changeMapSlot={changeMapSlot}
                />
              )}
            </div>
          </div>
          <div className="hidden min-h-0 @[940px]:block">
            {activeStep ? (
              <AnnotationsPanel annotations={activeStep.annotations} onJumpTo={handleJumpTo} onAskGuide={handleAskGuide} />
            ) : (
              <div className="h-full border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4 py-4">
                <span className="mb-2.5 block text-[11px] font-medium text-[color:var(--text-subtle)]">In this step</span>
                <p className="text-[12px] leading-5 text-[color:var(--text-subtle)]">
                  Pick a step to see the guide’s notes for it.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {commentsEnabled ? (
        <Drawer
          open={trayOpen}
          onClose={() => setTrayOpen(false)}
          title="Your review"
          ariaLabel="Your pending review comments"
          width={440}
        >
          <Drawer.Body>
            <ReviewTray comments={comments} changeset={changeset} onPost={onPostReview} postState={postState} />
          </Drawer.Body>
        </Drawer>
      ) : null}

      {chatEnabled && workspaceId && workspaceRoot ? (
        <Drawer
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          title="Ask the guide"
          ariaLabel="Ask the review guide about this change"
          width={440}
        >
          <Drawer.Body className="flex flex-col">
            <Suspense
              fallback={<p className="text-[12px] text-[color:var(--text-subtle)]">Loading the guide chat…</p>}
            >
              <AskGuidePane
                workspaceId={workspaceId}
                workspaceRoot={workspaceRoot}
                changedPaths={changedPaths}
                onJumpToLine={handleChatJump}
                prefill={chatPrefill}
              />
            </Suspense>
          </Drawer.Body>
        </Drawer>
      ) : null}
    </div>
  )
}

// The primary/alt modifiers named for the platform (safe when window is absent, as
// in static render), so the header chords match the keys the reviewer presses.
const IS_MAC = typeof window !== 'undefined' && window.api?.platform === 'darwin'
const PRIMARY_KEY = IS_MAC ? 'Cmd' : 'Ctrl'
const ALT_KEY = IS_MAC ? 'Option' : 'Alt'

// The discoverable-shortcut header for the reading column: the keys that were
// previously invisible and only learned by accident. One quiet row, not per-file
// chrome. Pane-nav is always live; the diff-only keys (hunks, comment) show only
// on a step pane, and the comment chord only when commenting is wired.
function ShortcutHints({ inStep, commentsEnabled }: { inStep: boolean; commentsEnabled: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-end gap-x-3.5 gap-y-1 text-[11px] text-[color:var(--text-subtle)]">
      <span className="inline-flex items-center gap-1">
        <KbdChord keys={['[']} />
        <KbdChord keys={[']']} /> panes
      </span>
      {inStep ? (
        <span className="inline-flex items-center gap-1">
          <KbdChord keys={['F7']} /> hunks
        </span>
      ) : null}
      {inStep && commentsEnabled ? (
        <span className="inline-flex items-center gap-1">
          <KbdChord keys={[PRIMARY_KEY, ALT_KEY, 'C']} /> comment
        </span>
      ) : null}
    </div>
  )
}

export default ReviewWalkthrough
