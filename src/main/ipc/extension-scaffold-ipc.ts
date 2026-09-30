// "Build your own extension" (the Extensions home's build flow): list the
// SDK's templates, check this machine can build one, and scaffold the project.
//
// The project is written by the SDK's own scaffolder — the one
// `sprintengine-module init` runs — from the templates and the
// extension-builder skill the app ships beside itself (`sdk-templates`,
// `sdk-skills` in package.json `build.extraResources`), so a project made here
// and one made on the command line are the same project. The SDK version it
// depends on is this checkout's, fixed at build time.
//
// The folder a project is written into is one the person picked in a dialog
// this process showed: the pick answers with a token, and `create` writes only
// under a folder whose token it issued. A renderer that names a path of its
// own gets `folder_not_picked`, and nothing is written.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { app, BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'

import {
  listModuleTemplates,
  scaffoldModuleProject,
  type ScaffoldModuleOptions,
  type ScaffoldModuleResult,
} from '../../../packages/module-sdk/src/scaffold'
import sdkPackage from '../../../packages/module-sdk/package.json'
import { conversationProviderForCli } from '../../shared/conversation-harness'
import {
  EXTENSION_MIN_NODE_VERSION,
  extensionIdProblem,
  type ExtensionScaffoldCheck,
  type ExtensionScaffoldCheckInput,
  type ExtensionScaffoldCreateInput,
  type ExtensionScaffoldCreateResult,
  type ExtensionScaffoldFolderPick,
  type ExtensionTemplateSummary,
} from '../../shared/extension-scaffold'
import { detectAgentCliAvailability } from '../cli-availability'
import { probeBinaryVersion, type BinaryVersionProbe } from '../cli-runtime-install'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import { assertAppSender } from './ipc-sender'
import { resolveTestOpenDirOverride } from './menu-dialog-ipc'

export const EXTENSION_SCAFFOLD_TEMPLATES_CHANNEL = 'extensions:scaffold:templates'
export const EXTENSION_SCAFFOLD_PICK_FOLDER_CHANNEL = 'extensions:scaffold:pick-folder'
export const EXTENSION_SCAFFOLD_CHECK_CHANNEL = 'extensions:scaffold:check'
export const EXTENSION_SCAFFOLD_CREATE_CHANNEL = 'extensions:scaffold:create'

/** The SDK version a scaffolded project depends on: this build's own. */
export const SCAFFOLD_SDK_VERSION: string = sdkPackage.version

// A pick stays usable for as long as a person plausibly spends filling in the
// rest of the form, and through a retry after a refusal (a folder name already
// taken). It is spent by the create that succeeds.
const FOLDER_TOKEN_TTL_MS = 30 * 60_000

// An IDEA.md longer than this is not a brief, and a name longer than this is
// not a name.
const MAX_IDEA_CHARS = 20_000
const MAX_NAME_CHARS = 80

/** Where the templates and the skill are: beside the app when packaged, the SDK package in a checkout. */
export function resolveScaffoldRoots(
  env: { isPackaged: boolean; resourcesPath: string; appPath: string } = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  },
): { templatesRoot: string; skillsRoot: string } {
  if (env.isPackaged) {
    return {
      templatesRoot: join(env.resourcesPath, 'sdk-templates'),
      skillsRoot: join(env.resourcesPath, 'sdk-skills'),
    }
  }
  const sdk = join(env.appPath, 'packages', 'module-sdk')
  return { templatesRoot: join(sdk, 'templates'), skillsRoot: join(sdk, 'skills') }
}

export type ExtensionScaffoldDeps = {
  roots: () => { templatesRoot: string; skillsRoot: string }
  sdkVersion: string
  /** Show the folder dialog for this sender; null when the person cancelled. */
  showFolderDialog: (event: IpcMainInvokeEvent) => Promise<string | null>
  probe: (binary: 'node' | 'npm' | 'git') => Promise<BinaryVersionProbe>
  /** The agent CLI's display name and whether it is installed (null: the probe could not say). */
  agent: (cli: string) => Promise<{ label: string; installed: boolean | null } | null>
  scaffold: (options: ScaffoldModuleOptions) => Promise<ScaffoldModuleResult>
  isDirectory: (path: string) => boolean
  now: () => number
}

function defaultDeps(): ExtensionScaffoldDeps {
  return {
    roots: () => resolveScaffoldRoots(),
    sdkVersion: SCAFFOLD_SDK_VERSION,
    showFolderDialog: async (event) => {
      const testOverride = await resolveTestOpenDirOverride({ isPackaged: app.isPackaged })
      if (testOverride) return testOverride
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: 'Where should the extension project go?',
        buttonLabel: 'Choose',
        properties: process.platform === 'darwin' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    probe: (binary) => probeBinaryVersion(binary, { userPathOnly: true }),
    agent: async (cli) => {
      const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
      if (!entry) return null
      const availability = await detectAgentCliAvailability(undefined, { listEntries: () => [entry] })
      return { label: entry.displayName, installed: availability[cli]?.installed ?? null }
    },
    scaffold: scaffoldModuleProject,
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    now: Date.now,
  }
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function nodeCheck(probe: BinaryVersionProbe): ExtensionScaffoldCheck {
  const [major, minor] = EXTENSION_MIN_NODE_VERSION
  const wanted = `${major}.${minor}`
  const base = { id: 'node' as const, label: 'Node.js', required: true }
  if (probe.outcome === 'not_installed') {
    return {
      ...base,
      status: 'missing',
      detail: `Not found on your PATH. Install Node.js ${wanted} or later (nodejs.org has installers), then check again.`,
    }
  }
  if (probe.outcome === 'probe_failed') {
    return { ...base, status: 'unknown', detail: 'Could not tell which Node.js is installed. The agent will find out.' }
  }
  const found = parseVersion(probe.version)
  if (found && (found[0] < major || (found[0] === major && found[1] < minor))) {
    return {
      ...base,
      status: 'outdated',
      detail: `Found ${found.join('.')}; the project's scripts need ${wanted} or later. Update Node.js, then check again.`,
    }
  }
  return { ...base, status: 'ok', detail: found ? found.join('.') : probe.version }
}

function npmCheck(probe: BinaryVersionProbe): ExtensionScaffoldCheck {
  const base = { id: 'npm' as const, label: 'npm', required: true }
  if (probe.outcome === 'not_installed') {
    return {
      ...base,
      status: 'missing',
      detail: 'Not found on your PATH. It comes with Node.js; reinstall Node.js, then check again.',
    }
  }
  if (probe.outcome === 'probe_failed') {
    return { ...base, status: 'unknown', detail: 'Could not tell whether npm is installed. The agent will find out.' }
  }
  return { ...base, status: 'ok', detail: parseVersion(probe.version)?.join('.') ?? probe.version }
}

function gitCheck(probe: BinaryVersionProbe): ExtensionScaffoldCheck {
  const base = { id: 'git' as const, label: 'git', required: false }
  if (probe.outcome === 'not_installed') {
    return {
      ...base,
      status: 'missing',
      detail: 'Not installed. You can build and try the extension without it; publishing it on GitHub needs git.',
    }
  }
  if (probe.outcome === 'probe_failed') {
    return { ...base, status: 'unknown', detail: 'Could not tell whether git is installed.' }
  }
  return { ...base, status: 'ok', detail: parseVersion(probe.version)?.join('.') ?? probe.version }
}

async function agentCheck(cli: string, deps: ExtensionScaffoldDeps): Promise<ExtensionScaffoldCheck> {
  const base = { id: 'agent' as const, required: true }
  const agent = await deps.agent(cli).catch(() => null)
  const label = agent?.label ?? cli
  if (!conversationProviderForCli(cli)) {
    return {
      ...base,
      label,
      status: 'missing',
      detail: `${label} cannot run as a chat agent here. Pick an agent that can — the list offers only those.`,
    }
  }
  if (!agent) {
    return { ...base, label, status: 'missing', detail: `${cli} is not an agent this app knows. Pick another one.` }
  }
  if (agent.installed === false) {
    return {
      ...base,
      label,
      status: 'missing',
      detail: `${label} is not installed on this machine. Install it from Settings › Agents, or pick another agent.`,
    }
  }
  if (agent.installed === null) {
    return { ...base, label, status: 'unknown', detail: `Could not tell whether ${label} is installed.` }
  }
  return { ...base, label, status: 'ok', detail: 'Installed, and runs as a chat.' }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function createExtensionScaffoldHandlers(overrides: Partial<ExtensionScaffoldDeps> = {}) {
  const deps: ExtensionScaffoldDeps = { ...defaultDeps(), ...overrides }
  const pickedFolders = new Map<string, { path: string; expiresAt: number }>()

  function prune(): void {
    const now = deps.now()
    for (const [token, pick] of pickedFolders) if (pick.expiresAt <= now) pickedFolders.delete(token)
  }

  return {
    templates(): ExtensionTemplateSummary[] {
      return listModuleTemplates(deps.roots().templatesRoot)
    },

    async pickFolder(event: IpcMainInvokeEvent): Promise<ExtensionScaffoldFolderPick | null> {
      const picked = await deps.showFolderDialog(event)
      if (!picked) return null
      prune()
      const path = resolve(picked)
      const token = randomUUID()
      pickedFolders.set(token, { path, expiresAt: deps.now() + FOLDER_TOKEN_TTL_MS })
      return { path, token }
    },

    async check(input: ExtensionScaffoldCheckInput | undefined): Promise<ExtensionScaffoldCheck[]> {
      const [node, npm, git] = await Promise.all(
        (['node', 'npm', 'git'] as const).map((binary) =>
          deps.probe(binary).catch((): BinaryVersionProbe => ({ outcome: 'probe_failed' })),
        ),
      )
      const checks = [nodeCheck(node), npmCheck(npm), gitCheck(git)]
      const cli = isString(input?.cli) ? input.cli.trim() : ''
      if (cli) checks.push(await agentCheck(cli, deps))
      return checks
    },

    async create(input: ExtensionScaffoldCreateInput | undefined): Promise<ExtensionScaffoldCreateResult> {
      const invalid = (message: string): ExtensionScaffoldCreateResult => ({
        ok: false,
        code: 'invalid_input',
        message,
      })
      if (!input || typeof input !== 'object') return invalid('Nothing to create.')
      const { templateId, id, displayName, parentDir, parentDirToken, ideaMarkdown } = input
      if (!isString(templateId) || templateId === '') return invalid('Choose a template.')
      if (!isString(id)) return invalid('Give the extension an id.')
      const idProblem = extensionIdProblem(id)
      if (idProblem) return { ok: false, code: 'invalid_id', message: idProblem }
      if (!isString(displayName) || displayName.trim() === '' || displayName.length > MAX_NAME_CHARS) {
        return invalid(`Give the extension a name of up to ${MAX_NAME_CHARS} characters.`)
      }
      if (ideaMarkdown !== undefined && (!isString(ideaMarkdown) || ideaMarkdown.length > MAX_IDEA_CHARS)) {
        return invalid(`The idea is longer than ${MAX_IDEA_CHARS} characters.`)
      }

      prune()
      const pick = isString(parentDirToken) ? pickedFolders.get(parentDirToken) : undefined
      if (!pick || !isString(parentDir) || resolve(parentDir) !== pick.path) {
        return {
          ok: false,
          code: 'folder_not_picked',
          message: 'Choose the folder for the project again; the one this names was not picked here.',
        }
      }
      if (!deps.isDirectory(pick.path)) {
        return { ok: false, code: 'io_error', message: `${pick.path} is no longer a folder. Choose another.` }
      }

      const { templatesRoot, skillsRoot } = deps.roots()
      const folder = join(pick.path, id)
      const result = await deps.scaffold({
        dir: folder,
        templateId,
        id,
        displayName: displayName.trim(),
        sdkVersion: deps.sdkVersion,
        templatesRoot,
        skillsRoot,
        ...(ideaMarkdown !== undefined && ideaMarkdown.trim() !== '' ? { ideaMarkdown } : {}),
      })
      if (!result.ok) return result
      pickedFolders.delete(parentDirToken)
      return { ok: true, folder, files: result.files }
    },
  }
}

export function registerExtensionScaffoldIpc(
  ipcMain: IpcMain,
  handlers: ReturnType<typeof createExtensionScaffoldHandlers> = createExtensionScaffoldHandlers(),
): void {
  ipcMain.handle(EXTENSION_SCAFFOLD_TEMPLATES_CHANNEL, () => handlers.templates())
  ipcMain.handle(EXTENSION_SCAFFOLD_CHECK_CHANNEL, (_event, input: ExtensionScaffoldCheckInput | undefined) =>
    handlers.check(input),
  )
  // The two that decide where files are written answer only the app's own window.
  ipcMain.handle(EXTENSION_SCAFFOLD_PICK_FOLDER_CHANNEL, (event) => {
    assertAppSender(event)
    return handlers.pickFolder(event)
  })
  ipcMain.handle(EXTENSION_SCAFFOLD_CREATE_CHANNEL, (event, input: ExtensionScaffoldCreateInput | undefined) => {
    assertAppSender(event)
    return handlers.create(input)
  })
}
