import {
  conversationCommandsFolderKey,
  type ConversationCommand,
  type ConversationCommandCatalog,
} from '../../shared/conversation/commands'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import type { ConversationCommandsDiskCache } from './disk-cache'
import { conversationCommandsFor, onConversationCommandsChanged, publishConversationCommands } from './registry'

/**
 * How old a list may be before the next ask for it starts a fresh probe in
 * the background. The list is served as it is meanwhile; the new one arrives
 * as a push. A list changes when the person adds a command file or a plugin,
 * which is rare enough that asking more often would be probe churn.
 */
const CONVERSATION_COMMANDS_TTL_MS = 5 * 60_000
/**
 * How long an ask for a list nothing is known about waits for the probe
 * before answering with what there is. Claude Code answers in well under a
 * second; a slower CLI's list still arrives as a push when its probe ends.
 */
const CONVERSATION_COMMANDS_COLD_WAIT_MS = 5_000
/**
 * How many CLIs may be listing at once. Each probe is a CLI process starting
 * up; a window restoring many chats, or a person opening the menu in one after
 * another, queues behind these rather than starting them all together.
 */
const CONVERSATION_COMMANDS_MAX_PROBES = 2
/**
 * How long after a probe failed the next ask for the same list waits before
 * trying again, unless a refresh is asked for. A CLI that cannot list (not
 * signed in, broken install) fails the same way on every try, and each try is
 * a CLI process; without this every open of the `/` menu started one.
 */
const CONVERSATION_COMMANDS_RETRY_MS = 60_000

type Probe = (input: {
  cli: string
  cwd: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}) => Promise<ConversationCommand[] | null>

export type ConversationCommandsServiceDeps = {
  /** Lists (and publishes) a CLI's commands for a folder; `probe.ts` by default. */
  probe?: Probe
  /** The person's per-CLI command and WSL overrides, so a probe runs the `claude` a chat runs. */
  cliRuntimes?: () => ConversationCliRuntimeOverrides | undefined
  cache?: ConversationCommandsDiskCache | null
  now?: () => number
  ttlMs?: number
  coldWaitMs?: number
  maxProbes?: number
  retryMs?: number
}

export type ConversationCommandsService = {
  /** `probe: false` answers from what is held and never asks the CLI. */
  list: (input: { cli: string; cwd: string; refresh?: boolean; probe?: false }) => Promise<ConversationCommandCatalog>
  /** Stop recording into the disk cache and write what is pending. */
  dispose: () => Promise<void>
}

/**
 * The composer's command lists, answered from the registry: what a probe, a
 * live session or an ACP update last published for the (CLI, folder). The
 * disk cache fills the registry at start, and every good list published after
 * is written back to it.
 */
export function createConversationCommandsService(
  deps: ConversationCommandsServiceDeps = {},
): ConversationCommandsService {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? CONVERSATION_COMMANDS_TTL_MS
  const coldWaitMs = deps.coldWaitMs ?? CONVERSATION_COMMANDS_COLD_WAIT_MS
  const retryMs = deps.retryMs ?? CONVERSATION_COMMANDS_RETRY_MS
  // When each list's last probe ended in failure, until one succeeds.
  const failedAt = new Map<string, number>()
  const cache = deps.cache ?? null
  const probe: Probe =
    deps.probe ??
    (async (input) => {
      const { probeConversationCommands } = await import('./probe')
      return probeConversationCommands(input)
    })
  const inFlight = new Map<string, Promise<void>>()
  const maxProbes = deps.maxProbes ?? CONVERSATION_COMMANDS_MAX_PROBES
  let probing = 0
  const waiting: Array<() => void> = []
  // A finished probe hands its slot straight to the next in line, so a probe
  // asked for in the meantime cannot take it first and run one over the cap.
  async function withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
    if (probing >= maxProbes) await new Promise<void>((resolve) => waiting.push(resolve))
    else probing += 1
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else probing -= 1
    }
  }
  const keyOf = (cli: string, cwd: string) => `${cli}\u0000${conversationCommandsFolderKey(cwd)}`

  // A list from an earlier run goes into the registry with the time it was
  // answered, so it is served at once and still counts as due a refresh.
  const hydrated: Promise<void> = cache
    ? cache.load().then(
        (catalogs) => {
          for (const catalog of catalogs) {
            if (conversationCommandsFor(catalog.cli, catalog.cwd).fetchedAt > 0) continue
            publishConversationCommands({ ...catalog })
          }
        },
        () => undefined,
      )
    : Promise.resolve()
  const stopRecording = cache ? onConversationCommandsChanged((catalog) => cache.record(catalog)) : () => undefined

  function refresh(cli: string, cwd: string): Promise<void> {
    const key = keyOf(cli, cwd)
    const running = inFlight.get(key)
    if (running) return running
    const run = withProbeSlot(() => probe({ cli, cwd, cliRuntimes: readCliRuntimes() }))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(key)
        if (conversationCommandsFor(cli, cwd).error) failedAt.set(key, now())
        else failedAt.delete(key)
      })
    inFlight.set(key, run)
    return run
  }

  function readCliRuntimes(): ConversationCliRuntimeOverrides | undefined {
    try {
      return deps.cliRuntimes?.()
    } catch {
      return undefined
    }
  }

  return {
    async list({ cli, cwd, refresh: forced, probe: mayProbe }) {
      await hydrated
      const known = conversationCommandsFor(cli, cwd)
      if (mayProbe === false) return known
      const failed = failedAt.get(keyOf(cli, cwd))
      const resting = Boolean(known.error) && failed !== undefined && now() - failed < retryMs
      const due =
        forced || (!resting && (known.fetchedAt === 0 || Boolean(known.error) || now() - known.fetchedAt >= ttlMs))
      if (due) {
        const run = refresh(cli, cwd)
        // Nothing to show yet: give the probe a moment to answer first.
        if (known.fetchedAt === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, coldWaitMs)))])
          if (timer) clearTimeout(timer)
        }
      }
      return conversationCommandsFor(cli, cwd)
    },
    async dispose() {
      stopRecording()
      await cache?.flush()
    },
  }
}
