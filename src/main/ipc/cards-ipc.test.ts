/**
 * The `cards:run` envelope, at the boundary it is read on.
 *
 * The executor has its own suite and this is not a second copy of it. What is
 * asserted here is the one thing only this file can be wrong about: that the
 * request is CHECKED rather than trusted. "The renderer sent it" is a claim
 * about a process, not about a shape, and the fields the request carries that a
 * card does not — the workspace, the clone parent, the MCP servers, and since
 * item 2473 the model row the person chose in the picker — all cross a process
 * boundary before they get here.
 *
 * The row is the part this suite was added for. `Go` opens the model picker and
 * choosing a row is what runs the card (owner ruling R4b, 2026-09-06), so a
 * model id, an effort level and a permission preset now ride the envelope. A
 * malformed one must not be the reason a card's installs do not run — it is
 * dropped, and the far side falls back to the app's own default, which is what
 * an absent field means anyway.
 *
 * The handler is exercised for real: a fake `ipcMain` keeps the registration,
 * the services are never reached (every dependency is a lazily-called closure,
 * and the card used here opens a chat and installs nothing), and the assertions
 * read the chat hand-off that comes back.
 */
import assert from 'node:assert/strict'

import type { CardRunResult } from '../../shared/electron-api'
import { registerCardsIpc, type CardsIpcServices } from './cards-ipc'

type Handler = (event: unknown, raw: unknown) => Promise<CardRunResult>

function handler(): Handler {
  let registered: Handler | null = null
  const ipcMain = {
    handle: (channel: string, fn: Handler) => {
      if (channel === 'cards:run') registered = fn
    },
  }
  registerCardsIpc(
    ipcMain as unknown as Parameters<typeof registerCardsIpc>[0],
    {} as unknown as CardsIpcServices,
  )
  assert.ok(registered, 'the channel is registered under the name the preload calls')
  return registered as unknown as Handler
}

// One action, and one that reaches no installer: `open.chat` is validated in the
// executor's switch and handed straight back for the renderer to perform.
const CHAT = [{ verb: 'open.chat', prompt: 'Give this app a design system.', send: true }]

function envelope(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: 'design-system',
    actions: CHAT,
    workspaceRoot: '/tmp/workspace',
    cloneParentDir: '/tmp/projects',
    mcpServers: [],
    mcpSyncEnabled: false,
    ...extra,
  }
}

async function main(): Promise<void> {
  const run = handler()

  // ── The chosen row travels, and comes back on the chat ───────────────────────
  {
    const result = await run(null, envelope({
      model: 'claude-opus-5',
      reasoning: 'high',
      permissionPreset: 'auto',
    }))
    assert.equal(result.ok, true)
    assert.equal(result.chat?.model, 'claude-opus-5')
    assert.equal(result.chat?.reasoning, 'high')
    assert.equal(result.chat?.permissionPreset, 'auto', 'the preset the row carried is the preset handed back')
  }

  // ── A row that is not a row is dropped, and the card still runs ──────────────
  // A number where a model id belongs, and a preset this build does not know:
  // neither is a reason to refuse the installs, and neither may reach the far
  // side as a launch axis nobody can honour.
  {
    const result = await run(null, envelope({
      model: 7,
      reasoning: { level: 'high' },
      permissionPreset: 'bypass-everything-forever',
    }))
    assert.equal(result.ok, true, 'a malformed launch axis does not stop the card')
    assert.equal(result.chat?.model, null, 'a model that is not a string is absent, not cast')
    assert.equal(result.chat?.reasoning, null)
    assert.equal(
      result.chat?.permissionPreset,
      null,
      'a preset this build does not know never reaches a spawn — the app-wide default stands',
    )
  }

  // ── An envelope with no row at all is the app's own defaults ─────────────────
  {
    const result = await run(null, envelope({}))
    assert.equal(result.ok, true)
    assert.deepEqual(
      { model: result.chat?.model, reasoning: result.chat?.reasoning, preset: result.chat?.permissionPreset },
      { model: null, reasoning: null, preset: null },
      'absent means "the app’s own default", never "no model"',
    )
  }

  // ── And the checks that were already here still refuse ───────────────────────
  {
    const refused = await run(null, envelope({ actions: [{ verb: 'exec', command: 'rm -rf /' }] }))
    assert.equal(refused.ok, false, 'a verb this build does not implement refuses the whole card')
    assert.equal(refused.chat, null)
  }
  {
    const noSlug = await run(null, envelope({ slug: '   ' }))
    assert.equal(noSlug.ok, false, 'a card with no slug could not be read')
  }
  {
    // A relative path is treated as absent rather than joined against the
    // process cwd — the rule the two app-owned paths have always had.
    const relative = await run(null, envelope({ workspaceRoot: 'relative/path' }))
    assert.equal(relative.ok, true, 'open.chat needs no workspace')
    assert.equal(relative.workspaceRoot, null, 'and a relative one is absent, not resolved')
  }

  console.log('cards-ipc.test.ts: ok')
}

void main()
