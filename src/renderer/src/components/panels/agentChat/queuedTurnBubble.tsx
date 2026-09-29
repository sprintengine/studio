// The message a person committed while the agent was working, as a row in the
// composer tray: "Queued", then the message on one line. It waits for the turn
// to end on its own; "Send now" hands it to the running turn instead (a
// steer), and Edit takes it back into the composer.

import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { GhostButton, Tooltip, TruncatedText } from '../../ui'
import { ComposerTrayRow } from './composerTray'

export type QueuedTurnSendNow = {
  // `steer` delivers into the running turn; `interrupt` stops it, and the queue
  // sends the message the moment the session is free, as it always does.
  kind: 'steer' | 'interrupt'
  label: string
  disabled: boolean
  // Why the action is unavailable, for its tooltip; absent while it is.
  reason?: string
}

// What "send it now" can do for the queued message at this moment. A provider
// that takes a message mid-turn gets a steer; any other has only Stop, so the
// action says so rather than promising a delivery it cannot make. A card the
// agent is blocked on holds the message either way: the agent reads nothing
// until it is answered.
export function queuedTurnSendNow(options: {
  canSteer: boolean
  activeTurn: boolean
  awaitingApproval: boolean
  stopping: boolean
  steering: boolean
}): QueuedTurnSendNow {
  const kind = options.canSteer ? 'steer' : 'interrupt'
  const label = options.canSteer ? 'Send now' : 'Stop and send'
  const refuse = (reason: string): QueuedTurnSendNow => ({ kind, label, disabled: true, reason })
  if (options.awaitingApproval) return refuse('Answer the open request first — the agent is waiting on it.')
  if (options.steering) return refuse('The last message is still being delivered.')
  if (options.stopping) return refuse('The turn is stopping.')
  if (!options.activeTurn) return refuse('The turn is still starting.')
  return { kind, label, disabled: false }
}

// A dashed ring round a clock hand: something waiting its turn, on the
// lifecycle glyphs' 16-grid.
function QueuedGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="icon-sm shrink-0 text-[color:var(--text-subtle)]"
    >
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
      <path d="M8 5.5v2.75l1.75 1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function QueuedTurnRow({
  text,
  attachments,
  sendNow,
  shortcutLabel,
  onSendNow,
  onEdit,
}: {
  text: string
  attachments: ConversationImageAttachment[]
  sendNow: QueuedTurnSendNow
  // The chord that sends now from the composer, for the action's tooltip.
  shortcutLabel: string
  onSendNow: () => void
  onEdit: () => void
}) {
  const sendNowHint =
    sendNow.reason ??
    (sendNow.kind === 'steer'
      ? `Give this to the agent while it works (${shortcutLabel})`
      : `Stop the reply and send this instead (${shortcutLabel})`)
  return (
    <ComposerTrayRow
      role="group"
      ariaLabel="Queued message"
      glyph={<QueuedGlyph />}
      actions={
        <>
          <Tooltip content={sendNowHint} placement="top">
            <GhostButton size="xs" disabled={sendNow.disabled} onClick={onSendNow}>
              {sendNow.label}
            </GhostButton>
          </Tooltip>
          <Tooltip content="Take it back into the composer" placement="top">
            <GhostButton size="xs" onClick={onEdit}>
              Edit
            </GhostButton>
          </Tooltip>
        </>
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <Tooltip content="Sends when this turn ends" placement="top">
          <span className="shrink-0">Queued</span>
        </Tooltip>
        {attachments.map((attachment) => (
          <AttachmentThumbnail key={attachment.id} attachment={attachment} className="h-5 w-5 shrink-0" />
        ))}
        {text ? (
          <TruncatedText as="span" text={text} className="min-w-0 text-meta italic text-[color:var(--text-muted)]" />
        ) : null}
      </span>
    </ComposerTrayRow>
  )
}
