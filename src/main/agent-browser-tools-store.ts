/**
 * "Let agents use the built-in browser", owned by main: the browser.* tools
 * are put together and offered here, before any window could be asked.
 *
 * Absent, unreadable or malformed read as ON: the tools are part of what the
 * app gives its agents, and a store that cannot be trusted should not take
 * them away unasked.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import { isRecord } from '../shared/records'
import { createBooleanFileSetting, type BooleanFileSetting, type BooleanFileSettingDeps } from './boolean-file-setting'

const AGENT_BROWSER_TOOLS_FILE = 'agent-browser-tools.json'

export type AgentBrowserToolsStore = BooleanFileSetting

/** `isEnabled()` is whether agents are given the browser.* tools. */
export function createAgentBrowserToolsStore(deps: BooleanFileSettingDeps): AgentBrowserToolsStore {
  return createBooleanFileSetting(
    {
      fileName: AGENT_BROWSER_TOOLS_FILE,
      key: 'enabled',
      fallback: true,
      notPersisted: {
        title: 'Agent browser setting not persisted',
        message:
          'The "Let agents use the built-in browser" setting could not be written to disk; it applies for this session but will not survive a restart.',
      },
    },
    deps,
  )
}

/**
 * Whether the setting is on as the file says now, read afresh every time: for
 * the server in a process of its own, which shares the profile's folder but
 * not the shell's memory, so a cached value would miss the person's change.
 */
export function agentBrowserToolsEnabledOnDisk(userDataDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(userDataDir, AGENT_BROWSER_TOOLS_FILE), 'utf8'))
    return !(isRecord(raw) && raw.enabled === false)
  } catch {
    return true
  }
}

/**
 * The switch as the gateway applies it: the shell toolsets an agent's first
 * list waits for, without the browser while it is off, and the gateway tools
 * left out of a list, the browser's while it is off. Both are asked when they
 * are needed, never kept, so a change applies without a restart.
 */
export function agentBrowserToolGate(isEnabled: () => boolean): {
  expectedToolsets: (toolsets: readonly string[]) => () => readonly string[]
  hidesTool: (name: string) => boolean
} {
  return {
    expectedToolsets: (toolsets) => () => toolsets.filter((name) => name !== 'browser' || isEnabled()),
    hidesTool: (name) => name.startsWith('browser.') && !isEnabled(),
  }
}
