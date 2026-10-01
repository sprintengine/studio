import { createStudioChatBackend } from '../src/main/studio-rpc/studio-chat-backend'
import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../src/server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../src/server/rpc/studio-rpc-server'
import type { StudioConversationBackend } from '../src/server/rpc/studio-rpc-types'
import type { ConversationSessionFrame } from '../src/shared/conversation-runtime'
import { createMemoryChannel, type MemoryChannelEnd } from './memory-channel'

// The chat view's own tests, run a second time with the window on the Studio
// protocol. A test stubs `window.api` with the conversation IPC it means to
// script, as it always has; this puts a real Studio RPC between the view and
// that stub: the window's client and transport, a port, the connection and
// router, and main's chat backend with its input checks, all answered in the
// end by the same stubbed IPC members. A test that passes both ways shows the
// protocol path changes nothing the view does.
//
// The `chat-over-studio` Vitest project sets STUDIO_CHAT_TRANSPORT_UNDER_TEST;
// in every other run this does nothing.

type Api = Record<string, unknown>

export function chatOverStudioUnderTest(): boolean {
  return process.env.STUDIO_CHAT_TRANSPORT_UNDER_TEST === 'studio'
}

/** A stubbed IPC member, read when it is called so a test may swap it mid-way. */
function call(api: Api, name: string, ...args: unknown[]): Promise<never> {
  const member = api[name]
  if (typeof member !== 'function') return Promise.reject(new Error(`window.api.${name} is not stubbed`))
  return Promise.resolve((member as (...values: unknown[]) => unknown)(...args)) as Promise<never>
}
const has = (api: Api, name: string) => typeof api[name] === 'function'

function conversationsOver(api: Api): StudioConversationBackend {
  return {
    list: async () => [],
    // A window names every conversation by its folder; nothing is resolved by workspace here.
    resolveKey: () => null,
    follow(key, cursor, listener) {
      const stop = (
        api.onConversationSession as (input: unknown, cb: (frame: ConversationSessionFrame) => void) => unknown
      )({ key, ...cursor }, listener)
      return { dispose: () => (typeof stop === 'function' ? stop() : undefined), ready: Promise.resolve() }
    },
    loadEarlier: (key, beforeCursor, turnLimit) =>
      call(api, 'conversationLoadEarlier', { key, beforeCursor, turnLimit }),
    toolDetail: (key, toolUseId) => call(api, 'conversationToolDetail', { ...key, toolUseId }),
    turnDiff: (key, turnSeq, path) => call(api, 'conversationTurnDiff', { key, turnSeq, path }),
    command: async () => ({ ok: false, code: 'unavailable', message: 'A window drives a chat by its session.' }),
    stop: async () => ({ ok: true }),
    permissionOf: () => 'bypass',
    findCreated: () => null,
    create: async () => ({ ok: false, code: 'unavailable', message: 'A window starts a chat by its session.' }),
    redact: (value) => value,
  }
}

// The runtime behind a window's IPC never sees a command id; the protocol's
// carry one for its receipts, which these stubs, standing in for the IPC, are
// not asked to keep.
const withoutId = <T extends { commandId?: string }>({ commandId: _id, ...rest }: T) => rest

function chatOver(api: Api) {
  return createStudioChatBackend({
    conversation: {
      startSession: (input) => call(api, 'conversationSessionStart', input),
      sendTurn: (input) => call(api, 'conversationSessionSendTurn', withoutId(input)),
      interrupt: (input) => call(api, 'conversationSessionInterrupt', withoutId(input)),
      respondToRequest: (input) => call(api, 'conversationSessionRespondToRequest', withoutId(input)),
      setPermission: (input) => call(api, 'conversationSessionSetPermission', withoutId(input)),
      get setModel() {
        return has(api, 'conversationSessionSetModel')
          ? (input: { commandId?: string }) => call(api, 'conversationSessionSetModel', withoutId(input))
          : undefined
      },
      get revertToTurn() {
        return has(api, 'conversationRevertToTurn')
          ? (input: unknown) => call(api, 'conversationRevertToTurn', input)
          : undefined
      },
      get rewindToTurn() {
        return has(api, 'conversationRewindToTurn')
          ? (input: unknown) => call(api, 'conversationRewindToTurn', input)
          : undefined
      },
      get forkAtTurn() {
        return has(api, 'conversationForkAtTurn')
          ? (input: unknown) => call(api, 'conversationForkAtTurn', input)
          : undefined
      },
      get readAttachment() {
        return has(api, 'conversationAttachment')
          ? (ref: string) => call(api, 'conversationAttachment', { ref })
          : undefined
      },
      get planDocument() {
        return has(api, 'conversationPlanDocument')
          ? (input: unknown) => call(api, 'conversationPlanDocument', input)
          : undefined
      },
      listProviders: (input) => call(api, 'conversationProvidersList', input),
      listProviderModels: (input) => call(api, 'conversationProviderModels', input),
      getSecretStatus: (input) => call(api, 'conversationSecretStatus', input),
    },
    files: {
      searchFiles: (_slot, input) =>
        call(api, 'searchFiles', input.rootPath, input.query, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          ...(input.channel === undefined ? {} : { channel: input.channel }),
          ...(input.recentAt === undefined ? {} : { recentAt: input.recentAt }),
        }),
      cancelActiveFileSearch: (_slot, channel) => {
        if (has(api, 'cancelFileSearch')) void call(api, 'cancelFileSearch', channel).catch(() => undefined)
      },
      cancelAllFileSearches: () => undefined,
      statPath: (path) => call(api, 'statPath', path),
      readImageDataUrl: (path) => call(api, 'readImageDataUrl', path),
    },
    repoRoot: (folderPath, hostId) =>
      hostId === undefined ? call(api, 'getGitRepoRoot', folderPath) : call(api, 'getGitRepoRoot', folderPath, hostId),
    commands: (input) => call(api, 'conversationCommands', input),
    onCommandsChanged: (listener) => {
      const subscribe = api.onConversationCommandsChanged as ((cb: typeof listener) => () => void) | undefined
      return typeof subscribe === 'function' ? subscribe(listener) : () => undefined
    },
    workspaces: () => [],
  })
}

export type StudioLoopback = {
  server: StudioRpcServer
  /** Drop every connection the window holds, as a restarted server would; its client reconnects. */
  drop(): void
  /** How many connections the window has opened so far. */
  connections(): number
}

/**
 * Put a stubbed window's chat view on the Studio protocol, when this run is
 * the `chat-over-studio` one. Call it after `window.api` is stubbed; members
 * the test changes later are read when they are called.
 */
export function installStudioLoopback(win: { api?: Api }): StudioLoopback | null {
  if (!chatOverStudioUnderTest()) return null
  const api = (win.api ??= {})
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/studio-loopback',
    version: 'test',
    environmentId: 'studio-loopback',
    backend: conversationsOver(api),
    chat: () => chatOver(api),
    // The socket is never started; windows say hello with their tickets.
    authenticator: createTicketAuthenticator(mintStudioTicket()),
  })
  const windowEnds = new Map<string, MemoryChannelEnd>()
  let opened = 0
  Object.assign(api, {
    studioChatTransport: 'studio',
    studioConnect: async () => {
      const [mainEnd, windowEnd] = createMemoryChannel()
      const ticket = mintStudioTicket()
      const connection = server.attach(framePortStream(mainEnd), {
        authenticator: createTicketAuthenticator(ticket),
        ownWindow: true,
      })
      windowEnds.set(connection.connectionId, windowEnd)
      opened++
      return { connectionId: connection.connectionId, ticket }
    },
    studioPortSend: (connectionId: string, frame: string) => windowEnds.get(connectionId)?.post(frame),
    studioPortListen: (connectionId: string, onFrame: (frame: string) => void, onClose: () => void) => {
      const end = windowEnds.get(connectionId)
      if (!end) {
        onClose()
        return
      }
      end.onFrame(onFrame)
      end.onClose(() => {
        windowEnds.delete(connectionId)
        onClose()
      })
    },
    studioPortClose: (connectionId: string) => windowEnds.get(connectionId)?.close(),
  })
  return {
    server,
    drop: () => {
      for (const end of [...windowEnds.values()]) end.close()
    },
    connections: () => opened,
  }
}
