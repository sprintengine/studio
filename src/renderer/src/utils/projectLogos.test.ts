import assert from 'node:assert/strict'

import type { ProjectLogo } from '../../../shared/electron-api'
import {
  ensureProjectLogo,
  getProjectLogoDataUrl,
  resetProjectLogos,
  subscribeProjectLogos,
} from './projectLogos'

// The renderer half of MC-2135: one detection per project folder per session,
// shared by every surface that shows that project, and never a state the icon
// slot cannot render.

const LOGO: ProjectLogo = { path: '/repo/logo.svg', mtimeMs: 1, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }

// Detection settles over several microtasks (`ensureProjectLogo` defers the
// call so a synchronous throw is caught like a rejection), so drain rather than
// counting ticks.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function deferred() {
  let resolve!: (value: ProjectLogo | null) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<ProjectLogo | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function main(): Promise<void> {
  {
    resetProjectLogos()
    assert.equal(getProjectLogoDataUrl(null), null, 'a workspace with no folder has no logo')
    assert.equal(getProjectLogoDataUrl('/never-asked'), null, 'an unasked folder has no logo')
  }

  {
    // A detection in flight must read exactly like a miss, so a row shows the
    // glyph throughout instead of flashing an empty slot.
    resetProjectLogos()
    const pending = deferred()
    let notified = 0
    const unsubscribe = subscribeProjectLogos(() => {
      notified += 1
    })

    ensureProjectLogo('/repo', () => pending.promise)
    assert.equal(getProjectLogoDataUrl('/repo'), null, 'a pending detection reads as no logo')
    assert.equal(notified, 0, 'starting a detection does not churn subscribers')

    pending.resolve(LOGO)
    await flush()
    assert.equal(getProjectLogoDataUrl('/repo'), LOGO.dataUrl, 'the resolved logo lands on the folder')
    assert.equal(notified, 1, 'subscribers are told once when it lands')
    unsubscribe()
  }

  {
    resetProjectLogos()
    let calls = 0
    const detect = async () => {
      calls += 1
      return LOGO
    }
    ensureProjectLogo('/repo', detect)
    ensureProjectLogo('/repo', detect)
    await flush()
    ensureProjectLogo('/repo', detect)
    assert.equal(calls, 1, 'every surface asking for the same project shares one detection')

    ensureProjectLogo('/other', detect)
    await flush()
    assert.equal(calls, 2, 'a different project gets its own detection')
  }

  {
    // Detection is decoration. A failed scan keeps the glyph and does not
    // surface an error, and it is not retried on every render.
    resetProjectLogos()
    let calls = 0
    const failing = async () => {
      calls += 1
      throw new Error('EACCES')
    }
    ensureProjectLogo('/repo', failing)
    await flush()
    assert.equal(getProjectLogoDataUrl('/repo'), null, 'a failed detection keeps the glyph')

    ensureProjectLogo('/repo', failing)
    assert.equal(calls, 1, 'a failed detection is not retried on the next render')
  }

  {
    // A detector that throws synchronously (a preload bridge without the
    // method, as a partially-stubbed test harness has) is a failed detection,
    // not a mount crash — the sidebar must never fail to render over
    // decoration.
    resetProjectLogos()
    assert.doesNotThrow(() => {
      ensureProjectLogo('/repo', () => {
        throw new TypeError('window.api.detectProjectLogo is not a function')
      })
    }, 'a synchronously throwing detector does not escape ensureProjectLogo')
    await flush()
    assert.equal(getProjectLogoDataUrl('/repo'), null, 'it settles as no logo, keeping the glyph')
  }

  {
    resetProjectLogos()
    ensureProjectLogo('/repo', async () => null)
    await flush()
    assert.equal(getProjectLogoDataUrl('/repo'), null, 'a repo with no logo reads as no logo')
  }
}

main()
  .then(() => console.log('project logo store tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
