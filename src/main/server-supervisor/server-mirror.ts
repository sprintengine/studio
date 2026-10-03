import { ControlRpcError, type ControlRpc } from '../../server/bootstrap/control-rpc'
import {
  SERVER_EVENTS,
  SERVER_METHODS,
  type ServerMirrorLaunchSettings,
  type ServerMirrorRegistry,
  type ServerMirrorState,
} from '../../server/desktop/server-methods'
import {
  emptyAgentLaunchSettings,
  type AgentLaunchSettings,
  type AgentLaunchSettingsRecord,
  type AgentLaunchSettingsSnapshot,
} from '../../shared/launch-settings'
import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot, WorkspaceSyncState } from '../../shared/workspace-sync'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'

// The shell's read-only copy of what the Studio server owns and the shell
// reads synchronously (phase 6 spec, section 5): the workspace registry and
// the launch settings. A terminal launch, the agent registration, the plugin
// pass over every workspace, the canvas and the tours all ask these at once,
// in the middle of their own work; out of process the answer has to be here
// already. The server pushes each change as it is accepted, and the mirror
// starts over from a fresh snapshot after every server restart.
//
// Writes are asynchronous calls: an agent record a terminal launch writes is
// sent and answered optimistically, the way a window's own write is. One the
// server could not take (it is starting, restarting, or not yet serving) is
// held, in order, and sent before the next snapshot is read, so a terminal
// agent started while the server was away keeps its row.
//
// The proxies have the shapes the in-process services have, for the members
// the shell uses, so the shell's composition does not branch on every read.

export type ServerStateMirror = {
  /** Load a fresh snapshot (the first `ready`, and every restart's). */
  load(): Promise<void>
  /** Resolves once a snapshot has arrived. */
  whenLoaded(): Promise<void>
  readonly registry: MirrorRegistry
  readonly workspaceSync: MirrorWorkspaceSync
  readonly launchSettings: MirrorLaunchSettings
}

export type MirrorRegistry = {
  getState(): WorkspaceSyncState
  getRecords(): WorkspaceRegistryRecord[]
  getRecord(workspaceId: string): WorkspaceRegistryRecord | null
  needsHydration(): boolean
  subscribe(listener: (state: WorkspaceSyncState) => void): () => void
}

export type MirrorWorkspaceSync = {
  getSnapshot(): WorkspaceSyncSnapshot
  subscribeEvents(listener: (event: WorkspaceSyncEvent) => void): () => void
  updateWorkspaceAgent(
    workspaceId: string,
    agentId: string,
    patch: unknown,
    actor: string,
    stamp?: number,
  ): { ok: true } | { ok: false; reason: string; message: string }
  /** The server flushes its own registry; nothing is held here. */
  flush(): Promise<void>
}

export type MirrorLaunchSettings = {
  get(): AgentLaunchSettings
  getRecord(): AgentLaunchSettingsRecord | null
  getSnapshot(): Promise<AgentLaunchSettingsSnapshot>
  subscribe(listener: (record: AgentLaunchSettingsRecord) => void): () => void
}

const EMPTY_STATE: WorkspaceSyncState = {
  workspaces: [],
  activeWorkspaceId: null,
  workspaceWindows: [],
  primaryWorkspaceWindowId: 'primary',
  lastAppliedWorkspaceSyncSequence: 0,
}

export function createServerStateMirror(deps: {
  rpc: Pick<ControlRpc, 'call' | 'on'>
  log?: (line: string) => void
}): ServerStateMirror {
  // Until the first snapshot nothing is known: `needsHydration` answers true,
  // which every reader takes as "not yet" rather than "this agent is gone"
  // (the prompt store must not drop a live agent's history on an empty mirror).
  let registryView: ServerMirrorRegistry = {
    state: EMPTY_STATE,
    snapshot: { sequence: 0, state: stripSequence(EMPTY_STATE) },
    needsHydration: true,
  }
  let launch: ServerMirrorLaunchSettings = { settings: emptyAgentLaunchSettings(), record: null }
  const registryListeners = new Set<(state: WorkspaceSyncState) => void>()
  const eventListeners = new Set<(event: WorkspaceSyncEvent) => void>()
  const launchListeners = new Set<(record: AgentLaunchSettingsRecord) => void>()
  // Agent records the server could not take yet, oldest first.
  const heldWrites: Array<Record<string, unknown>> = []
  let markLoaded: () => void = () => undefined
  const loaded = new Promise<void>((resolve) => {
    markLoaded = resolve
  })

  const fan = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (error) {
        deps.log?.(`a mirror listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const applyRegistry = (next: ServerMirrorRegistry): void => {
    registryView = next
    fan(registryListeners, next.state)
  }
  const applyLaunch = (next: ServerMirrorLaunchSettings): void => {
    const changed = next.record && next.record.revision !== launch.record?.revision
    launch = next
    if (changed && next.record) fan(launchListeners, next.record)
  }

  deps.rpc.on(SERVER_EVENTS.mirrorRegistry, (payload) => applyRegistry(payload as ServerMirrorRegistry))
  deps.rpc.on(SERVER_EVENTS.mirrorWorkspaceEvent, (payload) => fan(eventListeners, payload as WorkspaceSyncEvent))
  deps.rpc.on(SERVER_EVENTS.mirrorLaunchSettings, (payload) => applyLaunch(payload as ServerMirrorLaunchSettings))

  const serverAway = (error: unknown): boolean =>
    error instanceof ControlRpcError && (error.code === 'unavailable' || error.code === 'no_handler')
  const hold = (params: Record<string, unknown>): void => {
    heldWrites.push(params)
    if (heldWrites.length > MAX_HELD_WRITES) {
      heldWrites.shift()
      deps.log?.('agent record dropped: too many waiting for Studio server')
    }
  }
  const sendWrite = (params: Record<string, unknown>): Promise<void> =>
    deps.rpc.call(SERVER_METHODS.updateWorkspaceAgent, params).then((result) => {
      const answer = result as { ok?: boolean; message?: string } | null
      if (answer && answer.ok === false) deps.log?.(`agent record not written: ${answer.message ?? ''}`)
    })
  // Sent one at a time, in order; one the server still cannot take stays
  // first in line for the next snapshot.
  const sendHeld = async (): Promise<void> => {
    while (heldWrites.length > 0) {
      try {
        await sendWrite(heldWrites[0])
      } catch (error) {
        if (serverAway(error)) return
        deps.log?.(`agent record not written: ${error instanceof Error ? error.message : String(error)}`)
      }
      heldWrites.shift()
    }
  }

  return {
    async load() {
      await sendHeld()
      const state = await deps.rpc.call<ServerMirrorState>(SERVER_METHODS.mirrorSnapshot)
      applyRegistry({ state: state.state, snapshot: state.snapshot, needsHydration: state.needsHydration })
      applyLaunch(state.launchSettings)
      markLoaded()
    },
    whenLoaded: () => loaded,
    registry: {
      getState: () => registryView.state,
      getRecords: () => registryView.state.workspaces as WorkspaceRegistryRecord[],
      getRecord: (workspaceId) =>
        (registryView.state.workspaces.find((workspace) => workspace.id === workspaceId) as
          WorkspaceRegistryRecord | undefined) ?? null,
      needsHydration: () => registryView.needsHydration,
      subscribe(listener) {
        registryListeners.add(listener)
        return () => {
          registryListeners.delete(listener)
        }
      },
    },
    workspaceSync: {
      getSnapshot: () => registryView.snapshot,
      subscribeEvents(listener) {
        eventListeners.add(listener)
        return () => {
          eventListeners.delete(listener)
        }
      },
      updateWorkspaceAgent(workspaceId, agentId, patch, actor, stamp) {
        const params = { workspaceId, agentId, patch, actor, ...(typeof stamp === 'number' ? { stamp } : {}) }
        // Behind any already held, so a later patch never lands before an earlier one.
        if (heldWrites.length > 0) {
          hold(params)
          return { ok: true }
        }
        void sendWrite(params).catch((error: unknown) => {
          if (serverAway(error)) hold(params)
          else deps.log?.(`agent record not written: ${error instanceof Error ? error.message : String(error)}`)
        })
        return { ok: true }
      },
      flush: async () => undefined,
    },
    launchSettings: {
      get: () => launch.settings,
      getRecord: () => launch.record,
      getSnapshot: async () => ({
        record: launch.record,
        settings: launch.settings,
        persisted: launch.record !== null,
      }),
      subscribe(listener) {
        launchListeners.add(listener)
        return () => {
          launchListeners.delete(listener)
        }
      },
    },
  }
}

/** Agent records held for a server that is away; past this the oldest goes. */
const MAX_HELD_WRITES = 500

function stripSequence(state: WorkspaceSyncState): WorkspaceSyncSnapshot['state'] {
  const { lastAppliedWorkspaceSyncSequence: _sequence, ...rest } = state
  return rest
}
