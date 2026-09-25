// Taking the app's integrations back out: the other end of the ledger.
//
// Every file, entry and piece of machine state the app wrote outside its own
// data directory is listed (`ledger.ts`, plus a fresh scan for anything the
// ledger missed), grouped for the person to confirm, and removed in reverse
// dependency order: the entries that name the launcher first, the launcher
// last. Each removal reads its target again and takes out only what the marker
// identifies — a block between our markers, a key we own, an entry of the
// shape we write, a file whose content is recognisably ours — so the person's
// own content around it is untouched, and a target already gone is a skip, not
// a failure. Running it twice is the same as running it once.
//
// Used by Settings (after a confirmation that lists everything first), by the
// `--remove-integrations` command line the Windows uninstaller runs, and for
// one WSL distribution when it is removed from Machines.

import { existsSync } from 'node:fs'
import { readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import { isRecord } from '../../shared/records'
import {
  summarizeRemoval,
  type IntegrationRemovalGroup,
  type IntegrationRemovalItem,
  type IntegrationRemovalOptions,
  type IntegrationRemovalOutcome,
  type IntegrationRemovalPlan,
  type IntegrationRemovalReport,
} from '../../shared/integration-removal'
import type { PluginAgentStateSpec } from '../../shared/plugin-manifest'
import { removeAgentStateRegistrationAt, removeHooksDirIfOnlyOurs } from '../agent-state'
import { agentWorktreeLockOwner } from '../agent-worktree-lock'
import { withConfigFileLock, writeFileAtomically } from '../config-file-write'
import type { GitCommandResult } from '../git'
import { runGitCommand } from '../git-utils'
import {
  isManagedStudioGatewayEntry,
  removeCodexManagedServers,
  RETIRED_SPRINTENGINE_MCP_SERVER_ID,
} from '../mcp-config-service'
import { readSkillProvenance } from '../skills/install'
import { removeSettingsKey, STUDIO_PLUGIN_ID, STUDIO_PLUGIN_SOURCE_ID } from '../skills/studio-plugin'
import { KNOWLEDGE_ACTIVITY_HOOK_TAG, scanForIntegrations, type ScanHome, type ScanRoot } from './integration-scan'
import { LAUNCHER_POINTER_NAME, POSIX_LAUNCHER_NAME, WINDOWS_EMPTY_MCP_NAME, WINDOWS_LAUNCHER_NAME } from './launcher'
import { ledgerKey, type IntegrationLedger, type IntegrationLedgerEntry } from './ledger'
import {
  removeLegacySharedExcludeLines,
  removeMarkedBlock,
  WORKTREE_EXCLUDE_FILE,
  WORKTREE_EXCLUDE_START,
} from './worktree-exclude'

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

export type IntegrationRemovalDeps = {
  ledger: IntegrationLedger
  /** Checkouts to scan for anything the ledger missed (the workspace registry's folders). */
  listRoots?: () => ScanRoot[] | Promise<ScanRoot[]>
  /** Homes to scan (this machine's, and each WSL distribution's as this process opens it). */
  listHomes?: () => ScanHome[] | Promise<ScanHome[]>
  runGit?: RunGit
  /** What `tailscale serve status` says is served now (serve port → local port). Absent: tailnet shares are skipped. */
  readServedPorts?: () => Promise<Map<number, number> | null>
  /** `tailscale serve --https=<port> off`. */
  unsharePort?: (servePort: number) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Unregisters a link scheme (`app.removeAsDefaultProtocolClient`). */
  removeProtocolClient?: (scheme: string) => boolean
  /** The paths "Also delete Studio's data" names. */
  appDataPaths?: () => string[]
  /** Deletes the app's data once the app has quit. */
  scheduleAppDataDeletion?: (paths: string[]) => Promise<void>
  env?: NodeJS.ProcessEnv
  /**
   * Whether to scan for writes the ledger never saw before removing. Default
   * true; the uninstaller turns it off, because the first start of a build
   * with a ledger already scanned, and an uninstall has a time limit.
   */
  scan?: boolean
}

// ── Planning ────────────────────────────────────────────────────────────────

const GROUP_BY_KIND: Record<IntegrationLedgerEntry['kind'], IntegrationRemovalGroup> = {
  'agent-state-hooks': 'repositories',
  'status-line': 'repositories',
  'hook-script': 'repositories',
  'mcp-gateway': 'repositories',
  'mcp-approval': 'repositories',
  'studio-plugin-copy': 'repositories',
  'claude-plugin-setting': 'repositories',
  'claude-known-marketplace': 'user-config',
  'skill-copy': 'repositories',
  'knowledge-activity-hook': 'repositories',
  'git-exclude': 'repositories',
  'worktree-lock': 'worktree-locks',
  'tailnet-share': 'tailnet',
  'protocol-handler': 'protocol',
  launcher: 'launcher',
  'wsl-data': 'wsl',
}

// The order removal runs in. Entries that run the launcher go before the
// launcher; a settings key before the file it lives in could be deleted; the
// reporter copies after every registration that could name them.
const KIND_ORDER: readonly IntegrationLedgerEntry['kind'][] = [
  'agent-state-hooks',
  'status-line',
  'knowledge-activity-hook',
  'mcp-gateway',
  'mcp-approval',
  'claude-plugin-setting',
  'claude-known-marketplace',
  'studio-plugin-copy',
  'skill-copy',
  'hook-script',
  'git-exclude',
  'worktree-lock',
  'tailnet-share',
  'protocol-handler',
  'launcher',
  'wsl-data',
]

function describe(entry: IntegrationLedgerEntry): string {
  const cli = entry.cli ? ` (${entry.cli})` : ''
  switch (entry.kind) {
    case 'agent-state-hooks':
      return `Agent-state hooks${cli}`
    case 'status-line':
      return `Status line${cli}`
    case 'hook-script':
      return 'Copied hook script'
    case 'mcp-gateway':
      return `Studio MCP server entry${cli}`
    case 'mcp-approval':
      return 'Studio MCP server approval'
    case 'studio-plugin-copy':
      return 'Studio plugin copy'
    case 'claude-plugin-setting':
      return `Studio plugin setting (${entry.marker.split('.')[0]})`
    case 'claude-known-marketplace':
      return 'Studio marketplace in Claude Code’s plugin list'
    case 'skill-copy':
      return `Studio skill ${basename(entry.path)}`
    case 'knowledge-activity-hook':
      return 'Knowledge activity hook'
    case 'git-exclude':
      return entry.marker === 'owned' ? 'Worktree git excludes' : 'Git exclude lines'
    case 'worktree-lock':
      return 'Worktree lock'
    case 'tailnet-share':
      return `Tailnet share of localhost:${String(entry.detail?.localPort ?? '?')}`
    case 'protocol-handler':
      return `${entry.marker}:// link handler`
    case 'launcher':
      return 'Studio launcher'
    case 'wsl-data':
      return 'Studio’s files in the distribution'
  }
}

function toItem(entry: IntegrationLedgerEntry): IntegrationRemovalItem {
  // Anything inside a distribution is grouped under it, whatever its kind.
  const group = entry.hostId.startsWith('wsl:') ? 'wsl' : GROUP_BY_KIND[entry.kind]
  return {
    id: ledgerKey(entry),
    group,
    label: describe(entry),
    path: entry.path,
    hostId: entry.hostId,
    ...(entry.repo ? { repo: entry.repo } : {}),
  }
}

function inScope(entry: IntegrationLedgerEntry, options: IntegrationRemovalOptions): boolean {
  return options.hostId ? entry.hostId === options.hostId : true
}

/** Record what a fresh scan finds, so the plan covers writes the ledger never saw. */
async function refreshLedger(deps: IntegrationRemovalDeps, options: IntegrationRemovalOptions): Promise<void> {
  const inHost = <T extends { hostId: string }>(items: T[]) =>
    options.hostId ? items.filter((item) => item.hostId === options.hostId) : items
  const found = await scanForIntegrations({
    roots: inHost((await deps.listRoots?.()) ?? []),
    homes: inHost((await deps.listHomes?.()) ?? []),
    ...(deps.runGit ? { runGit: deps.runGit } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }).catch(() => [])
  await deps.ledger.record(found)
}

function sortEntries(entries: IntegrationLedgerEntry[]): IntegrationLedgerEntry[] {
  return [...entries].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

export async function planIntegrationRemoval(
  deps: IntegrationRemovalDeps,
  options: IntegrationRemovalOptions = {},
): Promise<IntegrationRemovalPlan> {
  await refreshLedger(deps, options)
  const entries = sortEntries((await deps.ledger.list()).filter((entry) => inScope(entry, options)))
  return {
    items: entries.map(toItem),
    lockedWorktrees: entries
      .filter((entry) => entry.kind === 'worktree-lock')
      .map((entry) => ({ path: entry.path, repo: entry.repo ?? '' })),
    appDataPaths: options.hostId ? [] : (deps.appDataPaths?.() ?? []),
  }
}

// ── Removing ────────────────────────────────────────────────────────────────

type Result = { status: 'removed' } | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string }

const removed: Result = { status: 'removed' }
const skip = (reason: string): Result => ({ status: 'skipped', reason })
const ALREADY_GONE = 'Already gone.'
const NOT_OURS_BY_PATH = 'That path is not one Studio writes, so it was left alone.'
const TRACKED = 'The repository has it committed, so it was left for the project to remove.'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether git tracks a file, or anything inside a directory. Fails closed: an
 * answer other than "not a repository" or an empty listing counts as tracked,
 * because the cost of the wrong guess is deleting a committed file.
 */
async function isTrackedByGit(path: string, runGit: RunGit): Promise<boolean> {
  const cwd = dirname(path)
  if (!existsSync(cwd)) return false
  const result = await runGit(cwd, ['ls-files', '--', basename(path)]).catch(() => null)
  if (!result) return true
  if (result.ok) return result.stdout.trim() !== ''
  return !/not a git repository/iu.test(`${result.stderr}\n${result.message ?? ''}`)
}

/** Whether the committed (`HEAD`) version of a file contains `text`. False outside git. */
async function committedVersionMentions(path: string, text: string, runGit: RunGit): Promise<boolean> {
  const shown = await runGit(dirname(path), ['show', `HEAD:./${basename(path)}`]).catch(() => null)
  return shown?.ok === true && shown.stdout.includes(text)
}

/**
 * Whether a file this removal leaves empty may be deleted: the app created it,
 * and git does not track it (a committed file, even an empty one, is the
 * project's).
 */
async function mayDeleteEmpty(entry: IntegrationLedgerEntry, runGit: RunGit): Promise<boolean> {
  if (entry.createdFile !== true) return false
  return !(await isTrackedByGit(entry.path, runGit))
}

/**
 * Read a JSON object, let `change` edit it, and write it back — or delete it
 * when nothing is left and that is allowed. Returns whether it changed.
 * An unreadable or unparseable file is someone's work in progress: skipped.
 */
async function editJson(
  path: string,
  change: (value: Record<string, unknown>) => boolean,
  deleteIfEmpty: () => Promise<boolean>,
): Promise<Result> {
  return withConfigFileLock(path, async () => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? skip(ALREADY_GONE) : skip(message(error))
    }
    let parsed: unknown
    try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch {
      return skip('The file is not valid JSON, so it was left as it is.')
    }
    if (!isRecord(parsed)) return skip('The file is not a JSON object, so it was left as it is.')
    if (!change(parsed)) return skip(ALREADY_GONE)
    if (Object.keys(parsed).length === 0 && (await deleteIfEmpty())) {
      await rm(path, { force: true })
      await rmdir(dirname(path)).catch(() => undefined)
    } else {
      await writeFileAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`)
    }
    return removed
  })
}

async function editText(
  path: string,
  change: (text: string) => string | null,
  deleteIfEmpty: () => Promise<boolean>,
): Promise<Result> {
  return withConfigFileLock(path, async () => {
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null) return skip(ALREADY_GONE)
    const next = change(raw)
    if (next === null || next === raw) return skip(ALREADY_GONE)
    if (next.trim() === '' && (await deleteIfEmpty())) {
      await rm(path, { force: true })
      await rmdir(dirname(path)).catch(() => undefined)
    } else {
      await writeFileAtomically(path, next)
    }
    return removed
  })
}

/** Drop `id` from a record, and the record itself once empty. */
function dropKey(
  holder: Record<string, unknown>,
  record: string,
  id: string,
  owns: (value: unknown) => boolean,
): boolean {
  const inner = holder[record]
  if (!isRecord(inner) || !(id in inner) || !owns(inner[id])) return false
  delete inner[id]
  if (Object.keys(inner).length === 0) delete holder[record]
  return true
}

function isOpencodeGateway(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.command)) return false
  const [command, ...args] = value.command as unknown[]
  return isManagedStudioGatewayEntry({ command, args, env: isRecord(value.environment) ? value.environment : {} })
}

function stripKnowledgeActivityHooks(settings: Record<string, unknown>): boolean {
  if (!isRecord(settings.hooks)) return false
  let changed = false
  for (const [event, blocks] of Object.entries(settings.hooks)) {
    if (!Array.isArray(blocks)) continue
    const kept = blocks
      .map((block) => {
        if (!isRecord(block) || !Array.isArray(block.hooks)) return block
        const hooks = block.hooks.filter(
          (hook) => !(isRecord(hook) && hook._sprintengine === KNOWLEDGE_ACTIVITY_HOOK_TAG),
        )
        if (hooks.length !== block.hooks.length) changed = true
        return { ...block, hooks }
      })
      .filter((block) => !isRecord(block) || !Array.isArray(block.hooks) || block.hooks.length > 0)
    if (kept.length === 0) delete settings.hooks[event]
    else settings.hooks[event] = kept
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  return changed
}

// ── What a ledger path may be, before anything is deleted at it ─────────────
//
// The ledger is the app's own file, but a path in it is still checked for the
// shape the kind has before a delete: a garbled or hand-edited entry must
// never point a recursive delete at a home folder.

function slashes(path: string): string {
  return path.split('\\').join('/').replace(/\/+$/u, '')
}

export function isLauncherDirPath(path: string): boolean {
  return slashes(path).endsWith('/.sprintengine/bin')
}

const HOOK_SCRIPT_NAMES = new Set(['agent-state.mjs', 'status-line.mjs', 'knowledge-activity.mjs'])

export function isHookScriptPath(path: string): boolean {
  return /\/\.sprintengine\/hooks\/[^/]+$/u.test(slashes(path)) && HOOK_SCRIPT_NAMES.has(basename(path))
}

export function isStudioPluginCopyPath(path: string): boolean {
  return slashes(path).endsWith('/.sprintengine/studio-plugin')
}

export function isWslDataPath(path: string): boolean {
  return slashes(path).endsWith('/.local/share/sprintengine-studio')
}

const LAUNCHER_FILES = [POSIX_LAUNCHER_NAME, WINDOWS_LAUNCHER_NAME, WINDOWS_EMPTY_MCP_NAME, LAUNCHER_POINTER_NAME]
// What `writeFileAtomically` leaves beside one of those if a write died half-way.
const LAUNCHER_TEMP_FILE = new RegExp(
  `^\\.(?:${LAUNCHER_FILES.map((name) => name.replace(/\./gu, '\\.')).join('|')})\\.\\d+\\.[0-9a-f-]+\\.tmp$`,
  'u',
)

/**
 * Remove the launcher directory: only `~/.sprintengine/bin`, only the files
 * this app writes there, and the directory only once that leaves it empty.
 * A ledger entry naming any other directory is refused outright.
 */
async function removeOwnedLauncherDir(dir: string): Promise<Result> {
  if (!isLauncherDirPath(dir)) return skip('That is not a Studio launcher folder, so it was left alone.')
  const names = await readdir(dir).catch(() => null)
  if (names === null) return skip(ALREADY_GONE)
  for (const name of names) {
    if (LAUNCHER_FILES.includes(name) || LAUNCHER_TEMP_FILE.test(name)) await rm(join(dir, name), { force: true })
  }
  await rmdir(dir).catch(() => undefined)
  // `~/.sprintengine` itself only when this leaves it empty: it also holds the
  // person's own extensions and skills.
  await rmdir(dirname(dir)).catch(() => undefined)
  return existsSync(dir) ? skip('Files that are not Studio’s are in the folder, so it was kept.') : removed
}

async function removeGitExclude(entry: IntegrationLedgerEntry, runGit: RunGit): Promise<Result> {
  if (entry.marker === 'legacy-shared-pair') {
    return (await removeLegacySharedExcludeLines(entry.path)) ? removed : skip(ALREADY_GONE)
  }
  if (entry.marker === WORKTREE_EXCLUDE_START) {
    return editText(
      entry.path,
      (text) => removeMarkedBlock(text),
      async () => false,
    )
  }
  // A worktree's own excludes file, and the config line naming it.
  if (basename(entry.path) !== WORKTREE_EXCLUDE_FILE) return skip(NOT_OURS_BY_PATH)
  const worktree = typeof entry.detail?.worktree === 'string' ? entry.detail.worktree : null
  if (worktree && existsSync(worktree)) {
    const current = await runGit(worktree, ['config', '--worktree', '--get', 'core.excludesFile'])
    if (current.ok && current.stdout.trim() === entry.path.split('\\').join('/')) {
      await runGit(worktree, ['config', '--worktree', '--unset', 'core.excludesFile'])
    }
    if (entry.detail?.enabledWorktreeConfig === true) await turnOffWorktreeConfigIfUnused(worktree, runGit)
  }
  if (!existsSync(entry.path)) return skip(ALREADY_GONE)
  await rm(entry.path, { force: true })
  return removed
}

/** Undo `extensions.worktreeConfig` when this app turned it on and no worktree uses it any more. */
async function turnOffWorktreeConfigIfUnused(worktree: string, runGit: RunGit): Promise<void> {
  const common = await runGit(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return
  const commonDir = common.stdout.trim()
  const candidates = [join(commonDir, 'config.worktree')]
  for (const name of (await readdir(join(commonDir, 'worktrees')).catch(() => [])) as string[]) {
    candidates.push(join(commonDir, 'worktrees', name, 'config.worktree'))
  }
  for (const path of candidates) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (/^\s*[^#;\s[]/mu.test(text)) return
  }
  await runGit(worktree, ['config', '--unset', 'extensions.worktreeConfig'])
}

async function removeWorktreeLock(
  entry: IntegrationLedgerEntry,
  runGit: RunGit,
  options: IntegrationRemovalOptions,
): Promise<Result> {
  const repo = entry.repo
  if (!repo || !existsSync(repo)) return skip('The repository is gone.')
  const listing = await runGit(repo, ['worktree', 'list', '--porcelain', '-z'])
  if (!listing.ok) return { status: 'failed', reason: listing.message ?? 'git could not list the worktrees.' }
  const records = listing.stdout.split('\0\0')
  const target = entry.path.split('\\').join('/')
  const record = records.find((chunk) =>
    chunk.split('\0').some((line) => line === `worktree ${target}` || line === `worktree ${entry.path}`),
  )
  if (!record) return skip('The worktree is gone.')
  const lockLine = record.split('\0').find((line) => line.startsWith('locked'))
  if (!lockLine) return skip('Already unlocked.')
  const reason = lockLine === 'locked' ? '' : lockLine.slice('locked '.length)
  // Only a lock this profile placed; a person's own, or another profile's, stays.
  if (agentWorktreeLockOwner(reason) !== 'this-profile') return skip('The lock is not this profile’s.')
  const unlocked = await runGit(repo, ['worktree', 'unlock', entry.path])
  if (!unlocked.ok) return { status: 'failed', reason: unlocked.message ?? 'git could not unlock the worktree.' }
  if (options.removeWorktrees) {
    // Never forced: git refuses a worktree with uncommitted or untracked
    // changes, and it is kept, unlocked, with git's own reason.
    const removedTree = await runGit(repo, ['worktree', 'remove', entry.path])
    if (!removedTree.ok) {
      const why = (removedTree.stderr || removedTree.message || '').trim().split('\n')[0]
      return skip(`Unlocked, and kept: ${why || 'git would not remove it.'}`)
    }
  }
  return removed
}

async function removeTailnetShare(entry: IntegrationLedgerEntry, deps: IntegrationRemovalDeps): Promise<Result> {
  const servePort = Number(entry.detail?.servePort)
  const localPort = Number(entry.detail?.localPort)
  if (!deps.readServedPorts || !deps.unsharePort) {
    return { status: 'failed', reason: 'Tailscale could not be asked from here.' }
  }
  const served = await deps.readServedPorts()
  // "Could not ask" is not "nothing is served": the share stays listed, so the
  // next run can take it down.
  if (served === null) return { status: 'failed', reason: 'Tailscale did not answer, so the share was left as it is.' }
  // Only the mapping this app published, still pointing where it pointed: a
  // port someone has since re-pointed is theirs now.
  if (!served.has(servePort)) return skip(ALREADY_GONE)
  if (served.get(servePort) !== localPort) return skip('The port now serves something else, so it was left alone.')
  const result = await deps.unsharePort(servePort)
  return result.ok ? removed : { status: 'failed', reason: result.message }
}

async function removeKnownMarketplace(entry: IntegrationLedgerEntry): Promise<Result> {
  // Claude Code's own file: only the entry for our marketplace, and only
  // while it still points at a workspace copy of our plugin.
  return editJson(
    entry.path,
    (value) =>
      dropKey({ root: value }, 'root', entry.marker, (known) => {
        if (!isRecord(known) || !isRecord(known.source)) return false
        const path = typeof known.source.path === 'string' ? known.source.path.split('\\').join('/') : ''
        return path.includes('/.sprintengine/studio-plugin')
      }) || false,
    async () => false,
  )
}

async function removeEntry(
  entry: IntegrationLedgerEntry,
  deps: IntegrationRemovalDeps,
  options: IntegrationRemovalOptions,
): Promise<Result> {
  const runGit = deps.runGit ?? runGitCommand
  const deleteIfEmpty = () => mayDeleteEmpty(entry, runGit)
  switch (entry.kind) {
    case 'agent-state-hooks':
    case 'status-line': {
      const kind = (
        entry.kind === 'status-line' ? 'settings-json' : entry.marker
      ) as PluginAgentStateSpec['registration']['kind']
      const outcome = await removeAgentStateRegistrationAt(entry.path, kind, { deleteIfEmpty: await deleteIfEmpty() })
      if (outcome === 'removed') return removed
      return skip(
        outcome === 'absent' ? ALREADY_GONE : 'The file could not be read or is not ours, so it was left as it is.',
      )
    }
    case 'knowledge-activity-hook': {
      const result = await editJson(entry.path, stripKnowledgeActivityHooks, deleteIfEmpty)
      const record = typeof entry.detail?.record === 'string' ? entry.detail.record : null
      if (record) {
        await rm(record, { force: true }).catch(() => undefined)
        await removeHooksDirIfOnlyOurs(dirname(record)).catch(() => undefined)
      }
      return result
    }
    case 'hook-script': {
      if (!isHookScriptPath(entry.path)) return skip(NOT_OURS_BY_PATH)
      if (!existsSync(entry.path)) return skip(ALREADY_GONE)
      if (await isTrackedByGit(entry.path, runGit)) return skip(TRACKED)
      await rm(entry.path, { force: true })
      await removeHooksDirIfOnlyOurs(dirname(entry.path)).catch(() => undefined)
      return removed
    }
    case 'mcp-gateway': {
      if (entry.path.endsWith('.toml')) {
        return editText(
          entry.path,
          (text) => {
            const next = removeCodexManagedServers(text, [STUDIO_MCP_SERVER_ID])
            return next === text ? null : next
          },
          deleteIfEmpty,
        )
      }
      if (basename(entry.path) === 'opencode.json') {
        return editJson(
          entry.path,
          (value) => dropKey(value, 'mcp', STUDIO_MCP_SERVER_ID, isOpencodeGateway),
          deleteIfEmpty,
        )
      }
      return editJson(
        entry.path,
        (value) => {
          const gateway = dropKey(value, 'mcpServers', STUDIO_MCP_SERVER_ID, isManagedStudioGatewayEntry)
          const retired = dropKey(value, 'mcpServers', RETIRED_SPRINTENGINE_MCP_SERVER_ID, () => true)
          return gateway || retired
        },
        deleteIfEmpty,
      )
    }
    case 'mcp-approval':
      return editJson(
        entry.path,
        (value) => {
          if (!Array.isArray(value.enabledMcpjsonServers)) return false
          const kept = value.enabledMcpjsonServers.filter((id) => id !== STUDIO_MCP_SERVER_ID)
          if (kept.length === value.enabledMcpjsonServers.length) return false
          if (kept.length > 0) value.enabledMcpjsonServers = kept
          else delete value.enabledMcpjsonServers
          return true
        },
        deleteIfEmpty,
      )
    case 'claude-plugin-setting': {
      const [record, ...rest] = entry.marker.split('.')
      const key = rest.join('.')
      // A key the project committed is the project's now, whoever first wrote it.
      if (await committedVersionMentions(entry.path, key, runGit)) {
        return skip('The repository has this setting committed, so it was left for the project to change.')
      }
      const changed = await removeSettingsKey(entry.path, record, key)
      if (!changed) return skip(ALREADY_GONE)
      // The settings helper leaves an emptied file behind; only one the app made goes.
      const text = await readFile(entry.path, 'utf8').catch(() => null)
      if (text !== null && text.trim() === '{}' && (await deleteIfEmpty())) {
        await rm(entry.path, { force: true })
        await rmdir(dirname(entry.path)).catch(() => undefined)
      }
      return removed
    }
    case 'claude-known-marketplace':
      return removeKnownMarketplace(entry)
    case 'studio-plugin-copy': {
      if (!isStudioPluginCopyPath(entry.path)) return skip(NOT_OURS_BY_PATH)
      if (!existsSync(join(entry.path, STUDIO_PLUGIN_ID, '.claude-plugin', 'plugin.json'))) return skip(ALREADY_GONE)
      if (await isTrackedByGit(entry.path, runGit)) return skip(TRACKED)
      await rm(entry.path, { recursive: true, force: true })
      await rmdir(dirname(entry.path)).catch(() => undefined)
      return removed
    }
    case 'skill-copy': {
      if ((await readSkillProvenance(entry.path))?.sourceId !== STUDIO_PLUGIN_SOURCE_ID) {
        return skip(existsSync(entry.path) ? 'It is no longer Studio’s copy.' : ALREADY_GONE)
      }
      if (await isTrackedByGit(entry.path, runGit)) return skip(TRACKED)
      await rm(entry.path, { recursive: true, force: true })
      return removed
    }
    case 'git-exclude':
      return removeGitExclude(entry, runGit)
    case 'worktree-lock':
      return removeWorktreeLock(entry, runGit, options)
    case 'tailnet-share':
      return removeTailnetShare(entry, deps)
    case 'protocol-handler': {
      if (!deps.removeProtocolClient) return skip('Only the app itself can unregister the link handler.')
      return deps.removeProtocolClient(entry.marker) ? removed : skip(ALREADY_GONE)
    }
    case 'launcher':
      return removeOwnedLauncherDir(entry.path)
    case 'wsl-data': {
      if (!isWslDataPath(entry.path)) return skip(NOT_OURS_BY_PATH)
      if (!existsSync(entry.path)) return skip(ALREADY_GONE)
      await rm(entry.path, { recursive: true, force: true })
      return removed
    }
  }
}

/**
 * Remove every listed integration in scope, in order, and report each one.
 * An entry that is gone, or was removed, leaves the ledger; one that failed
 * stays, so the next run tries it again.
 */
export async function removeIntegrations(
  deps: IntegrationRemovalDeps,
  options: IntegrationRemovalOptions = {},
): Promise<IntegrationRemovalReport> {
  if (deps.scan !== false) await refreshLedger(deps, options)
  const entries = sortEntries((await deps.ledger.list()).filter((entry) => inScope(entry, options)))
  // The launcher goes last only once nothing still names it: when something
  // failed, the entries left behind still run it.
  const outcomes: IntegrationRemovalOutcome[] = []
  const done: string[] = []
  for (const entry of entries) {
    const item = toItem(entry)
    let result: Result
    if (
      entry.kind === 'launcher' &&
      outcomes.some((outcome) => outcome.status === 'failed' && outcome.group !== 'tailnet')
    ) {
      result = skip('Kept, because an entry above that runs it could not be removed.')
    } else {
      try {
        result = await removeEntry(entry, deps, options)
      } catch (error) {
        result = { status: 'failed', reason: message(error) }
      }
    }
    outcomes.push({
      id: item.id,
      group: item.group,
      label: item.label,
      path: item.path,
      status: result.status,
      ...(result.status === 'removed' ? {} : { reason: result.reason }),
    })
    if (
      result.status !== 'failed' &&
      !(entry.kind === 'launcher' && result.status === 'skipped' && existsSync(entry.path))
    ) {
      done.push(ledgerKey(entry))
    }
  }
  await deps.ledger.forget(done)

  // Only once nothing failed: the data holds the ledger, and deleting it would
  // take away the list the next run retries from.
  let appDataScheduled = false
  const anyFailed = outcomes.some((outcome) => outcome.status === 'failed')
  if (options.deleteAppData && !options.hostId && !anyFailed && deps.scheduleAppDataDeletion) {
    const paths = deps.appDataPaths?.() ?? []
    if (paths.length > 0) {
      await deps.scheduleAppDataDeletion(paths)
      appDataScheduled = true
    }
  }
  return summarizeRemoval(outcomes, appDataScheduled)
}
