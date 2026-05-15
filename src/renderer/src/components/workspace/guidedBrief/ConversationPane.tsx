import { useEffect, useRef, useState } from 'react'
import { StatusDot } from '../../ui'
import { GuidedBriefRawTerminal } from './GuidedBriefRawTerminal'
import { ParsedConversationView } from './ParsedConversationView'
import {
  appendSpecChunk,
  appendUserTurn,
  type ConversationTurn,
} from './parseStream'
import type { GuidedBriefSpecialistSession } from './sessionAdapter'
import {
  buildPastedImageDescriptor,
  clipboardImageFromEvent,
  fileToBase64,
  type GuidedBriefAttachment,
} from './pasteAttachment'

type ComposerNotice = {
  tone: 'info' | 'warn'
  message: string
}

type ImagePasteContext = {
  workspaceRoot: string
  inspirationDirectoryPath: string
}

export type ConversationView = 'parsed' | 'raw'

type Props = {
  session: GuidedBriefSpecialistSession | null
  starting: boolean
  errorMessage: string | null
  specialistName: string
  specialistSubline: string
  isLive: boolean
  composerPlaceholder: string
  imagePaste?: ImagePasteContext
  view: ConversationView
}

export function ConversationPane({
  session,
  starting,
  errorMessage,
  specialistName,
  specialistSubline,
  isLive,
  composerPlaceholder,
  imagePaste,
  view,
}: Props) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [composerNotice, setComposerNotice] = useState<ComposerNotice | null>(null)
  const [attachments, setAttachments] = useState<GuidedBriefAttachment[]>([])
  const [turns, setTurns] = useState<ConversationTurn[]>([])
  const turnCounterRef = useRef(0)

  const canSend = !!session && !sending && (draft.trim().length > 0 || attachments.length > 0)

  const buildOutgoingMessage = () => {
    const trimmed = draft.trim()
    if (attachments.length === 0) return trimmed
    const references = attachments.map((a) => `[attached: ${a.relativePath}]`).join('\n')
    return trimmed ? `${references}\n\n${trimmed}` : references
  }

  // Subscribe to the same terminal stdout stream the raw xterm host receives,
  // and build a parsed view of speaker turns from it. Cleanup removes only
  // this subscription — the underlying agent process is not affected.
  useEffect(() => {
    if (!session) return
    const unsubscribe = window.api.onTerminalData(session.sessionId, (chunk) => {
      setTurns((prev) =>
        appendSpecChunk({
          chunk,
          turns: prev,
          now: Date.now(),
          nextSpecTurnId: () => {
            turnCounterRef.current += 1
            return `spec-${turnCounterRef.current}`
          },
        }),
      )
    })
    return () => {
      unsubscribe()
    }
  }, [session?.sessionId])

  const handleSend = async () => {
    if (!session || !canSend) return
    const outgoing = buildOutgoingMessage()
    if (!outgoing) return
    setSending(true)
    try {
      await session.sendMessage(outgoing)
      const visibleMessage = composeVisibleUserMessage(draft, attachments)
      if (visibleMessage) {
        setTurns((prev) =>
          appendUserTurn({
            message: visibleMessage,
            turns: prev,
            now: Date.now(),
            nextUserTurnId: () => {
              turnCounterRef.current += 1
              return `user-${turnCounterRef.current}`
            },
          }),
        )
      }
      setDraft('')
      setAttachments([])
      setComposerNotice(null)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      void handleSend()
    }
  }

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imagePaste) return
    const imageFile = clipboardImageFromEvent(event)
    if (!imageFile) return
    event.preventDefault()
    setComposerNotice(null)
    try {
      const descriptor = buildPastedImageDescriptor({
        workspaceRoot: imagePaste.workspaceRoot,
        inspirationDirectoryPath: imagePaste.inspirationDirectoryPath,
        file: imageFile,
      })
      const base64 = await fileToBase64(imageFile)
      const guidedBriefDir = await window.api.ensureDir(imagePaste.workspaceRoot, '.guided-brief')
      await window.api.ensureDir(guidedBriefDir, 'inspiration')
      await window.api.writeBinaryFile(descriptor.absolutePath, base64)
      setAttachments((prev) => [...prev, descriptor])
    } catch (error) {
      setComposerNotice({
        tone: 'warn',
        message:
          error instanceof Error
            ? `Could not attach pasted image: ${error.message}`
            : 'Could not attach pasted image.',
      })
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="icon-md">
            <circle cx="12" cy="9" r="3" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5 19c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
            {specialistName}
          </span>
          <span className="truncate text-[12px] text-[color:var(--text-muted)]">
            {specialistSubline}
          </span>
        </div>
        {isLive ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--text-muted)]">
            <StatusDot tone="good" pulse />
            Live
          </span>
        ) : null}
      </div>

      <div
        data-conversation-view={view}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)]"
      >
        {view === 'raw' ? (
          session ? (
            <GuidedBriefRawTerminal sessionId={session.sessionId} className="px-3 py-2" />
          ) : (
            <RawPlaceholder
              specialistName={specialistName}
              starting={starting}
              errorMessage={errorMessage}
            />
          )
        ) : (
          <ParsedConversationView
            specialistName={specialistName}
            starting={starting}
            errorMessage={errorMessage}
            turns={turns}
          />
        )}
      </div>

      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1 text-[11px] text-[color:var(--text-default)]">
                <svg className="icon-sm text-[color:var(--text-muted)]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="9" cy="9.5" r="1.4" fill="currentColor" />
                  <path d="M4.5 16l4.5-4 4 3.5 3-2.5 3.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
                <span className="font-mono">{attachment.relativePath}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.relativePath}`}
                  className="
                    inline-flex h-4 w-4 items-center justify-center rounded-sm text-[color:var(--text-muted)]
                    transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  "
                >
                  <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                    <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(event) => void handlePaste(event)}
            placeholder={composerPlaceholder}
            rows={2}
            disabled={!session}
            className="
              min-h-[44px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2
              text-[13px] leading-5 text-[color:var(--text-strong)] outline-none transition-colors
              placeholder:text-[color:var(--text-disabled)]
              hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
              disabled:cursor-not-allowed disabled:opacity-60
            "
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="
              inline-flex h-9 shrink-0 items-center rounded-md bg-[color:var(--accent-primary)] px-3 text-[12px] font-semibold text-[color:var(--bg-app)]
              transition-colors hover:bg-[color:var(--accent-primary-hover)]
              disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            Send
          </button>
        </div>
        <span className="text-[11px] text-[color:var(--text-muted)]">
          <kbd className="rounded border border-[color:var(--border-default)] px-1">⌘</kbd>
          <kbd className="ml-0.5 rounded border border-[color:var(--border-default)] px-1">Enter</kbd>{' '}
          sends{imagePaste ? ' · paste a screenshot to attach' : ' · plain English'}
        </span>
        {composerNotice ? (
          <span
            role="status"
            className={`text-[11px] leading-5 ${
              composerNotice.tone === 'warn'
                ? 'text-[color:var(--tone-warn)]'
                : 'text-[color:var(--text-muted)]'
            }`}
          >
            {composerNotice.message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function RawPlaceholder({
  specialistName,
  starting,
  errorMessage,
}: {
  specialistName: string
  starting: boolean
  errorMessage: string | null
}) {
  if (errorMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-[12px] font-semibold text-[color:var(--tone-error)]">
          {specialistName} session unavailable
        </span>
        <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{errorMessage}</span>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
      {starting
        ? `Starting the ${specialistName.toLowerCase()} session…`
        : `${specialistName} is not connected.`}
    </div>
  )
}

function composeVisibleUserMessage(
  draft: string,
  attachments: GuidedBriefAttachment[],
): string {
  const trimmed = draft.trim()
  if (attachments.length === 0) return trimmed
  const refs = attachments.map((a) => `[attached: ${a.relativePath}]`).join('\n')
  return trimmed ? `${refs}\n\n${trimmed}` : refs
}
