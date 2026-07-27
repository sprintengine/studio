#!/usr/bin/env node
// External SprintEngine Studio client. Connects to the app's local MCP socket
// (no app source imports — only the discovery file and the
// wire protocol), then drives create-workspace → launch-agent → read-status.
//
// Usage:
//   node scripts/automation-demo.mjs --user-data-dir <dir> [--cli <agentCli>] [--list-only]
//
// The discovery file <userData>/sprintengine-studio-mcp-info.json exists only
// while SprintEngine Studio is running. The old filename remains a fallback.

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'

function arg(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const userDataDir = arg('--user-data-dir', process.env.MULTICODE_USER_DATA_DIR)
if (!userDataDir) {
  console.error('Pass --user-data-dir <dir> (or set MULTICODE_USER_DATA_DIR).')
  process.exit(2)
}
const agentCli = arg('--cli', 'claude-code')
const folderPath = arg('--folder-path')
const listOnly = process.argv.includes('--list-only')

let info
try {
  let raw
  for (const filename of ['sprintengine-studio-mcp-info.json', 'automation-server-info.json']) {
    try {
      raw = readFileSync(join(userDataDir, filename), 'utf8')
      break
    } catch {
      // Try the next compatibility filename.
    }
  }
  if (!raw) throw new Error('no discovery file found')
  info = JSON.parse(raw)
} catch (error) {
  console.error(`No Studio MCP discovery file in ${userDataDir} — is SprintEngine Studio running? (${error.message})`)
  process.exit(3)
}

const socket = connect(info.socketPath)
socket.setEncoding('utf8')

let nextId = 1
const pendingById = new Map()
let buffer = ''
socket.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) {
      const message = JSON.parse(line)
      const pending = pendingById.get(message.id)
      if (pending) {
        pendingById.delete(message.id)
        pending(message)
      }
    }
    newline = buffer.indexOf('\n')
  }
})

function rpc(method, params) {
  const id = nextId++
  const frame = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
  console.log(`>>> ${JSON.stringify(frame)}`)
  return new Promise((resolve, reject) => {
    pendingById.set(id, (message) => {
      console.log(`<<< ${JSON.stringify(message)}`)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    })
    socket.write(`${JSON.stringify(frame)}\n`)
  })
}

function notify(method) {
  const frame = { jsonrpc: '2.0', method }
  console.log(`>>> ${JSON.stringify(frame)}`)
  socket.write(`${JSON.stringify(frame)}\n`)
}

function toolResult(result, label) {
  if (result.isError) throw new Error(`${label} returned an MCP tool error: ${result.content?.[0]?.text}`)
  return result.structuredContent
}

async function main() {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  console.log(`# connected to ${info.socketPath} (pid ${info.pid}, app ${info.appVersion})`)

  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'automation-demo', version: '1.0.0' },
  })
  notify('notifications/initialized')
  console.log(`# server: ${initialized.serverInfo.name} ${initialized.serverInfo.version}`)

  const tools = await rpc('tools/list')
  console.log(`# tools: ${tools.tools.map((tool) => tool.name).join(', ')}`)
  if (listOnly) {
    socket.end()
    return
  }

  const created = toolResult(
    await rpc('tools/call', {
      name: 'workspace.create',
      arguments: {
        name: `Automation Demo ${new Date().toISOString().slice(11, 19)}`,
        ...(folderPath ? { folderPath } : {}),
      },
    }),
    'workspace.create'
  )
  const workspaceId = created.workspace.id
  console.log(`# created workspace ${workspaceId} ("${created.workspace.name}")`)

  if (folderPath) {
    const backlogCreated = toolResult(
      await rpc('tools/call', {
        name: 'backlog.create',
        arguments: {
          workspaceId,
          title: 'Automation-created backlog item',
          description: 'Created through the SprintEngine Studio MCP acceptance drive.',
          type: 'feature',
        },
      }),
      'backlog.create'
    )
    const backlogPath = backlogCreated.item.relativePath
    const backlogContent = readFileSync(join(folderPath, backlogPath), 'utf8')
    if (!/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m.test(backlogContent)) {
      throw new Error(`backlog.create did not stamp a precise UTC timestamp in ${backlogPath}`)
    }
    console.log(`# backlog.create: ${backlogPath} has a precise server-owned timestamp`)
  }

  const launched = toolResult(
    await rpc('tools/call', { name: 'agent.launch', arguments: { workspaceId, cli: agentCli } }),
    'agent.launch'
  )
  const agentId = launched.agent.agentId
  console.log(`# launched agent ${agentId} (cli ${launched.agent.cli}, pty alive: ${launched.agent.terminal?.processAlive})`)

  const agentStatus = toolResult(
    await rpc('tools/call', { name: 'agent.status', arguments: { workspaceId, agentId } }),
    'agent.status'
  )
  console.log(`# agent.status: session ${agentStatus.agent.terminal?.sessionId} alive=${agentStatus.agent.terminal?.processAlive}`)

  const workspaceStatus = toolResult(
    await rpc('tools/call', { name: 'workspace.status', arguments: { workspaceId } }),
    'workspace.status'
  )
  console.log(`# workspace.status: ${workspaceStatus.agents.length} agent(s) in window ${workspaceStatus.workspace.windowId}`)

  // Read the instance-global roadmap (MC-1693). Read-only and safe: it returns
  // { roadmap: null } when no roadmap is configured, so the demo can always call it.
  // From here an agent can plan (horizon.add_step/remove_step/reorder/skip) and steer
  // (horizon.approve/merge/pause/resume) the same plan the global surface shows a human.
  const roadmap = toolResult(await rpc('tools/call', { name: 'horizon.status', arguments: {} }), 'horizon.status')
  console.log(
    roadmap.roadmap
      ? `# horizon.status: "${roadmap.roadmap.title ?? roadmap.roadmap.roadmapRef}" with ${roadmap.roadmap.lanes.length} lane(s)`
      : '# horizon.status: no roadmap configured for this Multicode'
  )

  // Explicit-error check: an unknown workspace id must produce an MCP tool
  // error, never fake success.
  const invalid = await rpc('tools/call', { name: 'workspace.status', arguments: { workspaceId: 'does-not-exist' } })
  if (!invalid.isError) throw new Error('Expected an MCP tool error for an unknown workspace id.')
  console.log(`# unknown workspace correctly errored: ${invalid.structuredContent.error.code}`)

  console.log('AUTOMATION DEMO OK')
  socket.end()
  console.log(JSON.stringify({ workspaceId, agentId }))
}

main().catch((error) => {
  console.error(`AUTOMATION DEMO FAILED: ${error.message}`)
  socket.destroy()
  process.exit(1)
})
