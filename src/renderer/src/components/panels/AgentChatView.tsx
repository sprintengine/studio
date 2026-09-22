// AgentChatView — the chat runtime surface for conversation-backed standard
// agents (T6). It renders canonical ConversationEvents from the main runtime
// over the typed conversation IPC/preload path, and drives the session
// lifecycle: start, send a turn, stream assistant output, approve/deny tool
// requests, interrupt, stop, and retry. It deliberately has no terminal
// emulator dependency and no landing/hero — the first screen is the usable
// composer.
//
// `projectConversation` is a pure, DOM-free fold of the event stream plus the
// locally tracked user turns into an ordered transcript. It is unit-tested by
// AgentChatView.test.ts so the streaming/approval/interrupt/failure states have
// node-level coverage without rendering.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationSessionSummary,
} from '../../../../shared/conversation-runtime'
import type { ConversationProviderListEntry, ConversationProviderModel } from '../../../../shared/plugin-manifest'
import type { CliPermissionPreset } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getEffectiveKeybindings } from '../../commands/effectiveKeybindings'
import { renderKeybinding } from '../../commands/keybindings'
import { PANEL_COMMAND_EVENT } from '../../utils/panelCommands'
import { uniqueAgentName } from '../workspace/workspaceManagerHelpers'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { dataTransferHasFiles, imageFilesFromDataTransfer } from '../../utils/imageFileTransfer'
import {
  attachmentCountLabel,
  attachmentPreviewUrl,
  ComposerAttachmentStrip,
  openAttachmentImage,
} from './ComposerAttachmentStrip'
import {
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  IconButton,
  InlineNotice,
  InlineSkillPicker,
  OutlineButton,
  SkillPickerPopover,
  Textarea,
  Tooltip,
  TruncatedText,
} from '../ui'
import type { InlineSkillPickerHandle } from '../ui'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import { renderChatSkillMention, renderChatSkillPrefill } from '../../utils/skillInvocation'
import { CreationBackdrop } from '../backdrops/CreationBackdrop'
import { projectConversation, type TranscriptEntry, type UserTurn } from './agentChat/conversationProjection'
import { deriveConversationTimelineRows } from './agentChat/conversationTimeline'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  attachmentRejection,
  providerAcceptsImages,
  readImageAttachment,
} from './agentChat/imageAttachments'
import { ModelPickerPill, PermissionPresetPill, type ModelGroup } from './agentChat/modelPicker'
import { ConversationPendingDock } from './agentChat/pendingDock'
import { TimelineRow, type TimelineChrome } from './agentChat/timelineRows'
import { EmptyChatState, ReadinessState, readinessLabel, type ChatReadiness } from './agentChat/chatStates'
import { ComposerActionButton, ComposerContextMenu, type ComposerMenuState } from './agentChat/composerControls'
export { ComposerContextMenu, editingShortcut } from './agentChat/composerControls'
export type { ComposerMenuState } from './agentChat/composerControls'

export { readinessLabel } from './agentChat/chatStates'
export type { ChatReadiness } from './agentChat/chatStates'

export {
  ResolvedDecisions,
  UserTimelineRow,
  WorkTimeline,
  formatStepDuration,
  isAuthShapedFailure,
} from './agentChat/timelineRows'

export { parseOptionLabel } from './agentChat/pendingDock'

export {
  PermissionPresetPill,
  filterModelGroups,
  permissionChangeScopeLabel,
  permissionPresetLabel,
} from './agentChat/modelPicker'
export type { ModelGroup } from './agentChat/modelPicker'

export {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  attachmentRejection,
  base64ByteLength,
  formatAttachmentBytes,
  isAttachableImageType,
  providerAcceptsImages,
  scaledImageDimensions,
  splitImageDataUrl,
} from './agentChat/imageAttachments'

export {
  activeConversationStage,
  deriveConversationTimelineRows,
  flattenToolEntries,
  groupResolvedDecisions,
  resolvedDecisionGroupLabel,
  subagentLaneLabel,
  toolObject,
  toolVerb,
} from './agentChat/conversationTimeline'
export type {
  ConversationApprovalEntry,
  ConversationDecisionRow,
  ConversationTimelineRow,
} from './agentChat/conversationTimeline'

export { projectConversation } from './agentChat/conversationProjection'
export type {
  ConversationProjection,
  TranscriptEntry,
  TranscriptToolEntry,
  UserTurn,
} from './agentChat/conversationProjection'

// The DataTransfer plumbing lives in utils/imageFileTransfer (shared with the
// new-chat launch surface); re-exported here because this module declared it
// first and the tests and seam read it from here.
export { dataTransferHasFiles }
// The staged-image strip and its helpers live in ComposerAttachmentStrip
// (shared with the new-chat launch surface, which must not import this panel);
// re-exported for the same reason.
export { attachmentCountLabel, attachmentPreviewUrl, ComposerAttachmentStrip, openAttachmentImage }

// Fold a commit made while the turn was locked into the waiting queued turn
// (D6/1776): text appends, images concatenate. Reports how many images the
// per-turn cap left behind so the composer can say so — a queue that quietly
// swallowed the tail of a paste would look like it had taken everything.
export function mergeQueuedTurn(
  previous: { text: string; attachments: ConversationImageAttachment[] } | null,
  text: string,
  attachments: ConversationImageAttachment[],
): { text: string; attachments: ConversationImageAttachment[]; dropped: number } {
  const previousText = previous?.text ?? ''
  const combined = [...(previous?.attachments ?? []), ...attachments]
  return {
    text: previousText && text ? `${previousText}\n${text}` : previousText || text,
    attachments: combined.slice(0, MAX_ATTACHMENTS_PER_TURN),
    dropped: Math.max(0, combined.length - MAX_ATTACHMENTS_PER_TURN),
  }
}

// What the queued-turn row reads as. An image-only queued turn has no text to
// show, so the count is the label rather than an empty row.
export function queuedTurnLabel(text: string, attachmentCount: number): string {
  if (attachmentCount === 0) return text
  const images = attachmentCountLabel(attachmentCount)
  return text ? `${text} · ${images}` : images
}

// Stable empty-catalog reference: returned for any provider whose live catalog
// has not loaded so effects keyed on the derived list do not re-run each render.
const EMPTY_MODELS: ConversationProviderModel[] = []

// ── Component ───────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string
  agentId: string
}

// The bordered/rounded surface and focus ring live on the composer container;
// the textarea itself is transparent and borderless so the field reads as one
// piece with the footer control row beneath it. The container wears
// FOCUS_RING_WITHIN_TEXTAREA_CLASS, so the indicator here is the product's one
// ring — it used to be an accent border swap, a second idiom.
// `text-body`, not the raw Tailwind `text-sm` it shipped with — the one type
// scale is the token's (remote-sessions-ux / composer-surface-premium).
// The composer's BOX only. Ground, ink, placeholder tier, the missing outline
// and the content sizing are `Textarea variant="composer"`'s — the wrapper
// already draws the border and takes the ring through
// `FOCUS_RING_WITHIN_TEXTAREA_CLASS`, which is the pairing that variant exists
// for. The bounds are the caller's, per the variant's contract, and they are the
// same pair the new-chat composer uses.
const COMPOSER_CLASS = 'max-h-[280px] min-h-[40px] overflow-y-auto rounded-t-lg px-3 pb-1 pt-2.5'

type PendingAction = 'starting' | 'sending' | 'stopping' | null

// A message committed while the session was busy, waiting for the turn to
// unlock (D6/1776). Attachments ride along so a queued image is not lost.
type QueuedTurn = { text: string; attachments: ConversationImageAttachment[] }

export function stopDisabledForPending(pending: PendingAction): boolean {
  return pending === 'stopping'
}

// Whether the session can accept a live send right now. The runtime rejects a
// new turn while its session is busy — `isSessionBusy` in
// src/main/conversation-runtime.ts, which is an open turn of any kind: the whole
// active turn, its awaiting-approval window, and a continuation turn the
// provider opened outside any send (1798). So a submit made while busy is queued
// and auto-sent on unlock (D6/1776) rather than fired as a live IPC that would
// error. Type-ahead into the textarea is always allowed; only the send/queue
// routing keys off this.
export function isConversationBusy(activeTurn: boolean, awaitingApproval: boolean, pending: PendingAction): boolean {
  return activeTurn || awaitingApproval || pending !== null
}

/**
 * The skill type-ahead the draft is asking for, if any. Two doors into one list
 * (agent-harness chats only — plain model chats run no tools):
 *
 * - `slash` — a `/` opening an otherwise-empty draft, the CLI-native habit. Only
 *   until the first space: a space commits the text as literal.
 * - `mention` — a `$` at the start of a word anywhere in the draft, so a skill
 *   can be named mid-sentence.
 *   The token runs to the end of the draft; a space ends it.
 *
 * `token` is the exact text the pick replaces, `query` the part after the
 * trigger character that filters the list. Pure, so the contract is testable
 * without a DOM.
 */
export type ChatSkillTrigger = { kind: 'slash' | 'mention'; query: string; token: string }

export function chatSkillTrigger(draft: string): ChatSkillTrigger | null {
  if (draft.startsWith('/') && !/\s/.test(draft)) {
    return { kind: 'slash', query: draft.slice(1), token: draft }
  }
  const mention = /(?:^|\s)(\$(\S*))$/.exec(draft)
  if (mention) return { kind: 'mention', query: mention[2], token: mention[1] }
  return null
}

// The composer's one commit rule, shared by every affordance that can commit a
// turn — Enter, the send button, and the right-click menu's Send item (1793) —
// so the three can never disagree about whether a turn can be committed or
// whether committing sends now or queues (D6/1776). Content is text OR staged
// images (D3/1774): an image-only message is sendable.
export function composerSendAction(options: {
  ready: boolean
  busy: boolean
  sending: boolean
  hasText: boolean
  attachmentCount: number
}): { label: string; disabled: boolean } {
  return {
    label: options.sending ? 'Sending' : options.busy ? 'Queue message' : 'Send message',
    disabled: !options.ready || (!options.hasText && options.attachmentCount === 0),
  }
}

// The model is editable only until the conversation starts: the runtime binds a
// session to one provider/model, so once the user has sent a turn (or a session
// exists) the in-composer picker locks. A replayed transcript counts as a
// started conversation too — after an app restart userTurns/sessionId are empty
// local state, but switching models over restored history would silently start
// a fresh session mid-thread.
export function isConversationModelLocked(
  userTurnCount: number,
  sessionId: string | null,
  hasTranscriptHistory = false,
): boolean {
  return userTurnCount > 0 || sessionId !== null || hasTranscriptHistory
}

// The tool-permission preset the pill reports, in precedence order (1809):
// the live session's own reported preset first — it is what the running child
// applies on its next tool call, and it can disagree with the agent record (an
// optimistic write lost to a reload race, a session started with an explicit
// preset); then the persisted per-agent field every CLI spawn stamps from the
// picker, which is also what the next session starts on; then 'default' (ask
// per tool) for an agent record predating the field — the safe end of the
// scale, never the loose one.
export function resolvePermissionPreset(
  session: Pick<ConversationSessionSummary, 'permissionPreset'> | null,
  agentPreset: CliPermissionPreset | undefined,
): CliPermissionPreset {
  return session?.permissionPreset ?? agentPreset ?? 'manual'
}

// Which mounted chat view answers a whole-window model-picker shortcut (see
// the effect inside AgentChatView). Mount order; the focused view wins.
export type MountedChatView = {
  workspaceId: string
  isFocused: () => boolean
  toggleModelPicker: () => void
}
const mountedChatViews: MountedChatView[] = []
export const MODEL_PICKER_TOGGLE_COMMAND = 'chat.modelPicker.toggle'

/**
 * Answer `chat.modelPicker.toggle` (⌘⇧M, or the palette row) with ONE chat
 * view: the one holding focus, failing that the most recently mounted view
 * in the active workspace — never every mounted view (background workspace
 * layers stay mounted). One module-level listener, installed while any view
 * is mounted, picks the responder and toggles it; the views never compare
 * closures, which is how the first cut of this silently answered nothing.
 * Returns the view that answered, or null.
 */
export function respondToModelPickerToggle(): MountedChatView | null {
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const responder =
    mountedChatViews.find((view) => view.isFocused()) ??
    [...mountedChatViews].reverse().find((view) => view.workspaceId === activeWorkspaceId) ??
    null
  responder?.toggleModelPicker()
  return responder
}

function onModelPickerPanelCommand(event: Event): void {
  const detail = (event as CustomEvent<{ id?: string }>).detail
  if (detail?.id === MODEL_PICKER_TOGGLE_COMMAND) respondToModelPickerToggle()
}

/** Register a mounted chat view as a possible responder; returns the unregister. */
export function registerMountedChatView(entry: MountedChatView): () => void {
  if (mountedChatViews.length === 0) window.addEventListener(PANEL_COMMAND_EVENT, onModelPickerPanelCommand)
  mountedChatViews.push(entry)
  return () => {
    const index = mountedChatViews.indexOf(entry)
    if (index >= 0) mountedChatViews.splice(index, 1)
    if (mountedChatViews.length === 0) window.removeEventListener(PANEL_COMMAND_EVENT, onModelPickerPanelCommand)
  }
}

export default function AgentChatView({ workspaceId, agentId }: Props) {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  // A conversation-runtime chat has no pty, so no `UserPromptSubmit` frame
  // reaches the sidebar's ordering clock the way a CLI's does. Sending a turn
  // is the same event, so it stamps the same clock here — without this these
  // chats would sit at their creation time for ever while every CLI chat moved.
  const recordWorkspaceUserMessage = useWorkspaceStore((s) => s.recordWorkspaceUserMessage)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const conversation = agent?.conversation
  const label = agent?.name ?? agentId
  const workspaceRoot = workspace?.folderPath ?? null

  const [readiness, setReadiness] = useState<ChatReadiness>({ kind: 'loading' })
  const [providers, setProviders] = useState<ConversationProviderListEntry[]>([])
  // Live model catalogs keyed by providerId, fetched lazily as the user opens
  // the picker or filters to a provider — never a blanket prefetch. A non-empty
  // entry is preferred over the manifest seed.
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ConversationProviderModel[]>>({})
  // Whether each provider has a configured key, fetched alongside its catalog.
  // Drives the explicit "add key" vs "no models" group state so a key-configured
  // provider never collapses into a silent stale seed.
  const [keyByProvider, setKeyByProvider] = useState<Record<string, boolean>>({})
  // The active provider's live catalog (stable ref per cache entry) feeds the
  // current-model label, context length, and the tab self-heal below.
  const liveModels = catalogByProvider[conversation?.providerId ?? ''] ?? EMPTY_MODELS
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  // The live session as the runtime last reported it — adopted on start and
  // re-adopted from every result that can change its preset, so the pill moves
  // when the provider accepts a change, never on an optimistic guess. The pill
  // reads the session's own preset first, then the agent record, then 'default'
  // (`resolvePermissionPreset`).
  const [session, setSession] = useState<ConversationSessionSummary | null>(null)
  const sessionId = session?.sessionId ?? null
  const permissionPreset = resolvePermissionPreset(session, agent?.cliPermissionPreset)
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [userTurns, setUserTurns] = useState<UserTurn[]>([])
  // Skill-at-spawn seeds the first draft (prefill only — the user submits).
  const [draft, setDraft] = useState(() => agent?.chatComposerPrefill ?? '')
  const [pending, setPending] = useState<PendingAction>(null)
  // Images staged for the next turn (D3/1774), in the order they were added.
  const [attachments, setAttachments] = useState<ConversationImageAttachment[]>([])
  // A pasted/dropped/picked image is being read and resampled. Held so the
  // strip can say so instead of looking like nothing happened on a large file.
  const [attachingCount, setAttachingCount] = useState(0)
  // An image drag is over the composer; drives the drop-target affordance.
  const [dropActive, setDropActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentSeqRef = useRef(0)
  // Type-ahead queue (D6/1776): a message the user committed while the session
  // was busy. It holds until the turn unlocks, then auto-sends as a follow-up
  // turn. Null when nothing is queued; a second commit while busy appends so no
  // typed intent is dropped. Attachments ride the queue too — dropping them at
  // the queue boundary would silently lose what the user staged.
  const [queuedTurn, setQueuedTurn] = useState<QueuedTurn | null>(null)
  // The composer's right-click menu (1793); null when closed. Opening it snapshots
  // the click point, the field's selection, and the clipboard, so the menu's
  // enable states describe the moment the user asked for it.
  const [composerMenu, setComposerMenu] = useState<ComposerMenuState | null>(null)
  // Where the caret belongs after a menu edit rewrites the controlled draft.
  // Applied once the new value has rendered, so the caret lands in the edited
  // text instead of jumping to the end of it.
  const pendingCaretRef = useRef<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false)
  // Skill type-ahead: Escape, a click elsewhere, or non-matching text sets
  // dismissed so the trigger character stays literal; cleared once the draft no
  // longer carries a trigger token (the `/` was removed, or a space ended the
  // `$word`), so the next one opens the list again.
  const [skillTriggerDismissed, setSkillTriggerDismissed] = useState(false)
  const skillPickerRef = useRef<InlineSkillPickerHandle | null>(null)
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const listRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // Drag enter/leave fire for every child the pointer crosses; the depth
  // counter keeps the drop affordance from flickering inside the composer.
  const dragDepthRef = useRef(0)
  // Completed assistant replies the user has "seen" (was at the bottom for);
  // the jump pill counts completions past this baseline while scrolled up.
  const repliesSeenRef = useRef(0)

  // The prefill is one-shot: once the user has sent anything, clear it from the
  // record so a later remount never re-seeds a stale invocation.
  useEffect(() => {
    if (!agent?.chatComposerPrefill || userTurns.length === 0) return
    updateAgent(workspaceId, agentId, { chatComposerPrefill: undefined })
  }, [agent?.chatComposerPrefill, userTurns.length, updateAgent, workspaceId, agentId])

  // Resolve provider/model/key readiness from the conversation IPC.
  useEffect(() => {
    let cancelled = false
    if (!conversation) return
    if (!workspaceRoot) {
      setReadiness({ kind: 'no-workspace-folder' })
      return
    }
    if (typeof window.api.conversationProvidersList !== 'function') {
      setReadiness({
        kind: 'error',
        message: 'Conversation providers need an app restart before this agent is available.',
      })
      return
    }
    setReadiness({ kind: 'loading' })
    void (async () => {
      try {
        const list = await window.api.conversationProvidersList({
          cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
        })
        if (cancelled) return
        if (!list.ok) {
          setReadiness({ kind: 'error', message: list.message })
          return
        }
        setProviders(list.providers)
        const provider = list.providers.find((entry) => entry.id === conversation.providerId)
        if (!provider) {
          setReadiness({ kind: 'provider-unavailable', providerId: conversation.providerId })
          return
        }
        // Listed but unable to start sessions (e.g. its CLI was not found):
        // surface the provider's own plain-language reason.
        if (provider.unavailable) {
          setReadiness({ kind: 'error', message: provider.unavailable })
          return
        }
        // Providers with a live catalog accept models not in the static seed, so
        // membership is only enforced for static-only providers.
        if (!provider.supportsDynamicModels && !provider.models.some((model) => model.id === conversation.modelId)) {
          setReadiness({
            kind: 'model-unavailable',
            providerId: conversation.providerId,
            modelId: conversation.modelId,
          })
          return
        }
        const status = await window.api.conversationSecretStatus({ providerId: conversation.providerId })
        if (cancelled) return
        // A provider that declares no secret returns ok:false with that reason;
        // treat anything other than an explicit unconfigured key as ready.
        if (status.ok && !status.status.configured) {
          setReadiness({ kind: 'missing-key', providerId: conversation.providerId })
          return
        }
        setReadiness({ kind: 'ready' })
      } catch (err) {
        if (!cancelled)
          setReadiness({ kind: 'error', message: err instanceof Error ? err.message : 'Provider check failed.' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversation, workspaceRoot, cliRuntimes])

  // Subscribe to canonical events for this agent's session. Every event carries a
  // unique id, so we dedupe on it: a window holds one broadcast subscription per
  // open chat tab (and dev StrictMode double-invokes effects), which would
  // otherwise deliver — and append — each streamed token more than once, tripling
  // the text. Deduping on id makes the transcript immune to duplicate delivery.
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (typeof window.api.onConversationEvent !== 'function') return
    const unsubscribe = window.api.onConversationEvent((event) => {
      if (event.workspaceId !== workspaceId || event.agentId !== agentId) return
      if (seenEventIdsRef.current.has(event.id)) return
      seenEventIdsRef.current.add(event.id)
      setEvents((current) => [...current, event])
    })
    return unsubscribe
  }, [workspaceId, agentId])

  // Replay the persisted transcript once per mount so the conversation
  // survives app/tab reloads. Replayed events are older than anything the live
  // subscription delivers, so they are prepended; ids dedupe the overlap.
  useEffect(() => {
    if (!workspaceRoot || typeof window.api.conversationTranscript !== 'function') return
    let cancelled = false
    void window.api
      .conversationTranscript({ workspaceRoot, workspaceId, agentId })
      .then((result) => {
        if (cancelled || !result.ok || result.events.length === 0) return
        const replayed = result.events.filter((event) => !seenEventIdsRef.current.has(event.id))
        if (replayed.length === 0) return
        for (const event of replayed) seenEventIdsRef.current.add(event.id)
        setEvents((current) => [...replayed, ...current])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, workspaceId, agentId])

  // Fetch one provider's live catalog and key status on demand, caching both.
  // Called for the active provider on mount and for whichever provider the user
  // filters to in the picker — never a blanket fan-out over every provider.
  // Failures are silent: the picker falls back to the manifest seed (unknown key
  // state) or its explicit empty state (known key state), never a stale list.
  const fetchProviderCatalog = useCallback((providerId: string) => {
    if (!providerId) return
    if (typeof window.api.conversationProviderModels === 'function') {
      void window.api
        .conversationProviderModels({ providerId })
        .then((result) => {
          if (result.ok) setCatalogByProvider((current) => ({ ...current, [providerId]: result.models }))
        })
        .catch(() => undefined)
    }
    if (typeof window.api.conversationSecretStatus === 'function') {
      void window.api
        .conversationSecretStatus({ providerId })
        .then((result) => {
          if (result.ok) setKeyByProvider((current) => ({ ...current, [providerId]: result.status.configured }))
        })
        .catch(() => undefined)
    }
  }, [])

  // Fetch the active provider up front so the current model's display label,
  // context length, and readiness resolve before the picker is ever opened.
  useEffect(() => {
    const providerId = conversation?.providerId
    if (providerId) fetchProviderCatalog(providerId)
  }, [conversation?.providerId, fetchProviderCatalog])

  const projection = useMemo(() => projectConversation(events, userTurns), [events, userTurns])
  const timelineRows = useMemo(
    () => deriveConversationTimelineRows(projection.entries, projection.activeTurn),
    [projection.entries, projection.activeTurn],
  )

  // Follow the stream only while the user is at (or near) the bottom: reading
  // scrollback must never be yanked away by incoming tokens. A "jump to
  // latest" pill appears once they scroll up. Keyed on events.length so token
  // appends (which don't change the row count) also keep the view pinned.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const handleLogScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48
    atBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])
  const jumpToLatest = useCallback(() => {
    const node = listRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }, [])
  useEffect(() => {
    const node = listRef.current
    if (node && atBottomRef.current) node.scrollTop = node.scrollHeight
  }, [events.length, timelineRows.length, projection.activeTurn])

  // Surface turn failures (streamed via `turn_failed`) to the app Notifications
  // panel, deduped on the message so a single failure is logged once.
  const lastNotifiedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    const message = projection.lastError
    // Clear on recovery so an identical error on a later turn notifies again.
    if (!message) {
      lastNotifiedErrorRef.current = null
      return
    }
    if (message === lastNotifiedErrorRef.current) return
    lastNotifiedErrorRef.current = message
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} turn failed`,
      message,
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [projection.lastError, label, workspaceId, workspace?.name, agentId])

  // Surface session/send action errors (start failure, missing key, IPC error)
  // the same way — these never reach the event stream.
  const lastNotifiedActionErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (!actionError || actionError === lastNotifiedActionErrorRef.current) return
    lastNotifiedActionErrorRef.current = actionError
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} could not start`,
      message: actionError,
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [actionError, label, workspaceId, workspace?.name, agentId])

  // Self-heal an ugly tab name: spawn may have named the tab with the raw model
  // id (a remembered live-only model has no nice label until the catalog loads).
  // Once live models arrive, rename to the model's display name.
  useEffect(() => {
    if (!conversation) return
    const displayName = liveModels.find((model) => model.id === conversation.modelId)?.displayName
    if (displayName && agent?.name === conversation.modelId && displayName !== conversation.modelId) {
      updateAgent(workspaceId, agentId, { name: displayName })
    }
  }, [liveModels, conversation, agent?.name, updateAgent, workspaceId, agentId])

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId
    if (!conversation || !workspaceRoot) return null
    const result = await window.api.conversationSessionStart({
      workspaceRoot,
      workspaceId,
      agentId,
      providerId: conversation.providerId,
      modelId: conversation.modelId,
      cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
      // The spawn picker's preset, stamped on the agent record at spawn and
      // editable from the composer's permission pill until the first turn. No
      // hardcoded 'default' here: an agent spawned as Bypass starts as Bypass.
      permissionPreset,
    })
    if (!result.ok) {
      setActionError(result.message)
      return null
    }
    setSession(result.session)
    return result.session.sessionId
  }, [agentId, cliRuntimes, conversation, permissionPreset, sessionId, workspaceId, workspaceRoot])

  // Change the tool-permission preset. The agent record is the durable seed (it
  // starts the next session and survives a remount), so it is written first; a
  // live session additionally gets the change pushed to its running query and
  // reports back the preset it now holds, which is what the pill reads. A
  // provider that refuses (no live-change support, or Claude Code declining)
  // rolls the record back and surfaces its own message — the pill never shows a
  // preset the session is not actually on. An accepted change the provider
  // cannot apply to the turn already streaming comes back with a `notice`: the
  // preset IS recorded, so the pill moves and the sentence says when it starts
  // applying (1808).
  const [permissionChanging, setPermissionChanging] = useState(false)
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null)
  const changePermissionPreset = useCallback(
    async (next: CliPermissionPreset) => {
      if (next === permissionPreset || permissionChanging) return
      setActionError(null)
      setPermissionNotice(null)
      const previous = agent?.cliPermissionPreset
      updateAgent(workspaceId, agentId, { cliPermissionPreset: next })
      if (!sessionId) return
      if (typeof window.api.conversationSessionSetPermission !== 'function') {
        updateAgent(workspaceId, agentId, { cliPermissionPreset: previous })
        setActionError('Changing tool permissions mid-conversation needs an app restart.')
        return
      }
      setPermissionChanging(true)
      try {
        const result = await window.api.conversationSessionSetPermission({ sessionId, permissionPreset: next })
        if (result.ok) {
          setSession(result.session)
          setPermissionNotice(result.notice ?? null)
        } else {
          updateAgent(workspaceId, agentId, { cliPermissionPreset: previous })
          setActionError(result.message)
        }
      } catch (err) {
        updateAgent(workspaceId, agentId, { cliPermissionPreset: previous })
        setActionError(err instanceof Error ? err.message : 'Could not change tool permissions.')
      } finally {
        setPermissionChanging(false)
      }
    },
    [agent?.cliPermissionPreset, agentId, permissionChanging, permissionPreset, sessionId, updateAgent, workspaceId],
  )

  // Send one turn. A turn needs text or at least one image — the runtime accepts
  // an image-only turn, so the composer does too.
  const sendTurn = useCallback(
    async (message: string, turnAttachments: ConversationImageAttachment[] = []) => {
      const text = message.trim()
      if ((!text && turnAttachments.length === 0) || pending) return
      setActionError(null)
      // A "from the next turn" notice is spent once that turn leaves.
      setPermissionNotice(null)
      setPending('starting')
      const activeSession = await ensureSession()
      if (!activeSession) {
        setPending(null)
        // The turn never left, so hand the staged images back rather than make
        // the user re-attach them — unless they already staged new ones.
        if (turnAttachments.length > 0) {
          setAttachments((current) => (current.length === 0 ? turnAttachments : current))
        }
        return
      }
      const localTurnId = `user-${userTurns.length}-${Date.now()}`
      setUserTurns((current) => [
        ...current,
        { id: localTurnId, text, ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}) },
      ])
      setDraft('')
      setPending('sending')
      recordWorkspaceUserMessage(workspaceId, Date.now())
      try {
        const result = await window.api.conversationSessionSendTurn({
          sessionId: activeSession,
          message: text,
          localTurnId,
          ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
        })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not send the message.')
      } finally {
        setPending(null)
      }
    },
    [ensureSession, pending, recordWorkspaceUserMessage, userTurns.length, workspaceId],
  )

  // Composer submit (Enter or the send affordance). Sends immediately when the
  // session is idle; queues the message when a turn is streaming or awaiting
  // approval, so the user gets terminal-style type-ahead without the send
  // erroring against the runtime's turn guard (D6/1776). The flush effect below
  // sends the queued message the moment the session unlocks.
  const submitComposer = useCallback(() => {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)) {
      const { dropped, ...merged } = mergeQueuedTurn(queuedTurn, text, attachments)
      setQueuedTurn(merged)
      setDraft('')
      setAttachments([])
      // The cap is the IPC boundary's; trimming to it is right, hiding the trim
      // is not — the user must know which images did not make the queue.
      setActionError(
        dropped > 0
          ? `Only ${MAX_ATTACHMENTS_PER_TURN} images fit in one message — ${attachmentCountLabel(dropped)} were not queued.`
          : null,
      )
      return
    }
    void sendTurn(text, attachments)
    setAttachments([])
  }, [attachments, draft, projection.activeTurn, projection.awaitingApproval, pending, queuedTurn, sendTurn])

  // Open the composer's right-click menu (1793). The clipboard read is awaited
  // before opening so Paste is never offered against an empty clipboard, and the
  // pointer/selection state is captured before it, because the event's target is
  // released once the handler returns. The menu key (Shift+F10) raises the same
  // event and is the keyboard path in; when it reports no pointer, the menu opens
  // at the field instead of the viewport corner.
  const openComposerMenu = useCallback(async (event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    const field = event.currentTarget
    const rect = field.getBoundingClientRect()
    const keyboardInvoked = event.clientX === 0 && event.clientY === 0
    const x = keyboardInvoked ? rect.left : event.clientX
    const y = keyboardInvoked ? rect.bottom : event.clientY
    const selectionStart = field.selectionStart ?? 0
    const selectionEnd = field.selectionEnd ?? selectionStart
    const clipboardText = await readClipboardText()
    setComposerMenu({ x, y, selectionStart, selectionEnd, clipboardText })
  }, [])

  // Replace the menu's captured selection with `text` ('' for a plain cut) and
  // put the caret after what was inserted.
  const replaceComposerSelection = useCallback((menu: ComposerMenuState, text: string) => {
    setDraft((current) => current.slice(0, menu.selectionStart) + text + current.slice(menu.selectionEnd))
    pendingCaretRef.current = menu.selectionStart + text.length
  }, [])

  // Apply the caret position a menu edit asked for, once the rewritten draft has
  // rendered. Focus comes back to the field so the user can keep typing.
  useEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const field = composerRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(caret, caret)
  }, [draft])

  // Auto-send the queued message as a follow-up turn once the session idles.
  // Gated on the same busy signal the submit uses, so it never races the guard;
  // sendTurn's own `pending` guard prevents a re-entrant double send.
  useEffect(() => {
    if (queuedTurn === null || readiness.kind !== 'ready') return
    if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)) return
    const { text, attachments: queuedAttachments } = queuedTurn
    setQueuedTurn(null)
    void sendTurn(text, queuedAttachments)
  }, [queuedTurn, readiness.kind, projection.activeTurn, projection.awaitingApproval, pending, sendTurn])

  // Stage images for the next turn. Each file is read and resampled on its own
  // so one unreadable file never drops the rest of a multi-image paste; the
  // first refusal is what the composer reports, and the rest still attach.
  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      let firstError: string | null = null
      // Refuse on type and count first, so the "Reading N images…" state counts
      // only what is actually being read.
      const readable: File[] = []
      for (const file of files) {
        const rejection = attachmentRejection(file, attachments.length + readable.length)
        if (rejection) firstError ??= rejection
        else readable.push(file)
      }
      if (readable.length === 0) {
        setActionError(firstError)
        return
      }

      const accepted: ConversationImageAttachment[] = []
      setAttachingCount((count) => count + readable.length)
      try {
        for (const file of readable) {
          attachmentSeqRef.current += 1
          try {
            accepted.push(await readImageAttachment(file, `att-${attachmentSeqRef.current}-${Date.now()}`))
          } catch (err) {
            firstError ??= err instanceof Error ? err.message : 'That image could not be attached.'
          }
        }
      } finally {
        setAttachingCount((count) => Math.max(0, count - readable.length))
      }
      // The slice is the invariant, not the user-facing rule: the per-file check
      // above already reported the cap, this only holds it under overlapping
      // batches (a paste landing while a drop is still reading).
      if (accepted.length > 0) {
        setAttachments((current) => [...current, ...accepted].slice(0, MAX_ATTACHMENTS_PER_TURN))
      }
      setActionError(firstError)
    },
    [attachments.length],
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((entry) => entry.id !== id))
  }, [])

  // Approval/question cards resolve mid-turn on stateful providers — while the
  // sendTurn promise is still pending — so they get their own busy latch
  // instead of the composer's `pending` (which would deadlock the card: the
  // turn cannot finish until the card is answered).
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const resolveApproval = useCallback(
    async (requestId: string, approved: boolean, answers?: Record<string, string>) => {
      if (!sessionId || respondingRequestId) return
      setActionError(null)
      setRespondingRequestId(requestId)
      try {
        const result = await window.api.conversationSessionRespondToRequest({ sessionId, requestId, approved, answers })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not record the approval.')
      } finally {
        setRespondingRequestId(null)
      }
    },
    [sessionId, respondingRequestId],
  )

  const interrupt = useCallback(async () => {
    if (!sessionId || pending === 'stopping') return
    setPending('stopping')
    try {
      const result = await window.api.conversationSessionInterrupt({ sessionId })
      if (!result.ok) setActionError(result.message)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not interrupt the turn.')
    } finally {
      setPending(null)
    }
  }, [sessionId, pending])

  // Retry re-sends the last user message. The projection's entries are the
  // authoritative source — after an app restart the message only exists in the
  // replayed transcript, not in the local userTurns state.
  const retry = useCallback(() => {
    const lastUser = [...projection.entries]
      .reverse()
      .find((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user')
    if (lastUser?.text) void sendTurn(lastUser.text)
  }, [sendTurn, projection.entries])

  if (!conversation) {
    return (
      <ChatShell>
        <InlineNotice tone="error" className="mx-3 my-2">
          This agent has no conversation provider selected.
        </InlineNotice>
      </ChatShell>
    )
  }

  const ready = readiness.kind === 'ready'
  // The session cannot take a live turn right now (streaming, awaiting approval,
  // or an in-flight send). A submit made while busy queues instead of erroring.
  const composerBusy = isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)
  // Retry and other "act now" affordances stay disabled while busy or not ready.
  const composerDisabled = !ready || composerBusy
  // The textarea itself is only disabled before the provider is ready — it stays
  // editable through a stream so type-ahead works (D6/1776).
  const composerInputDisabled = !ready
  // One rule for both send affordances — the footer button and the right-click
  // menu's Send item (1793) — so they can never label or gate a commit
  // differently from each other or from Enter.
  const sendAction = composerSendAction({
    ready,
    busy: composerBusy,
    sending: pending === 'starting' || pending === 'sending',
    hasText: draft.trim().length > 0,
    attachmentCount: attachments.length,
  })

  // The runtime binds a session to one provider/model, so the model is editable
  // only until the conversation starts: once a turn is sent, a session exists,
  // or replayed history is present, the pill is read-only and the user opens a
  // new agent to change model.
  const modelLocked = isConversationModelLocked(
    userTurns.length,
    sessionId,
    projection.entries.some((entry) => entry.kind === 'user' || entry.kind === 'assistant'),
  )
  const modelGroups = buildModelGroups(providers, catalogByProvider, keyByProvider)
  const currentModel = modelGroups
    .find((group) => group.providerId === conversation.providerId)
    ?.models.find((model) => model.id === conversation.modelId)
  const currentModelLabel = currentModel?.displayName ?? conversation.modelId
  const contextLength = currentModel?.contextLength
  const usedTokens = projection.usage ? projection.usage.inputTokens + projection.usage.outputTokens : 0
  // ⌘⇧M toggles the model picker (registered as
  // `chat.modelPicker.toggle` so the Shortcuts settings, the
  // palette and the conflict suite all know the chord). The shell's dispatcher
  // resolves the binding and `runCommand` routes the registry's panel-event to
  // the module-level responder above; this view only registers itself.
  const shellRef = useRef<HTMLDivElement | null>(null)
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const toggleModelPickerRef = useRef<() => void>(() => {})
  toggleModelPickerRef.current = () => {
    if (modelLocked) return
    setModelMenuOpen((open) => !open)
  }
  useEffect(
    () =>
      registerMountedChatView({
        workspaceId,
        isFocused: () => Boolean(shellRef.current?.contains(document.activeElement)),
        toggleModelPicker: () => toggleModelPickerRef.current(),
      }),
    [workspaceId],
  )
  const modelPickerShortcutLabel = useMemo(() => {
    const keybinding = getEffectiveKeybindings(MODEL_PICKER_TOGGLE_COMMAND, keybindingSettings)[0]
    if (!keybinding) return null
    const platform = window.api.platform === 'darwin' ? 'darwin' : window.api.platform === 'win32' ? 'windows' : 'linux'
    return renderKeybinding(keybinding, platform)
  }, [keybindingSettings])
  const selectModel = (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    if (modelLocked || (providerId === conversation.providerId && modelId === conversation.modelId)) return
    const nextLabel = modelGroups
      .find((group) => group.providerId === providerId)
      ?.models.find((model) => model.id === modelId)?.displayName
    // The tab was named after the spawn-default model; once the user picks a
    // different model before the conversation starts, keep the tab truthful.
    // Only auto-created names are touched — a user-renamed tab (no model-label
    // match, ignoring a uniqueness suffix) stays as the user wrote it — and
    // the new name is re-uniqued against the workspace's other agents so two
    // tabs never end up with the same label.
    const baseName = (agent?.name ?? '').replace(/ \d+$/, '')
    const renaming = Boolean(nextLabel && (baseName === currentModelLabel || agent?.name === conversation.modelId))
    updateAgent(workspaceId, agentId, {
      conversation: { providerId, modelId },
      ...(renaming && nextLabel && workspace
        ? {
            name: uniqueAgentName(
              nextLabel,
              Object.fromEntries(Object.entries(workspace.agents).filter(([id]) => id !== agentId)),
            ),
          }
        : {}),
    })
    setLastSelectedConversationModel({ providerId, modelId })
  }

  // Agent-harness providers (the Claude CLI) run tools and speak as "Claude";
  // plain model providers are a direct chat with the model.
  const providerEntry = providers.find((entry) => entry.id === conversation.providerId)
  const isAgentHarness = providerEntry?.providerType === 'agent-harness'
  const assistantName = isAgentHarness ? 'Claude' : currentModelLabel
  // Image attach (D3/1774) is offered only where a provider actually reads the
  // turn's attachments, and only once the session can take a turn — a control
  // that stages images no one will receive is worse than no control.
  const imagesEnabled = ready && providerAcceptsImages(conversation.providerId)

  // Skills doors (agent harness only — plain model chats run no tools): a '/'
  // opening an otherwise-empty draft, or a '$' starting a word anywhere in it,
  // filters the same inventory the Skills chip shows. See `chatSkillTrigger`.
  const skillTrigger = isAgentHarness && !skillTriggerDismissed ? chatSkillTrigger(draft) : null
  const dismissSkillTrigger = useCallback(() => setSkillTriggerDismissed(true), [])
  const applySkillPick = (skill: WorkspaceSkill) => {
    if (skillTrigger?.kind === 'mention') {
      // The `$word` is the tail of the draft by construction; swap it for the
      // mention and leave the caret after a space, ready for the next word.
      const head = draft.slice(0, draft.length - skillTrigger.token.length)
      setDraft(`${head}${renderChatSkillMention(skill)} `)
    } else {
      setDraft(renderChatSkillPrefill(skill))
    }
    setSkillTriggerDismissed(true)
    composerRef.current?.focus()
  }
  const modelLabelFor = (modelId?: string): string => {
    if (!modelId) return currentModelLabel
    for (const group of modelGroups) {
      const model = group.models.find((entry) => entry.id === modelId)
      if (model?.displayName) return model.displayName
    }
    return modelId
  }

  const pendingApprovalEntry = [...projection.entries]
    .reverse()
    .find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> =>
        entry.kind === 'approval' && entry.status === 'pending',
    )
  const composerPlaceholder = pendingApprovalEntry
    ? pendingApprovalEntry.requestKind === 'question'
      ? 'Answer the question above to continue'
      : pendingApprovalEntry.requestKind === 'plan'
        ? 'Respond to the plan above to continue'
        : 'Respond to the request above to continue'
    : !ready
      ? readinessLabel(readiness)
      : projection.activeTurn
        ? 'Reply — sends when the turn finishes'
        : 'Send a message…'

  // Retry lives on the failed turn's error block in the transcript; only the
  // latest failed turn is retryable (retry re-sends the last user message).
  const lastFailedTurnId =
    !projection.activeTurn && ready
      ? [...projection.entries]
          .reverse()
          .find(
            (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> =>
              entry.kind === 'assistant' && entry.status === 'failed',
          )?.turnId
      : undefined

  const chrome: TimelineChrome = {
    assistantName,
    modelLabelFor,
    retryTurnId: lastFailedTurnId,
    onRetry: retry,
    retryDisabled: composerDisabled,
  }

  const completedReplies = projection.entries.filter(
    (entry) => entry.kind === 'assistant' && entry.status === 'complete',
  ).length
  if (atBottom && repliesSeenRef.current !== completedReplies) repliesSeenRef.current = completedReplies
  const newReplies = atBottom ? 0 : Math.max(0, completedReplies - repliesSeenRef.current)

  // Orphan turn failure: lastError set but no transcript entry carries it (a
  // turn_failed with no turnId while nothing was streaming). Without this the
  // chat would look idle/successful with the only trace in Notifications.
  const hasFailedTurnEntry = projection.entries.some((entry) => entry.kind === 'assistant' && entry.status === 'failed')
  const composerError = actionError ?? (projection.lastError && !hasFailedTurnEntry ? projection.lastError : null)

  return (
    <ChatShell shellRef={shellRef}>
      <CreationBackdrop surface="chat" visible={timelineRows.length === 0} />
      {/* Loading is not a notice — it is the state the screen is in, so it reads
          as the quiet line it is; anything else here is a degraded session. */}
      {!ready && timelineRows.length > 0 ? (
        readiness.kind === 'loading' ? (
          <p className="mx-3 my-2 text-meta leading-5 text-[color:var(--text-muted)]">{readinessLabel(readiness)}</p>
        ) : (
          <InlineNotice tone="warn" className="mx-3 my-2">
            {readinessLabel(readiness)}
          </InlineNotice>
        )
      ) : null}
      {/* Warn only about the CURRENT session: after a restart the replayed
          transcript may carry a previous session's source, but no session is
          live until the next send (which resets the source via
          session_started). */}
      {sessionId !== null && projection.apiKeySource !== null && projection.apiKeySource !== 'none' ? (
        <InlineNotice tone="warn" className="mx-3 my-2">
          This session is using an API key, not your subscription.
        </InlineNotice>
      ) : null}

      <div
        ref={listRef}
        role="log"
        aria-label={`${label} conversation`}
        aria-live="polite"
        onScroll={handleLogScroll}
        className="flex-1 space-y-1 overflow-y-auto px-4 py-4"
      >
        {timelineRows.length === 0 ? (
          !ready ? (
            <ReadinessState
              readiness={readiness}
              canSwitchModel={!modelLocked}
              onSwitchModel={() => setModelMenuOpen(true)}
            />
          ) : isAgentHarness ? (
            <EmptyChatState
              assistantName={assistantName}
              onSuggestion={(text) => {
                setDraft(text)
                composerRef.current?.focus()
              }}
            />
          ) : (
            // Model providers are a plain chat — no tool contract to explain.
            <div className="flex h-full items-center justify-center">
              <p className="max-w-[280px] text-center text-meta leading-5 text-[color:var(--text-muted)]">
                No messages yet. Send a prompt to start the conversation.
              </p>
            </div>
          )
        ) : (
          timelineRows.map((row) => <TimelineRow key={row.id} row={row} chrome={chrome} />)
        )}
      </div>

      <div className="relative px-4 pb-4 pt-1">
        {!atBottom && timelineRows.length > 0 ? (
          <OutlineButton
            size="xs"
            onClick={jumpToLatest}
            className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap"
          >
            {newReplies > 0 ? `↓ ${newReplies} new ${newReplies === 1 ? 'reply' : 'replies'}` : '↓ Jump to latest'}
          </OutlineButton>
        ) : null}
        <ConversationPendingDock
          pendingApproval={pendingApprovalEntry}
          workspaceName={workspace?.name}
          onApprove={resolveApproval}
          busy={respondingRequestId !== null}
        />

        {/*
         * A turn failure renders as a structured error block in the transcript
         * (with its own Retry), so here we only restate text for action errors
         * that never reach the transcript (start/send/IPC) — plus the orphan
         * case: a turn_failed that attached to no turn (no turnId while nothing
         * was streaming) sets lastError without a failed transcript entry, and
         * must still surface somewhere in the chat.
         */}
        {composerError ? (
          <div className="mb-2 flex items-center justify-between gap-3">
            <TruncatedText
              as="span"
              text={composerError}
              className="min-w-0 text-meta leading-5 text-[color:var(--tone-error)]"
            />
            <OutlineButton onClick={retry} disabled={composerDisabled} className="shrink-0">
              Retry
            </OutlineButton>
          </div>
        ) : null}

        {/*
         * A permission change the provider recorded but cannot apply to the turn
         * already streaming (1808). Information, not a failure: the pill already
         * shows the new preset, and this says when it starts applying.
         */}
        {permissionNotice ? (
          <p role="status" className="mb-2 text-meta leading-5 text-[color:var(--text-muted)]">
            {permissionNotice}
          </p>
        ) : null}

        {/*
         * Queued message (D6/1776): the user typed ahead and committed while the
         * turn was busy. It auto-sends the moment the session unlocks; Cancel
         * drops it before then. Kept truthful so a queued turn is never a
         * silent, invisible pending action.
         */}
        {queuedTurn ? (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-meta font-medium leading-5 text-[color:var(--text-default)]">Queued</span>
              <TruncatedText
                as="span"
                text={queuedTurnLabel(queuedTurn.text, queuedTurn.attachments.length)}
                className="min-w-0 text-meta leading-5 text-[color:var(--text-muted)]"
              />
            </div>
            <OutlineButton onClick={() => setQueuedTurn(null)} className="shrink-0">
              Cancel
            </OutlineButton>
          </div>
        ) : null}

        {/*
         * Composer: a single rounded field that holds the textarea and a footer
         * control row (model chip + permission chip + send), so the input reads
         * as one surface. The model lives here — picked before the first
         * message, then locked. While an approval card is pending the disabled
         * placeholder says why the composer is waiting.
         */}
        <div
          className={`relative transition-colors ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_TEXTAREA_CLASS} ${
            dropActive ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-default)]'
          }`}
          onDragEnter={(event) => {
            if (!imagesEnabled || !dataTransferHasFiles(event.dataTransfer)) return
            dragDepthRef.current += 1
            setDropActive(true)
          }}
          onDragOver={(event) => {
            // Claiming the drag is what stops the window from navigating to the
            // dropped file, so it has to happen on every dragover.
            if (!imagesEnabled || !dataTransferHasFiles(event.dataTransfer)) return
            event.preventDefault()
          }}
          onDragLeave={(event) => {
            if (!imagesEnabled || !dataTransferHasFiles(event.dataTransfer)) return
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setDropActive(false)
          }}
          onDrop={(event) => {
            if (!imagesEnabled || !dataTransferHasFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepthRef.current = 0
            setDropActive(false)
            const files = imageFilesFromDataTransfer(event.dataTransfer)
            if (files.length === 0) {
              setActionError('Only PNG, JPEG, WebP, and GIF images can be attached.')
              return
            }
            void attachFiles(files)
          }}
        >
          {/* Gated on imagesEnabled too, so a provider/readiness change mid-drag
              can never strand the overlay over a composer that stopped accepting
              images. */}
          {dropActive && imagesEnabled ? (
            // Opaque, not a scrim: the field's own text ghosting through the
            // drop state reads as a rendering artifact rather than a state.
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[color:var(--bg-surface)] text-meta font-medium text-[color:var(--accent-primary)]">
              Drop to attach
            </div>
          ) : null}
          {skillTrigger ? (
            <InlineSkillPicker
              ref={skillPickerRef}
              workspaceRoot={workspaceRoot}
              query={skillTrigger.query}
              onPick={applySkillPick}
              onMatchCountChange={(count) => {
                // Non-matching text dismisses; the trigger character stays literal.
                if (count === 0 && skillTrigger.query.length > 0) setSkillTriggerDismissed(true)
              }}
              onDismiss={dismissSkillTrigger}
            />
          ) : null}
          <ComposerAttachmentStrip attachments={attachments} reading={attachingCount} onRemove={removeAttachment} />
          <label htmlFor={`chat-composer-${agentId}`} className="sr-only">
            Message {label}
          </label>
          <Textarea
            ref={composerRef}
            variant="composer"
            resize="none"
            id={`chat-composer-${agentId}`}
            value={draft}
            onPaste={(event) => {
              // A pasted screenshot only exists as a clipboard item; a text
              // paste reports no image and falls through to the default.
              if (!imagesEnabled) return
              const files = imageFilesFromDataTransfer(event.clipboardData)
              if (files.length === 0) return
              event.preventDefault()
              void attachFiles(files)
            }}
            onChange={(event) => {
              const value = event.target.value
              setDraft(value)
              if (!chatSkillTrigger(value)) setSkillTriggerDismissed(false)
            }}
            onContextMenu={(event) => void openComposerMenu(event)}
            onKeyDown={(event) => {
              // While the skill picker is up, the textarea keeps focus and
              // forwards navigation; Enter picks instead of sending.
              if (skillTrigger) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (skillPickerRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
                    event.preventDefault()
                    return
                  }
                } else if (event.key === 'Enter' && !event.shiftKey) {
                  if (skillPickerRef.current?.pickActive()) {
                    event.preventDefault()
                    return
                  }
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setSkillTriggerDismissed(true)
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submitComposer()
              }
            }}
            placeholder={composerPlaceholder}
            rows={1}
            disabled={composerInputDisabled}
            className={COMPOSER_CLASS}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
            <div className="flex min-w-0 items-center gap-1">
              {imagesEnabled ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ATTACHABLE_IMAGE_TYPES.join(',')}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                      // Clearing lets the same file be picked twice in a row.
                      event.target.value = ''
                      void attachFiles(files)
                    }}
                  />
                  <Tooltip content="Attach an image" placement="top">
                    <IconButton aria-label="Attach an image" onClick={() => fileInputRef.current?.click()}>
                      <PaperclipGlyph className="icon-sm" />
                    </IconButton>
                  </Tooltip>
                </>
              ) : null}
              {isAgentHarness ? (
                <SkillPickerPopover
                  open={skillsMenuOpen}
                  onOpenChange={setSkillsMenuOpen}
                  workspaceRoot={workspaceRoot}
                  onPick={applySkillPick}
                  onManageSkills={() => openExtensionsSurface({ view: 'skills', installed: true })}
                />
              ) : null}
              <ModelPickerPill
                label={currentModelLabel}
                shortcutLabel={modelPickerShortcutLabel}
                locked={modelLocked}
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                groups={modelGroups}
                selectedProviderId={conversation.providerId}
                selectedModelId={conversation.modelId}
                onSelect={selectModel}
                onBrowseProvider={fetchProviderCatalog}
                onAddKey={() => {
                  setModelMenuOpen(false)
                  openSettingsOverlay({ initialTab: 'providers' })
                }}
              />
              {contextLength ? <ContextMeter used={usedTokens} total={contextLength} /> : null}
              {isAgentHarness ? (
                <PermissionPresetPill
                  cli={conversation.providerId}
                  preset={permissionPreset}
                  live={sessionId !== null}
                  changing={permissionChanging}
                  open={permissionMenuOpen}
                  onOpenChange={setPermissionMenuOpen}
                  onChange={(next) => {
                    // Close on pick like every other picker here: a refusal
                    // rolls the pill back and writes the reason to the composer
                    // error line, which an open popover would sit on top of.
                    setPermissionMenuOpen(false)
                    void changePermissionPreset(next)
                  }}
                />
              ) : null}
            </div>
            {projection.activeTurn ? (
              <ComposerActionButton
                tone="neutral"
                ariaLabel={pending === 'stopping' ? 'Stopping' : 'Stop responding'}
                onClick={() => void interrupt()}
                disabled={stopDisabledForPending(pending)}
              >
                <StopGlyph className="icon-sm shrink-0" />
              </ComposerActionButton>
            ) : (
              <ComposerActionButton
                tone="accent"
                ariaLabel={sendAction.label}
                onClick={submitComposer}
                disabled={sendAction.disabled}
              >
                <SendArrowGlyph className="icon-sm shrink-0" />
              </ComposerActionButton>
            )}
          </div>
          {/*
           * Right-click menu (1793): Send plus the standard editing actions, so
           * committing a turn is not limited to Enter and the button. Rendered
           * only while open — it positions itself at the click point.
           */}
          {composerMenu ? (
            <ComposerContextMenu
              menu={composerMenu}
              send={sendAction}
              editable={!composerInputDisabled}
              onSend={submitComposer}
              onCut={() => {
                const selected = draft.slice(composerMenu.selectionStart, composerMenu.selectionEnd)
                void writeClipboardText(selected).then((written) => {
                  if (written) replaceComposerSelection(composerMenu, '')
                  else setActionError('Could not cut to the clipboard.')
                })
              }}
              onCopy={() => {
                const selected = draft.slice(composerMenu.selectionStart, composerMenu.selectionEnd)
                void writeClipboardText(selected).then((written) => {
                  if (!written) setActionError('Could not copy to the clipboard.')
                })
              }}
              onPaste={() => replaceComposerSelection(composerMenu, composerMenu.clipboardText)}
              onClose={() => setComposerMenu(null)}
            />
          ) : null}
        </div>
      </div>
    </ChatShell>
  )
}

// The chat panel is header-less by design: the tab already names the agent, and
// model/session state live in the composer footer (shared layout). Repeating the name
// or model in a header is the duplication we're avoiding.
function ChatShell({
  shellRef,
  children,
}: {
  shellRef?: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}) {
  return (
    <div
      ref={shellRef}
      className="relative isolate flex h-full flex-col bg-[color:var(--agent-surface)] text-meta text-[color:var(--text-default)]"
    >
      {children}
    </div>
  )
}

// Compact context-window meter: a ring that fills as the conversation consumes
// the model's context, plus "used / total" in tokens. Shown only when the
// provider reports a context length (e.g. OpenRouter's `context_length`).
function ContextMeter({ used, total }: { used: number; total: number }) {
  const fraction = Math.max(0, Math.min(1, total > 0 ? used / total : 0))
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const nearFull = fraction >= 0.9
  return (
    <Tooltip content={`Context used: ${used.toLocaleString()} / ${total.toLocaleString()} tokens`} placement="top">
      <span className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-micro tabular-nums text-[color:var(--text-muted)]">
        <svg className="icon-sm -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={nearFull ? 'var(--tone-warn)' : 'var(--accent-primary)'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
        {formatTokens(used)}
      </span>
    </Tooltip>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

// Picker groups: one per provider, merging each provider's own live catalog
// (fetched when the user browses to it) over its manifest seed. Subscription
// providers ('agent-harness') sort first and carry the subscription annotation
// so metered API entries are never mistaken for the user's own plan. A
// dynamic-catalog provider is never dropped for an empty seed: when its key is
// missing it shows an explicit add-key state, and when the key is present but
// the catalog is empty it says so — never a silent stale seed (1772/D5).
export function buildModelGroups(
  providers: ConversationProviderListEntry[],
  catalogByProvider: Record<string, ConversationProviderModel[]>,
  keyByProvider: Record<string, boolean>,
): ModelGroup[] {
  return [...providers]
    .sort((a, b) => Number(b.providerType === 'agent-harness') - Number(a.providerType === 'agent-harness'))
    .map((entry): ModelGroup => {
      const base = { providerId: entry.id, providerLabel: entry.displayName, unavailable: entry.unavailable }
      const liveCatalog = catalogByProvider[entry.id]
      const hasLive = Array.isArray(liveCatalog) && liveCatalog.length > 0
      // Subscription (agent-harness) providers need no key: live catalog if it
      // loaded, else the seed. Static model-providers list their full seed as-is
      // — it is the complete catalog, not a truncated one.
      if (entry.providerType === 'agent-harness' || !entry.supportsDynamicModels) {
        return {
          ...base,
          subscription: entry.providerType === 'agent-harness',
          models: hasLive ? liveCatalog : entry.models,
        }
      }
      // Dynamic model-providers (OpenRouter, xAI): key state gates the catalog.
      const hasKey = keyByProvider[entry.id]
      if (hasKey === false) return { ...base, models: [], emptyState: 'add-key' }
      if (hasLive) return { ...base, models: liveCatalog }
      // Key present but catalog empty/unreachable: say so rather than seed.
      if (hasKey === true) return { ...base, models: [], emptyState: 'no-models' }
      // Key state not yet fetched — show the seed provisionally until the user
      // browses to this provider and its live catalog + key status load.
      return { ...base, models: entry.models }
    })
}

// Clipboard reads/writes go through the main process: an Electron renderer has
// no permission-free `navigator.clipboard` read, and the app already owns this
// bridge for the terminal. An unavailable bridge reads as an empty clipboard,
// which disables Paste rather than offering an item that would do nothing.
async function readClipboardText(): Promise<string> {
  if (typeof window.api?.clipboardReadText !== 'function') return ''
  try {
    return await window.api.clipboardReadText()
  } catch {
    return ''
  }
}

// Reports whether the text actually reached the clipboard: Cut removes the
// selection only on a true, so a failed write can never lose the text from both
// the draft and the clipboard.
async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof window.api?.clipboardWriteText !== 'function') return false
  try {
    await window.api.clipboardWriteText(text)
    return true
  } catch {
    return false
  }
}

function PaperclipGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M13.75 8.5l-4.6 4.6a2.4 2.4 0 0 1-3.4-3.4l5.6-5.6a3.4 3.4 0 0 1 4.8 4.8l-5.6 5.6a4.4 4.4 0 0 1-6.2-6.2l4.6-4.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SendArrowGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 15.5V5M10 5L5.75 9.25M10 5l4.25 4.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StopGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.6" fill="currentColor" />
    </svg>
  )
}
