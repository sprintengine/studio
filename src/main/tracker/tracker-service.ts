import { TrackerConnectionStore, type TrackerConnectionStoreOptions } from './connection-store'
import { getSharedTrackerProviderRegistry, TrackerProviderRegistry } from './provider-registry'
import {
  toTrackerError,
  TrackerProviderError,
  type TrackerAddConnectionInput,
  type TrackerAddConnectionResult,
  type TrackerConnectionProbe,
  type TrackerFetchIssueInput,
  type TrackerFetchIssueResult,
  type TrackerListConnectionsResult,
  type TrackerProvider,
  type TrackerProviderId,
  type TrackerRemoveConnectionInput,
  type TrackerRemoveConnectionResult,
  type TrackerSearchInput,
  type TrackerSearchResult,
  type TrackerTestConnectionInput,
  type TrackerTestConnectionResult,
  type TrackerTransition,
} from '../../shared/tracker/types'

// Orchestrates the tracker seam behind the IPC surface: connection CRUD delegates
// to the connection store; search / fetch / test route through the registered
// provider client and normalize every failure to a typed TrackerError so a stack
// trace never crosses to the renderer (plan §3.3). With no client registered the
// service degrades honestly rather than faking a result.

export class TrackerService {
  private readonly connectionStore: TrackerConnectionStore
  private readonly registry: TrackerProviderRegistry

  constructor(options: { connectionStore?: TrackerConnectionStore; registry?: TrackerProviderRegistry } = {}) {
    this.registry = options.registry ?? getSharedTrackerProviderRegistry()
    this.connectionStore =
      options.connectionStore ??
      new TrackerConnectionStore({ resolveCapabilities: (provider) => this.registry.get(provider)?.capabilities })
  }

  // Exposed so provider clients (T3/T4/T5) can resolve credentials and read
  // connection metadata; never surfaced over IPC.
  get connections(): TrackerConnectionStore {
    return this.connectionStore
  }

  async listConnections(): Promise<TrackerListConnectionsResult> {
    try {
      return { ok: true, connections: await this.connectionStore.list() }
    } catch (err) {
      return { ok: false, error: toTrackerError(err) }
    }
  }

  async addConnection(input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult> {
    try {
      return { ok: true, connection: await this.connectionStore.add(input) }
    } catch (err) {
      return { ok: false, error: toTrackerError(err, { provider: input.provider }) }
    }
  }

  async removeConnection(input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult> {
    try {
      await this.connectionStore.remove(input.connectionId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: toTrackerError(err, { connectionId: input.connectionId }) }
    }
  }

  async testConnection(input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult> {
    try {
      if ('draft' in input) {
        const probe = await this.connectionStore.withDraftConnection(input.draft, (connectionId) =>
          this.probe(input.draft.provider, connectionId)
        )
        return { ok: true, probe }
      }
      const connection = await this.connectionStore.getConnection(input.connectionId)
      if (!connection) {
        return { ok: false, error: notConfigured('This tracker connection no longer exists.') }
      }
      const probe = await this.probe(connection.provider, input.connectionId)
      this.connectionStore.recordProbe(input.connectionId, probe)
      return { ok: true, probe }
    } catch (err) {
      return { ok: false, error: toTrackerError(err) }
    }
  }

  async search(input: TrackerSearchInput): Promise<TrackerSearchResult> {
    return this.withProvider(input.connectionId, async (provider, connectionId) => {
      const page = await provider.searchIssues({ connectionId, query: input.query, cursor: input.cursor })
      return { ok: true, issues: page.issues, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    })
  }

  async fetchIssue(input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult> {
    return this.withProvider(input.connectionId, async (provider, connectionId) => {
      const issue = await provider.fetchIssue({ connectionId, externalId: input.externalId })
      return { ok: true, issue }
    })
  }

  // Enumerate the named workflow transitions a provider offers FROM a real issue
  // (plan §3.7, MC-1640 tier 2). Capability-gated: a provider without
  // `canTransition` or without a `listTransitions` implementation returns an
  // `unsupported` TrackerError so the T11 UI hides the transition tier by
  // capability, never by a provider name check. Transitions are always read from
  // the tracker — never guessed.
  async listTransitions(input: {
    connectionId: string
    externalId: string
  }): Promise<{ ok: true; transitions: TrackerTransition[] } | { ok: false; error: ReturnType<typeof toTrackerError> }> {
    return this.withProvider(input.connectionId, async (provider, connectionId) => {
      if (!provider.capabilities.canTransition || !provider.listTransitions) {
        throw new TrackerProviderError('unsupported', 'This tracker does not support status changes.', {
          provider: provider.provider,
          connectionId,
        })
      }
      const transitions = await provider.listTransitions({ connectionId, externalId: input.externalId })
      return { ok: true, transitions }
    })
  }

  // Probes via the registered client, or returns an honest ok:false probe when no
  // client is registered for the provider yet (T1 ships the registry empty).
  private async probe(provider: TrackerProviderId, connectionId: string): Promise<TrackerConnectionProbe> {
    const client = this.registry.get(provider)
    if (!client) return { ok: false, reason: 'No client available for this tracker yet.' }
    try {
      return await client.testConnection({ connectionId })
    } catch (err) {
      return { ok: false, reason: toTrackerError(err, { provider, connectionId }).message }
    }
  }

  private async withProvider<T extends { ok: true }>(
    connectionId: string,
    run: (provider: TrackerProvider, connectionId: string) => Promise<T>
  ): Promise<T | { ok: false; error: ReturnType<typeof toTrackerError> }> {
    let provider: TrackerProviderId
    try {
      const connection = await this.connectionStore.getConnection(connectionId)
      if (!connection) return { ok: false, error: notConfigured('This tracker connection no longer exists.', { connectionId }) }
      provider = connection.provider
      const client = this.registry.get(provider)
      if (!client) {
        return {
          ok: false,
          error: notConfigured('No client available for this tracker yet.', { provider, connectionId }),
        }
      }
      return await run(client, connectionId)
    } catch (err) {
      return { ok: false, error: toTrackerError(err, { connectionId }) }
    }
  }
}

function notConfigured(
  message: string,
  context: { provider?: TrackerProviderId; connectionId?: string } = {}
): ReturnType<typeof toTrackerError> {
  return toTrackerError(new TrackerProviderError('not_configured', message, context), context)
}

// Process-wide service singleton the IPC layer defaults to. Its connection store
// wires capability resolution to the shared provider registry so a client
// registered by T3/T4/T5 immediately drives capability-gated UI.
let sharedService: TrackerService | null = null

export function getSharedTrackerService(overrides?: TrackerConnectionStoreOptions): TrackerService {
  if (overrides) return new TrackerService({ connectionStore: new TrackerConnectionStore(overrides) })
  return (sharedService ??= new TrackerService())
}
