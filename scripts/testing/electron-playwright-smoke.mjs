#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const userDataDir = process.env.MULTICODE_PW_USER_DATA || '/tmp/multicode-playwright-user-data'
const screenshotPath =
  process.env.MULTICODE_PW_SCREENSHOT || '/tmp/multicode-playwright-smoke.png'

async function loadPlaywright() {
  try {
    return require('playwright')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        'Playwright is not available to this Node process.',
        'Install it locally, or run:',
        '  tmp=/tmp/multicode-playwright',
        '  npm --prefix "$tmp" install playwright --no-audit --no-fund',
        '  NODE_PATH="$tmp/node_modules" node scripts/testing/electron-playwright-smoke.mjs',
        `Original error: ${message}`,
      ].join('\n'),
    )
  }
}

async function main() {
  const { _electron: electron } = await loadPlaywright()
  const electronPath = require('electron')

  await rm(userDataDir, { recursive: true, force: true })
  await mkdir(userDataDir, { recursive: true })

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_DIAGNOSTICS: '1',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1000)
    await page.screenshot({ path: screenshotPath, fullPage: true })

    const bodyText = await page.locator('body').innerText()
    console.log(JSON.stringify({
      title: await page.title(),
      url: page.url(),
      userDataDir,
      screenshotPath,
      bodyPreview: bodyText.slice(0, 500),
    }, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
