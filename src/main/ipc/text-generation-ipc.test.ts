/**
 * The `text-generation:chat-title` boundary. The service has its own suite;
 * what only this file can get wrong is the trail a failure leaves. A title that
 * does not arrive is silent in the window by rule (the heuristic title
 * stands), so the diagnostics log is the one place a person can see why their
 * chosen engine did not answer.
 */
import assert from 'node:assert/strict'

import type { DiagnosticLogInput } from '../../shared/electron-api'
import type { ChatTitleRequest, TextGenerationResult } from '../../shared/text-generation/contract'
import { registerTextGenerationIpc } from './text-generation-ipc'
import { test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

test('text-generation-ipc', async () => {
  type Handler = (event: unknown, raw: unknown) => Promise<TextGenerationResult>

  function register(result: TextGenerationResult): { handler: Handler; logged: DiagnosticLogInput[] } {
    let registered: Handler | null = null
    const logged: DiagnosticLogInput[] = []
    const ipcMain = {
      handle: (channel: string, fn: Handler) => {
        if (channel === 'text-generation:chat-title') registered = fn
      },
    }
    registerTextGenerationIpc(ipcMain as unknown as Parameters<typeof registerTextGenerationIpc>[0], {
      generate: async (_request: ChatTitleRequest) => result,
      log: async (entry) => {
        logged.push(entry)
      },
    })
    assert.ok(registered, 'the channel is registered under the name the preload calls')
    return { handler: registered as unknown as Handler, logged }
  }

  const request = {
    prompt: 'fix the sidebar flicker',
    engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
  }

  // A failed title leaves one info line naming the engine and the reason.
  {
    const failure: TextGenerationResult = {
      ok: false,
      code: 'transport',
      message: "codex exited 1: Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model.",
    }
    const { handler, logged } = register(failure)
    assert.deepEqual(await handler({}, request), failure, 'the renderer still gets the typed failure')
    assert.equal(logged.length, 1)
    assert.equal(logged[0]!.level, 'info', 'never a warning: a missing title is not an error the person must act on')
    assert.equal(logged[0]!.title, 'Chat title not generated')
    assert.equal(
      logged[0]!.message,
      "codex · gpt-5.6-luna · low: transport — codex exited 1: Unsupported value: 'minimal' is not supported with the 'gpt-5.6-luna' model.",
    )
  }

  // A title that lands leaves no trail.
  {
    const { handler, logged } = register({ ok: true, value: 'Fix sidebar flicker', ms: 4000 })
    assert.deepEqual(await handler({}, request), { ok: true, value: 'Fix sidebar flicker', ms: 4000 })
    assert.equal(logged.length, 0)
  }

  // A malformed request never reaches the service, and is logged too.
  {
    const { handler, logged } = register({ ok: true, value: 'unused', ms: 0 })
    const result = await handler({}, { prompt: 42 })
    assert.deepEqual(result, { ok: false, code: 'unsupported', message: 'Malformed chat title request.' })
    assert.equal(logged.length, 1)
  }

  // A log that cannot be written never costs the caller its answer.
  {
    let registered: Handler | null = null
    registerTextGenerationIpc(
      {
        handle: (_channel: string, fn: Handler) => {
          registered = fn
        },
      } as unknown as Parameters<typeof registerTextGenerationIpc>[0],
      {
        generate: async () => ({ ok: false, code: 'timeout', message: 'codex did not answer in time.' }),
        log: async () => {
          throw new Error('disk full')
        },
      },
    )
    const result = await (registered as unknown as Handler)({}, request)
    assert.deepEqual(result, { ok: false, code: 'timeout', message: 'codex did not answer in time.' })
  }
})
