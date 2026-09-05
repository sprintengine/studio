#!/usr/bin/env node
// End-to-end acceptance run for the SprintEngine Studio MCP gateway (T10):
//   Phase A — fresh profile: the always-on gateway starts and lists tools.
//   Phase B — a legacy persisted `enabled: false` cannot disable it; the external client
//   performs create-workspace → launch-agent → read-status against the running
//   app, and a screenshot captures the created workspace/agent in the UI.
//
// Run after `npm run build`:
//   NODE_PATH=/tmp/multicode-playwright/node_modules node scripts/testing/automation-e2e.mjs

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveMainWindow } from './newChatWorkspace.mjs'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const userDataDir = process.env.MULTICODE_AUTOMATION_E2E_PROFILE || join(tmpdir(), 'multicode-automation-e2e-profile')
const workspaceRoot = process.env.MULTICODE_AUTOMATION_E2E_WORKSPACE || join(tmpdir(), 'multicode-automation-e2e-workspace')
const screenshotPath = process.env.MULTICODE_AUTOMATION_E2E_SCREENSHOT || join(tmpdir(), 'multicode-automation-e2e.png')
const agentCli = process.env.MULTICODE_AUTOMATION_E2E_CLI || 'claude-code'

function loadPlaywright() {
  try {
    return require('playwright')
  } catch {
    throw new Error(
      'Playwright is unavailable. Install it or run with NODE_PATH=/tmp/multicode-playwright/node_modules.'
    )
  }
}

async function launchApp(electron) {
  const electronPath = require('electron')
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
    },
  })
  const page = await resolveMainWindow(app)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  return { app, page }
}

async function runDemo(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(root, 'scripts/automation-demo.mjs'), '--user-data-dir', userDataDir, ...args],
      { timeout: 90_000 }
    )
    return { code: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

async function main() {
  const { _electron: electron } = loadPlaywright()

  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
  mkdirSync(workspaceRoot, { recursive: true })

  // ── Phase A: the gateway starts with a fresh profile ──────────────────────
  console.log('## Phase A: Studio MCP enabled by default')
  {
    const { app } = await launchApp(electron)
    try {
      if (!existsSync(join(userDataDir, 'sprintengine-studio-mcp-info.json'))) {
        throw new Error('Canonical discovery file is missing from a fresh profile.')
      }
      console.log('phase A: canonical discovery file is present — OK')
      const demo = await runDemo(['--list-only'])
      if (demo.code !== 0) {
        throw new Error(`External client could not connect to the default gateway (exit ${demo.code}).`)
      }
      console.log('phase A: external client listed tools — OK')
    } finally {
      await app.close()
    }
  }

  // ── Phase B: legacy false is ignored, then drive the mutation demo ────────
  console.log('## Phase B: legacy disabled setting cannot stop Studio MCP')
  writeFileSync(join(userDataDir, 'automation-settings.json'), JSON.stringify({ enabled: false }, null, 2))
  {
    const { app, page } = await launchApp(electron)
    try {
      if (!existsSync(join(userDataDir, 'sprintengine-studio-mcp-info.json'))) {
        throw new Error('Discovery file missing with legacy enabled:false — the gateway was incorrectly disabled.')
      }
      console.log('phase B: Studio MCP is still listening — OK')

      const demo = await runDemo(['--cli', agentCli, '--folder-path', workspaceRoot])
      console.log(demo.output)
      if (demo.code !== 0 || !demo.output.includes('AUTOMATION DEMO OK')) {
        throw new Error(`automation-demo failed with exit ${demo.code}`)
      }
      const managedMcpConfig = agentCli === 'codex'
        ? join(workspaceRoot, '.codex', 'config.toml')
        : join(workspaceRoot, '.mcp.json')
      if (!existsSync(managedMcpConfig)) {
        throw new Error(`Studio agent launch did not create workspace MCP config at ${managedMcpConfig}.`)
      }
      if (!readFileSync(managedMcpConfig, 'utf8').includes('sprintengine-studio')) {
        throw new Error('Workspace MCP config does not contain the required sprintengine-studio server.')
      }
      const claudeSettingsPath = join(workspaceRoot, '.claude', 'settings.local.json')
      if (['claude-code', 'zai', 'kimi-claude'].includes(agentCli) || agentCli === 'codex') {
        const claudeMcpPath = join(workspaceRoot, '.mcp.json')
        if (!existsSync(claudeMcpPath) || !readFileSync(claudeMcpPath, 'utf8').includes('sprintengine-studio')) {
          throw new Error('The workspace default Claude agent did not receive sprintengine-studio.')
        }
        if (!existsSync(claudeSettingsPath)) {
          throw new Error(`Claude project MCP settings were not created at ${claudeSettingsPath}.`)
        }
        const claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
        if (!claudeSettings.enabledMcpjsonServers?.includes('sprintengine-studio')) {
          throw new Error('Claude project settings did not automatically enable sprintengine-studio.')
        }
        if (claudeSettings.disabledMcpjsonServers?.includes('sprintengine-studio')) {
          throw new Error('Claude project settings still disable sprintengine-studio.')
        }
      }
      if (agentCli === 'codex' && !demo.output.includes('workspace.status: 2 agent(s)')) {
        throw new Error('The real Claude + Codex proof did not keep both CLI processes alive concurrently.')
      }
      console.log('phase B: launched agents received the workspace-scoped Studio MCP config — OK')

      // Let the created workspace/agent terminal render, then capture the UI.
      await page.waitForTimeout(3000)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`phase B: screenshot written to ${screenshotPath}`)

      const bodyText = await page.locator('body').innerText()
      if (!bodyText.includes('Automation Demo')) {
        throw new Error('Created workspace name is not visible in the UI.')
      }
      console.log('phase B: created workspace is visible in the UI — OK')
    } finally {
      await app.close()
    }
  }

  for (const filename of ['sprintengine-studio-mcp-info.json', 'automation-server-info.json']) {
    if (existsSync(join(userDataDir, filename))) {
      throw new Error(`Discovery file ${filename} remained after app shutdown.`)
    }
  }
  const auditPath = join(userDataDir, 'sprintengine-studio-mcp-audit.jsonl')
  const auditRecords = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const auditedTools = auditRecords.map((record) => record.tool)
  for (const tool of ['workspace.create', 'backlog.create', 'agent.launch']) {
    if (!auditedTools.includes(tool)) throw new Error(`Mutation audit is missing ${tool}.`)
  }
  if (auditedTools.some((tool) => ['workspace.status', 'agent.status', 'horizon.status'].includes(tool))) {
    throw new Error('A read-only operation was incorrectly written to the mutation audit.')
  }
  if (readFileSync(auditPath, 'utf8').includes('Created through the SprintEngine Studio MCP acceptance drive.')) {
    throw new Error('Mutation audit leaked the backlog body.')
  }
  console.log('shutdown: discovery cleaned up and mutation-only redacted audit is present — OK')

  console.log('AUTOMATION E2E OK')
}

main().catch((error) => {
  console.error(`AUTOMATION E2E FAILED: ${error.message}`)
  process.exit(1)
})
