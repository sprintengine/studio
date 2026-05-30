#!/usr/bin/env node
// VSCode (and any Electron host) sets ELECTRON_RUN_AS_NODE=1, which disables Electron's
// browser process initialization when spawned as a child. Clear it before starting.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const { spawnSync } = require('child_process')
const net = require('net')
const os = require('os')
const path = require('path')
const bin = path.join(require.resolve('electron-vite/package.json'), '../bin/electron-vite.js')

const defaultRendererPort = 5173

function parsePort(value) {
  if (typeof value !== 'string' || !value.trim()) return null

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => {
      resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')
    })
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function isPortAvailable(port) {
  const ipv4Available = await canListen(port, '127.0.0.1')
  const ipv6Available = await canListen(port, '::1')
  return ipv4Available && ipv6Available
}

async function findAvailablePort(start) {
  for (let port = start; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) return port
  }
  return null
}

function devProfileDir(port) {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', `multicode-dev-${port}`)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), `multicode-dev-${port}`)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), `multicode-dev-${port}`)
}

async function configureParallelDevInstance() {
  const requestedPort = parsePort(env.MULTICODE_RENDERER_PORT)
  let rendererPort = requestedPort ?? defaultRendererPort

  if (!requestedPort && !(await isPortAvailable(defaultRendererPort))) {
    const availablePort = await findAvailablePort(defaultRendererPort + 1)
    if (!availablePort) throw new Error('No available renderer port found for Multicode dev.')
    rendererPort = availablePort
    env.MULTICODE_RENDERER_PORT = String(rendererPort)
  }

  if (rendererPort !== defaultRendererPort && !env.MULTICODE_USER_DATA_DIR) {
    env.MULTICODE_USER_DATA_DIR = devProfileDir(rendererPort)
    env.MULTICODE_ALLOW_MULTI_INSTANCE = '1'
    console.info(
      `Starting parallel Multicode dev instance on port ${rendererPort} with userData ${env.MULTICODE_USER_DATA_DIR}`
    )
  }
}

async function main() {
  await configureParallelDevInstance()
  const result = spawnSync('node', [bin, 'dev'], { stdio: 'inherit', env })
  process.exit(result.status ?? 0)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
