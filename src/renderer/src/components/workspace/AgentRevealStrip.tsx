import React from 'react'

import { openAwaitingFiles } from '../../hooks/useAgentEditorReveal'
import { setAgentRevealNotice, useAgentRevealNotice } from '../../utils/agentEditorReveal'
import { CloseIconButton, GhostButton } from '../ui'

// What an agent said when it opened something (editor.open's `note`), and the
// files outside the workspace it asked to show, above the workspace's editor
// area.
//
// Neither is an inline notice or a banner: both of those carry a tone, and the
// system has no neutral one on purpose — "information is content" (the
// inline-notice entry). An agent's note IS content: one muted line in the
// system's own status idiom (`ActionResultMessage`'s info rendering), with a
// close button, not a toast that disappears before it is read. The request to
// open a file outside the workspace is a question with two answers, as ghost
// buttons beside it; nothing opens until the person picks Open.
export function AgentRevealStrip({ workspaceId }: { workspaceId: string }) {
  const notice = useAgentRevealNotice(workspaceId)
  if (!notice) return null
  const who = notice.agentName?.trim() || 'An agent'
  const awaiting = notice.awaiting
  const target = awaiting.length === 1 ? awaiting[0].displayPath : `${awaiting.length} files outside this workspace`

  return (
    <div className="flex shrink-0 flex-col border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
      {notice.note ? (
        <div className="flex min-h-control-sm items-center gap-2 px-3">
          <p role="status" className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]">
            <span className="text-[color:var(--text-default)]">{who}:</span> {notice.note}
          </p>
          <CloseIconButton
            aria-label="Dismiss the agent's note"
            onClick={() => setAgentRevealNotice(workspaceId, { ...notice, note: null })}
          />
        </div>
      ) : null}
      {awaiting.length > 0 ? (
        <div className="flex min-h-control-sm items-center gap-2 px-3">
          <p role="status" className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]">
            {who} wants to show you{' '}
            <span
              className="font-mono text-[color:var(--text-default)]"
              title={awaiting.map((file) => file.path).join('\n')}
            >
              {target}
            </span>
          </p>
          <GhostButton size="xs" onClick={() => void openAwaitingFiles(workspaceId)}>
            Open
          </GhostButton>
          <GhostButton size="xs" onClick={() => setAgentRevealNotice(workspaceId, { ...notice, awaiting: [] })}>
            Dismiss
          </GhostButton>
        </div>
      ) : null}
    </div>
  )
}
