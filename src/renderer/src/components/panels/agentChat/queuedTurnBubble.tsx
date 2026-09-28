// The message a person committed while the agent was working, shown where it
// will land: a dashed ghost of the bubble it becomes, at the foot of the
// conversation above the composer. It waits for the turn to end on its own;
// "Send now" hands it to the running turn instead (a steer), and Edit takes it
// back into the composer.

import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { GhostButton, Tooltip } from '../../ui'

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

export function QueuedTurnBubble({
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
    <div role="group" aria-label="Queued message" className="mb-2 flex flex-col items-end">
      <div className="max-w-[76%] rounded-sm border border-dashed border-[color:var(--border-default)] px-3 py-1.5">
        {attachments.length > 0 ? (
          <div className={`flex flex-wrap justify-end gap-1.5 ${text ? 'mb-2' : ''}`}>
            {attachments.map((attachment) => (
              <AttachmentThumbnail key={attachment.id} attachment={attachment} className="h-10 w-10" />
            ))}
          </div>
        ) : null}
        {text ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-body leading-normal text-[color:var(--text-muted)]">
            {text}
          </p>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="text-meta leading-5 text-[color:var(--text-muted)]">Queued · sends when this turn ends</span>
        <Tooltip content={sendNowHint} placement="top">
          <GhostButton size="inline" disabled={sendNow.disabled} onClick={onSendNow}>
            {sendNow.label}
          </GhostButton>
        </Tooltip>
        <Tooltip content="Take it back into the composer" placement="top">
          <GhostButton size="inline" onClick={onEdit}>
            Edit
          </GhostButton>
        </Tooltip>
      </div>
    </div>
  )
}
