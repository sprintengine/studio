#!/usr/bin/env node
// VSCode (and any Electron host) sets ELECTRON_RUN_AS_NODE=1, which disables Electron's
// browser process initialization when spawned as a child. Clear it before starting.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const { spawnSync } = require('child_process')
const net = require('net')
const bin = require('path').join(require.resolve('electron-vite/package.json'), '../bin/electron-vite.js')

const rendererPort = 5173

function findPortOwner(port) {
  if (process.platform === 'win32') return ''

  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })

  return result.stdout.trim()
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        const owner = findPortOwner(port)
        reject(
          new Error(
            [
              `Multicode dev renderer requires http://localhost:${port}.`,
              'That port is already in use, so starting on a fallback port would hide persisted workspaces.',
              owner ? `\nPort owner:\n${owner}` : '',
            ].join('\n')
          )
        )
        return
      }

      reject(error)
    })

    server.once('listening', () => {
      server.close(() => resolve())
    })

    server.listen(port, '127.0.0.1')
  })
}

async function main() {
  const owner = findPortOwner(rendererPort)
  if (owner) {
    console.error(
      [
        `Multicode dev renderer requires http://localhost:${rendererPort}.`,
        'That port is already in use, so starting on a fallback or split localhost binding would hide persisted workspaces.',
        `\nPort owner:\n${owner}`,
      ].join('\n')
    )
    process.exit(1)
  }

  try {
    await assertPortAvailable(rendererPort)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const result = spawnSync('node', [bin, 'dev'], { stdio: 'inherit', env })
  process.exit(result.status ?? 0)
}

main()
