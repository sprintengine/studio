import type { OfferedToolset, StudioClientTools, ToolDefinition } from '../../../../../packages/agent-sdk/src/tools'
import {
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  type StudioCapability,
} from '../../../../../packages/studio-protocol/src/public'

// When a web tab offers `canvas`, and when it takes it back (phase 9 spec,
// 3.8; decision R79):
//
// - only a tab whose session holds the owner's grants (a loopback pairing),
//   and only to a server that serves client tools and the board files; a
//   tailnet browser never offers it in v1;
// - withdrawn when the page is hidden for good or put in the back/forward
//   cache (`pagehide`), offered again when it comes back (`pageshow`);
// - the tab's visibility is the focus hint, so a tab the person is looking at
//   is preferred over one in the background. A call arrives as a socket
//   message, which a browser does not throttle in a background tab.

export type CanvasToolsetClient = {
  supports(capability: StudioCapability): boolean
  tools: Pick<StudioClientTools, 'offer' | 'focus'>
  close(): void
}

export type WebCanvasToolsetDeps<C extends CanvasToolsetClient> = {
  /** Whether this tab's session is an owner's (GET /api/session). */
  isOwnerSession(): Promise<boolean>
  connect(): Promise<C>
  /** The tools, built over the connected client. */
  tools(client: C): { definitions: ToolDefinition[]; dispose(): Promise<void> }
  /** The page's lifecycle and visibility events. */
  view: Pick<Window, 'addEventListener' | 'removeEventListener'>
  visible(): boolean
  onVisibilityChange(listener: (visible: boolean) => void): () => void
  log?: (message: string) => void
}

export type WebCanvasToolset = {
  /** The toolset as it stands: offered, or why not. */
  state(): 'offered' | 'withdrawn' | 'not-offered'
  stop(): Promise<void>
}

export async function startWebCanvasToolset<C extends CanvasToolsetClient>(
  deps: WebCanvasToolsetDeps<C>,
): Promise<WebCanvasToolset> {
  const notOffered: WebCanvasToolset = { state: () => 'not-offered', stop: async () => undefined }
  if (!(await deps.isOwnerSession().catch(() => false))) return notOffered
  const client = await deps.connect()
  if (!client.supports(STUDIO_CLIENT_TOOLS_CAPABILITY) || !client.supports(STUDIO_BOARD_FILES_CAPABILITY)) {
    client.close()
    return notOffered
  }
  const tools = deps.tools(client)
  let offered: OfferedToolset | null = null
  let offering: Promise<void> | null = null

  const focus = (visible: boolean) => client.tools.focus({ focused: visible, workspaceIds: [] })
  const offer = () => {
    if (offered || offering) return offering ?? Promise.resolve()
    offering = client.tools
      .offer({ name: 'canvas', title: 'Canvas', tools: tools.definitions })
      .then((toolset) => {
        offered = toolset
        focus(deps.visible())
      })
      .catch((error: unknown) =>
        deps.log?.(`canvas was not offered: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        offering = null
      })
    return offering
  }
  const withdraw = () => {
    const current = offered
    offered = null
    if (current) void current.withdraw().catch(() => undefined)
  }

  const onPageHide = () => withdraw()
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) void offer()
  }
  deps.view.addEventListener('pagehide', onPageHide)
  deps.view.addEventListener('pageshow', onPageShow)
  const stopVisibility = deps.onVisibilityChange((visible) => {
    if (offered) focus(visible)
  })
  await offer()

  return {
    state: () => (offered ? 'offered' : 'withdrawn'),
    async stop() {
      deps.view.removeEventListener('pagehide', onPageHide)
      deps.view.removeEventListener('pageshow', onPageShow)
      stopVisibility()
      withdraw()
      await tools.dispose()
      client.close()
    },
  }
}
