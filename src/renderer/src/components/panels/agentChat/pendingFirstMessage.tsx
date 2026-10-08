// The first message of a chat that is not ready to send it yet — a New chat
// whose worktree is still being made, or whose provider is still being
// checked. Enter on New chat opened the chat at once, so what was typed shows
// here as the person's bubble with the line saying what it waits on, rather
// than an empty chat that looks as if the words were lost. The bubble is the
// one a sent message draws; it gives way to that one when the message goes.

import React, { useState } from 'react'

import { UserTimelineRow, WorkingTimelineRow } from './timelineRows'

export function PendingFirstMessage({
  text,
  files,
  label,
}: {
  text: string
  /** The files and images the message carries, by path, drawn as its cards. */
  files: readonly string[]
  /** What the message waits on, in words: "Preparing worktree…". */
  label: string
}) {
  // When the wait began, for the line's elapsed time: the first frame shown.
  const [since] = useState(() => Date.now())
  return (
    <div className="chat-column-gutter h-full overflow-y-auto py-4" data-pending-first-message="">
      <UserTimelineRow
        entry={{
          kind: 'user',
          id: 'pending-first-message',
          text,
          createdAt: since,
          ...(files.length ? { files: files.map((path) => ({ path })) } : {}),
        }}
      />
      <WorkingTimelineRow
        row={{ kind: 'working', id: 'pending-first-message-working', stage: 'thinking', label, startedAt: since }}
      />
    </div>
  )
}
