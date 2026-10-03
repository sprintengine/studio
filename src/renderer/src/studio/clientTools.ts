import { useEffect, useSyncExternalStore } from 'react'

import {
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_RESERVED_TOOLSET_NAMES,
  type StudioToolsetListing,
} from '../../../../packages/studio-protocol/src/public'
import { mcpCallOf } from '../../../shared/conversation/approvalRules'
import { STUDIO_MCP_SERVER_ID } from '../../../shared/product-identity'
import { windowStudioClient } from './windowStudioClient'

// The toolsets apps give this Studio's agents, as this window sees them: the
// `tools.catalog` stream over the window's own Studio connection. A chat
// labels a tool step or a permission request whose tool an app offers with
// that app's name ("from Acme Game"), resolved here from the tool's name
// alone, so the conversation contract carries nothing new.
//
// Nothing connects until a tool that could be an app's is shown: Studio's own
// tool families are never an app's, and a window that never shows one never
// subscribes.

type Listing = Pick<StudioToolsetListing, 'name' | 'title' | 'builtIn'>

let toolsets: readonly Listing[] = []
const listeners = new Set<() => void>()
let started = false

function publish(next: readonly Listing[]): void {
  toolsets = next
  for (const listener of [...listeners]) listener()
}

function apply(payload: unknown): void {
  const listed = (payload as { toolsets?: unknown } | null)?.toolsets
  if (!Array.isArray(listed)) return
  publish(
    listed
      .filter((entry): entry is Listing => typeof entry?.name === 'string' && typeof entry.title === 'string')
      .map((entry) => ({ name: entry.name, title: entry.title, builtIn: entry.builtIn === true })),
  )
}

/** Follow the catalog, once per window. */
function start(): void {
  if (started) return
  started = true
  let api: Parameters<typeof windowStudioClient>[0]
  try {
    api = window.api
    if (typeof api?.studioConnect !== 'function') return
  } catch {
    return
  }
  void windowStudioClient(api)
    .then((client) => {
      if (!client.supports(STUDIO_CLIENT_TOOLS_CAPABILITY)) return
      client.subscribe('tools.catalog', {}, { onPayload: apply })
      void client
        .request('tools.catalog', {})
        .then(apply)
        .catch(() => undefined)
    })
    .catch(() => {
      // Tried again the next time a tool needs it.
      started = false
    })
}

/** The toolset a Studio gateway tool's name belongs to, or null for any other tool. */
export function gatewayToolsetOf(toolName: string): string | null {
  const call = mcpCallOf(toolName)
  const tool = call && call.server.includes(STUDIO_MCP_SERVER_ID) ? call.tool : toolName.includes('.') ? toolName : null
  if (!tool) return null
  const toolset = /^([a-z][a-z0-9-]{1,15})[._]/u.exec(tool)?.[1]
  return toolset ?? null
}

/** The app a tool comes from, by its title, given the catalog; null for Studio's own tools and any other. */
export function clientToolOriginOf(toolName: string, listed: readonly Listing[]): string | null {
  const toolset = gatewayToolsetOf(toolName)
  if (!toolset || STUDIO_RESERVED_TOOLSET_NAMES.includes(toolset)) return null
  const found = listed.find((entry) => entry.name === toolset && !entry.builtIn)
  return found ? found.title : null
}

const snapshot = () => toolsets

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The app a tool comes from, kept current as apps offer and withdraw. */
export function useClientToolOrigin(toolName: string | undefined): string | null {
  const listed = useSyncExternalStore(subscribe, snapshot, snapshot)
  const toolset = toolName ? gatewayToolsetOf(toolName) : null
  const maybeAnApps = toolset !== null && !STUDIO_RESERVED_TOOLSET_NAMES.includes(toolset)
  useEffect(() => {
    if (maybeAnApps) start()
  }, [maybeAnApps])
  return toolName ? clientToolOriginOf(toolName, listed) : null
}

/** Every app toolset this window knows of, for a chat's menu. */
export function useAppToolsets(): readonly Listing[] {
  useEffect(() => start(), [])
  const listed = useSyncExternalStore(subscribe, snapshot, snapshot)
  return listed.filter((entry) => !entry.builtIn)
}

/** The app toolsets one conversation was opened to. */
export async function conversationToolGrants(key: { workspaceId: string; agentId: string }): Promise<string[]> {
  const client = await windowStudioClient(window.api)
  if (!client.supports(STUDIO_CLIENT_TOOLS_CAPABILITY)) return []
  return (await client.request('tools.grants', { key })).grants
}

/** Open one conversation to one app's toolset, or close it. Answers the toolsets it is open to now. */
export async function setConversationToolGrant(
  key: { workspaceId: string; agentId: string },
  toolset: string,
  granted: boolean,
): Promise<string[]> {
  const client = await windowStudioClient(window.api)
  const commandId = `grant-${globalThis.crypto.randomUUID()}`
  return (await client.request('tools.grant', { key, toolset, granted, commandId })).grants
}

/** Tests only: start again from no catalog. */
export function resetClientToolsForTests(next: readonly Listing[] = []): void {
  started = next.length > 0
  publish(next)
}
