import React from 'react'

import { openAwaitingFiles } from '../../hooks/useAgentEditorReveal'
import { setAgentRevealNotice, useAgentRevealNotice } from '../../utils/agentEditorReveal'
import { GhostButton } from '../ui'

// The files outside the workspace an agent asked to show, above the
// workspace's editor area. It is a question with two answers, as ghost buttons
// beside it; nothing opens until the person picks Open.
export function AgentRevealStrip({ workspaceId }: { workspaceId: string }) {
  const notice = useAgentRevealNotice(workspaceId)
  if (!notice) return null
  const who = notice.agentName?.trim() || 'An agent'
  const awaiting = notice.awaiting
  const target = awaiting.length === 1 ? awaiting[0].displayPath : `${awaiting.length} files outside this workspace`

  return (
    <div className="flex shrink-0 flex-col border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
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
