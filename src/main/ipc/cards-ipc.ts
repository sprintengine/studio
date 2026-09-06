// `cards:run` — the one channel behind `Go` on the Extensions home (item 2469).
//
// It is shaped like the skills and MCP install channels beside it: one handler,
// one envelope in, one report out, and the service objects bound here rather
// than reached for inside the executor. `src/main/cards/run-card.ts` takes its
// installers as dependencies precisely so that this file is the only place that
// knows which real service each one is, and so the executor's own test can
// watch the order without a workspace, a network or a machine with a CLI on it.
//
// **The envelope is re-parsed, not trusted.** The actions were validated once
// already, by `parseHostedCardFeed` in the main process, but they have been to
// the renderer and back since — so every action is put through the shared
// parser again here, and a card that fails is refused whole rather than run in
// part. That is the same rule the feed parser applies to a card with one bad
// action, for the same reason: half of Go is worse than none of it.
//
// The two fields the request carries that a card does not — the workspace and
// the parent directory clones go into — are the app's own facts and are checked
// for shape here only. They never came from the feed.

import type { IpcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CardRunInput, CardRunResult, McpServerConfig } from '../../shared/electron-api'
import { parseCardAction, type CardAction } from '../../shared/hosted-card-feed'
import { detectCli } from '../cli-runtime-install'
import { cloneGitHubRepo } from '../git-clone'
import type { GitHubTokenStore } from '../github-token-store'
import type { McpConfigService } from '../mcp-config-service'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import type { SkillsService } from '../skills'
import { installedSkillCopies } from '../skills/sync'
import { runCard, type CardRunDeps } from '../cards/run-card'

export type CardsIpcServices = {
  skillsService: SkillsService
  mcpConfigService: McpConfigService
  githubTokenStore: GitHubTokenStore
}

export function registerCardsIpc(
  ipcMain: IpcMain,
  services: CardsIpcServices,
  overrides: Partial<CardRunDeps> = {},
): void {
  const deps: CardRunDeps = {
    listMcpCatalog: () => services.mcpConfigService.listCatalog(),
    syncMcp: (input) => services.mcpConfigService.sync(input),
    getSkillScan: (input) => services.skillsService.getScan(input),
    installSkill: (input) => services.skillsService.install(input),
    installPlugin: (input) => services.skillsService.installPlugin(input),
    listInstalledPlugins: (input) => services.skillsService.listInstalledPlugins(input),
    installedSkillCopies: (workspaceRoot) => installedSkillCopies(workspaceRoot),
    // Only the agent CLIs this build registers as plugins, which is the same
    // list the availability slice probes. A `require.cli` naming anything else
    // never reaches a probe, let alone a spawn.
    listAgentCliIds: () => listPluginRegistryEntries().map((entry) => entry.id),
    detectCli: async (cli) => {
      const detected = await detectCli(cli)
      // A probe that errored decided nothing, and "decided nothing" is not
      // "installed" — `cli-availability.ts` drops such a CLI from its map for
      // the same reason. Here it means Go says the CLI is missing, which is the
      // reading that installs nothing on a guess.
      return { installed: detected.error === null && detected.installed }
    },
    // The token never crosses IPC: it is resolved on this side, exactly as
    // `github-repos-ipc.ts` does for the clone picker.
    cloneRepo: async (input) =>
      cloneGitHubRepo({ ...input, token: await services.githubTokenStore.resolveToken() }),
    pathExists: (path) => existsSync(path),
    joinPath: (...segments) => join(...segments),
    ...overrides,
  }

  ipcMain.handle('cards:run', async (_event, raw: unknown): Promise<CardRunResult> => {
    const request = parseRequest(raw)
    if (!request.ok) {
      return {
        ok: false,
        outcomes: [],
        workspaceRoot: null,
        mcpServers: [],
        chat: null,
        surface: null,
        message: request.message,
      }
    }
    try {
      return await runCard(request.input, deps)
    } catch (error) {
      return {
        ok: false,
        outcomes: [],
        workspaceRoot: request.input.workspaceRoot,
        mcpServers: [],
        chat: null,
        surface: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

type ParsedRequest = { ok: true; input: CardRunInput } | { ok: false; message: string }

function parseRequest(raw: unknown): ParsedRequest {
  if (!isObject(raw)) return { ok: false, message: 'That card could not be read, so nothing ran.' }
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : ''
  if (!slug) return { ok: false, message: 'That card could not be read, so nothing ran.' }
  if (!Array.isArray(raw.actions)) return { ok: false, message: 'That card has nothing to run.' }

  const actions: CardAction[] = []
  for (const entry of raw.actions) {
    const parsed = parseCardAction(entry)
    // One unreadable action refuses the whole card. A partially run card is the
    // state nobody can see and nobody can undo.
    if (!parsed.ok) return { ok: false, message: `That card asks for something this build cannot do: ${parsed.message}` }
    actions.push(parsed.action)
  }

  return {
    ok: true,
    input: {
      slug,
      actions,
      workspaceRoot: absolutePathOrNull(raw.workspaceRoot),
      cloneParentDir: absolutePathOrNull(raw.cloneParentDir),
      mcpServers: Array.isArray(raw.mcpServers) ? (raw.mcpServers as McpServerConfig[]) : [],
    },
  }
}

/**
 * The app's own two paths, checked for shape rather than for provenance: both
 * are chosen by the shell (the open workspace, the projects directory) and
 * neither has ever been in the feed. A relative one is treated as absent, so a
 * malformed shell state cannot turn into a join against the process cwd.
 */
function absolutePathOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (path.length === 0) return null
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
