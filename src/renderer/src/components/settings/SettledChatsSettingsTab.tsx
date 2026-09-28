import React, { useMemo, useState } from 'react'

import type { WorkspaceId } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { EmptyState, GhostButton, OutlineButton } from '../ui'
import { SettingCard, SettingsPageHeader } from './SettingsAtoms'
import { listSettledChats } from './settledChatsModel'

/**
 * Settings ▸ Settled chats (owner, 2026-09-28): where a chat goes once it has
 * come to rest. The sidebar used to fold these into a Settled shelf under
 * every project; that was one more line to read past for chats the person had
 * already called finished, so the rail stopped drawing them and this page
 * holds them instead.
 *
 * Two things to do with one, both the ones the shelf offered: Open reads it
 * (and, as opening any settled chat does, leaves it settled — reading is not
 * activity), and Un-settle puts it back in its project's list.
 */
export function SettledChatsSettingsTab({
  onOpenChat,
}: {
  /** Leave Settings for this chat. */
  onOpenChat: (id: WorkspaceId) => void
}): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setWorkspaceSettled = useWorkspaceStore((s) => s.setWorkspaceSettled)
  // One clock for the visit: "settled 3d ago" does not need to tick while the
  // page is open, and a timer here would re-render the list for nothing.
  const [now] = useState(() => Date.now())

  const chats = useMemo(() => listSettledChats(workspaces, moduleOverrides), [workspaces, moduleOverrides])

  return (
    <div role="tabpanel" id="settings-panel-settled-chats" aria-labelledby="settings-tab-settled-chats">
      <SettingsPageHeader title="Settled chats" meta={chats.length > 0 ? `${chats.length}` : undefined} />
      {chats.length === 0 ? (
        <EmptyState
          density="list"
          title="No settled chats."
          body="A chat settles after three days without activity, or when you settle it from its menu."
        />
      ) : (
        <SettingCard as="ul" ariaLabel="Settled chats">
          {chats.map((chat) => (
            <li key={chat.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium text-[color:var(--text-strong)]" title={chat.title}>
                  {chat.title}
                </div>
                <div className="truncate text-meta text-[color:var(--text-subtle)]">
                  {chat.project} · Settled {formatRelativeMsAgo(chat.settledAt, now)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* The visible word leads the accessible name, and the chat
                    follows it, so a list of these is not a list of identical
                    buttons. */}
                <GhostButton
                  size="xs"
                  aria-label={`Un-settle ${chat.title}`}
                  onClick={() => setWorkspaceSettled(chat.id, false)}
                >
                  Un-settle
                </GhostButton>
                <OutlineButton size="xs" aria-label={`Open ${chat.title}`} onClick={() => onOpenChat(chat.id)}>
                  Open
                </OutlineButton>
              </div>
            </li>
          ))}
        </SettingCard>
      )}
    </div>
  )
}
