import { useEffect, useState } from 'react'

import { conversationToolGrants, setConversationToolGrant, useAppToolsets } from '../../studio/clientTools'
import { MenuDivider, MenuItem } from '../ui'

// A chat tab's menu rows for the tools apps offer: an app's tools reach the
// chats it started, and the person may open any other chat to them, or close
// one again, here. One row per app toolset, ticked when this chat may use it.
// Nothing shows while no app offers tools.

export function ChatAppToolsMenuItems({
  workspaceId,
  agentId,
  onDone,
}: {
  workspaceId: string
  agentId: string
  onDone: () => void
}) {
  const toolsets = useAppToolsets()
  const [grants, setGrants] = useState<string[] | null>(null)
  useEffect(() => {
    if (toolsets.length === 0) return undefined
    let live = true
    void conversationToolGrants({ workspaceId, agentId })
      .then((next) => {
        if (live) setGrants(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workspaceId, agentId, toolsets.length])
  if (toolsets.length === 0) return null
  return (
    <>
      <MenuDivider />
      {toolsets.map((toolset) => {
        const granted = grants?.includes(toolset.name) ?? false
        return (
          <MenuItem
            key={toolset.name}
            checked={granted}
            disabled={grants === null}
            hint={granted ? 'This chat may use them' : 'Only the chats it starts'}
            onClick={() => {
              onDone()
              void setConversationToolGrant({ workspaceId, agentId }, toolset.name, !granted).catch(() => undefined)
            }}
          >
            Tools from {toolset.title}
          </MenuItem>
        )
      })}
    </>
  )
}
