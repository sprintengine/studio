import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { registerAutomationTrigger, type RegisterMain } from '@sprintengine/module-sdk'

type FileChangedConfig = { path: string }

function readConfig(config: unknown): FileChangedConfig | null {
  if (typeof config !== 'object' || config === null) return null
  const { path } = config as { path?: unknown }
  return typeof path === 'string' && path.trim().length > 0 ? { path: path.trim() } : null
}

/** The file inside the project, or null when the path would leave it. */
function resolveInside(workspaceRoot: string, path: string): string | null {
  const absolute = resolve(workspaceRoot, path)
  const inside = relative(workspaceRoot, absolute)
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? null : absolute
}

// A trigger kind for Studio's Automations: pair it in the Automations panel
// with any action (an agent run, a skill loop) and it fires when the watched
// file's content is new. The engine polls `poll` on its own cadence and runs
// each event id at most once, so the id is the file's content hash: the same
// content never fires twice.
//
// Kinds are namespaced by module id. `dependsOn: ["automations"]` in the
// manifest makes the registry exist before this code runs.
export const registerMain: RegisterMain = (host) => {
  registerAutomationTrigger(host, {
    kind: `${host.moduleId}.file-changed`,
    label: 'File changed',
    glyph: 'board',
    summary: 'Runs when a file in the project has new content.',
    configSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', title: 'File', description: 'Path relative to the project, e.g. docs/plan.md' },
      },
      required: ['path'],
    },
    validateConfig(config) {
      return readConfig(config)
        ? { ok: true }
        : { ok: false, error: 'Name the file to watch, relative to the project.' }
    },
    // Nothing to push: this trigger is polled.
    subscribe: () => () => {},
    async poll({ config, workspaceRoot, now }) {
      const parsed = readConfig(config)
      if (!parsed) return { ok: false, blockedReason: 'The trigger has no file to watch.' }
      const file = resolveInside(workspaceRoot, parsed.path)
      if (!file) return { ok: false, blockedReason: `${parsed.path} is outside the project.` }
      let bytes: Buffer
      try {
        bytes = await readFile(file)
      } catch {
        // A file that does not exist yet has nothing new to report.
        return { ok: true, events: [] }
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      return {
        ok: true,
        events: [
          {
            id: `${parsed.path}@${sha256}`,
            occurredAt: new Date(now()).toISOString(),
            payload: { path: parsed.path, sha256 },
          },
        ],
      }
    },
  })
}
