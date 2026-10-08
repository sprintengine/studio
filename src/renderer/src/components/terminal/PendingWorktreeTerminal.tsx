// A terminal agent opened before its worktree (utils/newChatWorktree.ts): what
// its pane shows in place of a terminal until the worktree is its folder. There
// is no terminal yet on purpose. A pty spawned now would start in the app's
// default folder, not in the worktree the person asked for, so the pane mounts
// none, and the agent's launch (its first prompt with it) happens when the
// folder lands, as an agent opened in a folder does at once.
//
// The prompt waits on screen beside the line saying what it waits on, the way a
// chat agent's first message does (agentChat/pendingFirstMessage.tsx); a
// worktree that could not be made says why, with Retry and Start in the
// project.

import React, { useState } from 'react'

import { ReadinessState } from '../panels/agentChat/chatStates'
import type { PendingWorktreeGate } from '../panels/agentChat/chatBinding'
import { WorkingTimelineRow } from '../panels/agentChat/timelineRows'

export function PendingWorktreeTerminal({ gate, prompt }: { gate: PendingWorktreeGate; prompt: string | null }) {
  // When the wait began, for the line's elapsed time: the first frame shown.
  const [since] = useState(() => Date.now())
  const { readiness } = gate
  return (
    <div
      data-pending-worktree-terminal={readiness.kind}
      // The agent pane sets mono for its terminal; this is the app talking.
      className="absolute inset-0 overflow-y-auto bg-[color:var(--agent-surface)] font-sans"
    >
      {readiness.kind === 'worktree-failed' ? (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <ReadinessState
              readiness={readiness}
              canSwitchModel={false}
              onSwitchModel={() => undefined}
              worktreeActions={gate.worktreeActions}
              worktreeFailedNote={
                prompt?.trim()
                  ? 'Nothing was started; the agent takes the prompt below when it does.'
                  : 'Nothing was started.'
              }
            />
          </div>
          {/* The prompt it is holding, so the promise above can be checked. */}
          {prompt?.trim() ? (
            <p className="mx-auto mb-8 w-full max-w-[560px] whitespace-pre-wrap break-words px-6 font-mono text-body text-[color:var(--text-muted)]">
              {prompt.trim()}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center px-6">
          <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3">
            {prompt?.trim() ? (
              <p className="whitespace-pre-wrap break-words font-mono text-body text-[color:var(--text-default)]">
                {prompt.trim()}
              </p>
            ) : null}
            <WorkingTimelineRow
              row={{
                kind: 'working',
                id: 'pending-worktree-terminal',
                stage: 'thinking',
                label: readiness.label ?? 'Preparing worktree…',
                startedAt: since,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
