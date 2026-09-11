// The app installs its own plugin into every workspace it opens.
//
// This is the Electron-bound half of `skills/studio-plugin.ts`: it resolves the
// bundled template, the bridge, the reporter and the live agent-state socket,
// answers the hooks acknowledgement once, and runs the install at the two
// moments a workspace becomes real to main — the boot pass over the roots the
// registry already holds, and every workspace event after that.
//
// Three properties it must have, because it runs on a path a person is waiting
// behind:
//
//   - **Best-effort.** A failure is logged and swallowed. An app that refused
//     to open a workspace because a skill could not be copied would be worse
//     than an app whose agent has to call `sprintengine_help` this once.
//   - **Once per workspace per app run**, and serialised per workspace. The
//     install rewrites `.claude/settings.json`; two concurrent
//     read-modify-writes of that file lose one of them.
//   - **Version-keyed.** The memo is keyed by the version the build ships, so a
//     workspace opened under an older build reinstalls when the app updates
//     without anyone pressing anything. That is also the drift the catalogue's
//     built-in row reports.
//
// The acknowledgement is answered ONCE, at first run, for the app's own plugin.
// A person is asked to vet hook commands before a THIRD PARTY's plugin runs
// them; these commands are this app's own reporter, spawned by this app, and
// asking about them would be the app asking permission to be itself. What the
// record buys is honesty: the timestamp is real, it is per profile, and the
// built-in row can say when it was given.

import { existsSync } from 'node:fs'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { SkillHarness } from '../shared/skills'
import { AGENT_STATE_HOOK_SCRIPT_REL } from './agent-state'
import {
  installStudioPlugin,
  readStudioPluginTemplate,
  removeStudioPluginClaudeRegistration,
  STUDIO_PLUGIN_ID,
  studioClaudePluginKey,
  type StudioPluginInstallResult,
} from './skills/studio-plugin'

const ACKNOWLEDGEMENT_FILE = 'studio-plugin.json'

export type StudioPluginServiceOptions = {
  /** `resources/studio-plugin` in this build, or null when it did not ship. */
  resolveTemplateRoot: () => string | null
  /** The bundled stdin-filter reporter, or null when it did not ship. */
  resolveAgentStateReporterPath: () => string | null
  /** Absolute path of the bundled MCP stdio bridge. */
  resolveBridgeScriptPath: () => string
  /** The binary that runs the bridge — this app's own executable. */
  resolveNodeCommand: () => string
  resolveUserDataDir: () => string
  /** The live agent-state socket; '' when the reporter socket is not up. */
  resolveAgentStateSocketPath: () => string
  /** Which CLIs on this machine read workspace skills. */
  listHarnesses: () => Promise<SkillHarness[]>
  /**
   * Whether the launch hands the Claude-family CLIs this app's plugin
   * directories itself. True ⇒ this workspace gets no `.claude/skills` copies,
   * no hook merged into its Claude settings and no `enabledPlugins` entry: the
   * session carries all three, and writing them here as well would both double
   * every agent-state frame and leave the files in the person's repository.
   *
   * Absent ⇒ false, which is the arrangement from before the launch flag: every
   * harness is written to, exactly as it was.
   */
  resolveLaunchPluginsActive?: () => boolean
  logDiagnostic?: (input: {
    level: 'warning' | 'info'
    title: string
    message: string
    details?: string
  }) => void
}

type StudioPluginInstallRecord = {
  workspaceRoot: string
  version: string
  skillDirNames: string[]
  claudePluginKey: string
  hookSettingsPath: string
  installedAt: string
  /**
   * Whether the launch was carrying this app's plugin directories when this
   * install ran. Part of the record rather than the key so that `installed()`
   * still answers for a workspace by version alone — but compared before the
   * memo is trusted, because the two arrangements write different things.
   *
   * The case that makes it load-bearing: the app-owned copy is materialised
   * asynchronously at startup, so a workspace opened in that window is
   * installed the OLD way (hook merged into its Claude settings). Moments later
   * the copy lands and every launch starts registering the same hook itself. A
   * memo keyed on version alone would never reinstall, and both registrations
   * would fire the reporter for every event, forever.
   */
  launchPluginsActive: boolean
}

export type StudioPluginService = {
  /** Install into one workspace. Idempotent, serialised, and never throws. */
  ensureInstalled(workspaceRoot: string): Promise<void>
  /** Install into every root main already knows about. Runs once, at boot. */
  ensureInstalledForRoots(roots: readonly string[]): Promise<void>
  /** What this build ships, for the catalogue's built-in row. '' when it did not ship. */
  bundledVersion(): Promise<string>
  /** What the last install of this run wrote for a workspace, or null. */
  installed(workspaceRoot: string): StudioPluginInstallRecord | null
  /** When the hooks acknowledgement was answered, or '' when it has not been. */
  hooksAcknowledgedAt(): Promise<string>
}

export function createStudioPluginService(options: StudioPluginServiceOptions): StudioPluginService {
  // Keyed by `${version}::${root}`: a version bump invalidates every entry
  // without anyone having to remember to clear this map.
  const done = new Map<string, StudioPluginInstallRecord>()
  const chains = new Map<string, Promise<void>>()
  let cachedVersion: string | null = null
  let cachedAcknowledgement: string | null = null

  function warn(title: string, message: string, details?: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message, ...(details ? { details } : {}) })
  }

  async function bundledVersion(): Promise<string> {
    if (cachedVersion !== null) return cachedVersion
    const templateRoot = options.resolveTemplateRoot()
    if (!templateRoot) {
      cachedVersion = ''
      return cachedVersion
    }
    const read = await readStudioPluginTemplate(templateRoot)
    cachedVersion = read.ok ? read.template.version : ''
    return cachedVersion
  }

  function acknowledgementPath(): string {
    return join(options.resolveUserDataDir(), ACKNOWLEDGEMENT_FILE)
  }

  /**
   * Answer the hooks acknowledgement, once, and record when. Distinct from the
   * service's `hooksAcknowledgedAt`, which only READS it: a surface displaying
   * the record must never be what answers the question.
   *
   * An unreadable or malformed record is treated as unanswered and rewritten:
   * this is a record of a decision the app makes for itself, so re-making it is
   * free, and refusing to install because a JSON file was truncated would cost
   * the workspace its agent state.
   */
  async function answerHooksAcknowledgement(): Promise<string> {
    if (cachedAcknowledgement !== null) return cachedAcknowledgement
    const path = acknowledgementPath()
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing !== null) {
      try {
        const parsed: unknown = JSON.parse(existing)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const at = (parsed as Record<string, unknown>).hooksAcknowledgedAt
          if (typeof at === 'string' && at !== '') {
            cachedAcknowledgement = at
            return at
          }
        }
      } catch {
        // Fall through and answer it again.
      }
    }
    const at = new Date().toISOString()
    try {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(
        temp,
        `${JSON.stringify({ plugin: STUDIO_PLUGIN_ID, hooksAcknowledgedAt: at }, null, 2)}\n`,
        'utf8'
      )
      await rename(temp, path)
    } catch (error) {
      // The decision still stands for this run; only the record failed. Say so
      // rather than silently re-answering on every open.
      warn(
        'Studio plugin acknowledgement not recorded',
        'The hook acknowledgement for the built-in plugin could not be written, so it will be answered again next run.',
        describe(error)
      )
    }
    cachedAcknowledgement = at
    return at
  }

  async function install(workspaceRoot: string): Promise<void> {
    const version = await bundledVersion()
    if (version === '') {
      warn(
        'Studio plugin missing from this build',
        'The built-in SprintEngine Studio plugin did not ship with this build, so no workspace receives it.'
      )
      return
    }
    // The Claude-family CLIs read this app's skills from the directories the
    // launch passes them, so the workspace copy for that harness is dropped —
    // the other CLIs still read theirs from the repository until each gets a
    // launch-scoped path of its own.
    //
    // Read BEFORE the memo: an install done under the other arrangement wrote
    // different files, so it has to be redone rather than remembered.
    const launchPluginsActive = options.resolveLaunchPluginsActive?.() ?? false
    const key = `${version}::${workspaceRoot}`
    if (done.get(key)?.launchPluginsActive === launchPluginsActive) return

    // The migration runs BEFORE every early return below. A workspace written
    // to by an older release holds a hook that now fires beside the one the
    // launch registers — twice per event — and that has to come out even when
    // this build ships no template, or no harness on this machine wants skills.
    if (launchPluginsActive) {
      const removed = await removeStudioPluginClaudeRegistration(workspaceRoot)
      if (removed.length > 0) {
        options.logDiagnostic?.({
          level: 'info',
          title: 'Workspace tidied',
          message: 'SprintEngine Studio now passes its skills and agent-state hook to Claude at launch, so the copies in this workspace were removed.',
          details: removed.join(', '),
        })
      }
    }

    const templateRoot = options.resolveTemplateRoot()
    const reporter = options.resolveAgentStateReporterPath()
    if (!templateRoot || !reporter) return
    const socketPath = options.resolveAgentStateSocketPath()
    const harnesses = (await options.listHarnesses()).filter(
      (harness) => !(launchPluginsActive && harness === 'claude')
    )
    if (harnesses.length === 0) return

    // The hook is only registered when a socket exists to report to. Without
    // one the rest still installs: the skills and the MCP bridge are what an
    // agent reads, and agent state is repaired by the CLI's own installer at
    // the next launch.
    const acknowledged = socketPath !== '' && (await answerHooksAcknowledgement()) !== ''

    const result: StudioPluginInstallResult = await installStudioPlugin({
      workspaceRoot,
      templateRoot,
      harnesses,
      agentStateReporterSourcePath: reporter,
      hooksAcknowledged: acknowledged,
      registerWithClaude: !launchPluginsActive,
      tokens: {
        nodeCommand: options.resolveNodeCommand(),
        bridgeScriptPath: options.resolveBridgeScriptPath(),
        userDataDir: options.resolveUserDataDir(),
        agentStateReporterPath: resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL),
        agentStateSocketPath: socketPath,
      },
    })
    if (!result.ok) {
      warn('Studio plugin install failed', result.message)
      return
    }
    for (const warning of result.warnings) warn('Studio plugin install warning', warning)
    done.set(key, {
      workspaceRoot,
      version: result.version,
      skillDirNames: result.skillDirNames,
      claudePluginKey: result.claudePluginKey || studioClaudePluginKey(),
      hookSettingsPath: result.hookSettingsPath,
      installedAt: new Date().toISOString(),
      launchPluginsActive,
    })
  }

  async function ensureInstalled(workspaceRoot: string): Promise<void> {
    const root = workspaceRoot?.trim() ?? ''
    if (root === '') return
    // Synchronous fast path. Every accepted registry event runs a pass over
    // every known root, so the settled case has to cost nothing — not a chain
    // link, not a stat.
    if (
      cachedVersion !== null
      && cachedVersion !== ''
      && done.get(`${cachedVersion}::${root}`)?.launchPluginsActive
        === (options.resolveLaunchPluginsActive?.() ?? false)
    ) {
      return
    }
    if (!existsSync(root)) return
    // Serialised on the workspace, not on the version: two versions never race
    // inside one app run, but two openings of the same workspace do, and both
    // would read-modify-write the same `.claude/settings.json`.
    const prior = chains.get(root) ?? Promise.resolve()
    const next = prior.then(() => install(root))
    // Keep the chain alive even if this link rejected, so a later open retries
    // rather than inheriting a poisoned promise.
    chains.set(
      root,
      next.catch(() => {})
    )
    await next.catch((error) => warn('Studio plugin install threw', describe(error)))
  }

  return {
    ensureInstalled,
    async ensureInstalledForRoots(roots) {
      // Sequential on purpose: each install writes a handful of small files,
      // and a fan-out over every known workspace at boot would compete with the
      // window that is trying to paint.
      for (const root of roots) await ensureInstalled(root)
    },
    bundledVersion,
    installed(workspaceRoot) {
      const root = workspaceRoot?.trim() ?? ''
      if (root === '' || cachedVersion === null) return null
      return done.get(`${cachedVersion}::${root}`) ?? null
    },
    hooksAcknowledgedAt: async () => cachedAcknowledgement ?? (await readAcknowledgementOnly(acknowledgementPath())),
  }
}

/** Read the record without answering it — for a caller that only wants to display it. */
async function readAcknowledgementOnly(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    const at = (parsed as Record<string, unknown>).hooksAcknowledgedAt
    return typeof at === 'string' ? at : ''
  } catch {
    return ''
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
